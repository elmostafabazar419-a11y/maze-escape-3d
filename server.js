const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});

app.use(express.static("public"));
app.use(express.static(__dirname));

app.get("/health", (req, res) => {
  res.json({ ok: true, game: "MAZE ESCAPE 3D" });
});

const rooms = {};
const MAX_PLAYERS = 6;
const COLORS = [
  "#e13b48", "#36b8d8", "#d8bc48",
  "#a875e8", "#54c878", "#ef8a45"
];

// ============ wallMap للحماية من الغش ============
const wallMap = [
  "111111111111111",
  "100000100000001",
  "101110101110101",
  "101000100010101",
  "101011111010101",
  "100010000010001",
  "111010111110101",
  "100010100000101",
  "101110101110101",
  "101000001000001",
  "101011111011101",
  "100000100000001",
  "101110101110101",
  "100000000000001",
  "111111111111111"
];

const CELL = 2;
const MAP_OFFSET = 14;

function collidesWithWall(x, z, radius = 0.35) {
  for (let r = 0; r < wallMap.length; r++) {
    for (let c = 0; c < wallMap[r].length; c++) {
      if (wallMap[r][c] !== "1") continue;
      const wx = c * CELL - MAP_OFFSET;
      const wz = r * CELL - MAP_OFFSET;
      const halfX = CELL / 2;
      const halfZ = CELL / 2;
      const cx = Math.max(wx - halfX, Math.min(x, wx + halfX));
      const cz = Math.max(wz - halfZ, Math.min(z, wz + halfZ));
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
  }
  return false;
}

function makeCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (rooms[code]);
  return code;
}

function createRoomData() {
  return {
    hostId: null,
    started: false,
    players: {},
    keys: [
      { id: 1, x: 0, z: -12, found: false }
    ],
    monster: {
      x: 2,
      z: 0,
      state: "wander",
      targetId: null,
      wanderDir: { x: 0, z: 0 },
      lastDirChange: 0
    },
    lastMonsterMove: 0,
    caughtAt: {}
  };
}

function snapshot(room) {
  return {
    started: room.started,
    hostId: room.hostId,
    players: room.players,
    keys: room.keys,
    monster: {
      x: room.monster.x,
      z: room.monster.z,
      state: room.monster.state
    }
  };
}

function updateRoom(code) {
  const room = rooms[code];
  if (room) io.to(code).emit("worldUpdate", snapshot(room));
}

function reply(callback, data) {
  if (typeof callback === "function") callback(data);
}

function playersArray(room) {
  return Object.values(room.players).map(p => ({
    id: p.id,
    name: p.name,
    color: p.color
  }));
}

function leaveCurrentRoom(socket) {
  const oldCode = socket.data.room;
  if (!oldCode || !rooms[oldCode]) return;

  const room = rooms[oldCode];
  const leavingName = room.players[socket.id]?.name || "Someone";

  delete room.players[socket.id];
  delete room.caughtAt[socket.id];
  socket.leave(oldCode);
  delete socket.data.room;

  if (room.hostId === socket.id) {
    room.hostId = Object.keys(room.players)[0] || null;
  }

  if (!Object.keys(room.players).length) {
    delete rooms[oldCode];
  } else {
    io.to(oldCode).emit("playerJoined", {
      id: socket.id,
      name: leavingName,
      left: true,
      players: playersArray(room)
    });
    updateRoom(oldCode);
  }
}

function joinRoom(socket, rawCode, rawName, callback) {
  const code = String(rawCode || "").trim().toUpperCase();
  const name = String(rawName || "Player").trim().slice(0, 18) || "Player";
  const room = rooms[code];

  if (!room) {
    return reply(callback, { ok: false, message: "Room not found. Check the code." });
  }

  if (room.started) {
    return reply(callback, { ok: false, message: "Game already started. Create a new room." });
  }

  if (Object.keys(room.players).length >= MAX_PLAYERS) {
    return reply(callback, { ok: false, message: "Room is full." });
  }

  leaveCurrentRoom(socket);

  const index = Object.keys(room.players).length;
  socket.join(code);
  socket.data.room = code;

  room.players[socket.id] = {
    id: socket.id,
    name: name,
    x: -10 + index * 2,
    z: -10,
    yaw: 0,
    color: COLORS[index % COLORS.length]
  };

  if (!room.hostId) room.hostId = socket.id;

  reply(callback, {
    ok: true,
    code: code,
    id: socket.id,
    host: room.hostId === socket.id
  });

  io.to(code).emit("playerJoined", {
    id: socket.id,
    name: name,
    players: playersArray(room)
  });

  updateRoom(code);
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("createRoom", (name, callback) => {
    leaveCurrentRoom(socket);

    const code = makeCode();
    rooms[code] = createRoomData();
    rooms[code].hostId = socket.id;

    joinRoom(socket, code, name, callback);
  });

  socket.on("joinRoom", (data, callback) => {
    data = data || {};
    joinRoom(socket, data.code, data.name, callback);
  });

  socket.on("startGame", () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || room.started || room.hostId !== socket.id) return;

    room.started = true;
    room.monster.state = "wander";
    room.monster.targetId = null;
    room.monster.x = 2;
    room.monster.z = 0;

    io.to(code).emit("gameStarted", snapshot(room));
    updateRoom(code);
  });

  socket.on("playerMove", data => {
    const code = socket.data.room;
    const room = rooms[code];
    const player = room?.players[socket.id];

    if (!room || !room.started || !player || !data) return;

    const x = Number(data.x);
    const z = Number(data.z);
    const yaw = Number(data.yaw);

    if (![x, z, yaw].every(Number.isFinite)) return;

    const clampedX = Math.max(-14, Math.min(14, x));
    const clampedZ = Math.max(-14, Math.min(14, z));

    if (collidesWithWall(clampedX, clampedZ, 0.3)) return;

    player.x = clampedX;
    player.z = clampedZ;
    player.yaw = yaw;

    updateRoom(code);
  });

  socket.on("collectKey", id => {
    const code = socket.data.room;
    const room = rooms[code];
    const player = room?.players[socket.id];
    const key = room?.keys.find(k => k.id === Number(id));

    if (!room || !room.started || !player || !key || key.found) return;

    const dist = Math.hypot(player.x - key.x, player.z - key.z);
    if (dist < 3) {
      key.found = true;
      io.to(code).emit("keyCollected", { id: key.id, by: player.name });
      updateRoom(code);
    }
  });

  socket.on("playerEscaped", () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.started) return;

    const player = room.players[socket.id];
    if (!player || !room.keys.every(k => k.found)) return;

    io.to(code).emit("gameWon", {
      playerId: socket.id,
      playerName: player.name
    });
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    leaveCurrentRoom(socket);
  });
});

// ============ Monster AI ============
const MONSTER_SPEED = 0.14;
const VISION_RANGE = 6;
const LOSE_RANGE = 12;
const WANDER_CHANGE = 2000;

function getRandomDirection() {
  const angle = Math.random() * Math.PI * 2;
  return { x: Math.cos(angle), z: Math.sin(angle) };
}

setInterval(() => {
  for (const [code, room] of Object.entries(rooms)) {
    if (!room.started) continue;

    const now = Date.now();
    if (now - room.lastMonsterMove < 100) continue;
    room.lastMonsterMove = now;

    const players = Object.values(room.players);
    if (!players.length) continue;

    const monster = room.monster;
    let target = null;

    if (monster.state === "chase" && monster.targetId) {
      target = room.players[monster.targetId];
      if (target) {
        const dist = Math.hypot(target.x - monster.x, target.z - monster.z);
        if (dist > LOSE_RANGE) {
          monster.state = "wander";
          monster.targetId = null;
          target = null;
        }
      } else {
        monster.state = "wander";
        monster.targetId = null;
      }
    }

    if (monster.state === "wander") {
      let closest = null;
      let closestDist = Infinity;
      for (const p of players) {
        const d = Math.hypot(p.x - monster.x, p.z - monster.z);
        if (d < closestDist) {
          closestDist = d;
          closest = p;
        }
      }
      if (closest && closestDist < VISION_RANGE) {
        monster.state = "chase";
        monster.targetId = closest.id;
        target = closest;
      }
    }

    let moveX = 0;
    let moveZ = 0;

    if (monster.state === "chase" && target) {
      const dx = target.x - monster.x;
      const dz = target.z - monster.z;
      const len = Math.hypot(dx, dz) || 1;
      moveX = (dx / len) * MONSTER_SPEED;
      moveZ = (dz / len) * MONSTER_SPEED;
    } else {
      if (now - monster.lastDirChange > WANDER_CHANGE || !monster.wanderDir || (monster.wanderDir.x === 0 && monster.wanderDir.z === 0)) {
        monster.wanderDir = getRandomDirection();
        monster.lastDirChange = now;
      }
      moveX = monster.wanderDir.x * MONSTER_SPEED;
      moveZ = monster.wanderDir.z * MONSTER_SPEED;
    }

    const newX = monster.x + moveX;
    if (!collidesWithWall(newX, monster.z, 0.4)) {
      monster.x = newX;
    } else {
      monster.wanderDir = getRandomDirection();
      monster.lastDirChange = now;
    }

    const newZ = monster.z + moveZ;
    if (!collidesWithWall(monster.x, newZ, 0.4)) {
      monster.z = newZ;
    } else {
      monster.wanderDir = getRandomDirection();
      monster.lastDirChange = now;
    }

    for (const p of players) {
      const d = Math.hypot(p.x - monster.x, p.z - monster.z);
      if (d < 1.15) {
        const last = room.caughtAt[p.id] || 0;
        if (now - last > 2500) {
          room.caughtAt[p.id] = now;
          io.to(code).emit("playerCaught", p.id);
        }
      }
    }

    updateRoom(code);
  }
}, 100);

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("MAZE ESCAPE 3D listening on port " + PORT);
});

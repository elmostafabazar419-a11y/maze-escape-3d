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
      { id: 1, x: -12, z: 0, found: false }
    ],
    monster: { x: 2, z: 0 },
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
    monster: room.monster
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

    player.x = Math.max(-14, Math.min(14, x));
    player.z = Math.max(-14, Math.min(14, z));
    player.yaw = yaw;

    updateRoom(code);
  });

  socket.on("collectKey", id => {
    const code = socket.data.room;
    const room = rooms[code];
    const player = room?.players[socket.id];
    const key = room?.keys.find(k => k.id === Number(id));

    if (!room || !room.started || !player || !key || key.found) return;

    if (Math.hypot(player.x - key.x, player.z - key.z) < 3) {
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

  socket.on("voiceOffer", data => {
    const target = data?.target;
    if (rooms[socket.data.room]?.players[target]) {
      io.to(target).emit("voiceOffer", {
        from: socket.id,
        offer: data.offer
      });
    }
  });

  socket.on("voiceAnswer", data => {
    const target = data?.target;
    if (rooms[socket.data.room]?.players[target]) {
      io.to(target).emit("voiceAnswer", {
        from: socket.id,
        answer: data.answer
      });
    }
  });

  socket.on("voiceIce", data => {
    const target = data?.target;
    if (rooms[socket.data.room]?.players[target]) {
      io.to(target).emit("voiceIce", {
        from: socket.id,
        candidate: data.candidate
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    leaveCurrentRoom(socket);
  });
});

// Monster movement and collision checks
setInterval(() => {
  for (const [code, room] of Object.entries(rooms)) {
    if (!room.started) continue;

    const now = Date.now();
    if (now - room.lastMonsterMove < 350) continue;
    room.lastMonsterMove = now;

    const players = Object.values(room.players);
    if (!players.length) continue;

    let target = players[0];
    let distance = Infinity;

    for (const player of players) {
      const d = Math.hypot(
        player.x - room.monster.x,
        player.z - room.monster.z
      );
      if (d < distance) {
        distance = d;
        target = player;
      }
    }

    const dx = target.x - room.monster.x;
    const dz = target.z - room.monster.z;
    const length = Math.hypot(dx, dz) || 1;

    room.monster.x += (dx / length) * 0.22;
    room.monster.z += (dz / length) * 0.22;

    for (const player of players) {
      if (Math.hypot(
        player.x - room.monster.x,
        player.z - room.monster.z
      ) < 1.15) {
        const last = room.caughtAt[player.id] || 0;
        if (now - last > 2500) {
          room.caughtAt[player.id] = now;
          io.to(code).emit("playerCaught", player.id);
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

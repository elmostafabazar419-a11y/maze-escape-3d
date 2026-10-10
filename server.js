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

function leaveCurrentRoom(socket) {
  const oldCode = socket.data.room;
  if (!oldCode || !rooms[oldCode]) return;

  const room = rooms[oldCode];
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
      name: "Someone",
      left: true,
      players: Object.values(room.players).map(p => ({
        id: p.id,
        name: p.name,
        color: p.color
      }))
    });
    updateRoom(oldCode);
  }
}

function joinRoom(socket, rawCode, rawName, callback) {
  const code = String(rawCode || "").trim().toUpperCase();
  const name = String(rawName || "Player").trim().slice(0, 18) || "Player";
  const room = rooms[code];

  if (!room) {
    return reply(callback, { ok: false

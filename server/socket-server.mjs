import { createServer } from "node:http";
import { Server } from "socket.io";

const port = Number(process.env.PORT) || 3001;
const allowedOrigins = (process.env.CORS_ORIGIN || "*").split(",").map((origin) => origin.trim());
const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins } });
const rooms = new Map();
const socketRooms = new Map();
const names = new Map();
const MAX_NAME_LENGTH = 10;
const TURN_LIMIT_MS = 10_000;

function normalizeRoomId(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function validName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_NAME_LENGTH;
}

function publish(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("room:update", {
    roomId,
    count: room.players.length,
    maxPlayers: room.maxPlayers,
    hostId: room.players.find((player) => player.socketId === room.host)?.id,
    status: room.status,
    players: room.players.map((player) => ({ id: player.id, name: player.name, isHost: player.socketId === room.host })),
  });
}

function error(socket, message) {
  socket.emit("game:error", message);
}

function leaveRoom(socket, roomId, reason = "leave") {
  const id = normalizeRoomId(roomId || socketRooms.get(socket.id));
  const room = rooms.get(id);
  if (!room) return false;
  const leaving = room.players.find((player) => player.socketId === socket.id);
  if (!leaving) return false;
  room.players = room.players.filter((player) => player.socketId !== socket.id);
  socket.leave(id);
  socketRooms.delete(socket.id);
  if (room.status === "playing") {
    room.status = "waiting";
    room.turnId += 1;
    io.to(id).emit("game:aborted", { message: "참가자가 나가 경기가 중단되었습니다. 대기방으로 돌아갑니다." });
  }
  if (room.players.length === 0) {
    rooms.delete(id);
  } else {
    if (room.host === socket.id) room.host = room.players[0].socketId;
    publish(id);
  }
  return reason === "leave";
}

function newRoomId() {
  let roomId = "";
  do roomId = Math.random().toString(36).slice(2, 8).toUpperCase(); while (rooms.has(roomId));
  return roomId;
}

function advanceTurn(roomId, room) {
  if (room.status !== "playing" || room.players.length === 0) return;
  const currentIndex = room.players.findIndex((candidate) => candidate.id === room.currentPlayerId);
  room.currentPlayerId = room.players[(currentIndex + 1 + room.players.length) % room.players.length].id;
  room.turnId += 1;
  room.deadline = Date.now() + TURN_LIMIT_MS;
  io.to(roomId).emit("game:turn", { playerId: room.currentPlayerId, turnId: room.turnId, deadline: room.deadline });
}

setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.status === "playing" && Date.now() > room.deadline) advanceTurn(roomId, room);
  }
}, 250);

io.on("connection", (socket) => {
  socket.on("room:create", (payload, ack) => {
    if (socketRooms.has(socket.id)) return error(socket, "먼저 현재 방에서 나가세요.");
    if (!payload || !validName(payload.name)) return error(socket, "닉네임은 1~10자로 입력하세요.");
    const maxPlayers = Number(payload.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 4) return error(socket, "인원수는 2~4명이어야 합니다.");
    const roomId = newRoomId();
    const player = { socketId: socket.id, id: 0, name: payload.name.trim() };
    rooms.set(roomId, { host: socket.id, maxPlayers, status: "waiting", players: [player], nextId: 1, turnId: 1, currentPlayerId: 0, deadline: 0 });
    socketRooms.set(socket.id, roomId);
    names.set(socket.id, player.name);
    socket.join(roomId);
    socket.emit("room:created", { roomId, count: 1, playerId: player.id });
    publish(roomId);
    ack?.({ ok: true });
  });

  socket.on("room:join", (payload, ack) => {
    if (socketRooms.has(socket.id)) return error(socket, "먼저 현재 방에서 나가세요.");
    const roomId = normalizeRoomId(payload?.roomId);
    const room = rooms.get(roomId);
    if (!room) return error(socket, "방을 찾을 수 없습니다.");
    if (room.status !== "waiting") return error(socket, "진행 중인 방에는 참여할 수 없습니다.");
    if (room.players.length >= room.maxPlayers) return error(socket, "방이 가득 찼습니다.");
    if (!validName(payload?.name)) return error(socket, "닉네임은 1~10자로 입력하세요.");
    const player = { socketId: socket.id, id: room.nextId++, name: payload.name.trim() };
    room.players.push(player);
    socketRooms.set(socket.id, roomId);
    names.set(socket.id, player.name);
    socket.join(roomId);
    publish(roomId);
    ack?.({ ok: true, playerId: player.id });
  });

  socket.on("room:start", (payload, ack) => {
    const roomId = normalizeRoomId(payload?.roomId);
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || room.status !== "waiting" || room.players.length !== room.maxPlayers) return error(socket, "게임을 시작할 수 없습니다.");
    room.status = "playing";
    room.turnId += 1;
    room.currentPlayerId = room.players[0].id;
    room.deadline = Date.now() + TURN_LIMIT_MS;
    for (const player of room.players) io.to(player.socketId).emit("game:start", { roomId, names: room.players.map((candidate) => candidate.name), playerId: player.id, turnId: room.turnId, deadline: room.deadline });
    ack?.({ ok: true });
  });

  socket.on("room:leave", (payload, ack) => {
    leaveRoom(socket, payload?.roomId, "leave");
    ack?.({ ok: true });
  });

  socket.on("game:move", (payload, ack) => {
    const roomId = normalizeRoomId(payload?.roomId);
    const room = rooms.get(roomId);
    const player = room?.players.find((candidate) => candidate.socketId === socket.id);
    const x = payload?.x;
    const y = payload?.y;
    if (!room || !player || room.status !== "playing" || player.id !== room.currentPlayerId || payload?.turnId !== room.turnId || !Number.isFinite(x) || !Number.isFinite(y) || x < 10 || x > 590 || y < 10 || y > 1290 || Date.now() > room.deadline) {
      return error(socket, "유효하지 않거나 만료된 턴 입력입니다.");
    }
    const nextTurnId = room.turnId + 1;
    const currentIndex = room.players.findIndex((candidate) => candidate.id === room.currentPlayerId);
    room.currentPlayerId = room.players[(currentIndex + 1) % room.players.length].id;
    room.turnId = nextTurnId;
    room.deadline = Date.now() + TURN_LIMIT_MS;
    socket.to(roomId).emit("game:move", { playerId: player.id, x, y, turnId: room.turnId, deadline: room.deadline });
    ack?.({ ok: true });
  });

  socket.on("disconnect", () => leaveRoom(socket, socketRooms.get(socket.id), "disconnect"));
});

httpServer.listen(port, () => console.log(`Socket.IO server listening on http://localhost:${port}`));

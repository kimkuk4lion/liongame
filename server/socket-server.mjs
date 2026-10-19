import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Server } from "socket.io";

const port = Number(process.env.PORT) || 3001;
const origins = (process.env.CORS_ORIGIN || "*").split(",").map((value) => value.trim());
const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: origins.length === 1 ? origins[0] : origins },
  pingInterval: 25_000,
  pingTimeout: 30_000,
});
const rooms = new Map();
const socketRooms = new Map();
const TURN_LIMIT_MS = 10_000;
const RECONNECT_GRACE_MS = 30_000;
const WIDTH = 600;
const HEIGHT = 1300;
const MAX_MOVE_DISTANCE = 200;
const MARBLE_RADIUS = 12.5;
const HOLE_RADIUS = 17.5;
const MIN_COORDINATE = 10;
const PUSH_DISTANCE_BASE = 50;
const PUSH_DISTANCE_PER_FORCE = 1.8;
const HOLES = [{ x: 300, y: 950 }, { x: 300, y: 700 }, { x: 300, y: 400 }, { x: 500, y: 400 }, { x: 100, y: 400 }, { x: 300, y: 150 }];

const validName = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 10;
const sessionTokenOf = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : "";
const roomIdOf = (value) => {
  const roomId = typeof value === "string" ? value.trim() : "";
  return /^\d{4}$/.test(roomId) ? roomId : "";
};
const finiteCoordinate = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
function segmentDistance(startX, startY, endX, endY, pointX, pointY) {
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared));
  const closestX = startX + dx * projection;
  const closestY = startY + dy * projection;
  return Math.hypot(pointX - closestX, pointY - closestY);
}

function publish(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("room:update", {
    roomId, count: room.players.length, maxPlayers: room.maxPlayers, hostId: room.hostId,
    status: room.status,
    players: room.players.map(({ id, name }) => ({ id, name, isHost: id === room.hostId })),
  });
}

function emitError(socket, message, ack) {
  const result = { ok: false, error: message };
  socket.emit("game:error", message);
  if (typeof ack === "function") ack(result);
}

function nextAlive(room, currentId) {
  const start = room.players.findIndex((player) => player.id === currentId);
  for (let offset = 1; offset <= room.players.length; offset += 1) {
    const player = room.players[(start + offset + room.players.length) % room.players.length];
    if (room.state.marbles.find((marble) => marble.id === player.id)?.alive) return player.id;
  }
  return undefined;
}

function snapshot(room) {
  return {
    version: room.version, gameId: room.gameId, turnId: room.turnId, turnPlayerId: room.turnPlayerId,
    deadline: room.paused ? 0 : room.deadline,
    pausedRemainingMs: room.paused ? room.pausedRemainingMs : 0,
    state: room.status === "finished" ? "finished" : room.paused ? "paused" : room.moving ? "moving" : "wait_move",
    marbles: room.state.marbles, winnerId: room.state.winnerId,
  };
}

function broadcastState(roomId, room, requestId) {
  io.to(roomId).emit("game:state", { ...snapshot(room), requestId });
}

function resetGameState(room) {
  room.gameId += 1;
  room.version = 0;
  room.turnId = 1;
  room.turnPlayerId = room.players[0]?.id;
  room.deadline = Date.now() + TURN_LIMIT_MS;
  room.moving = false;
  room.paused = false;
  room.pausedRemainingMs = 0;
  room.lastRequestId = "";
  room.state = {
    winnerId: undefined,
    marbles: room.players.map((player, index) => ({
      id: player.id, name: player.name, x: 100 + index * (room.players.length === 1 ? 0 : 400 / (room.players.length - 1)),
      y: 1200, lion: false, hole: 0, alive: true, inHole: true, score: 0,
      eliminated: false,
    })),
  };
}

function advanceTurn(roomId, room) {
  if (room.status !== "playing" || room.moving || room.paused) return;
  const next = nextAlive(room, room.turnPlayerId);
  if (next === undefined) {
    room.status = "finished";
    room.state.winnerId = [...room.state.marbles].sort((a, b) => b.score - a.score)[0]?.id;
    room.version += 1;
    broadcastState(roomId, room);
    return;
  }
  room.turnPlayerId = next;
  room.turnId += 1;
  room.deadline = Date.now() + TURN_LIMIT_MS;
  room.version += 1;
  broadcastState(roomId, room);
}

function finishGame(roomId, room, winnerId) {
  if (room.status === "finished") return;
  room.status = "finished";
  room.paused = false;
  room.moving = false;
  room.state.winnerId = winnerId;
  room.deadline = 0;
  room.players.forEach((player) => {
    if (player.graceTimer) clearTimeout(player.graceTimer);
    player.graceTimer = undefined;
    player.reconnectToken = undefined;
  });
  room.version += 1;
  broadcastState(roomId, room);
  io.to(roomId).emit("game:finished", { winnerId });
}

function resumeIfReady(roomId, room) {
  if (room.status !== "playing" || !room.paused || room.players.some((player) => player.status === "disconnected")) return;
  room.paused = false;
  room.deadline = Date.now() + room.pausedRemainingMs;
  room.pausedRemainingMs = 0;
  room.version += 1;
  io.to(roomId).emit("game:resumed", {});
  broadcastState(roomId, room);
}

function eliminatePlayer(roomId, room, player, reason) {
  if (player.status === "eliminated") return;
  if (player.graceTimer) clearTimeout(player.graceTimer);
  player.graceTimer = undefined;
  player.status = "eliminated";
  player.socketId = undefined;
  player.reconnectToken = undefined;
  socketRooms.forEach((mappedRoom, socketId) => {
    if (mappedRoom === roomId && !io.sockets.sockets.get(socketId)?.connected) socketRooms.delete(socketId);
  });
  const marble = room.state.marbles.find((candidate) => candidate.id === player.id);
  if (marble) {
    marble.alive = false;
    marble.eliminated = true;
    marble.eliminationReason = reason;
  }
  io.to(roomId).emit("player:eliminated", { playerId: player.id, reason });
  if (room.turnPlayerId === player.id && room.status === "playing") {
    room.moving = false;
    advanceTurn(roomId, room);
  }
  const alive = room.state.marbles.filter((marble) => marble.alive);
  if (room.status === "playing" && alive.length <= 1) finishGame(roomId, room, alive[0]?.id);
  else resumeIfReady(roomId, room);
  room.version += 1;
  broadcastState(roomId, room);
  publish(roomId);
}

function pauseForDisconnect(roomId, room, player) {
  if (room.status !== "playing" || room.status === "finished") return;
  if (!room.paused) {
    room.paused = true;
    room.pausedRemainingMs = Math.max(0, room.deadline - Date.now());
    room.deadline = 0;
    room.version += 1;
    broadcastState(roomId, room);
    io.to(roomId).emit("game:paused", { playerId: player.id, remainingMs: RECONNECT_GRACE_MS });
  }
}

function markDisconnected(socket, requestedRoom) {
  const id = roomIdOf(requestedRoom || socketRooms.get(socket.id));
  const room = rooms.get(id);
  const player = room?.players.find((candidate) => candidate.socketId === socket.id);
  if (!room || !player || player.status === "eliminated") return;
  player.socketId = undefined;
  player.status = "disconnected";
  socketRooms.delete(socket.id);
  io.to(id).emit("player:disconnected", { playerId: player.id, graceMs: RECONNECT_GRACE_MS });
  pauseForDisconnect(id, room, player);
  player.graceTimer = setTimeout(() => {
    if (player.status !== "disconnected") return;
    if (room.status === "waiting") {
      room.players = room.players.filter((candidate) => candidate.id !== player.id);
      player.reconnectToken = undefined;
      if (room.hostId === player.id) room.hostId = room.players[0]?.id;
      if (room.players.length === 0) rooms.delete(id);
      else publish(id);
      return;
    }
    eliminatePlayer(id, room, player, "disconnect_timeout");
    if (room.players.every((candidate) => candidate.status === "eliminated")) {
      rooms.delete(id);
    }
  }, RECONNECT_GRACE_MS);
  publish(id);
}

function leaveRoom(socket, requestedRoom) {
  const id = roomIdOf(requestedRoom || socketRooms.get(socket.id));
  const room = rooms.get(id);
  const player = room?.players.find((candidate) => candidate.socketId === socket.id);
  if (!room || !player) return;
  if (player.graceTimer) clearTimeout(player.graceTimer);
  socketRooms.delete(socket.id);
  socket.leave(id);
  if (room.status === "playing") {
    eliminatePlayer(id, room, player, "manual_leave");
    return;
  }
  room.players = room.players.filter((candidate) => candidate.id !== player.id);
  player.reconnectToken = undefined;
  if (room.players.length === 0) rooms.delete(id);
  else {
    if (!room.players.some((candidate) => candidate.id === room.hostId)) room.hostId = room.players[0].id;
    publish(id);
  }
}

setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.status === "playing" && !room.paused && !room.moving && Date.now() > room.deadline) advanceTurn(roomId, room);
  }
}, 250);

io.on("connection", (socket) => {
  socket.on("room:create", (payload, ack) => {
    if (socketRooms.has(socket.id)) return emitError(socket, "먼저 현재 방에서 나가세요.", ack);
    const maxPlayers = Number(payload?.maxPlayers);
    if (!validName(payload?.name) || !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 4) return emitError(socket, "닉네임은 1~10자, 인원수는 2~4명이어야 합니다.", ack);
    let roomId;
    do roomId = String(Math.floor(Math.random() * 10_000)).padStart(4, "0"); while (rooms.has(roomId));
    const player = { id: 0, socketId: socket.id, name: payload.name.trim(), status: "connected", reconnectToken: randomBytes(32).toString("hex") };
    const room = { hostId: 0, maxPlayers, status: "waiting", players: [player], nextId: 1, gameId: 0, version: 0, turnId: 0, turnPlayerId: 0, deadline: 0, moving: false, paused: false, pausedRemainingMs: 0, lastRequestId: "", state: { marbles: [] } };
    rooms.set(roomId, room);
    socketRooms.set(socket.id, roomId);
    socket.join(roomId);
    socket.emit("room:created", { roomId, count: 1, playerId: 0, reconnectToken: player.reconnectToken });
    publish(roomId);
    ack?.({ ok: true, playerId: 0, reconnectToken: player.reconnectToken });
  });

  socket.on("room:join", (payload, ack) => {
    const id = roomIdOf(payload?.roomId);
    const room = rooms.get(id);
    if (socketRooms.has(socket.id)) return emitError(socket, "먼저 현재 방에서 나가세요.", ack);
    if (!room) return emitError(socket, "방을 찾을 수 없습니다.", ack);
    if (room.status !== "waiting") return emitError(socket, "진행 중인 방에는 참여할 수 없습니다.", ack);
    if (room.players.length >= room.maxPlayers || !validName(payload?.name)) return emitError(socket, "방이 가득 찼거나 닉네임이 올바르지 않습니다.", ack);
    const player = { id: room.nextId++, socketId: socket.id, name: payload.name.trim(), status: "connected", reconnectToken: randomBytes(32).toString("hex") };
    room.players.push(player);
    socketRooms.set(socket.id, id);
    socket.join(id);
    publish(id);
    ack?.({ ok: true, playerId: player.id, reconnectToken: player.reconnectToken });
  });

  socket.on("room:rejoin", (payload, ack) => {
    const id = roomIdOf(payload?.roomId);
    const token = sessionTokenOf(payload?.reconnectToken);
    const room = rooms.get(id);
    const player = room?.players.find((candidate) => candidate.reconnectToken === token);
    if (!room || !player || player.status === "eliminated" || room.status === "finished") return emitError(socket, "재접속 세션이 만료되었습니다.", ack);
    if (player.socketId && player.socketId !== socket.id) {
      socketRooms.delete(player.socketId);
      const oldSocket = io.sockets.sockets.get(player.socketId);
      oldSocket?.leave(id);
    }
    if (player.graceTimer) clearTimeout(player.graceTimer);
    player.graceTimer = undefined;
    player.socketId = socket.id;
    player.status = "connected";
    socketRooms.set(socket.id, id);
    socket.join(id);
    const wasPaused = room.paused;
    const disconnected = room.players.some((candidate) => candidate.status === "disconnected");
    if (room.status === "playing" && !disconnected && wasPaused) resumeIfReady(id, room);
    io.to(id).emit("player:reconnected", { playerId: player.id });
    publish(id);
    if (room.status === "playing") {
      socket.emit("game:start", {
        roomId: id, gameId: room.gameId, playerId: player.id, turnId: room.turnId, deadline: room.deadline,
        players: room.players.map(({ id: playerId, name }) => ({ id: playerId, name })),
        state: snapshot(room),
      });
    }
    ack?.({ ok: true, playerId: player.id, status: room.status, state: room.status === "playing" ? snapshot(room) : undefined });
  });

  socket.on("room:start", (payload, ack) => {
    const id = roomIdOf(payload?.roomId);
    const room = rooms.get(id);
    if (!room || room.hostId !== room.players.find((player) => player.socketId === socket.id)?.id || room.status !== "waiting" || room.players.length !== room.maxPlayers || room.players.some((player) => player.status !== "connected")) return emitError(socket, "게임을 시작할 수 없습니다.", ack);
    resetGameState(room);
    room.status = "playing";
    room.players.forEach((player) => io.to(player.socketId).emit("game:start", {
      roomId: id, gameId: room.gameId, playerId: player.id, turnId: room.turnId, deadline: room.deadline,
      players: room.players.map(({ id: playerId, name }) => ({ id: playerId, name })),
      state: snapshot(room),
    }));
    ack?.({ ok: true });
  });

  socket.on("room:leave", (payload, ack) => {
    leaveRoom(socket, payload?.roomId);
    ack?.({ ok: true });
  });

  socket.on("game:move", (payload, ack) => {
    const id = roomIdOf(payload?.roomId);
    const room = rooms.get(id);
    const player = room?.players.find((candidate) => candidate.socketId === socket.id);
    const x = payload?.x;
    const y = payload?.y;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    const current = room?.state.marbles.find((marble) => marble.id === room.turnPlayerId);
    const distance = current ? Math.hypot(x - current.x, y - current.y) : Infinity;
    if (!room || !player || player.status !== "connected" || room.status !== "playing" || room.paused || room.moving || player.id !== room.turnPlayerId || payload?.gameId !== room.gameId || payload?.turnId !== room.turnId || !requestId || requestId === room.lastRequestId || !finiteCoordinate(x, 10, WIDTH - 10) || !finiteCoordinate(y, 10, HEIGHT - 10) || distance < 8 || distance > MAX_MOVE_DISTANCE || Date.now() > room.deadline) {
      return emitError(socket, "유효하지 않거나 만료된 턴 입력입니다.", ack);
    }
    room.lastRequestId = requestId;
    room.moving = true;
    const startX = current.x;
    const startY = current.y;
    current.x = x;
    current.y = y;
    current.inHole = false;
    const force = Math.min(100, distance / 2);
    for (const other of room.state.marbles) {
      if (other.id === current.id || !other.alive || segmentDistance(startX, startY, x, y, other.x, other.y) > MARBLE_RADIUS * 2) continue;
      if (current.lion) {
        other.alive = false;
        current.score += 2;
      } else if (other.lion) {
        current.alive = false;
      } else {
        current.score += 1;
        other.inHole = false;
      }
      if (other.alive && !current.lion && !other.lion) {
        const collisionX = other.x - current.x;
        const collisionY = other.y - current.y;
        const collisionDistance = Math.hypot(collisionX, collisionY);
        const shotDistance = Math.hypot(x - startX, y - startY) || 1;
        const directionX = collisionDistance > 0 ? collisionX / collisionDistance : (x - startX) / shotDistance;
        const directionY = collisionDistance > 0 ? collisionY / collisionDistance : (y - startY) / shotDistance;
        const pushDistance = PUSH_DISTANCE_BASE + force * PUSH_DISTANCE_PER_FORCE;
        other.x = clamp(other.x + directionX * pushDistance, MIN_COORDINATE, WIDTH - MIN_COORDINATE);
        other.y = clamp(other.y + directionY * pushDistance, MIN_COORDINATE, HEIGHT - MIN_COORDINATE);
      }
    }
    if (!current.lion) {
      const hole = HOLES[current.hole];
      if (hole && segmentDistance(startX, startY, x, y, hole.x, hole.y) <= HOLE_RADIUS + MARBLE_RADIUS) {
        current.score += 2;
        current.x = hole.x;
        current.y = hole.y;
        current.hole += 1;
        current.inHole = current.hole < HOLES.length;
        current.lion = current.hole >= HOLES.length;
      }
    }
    room.version += 1;
    room.moving = false;
    const alive = room.state.marbles.filter((marble) => marble.alive);
    if (alive.length <= 1) {
      finishGame(id, room, alive[0]?.id);
    } else if (room.status === "playing") {
      advanceTurn(id, room);
    }
    broadcastState(id, room, requestId);
    ack?.({ ok: true, version: room.version, requestId });
  });

  socket.on("disconnect", (reason) => {
  console.warn(`[socket] disconnected ${socket.id}: ${reason}`);
  markDisconnected(socket);
  });
});

httpServer.listen(port, () => console.log(`Socket.IO server listening on http://localhost:${port}`));

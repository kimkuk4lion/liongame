import { createServer } from "node:http";
import { Server } from "socket.io";

const port = Number(process.env.PORT) || 3001;
const origins = (process.env.CORS_ORIGIN || "*").split(",").map((value) => value.trim());
const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: origins.length === 1 ? origins[0] : origins } });
const rooms = new Map();
const socketRooms = new Map();
const TURN_LIMIT_MS = 10_000;
const WIDTH = 600;
const HEIGHT = 1300;
const MAX_MOVE_DISTANCE = 200;
const MARBLE_RADIUS = 12.5;
const HOLE_RADIUS = 17.5;
const MIN_COORDINATE = 10;
const HOLES = [{ x: 300, y: 950 }, { x: 300, y: 700 }, { x: 300, y: 400 }, { x: 500, y: 400 }, { x: 100, y: 400 }, { x: 300, y: 150 }];

const validName = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 10;
const roomIdOf = (value) => typeof value === "string" ? value.trim().toUpperCase() : "";
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
    deadline: room.deadline, state: room.status === "finished" ? "finished" : room.moving ? "moving" : "wait_move",
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
  room.lastRequestId = "";
  room.state = {
    winnerId: undefined,
    marbles: room.players.map((player, index) => ({
      id: player.id, name: player.name, x: 100 + index * (room.players.length === 1 ? 0 : 400 / (room.players.length - 1)),
      y: 1200, lion: false, hole: 0, alive: true, inHole: true, score: 0,
    })),
  };
}

function advanceTurn(roomId, room) {
  if (room.status !== "playing" || room.moving) return;
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

function leaveRoom(socket, requestedRoom) {
  const id = roomIdOf(requestedRoom || socketRooms.get(socket.id));
  const room = rooms.get(id);
  if (!room || !room.players.some((player) => player.socketId === socket.id)) return;
  room.players = room.players.filter((player) => player.socketId !== socket.id);
  socketRooms.delete(socket.id);
  socket.leave(id);
  if (room.status === "playing") {
    room.status = "waiting";
    room.moving = false;
    room.version += 1;
    io.to(id).emit("game:aborted", { message: "참가자가 나가 경기가 중단되었습니다. 대기방으로 돌아갑니다." });
  }
  if (room.players.length === 0) rooms.delete(id);
  else {
    if (!room.players.some((player) => player.id === room.hostId)) {
      room.hostId = room.players[0].id;
    }
    publish(id);
  }
}

setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.status === "playing" && !room.moving && Date.now() > room.deadline) advanceTurn(roomId, room);
  }
}, 250);

io.on("connection", (socket) => {
  socket.on("room:create", (payload, ack) => {
    if (socketRooms.has(socket.id)) return emitError(socket, "먼저 현재 방에서 나가세요.", ack);
    const maxPlayers = Number(payload?.maxPlayers);
    if (!validName(payload?.name) || !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 4) return emitError(socket, "닉네임은 1~10자, 인원수는 2~4명이어야 합니다.", ack);
    let roomId;
    do roomId = Math.random().toString(36).slice(2, 8).toUpperCase(); while (rooms.has(roomId));
    const player = { id: 0, socketId: socket.id, name: payload.name.trim() };
    const room = { hostId: 0, maxPlayers, status: "waiting", players: [player], nextId: 1, gameId: 0, version: 0, turnId: 0, turnPlayerId: 0, deadline: 0, moving: false, lastRequestId: "", state: { marbles: [] } };
    rooms.set(roomId, room);
    socketRooms.set(socket.id, roomId);
    socket.join(roomId);
    socket.emit("room:created", { roomId, count: 1, playerId: 0 });
    publish(roomId);
    ack?.({ ok: true, playerId: 0 });
  });

  socket.on("room:join", (payload, ack) => {
    const id = roomIdOf(payload?.roomId);
    const room = rooms.get(id);
    if (socketRooms.has(socket.id)) return emitError(socket, "먼저 현재 방에서 나가세요.", ack);
    if (!room) return emitError(socket, "방을 찾을 수 없습니다.", ack);
    if (room.status !== "waiting") return emitError(socket, "진행 중인 방에는 참여할 수 없습니다.", ack);
    if (room.players.length >= room.maxPlayers || !validName(payload?.name)) return emitError(socket, "방이 가득 찼거나 닉네임이 올바르지 않습니다.", ack);
    const player = { id: room.nextId++, socketId: socket.id, name: payload.name.trim() };
    room.players.push(player);
    socketRooms.set(socket.id, id);
    socket.join(id);
    publish(id);
    ack?.({ ok: true, playerId: player.id });
  });

  socket.on("room:start", (payload, ack) => {
    const id = roomIdOf(payload?.roomId);
    const room = rooms.get(id);
    if (!room || room.hostId !== room.players.find((player) => player.socketId === socket.id)?.id || room.status !== "waiting" || room.players.length !== room.maxPlayers) return emitError(socket, "게임을 시작할 수 없습니다.", ack);
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
    if (!room || !player || room.status !== "playing" || room.moving || player.id !== room.turnPlayerId || payload?.gameId !== room.gameId || payload?.turnId !== room.turnId || !requestId || requestId === room.lastRequestId || !finiteCoordinate(x, 10, WIDTH - 10) || !finiteCoordinate(y, 10, HEIGHT - 10) || distance < 8 || distance > MAX_MOVE_DISTANCE || Date.now() > room.deadline) {
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
        current.score += other.inHole ? 3 : 1;
        other.inHole = false;
      }
      if (other.alive && !current.lion && !other.lion) {
        const collisionX = other.x - current.x;
        const collisionY = other.y - current.y;
        const collisionDistance = Math.hypot(collisionX, collisionY);
        const shotDistance = Math.hypot(x - startX, y - startY) || 1;
        const directionX = collisionDistance > 0 ? collisionX / collisionDistance : (x - startX) / shotDistance;
        const directionY = collisionDistance > 0 ? collisionY / collisionDistance : (y - startY) / shotDistance;
        const pushDistance = 80 + force * 3;
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
    if (room.state.marbles.filter((marble) => marble.alive).length <= 1) {
      room.status = "finished";
      room.state.winnerId = room.state.marbles.filter((marble) => marble.alive)[0]?.id;
    }
    room.version += 1;
    room.moving = false;
    if (room.status === "playing") advanceTurn(id, room);
    broadcastState(id, room, requestId);
    ack?.({ ok: true, version: room.version, requestId });
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

httpServer.listen(port, () => console.log(`Socket.IO server listening on http://localhost:${port}`));

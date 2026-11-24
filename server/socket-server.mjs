import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { createAccounts } from "./accounts.mjs";

const port = Number(process.env.PORT) || 3001;
const origins = (process.env.CORS_ORIGIN ||
  (process.env.APP_URL ? new URL(process.env.APP_URL).origin : "*"))
  .split(",").map((value) => value.trim());
const accounts = await createAccounts();
const httpServer = createServer((req, res) => {
  accounts.handle(req, res).catch(() => {
    console.error("Game API request failed");
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." }));
  });
});
const io = new Server(httpServer, {
  cors: { origin: origins.includes("*") ? "*" : origins, credentials: !origins.includes("*") },
  pingInterval: 25_000,
  pingTimeout: 30_000,
});
const rooms = new Map();
const socketRooms = new Map();
const TURN_LIMITS = { easy: 15_000, normal: 10_000, hard: 6_000 };
const RECONNECT_GRACE_MS = 30_000;
const WIDTH = 600;
const HEIGHT = 1300;
const MAX_MOVE_DISTANCE = 200;
const MARBLE_RADIUS = 12.5;
const HOLE_RADIUS = 17.5;
const MIN_COORDINATE = 10;
const PUSH_DISTANCE_BASE = 20;
const PUSH_DISTANCE_PER_FORCE = 0.8;
const MAX_ROOM_COUNT = 10_000;
const ROOM_CODE_ISSUE_ATTEMPTS = 20_000;
const MAX_REQUEST_ID_LENGTH = 64;
const CREATE_ROOM_RATE_LIMIT = { max: 3, windowMs: 10_000 };
const JOIN_ROOM_RATE_LIMIT = { max: 8, windowMs: 10_000 };
const MOVE_RATE_LIMIT = { max: 20, windowMs: 2_000 };
const HOLES = [
  { x: 300, y: 950 },
  { x: 300, y: 700 },
  { x: 300, y: 400 },
  { x: 500, y: 400 },
  { x: 100, y: 400 },
  { x: 300, y: 150 },
];

const sessionTokenOf = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : "";
const roomIdOf = (value) => {
  const roomId = typeof value === "string" ? value.trim() : "";
  return /^\d{4}$/.test(roomId) ? roomId : "";
};
const gameRoomIdOf = (value, socket) => socket.data.practiceRoom === value
  ? socket.data.practiceRoom : roomIdOf(value);
const finiteCoordinate = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;
const validRequestId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
function segmentDistance(startX, startY, endX, endY, pointX, pointY) {
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy;
  const projection =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared));
  const closestX = startX + dx * projection;
  const closestY = startY + dy * projection;
  return Math.hypot(pointX - closestX, pointY - closestY);
}

function firstContactOnSegment(startX, startY, endX, endY, pointX, pointY, radius) {
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return undefined;
  const t = ((pointX - startX) * dx + (pointY - startY) * dy) / lengthSquared;
  const clampedT = Math.max(0, Math.min(1, t));
  const contactX = startX + dx * clampedT;
  const contactY = startY + dy * clampedT;
  const distance = Math.hypot(pointX - contactX, pointY - contactY);
  if (distance > radius) return undefined;
  return { t: clampedT, x: contactX, y: contactY };
}

function roomSummary(roomId, room) {
  return {
    roomId,
    count: room.players.length,
    maxPlayers: room.maxPlayers,
    hostId: room.hostId,
    status: room.status,
    rematchReady: canRematch(room),
    players: room.players.map(({ id, name }) => ({ id, name, isHost: id === room.hostId })),
  };
}

function canRematch(room) {
  if (room.status !== "finished") return false;
  const remaining = room.players.filter((player) => player.status !== "eliminated");
  return remaining.length >= 2 && remaining.every((player) => player.status === "connected");
}

function gameStartData(roomId, room, player) {
  return {
    roomId,
    gameId: room.gameId,
    playerId: player.id,
    turnId: room.turnId,
    deadline: room.deadline,
    hostId: room.hostId,
    difficulty: room.difficulty,
    rematchReady: canRematch(room),
    players: room.state.marbles.map(({ id, name }) => ({ id, name })),
    state: snapshot(room),
  };
}

function startRound(roomId, room) {
  resetGameState(room);
  room.status = "playing";
  for (const player of room.practiceMemberId ? room.players.slice(0, 1) : room.players) {
    io.to(player.socketId).emit("game:start", gameStartData(roomId, room, player));
  }
}

function publish(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("room:update", roomSummary(roomId, room));
}

function emitError(socket, message, ack) {
  const result = { ok: false, error: message };
  socket.emit("game:error", message);
  if (typeof ack === "function") ack(result);
}

function emitAck(ack, payload) {
  if (typeof ack === "function") ack(payload);
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
    version: room.version,
    gameId: room.gameId,
    turnId: room.turnId,
    turnPlayerId: room.turnPlayerId,
    deadline: room.paused ? 0 : room.deadline,
    pausedRemainingMs: room.paused ? room.pausedRemainingMs : 0,
    state:
      room.status === "finished"
        ? "finished"
        : room.paused
          ? "paused"
          : room.moving
            ? "moving"
            : "wait_move",
    marbles: room.state.marbles,
    winnerId: room.state.winnerId,
  };
}

function broadcastState(roomId, room, requestId) {
  io.to(roomId).emit("game:state", { ...snapshot(room), requestId });
}

function resetGameState(room) {
  room.roundId = randomUUID();
  room.gameId += 1;
  room.version = 0;
  room.turnId = 1;
  room.turnPlayerId = room.players[0]?.id;
  room.deadline = Date.now() + TURN_LIMITS[room.difficulty];
  room.moving = false;
  room.paused = false;
  room.pausedRemainingMs = 0;
  room.lastRequestId = "";
  room.state = {
    winnerId: undefined,
    marbles: room.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      x: 100 + index * (room.players.length === 1 ? 0 : 400 / (room.players.length - 1)),
      y: 1200,
      lion: false,
      hole: 0,
      alive: true,
      inHole: true,
      score: 0,
      eliminated: false,
    })),
  };
}

function advanceTurn(roomId, room) {
  if (room.status !== "playing" || room.moving || room.paused) return;
  const next = nextAlive(room, room.turnPlayerId);
  if (next === undefined) {
    finishGame(roomId, room);
    return;
  }
  room.turnPlayerId = next;
  room.turnId += 1;
  room.deadline = Date.now() + TURN_LIMITS[room.difficulty];
  room.version += 1;
  broadcastState(roomId, room);
}

function finishGame(roomId, room) {
  if (room.status === "finished") return false;
  room.status = "finished";
  room.paused = false;
  room.moving = false;
  room.state.winnerId = room.state.marbles
    .filter((marble) => !marble.eliminated)
    .sort((a, b) => b.score - a.score)[0]?.id;
  room.deadline = 0;
  const winner = room.state.marbles.find((marble) => marble.id === room.state.winnerId);
  const winnerAccount = room.players.find((player) => player.id === winner?.id)?.memberId;
  const memberId = room.practiceMemberId ?? winnerAccount;
  if (memberId) {
    const result = [room.roundId, memberId, room.practiceMemberId ? "practice" : "multi", winner?.score ?? 0];
    accounts.record(...result).catch(() => {
      setTimeout(() => accounts.record(...result).catch(() => {
        console.error("Leaderboard result could not be saved");
      }), 500).unref();
    });
  }
  if (!room.players.some((player) => player.id === room.hostId && player.status !== "eliminated")) {
    room.hostId = room.players.find((player) => player.status !== "eliminated")?.id;
  }
  room.version += 1;
  broadcastState(roomId, room);
  io.to(roomId).emit("game:finished", { winnerId: room.state.winnerId });
  publish(roomId);
  return true;
}

function resumeIfReady(roomId, room) {
  if (
    room.status !== "playing" ||
    !room.paused ||
    room.players.some((player) => player.status === "disconnected")
  )
    return;
  const current = room.state.marbles.find((marble) => marble.id === room.turnPlayerId);
  if (!current?.alive) {
    const next = nextAlive(room, room.turnPlayerId);
    if (next === undefined) {
      finishGame(roomId, room);
      return;
    }
    room.turnPlayerId = next;
    room.turnId += 1;
    room.pausedRemainingMs = TURN_LIMITS[room.difficulty];
  }
  room.paused = false;
  room.deadline =
    Date.now() + (room.pausedRemainingMs > 0 ? room.pausedRemainingMs : TURN_LIMITS[room.difficulty]);
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
    if (mappedRoom === roomId && !io.sockets.sockets.get(socketId)?.connected)
      socketRooms.delete(socketId);
  });
  const marble = room.state.marbles.find((candidate) => candidate.id === player.id);
  if (marble) {
    marble.alive = false;
    marble.eliminated = true;
    marble.eliminationReason = reason;
  }
  io.to(roomId).emit("player:eliminated", { playerId: player.id, reason });
  const eliminatedCurrentTurn = room.turnPlayerId === player.id;
  const alive = room.state.marbles.filter((marble) => marble.alive);
  if (room.status === "playing" && alive.length <= 1) {
    finishGame(roomId, room);
    publish(roomId);
    return;
  }
  if (room.status === "playing" && eliminatedCurrentTurn) {
    room.moving = false;
    const next = nextAlive(room, player.id);
    if (next === undefined) {
      finishGame(roomId, room);
      publish(roomId);
      return;
    }
    room.turnPlayerId = next;
    room.turnId += 1;
    room.deadline = Date.now() + TURN_LIMITS[room.difficulty];
    room.pausedRemainingMs = TURN_LIMITS[room.difficulty];
  }
  if (room.status === "playing" && room.paused) {
    if (room.players.some((candidate) => candidate.status === "disconnected")) {
      room.deadline = 0;
    } else {
      resumeIfReady(roomId, room);
      publish(roomId);
      return;
    }
  }
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
  if (socket.data.practiceRoom) {
    rooms.delete(socket.data.practiceRoom);
    socketRooms.delete(socket.id);
    return;
  }
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
    if (room.status !== "playing") {
      room.players = room.players.filter((candidate) => candidate.id !== player.id);
      player.reconnectToken = undefined;
      if (room.hostId === player.id) room.hostId = room.players.find((candidate) => candidate.status !== "eliminated")?.id;
      if (room.players.every((candidate) => candidate.status === "eliminated")) rooms.delete(id);
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
  if (socket.data.practiceRoom === requestedRoom && requestedRoom) {
    rooms.delete(requestedRoom);
    socketRooms.delete(socket.id);
    socket.leave(requestedRoom);
    delete socket.data.practiceRoom;
    return;
  }
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
  if (room.players.every((candidate) => candidate.status === "eliminated")) rooms.delete(id);
  else {
    if (!room.players.some((candidate) => candidate.id === room.hostId))
      room.hostId = room.players.find((candidate) => candidate.status !== "eliminated")?.id;
    publish(id);
  }
}

setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.status === "playing" && !room.paused && !room.moving && Date.now() > room.deadline)
      advanceTurn(roomId, room);
  }
}, 250);

io.use((socket, next) => {
  if (!origins.includes("*") && socket.handshake.headers.origin &&
      !origins.includes(socket.handshake.headers.origin)) {
    return next(new Error("Origin not allowed"));
  }
  accounts.member(socket.request).then((member) => {
    if (!member) return next(new Error("AUTH_REQUIRED"));
    socket.data.member = member;
    next();
  }, () => next(new Error("Account service unavailable")));
});

io.on("connection", (socket) => {
  const rateBuckets = {
    create: [],
    join: [],
    move: [],
  };
  const allowRate = (key, { max, windowMs }) => {
    const now = Date.now();
    const bucket = rateBuckets[key];
    while (bucket.length > 0 && now - bucket[0] > windowMs) bucket.shift();
    if (bucket.length >= max) return false;
    bucket.push(now);
    return true;
  };

  socket.on("practice:start", (_payload, ack) => {
    const { id: memberId, nickname } = socket.data.member;
    if (socketRooms.has(socket.id) || rooms.size >= MAX_ROOM_COUNT ||
        !allowRate("create", CREATE_ROOM_RATE_LIMIT)) {
      return emitAck(ack, { ok: false, error: "기록을 저장하는 연습 경기를 시작할 수 없습니다." });
    }
    const id = randomUUID();
    const players = Array.from({ length: 4 }, (_, i) => ({
      id: i, name: `${nickname} ${i + 1}`, status: "connected", socketId: socket.id,
    }));
    const room = {
      hostId: 0, maxPlayers: 4, gameId: 0, difficulty: "normal", players, practiceMemberId: memberId,
    };
    rooms.set(id, room);
    socketRooms.set(socket.id, id);
    socket.data.practiceRoom = id;
    socket.join(id);
    startRound(id, room);
    emitAck(ack, { ok: true, round: gameStartData(id, room, players[0]) });
  });

  socket.on("room:create", (payload, ack) => {
    if (!allowRate("create", CREATE_ROOM_RATE_LIMIT))
      return emitError(socket, "요청이 너무 많습니다. 잠시 후 다시 시도하세요.", ack);
    if (socketRooms.has(socket.id)) return emitError(socket, "먼저 현재 방에서 나가세요.", ack);
    const maxPlayers = Number(payload?.maxPlayers);
    if (
      !Number.isInteger(maxPlayers) ||
      maxPlayers < 2 ||
      maxPlayers > 4
    )
      return emitError(socket, "인원수는 2~4명이어야 합니다.", ack);
    if (rooms.size >= MAX_ROOM_COUNT)
      return emitError(socket, "생성 가능한 방 한도를 초과했습니다.", ack);
    let roomId;
    let attempts = 0;
    do {
      roomId = String(Math.floor(Math.random() * 10_000)).padStart(4, "0");
      attempts += 1;
    } while (rooms.has(roomId) && attempts < ROOM_CODE_ISSUE_ATTEMPTS);
    if (rooms.has(roomId))
      return emitError(socket, "방 코드를 할당할 수 없습니다. 잠시 후 다시 시도하세요.", ack);
    const player = {
      id: 0,
      socketId: socket.id,
      name: socket.data.member.nickname,
      memberId: socket.data.member.id,
      status: "connected",
      reconnectToken: randomBytes(32).toString("hex"),
    };
    const room = {
      hostId: 0,
      maxPlayers,
      status: "waiting",
      players: [player],
      nextId: 1,
      gameId: 0,
      version: 0,
      turnId: 0,
      turnPlayerId: 0,
      deadline: 0,
      difficulty: "normal",
      moving: false,
      paused: false,
      pausedRemainingMs: 0,
      lastRequestId: "",
      state: { marbles: [] },
    };
    rooms.set(roomId, room);
    socketRooms.set(socket.id, roomId);
    socket.join(roomId);
    socket.emit("room:created", {
      roomId,
      count: 1,
      playerId: 0,
      reconnectToken: player.reconnectToken,
    });
    publish(roomId);
    emitAck(ack, { ok: true, playerId: 0, reconnectToken: player.reconnectToken });
  });

  socket.on("room:join", (payload, ack) => {
    if (!allowRate("join", JOIN_ROOM_RATE_LIMIT))
      return emitError(socket, "요청이 너무 많습니다. 잠시 후 다시 시도하세요.", ack);
    const id = roomIdOf(payload?.roomId);
    const room = rooms.get(id);
    if (socketRooms.has(socket.id)) return emitError(socket, "먼저 현재 방에서 나가세요.", ack);
    if (!room) return emitError(socket, "방을 찾을 수 없습니다.", ack);
    if (room.status !== "waiting")
      return emitError(socket, "진행 중인 방에는 참여할 수 없습니다.", ack);
    const { id: memberId, nickname } = socket.data.member;
    if (room.players.some((player) => player.memberId === memberId))
      return emitError(socket, "같은 계정으로 이미 방에 참여했습니다.", ack);
    if (room.players.length >= room.maxPlayers)
      return emitError(socket, "방이 가득 찼습니다.", ack);
    const player = {
      id: room.nextId++,
      socketId: socket.id,
      name: nickname,
      memberId,
      status: "connected",
      reconnectToken: randomBytes(32).toString("hex"),
    };
    room.players.push(player);
    socketRooms.set(socket.id, id);
    socket.join(id);
    publish(id);
    emitAck(ack, { ok: true, playerId: player.id, reconnectToken: player.reconnectToken });
  });

  socket.on("room:rejoin", (payload, ack) => {
    const id = roomIdOf(payload?.roomId);
    const token = sessionTokenOf(payload?.reconnectToken);
    const mappedRoom = roomIdOf(socketRooms.get(socket.id));
    if (mappedRoom && mappedRoom !== id)
      return emitError(socket, "먼저 현재 방에서 나가세요.", ack);
    const room = rooms.get(id);
    const player = room?.players.find((candidate) => candidate.reconnectToken === token);
    if (!room || !player || player.status === "eliminated" ||
        player.memberId !== socket.data.member.id)
      return emitError(socket, "재접속 세션이 만료되었습니다.", ack);
    if (player.socketId === socket.id && mappedRoom === id) {
      emitAck(ack, {
        ok: true,
        playerId: player.id,
        status: room.status,
        room: roomSummary(id, room),
        state: room.status === "playing" ? snapshot(room) : undefined,
        gameStartData: room.status === "waiting" ? undefined : gameStartData(id, room, player),
      });
      return;
    }
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
    const round = room.status === "waiting" ? undefined : gameStartData(id, room, player);
    if (round) socket.emit("game:start", round);
    emitAck(ack, {
      ok: true,
      playerId: player.id,
      status: room.status,
      room: roomSummary(id, room),
      state: room.status === "playing" ? snapshot(room) : undefined,
      gameStartData: round,
    });
  });

  socket.on("room:start", (payload, ack) => {
    const id = roomIdOf(payload?.roomId);
    const room = rooms.get(id);
    if (
      !room ||
      room.hostId !== room.players.find((player) => player.socketId === socket.id)?.id ||
      room.status !== "waiting" ||
      room.players.length !== room.maxPlayers ||
      room.players.some((player) => player.status !== "connected")
    )
      return emitError(socket, "게임을 시작할 수 없습니다.", ack);
    startRound(id, room);
    emitAck(ack, { ok: true });
  });

  socket.on("room:rematch", (payload, ack) => {
    const id = gameRoomIdOf(payload?.roomId, socket);
    const room = rooms.get(id);
    const player = room?.players.find((candidate) => candidate.socketId === socket.id);
    const difficulty = payload?.difficulty;
    if (typeof difficulty !== "string" || !Object.hasOwn(TURN_LIMITS, difficulty))
      return emitAck(ack, { ok: false, error: "올바른 난이도를 선택해 주세요." });
    if (!room || !player || player.id !== room.hostId || payload?.gameId !== room.gameId || !canRematch(room))
      return emitAck(ack, { ok: false, error: "모든 참가자가 연결되어 있고 두 명 이상일 때 방장이 재대결할 수 있습니다." });
    room.players = room.players.filter((candidate) => candidate.status === "connected");
    room.difficulty = difficulty;
    startRound(id, room);
    emitAck(ack, { ok: true });
  });

  socket.on("room:leave", (payload, ack) => {
    leaveRoom(socket, payload?.roomId);
    emitAck(ack, { ok: true });
  });

  socket.on("game:move", (payload, ack) => {
    if (!allowRate("move", MOVE_RATE_LIMIT))
      return emitError(socket, "입력이 너무 빠릅니다. 잠시 후 다시 시도하세요.", ack);
    const id = gameRoomIdOf(payload?.roomId, socket);
    const room = rooms.get(id);
    const player = room?.players.find((candidate) => candidate.socketId === socket.id &&
      (!room.practiceMemberId || candidate.id === room.turnPlayerId));
    const x = payload?.x;
    const y = payload?.y;
    const requestId = validRequestId(payload?.requestId) ? payload.requestId : "";
    const hasValidCoordinates =
      typeof x === "number" &&
      typeof y === "number" &&
      finiteCoordinate(x, 10, WIDTH - 10) &&
      finiteCoordinate(y, 10, HEIGHT - 10);
    const current = room?.state.marbles.find((marble) => marble.id === room.turnPlayerId);
    const distance =
      current && hasValidCoordinates ? Math.hypot(x - current.x, y - current.y) : Infinity;
    if (
      !room ||
      !player ||
      player.status !== "connected" ||
      room.status !== "playing" ||
      room.paused ||
      room.moving ||
      player.id !== room.turnPlayerId ||
      payload?.gameId !== room.gameId ||
      payload?.turnId !== room.turnId ||
      !requestId ||
      requestId === room.lastRequestId ||
      !hasValidCoordinates ||
      distance < 8 ||
      distance > MAX_MOVE_DISTANCE + 1e-6 ||
      Date.now() > room.deadline
    ) {
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
    const shotDx = x - startX;
    const shotDy = y - startY;
    const shotDistance = Math.hypot(shotDx, shotDy) || 1;
    let firstMarbleHit;
    for (const other of room.state.marbles) {
      if (other.id === current.id || !other.alive) continue;
      const contact = firstContactOnSegment(
        startX,
        startY,
        x,
        y,
        other.x,
        other.y,
        MARBLE_RADIUS * 2,
      );
      if (!contact) continue;
      if (!firstMarbleHit || contact.t < firstMarbleHit.t) {
        firstMarbleHit = { other, ...contact };
      }
    }
    let firstHoleHit;
    if (!current.lion) {
      const hole = HOLES[current.hole];
      if (hole) {
        const contact = firstContactOnSegment(
          startX,
          startY,
          x,
          y,
          hole.x,
          hole.y,
          HOLE_RADIUS + MARBLE_RADIUS,
        );
        if (contact) firstHoleHit = { hole, ...contact };
      }
    }
    const marbleBeforeHole =
      firstMarbleHit && (!firstHoleHit || firstMarbleHit.t <= firstHoleHit.t);
    if (marbleBeforeHole) {
      current.x = firstMarbleHit.x;
      current.y = firstMarbleHit.y;
      const other = firstMarbleHit.other;
      if (current.lion) {
        other.alive = false;
        current.score += 2;
        io.to(id).emit("game:lion-hit", { gameId: room.gameId, x: other.x, y: other.y });
      } else if (other.lion) {
        current.alive = false;
      } else {
        current.score += 1;
        other.inHole = false;
        const hitX = other.x - firstMarbleHit.x;
        const hitY = other.y - firstMarbleHit.y;
        const hitDistance = Math.hypot(hitX, hitY);
        const directionX = hitDistance > 0 ? hitX / hitDistance : shotDx / shotDistance;
        const directionY = hitDistance > 0 ? hitY / hitDistance : shotDy / shotDistance;
        const pushDistance = PUSH_DISTANCE_BASE + force * PUSH_DISTANCE_PER_FORCE;
        other.x = clamp(
          other.x + directionX * pushDistance,
          MIN_COORDINATE,
          WIDTH - MIN_COORDINATE,
        );
        other.y = clamp(
          other.y + directionY * pushDistance,
          MIN_COORDINATE,
          HEIGHT - MIN_COORDINATE,
        );
      }
    } else if (firstHoleHit && current.alive) {
      current.score += 2;
      current.x = firstHoleHit.hole.x;
      current.y = firstHoleHit.hole.y;
      current.hole += 1;
      current.inHole = current.hole < HOLES.length;
      current.lion = current.hole >= HOLES.length;
    }
    room.version += 1;
    room.moving = false;
    const alive = room.state.marbles.filter((marble) => marble.alive);
    if (alive.length <= 1) {
      finishGame(id, room);
    } else if (room.status === "playing") {
      advanceTurn(id, room);
    }
    broadcastState(id, room, requestId);
    emitAck(ack, { ok: true, version: room.version, requestId });
  });

  socket.on("disconnect", (reason) => {
    console.warn(`[socket] disconnected ${socket.id}: ${reason}`);
    markDisconnected(socket);
  });
});

httpServer.listen(port, () =>
  console.log(`Socket.IO server listening on http://localhost:${port}`),
);

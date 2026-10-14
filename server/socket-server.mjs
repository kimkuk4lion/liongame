import { createServer } from "node:http";
import { Server } from "socket.io";

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: "*" } });
const rooms = new Map();

function publish(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit("room:update", {
    roomId,
    count: room.players.length,
    maxPlayers: room.maxPlayers,
    host: room.players[0]?.socketId === room.host,
  });
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name, maxPlayers }) => {
    const count = Math.min(4, Math.max(2, Number(maxPlayers) || 2));
    const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
    rooms.set(roomId, { host: socket.id, maxPlayers: count, players: [{ socketId: socket.id, name }] });
    socket.join(roomId);
    socket.emit("room:created", { roomId, count: 1 });
    publish(roomId);
  });

  socket.on("room:join", ({ roomId, name }) => {
    const room = rooms.get(String(roomId).toUpperCase());
    if (!room) return socket.emit("game:error", "방을 찾을 수 없습니다.");
    if (room.players.length >= room.maxPlayers) return socket.emit("game:error", "방이 가득 찼습니다.");
    room.players.push({ socketId: socket.id, name: String(name || "플레이어") });
    socket.join(roomId);
    publish(roomId);
  });

  socket.on("room:start", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.host !== socket.id || room.players.length !== room.maxPlayers) return;
    io.to(roomId).emit("game:start", { roomId, names: room.players.map((player) => player.name) });
  });

  socket.on("game:move", ({ roomId, playerId, x, y }) => {
    if (!rooms.has(roomId) || !Number.isInteger(playerId)) return;
    socket.to(roomId).emit("game:move", { playerId, x, y });
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms) {
      room.players = room.players.filter((player) => player.socketId !== socket.id);
      if (room.players.length === 0) rooms.delete(roomId);
      else if (room.host === socket.id) room.host = room.players[0].socketId;
      else publish(roomId);
    }
  });
});

httpServer.listen(3001, () => console.log("Socket.IO server listening on http://localhost:3001"));

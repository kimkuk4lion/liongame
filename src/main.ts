import { io, Socket } from "socket.io-client";
import StartGame from "./game/main";
import type { Game as PhaserGame } from "phaser";

export type GameSettings = {
  mode: "practice" | "multi";
  playerCount: number;
  names: string[];
  roomId?: string;
  serverUrl: string;
  playerId?: number;
  turnId?: number;
  socket?: Socket;
  onExit?: () => void;
};

const SERVER_URL = import.meta.env.VITE_SOCKET_URL || (location.protocol === "https:" ? `${location.origin}` : "http://localhost:3001");
let nickname = "플레이어";
let socket: Socket | undefined;
let game: PhaserGame | undefined;
let screenGeneration = 0;

document.addEventListener("DOMContentLoaded", () => {
  showLobby();
});

function showLobby() {
  screenGeneration += 1;
  game?.destroy(true);
  game = undefined;
  socket?.disconnect();
  socket = undefined;
  const root = document.getElementById("game-container");
  if (!root) return;
  root.innerHTML = `
    <main class="lobby">
      <img src="/assets/logo.png" class="logo" alt="사자구슬게임">
      <h1>사자구슬게임</h1>
      <p class="subtitle">10초 안에 조준하고 상대를 밀어내세요!</p>
      <section class="panel">
        <label>닉네임 <input id="nickname" maxlength="10" placeholder="플레이어" value="${escapeHtml(nickname)}"></label>
        <div class="button-row">
          <button id="practice">연습모드 (구슬 4개)</button>
          <button id="multi">멀티플레이</button>
        </div>
      </section>
      <p id="lobby-status" class="status"></p>
    </main>`;
  root.querySelector("#practice")?.addEventListener("click", () => {
    nickname = inputValue(root, "#nickname", nickname);
    start({ mode: "practice", playerCount: 4, names: ["연습 1", "연습 2", "연습 3", "연습 4"], serverUrl: SERVER_URL });
  });
  root.querySelector("#multi")?.addEventListener("click", () => showMultiplayer(root));
}

function showMultiplayer(root: HTMLElement) {
  root.innerHTML = `
    <main class="lobby">
      <h1>멀티플레이</h1>
      <section class="panel">
        <label>닉네임 <input id="nickname" maxlength="10" placeholder="닉네임" value="${escapeHtml(nickname)}"></label>
        <label>인원수 <select id="count"><option>2</option><option>3</option><option>4</option></select></label>
        <div class="button-row">
          <button id="create">방 만들기</button>
          <button id="join">방 참여</button>
        </div>
        <input id="room" maxlength="8" placeholder="방 코드 (참여 시)">
      </section>
      <p id="lobby-status" class="status">Socket.IO 서버에 연결 중...</p>
    </main>`;
  const generation = screenGeneration;
  socket = io(SERVER_URL, { autoConnect: false });
  const currentSocket = socket;
  currentSocket.connect();
  const status = root.querySelector("#lobby-status") as HTMLElement;
  let roomCode = "";
  const cancel = document.createElement("button");
  cancel.textContent = "메인으로";
  cancel.addEventListener("click", showLobby);
  root.querySelector(".panel")?.append(cancel);
  currentSocket.on("connect", () => { status.textContent = "방을 만들거나 방 코드를 입력하세요."; });
  currentSocket.on("connect_error", () => { status.textContent = "멀티플레이 서버에 연결할 수 없습니다. 서버를 먼저 실행하세요."; });
  currentSocket.on("room:created", (room: { roomId: string; count: number }) => {
    if (generation !== screenGeneration) return;
    roomCode = room.roomId;
    status.textContent = `방 코드: ${roomCode} · ${room.count}명 입장 대기 중`;
  });
  currentSocket.on("room:update", (room: { roomId: string; count: number; maxPlayers: number; hostId: number; players: { id: number; name: string; isHost: boolean }[]; status: string }) => {
    if (generation !== screenGeneration) return;
    roomCode = room.roomId;
    status.textContent = `방 코드: ${roomCode} · ${room.count}/${room.maxPlayers}명`;
    if (!root.querySelector("#leave-room")) {
      const leave = document.createElement("button");
      leave.id = "leave-room";
      leave.textContent = "방 나가기";
      leave.addEventListener("click", () => {
        currentSocket.emit("room:leave", { roomId: roomCode }, () => showLobby());
        window.setTimeout(() => { if (generation === screenGeneration) showLobby(); }, 800);
      });
      root.querySelector(".panel")?.append(leave);
    }
    root.querySelector("#start-game")?.remove();
    if (room.hostId === room.players.find((player) => player.isHost)?.id && room.count >= room.maxPlayers && room.status === "waiting") addStartButton(root, currentSocket, () => roomCode);
  });
  currentSocket.on("game:start", (data: { roomId: string; names: string[]; playerId: number; turnId: number; deadline: number }) => {
    if (generation !== screenGeneration) return;
    start({ mode: "multi", playerCount: data.names.length, names: data.names, roomId: data.roomId, playerId: data.playerId, turnId: data.turnId, serverUrl: SERVER_URL, socket: currentSocket });
  });
  currentSocket.on("game:error", (message: string) => { if (generation === screenGeneration) status.textContent = message; });
  root.querySelector("#create")?.addEventListener("click", () => {
    nickname = inputValue(root, "#nickname", nickname);
    currentSocket.emit("room:create", { name: nickname, maxPlayers: Number(inputValue(root, "#count", "2")) });
  });
  root.querySelector("#join")?.addEventListener("click", () => {
    nickname = inputValue(root, "#nickname", nickname);
    roomCode = inputValue(root, "#room", "").toUpperCase();
    currentSocket.emit("room:join", { roomId: roomCode, name: nickname });
  });
}

function addStartButton(root: HTMLElement, socket: Socket, roomId: () => string) {
  if (root.querySelector("#start-game")) return;
  const button = document.createElement("button");
  button.id = "start-game";
  button.textContent = "게임 시작";
  button.addEventListener("click", () => socket.emit("room:start", { roomId: roomId() }));
  root.querySelector(".panel")?.append(button);
  if (!root.querySelector("#leave-room")) {
    const leave = document.createElement("button");
    leave.id = "leave-room";
    leave.textContent = "방 나가기";
    leave.addEventListener("click", () => { socket.emit("room:leave", {}, () => showLobby()); window.setTimeout(showLobby, 800); });
    root.querySelector(".panel")?.append(leave);
  }
}

function inputValue(root: HTMLElement, selector: string, fallback: string) {
  return (root.querySelector(selector) as HTMLInputElement | HTMLSelectElement)?.value || fallback;
}

function start(settings: GameSettings) {
  document.getElementById("game-container")!.innerHTML = "";
  settings.onExit = showLobby;
  game = StartGame("game-container", settings);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

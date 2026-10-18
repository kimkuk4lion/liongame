import { io, Socket } from "socket.io-client";
import StartGame from "./game/main";

export type GameSettings = {
  mode: "practice" | "multi";
  playerCount: number;
  names: string[];
  roomId?: string;
  serverUrl: string;
};

const SERVER_URL = "http://localhost:3001";

document.addEventListener("DOMContentLoaded", () => {
  showLobby();
});

function showLobby() {
  const root = document.getElementById("game-container");
  if (!root) return;
  root.innerHTML = `
    <main class="lobby">
      <img src="/assets/logo.png" class="logo" alt="사자구슬게임">
      <h1>사자구슬게임</h1>
      <p class="subtitle">10초 안에 조준하고 상대를 밀어내세요!</p>
      <section class="panel">
        <label>닉네임 <input id="nickname" maxlength="10" placeholder="플레이어" value="플레이어"></label>
        <div class="button-row">
          <button id="practice">연습모드 (구슬 4개)</button>
          <button id="multi">멀티플레이</button>
        </div>
      </section>
      <p id="lobby-status" class="status"></p>
    </main>`;
  root.querySelector("#practice")?.addEventListener("click", () => {
    start({ mode: "practice", playerCount: 4, names: ["연습 1", "연습 2", "연습 3", "연습 4"], serverUrl: SERVER_URL });
  });
  root.querySelector("#multi")?.addEventListener("click", () => showMultiplayer(root));
}

function showMultiplayer(root: HTMLElement) {
  root.innerHTML = `
    <main class="lobby">
      <h1>멀티플레이</h1>
      <section class="panel">
        <label>닉네임 <input id="nickname" maxlength="10" placeholder="닉네임" value="플레이어"></label>
        <label>인원수 <select id="count"><option>2</option><option>3</option><option>4</option></select></label>
        <div class="button-row">
          <button id="create">방 만들기</button>
          <button id="join">방 참여</button>
        </div>
        <input id="room" maxlength="8" placeholder="방 코드 (참여 시)">
      </section>
      <p id="lobby-status" class="status">Socket.IO 서버에 연결 중...</p>
    </main>`;
  const socket = io(SERVER_URL);
  const status = root.querySelector("#lobby-status") as HTMLElement;
  let roomCode = "";
  socket.on("connect", () => { status.textContent = "방을 만들거나 방 코드를 입력하세요."; });
  socket.on("connect_error", () => { status.textContent = "멀티플레이 서버에 연결할 수 없습니다. 서버를 먼저 실행하세요."; });
  socket.on("room:created", (room: { roomId: string; count: number }) => {
    roomCode = room.roomId;
    status.textContent = `방 코드: ${roomCode} · ${room.count}명 입장 대기 중`;
  });
  socket.on("room:update", (room: { roomId: string; count: number; maxPlayers: number; host: boolean }) => {
    roomCode = room.roomId;
    status.textContent = `방 코드: ${roomCode} · ${room.count}/${room.maxPlayers}명`;
    if (room.host && room.count >= room.maxPlayers) addStartButton(root, socket, roomCode);
  });
  socket.on("game:start", (game: { roomId: string; names: string[] }) => {
    socket.disconnect();
    start({ mode: "multi", playerCount: game.names.length, names: game.names, roomId: game.roomId, serverUrl: SERVER_URL });
  });
  root.querySelector("#create")?.addEventListener("click", () => {
    const name = inputValue(root, "#nickname", "플레이어");
    socket.emit("room:create", { name, maxPlayers: Number(inputValue(root, "#count", "2")) });
  });
  root.querySelector("#join")?.addEventListener("click", () => {
    const name = inputValue(root, "#nickname", "플레이어");
    roomCode = inputValue(root, "#room", "").toUpperCase();
    socket.emit("room:join", { roomId: roomCode, name });
  });
}

function addStartButton(root: HTMLElement, socket: Socket, roomId: string) {
  if (root.querySelector("#start-game")) return;
  const button = document.createElement("button");
  button.id = "start-game";
  button.textContent = "게임 시작";
  button.addEventListener("click", () => socket.emit("room:start", { roomId }));
  root.querySelector(".panel")?.append(button);
}

function inputValue(root: HTMLElement, selector: string, fallback: string) {
  return (root.querySelector(selector) as HTMLInputElement | HTMLSelectElement)?.value || fallback;
}

function start(settings: GameSettings) {
  document.getElementById("game-container")!.innerHTML = "";
  StartGame("game-container", settings);
}

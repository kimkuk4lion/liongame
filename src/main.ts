import { io, Socket } from "socket.io-client";
import StartGame from "./game/main";
import type { Game as PhaserGame } from "phaser";

export type GameSettings = {
  mode: "practice" | "multi";
  playerCount: number;
  names: string[];
  playerIds?: number[];
  roomId?: string;
  gameId?: number;
  initialState?: unknown;
  serverUrl: string;
  playerId?: number;
  reconnectToken?: string;
  turnId?: number;
  socket?: Socket;
  onExit?: () => void;
  onAbort?: () => void;
};

const SERVER_URL = import.meta.env.VITE_SOCKET_URL || (location.protocol === "https:" ? `${location.origin}` : "http://localhost:3001");
let nickname = "플레이어";
let socket: Socket | undefined;
let game: PhaserGame | undefined;
let screenGeneration = 0;
let screen: "main" | "waiting" | "playing" = "main";
let roomSession: { roomId: string; playerId: number; token?: string } | undefined;
let navigationTimer: number | undefined;

function clearNavigationTimer() {
  if (navigationTimer !== undefined) {
    window.clearTimeout(navigationTimer);
    navigationTimer = undefined;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  showLobby();
});

function showLobby() {
  clearNavigationTimer();
  screenGeneration += 1;
  screen = "main";
  roomSession = undefined;
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
  clearNavigationTimer();
  screen = "waiting";
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
        <input id="room" maxlength="4" inputmode="numeric" pattern="[0-9]{4}" placeholder="방 코드 (참여 시)">
      </section>
      <p id="lobby-status" class="status">Socket.IO 서버에 연결 중...</p>
    </main>`;
  const generation = screenGeneration;
  socket = io(SERVER_URL, {
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
  const currentSocket = socket;
  const status = root.querySelector("#lobby-status") as HTMLElement;
  let roomCode = "";
  let requestPending = false;
  const storedSession = readSession();
  const cancel = document.createElement("button");
  cancel.id = "main-cancel";
  cancel.textContent = "메인으로";
  cancel.addEventListener("click", showLobby);
  root.querySelector(".panel")?.append(cancel);
  currentSocket.on("connect", () => {
    if (storedSession && !roomSession) {
      roomCode = storedSession.roomId;
      roomSession = { roomId: storedSession.roomId, playerId: storedSession.playerId, token: storedSession.reconnectToken };
      currentSocket.emit("room:rejoin", storedSession, (result: { ok: boolean; error?: string }) => {
        if (!result?.ok) {
          roomSession = undefined;
          clearSession();
          status.textContent = result?.error || "재접속 세션이 만료되었습니다.";
        }
      });
    } else {
      status.textContent = "방을 만들거나 방 코드를 입력하세요.";
    }
  });
  currentSocket.on("disconnect", (reason) => {
    if (generation === screenGeneration && screen === "waiting") status.textContent = `서버 연결이 끊겼습니다. (${reason}) 재접속 중...`;
  });
  currentSocket.on("reconnect_attempt", () => {
    if (generation === screenGeneration && screen === "waiting") status.textContent = "서버에 재접속 중...";
  });
  currentSocket.on("connect_error", () => { status.textContent = "멀티플레이 서버에 연결할 수 없습니다. 서버를 먼저 실행하세요."; });
  const onCreated = (room: { roomId: string; count: number; playerId: number; reconnectToken: string }) => {
    if (generation !== screenGeneration) return;
    roomCode = room.roomId;
    roomSession = { roomId: room.roomId, playerId: room.playerId, token: room.reconnectToken };
    saveSession(room.roomId, room.playerId, room.reconnectToken);
    status.textContent = `방 코드: ${roomCode} · ${room.count}명 입장 대기 중`;
  };
  const onRoomUpdate = (room: { roomId: string; count: number; maxPlayers: number; hostId: number; players: { id: number; name: string; isHost: boolean }[]; status: string }) => {
    if (generation !== screenGeneration || screen !== "waiting") return;
    roomCode = room.roomId;
    status.textContent = `방 코드: ${roomCode} · ${room.count}/${room.maxPlayers}명`;
    if (!root.querySelector("#leave-room")) {
      const leave = document.createElement("button");
      leave.id = "leave-room";
      leave.textContent = "방 나가기";
      leave.addEventListener("click", () => {
        currentSocket.emit("room:leave", { roomId: roomCode }, () => showLobby());
        navigationTimer = window.setTimeout(() => {
          navigationTimer = undefined;
          if (generation === screenGeneration) showLobby();
        }, 800);
      });
      root.querySelector(".panel")?.append(leave);
    }
    const startButton = root.querySelector("#lobby-start-button") as HTMLButtonElement | null;
    if (startButton) startButton.remove();
    if (roomSession?.playerId === room.hostId && room.count >= room.maxPlayers && room.status === "waiting") addStartButton(root, currentSocket, () => roomCode);
  };
  const onStart = (data: { roomId: string; gameId: number; playerId: number; turnId: number; deadline: number; players: { id: number; name: string }[]; state: unknown }) => {
    if (generation !== screenGeneration) return;
    dispose();
    screen = "playing";
    start({
      mode: "multi",
      playerCount: data.players.length,
      names: data.players.map((player) => player.name),
      playerIds: data.players.map((player) => player.id),
      roomId: data.roomId,
      gameId: data.gameId,
      playerId: data.playerId,
      reconnectToken: roomSession?.token,
      turnId: data.turnId,
      initialState: data.state,
      serverUrl: SERVER_URL,
      socket: currentSocket,
      onAbort: () => {
        if (generation === screenGeneration && screen === "playing") {
          showWaiting(root, currentSocket, roomCode, generation);
        }
      },
      onExit: () => {
        clearSession();
        currentSocket.emit("room:leave", { roomId: roomCode }, () => showLobby());
      },
    });
  };
  const onError = (message: string) => { if (generation === screenGeneration) status.textContent = message; requestPending = false; setLobbyButtons(root, false); };
  currentSocket.on("room:created", onCreated);
  currentSocket.on("room:update", onRoomUpdate);
  currentSocket.on("game:start", onStart);
  currentSocket.on("game:error", onError);
  const dispose = () => {
    currentSocket.off("room:created", onCreated);
    currentSocket.off("room:update", onRoomUpdate);
    currentSocket.off("game:start", onStart);
    currentSocket.off("game:error", onError);
  };
  currentSocket.connect();
  root.querySelector("#create")?.addEventListener("click", () => {
    if (!currentSocket.connected || requestPending) return;
    nickname = inputValue(root, "#nickname", nickname);
    requestPending = true; setLobbyButtons(root, true);
    currentSocket.emit("room:create", { name: nickname, maxPlayers: Number(inputValue(root, "#count", "2")) }, (result: { ok: boolean; error?: string; playerId?: number; reconnectToken?: string }) => {
      if (!result?.ok) onError(result?.error || "방 생성에 실패했습니다.");
    });
  });
  root.querySelector("#join")?.addEventListener("click", () => {
    if (!currentSocket.connected || requestPending) return;
    nickname = inputValue(root, "#nickname", nickname);
    roomCode = inputValue(root, "#room", "").toUpperCase();
    requestPending = true; setLobbyButtons(root, true);
    currentSocket.emit("room:join", { roomId: roomCode, name: nickname }, (result: { ok: boolean; playerId?: number; reconnectToken?: string; error?: string }) => {
      if (result?.ok && result.playerId !== undefined && result.reconnectToken) {
        roomSession = { roomId: roomCode, playerId: result.playerId, token: result.reconnectToken };
        saveSession(roomCode, result.playerId, result.reconnectToken);
      }
      else onError(result?.error || "방 참여에 실패했습니다.");
    });
  });
  root.querySelector(".panel")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).id === "main-cancel") { dispose(); showLobby(); }
  });
}

function addStartButton(root: HTMLElement, socket: Socket, roomId: () => string) {
  if (root.querySelector("#lobby-start-button")) return;
  const button = document.createElement("button");
  button.id = "lobby-start-button";
  button.textContent = "게임 시작";
  button.addEventListener("click", () => {
    button.disabled = true;
    socket.emit("room:start", { roomId: roomId() }, (result: { ok: boolean }) => { if (!result?.ok) button.disabled = false; });
  });
  root.querySelector(".panel")?.append(button);
  if (!root.querySelector("#leave-room")) {
    const leave = document.createElement("button");
    leave.id = "leave-room";
    leave.textContent = "방 나가기";
    leave.addEventListener("click", () => {
      clearSession();
      socket.emit("room:leave", {}, () => showLobby());
      navigationTimer = window.setTimeout(() => {
        navigationTimer = undefined;
        showLobby();
      }, 800);
    });
    root.querySelector(".panel")?.append(leave);
  }
}

function showWaiting(root: HTMLElement, socket: Socket, roomId: string, generation: number) {
  clearNavigationTimer();
  if (generation !== screenGeneration) return;
  screen = "waiting";
  root.innerHTML = `<main class="lobby"><h1>대기방</h1><section class="panel"><p id="lobby-status" class="status">방 코드: ${escapeHtml(roomId)}</p><button id="waiting-leave">방 나가기</button></section></main>`;
  let disposed = false;
  root.querySelector("#waiting-leave")?.addEventListener("click", () => {
    dispose();
    clearSession();
    socket.emit("room:leave", { roomId }, () => showLobby());
    navigationTimer = window.setTimeout(() => {
      navigationTimer = undefined;
      if (generation === screenGeneration) showLobby();
    }, 800);
  });
  const status = root.querySelector("#lobby-status") as HTMLElement;
  const onUpdate = (room: { roomId: string; count: number; maxPlayers: number; hostId: number; status: string }) => {
    if (generation !== screenGeneration || screen !== "waiting") return;
    status.textContent = `방 코드: ${room.roomId} · ${room.count}/${room.maxPlayers}명`;
    root.querySelector("#lobby-start-button")?.remove();
    if (roomSession?.playerId === room.hostId && room.count >= room.maxPlayers && room.status === "waiting") addStartButton(root, socket, () => roomId);
  };
  const onStart = (data: { roomId: string; gameId: number; playerId: number; turnId: number; players: { id: number; name: string }[]; state: unknown }) => {
    if (generation !== screenGeneration) return;
    dispose();
    screen = "playing";
    start({ mode: "multi", playerCount: data.players.length, names: data.players.map((player) => player.name), playerIds: data.players.map((player) => player.id), roomId: data.roomId, gameId: data.gameId, playerId: data.playerId, turnId: data.turnId, initialState: data.state, serverUrl: SERVER_URL, socket, onAbort: () => showWaiting(root, socket, roomId, generation) });
  };
  const onError = (message: string) => { if (generation === screenGeneration) status.textContent = message; };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    socket.off("room:update", onUpdate);
    socket.off("game:start", onStart);
    socket.off("game:error", onError);
  };
  socket.on("room:update", onUpdate);
  socket.on("game:start", onStart);
  socket.on("game:error", onError);
}

function setLobbyButtons(root: HTMLElement, disabled: boolean) {
  root.querySelectorAll<HTMLButtonElement>("#create, #join, #lobby-start-button").forEach((button) => { button.disabled = disabled; });
}

function inputValue(root: HTMLElement, selector: string, fallback: string) {
  return (root.querySelector(selector) as HTMLInputElement | HTMLSelectElement)?.value || fallback;
}

function saveSession(roomId: string, playerId: number, token: string) {
  sessionStorage.setItem("liongame-session", JSON.stringify({ roomId, playerId, reconnectToken: token }));
}

function readSession(): { roomId: string; playerId: number; reconnectToken: string } | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem("liongame-session") || "null");
    return value && typeof value.roomId === "string" && typeof value.playerId === "number" && typeof value.reconnectToken === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function clearSession() {
  sessionStorage.removeItem("liongame-session");
}

function start(settings: GameSettings) {
  clearNavigationTimer();
  const root = document.getElementById("game-container")!;
  root.innerHTML = "";
  const onExit = settings.onExit ?? showLobby;
  const onAbort = settings.onAbort;
  settings.onExit = () => {
    game?.destroy(true);
    game = undefined;
    onExit();
  };
  settings.onAbort = onAbort
    ? () => {
      game?.destroy(true);
      game = undefined;
      onAbort();
    }
    : undefined;
  game?.destroy(true);
  game = StartGame("game-container", settings);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

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

type WaitingRoomUpdate = {
  roomId: string;
  count: number;
  maxPlayers: number;
  hostId: number;
  players?: { id: number; name: string; isHost: boolean }[];
  status: string;
};

type GameStartPayload = {
  roomId: string;
  gameId: number;
  playerId: number;
  turnId: number;
  deadline?: number;
  players: { id: number; name: string }[];
  state: unknown;
};

const SERVER_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (location.protocol === "https:" ? `${location.origin}` : "http://localhost:3001");
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
  root.classList.remove("game-active");
  root.innerHTML = `
    <main class="lobby">
      <div class="home">
        <header class="hero">
          <img src="./assets/logo.png" class="logo" alt="">
          <h1>사자구슬게임</h1>
          <p class="subtitle">10초 안에 조준하고 상대 구슬을 밀어내세요.</p>
        </header>
        <section class="mode-grid" aria-label="게임 모드">
          <button id="practice" class="mode-card">
            <strong>연습 모드</strong>
            <span>구슬 4개로 조준과 힘 조절을 익혀보세요.</span>
            <span class="mode-action">연습 시작 <span aria-hidden="true">→</span></span>
          </button>
          <button id="multi" class="mode-card mode-card-primary">
            <strong>멀티플레이</strong>
            <span>친구와 방 코드를 공유하고 2~4인 대전을 즐기세요.</span>
            <span class="mode-action">멀티플레이 입장 <span aria-hidden="true">→</span></span>
          </button>
        </section>
      </div>
    </main>`;
  root.querySelector("#practice")?.addEventListener("click", () => {
    start({
      mode: "practice",
      playerCount: 4,
      names: ["연습 1", "연습 2", "연습 3", "연습 4"],
      serverUrl: SERVER_URL,
    });
  });
  root.querySelector("#multi")?.addEventListener("click", () => showMultiplayer(root));
}

function showMultiplayer(root: HTMLElement) {
  clearNavigationTimer();
  screen = "waiting";
  root.innerHTML = `
    <main class="lobby">
      <div class="flow">
        <button id="main-cancel" class="back-button" type="button">← 메인으로</button>
        <h1>멀티플레이</h1>
        <section id="room-setup" class="panel">
          <label for="nickname">닉네임</label>
          <input id="nickname" maxlength="10" value="${escapeHtml(nickname)}">
          <div class="room-options">
            <div class="room-option">
              <label for="count">참가 인원</label>
              <select id="count"><option value="2">2명</option><option value="3">3명</option><option value="4">4명</option></select>
              <button id="create" type="button" disabled>방 만들기</button>
            </div>
            <form id="join-form" class="room-option">
              <label for="room">방 코드</label>
              <input id="room" maxlength="4" inputmode="numeric" pattern="[0-9]{4}" required placeholder="숫자 4자리">
              <button id="join" type="submit" disabled>방 참여</button>
            </form>
          </div>
        </section>
        ${waitingPanel(true)}
        <p id="lobby-status" class="status" role="status">서버에 연결 중입니다…</p>
      </div>
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
  let roomCode = roomSession?.roomId ?? "";
  let requestPending = false;
  let leavingToMain = false;
  let latestWaitingRoomUpdate: WaitingRoomUpdate | undefined;
  const cancel = root.querySelector<HTMLButtonElement>("#main-cancel")!;
  const leaveAndReturnToMain = () => {
    if (leavingToMain) return;
    leavingToMain = true;
    clearNavigationTimer();
    clearSession();
    roomSession = undefined;
    const targetRoomId = roomCode;
    if (currentSocket.connected && targetRoomId) {
      currentSocket.emit("room:leave", { roomId: targetRoomId }, () => {});
    } else {
      showLobby();
      return;
    }
    navigationTimer = window.setTimeout(() => {
      navigationTimer = undefined;
      if (generation === screenGeneration) showLobby();
    }, 800);
  };
  cancel.addEventListener("click", leaveAndReturnToMain);
  root.querySelector("#waiting-leave")?.addEventListener("click", leaveAndReturnToMain);
  currentSocket.on("connect", () => {
    const session = roomSession
      ? {
          roomId: roomSession.roomId,
          playerId: roomSession.playerId,
          reconnectToken: roomSession.token ?? "",
        }
      : readSession();
    if (session?.roomId && session.reconnectToken) {
      roomCode = session.roomId;
      roomSession = {
        roomId: session.roomId,
        playerId: session.playerId,
        token: session.reconnectToken,
      };
      status.textContent = "이전 세션을 확인 중입니다...";
      currentSocket.emit(
        "room:rejoin",
        session,
        (result: {
          ok: boolean;
          error?: string;
          playerId?: number;
          status?: "waiting" | "playing";
          room?: WaitingRoomUpdate;
          gameStartData?: GameStartPayload;
        }) => {
          if (generation !== screenGeneration || screen !== "waiting" || leavingToMain) return;
          if (!result?.ok) {
            roomSession = undefined;
            clearSession();
            status.textContent = result?.error || "재접속 세션이 만료되었습니다.";
            requestPending = false;
            setLobbyButtons(root, false);
            return;
          }
          roomSession = {
            roomId: session.roomId,
            playerId: result.playerId ?? session.playerId,
            token: session.reconnectToken,
          };
          saveSession(session.roomId, result.playerId ?? session.playerId, session.reconnectToken);
          if (result.status === "waiting") {
            const room = result.room ?? latestWaitingRoomUpdate;
            if (room) onRoomUpdate(room);
          } else if (result.status === "playing" && result.gameStartData) {
            onStart(result.gameStartData);
          } else {
            status.textContent = "진행 중 게임 상태를 복구 중입니다...";
          }
        },
      );
    } else {
      status.textContent = "방을 만들거나 방 코드를 입력하세요.";
      setLobbyButtons(root, requestPending);
    }
  });
  currentSocket.on("disconnect", () => {
    if (generation === screenGeneration && screen === "waiting") {
      requestPending = false;
      setLobbyButtons(root, true);
      status.textContent = "서버 연결이 끊겼습니다. 다시 연결하는 중입니다…";
    }
  });
  const onReconnectAttempt = () => {
    if (generation === screenGeneration && screen === "waiting")
      status.textContent = "서버에 재접속 중...";
  };
  currentSocket.io.on("reconnect_attempt", onReconnectAttempt);
  currentSocket.on("connect_error", () => {
    status.textContent = "멀티플레이 서버에 연결할 수 없습니다. 다시 시도하는 중입니다…";
  });
  const onCreated = (room: {
    roomId: string;
    count: number;
    playerId: number;
    reconnectToken: string;
  }) => {
    if (generation !== screenGeneration || leavingToMain) return;
    roomCode = room.roomId;
    roomSession = { roomId: room.roomId, playerId: room.playerId, token: room.reconnectToken };
    saveSession(room.roomId, room.playerId, room.reconnectToken);
    status.textContent = `방 코드: ${roomCode} · ${room.count}명 입장 대기 중`;
  };
  const onRoomUpdate = (room: WaitingRoomUpdate) => {
    if (generation !== screenGeneration || screen !== "waiting" || leavingToMain) return;
    latestWaitingRoomUpdate = room;
    roomCode = room.roomId;
    renderWaitingRoom(root, currentSocket, room, status);
  };
  const onStart = (data: GameStartPayload) => {
    if (generation !== screenGeneration || screen !== "waiting" || leavingToMain) return;
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
          showWaiting(root, currentSocket, roomCode, generation, leaveAndReturnToMain);
        }
      },
      onExit: leaveAndReturnToMain,
    });
  };
  const onError = (message: string) => {
    if (generation === screenGeneration) status.textContent = message;
    requestPending = false;
    setLobbyButtons(root, false);
  };
  currentSocket.on("room:created", onCreated);
  currentSocket.on("room:update", onRoomUpdate);
  currentSocket.on("game:start", onStart);
  currentSocket.on("game:error", onError);
  const dispose = () => {
    currentSocket.off("room:created", onCreated);
    currentSocket.off("room:update", onRoomUpdate);
    currentSocket.off("game:start", onStart);
    currentSocket.off("game:error", onError);
    currentSocket.io.off("reconnect_attempt", onReconnectAttempt);
  };
  currentSocket.connect();
  root.querySelector("#create")?.addEventListener("click", () => {
    if (!currentSocket.connected || requestPending) return;
    nickname = inputValue(root, "#nickname", nickname);
    requestPending = true;
    setLobbyButtons(root, true);
    currentSocket.emit(
      "room:create",
      { name: nickname, maxPlayers: Number(inputValue(root, "#count", "2")) },
      (result: { ok: boolean; error?: string; playerId?: number; reconnectToken?: string }) => {
        if (!result?.ok) onError(result?.error || "방 생성에 실패했습니다.");
      },
    );
  });
  root.querySelector("#join-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!currentSocket.connected || requestPending) return;
    nickname = inputValue(root, "#nickname", nickname);
    roomCode = inputValue(root, "#room", "").toUpperCase();
    requestPending = true;
    setLobbyButtons(root, true);
    currentSocket.emit(
      "room:join",
      { roomId: roomCode, name: nickname },
      (result: { ok: boolean; playerId?: number; reconnectToken?: string; error?: string }) => {
        if (generation !== screenGeneration || leavingToMain) return;
        if (result?.ok && result.playerId !== undefined && result.reconnectToken) {
          roomSession = {
            roomId: roomCode,
            playerId: result.playerId,
            token: result.reconnectToken,
          };
          saveSession(roomCode, result.playerId, result.reconnectToken);
          if (latestWaitingRoomUpdate) onRoomUpdate(latestWaitingRoomUpdate);
        } else onError(result?.error || "방 참여에 실패했습니다.");
      },
    );
  });
}

function waitingPanel(hidden = false) {
  return `
    <section id="waiting-panel" class="panel" aria-label="대기방" ${hidden ? "hidden" : ""}>
      <div class="room-summary">
        <div><span class="field-label">방 코드</span><strong id="waiting-code" class="room-code">—</strong></div>
        <span id="waiting-count"></span>
      </div>
      <p class="room-hint">친구에게 방 코드를 알려주세요.</p>
      <ul id="waiting-players" class="player-list" aria-label="참가자"></ul>
      <button id="lobby-start-button" type="button" hidden>게임 시작</button>
      <button id="waiting-leave" class="secondary-button" type="button">방 나가기</button>
    </section>`;
}

function renderWaitingRoom(
  root: HTMLElement,
  socket: Socket,
  room: WaitingRoomUpdate,
  status: HTMLElement,
) {
  root.querySelector("#room-setup")?.setAttribute("hidden", "");
  root.querySelector("#main-cancel")?.setAttribute("hidden", "");
  root.querySelector("#waiting-panel")?.removeAttribute("hidden");
  root.querySelector("h1")!.textContent = "대기방";
  root.querySelector("#waiting-code")!.textContent = room.roomId;
  root.querySelector("#waiting-count")!.textContent = `${room.count} / ${room.maxPlayers}명`;
  const players = (room.players ?? []).map((player) => {
    const row = document.createElement("li");
    row.textContent = player.name;
    if (player.isHost) {
      const badge = document.createElement("span");
      badge.textContent = "방장";
      row.append(badge);
    }
    return row;
  });
  root.querySelector("#waiting-players")!.replaceChildren(...players);
  const button = root.querySelector<HTMLButtonElement>("#lobby-start-button")!;
  const isHost = roomSession?.playerId === room.hostId;
  const isFull = room.count >= room.maxPlayers;
  button.hidden = !isHost || !isFull || room.status !== "waiting";
  button.disabled = !socket.connected;
  status.textContent = !isFull
    ? `${room.maxPlayers - room.count}명 더 입장하면 시작할 수 있습니다.`
    : isHost ? "모든 참가자가 입장했습니다." : "방장이 게임을 시작할 때까지 기다려 주세요.";
  button.onclick = () => {
    button.disabled = true;
    socket.emit("room:start", { roomId: room.roomId }, (result: { ok: boolean }) => {
      if (!result?.ok) button.disabled = false;
    });
  };
}

function showWaiting(
  root: HTMLElement,
  socket: Socket,
  roomId: string,
  generation: number,
  onLeave: () => void,
  initialRoom?: WaitingRoomUpdate,
) {
  clearNavigationTimer();
  if (generation !== screenGeneration) return;
  screen = "waiting";
  root.classList.remove("game-active");
  root.innerHTML = `<main class="lobby"><div class="flow"><h1>대기방</h1>
    ${waitingPanel()}<p id="lobby-status" class="status" role="status">대기방 정보를 불러오는 중입니다…</p>
    </div></main>`;
  root.querySelector("#waiting-code")!.textContent = roomId;
  let disposed = false;
  root.querySelector("#waiting-leave")?.addEventListener("click", () => {
    dispose();
    onLeave();
  });
  const status = root.querySelector("#lobby-status") as HTMLElement;
  const applyWaitingRoomUpdate = (room: WaitingRoomUpdate) => {
    if (generation !== screenGeneration || screen !== "waiting") return;
    renderWaitingRoom(root, socket, room, status);
  };
  const onUpdate = (room: WaitingRoomUpdate) => {
    applyWaitingRoomUpdate(room);
  };
  const onStart = (data: {
    roomId: string;
    gameId: number;
    playerId: number;
    turnId: number;
    players: { id: number; name: string }[];
    state: unknown;
  }) => {
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
      socket,
      onAbort: () => showWaiting(root, socket, roomId, generation, onLeave),
      onExit: onLeave,
    });
  };
  const onError = (message: string) => {
    if (generation === screenGeneration) status.textContent = message;
  };
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
  if (initialRoom) applyWaitingRoomUpdate(initialRoom);
}

function setLobbyButtons(root: HTMLElement, disabled: boolean) {
  root
    .querySelectorAll<HTMLButtonElement>("#create, #join, #lobby-start-button")
    .forEach((button) => {
      button.disabled = disabled;
    });
}

function inputValue(root: HTMLElement, selector: string, fallback: string) {
  return (root.querySelector(selector) as HTMLInputElement | HTMLSelectElement)?.value || fallback;
}

function saveSession(roomId: string, playerId: number, token: string) {
  try {
    sessionStorage.setItem(
      "liongame-session",
      JSON.stringify({ roomId, playerId, reconnectToken: token }),
    );
  } catch {
    // Ignore storage failures and keep UI flow alive.
  }
}

function readSession(): { roomId: string; playerId: number; reconnectToken: string } | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem("liongame-session") || "null");
    return value &&
      typeof value.roomId === "string" &&
      typeof value.playerId === "number" &&
      typeof value.reconnectToken === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem("liongame-session");
  } catch {
    // Ignore storage failures and keep UI flow alive.
  }
}

function start(settings: GameSettings) {
  clearNavigationTimer();
  const root = document.getElementById("game-container")!;
  root.classList.add("game-active");
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
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

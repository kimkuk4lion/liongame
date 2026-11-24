import { io, Socket } from "socket.io-client";
import StartGame from "./game/main";
import type { Game as PhaserGame } from "phaser";
import { TURN_SECONDS, type Difficulty } from "./constants";
import { mountAccount, showLeaderboard, showProfile } from "./account-ui";

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
  difficulty?: Difficulty;
  hostId?: number;
  rematchReady?: boolean;
  onFinished?: () => void;
  onReady?: () => void;
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
  rematchReady?: boolean;
};

type GameStartPayload = {
  roomId: string;
  gameId: number;
  playerId: number;
  turnId: number;
  deadline?: number;
  difficulty?: Difficulty;
  hostId?: number;
  rematchReady?: boolean;
  players: { id: number; name: string }[];
  state: unknown;
};

const SERVER_URL =
  import.meta.env.VITE_SOCKET_URL || location.origin;
let socket: Socket | undefined;
let game: PhaserGame | undefined;
let disposeRound: (() => void) | undefined;
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

function showLobby(notice = "") {
  clearNavigationTimer();
  screenGeneration += 1;
  screen = "main";
  roomSession = undefined;
  disposeRound?.();
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
          <button id="practice" class="mode-card" disabled>
            <strong>연습 모드</strong>
            <span>구슬 4개로 조준과 힘 조절을 익혀보세요.</span>
            <span class="mode-action">연습 시작 <span aria-hidden="true">→</span></span>
          </button>
          <button id="multi" class="mode-card mode-card-primary" disabled>
            <strong>멀티플레이</strong>
            <span>친구와 방 코드를 공유하고 2~4인 대전을 즐기세요.</span>
            <span class="mode-action">멀티플레이 입장 <span aria-hidden="true">→</span></span>
          </button>
        </section>
        <footer class="home-actions">
          <div id="account-actions">
            <a id="kakao-login" class="account-login" href="/api/auth/kakao" aria-disabled="true">카카오 로그인</a>
            <span id="account-nickname" hidden></span>
            <button id="my-page" class="secondary-button" type="button">마이페이지</button>
          </div>
          <button id="leaderboard" class="secondary-button">순위표</button>
        </footer>
        <p id="home-status" class="status" role="status"></p>
      </div>
    </main>`;
  const practice = root.querySelector<HTMLButtonElement>("#practice")!;
  const multi = root.querySelector<HTMLButtonElement>("#multi")!;
  const status = root.querySelector<HTMLElement>("#home-status")!;
  status.textContent = notice;
  void mountAccount(root).then((session) => {
    if (!practice.isConnected) return;
    practice.disabled = multi.disabled = false;
    const requireLogin = () => {
      if (session?.member) return true;
      if (session?.loginEnabled) {
        location.assign("/api/auth/kakao");
      } else {
        status.textContent = "플레이하려면 카카오 로그인이 필요합니다. 서버의 로그인 설정을 확인해 주세요.";
      }
      return false;
    };
    practice.onclick = () => {
      if (!requireLogin()) return;
      practice.disabled = true;
      void startRankedPractice(practice, status);
    };
    multi.onclick = () => {
      if (requireLogin() && session?.member) showMultiplayer(root, session.member.nickname);
    };
  });
  root.querySelector("#my-page")?.addEventListener("click", () => {
    socket?.disconnect();
    socket = undefined;
    showProfile(root, () => showLobby(), () => {
      clearSession();
      showLobby("로그아웃했습니다.");
    });
  });
  root.querySelector("#leaderboard")?.addEventListener("click", () => {
    socket?.disconnect();
    socket = undefined;
    showLeaderboard(root, () => showLobby());
  });
}

async function startRankedPractice(button: HTMLButtonElement, status: HTMLElement) {
  const current = io(SERVER_URL, { reconnection: false, withCredentials: true, timeout: 4000 });
  socket = current;
  current.on("connect_error", (error) => {
    if (button.isConnected && error.message === "AUTH_REQUIRED") location.assign("/api/auth/kakao");
  });
  status.textContent = "순위에 반영되는 연습 경기를 준비 중입니다…";
  try {
    const result = await current.timeout(5000).emitWithAck("practice:start", {});
    if (!button.isConnected) {
      current.disconnect();
      return;
    }
    if (!result?.ok) throw new Error(result?.error || "연습 경기를 시작할 수 없습니다.");
    const round: GameStartPayload = result.round;
    screen = "playing";
    current.on("disconnect", () => {
      if (socket === current && screen === "playing") {
        showLobby("연습 경기 연결이 끊겼습니다.");
      }
    });
    start({
      mode: "practice", playerCount: round.players.length,
      names: round.players.map((player) => player.name),
      playerIds: round.players.map((player) => player.id),
      roomId: round.roomId, gameId: round.gameId, playerId: round.playerId,
      turnId: round.turnId, hostId: round.hostId, difficulty: round.difficulty,
      rematchReady: round.rematchReady, initialState: round.state,
      serverUrl: SERVER_URL, socket: current,
    });
  } catch (error) {
    current.disconnect();
    if (button.isConnected) {
      button.disabled = false;
      status.textContent = error instanceof Error ? error.message : "연습 경기를 시작할 수 없습니다.";
    }
  }
}

function showMultiplayer(root: HTMLElement, nickname: string) {
  socket?.disconnect();
  clearNavigationTimer();
  screen = "waiting";
  root.innerHTML = `
    <main class="lobby">
      <div class="flow">
        <button id="main-cancel" class="back-button" type="button">← 메인으로</button>
        <h1>멀티플레이</h1>
        <section id="room-setup" class="panel">
          <label for="nickname">닉네임</label>
          <input id="nickname" value="${escapeHtml(nickname)}" readonly>
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
    withCredentials: true,
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
          status?: "waiting" | "playing" | "finished";
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
          } else if (result.gameStartData) {
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
  currentSocket.on("connect_error", (error) => {
    if (error.message === "AUTH_REQUIRED") {
      if (status.isConnected) location.assign("/api/auth/kakao");
      return;
    }
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
      hostId: data.hostId,
      difficulty: data.difficulty,
      rematchReady: data.rematchReady,
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
    requestPending = true;
    setLobbyButtons(root, true);
    currentSocket.emit(
      "room:create",
      { maxPlayers: Number(inputValue(root, "#count", "2")) },
      (result: { ok: boolean; error?: string; playerId?: number; reconnectToken?: string }) => {
        if (!result?.ok) onError(result?.error || "방 생성에 실패했습니다.");
      },
    );
  });
  root.querySelector("#join-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!currentSocket.connected || requestPending) return;
    roomCode = inputValue(root, "#room", "").toUpperCase();
    requestPending = true;
    setLobbyButtons(root, true);
    currentSocket.emit(
      "room:join",
      { roomId: roomCode },
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
  const onStart = (data: GameStartPayload) => {
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
      hostId: data.hostId,
      difficulty: data.difficulty,
      rematchReady: data.rematchReady,
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

function start(settings: GameSettings, showGuide = true) {
  clearNavigationTimer();
  disposeRound?.();
  const root = document.getElementById("game-container")!;
  root.classList.add("game-active");
  root.innerHTML = "";
  const onExit = settings.onExit ?? showLobby;
  const onAbort = settings.onAbort;
  const currentSocket = settings.socket;
  let active = true;
  let room = { hostId: settings.hostId, rematchReady: settings.rematchReady };
  let updateActions: (() => void) | undefined;
  let guide: HTMLElement | undefined;
  let guideTimer: number | undefined;
  const removeGuide = () => {
    window.clearTimeout(guideTimer);
    guide?.remove();
    guide = undefined;
  };
  const onRoomUpdate = (update: WaitingRoomUpdate) => {
    if (update.roomId !== settings.roomId) return;
    room = { hostId: update.hostId, rematchReady: update.rematchReady };
    updateActions?.();
  };
  const onNextRound = (data: GameStartPayload) => {
    if (data.roomId !== settings.roomId || data.gameId < (settings.gameId ?? 0)) return;
    start({
      ...settings,
      gameId: data.gameId,
      turnId: data.turnId,
      difficulty: data.difficulty,
      hostId: data.hostId,
      rematchReady: data.rematchReady,
      playerId: data.playerId,
      playerCount: data.players.length,
      playerIds: data.players.map((player) => player.id),
      names: data.players.map((player) => player.name),
      initialState: data.state,
    }, data.gameId !== settings.gameId);
  };
  if (currentSocket) {
    currentSocket.on("game:start", onNextRound);
    currentSocket.on("room:update", onRoomUpdate);
  }
  disposeRound = () => {
    active = false;
    removeGuide();
    currentSocket?.off("game:start", onNextRound);
    currentSocket?.off("room:update", onRoomUpdate);
    disposeRound = undefined;
  };
  const leaveRound = (callback: () => void) => {
    if (!active) return;
    disposeRound?.();
    game?.destroy(true);
    game = undefined;
    callback();
  };
  const onFinished = () => {
    if (!active) return;
    removeGuide();
    const form = document.createElement("form");
    form.className = "result-actions";
    form.innerHTML = `
      <div class="result-controls">
        <label for="rematch-difficulty">다음 경기 난이도</label>
        <select id="rematch-difficulty">
          <option value="easy">쉬움 · ${TURN_SECONDS.easy}초</option>
          <option value="normal">보통 · ${TURN_SECONDS.normal}초</option>
          <option value="hard">어려움 · ${TURN_SECONDS.hard}초</option>
        </select>
        <button type="submit">재대결</button>
      </div>
      <p class="status" role="status"></p>`;
    const controls = form.querySelector<HTMLElement>(".result-controls")!;
    const difficulty = form.querySelector("select")!;
    const rematch = form.querySelector("button")!;
    const status = form.querySelector("p")!;
    difficulty.value = settings.difficulty ?? "normal";
    let pending = false;
    updateActions = () => {
      const isHost = !currentSocket || room.hostId === settings.playerId;
      controls.hidden = !isHost;
      rematch.disabled = pending || Boolean(currentSocket && !room.rematchReady);
      status.textContent = !isHost
        ? "방장이 재대결을 시작할 수 있습니다."
        : pending ? "재대결을 준비 중입니다…"
          : rematch.disabled ? "참가자가 두 명 이상이고 모두 연결되어야 재대결할 수 있습니다." : "";
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!active || controls.hidden || rematch.disabled) return;
      const selected = difficulty.value as Difficulty;
      if (!currentSocket) {
        start({ ...settings, difficulty: selected });
        return;
      }
      pending = true;
      updateActions?.();
      try {
        if (!currentSocket.connected) throw new Error("서버에 다시 연결한 뒤 시도해 주세요.");
        const result = await currentSocket.timeout(4000).emitWithAck("room:rematch", {
          roomId: settings.roomId,
          gameId: settings.gameId,
          difficulty: selected,
        });
        if (!result?.ok) throw new Error(result?.error || "재대결을 시작할 수 없습니다.");
      } catch (error) {
        if (!active) return;
        pending = false;
        updateActions?.();
        status.textContent = error instanceof Error ? error.message : "재대결을 시작할 수 없습니다.";
      }
    });
    updateActions();
    root.append(form);
  };
  game?.destroy(true);
  game = StartGame("game-container", {
    ...settings,
    onFinished,
    onReady: () => {
      if (!active || !showGuide) return;
      guide = document.createElement("aside");
      guide.className = "game-guide";
      guide.setAttribute("role", "status");
      guide.innerHTML = `<strong>게임 방법</strong>
        <span>내 차례에 구슬을 누르고, 보낼 방향의 반대로 당겼다가 놓으세요.</span>`;
      root.append(guide);
      guideTimer = window.setTimeout(removeGuide, 4000);
    },
    onExit: () => leaveRound(onExit),
    onAbort: onAbort ? () => leaveRound(onAbort) : undefined,
  });
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

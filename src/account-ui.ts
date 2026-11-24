export type Session = { loginEnabled: boolean; member: { nickname: string } | null };
type Mode = "practice" | "multi";
type Entry = { rank: number; nickname: string; value: number };

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(6000) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || "요청을 처리하지 못했습니다.");
  return data as T;
}

export async function mountAccount(root: HTMLElement) {
  const loginLink = root.querySelector<HTMLAnchorElement>("#kakao-login")!;
  const nickname = root.querySelector<HTMLElement>("#account-nickname")!;
  const status = root.querySelector<HTMLElement>("#home-status")!;
  let canLogin = false;
  loginLink.addEventListener("click", (event) => {
    if (canLogin) return;
    event.preventDefault();
    status.textContent = "카카오 로그인 설정과 서버 연결을 확인해 주세요.";
  });
  const url = new URL(location.href);
  const login = url.searchParams.get("login");
  if (login) {
    status.textContent = login === "cancelled" ? "카카오 로그인을 취소했습니다." : "카카오 로그인에 실패했습니다.";
    url.searchParams.delete("login");
    history.replaceState(null, "", url);
  }
  try {
    const session = await api<Session>("/api/auth/session");
    if (!loginLink.isConnected) return session;
    canLogin = session.loginEnabled;
    loginLink.hidden = Boolean(session.member);
    loginLink.setAttribute("aria-disabled", String(!canLogin));
    nickname.textContent = session.member?.nickname ?? "";
    nickname.hidden = !session.member;
    return session;
  } catch {
    status.textContent ||= "로그인 상태를 확인할 수 없습니다.";
    return null;
  }
}

export function showProfile(root: HTMLElement, onBack: () => void, onLogout: () => void) {
  root.innerHTML = `
    <main class="lobby">
      <div class="flow">
        <button id="profile-back" class="back-button" type="button">← 메인으로</button>
        <h1>마이페이지</h1>
        <section class="panel" aria-label="내 계정">
          <p class="status" role="status" id="profile-status">계정 정보를 불러오는 중입니다…</p>
          <div class="profile-details" hidden>
            <form id="profile-form" class="profile-details">
              <label for="profile-nickname">닉네임</label>
              <input id="profile-nickname" minlength="2" maxlength="10" required
                aria-describedby="nickname-help">
              <small id="nickname-help">문자와 숫자로 2~10자</small>
              <button type="submit">닉네임 저장</button>
            </form>
            <button id="profile-logout" class="secondary-button" type="button">로그아웃</button>
          </div>
        </section>
      </div>
    </main>`;
  const back = root.querySelector<HTMLButtonElement>("#profile-back")!;
  const status = root.querySelector<HTMLElement>("#profile-status")!;
  const details = root.querySelector<HTMLElement>(".profile-details")!;
  const form = root.querySelector<HTMLFormElement>("#profile-form")!;
  const nickname = root.querySelector<HTMLInputElement>("#profile-nickname")!;
  const save = form.querySelector("button")!;
  const logout = root.querySelector<HTMLButtonElement>("#profile-logout")!;
  back.onclick = onBack;
  void api<{ nickname: string }>("/api/auth/profile").then((profile) => {
    nickname.value = profile.nickname;
    details.hidden = false;
    status.textContent = "";
  }).catch((error) => {
    status.textContent = error.message;
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = nickname.disabled = logout.disabled = true;
    status.textContent = "닉네임을 저장하는 중입니다…";
    try {
      const profile = await api<{ nickname: string }>("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: nickname.value }),
      });
      nickname.value = profile.nickname;
      status.textContent = "닉네임을 변경했습니다.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "닉네임을 저장하지 못했습니다.";
    } finally {
      save.disabled = nickname.disabled = logout.disabled = false;
    }
  };
  logout.onclick = async () => {
    save.disabled = nickname.disabled = logout.disabled = true;
    try {
      await api("/api/auth/logout", { method: "POST" });
      if (back.isConnected) onLogout();
    } catch {
      save.disabled = nickname.disabled = logout.disabled = false;
      status.textContent = "로그아웃하지 못했습니다. 다시 시도해 주세요.";
    }
  };
}

export function showLeaderboard(root: HTMLElement, onBack: () => void) {
  root.innerHTML = `
    <main class="lobby">
      <div class="flow">
        <button id="ranking-back" class="back-button">← 메인으로</button>
        <h1>순위표</h1>
        <section class="panel" aria-label="게임 순위">
          <div class="ranking-tabs" aria-label="순위 분류">
            <button id="ranking-practice" type="button" aria-pressed="true">연습 최고 점수</button>
            <button id="ranking-multi" type="button" aria-pressed="false">멀티 승리 횟수</button>
          </div>
          <p class="status" role="status" id="ranking-status"></p>
          <table class="ranking-table" hidden>
            <thead><tr><th scope="col">순위</th><th scope="col">플레이어</th><th scope="col" id="ranking-metric"></th></tr></thead>
            <tbody></tbody>
          </table>
        </section>
      </div>
    </main>`;
  const back = root.querySelector<HTMLButtonElement>("#ranking-back")!;
  const practice = root.querySelector<HTMLButtonElement>("#ranking-practice")!;
  const multi = root.querySelector<HTMLButtonElement>("#ranking-multi")!;
  const status = root.querySelector<HTMLElement>("#ranking-status")!;
  const metric = root.querySelector<HTMLElement>("#ranking-metric")!;
  const table = root.querySelector<HTMLTableElement>(".ranking-table")!;
  let request = 0;
  async function load(mode: Mode) {
    const currentRequest = ++request;
    practice.setAttribute("aria-pressed", String(mode === "practice"));
    multi.setAttribute("aria-pressed", String(mode === "multi"));
    status.textContent = "순위를 불러오는 중입니다…";
    table.hidden = true;
    try {
      const { entries } = await api<{ entries: Entry[] }>(`/api/leaderboard?mode=${mode}`);
      if (!back.isConnected || currentRequest !== request) return;
      metric.textContent = mode === "practice" ? "최고 점수" : "승리 횟수";
      const rows = entries.map(({ rank, nickname, value }) => {
        const row = document.createElement("tr");
        for (const text of [String(rank), nickname, String(value)]) row.insertCell().textContent = text;
        return row;
      });
      table.tBodies[0].replaceChildren(...rows);
      status.textContent = rows.length ? "" : "아직 등록된 기록이 없습니다.";
      table.hidden = !rows.length;
    } catch (error) {
      if (back.isConnected && currentRequest === request) {
        status.textContent = error instanceof Error && error.name === "Error"
          ? error.message : "순위를 불러오지 못했습니다.";
      }
    }
  }
  back.onclick = onBack;
  practice.onclick = () => void load("practice");
  multi.onclick = () => void load("multi");
  void load("practice");
}

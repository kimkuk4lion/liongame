import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import pg from "pg";

const sessionSeconds = 30 * 24 * 60 * 60;
const loginSeconds = 600;
const token = () => randomBytes(32).toString("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const isToken = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nicknameWords = [
  "사자자리", "반딧불이", "해바라기", "무지갯빛", "구름다리", "사막여우", "바다거북",
  "고슴도치", "개똥벌레", "소금쟁이", "산들바람", "은하열차", "왕잠자리", "별빛정원",
  "달빛산책", "바람개비", "물수제비", "나무늘보",
];

function randomNickname() {
  return nicknameWords[randomInt(nicknameWords.length)] + String(randomInt(10_000)).padStart(4, "0");
}

async function readJson(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes <= 1024) chunks.push(chunk);
  }
  if (bytes > 1024) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export async function createAccounts({
  env = process.env,
  fetchProvider = fetch,
  pool = env.DATABASE_URL ? new pg.Pool({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  }) : undefined,
} = {}) {
  const configuredUrl = env.APP_URL?.trim();
  const appUrl = configuredUrl ? URL.parse(configuredUrl) : null;
  if (configuredUrl && (!appUrl || !["http:", "https:"].includes(appUrl.protocol) ||
      appUrl.username || appUrl.password)) {
    throw new Error("APP_URL must be an absolute HTTP or HTTPS service URL.");
  }
  const redirectUri = env.KAKAO_REDIRECT_URI;
  const kakaoKey = env.KAKAO_REST_API_KEY;
  const loginEnabled = Boolean(appUrl && pool && kakaoKey && redirectUri);
  const secure = appUrl?.protocol === "https:" || Boolean(redirectUri?.startsWith("https:"));
  const sessionCookie = secure ? "__Host-lion_session" : "lion_session";
  const stateCookie = secure ? "__Host-lion_state" : "lion_state";
  pool?.on?.("error", () => console.error("PostgreSQL connection error"));
  await pool?.query(`
    CREATE TABLE IF NOT EXISTS lion_members (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kakao_id text NOT NULL UNIQUE,
      nickname text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lion_sessions (
      token_hash text PRIMARY KEY,
      member_id bigint NOT NULL REFERENCES lion_members(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lion_results (
      round_id uuid PRIMARY KEY,
      member_id bigint NOT NULL REFERENCES lion_members(id) ON DELETE CASCADE,
      mode text NOT NULL CHECK (mode IN ('practice', 'multi')),
      score integer NOT NULL CHECK (score >= 0)
    );
    CREATE INDEX IF NOT EXISTS lion_results_mode_member ON lion_results (mode, member_id);
  `);

  function getCookie(req, name) {
    return req.headers.cookie?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(name + "="))?.slice(name.length + 1);
  }

  function cookie(name, value, age) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`;
  }

  function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  function redirect(res, url, cookies = []) {
    res.writeHead(302, { Location: String(url), "Set-Cookie": cookies });
    res.end();
  }

  function loginResult(res, status, session) {
    const destination = new URL(appUrl);
    if (status) destination.searchParams.set("login", status);
    const cookies = [cookie(stateCookie, "", 0)];
    if (session) cookies.push(cookie(sessionCookie, session, sessionSeconds));
    redirect(res, destination, cookies);
  }

  async function member(req) {
    const session = getCookie(req, sessionCookie);
    if (!pool || !isToken(session)) return null;
    const { rows } = await pool.query(
      `SELECT m.id, m.nickname FROM lion_sessions s JOIN lion_members m ON m.id = s.member_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hash(session)],
    );
    return rows[0] ?? null;
  }

  async function kakaoCallback(req, res, url) {
    const state = url.searchParams.get("state");
    const expected = getCookie(req, stateCookie);
    if (!isToken(state) || !isToken(expected) ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
      return loginResult(res, "failed");
    }
    if (url.searchParams.get("error") === "access_denied") return loginResult(res, "cancelled");
    const code = url.searchParams.get("code");
    if (!code) return loginResult(res, "failed");
    const body = new URLSearchParams({
      grant_type: "authorization_code", client_id: kakaoKey, redirect_uri: redirectUri, code,
    });
    if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);
    const exchange = await fetchProvider("https://kauth.kakao.com/oauth/token", {
      method: "POST", body, signal: AbortSignal.timeout(8000),
    });
    if (!exchange.ok) return loginResult(res, "failed");
    const { access_token: accessToken } = await exchange.json();
    if (typeof accessToken !== "string" || !accessToken) return loginResult(res, "failed");
    const tokenInfo = await fetchProvider("https://kapi.kakao.com/v1/user/access_token_info", {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000),
    });
    if (!tokenInfo.ok) return loginResult(res, "failed");
    const info = JSON.parse(await tokenInfo.text(), (key, value, context) =>
      key === "id" && Number.isInteger(value) && /^\d+$/.test(context?.source ?? "")
        ? context.source : value,
    );
    const kakaoId = String(info.id ?? "");
    if (!/^\d{1,20}$/.test(kakaoId)) return loginResult(res, "failed");
    const { rows } = await pool.query(
      `INSERT INTO lion_members (kakao_id, nickname) VALUES ($1, $2)
       ON CONFLICT (kakao_id) DO UPDATE SET kakao_id = EXCLUDED.kakao_id RETURNING id`,
      [kakaoId, randomNickname()],
    );
    const session = token();
    const previous = getCookie(req, sessionCookie);
    await pool.query(
      `WITH expired AS (
         DELETE FROM lion_sessions WHERE expires_at <= now() OR token_hash = $4
       )
       INSERT INTO lion_sessions (token_hash, member_id, expires_at)
       VALUES ($1, $2, now() + $3 * interval '1 second')`,
      [hash(session), rows[0].id, sessionSeconds, isToken(previous) ? hash(previous) : null],
    );
    loginResult(res, undefined, session);
  }

  async function handle(req, res) {
    const url = new URL(req.url, appUrl ?? "http://request.invalid");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" && url.pathname === "/api/auth/kakao") {
      if (!loginEnabled) return json(res, 503, { error: "카카오 로그인 설정이 필요합니다." });
      const state = token();
      const authorize = new URL("https://kauth.kakao.com/oauth/authorize");
      authorize.search = new URLSearchParams({
        response_type: "code", client_id: kakaoKey, redirect_uri: redirectUri, state,
      });
      return redirect(res, authorize, [cookie(stateCookie, state, loginSeconds)]);
    }
    if (req.method === "GET" && url.pathname === "/api/auth/kakao/callback") {
      if (!loginEnabled) return json(res, 503, { error: "카카오 로그인 설정이 필요합니다." });
      try {
        return await kakaoCallback(req, res, url);
      } catch {
        console.error("Kakao login request failed");
        return loginResult(res, "failed");
      }
    }
    if (req.method === "GET" && url.pathname === "/api/auth/session") {
      const account = await member(req);
      return json(res, 200, { loginEnabled, member: account ? { nickname: account.nickname } : null });
    }
    if (url.pathname === "/api/auth/profile" && (req.method === "GET" || req.method === "PATCH")) {
      if (req.method === "PATCH" && (!appUrl || req.headers.origin !== appUrl.origin)) {
        return json(res, 403, { error: "허용되지 않은 요청입니다." });
      }
      const account = await member(req);
      if (!account) return json(res, 401, { error: "카카오 로그인 후 이용할 수 있습니다." });
      if (req.method === "GET") {
        return json(res, 200, { nickname: account.nickname });
      }
      const body = await readJson(req);
      const nickname = typeof body?.nickname === "string" ? body.nickname.trim().normalize("NFC") : "";
      if (!/^[\p{L}\p{N}]{2,10}$/u.test(nickname)) {
        return json(res, 400, { error: "닉네임은 문자와 숫자로 2~10자까지 입력해 주세요." });
      }
      const { rows } = await pool.query(
        `UPDATE lion_members m SET nickname = $1 FROM lion_sessions s
         WHERE m.id = s.member_id AND s.token_hash = $2 AND s.expires_at > now()
         RETURNING m.nickname`,
        [nickname, hash(getCookie(req, sessionCookie))],
      );
      if (!rows[0]) return json(res, 401, { error: "로그인 세션이 만료되었습니다." });
      return json(res, 200, rows[0]);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      if (!appUrl || req.headers.origin !== appUrl.origin) return json(res, 403, { error: "허용되지 않은 요청입니다." });
      const session = getCookie(req, sessionCookie);
      if (pool && isToken(session)) {
        await pool.query("DELETE FROM lion_sessions WHERE token_hash = $1", [hash(session)]);
      }
      res.setHeader("Set-Cookie", cookie(sessionCookie, "", 0));
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/leaderboard") {
      const mode = url.searchParams.get("mode");
      if (mode !== "practice" && mode !== "multi") return json(res, 400, { error: "게임 모드를 선택해 주세요." });
      if (!pool) return json(res, 503, { error: "순위표 데이터베이스가 연결되지 않았습니다." });
      const { rows } = await pool.query(
        `WITH totals AS (
           SELECT member_id, CASE WHEN $1 = 'practice' THEN max(score) ELSE count(*) END AS value
           FROM lion_results WHERE mode = $1 GROUP BY member_id
         )
         SELECT dense_rank() OVER (ORDER BY value DESC) AS rank, m.nickname, value
         FROM totals JOIN lion_members m ON m.id = totals.member_id
         ORDER BY value DESC, totals.member_id LIMIT 10`,
        [mode],
      );
      return json(res, 200, { entries: rows.map(({ rank, nickname, value }) => ({
        rank: Number(rank), nickname, value: Number(value),
      })) });
    }
    return json(res, 404, { error: "요청을 찾을 수 없습니다." });
  }

  async function record(roundId, memberId, mode, score) {
    if (!pool || !memberId) return;
    await pool.query(
      `INSERT INTO lion_results (round_id, member_id, mode, score) VALUES ($1, $2, $3, $4)
       ON CONFLICT (round_id) DO NOTHING`,
      [roundId, memberId, mode, score],
    );
  }

  return { handle, member, record };
}

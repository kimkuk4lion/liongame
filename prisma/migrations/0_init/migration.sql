CREATE TABLE "lion_members" (
    "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "kakao_id" text NOT NULL UNIQUE,
    "nickname" text NOT NULL
);

CREATE TABLE "lion_sessions" (
    "token_hash" text PRIMARY KEY,
    "member_id" bigint NOT NULL REFERENCES "lion_members"("id") ON DELETE CASCADE,
    "expires_at" timestamptz NOT NULL
);

CREATE TABLE "lion_results" (
    "round_id" uuid PRIMARY KEY,
    "member_id" bigint NOT NULL REFERENCES "lion_members"("id") ON DELETE CASCADE,
    "mode" text NOT NULL CHECK ("mode" IN ('practice', 'multi')),
    "score" integer NOT NULL CHECK ("score" >= 0)
);

CREATE INDEX "lion_results_mode_member" ON "lion_results" ("mode", "member_id");

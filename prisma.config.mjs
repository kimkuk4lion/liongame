import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { defineConfig } from "prisma/config";

function databaseUrlFrom(file) {
  try {
    return parseEnv(readFileSync(file, "utf8")).DATABASE_URL;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const environmentFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env.development";
const databaseUrl = process.env.DATABASE_URL ?? databaseUrlFrom(environmentFile) ?? databaseUrlFrom(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: databaseUrl || undefined },
});

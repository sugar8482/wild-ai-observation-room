import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresArchive } from "../lib/postgres-archive.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function localSettings() {
  const content = await readFile(resolve(projectRoot, ".env.local"), "utf8");
  return Object.fromEntries(content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
}

const settings = await localSettings();
const connectionString = process.env.OBSERVATION_DATABASE_URL || settings.OBSERVATION_DATABASE_URL || "";
if (!connectionString) throw new Error("OBSERVATION_DATABASE_URL 未配置，未执行迁移");
const ssl = String(process.env.OBSERVATION_DATABASE_SSL || settings.OBSERVATION_DATABASE_SSL || "false")
  .toLowerCase() === "true";
const statePath = resolve(process.argv[2] || resolve(projectRoot, "data", "state.json"));
const snapshot = JSON.parse(await readFile(statePath, "utf8"));
const archive = createPostgresArchive({ connectionString, ssl });
try {
  const counts = await archive.syncWerewolfSnapshot(snapshot);
  console.log(JSON.stringify({ ok: true, statePath, ...counts }));
} finally {
  await archive.close();
}

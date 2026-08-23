import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = resolve(projectRoot, "data", "state.json");
const settingsPath = resolve(projectRoot, ".env.local");
const apply = process.argv.includes("--apply");

function parseSettings(source) {
  const settings = {};
  for (const rawLine of String(source || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    settings[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return settings;
}

function archivedMessage(row) {
  return {
    id: row.message_id,
    kind: row.kind,
    author: row.author,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.external_id ? { externalId: row.external_id } : {}),
    ...(row.source ? { source: row.source } : {}),
    ...(row.privacy === "private" ? {
      privacy: "private",
      recipientIds: Array.isArray(row.recipient_ids) ? row.recipient_ids : [],
    } : {}),
    text: row.body,
    timestamp: new Date(row.sent_at).getTime(),
  };
}

const [settingsSource, stateSource] = await Promise.all([
  readFile(settingsPath, "utf8"),
  readFile(statePath, "utf8"),
]);
const settings = parseSettings(settingsSource);
const connectionString = process.env.OBSERVATION_DATABASE_URL || settings.OBSERVATION_DATABASE_URL || "";
if (!connectionString) throw new Error("OBSERVATION_DATABASE_URL 未配置");
const sslEnabled = String(
  process.env.OBSERVATION_DATABASE_SSL || settings.OBSERVATION_DATABASE_SSL || "false",
).toLowerCase() === "true";
const state = JSON.parse(stateSource);
const pool = new Pool({
  connectionString,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  max: 1,
  application_name: "wild-ai-observation-room-restore",
});

const report = [];
try {
  for (const room of Array.isArray(state.rooms) ? state.rooms : []) {
    const result = await pool.query(`
      SELECT message_id, kind, author, agent_id, external_id, source,
        privacy, recipient_ids, body, sent_at
      FROM room_messages
      WHERE room_id = $1
      ORDER BY sent_at, message_id
    `, [room.id]);
    const existingById = new Map(
      (Array.isArray(room.messages) ? room.messages : [])
        .filter((message) => message?.id)
        .map((message) => [message.id, message]),
    );
    const restored = result.rows.map((row) => {
      const archived = archivedMessage(row);
      return existingById.get(archived.id) || archived;
    });
    const restoredIds = new Set(restored.map((message) => message.id));
    const currentOnly = [...existingById.values()].filter((message) => !restoredIds.has(message.id));
    const merged = [...restored, ...currentOnly]
      .sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
    const before = Array.isArray(room.messages) ? room.messages.length : 0;
    room.messages = merged;
    report.push({ room: room.name, before, archived: result.rowCount, after: merged.length, added: merged.length - before });
  }

  if (apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${statePath}.before-message-restore-${stamp}.bak`;
    const temporaryPath = `${statePath}.restore.tmp`;
    await copyFile(statePath, backupPath);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, statePath);
  }
} finally {
  await pool.end();
}

console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", rooms: report }, null, 2));

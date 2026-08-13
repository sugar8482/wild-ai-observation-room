import pg from "pg";

const { Pool } = pg;
const SCHEMA_VERSION = 1;
const DEFAULT_RETRY_MS = 30_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS archive_agents (
  agent_id text PRIMARY KEY,
  name text NOT NULL,
  provider_format text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  persona text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS archive_rooms (
  room_id text PRIMARY KEY,
  name text NOT NULL,
  room_prompt text NOT NULL DEFAULT '',
  participant_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  archived boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_messages (
  room_id text NOT NULL,
  message_id text NOT NULL,
  kind text NOT NULL,
  author text NOT NULL,
  agent_id text,
  external_id text,
  source text NOT NULL DEFAULT '',
  privacy text NOT NULL DEFAULT 'public',
  recipient_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  body text NOT NULL,
  sent_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, message_id)
);

CREATE INDEX IF NOT EXISTS room_messages_room_time_idx
  ON room_messages (room_id, sent_at, message_id);
CREATE INDEX IF NOT EXISTS room_messages_agent_time_idx
  ON room_messages (agent_id, sent_at)
  WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS room_messages_privacy_idx
  ON room_messages (privacy, sent_at);

CREATE TABLE IF NOT EXISTS room_summaries (
  room_id text PRIMARY KEY,
  summary text NOT NULL DEFAULT '',
  focus text NOT NULL DEFAULT '',
  summarized_through_id text,
  summarized_message_count integer NOT NULL DEFAULT 0,
  stale boolean NOT NULL DEFAULT false,
  updated_at timestamptz,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_summary_versions (
  id bigserial PRIMARY KEY,
  room_id text NOT NULL,
  summary text NOT NULL,
  focus text NOT NULL DEFAULT '',
  summarized_through_id text,
  summarized_message_count integer NOT NULL DEFAULT 0,
  stale boolean NOT NULL DEFAULT false,
  source_updated_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, source_updated_at)
);

CREATE TABLE IF NOT EXISTS agent_private_memories (
  agent_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  memory text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT 0,
  archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_private_memory_versions (
  id bigserial PRIMARY KEY,
  agent_id text NOT NULL,
  memory text NOT NULL,
  revision bigint NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, revision)
);

CREATE TABLE IF NOT EXISTS archive_sync_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL,
  last_synced_at timestamptz,
  room_count integer NOT NULL DEFAULT 0,
  message_count integer NOT NULL DEFAULT 0,
  summary_count integer NOT NULL DEFAULT 0,
  private_memory_count integer NOT NULL DEFAULT 0
);
`;

function clean(value) {
  return String(value ?? "");
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function snapshotToArchiveRows(snapshot = {}) {
  const agents = (Array.isArray(snapshot.agents) ? snapshot.agents : [])
    .filter((agent) => clean(agent?.id))
    .map((agent) => ({
      agent_id: clean(agent.id),
      name: clean(agent.name) || "未命名嘉宾",
      provider_format: clean(agent.format),
      model: clean(agent.model),
      persona: clean(agent.persona),
    }));
  const privateMemories = (Array.isArray(snapshot.agents) ? snapshot.agents : [])
    .filter((agent) => clean(agent?.id))
    .map((agent) => ({
      agent_id: clean(agent.id),
      enabled: agent.memoryEnabled === true,
      memory: clean(agent.memory),
      revision: Math.max(0, Math.trunc(finiteNumber(agent.memoryRevision))),
    }));
  const rooms = [];
  const messages = [];
  const summaries = [];
  for (const room of Array.isArray(snapshot.rooms) ? snapshot.rooms : []) {
    const roomId = clean(room?.id);
    if (!roomId) continue;
    rooms.push({
      room_id: roomId,
      name: clean(room.name) || "未命名房间",
      room_prompt: clean(room.roomPrompt),
      participant_ids: Array.isArray(room.participantIds) ? room.participantIds.map(clean).filter(Boolean) : [],
      updated_at_ms: finiteNumber(room.updatedAt, Date.now()),
    });
    for (const message of Array.isArray(room.messages) ? room.messages : []) {
      const messageId = clean(message?.id);
      if (!messageId) continue;
      messages.push({
        room_id: roomId,
        message_id: messageId,
        kind: clean(message.kind) || "user",
        author: clean(message.author) || "未知",
        agent_id: clean(message.agentId) || null,
        external_id: clean(message.externalId) || null,
        source: clean(message.source),
        privacy: message.privacy === "private" ? "private" : "public",
        recipient_ids: Array.isArray(message.recipientIds) ? message.recipientIds.map(clean).filter(Boolean) : [],
        body: clean(message.text),
        sent_at_ms: finiteNumber(message.timestamp, Date.now()),
      });
    }
    const memory = room.memory && typeof room.memory === "object" ? room.memory : {};
    summaries.push({
      room_id: roomId,
      summary: clean(memory.summary),
      focus: clean(memory.focus),
      summarized_through_id: clean(memory.summarizedThroughId) || null,
      summarized_message_count: Math.max(0, Math.trunc(finiteNumber(memory.summarizedMessageCount))),
      stale: memory.stale === true,
      updated_at_ms: finiteNumber(memory.updatedAt, 0) || null,
    });
  }
  return { agents, rooms, messages, summaries, privateMemories };
}

async function syncRows(client, rows) {
  await client.query("BEGIN");
  try {
    await client.query(`
      UPDATE archive_agents SET archived = true
      WHERE agent_id NOT IN (SELECT value FROM jsonb_array_elements_text($1::jsonb))
    `, [JSON.stringify(rows.agents.map((item) => item.agent_id))]);
    await client.query(`
      UPDATE archive_rooms SET archived = true
      WHERE room_id NOT IN (SELECT value FROM jsonb_array_elements_text($1::jsonb))
    `, [JSON.stringify(rows.rooms.map((item) => item.room_id))]);

    await client.query(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          agent_id text, name text, provider_format text, model text, persona text
        )
      )
      INSERT INTO archive_agents (agent_id, name, provider_format, model, persona, archived, last_seen_at)
      SELECT agent_id, name, provider_format, model, persona, false, now() FROM incoming
      ON CONFLICT (agent_id) DO UPDATE SET
        name = EXCLUDED.name,
        provider_format = EXCLUDED.provider_format,
        model = EXCLUDED.model,
        persona = EXCLUDED.persona,
        archived = false,
        last_seen_at = now()
    `, [JSON.stringify(rows.agents)]);

    await client.query(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          room_id text, name text, room_prompt text, participant_ids jsonb, updated_at_ms double precision
        )
      )
      INSERT INTO archive_rooms (room_id, name, room_prompt, participant_ids, archived, updated_at)
      SELECT room_id, name, room_prompt, participant_ids, false, to_timestamp(updated_at_ms / 1000.0) FROM incoming
      ON CONFLICT (room_id) DO UPDATE SET
        name = EXCLUDED.name,
        room_prompt = EXCLUDED.room_prompt,
        participant_ids = EXCLUDED.participant_ids,
        archived = false,
        updated_at = EXCLUDED.updated_at
    `, [JSON.stringify(rows.rooms)]);

    await client.query(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          room_id text, message_id text, kind text, author text, agent_id text,
          external_id text, source text, privacy text, recipient_ids jsonb,
          body text, sent_at_ms double precision
        )
      )
      INSERT INTO room_messages (
        room_id, message_id, kind, author, agent_id, external_id,
        source, privacy, recipient_ids, body, sent_at
      )
      SELECT room_id, message_id, kind, author, agent_id, external_id,
        source, privacy, recipient_ids, body, to_timestamp(sent_at_ms / 1000.0)
      FROM incoming
      ON CONFLICT (room_id, message_id) DO UPDATE SET
        kind = EXCLUDED.kind,
        author = EXCLUDED.author,
        agent_id = EXCLUDED.agent_id,
        external_id = EXCLUDED.external_id,
        source = EXCLUDED.source,
        privacy = EXCLUDED.privacy,
        recipient_ids = EXCLUDED.recipient_ids,
        body = EXCLUDED.body,
        sent_at = EXCLUDED.sent_at
    `, [JSON.stringify(rows.messages)]);

    await client.query(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          room_id text, summary text, focus text, summarized_through_id text,
          summarized_message_count integer, stale boolean, updated_at_ms double precision
        )
      )
      INSERT INTO room_summaries (
        room_id, summary, focus, summarized_through_id,
        summarized_message_count, stale, updated_at, archived_at
      )
      SELECT room_id, summary, focus, summarized_through_id,
        summarized_message_count, stale,
        CASE WHEN updated_at_ms IS NULL THEN NULL ELSE to_timestamp(updated_at_ms / 1000.0) END,
        now()
      FROM incoming
      ON CONFLICT (room_id) DO UPDATE SET
        summary = EXCLUDED.summary,
        focus = EXCLUDED.focus,
        summarized_through_id = EXCLUDED.summarized_through_id,
        summarized_message_count = EXCLUDED.summarized_message_count,
        stale = EXCLUDED.stale,
        updated_at = EXCLUDED.updated_at,
        archived_at = now()
    `, [JSON.stringify(rows.summaries)]);

    await client.query(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          room_id text, summary text, focus text, summarized_through_id text,
          summarized_message_count integer, stale boolean, updated_at_ms double precision
        )
      )
      INSERT INTO room_summary_versions (
        room_id, summary, focus, summarized_through_id,
        summarized_message_count, stale, source_updated_at
      )
      SELECT room_id, summary, focus, summarized_through_id,
        summarized_message_count, stale, to_timestamp(updated_at_ms / 1000.0)
      FROM incoming
      WHERE summary <> '' AND updated_at_ms IS NOT NULL
      ON CONFLICT (room_id, source_updated_at) DO NOTHING
    `, [JSON.stringify(rows.summaries)]);

    await client.query(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          agent_id text, enabled boolean, memory text, revision numeric
        )
      )
      INSERT INTO agent_private_memories (agent_id, enabled, memory, revision, archived_at)
      SELECT agent_id, enabled, memory, revision::bigint, now() FROM incoming
      ON CONFLICT (agent_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        memory = EXCLUDED.memory,
        revision = EXCLUDED.revision,
        archived_at = now()
    `, [JSON.stringify(rows.privateMemories)]);

    await client.query(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          agent_id text, enabled boolean, memory text, revision numeric
        )
      )
      INSERT INTO agent_private_memory_versions (agent_id, memory, revision)
      SELECT agent_id, memory, revision::bigint FROM incoming
      WHERE memory <> '' AND revision > 0
      ON CONFLICT (agent_id, revision) DO NOTHING
    `, [JSON.stringify(rows.privateMemories)]);

    await client.query(`
      INSERT INTO archive_sync_state (
        singleton, schema_version, last_synced_at,
        room_count, message_count, summary_count, private_memory_count
      ) VALUES (true, $1, now(), $2, $3, $4, $5)
      ON CONFLICT (singleton) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        last_synced_at = EXCLUDED.last_synced_at,
        room_count = EXCLUDED.room_count,
        message_count = EXCLUDED.message_count,
        summary_count = EXCLUDED.summary_count,
        private_memory_count = EXCLUDED.private_memory_count
    `, [
      SCHEMA_VERSION,
      rows.rooms.length,
      rows.messages.length,
      rows.summaries.filter((item) => item.summary).length,
      rows.privateMemories.filter((item) => item.memory).length,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export function createPostgresArchive({
  connectionString = "",
  ssl = false,
  retryMs = DEFAULT_RETRY_MS,
  now = Date.now,
  logger = console,
  pool: providedPool = null,
} = {}) {
  const enabled = Boolean(String(connectionString || "").trim() || providedPool);
  const pool = enabled
    ? providedPool || new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: false } : false,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      application_name: "wild-ai-observation-room",
    })
    : null;
  let schemaPromise = null;
  let pendingSnapshot = null;
  let running = false;
  let stopped = false;
  let retryTimer = null;
  let lastSuccessAt = null;
  let lastAttemptAt = null;
  let lastError = "";
  let lastCounts = null;

  async function ensureSchema() {
    if (!enabled) return;
    if (!schemaPromise) schemaPromise = pool.query(SCHEMA_SQL).catch((error) => {
      schemaPromise = null;
      throw error;
    });
    await schemaPromise;
  }

  function scheduleRetry() {
    if (stopped || retryTimer || !pendingSnapshot) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drain();
    }, Math.max(1_000, Number(retryMs) || DEFAULT_RETRY_MS));
    retryTimer.unref?.();
  }

  async function syncSnapshot(snapshot) {
    await ensureSchema();
    const rows = snapshotToArchiveRows(snapshot);
    const client = await pool.connect();
    try {
      await syncRows(client, rows);
    } finally {
      client.release();
    }
    return {
      rooms: rows.rooms.length,
      messages: rows.messages.length,
      summaries: rows.summaries.filter((item) => item.summary).length,
      privateMemories: rows.privateMemories.filter((item) => item.memory).length,
    };
  }

  async function drain() {
    if (!enabled || stopped || running || !pendingSnapshot) return;
    running = true;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    lastAttemptAt = now();
    try {
      lastCounts = await syncSnapshot(snapshot);
      lastSuccessAt = now();
      lastError = "";
    } catch (error) {
      pendingSnapshot ||= snapshot;
      lastError = error?.message || "PostgreSQL 档案同步失败";
      logger.warn?.(`[archive] ${lastError}`);
    } finally {
      running = false;
    }
    if (pendingSnapshot) {
      if (lastError) scheduleRetry();
      else queueMicrotask(() => void drain());
    }
  }

  function enqueue(snapshot) {
    if (!enabled || stopped || !snapshot) return false;
    pendingSnapshot = structuredClone(snapshot);
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    queueMicrotask(() => void drain());
    return true;
  }

  function status() {
    return {
      enabled,
      state: !enabled ? "disabled" : lastError ? "error" : running ? "syncing" : lastSuccessAt ? "ready" : "connecting",
      syncing: running,
      pending: Boolean(pendingSnapshot),
      lastSuccessAt,
      lastAttemptAt,
      lastError,
      counts: lastCounts,
      retryMs: enabled ? Math.max(1_000, Number(retryMs) || DEFAULT_RETRY_MS) : null,
    };
  }

  async function flush({ timeoutMs = 10_000 } = {}) {
    if (!enabled) return true;
    const deadline = now() + timeoutMs;
    while ((running || pendingSnapshot) && now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !running && !pendingSnapshot;
  }

  async function close() {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    await pool?.end?.();
  }

  return { enqueue, status, flush, close, syncSnapshot };
}

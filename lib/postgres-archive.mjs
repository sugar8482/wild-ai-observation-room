import pg from "pg";
import { roomMembers } from "../public/room-presence.js";
import {
  WEREWOLF_ARCHIVE_SCHEMA_SQL,
  deleteWerewolfEvent as deleteStoredWerewolfEvent,
  editWerewolfEvent as editStoredWerewolfEvent,
  listWerewolfArchives,
  loadCurrentWerewolfGame,
  loadWerewolfGame,
  snapshotToWerewolfRows,
  syncWerewolfRows,
} from "./werewolf-archive.mjs";

const { Pool } = pg;
const SCHEMA_VERSION = 4;
const DEFAULT_RETRY_MS = 30_000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_state_current (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state_data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS room_members (
  room_id text NOT NULL,
  member_id text NOT NULL,
  name text NOT NULL,
  member_type text NOT NULL,
  status text NOT NULL,
  note text NOT NULL DEFAULT '',
  joined_at timestamptz NOT NULL,
  status_changed_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, member_id)
);

CREATE INDEX IF NOT EXISTS room_members_room_status_idx
  ON room_members (room_id, status, status_changed_at);

CREATE TABLE IF NOT EXISTS room_member_events (
  id bigserial PRIMARY KEY,
  room_id text NOT NULL,
  member_id text NOT NULL,
  name text NOT NULL,
  member_type text NOT NULL,
  status text NOT NULL,
  note text NOT NULL DEFAULT '',
  happened_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, member_id, happened_at)
);

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

ALTER TABLE archive_sync_state
  ADD COLUMN IF NOT EXISTS member_count integer NOT NULL DEFAULT 0;

ALTER TABLE archive_sync_state
  ADD COLUMN IF NOT EXISTS werewolf_game_count integer NOT NULL DEFAULT 0;

ALTER TABLE archive_sync_state
  ADD COLUMN IF NOT EXISTS werewolf_event_count integer NOT NULL DEFAULT 0;

ALTER TABLE archive_sync_state
  ADD COLUMN IF NOT EXISTS werewolf_diary_count integer NOT NULL DEFAULT 0;

${WEREWOLF_ARCHIVE_SCHEMA_SQL}
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
  const members = [];
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
    for (const member of roomMembers(room, snapshot.agents || [])) {
      members.push({
        room_id: roomId,
        member_id: clean(member.id),
        name: clean(member.name) || "未命名嘉宾",
        member_type: clean(member.type) || "agent",
        status: clean(member.status) || "active",
        note: clean(member.note),
        joined_at_ms: finiteNumber(member.joinedAt, room.createdAt || Date.now()),
        status_changed_at_ms: finiteNumber(member.statusChangedAt, room.updatedAt || Date.now()),
        last_seen_at_ms: finiteNumber(member.lastSeenAt, 0) || null,
      });
    }
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
  return {
    agents,
    rooms,
    members,
    messages,
    summaries,
    privateMemories,
    werewolf: snapshotToWerewolfRows(snapshot),
  };
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
      DELETE FROM room_members
      WHERE (room_id, member_id) NOT IN (
        SELECT room_id, member_id FROM jsonb_to_recordset($1::jsonb) AS x(room_id text, member_id text)
      )
    `, [JSON.stringify(rows.members)]);

    await client.query(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          room_id text, member_id text, name text, member_type text, status text, note text,
          joined_at_ms double precision, status_changed_at_ms double precision, last_seen_at_ms double precision
        )
      )
      INSERT INTO room_members (
        room_id, member_id, name, member_type, status, note,
        joined_at, status_changed_at, last_seen_at, archived_at
      )
      SELECT room_id, member_id, name, member_type, status, note,
        to_timestamp(joined_at_ms / 1000.0),
        to_timestamp(status_changed_at_ms / 1000.0),
        CASE WHEN last_seen_at_ms IS NULL THEN NULL ELSE to_timestamp(last_seen_at_ms / 1000.0) END,
        now()
      FROM incoming
      ON CONFLICT (room_id, member_id) DO UPDATE SET
        name = EXCLUDED.name,
        member_type = EXCLUDED.member_type,
        status = EXCLUDED.status,
        note = EXCLUDED.note,
        joined_at = EXCLUDED.joined_at,
        status_changed_at = EXCLUDED.status_changed_at,
        last_seen_at = EXCLUDED.last_seen_at,
        archived_at = now()
    `, [JSON.stringify(rows.members)]);

    await client.query(`
      WITH incoming AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          room_id text, member_id text, name text, member_type text, status text, note text,
          joined_at_ms double precision, status_changed_at_ms double precision, last_seen_at_ms double precision
        )
      )
      INSERT INTO room_member_events (
        room_id, member_id, name, member_type, status, note, happened_at
      )
      SELECT room_id, member_id, name, member_type, status, note,
        to_timestamp(status_changed_at_ms / 1000.0)
      FROM incoming
      ON CONFLICT (room_id, member_id, happened_at) DO NOTHING
    `, [JSON.stringify(rows.members)]);

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

    await syncWerewolfRows(client, rows.werewolf);

    await client.query(`
      INSERT INTO archive_sync_state (
        singleton, schema_version, last_synced_at,
        room_count, member_count, message_count, summary_count, private_memory_count,
        werewolf_game_count, werewolf_event_count, werewolf_diary_count
      ) VALUES (true, $1, now(), $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (singleton) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        last_synced_at = EXCLUDED.last_synced_at,
        room_count = EXCLUDED.room_count,
        member_count = EXCLUDED.member_count,
        message_count = EXCLUDED.message_count,
        summary_count = EXCLUDED.summary_count,
        private_memory_count = EXCLUDED.private_memory_count,
        werewolf_game_count = EXCLUDED.werewolf_game_count,
        werewolf_event_count = EXCLUDED.werewolf_event_count,
        werewolf_diary_count = EXCLUDED.werewolf_diary_count
    `, [
      SCHEMA_VERSION,
      rows.rooms.length,
      rows.members.length,
      rows.messages.length,
      rows.summaries.filter((item) => item.summary).length,
      rows.privateMemories.filter((item) => item.memory).length,
      rows.werewolf.games.length,
      rows.werewolf.events.length,
      rows.werewolf.diaries.length,
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
      members: rows.members.length,
      messages: rows.messages.length,
      summaries: rows.summaries.filter((item) => item.summary).length,
      privateMemories: rows.privateMemories.filter((item) => item.memory).length,
      werewolfGames: rows.werewolf.games.length,
      werewolfEvents: rows.werewolf.events.length,
      werewolfDiaries: rows.werewolf.diaries.length,
    };
  }

  async function loadState() {
    if (!enabled) return null;
    await ensureSchema();
    const result = await pool.query(`
      SELECT state_data FROM app_state_current WHERE singleton = true LIMIT 1
    `);
    return result.rows[0]?.state_data || null;
  }

  async function saveState(snapshot) {
    if (!enabled) return false;
    await ensureSchema();
    await pool.query(`
      INSERT INTO app_state_current (singleton, state_data, updated_at)
      VALUES (true, $1::jsonb, now())
      ON CONFLICT (singleton) DO UPDATE SET
        state_data = EXCLUDED.state_data,
        updated_at = EXCLUDED.updated_at
    `, [JSON.stringify(snapshot)]);
    return true;
  }

  async function syncWerewolfSnapshot(snapshot) {
    if (!enabled) return { games: 0, events: 0, diaries: 0 };
    await ensureSchema();
    const rows = snapshotToWerewolfRows(snapshot);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await syncWerewolfRows(client, rows);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return {
      games: rows.games.length,
      events: rows.events.length,
      diaries: rows.diaries.length,
    };
  }

  async function werewolfArchives(roomId, options = {}) {
    if (!enabled) return { items: [], offset: 0, limit: 20, total: 0 };
    await ensureSchema();
    return listWerewolfArchives(pool, roomId, options);
  }

  async function werewolfGame(gameId, options = {}) {
    if (!enabled) return null;
    await ensureSchema();
    return loadWerewolfGame(pool, gameId, options);
  }

  async function currentWerewolfGame(roomId) {
    if (!enabled) return null;
    await ensureSchema();
    return loadCurrentWerewolfGame(pool, roomId);
  }

  async function deleteWerewolfEvent(roomId, gameId, eventId) {
    if (!enabled) return { gameFound: false, deleted: false };
    await ensureSchema();
    return deleteStoredWerewolfEvent(pool, { roomId, gameId, eventId });
  }

  async function editWerewolfEvent(roomId, gameId, eventId, text) {
    if (!enabled) return { gameFound: false, eventFound: false, updated: false, text: "" };
    await ensureSchema();
    return editStoredWerewolfEvent(pool, { roomId, gameId, eventId, text });
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
      backend: "postgres",
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

  return {
    enqueue,
    status,
    flush,
    close,
    loadState,
    saveState,
    syncSnapshot,
    syncWerewolfSnapshot,
    werewolfArchives,
    werewolfGame,
    currentWerewolfGame,
    deleteWerewolfEvent,
    editWerewolfEvent,
  };
}

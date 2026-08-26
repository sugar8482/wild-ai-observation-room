import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { snapshotToArchiveRows } from "./postgres-archive.mjs";
import { sanitizeWerewolfGame } from "../public/werewolf-game.js";

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_state_current (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_format TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_rooms (
  room_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  room_prompt TEXT NOT NULL DEFAULT '',
  participant_ids_json TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  name TEXT NOT NULL,
  member_type TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  joined_at_ms INTEGER NOT NULL,
  status_changed_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER,
  PRIMARY KEY (room_id, member_id)
);

CREATE TABLE IF NOT EXISTS room_messages (
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  author TEXT NOT NULL,
  agent_id TEXT,
  external_id TEXT,
  source TEXT NOT NULL DEFAULT '',
  privacy TEXT NOT NULL DEFAULT 'public',
  recipient_ids_json TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  PRIMARY KEY (room_id, message_id)
);
CREATE INDEX IF NOT EXISTS room_messages_room_time_idx
  ON room_messages (room_id, sent_at_ms, message_id);

CREATE TABLE IF NOT EXISTS room_summaries (
  room_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL DEFAULT '',
  focus TEXT NOT NULL DEFAULT '',
  summarized_through_id TEXT,
  summarized_message_count INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS agent_private_memories (
  agent_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  memory TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS werewolf_games (
  game_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  game_sequence INTEGER,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  day INTEGER NOT NULL,
  winner TEXT,
  archive_title TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  game_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  archived_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS werewolf_games_room_archive_idx
  ON werewolf_games (room_id, archived_at_ms DESC, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS werewolf_events (
  game_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'log',
  visibility TEXT NOT NULL DEFAULT 'public',
  day INTEGER NOT NULL,
  phase TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at_ms INTEGER NOT NULL,
  PRIMARY KEY (game_id, event_id)
);
CREATE INDEX IF NOT EXISTS werewolf_events_game_sequence_idx
  ON werewolf_events (game_id, event_sequence);

CREATE TABLE IF NOT EXISTS werewolf_private_diaries (
  game_id TEXT NOT NULL,
  diary_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  audience_ids_json TEXT NOT NULL DEFAULT '[]',
  written_at_ms INTEGER NOT NULL,
  PRIMARY KEY (game_id, diary_id)
);
CREATE INDEX IF NOT EXISTS werewolf_private_diaries_game_time_idx
  ON werewolf_private_diaries (game_id, written_at_ms, diary_id);

CREATE TABLE IF NOT EXISTS archive_sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  last_synced_at_ms INTEGER,
  room_count INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  summary_count INTEGER NOT NULL DEFAULT 0,
  private_memory_count INTEGER NOT NULL DEFAULT 0,
  werewolf_game_count INTEGER NOT NULL DEFAULT 0,
  werewolf_event_count INTEGER NOT NULL DEFAULT 0,
  werewolf_diary_count INTEGER NOT NULL DEFAULT 0
);
`;

function json(value, fallback = null) {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function werewolfGames(snapshot = {}) {
  const games = [];
  for (const room of Array.isArray(snapshot.rooms) ? snapshot.rooms : []) {
    if (room?.roomType !== "werewolf" || !room.id) continue;
    (Array.isArray(room.werewolfArchives) ? room.werewolfArchives : []).forEach((raw, index) => {
      const game = sanitizeWerewolfGame(raw);
      if (game) games.push({ roomId: room.id, sequence: index + 1, game });
    });
    const active = sanitizeWerewolfGame(room.werewolf);
    if (active) games.push({ roomId: room.id, sequence: null, game: active });
  }
  return games;
}

export function createSqliteArchive({ filePath, now = Date.now, logger = console } = {}) {
  if (!filePath) throw new Error("SQLite 存储需要 filePath");
  mkdirSync(dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  database.exec(SCHEMA_SQL);
  let lastSuccessAt = null;
  let lastAttemptAt = null;
  let lastError = "";
  let lastCounts = null;
  let pendingSnapshot = null;
  let running = false;
  let stopped = false;

  const upsertAgent = database.prepare(`
    INSERT INTO archive_agents (agent_id, name, provider_format, model, persona, archived, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name=excluded.name, provider_format=excluded.provider_format, model=excluded.model,
      persona=excluded.persona, archived=0, updated_at_ms=excluded.updated_at_ms
  `);
  const upsertRoom = database.prepare(`
    INSERT INTO archive_rooms (room_id, name, room_prompt, participant_ids_json, archived, updated_at_ms)
    VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(room_id) DO UPDATE SET
      name=excluded.name, room_prompt=excluded.room_prompt,
      participant_ids_json=excluded.participant_ids_json, archived=0, updated_at_ms=excluded.updated_at_ms
  `);
  const upsertMember = database.prepare(`
    INSERT INTO room_members (
      room_id, member_id, name, member_type, status, note,
      joined_at_ms, status_changed_at_ms, last_seen_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, member_id) DO UPDATE SET
      name=excluded.name, member_type=excluded.member_type, status=excluded.status,
      note=excluded.note, joined_at_ms=excluded.joined_at_ms,
      status_changed_at_ms=excluded.status_changed_at_ms, last_seen_at_ms=excluded.last_seen_at_ms
  `);
  const upsertMessage = database.prepare(`
    INSERT INTO room_messages (
      room_id, message_id, kind, author, agent_id, external_id,
      source, privacy, recipient_ids_json, body, sent_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, message_id) DO UPDATE SET
      kind=excluded.kind, author=excluded.author, agent_id=excluded.agent_id,
      external_id=excluded.external_id, source=excluded.source, privacy=excluded.privacy,
      recipient_ids_json=excluded.recipient_ids_json, body=excluded.body, sent_at_ms=excluded.sent_at_ms
  `);
  const upsertSummary = database.prepare(`
    INSERT INTO room_summaries (
      room_id, summary, focus, summarized_through_id,
      summarized_message_count, stale, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET
      summary=excluded.summary, focus=excluded.focus,
      summarized_through_id=excluded.summarized_through_id,
      summarized_message_count=excluded.summarized_message_count,
      stale=excluded.stale, updated_at_ms=excluded.updated_at_ms
  `);
  const upsertMemory = database.prepare(`
    INSERT INTO agent_private_memories (agent_id, enabled, memory, revision, updated_at_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      enabled=excluded.enabled, memory=excluded.memory,
      revision=excluded.revision, updated_at_ms=excluded.updated_at_ms
  `);
  const upsertGame = database.prepare(`
    INSERT INTO werewolf_games (
      game_id, room_id, game_sequence, status, phase, day, winner,
      archive_title, revision, game_json, created_at_ms, updated_at_ms, archived_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET
      room_id=excluded.room_id,
      game_sequence=COALESCE(excluded.game_sequence, werewolf_games.game_sequence),
      status=excluded.status, phase=excluded.phase, day=excluded.day, winner=excluded.winner,
      archive_title=excluded.archive_title, revision=excluded.revision,
      game_json=excluded.game_json, created_at_ms=excluded.created_at_ms,
      updated_at_ms=excluded.updated_at_ms, archived_at_ms=excluded.archived_at_ms
    WHERE werewolf_games.revision <= excluded.revision
       OR werewolf_games.updated_at_ms <= excluded.updated_at_ms
  `);
  const upsertWerewolfEvent = database.prepare(`
    INSERT INTO werewolf_events (
      game_id, event_id, room_id, event_sequence, event_type, visibility,
      day, phase, author_id, author, body, payload_json, occurred_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id, event_id) DO UPDATE SET
      room_id=excluded.room_id, event_sequence=excluded.event_sequence,
      event_type=excluded.event_type, visibility=excluded.visibility,
      day=excluded.day, phase=excluded.phase, author_id=excluded.author_id,
      author=excluded.author, body=excluded.body,
      payload_json=excluded.payload_json, occurred_at_ms=excluded.occurred_at_ms
  `);
  const upsertWerewolfDiary = database.prepare(`
    INSERT INTO werewolf_private_diaries (
      game_id, diary_id, room_id, author_id, body, audience_ids_json, written_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id, diary_id) DO UPDATE SET
      room_id=excluded.room_id, author_id=excluded.author_id, body=excluded.body,
      audience_ids_json=excluded.audience_ids_json, written_at_ms=excluded.written_at_ms
  `);

  function syncSnapshotSync(snapshot) {
    const rows = snapshotToArchiveRows(snapshot);
    const games = werewolfGames(snapshot);
    const timestamp = now();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("UPDATE archive_agents SET archived=1; UPDATE archive_rooms SET archived=1; DELETE FROM room_members;");
      for (const row of rows.agents) {
        upsertAgent.run(row.agent_id, row.name, row.provider_format, row.model, row.persona, timestamp);
      }
      for (const row of rows.rooms) {
        upsertRoom.run(row.room_id, row.name, row.room_prompt, JSON.stringify(row.participant_ids), Math.trunc(row.updated_at_ms));
      }
      for (const row of rows.members) {
        upsertMember.run(
          row.room_id, row.member_id, row.name, row.member_type, row.status, row.note,
          Math.trunc(row.joined_at_ms), Math.trunc(row.status_changed_at_ms),
          row.last_seen_at_ms == null ? null : Math.trunc(row.last_seen_at_ms),
        );
      }
      for (const row of rows.messages) {
        upsertMessage.run(
          row.room_id, row.message_id, row.kind, row.author, row.agent_id, row.external_id,
          row.source, row.privacy, JSON.stringify(row.recipient_ids), row.body, Math.trunc(row.sent_at_ms),
        );
      }
      for (const row of rows.summaries) {
        upsertSummary.run(
          row.room_id, row.summary, row.focus, row.summarized_through_id,
          row.summarized_message_count, row.stale ? 1 : 0,
          row.updated_at_ms == null ? null : Math.trunc(row.updated_at_ms),
        );
      }
      for (const row of rows.privateMemories) {
        upsertMemory.run(row.agent_id, row.enabled ? 1 : 0, row.memory, row.revision, timestamp);
      }
      for (const { roomId, sequence, game } of games) {
        upsertGame.run(
          game.id, roomId, sequence, game.status, game.phase, game.day, game.winner,
          game.archiveTitle || "", game.revision, JSON.stringify(game),
          Math.trunc(game.createdAt), Math.trunc(game.updatedAt),
          game.archivedAt == null ? null : Math.trunc(game.archivedAt),
        );
      }
      for (const row of rows.werewolf.events) {
        upsertWerewolfEvent.run(
          row.game_id, row.event_id, row.room_id, row.event_sequence,
          row.event_type, row.visibility, row.day, row.phase,
          row.author_id, row.author, row.body, JSON.stringify(row.payload || {}),
          Math.trunc(row.occurred_at_ms),
        );
      }
      for (const row of rows.werewolf.diaries) {
        upsertWerewolfDiary.run(
          row.game_id, row.diary_id, row.room_id, row.author_id, row.body,
          JSON.stringify(row.audience_ids || []), Math.trunc(row.written_at_ms),
        );
      }
      database.prepare(`
        INSERT INTO archive_sync_state (
          singleton, schema_version, last_synced_at_ms, room_count, member_count,
          message_count, summary_count, private_memory_count,
          werewolf_game_count, werewolf_event_count, werewolf_diary_count
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          schema_version=excluded.schema_version, last_synced_at_ms=excluded.last_synced_at_ms,
          room_count=excluded.room_count, member_count=excluded.member_count,
          message_count=excluded.message_count, summary_count=excluded.summary_count,
          private_memory_count=excluded.private_memory_count,
          werewolf_game_count=excluded.werewolf_game_count,
          werewolf_event_count=excluded.werewolf_event_count,
          werewolf_diary_count=excluded.werewolf_diary_count
      `).run(
        SCHEMA_VERSION, timestamp, rows.rooms.length, rows.members.length, rows.messages.length,
        rows.summaries.filter((row) => row.summary).length,
        rows.privateMemories.filter((row) => row.memory).length,
        games.length,
        rows.werewolf.events.length,
        rows.werewolf.diaries.length,
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return {
      rooms: rows.rooms.length,
      members: rows.members.length,
      messages: rows.messages.length,
      summaries: rows.summaries.filter((row) => row.summary).length,
      privateMemories: rows.privateMemories.filter((row) => row.memory).length,
      werewolfGames: games.length,
      werewolfEvents: rows.werewolf.events.length,
      werewolfDiaries: rows.werewolf.diaries.length,
    };
  }

  async function syncSnapshot(snapshot) {
    lastAttemptAt = now();
    try {
      lastCounts = syncSnapshotSync(snapshot);
      lastSuccessAt = now();
      lastError = "";
      return lastCounts;
    } catch (error) {
      lastError = error?.message || "SQLite 档案同步失败";
      throw error;
    }
  }

  async function drain() {
    if (stopped || running || !pendingSnapshot) return;
    running = true;
    const snapshot = pendingSnapshot;
    pendingSnapshot = null;
    try {
      await syncSnapshot(snapshot);
    } catch (error) {
      pendingSnapshot ||= snapshot;
      logger.warn?.(`[sqlite] ${lastError}`);
    } finally {
      running = false;
    }
    if (pendingSnapshot && !stopped) setTimeout(() => void drain(), 1_000).unref?.();
  }

  function enqueue(snapshot) {
    if (stopped || !snapshot) return false;
    pendingSnapshot = structuredClone(snapshot);
    queueMicrotask(() => void drain());
    return true;
  }

  async function loadState() {
    const row = database.prepare("SELECT state_json FROM app_state_current WHERE singleton=1").get();
    return row ? json(row.state_json, null) : null;
  }

  async function saveState(snapshot) {
    database.prepare(`
      INSERT INTO app_state_current (singleton, state_json, updated_at_ms)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        state_json=excluded.state_json, updated_at_ms=excluded.updated_at_ms
    `).run(JSON.stringify(snapshot), now());
    return true;
  }

  async function syncWerewolfSnapshot(snapshot) {
    const counts = await syncSnapshot(snapshot);
    return {
      games: counts.werewolfGames,
      events: counts.werewolfEvents,
      diaries: counts.werewolfDiaries,
    };
  }

  async function werewolfArchives(roomId, { offset = 0, limit = 20 } = {}) {
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
    const total = Number(database.prepare(`
      SELECT count(*) AS count FROM werewolf_games
      WHERE room_id=? AND archived_at_ms IS NOT NULL
    `).get(String(roomId || ""))?.count || 0);
    const rows = database.prepare(`
      SELECT * FROM werewolf_games
      WHERE room_id=? AND archived_at_ms IS NOT NULL
      ORDER BY archived_at_ms DESC, game_id DESC LIMIT ? OFFSET ?
    `).all(String(roomId || ""), safeLimit, safeOffset);
    return {
      items: rows.map((row) => ({
        id: row.game_id,
        roomId: row.room_id,
        sequence: row.game_sequence,
        status: row.status,
        phase: row.phase,
        day: row.day,
        winner: row.winner,
        archiveTitle: row.archive_title,
        revision: row.revision,
        createdAt: row.created_at_ms,
        updatedAt: row.updated_at_ms,
        archivedAt: row.archived_at_ms,
      })),
      offset: safeOffset,
      limit: safeLimit,
      total,
    };
  }

  function gameResult(row, { eventOffset = 0, eventLimit = 100 } = {}) {
    if (!row) return null;
    const full = sanitizeWerewolfGame(json(row.game_json, null));
    if (!full) return null;
    const offset = Math.max(0, Math.trunc(Number(eventOffset) || 0));
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(eventLimit) || 100)));
    const total = full.log.length;
    const start = Math.max(0, total - offset - limit);
    const end = Math.max(0, total - offset);
    const game = sanitizeWerewolfGame({ ...full, log: full.log.slice(start, end) });
    return {
      game,
      metadata: {
        id: row.game_id,
        roomId: row.room_id,
        sequence: row.game_sequence,
        status: row.status,
        phase: row.phase,
        day: row.day,
        winner: row.winner,
        archiveTitle: row.archive_title,
        revision: row.revision,
        createdAt: row.created_at_ms,
        updatedAt: row.updated_at_ms,
        archivedAt: row.archived_at_ms,
      },
      events: { offset, limit, total, hasMore: start > 0 },
    };
  }

  async function werewolfGame(gameId, options = {}) {
    const roomId = String(options.roomId || "");
    const row = roomId
      ? database.prepare("SELECT * FROM werewolf_games WHERE game_id=? AND room_id=? LIMIT 1").get(String(gameId || ""), roomId)
      : database.prepare("SELECT * FROM werewolf_games WHERE game_id=? LIMIT 1").get(String(gameId || ""));
    return gameResult(row, options);
  }

  async function currentWerewolfGame(roomId) {
    const row = database.prepare(`
      SELECT * FROM werewolf_games
      WHERE room_id=? AND archived_at_ms IS NULL
      ORDER BY updated_at_ms DESC, game_id DESC LIMIT 1
    `).get(String(roomId || ""));
    return row ? sanitizeWerewolfGame(json(row.game_json, null)) : null;
  }

  async function deleteWerewolfEvent(roomId, gameId, eventId) {
    const room = String(roomId || "");
    const game = String(gameId || "");
    const event = String(eventId || "");
    const row = database.prepare(`
      SELECT * FROM werewolf_games WHERE game_id=? AND room_id=? LIMIT 1
    `).get(game, room);
    if (!row) return { gameFound: false, deleted: false };
    const stored = sanitizeWerewolfGame(json(row.game_json, null));
    const nextLog = stored?.log?.filter((entry) => entry.id !== event) || [];
    const deletedFromGame = Boolean(stored && nextLog.length !== stored.log.length);
    database.exec("BEGIN IMMEDIATE");
    try {
      if (deletedFromGame) {
        stored.log = nextLog;
        stored.revision = Math.max(1, Number(stored.revision) || 1) + 1;
        stored.updatedAt = now();
        database.prepare(`
          UPDATE werewolf_games
          SET game_json=?, revision=?, updated_at_ms=?
          WHERE game_id=? AND room_id=?
        `).run(JSON.stringify(stored), stored.revision, Math.trunc(stored.updatedAt), game, room);
      }
      const result = database.prepare(`
        DELETE FROM werewolf_events
        WHERE game_id=? AND room_id=? AND event_id=?
      `).run(game, room, event);
      database.exec("COMMIT");
      return { gameFound: true, deleted: deletedFromGame || Number(result.changes) > 0 };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async function editWerewolfEvent(roomId, gameId, eventId, messageText) {
    const room = String(roomId || "");
    const game = String(gameId || "");
    const event = String(eventId || "");
    const text = String(messageText || "").trim().slice(0, 50_000);
    const row = database.prepare(`
      SELECT * FROM werewolf_games WHERE game_id=? AND room_id=? LIMIT 1
    `).get(game, room);
    if (!row) return { gameFound: false, eventFound: false, updated: false, text };
    const stored = sanitizeWerewolfGame(json(row.game_json, null));
    const storedEvent = stored?.log?.find((entry) => entry.id === event);
    const eventRow = database.prepare(`
      SELECT body FROM werewolf_events WHERE game_id=? AND room_id=? AND event_id=? LIMIT 1
    `).get(game, room, event);
    if (!storedEvent && !eventRow) return { gameFound: true, eventFound: false, updated: false, text };
    const changed = storedEvent?.text !== text || eventRow?.body !== text;
    if (!changed) return { gameFound: true, eventFound: true, updated: false, text };
    database.exec("BEGIN IMMEDIATE");
    try {
      if (storedEvent) {
        storedEvent.text = text;
        stored.revision = Math.max(1, Number(stored.revision) || 1) + 1;
        stored.updatedAt = now();
        database.prepare(`
          UPDATE werewolf_games
          SET game_json=?, revision=?, updated_at_ms=?
          WHERE game_id=? AND room_id=?
        `).run(JSON.stringify(stored), stored.revision, Math.trunc(stored.updatedAt), game, room);
      }
      database.prepare(`
        UPDATE werewolf_events SET body=?
        WHERE game_id=? AND room_id=? AND event_id=?
      `).run(text, game, room, event);
      database.exec("COMMIT");
      return { gameFound: true, eventFound: true, updated: true, text };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function status() {
    return {
      enabled: true,
      backend: "sqlite",
      state: lastError ? "error" : running ? "syncing" : lastSuccessAt ? "ready" : "ready",
      syncing: running,
      pending: Boolean(pendingSnapshot),
      lastSuccessAt,
      lastAttemptAt,
      lastError,
      counts: lastCounts,
      filePath,
    };
  }

  async function flush({ timeoutMs = 10_000 } = {}) {
    const deadline = now() + timeoutMs;
    while ((running || pendingSnapshot) && now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !running && !pendingSnapshot;
  }

  async function close() {
    stopped = true;
    await flush();
    database.close();
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

import { sanitizeWerewolfGame } from "../public/werewolf-game.js";

export const WEREWOLF_ARCHIVE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS werewolf_games (
  game_id text PRIMARY KEY,
  room_id text NOT NULL,
  game_sequence integer,
  status text NOT NULL,
  view_mode text NOT NULL,
  cost_mode text NOT NULL,
  deal_mode text NOT NULL,
  phase text NOT NULL,
  day integer NOT NULL,
  winner text,
  archive_title text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT 1,
  game_state jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived_at timestamptz,
  persisted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS werewolf_games_room_archive_idx
  ON werewolf_games (room_id, archived_at DESC NULLS FIRST, updated_at DESC);

CREATE TABLE IF NOT EXISTS werewolf_events (
  game_id text NOT NULL,
  event_id text NOT NULL,
  room_id text NOT NULL,
  event_sequence integer NOT NULL,
  event_type text NOT NULL DEFAULT 'log',
  visibility text NOT NULL DEFAULT 'public',
  day integer NOT NULL,
  phase text NOT NULL,
  author_id text NOT NULL,
  author text NOT NULL,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, event_id)
);

CREATE INDEX IF NOT EXISTS werewolf_events_game_sequence_idx
  ON werewolf_events (game_id, event_sequence);

CREATE TABLE IF NOT EXISTS werewolf_private_diaries (
  game_id text NOT NULL,
  diary_id text NOT NULL,
  room_id text NOT NULL,
  author_id text NOT NULL,
  body text NOT NULL,
  audience_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  written_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, diary_id)
);

CREATE INDEX IF NOT EXISTS werewolf_private_diaries_game_time_idx
  ON werewolf_private_diaries (game_id, written_at, diary_id);
`;

function clean(value) {
  return String(value ?? "");
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function jsonValue(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function stateWithoutStreams(game) {
  const state = structuredClone(game);
  delete state.log;
  delete state.privateDiaries;
  return state;
}

function addGame(rows, roomId, rawGame, gameSequence = null) {
  const game = sanitizeWerewolfGame(rawGame);
  if (!game) return;
  const existingIndex = rows.games.findIndex((item) => item.game_id === game.id);
  const row = {
    game_id: game.id,
    room_id: roomId,
    game_sequence: Number.isFinite(Number(gameSequence)) ? Math.max(1, Math.trunc(Number(gameSequence))) : null,
    status: game.status,
    view_mode: game.viewMode,
    cost_mode: game.costMode,
    deal_mode: game.dealMode,
    phase: game.phase,
    day: game.day,
    winner: game.winner,
    archive_title: clean(game.archiveTitle),
    revision: Math.max(1, Math.trunc(finiteNumber(game.revision, 1))),
    game_state: stateWithoutStreams(game),
    created_at_ms: finiteNumber(game.createdAt, Date.now()),
    updated_at_ms: finiteNumber(game.updatedAt, Date.now()),
    archived_at_ms: finiteNumber(game.archivedAt, 0) || null,
  };
  if (existingIndex < 0) rows.games.push(row);
  else if (row.updated_at_ms >= rows.games[existingIndex].updated_at_ms || row.archived_at_ms) {
    rows.games[existingIndex] = row;
  }

  const knownEvents = new Set(rows.events.filter((item) => item.game_id === game.id).map((item) => item.event_id));
  game.log.forEach((entry, index) => {
    if (knownEvents.has(entry.id)) return;
    knownEvents.add(entry.id);
    rows.events.push({
      game_id: game.id,
      event_id: entry.id,
      room_id: roomId,
      event_sequence: index + 1,
      event_type: "log",
      visibility: entry.visibility,
      day: entry.day,
      phase: entry.phase,
      author_id: entry.authorId,
      author: entry.author,
      body: entry.text,
      payload: entry.visibility === "private"
        ? { recipientIds: entry.recipientIds }
        : {},
      occurred_at_ms: finiteNumber(entry.timestamp, game.updatedAt),
    });
  });

  const knownDiaries = new Set(rows.diaries.filter((item) => item.game_id === game.id).map((item) => item.diary_id));
  game.privateDiaries.forEach((entry) => {
    if (knownDiaries.has(entry.id)) return;
    knownDiaries.add(entry.id);
    rows.diaries.push({
      game_id: game.id,
      diary_id: entry.id,
      room_id: roomId,
      author_id: entry.authorId,
      body: entry.body,
      audience_ids: entry.audienceIds,
      written_at_ms: finiteNumber(entry.timestamp, game.updatedAt),
    });
  });
}

export function snapshotToWerewolfRows(snapshot = {}) {
  const rows = { games: [], events: [], diaries: [] };
  for (const room of Array.isArray(snapshot.rooms) ? snapshot.rooms : []) {
    if (room?.roomType !== "werewolf") continue;
    const roomId = clean(room.id);
    if (!roomId) continue;
    (Array.isArray(room.werewolfArchives) ? room.werewolfArchives : [])
      .forEach((game, index) => addGame(rows, roomId, game, index + 1));
    addGame(rows, roomId, room.werewolf, null);
  }
  return rows;
}

export async function syncWerewolfRows(client, rows = { games: [], events: [], diaries: [] }) {
  await client.query(`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        game_id text, room_id text, game_sequence integer, status text,
        view_mode text, cost_mode text, deal_mode text, phase text, day integer,
        winner text, archive_title text, revision numeric, game_state jsonb,
        created_at_ms double precision, updated_at_ms double precision,
        archived_at_ms double precision
      )
    )
    INSERT INTO werewolf_games (
      game_id, room_id, game_sequence, status, view_mode, cost_mode, deal_mode,
      phase, day, winner, archive_title, revision, game_state,
      created_at, updated_at, archived_at, persisted_at
    )
    SELECT game_id, room_id, game_sequence, status, view_mode, cost_mode, deal_mode,
      phase, day, winner, archive_title, revision::bigint, game_state,
      to_timestamp(created_at_ms / 1000.0), to_timestamp(updated_at_ms / 1000.0),
      CASE WHEN archived_at_ms IS NULL THEN NULL ELSE to_timestamp(archived_at_ms / 1000.0) END,
      now()
    FROM incoming
    ON CONFLICT (game_id) DO UPDATE SET
      room_id = EXCLUDED.room_id,
      game_sequence = COALESCE(EXCLUDED.game_sequence, werewolf_games.game_sequence),
      status = EXCLUDED.status,
      view_mode = EXCLUDED.view_mode,
      cost_mode = EXCLUDED.cost_mode,
      deal_mode = EXCLUDED.deal_mode,
      phase = EXCLUDED.phase,
      day = EXCLUDED.day,
      winner = EXCLUDED.winner,
      archive_title = EXCLUDED.archive_title,
      revision = EXCLUDED.revision,
      game_state = EXCLUDED.game_state,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      archived_at = EXCLUDED.archived_at,
      persisted_at = now()
    WHERE werewolf_games.revision <= EXCLUDED.revision
       OR werewolf_games.updated_at <= EXCLUDED.updated_at
  `, [JSON.stringify(rows.games)]);

  await client.query(`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        game_id text, event_id text, room_id text, event_sequence integer,
        event_type text, visibility text, day integer, phase text,
        author_id text, author text, body text, payload jsonb,
        occurred_at_ms double precision
      )
    )
    INSERT INTO werewolf_events (
      game_id, event_id, room_id, event_sequence, event_type, visibility,
      day, phase, author_id, author, body, payload, occurred_at, persisted_at
    )
    SELECT game_id, event_id, room_id, event_sequence, event_type, visibility,
      day, phase, author_id, author, body, payload,
      to_timestamp(occurred_at_ms / 1000.0), now()
    FROM incoming
    ON CONFLICT (game_id, event_id) DO UPDATE SET
      event_sequence = EXCLUDED.event_sequence,
      event_type = EXCLUDED.event_type,
      visibility = EXCLUDED.visibility,
      day = EXCLUDED.day,
      phase = EXCLUDED.phase,
      author_id = EXCLUDED.author_id,
      author = EXCLUDED.author,
      body = EXCLUDED.body,
      payload = EXCLUDED.payload,
      occurred_at = EXCLUDED.occurred_at,
      persisted_at = now()
  `, [JSON.stringify(rows.events)]);

  await client.query(`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        game_id text, diary_id text, room_id text, author_id text,
        body text, audience_ids jsonb, written_at_ms double precision
      )
    )
    INSERT INTO werewolf_private_diaries (
      game_id, diary_id, room_id, author_id, body, audience_ids,
      written_at, persisted_at
    )
    SELECT game_id, diary_id, room_id, author_id, body, audience_ids,
      to_timestamp(written_at_ms / 1000.0), now()
    FROM incoming
    ON CONFLICT (game_id, diary_id) DO UPDATE SET
      author_id = EXCLUDED.author_id,
      body = EXCLUDED.body,
      audience_ids = EXCLUDED.audience_ids,
      written_at = EXCLUDED.written_at,
      persisted_at = now()
  `, [JSON.stringify(rows.diaries)]);
}

function gameMetadata(row) {
  return {
    id: clean(row.game_id),
    roomId: clean(row.room_id),
    sequence: Number(row.game_sequence) || null,
    status: clean(row.status),
    phase: clean(row.phase),
    day: Number(row.day) || 1,
    winner: clean(row.winner) || null,
    archiveTitle: clean(row.archive_title),
    revision: Number(row.revision) || 1,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    archivedAt: row.archived_at ? new Date(row.archived_at).getTime() : null,
  };
}

function eventFromRow(row) {
  const payload = jsonValue(row.payload, {});
  return {
    id: clean(row.event_id),
    day: Number(row.day) || 1,
    phase: clean(row.phase),
    visibility: clean(row.visibility) || "public",
    recipientIds: Array.isArray(payload.recipientIds) ? payload.recipientIds : [],
    authorId: clean(row.author_id),
    author: clean(row.author),
    text: clean(row.body),
    timestamp: new Date(row.occurred_at).getTime(),
  };
}

export async function deleteWerewolfEvent(pool, { roomId = "", gameId = "", eventId = "" } = {}) {
  const game = clean(gameId);
  const room = clean(roomId);
  const event = clean(eventId);
  if (!game || !room || !event) return { gameFound: false, deleted: false };
  const found = await gameRow(pool, game, room);
  if (!found) return { gameFound: false, deleted: false };
  const result = await pool.query(`
    DELETE FROM werewolf_events
    WHERE game_id = $1 AND room_id = $2 AND event_id = $3
  `, [game, room, event]);
  return { gameFound: true, deleted: Number(result.rowCount) > 0 };
}

function diaryFromRow(row) {
  return {
    id: clean(row.diary_id),
    authorId: clean(row.author_id),
    body: clean(row.body),
    audienceIds: jsonValue(row.audience_ids, []),
    timestamp: new Date(row.written_at).getTime(),
  };
}

export async function listWerewolfArchives(pool, roomId, { offset = 0, limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const result = await pool.query(`
    SELECT game_id, room_id, game_sequence, status, phase, day, winner,
      archive_title, revision, created_at, updated_at, archived_at,
      count(*) OVER() AS total_count
    FROM werewolf_games
    WHERE room_id = $1 AND archived_at IS NOT NULL
    ORDER BY archived_at DESC, game_id DESC
    LIMIT $2 OFFSET $3
  `, [clean(roomId), safeLimit, safeOffset]);
  return {
    items: result.rows.map(gameMetadata),
    offset: safeOffset,
    limit: safeLimit,
    total: Number(result.rows[0]?.total_count) || 0,
  };
}

async function gameRow(pool, gameId, roomId = "") {
  const values = [clean(gameId)];
  const roomClause = roomId ? " AND room_id = $2" : "";
  if (roomId) values.push(clean(roomId));
  const result = await pool.query(`
    SELECT * FROM werewolf_games WHERE game_id = $1${roomClause} LIMIT 1
  `, values);
  return result.rows[0] || null;
}

export async function loadWerewolfGame(pool, gameId, {
  roomId = "",
  eventOffset = 0,
  eventLimit = 100,
  includeDiaries = true,
} = {}) {
  const row = await gameRow(pool, gameId, roomId);
  if (!row) return null;
  const safeOffset = Math.max(0, Math.trunc(Number(eventOffset) || 0));
  const safeLimit = Math.min(200, Math.max(1, Math.trunc(Number(eventLimit) || 100)));
  const eventsResult = await pool.query(`
    SELECT *, count(*) OVER() AS total_count
    FROM werewolf_events
    WHERE game_id = $1
    ORDER BY event_sequence DESC, event_id DESC
    LIMIT $2 OFFSET $3
  `, [clean(gameId), safeLimit, safeOffset]);
  const diariesResult = includeDiaries
    ? await pool.query(`
      SELECT * FROM werewolf_private_diaries
      WHERE game_id = $1
      ORDER BY written_at, diary_id
    `, [clean(gameId)])
    : { rows: [] };
  const eventTotal = Number(eventsResult.rows[0]?.total_count) || 0;
  const logs = eventsResult.rows.map(eventFromRow).reverse();
  const base = jsonValue(row.game_state, {});
  const game = sanitizeWerewolfGame({
    ...base,
    id: row.game_id,
    log: logs,
    privateDiaries: diariesResult.rows.map(diaryFromRow),
    archiveTitle: row.archive_title,
    archivedAt: row.archived_at ? new Date(row.archived_at).getTime() : null,
  });
  return {
    game,
    metadata: gameMetadata(row),
    events: {
      offset: safeOffset,
      limit: safeLimit,
      total: eventTotal,
      hasMore: safeOffset + logs.length < eventTotal,
    },
  };
}

export async function loadCurrentWerewolfGame(pool, roomId) {
  const result = await pool.query(`
    SELECT game_id FROM werewolf_games
    WHERE room_id = $1 AND archived_at IS NULL
    ORDER BY updated_at DESC, game_id DESC
    LIMIT 1
  `, [clean(roomId)]);
  const gameId = result.rows[0]?.game_id;
  if (!gameId) return null;
  const row = await gameRow(pool, gameId, roomId);
  if (!row) return null;
  const [eventsResult, diariesResult] = await Promise.all([
    pool.query(`
      SELECT * FROM werewolf_events
      WHERE game_id = $1
      ORDER BY event_sequence, event_id
    `, [clean(gameId)]),
    pool.query(`
      SELECT * FROM werewolf_private_diaries
      WHERE game_id = $1
      ORDER BY written_at, diary_id
    `, [clean(gameId)]),
  ]);
  return sanitizeWerewolfGame({
    ...jsonValue(row.game_state, {}),
    id: row.game_id,
    log: eventsResult.rows.map(eventFromRow),
    privateDiaries: diariesResult.rows.map(diaryFromRow),
    archiveTitle: row.archive_title,
    archivedAt: null,
  });
}

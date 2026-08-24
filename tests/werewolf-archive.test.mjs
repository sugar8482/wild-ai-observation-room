import assert from "node:assert/strict";
import test from "node:test";
import {
  WEREWOLF_ARCHIVE_SCHEMA_SQL,
  deleteWerewolfEvent,
  listWerewolfArchives,
  loadWerewolfGame,
  snapshotToWerewolfRows,
  syncWerewolfRows,
} from "../lib/werewolf-archive.mjs";
import {
  WEREWOLF_USER_ID,
  appendWerewolfLog,
  appendWerewolfPrivateDiary,
  archiveWerewolfGame,
  createWerewolfGame,
  finishWerewolfGame,
} from "../public/werewolf-game.js";

function participants() {
  return Array.from({ length: 6 }, (_, index) => ({
    id: `archive-player-${index + 1}`,
    name: `卷宗玩家${index + 1}`,
    type: "agent",
  }));
}

function completeGame() {
  const game = createWerewolfGame({ participants: participants(), viewMode: "god", random: () => 0.2 });
  const [wolf, , seer, witch, target] = game.players;
  game.nights = [{
    day: 1,
    wolfVotes: { [wolf.id]: target.id },
    killTargetId: target.id,
    seerTargetId: wolf.id,
    seerResult: "wolf",
    witchSave: true,
    poisonTargetId: null,
    deaths: [],
    resolved: true,
  }];
  game.seerChecks = [{ day: 1, seerId: seer.id, targetId: wolf.id, result: "wolf" }];
  game.witch = { healAvailable: false, poisonAvailable: true };
  game.days = [{
    day: 1,
    speechOrder: game.players.map((player) => player.id),
    speeches: { [wolf.id]: "我是预言家。" },
    provisionalVotes: {},
    votes: { [seer.id]: wolf.id },
    tieVotes: {},
    voteCounts: { [wolf.id]: 1 },
    tiedIds: [],
    eliminatedId: wolf.id,
  }];
  finishWerewolfGame(game, "good");
  appendWerewolfPrivateDiary(game, {
    id: "archive-diary-one",
    authorId: wolf.id,
    body: "我不该悍跳得那么早。",
    audienceIds: [wolf.id, WEREWOLF_USER_ID],
    timestamp: game.updatedAt + 1,
  });
  return game;
}

test("狼人杀数据库行保存完整结构化事实、私人日记与超过五百条事件", () => {
  const game = completeGame();
  const privateEvent = appendWerewolfLog(game, {
    visibility: "private",
    recipientIds: [game.players[1].id],
    authorId: game.players[0].id,
    author: game.players[0].name,
    text: "只给一位嘉宾的赛后私聊。",
    phase: "debrief",
  });
  for (let index = 0; index < 620; index += 1) {
    appendWerewolfLog(game, {
      visibility: index % 2 ? "wolves" : "public",
      authorId: game.players[0].id,
      author: game.players[0].name,
      text: `完整事件 ${index + 1}`,
      phase: "debrief",
    });
  }
  const archived = archiveWerewolfGame(game, 1);
  const rows = snapshotToWerewolfRows({
    rooms: [{
      id: "werewolf-room",
      roomType: "werewolf",
      werewolf: null,
      werewolfArchives: [archived],
    }],
  });

  assert.equal(rows.games.length, 1);
  assert.equal(rows.events.length, archived.log.length);
  assert.ok(rows.events.length > 500);
  assert.equal(rows.diaries.length, 1);
  assert.deepEqual(rows.events.find((row) => row.event_id === privateEvent.id).payload, {
    recipientIds: [game.players[1].id],
  });
  assert.equal(rows.games[0].game_state.nights[0].wolfVotes[game.players[0].id], game.players[4].id);
  assert.equal(rows.games[0].game_state.seerChecks[0].result, "wolf");
  assert.equal(rows.games[0].game_state.witch.healAvailable, false);
  assert.equal(rows.games[0].game_state.days[0].votes[game.players[2].id], game.players[0].id);
  assert.equal(Object.hasOwn(rows.games[0].game_state, "log"), false);
  assert.equal(Object.hasOwn(rows.games[0].game_state, "privateDiaries"), false);
});

test("狼人杀迁移与重复增量写入使用稳定主键，不删除旧事件", async () => {
  const game = completeGame();
  const rows = snapshotToWerewolfRows({
    rooms: [{ id: "werewolf-room", roomType: "werewolf", werewolf: game, werewolfArchives: [] }],
  });
  const stored = { games: new Map(), events: new Map(), diaries: new Map() };
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push(sql);
      const incoming = JSON.parse(values?.[0] || "[]");
      if (/INSERT INTO werewolf_games/.test(sql)) incoming.forEach((row) => stored.games.set(row.game_id, row));
      if (/INSERT INTO werewolf_events/.test(sql)) incoming.forEach((row) => stored.events.set(`${row.game_id}:${row.event_id}`, row));
      if (/INSERT INTO werewolf_private_diaries/.test(sql)) incoming.forEach((row) => stored.diaries.set(`${row.game_id}:${row.diary_id}`, row));
      return { rows: [] };
    },
  };

  await syncWerewolfRows(client, rows);
  await syncWerewolfRows(client, rows);
  assert.equal(stored.games.size, 1);
  assert.equal(stored.events.size, rows.events.length);
  assert.equal(stored.diaries.size, 1);
  assert.doesNotMatch(queries.join("\n"), /DELETE FROM werewolf_/);
  assert.match(WEREWOLF_ARCHIVE_SCHEMA_SQL, /PRIMARY KEY \(game_id, event_id\)/);
  assert.match(queries.join("\n"), /ON CONFLICT \(game_id, event_id\) DO UPDATE/);
});

test("历史目录外层严格按一整局分页，单局内部事件窗口独立为一百条", async () => {
  const archivedAt = new Date("2026-08-22T12:00:00Z");
  const game = completeGame();
  const state = structuredClone(game);
  delete state.log;
  delete state.privateDiaries;
  const gameRow = {
    game_id: game.id,
    room_id: "werewolf-room",
    game_sequence: 1,
    status: "ended",
    phase: "debrief",
    day: 3,
    winner: "good",
    archive_title: "第 1 局｜好人胜利",
    revision: 9,
    game_state: state,
    created_at: new Date(game.createdAt),
    updated_at: new Date(game.updatedAt),
    archived_at: archivedAt,
    total_count: "4",
  };
  const eventRows = Array.from({ length: 100 }, (_, index) => ({
    event_id: `event-${520 + index}`,
    day: 3,
    phase: "debrief",
    visibility: index === 0 ? "private" : "public",
    payload: index === 0 ? { recipientIds: ["archive-player-2"] } : {},
    author_id: "system",
    author: "法官",
    body: `事件 ${520 + index}`,
    occurred_at: new Date(1_000 + index),
    total_count: "620",
  }));
  const pool = {
    async query(sql, values) {
      if (/count\(\*\) OVER\(\) AS total_count/.test(sql) && /FROM werewolf_games/.test(sql)) {
        assert.deepEqual(values, ["werewolf-room", 1, 2]);
        return { rows: [gameRow] };
      }
      if (/SELECT \* FROM werewolf_games/.test(sql)) return { rows: [gameRow] };
      if (/FROM werewolf_events/.test(sql)) return { rows: eventRows };
      if (/FROM werewolf_private_diaries/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const catalog = await listWerewolfArchives(pool, "werewolf-room", { offset: 2, limit: 1 });
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.limit, 1);
  assert.equal(catalog.total, 4);

  const loaded = await loadWerewolfGame(pool, game.id, {
    roomId: "werewolf-room",
    eventOffset: 0,
    eventLimit: 100,
  });
  assert.equal(loaded.game.log.length, 100);
  assert.deepEqual(loaded.game.log.find((entry) => entry.visibility === "private").recipientIds, ["archive-player-2"]);
  assert.equal(loaded.events.total, 620);
  assert.equal(loaded.events.hasMore, true);
});

test("PostgreSQL 狼人杀事件删除校验房间并且重复删除安全", async () => {
  let deleteCount = 0;
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (/SELECT \* FROM werewolf_games/.test(sql)) {
        return values[1] === "werewolf-room" ? { rows: [{ game_id: values[0], room_id: values[1] }] } : { rows: [] };
      }
      if (/DELETE FROM werewolf_events/.test(sql)) {
        deleteCount += 1;
        return { rowCount: deleteCount === 1 ? 1 : 0, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  assert.deepEqual(await deleteWerewolfEvent(pool, {
    roomId: "werewolf-room",
    gameId: "game-one",
    eventId: "event-one",
  }), { gameFound: true, deleted: true });
  assert.deepEqual(await deleteWerewolfEvent(pool, {
    roomId: "werewolf-room",
    gameId: "game-one",
    eventId: "event-one",
  }), { gameFound: true, deleted: false });
  assert.deepEqual(await deleteWerewolfEvent(pool, {
    roomId: "other-room",
    gameId: "game-one",
    eventId: "event-one",
  }), { gameFound: false, deleted: false });
  assert.equal(queries.filter((query) => /DELETE FROM werewolf_events/.test(query.sql)).length, 2);
});

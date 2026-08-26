import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createSqliteArchive } from "../lib/sqlite-archive.mjs";
import {
  appendWerewolfLog,
  appendWerewolfPrivateDiary,
  archiveWerewolfGame,
  createWerewolfGame,
  finishWerewolfGame,
} from "../public/werewolf-game.js";

function sampleState() {
  const participants = Array.from({ length: 6 }, (_, index) => ({
    id: index === 0 ? "guest-global" : `wolf-guest-${index + 1}`,
    name: index === 0 ? "GPT" : `嘉宾${index + 1}`,
    type: "agent",
  }));
  const game = createWerewolfGame({ participants, viewMode: "god", random: () => 0.4 });
  appendWerewolfLog(game, { authorId: "guest-global", author: "GPT", text: "本局第一句。" });
  appendWerewolfLog(game, {
    visibility: "private",
    recipientIds: ["wolf-guest-2"],
    authorId: "guest-global",
    author: "GPT",
    text: "这句只写进本局私聊事件。",
    phase: "debrief",
  });
  appendWerewolfPrivateDiary(game, {
    authorId: "guest-global",
    body: "只随这局封存的日记。",
    audienceIds: ["werewolf-user", "guest-global"],
  });
  finishWerewolfGame(game, "good");
  const archived = archiveWerewolfGame(game, 1);

  return {
    version: 3,
    activeRoomId: "room-one",
    agents: [{
      id: "guest-global",
      name: "GPT",
      format: "openai",
      model: "gpt-test",
      persona: "保持自然。",
      memoryEnabled: true,
      memory: "- [群聊] 我记得晨曦。",
      memoryRevision: 3,
    }],
    rooms: [
      {
        id: "room-one",
        name: "客厅",
        participantIds: ["guest-global"],
        messages: [{ id: "message-one", kind: "user", author: "晨曦", text: "你好", timestamp: 1 }],
      },
      {
        id: "room-two",
        name: "书房",
        participantIds: ["guest-global"],
        messages: [{ id: "message-two", kind: "agent", agentId: "guest-global", author: "GPT", text: "我也在这里。", timestamp: 2 }],
      },
      {
        id: "werewolf-room",
        name: "狼人杀",
        roomType: "werewolf",
        participantIds: ["guest-global"],
        messages: [],
        werewolf: null,
        werewolfArchives: [archived],
      },
    ],
  };
}

test("SQLite 零配置存储以数据库为主，并保留跨房间嘉宾、全局记忆和完整狼人杀卷宗", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-sqlite-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "observation-room.sqlite");
  const archive = createSqliteArchive({ filePath, logger: { warn() {} } });
  const state = sampleState();

  assert.equal(await archive.loadState(), null);
  await archive.saveState(state);
  assert.deepEqual(await archive.loadState(), state);
  const counts = await archive.syncSnapshot(state);
  assert.equal(counts.rooms, 3);
  assert.equal(counts.members, 3);
  assert.equal(counts.messages, 2);
  assert.equal(counts.privateMemories, 1);
  assert.equal(counts.werewolfGames, 1);
  assert.ok(counts.werewolfEvents >= 2);
  assert.equal(counts.werewolfDiaries, 1);

  const catalog = await archive.werewolfArchives("werewolf-room");
  assert.equal(catalog.total, 1);
  const restored = await archive.werewolfGame(catalog.items[0].id, {
    roomId: "werewolf-room",
    eventOffset: 0,
    eventLimit: 100,
  });
  assert.ok(restored.game.log.some((entry) => entry.text === "本局第一句。"));
  const privateEvent = restored.game.log.find((entry) => entry.text === "这句只写进本局私聊事件。");
  assert.deepEqual(privateEvent.recipientIds, ["wolf-guest-2"]);
  assert.equal(restored.game.privateDiaries[0].body, "只随这局封存的日记。");

  let database = new DatabaseSync(filePath, { readOnly: true });
  assert.equal(database.prepare("SELECT count(*) AS total FROM room_members WHERE member_id=?").get("guest-global").total, 3);
  assert.equal(database.prepare("SELECT count(*) AS total FROM agent_private_memories WHERE agent_id=?").get("guest-global").total, 1);
  assert.deepEqual(
    JSON.parse(database.prepare("SELECT payload_json FROM werewolf_events WHERE game_id=? AND event_id=?").get(restored.game.id, privateEvent.id).payload_json),
    { recipientIds: ["wolf-guest-2"] },
  );
  database.close();

  assert.deepEqual(
    await archive.editWerewolfEvent("werewolf-room", restored.game.id, privateEvent.id, "这句赛后私聊已经改好。"),
    { gameFound: true, eventFound: true, updated: true, text: "这句赛后私聊已经改好。" },
  );
  assert.equal(
    (await archive.werewolfGame(restored.game.id, { roomId: "werewolf-room" })).game.log
      .find((entry) => entry.id === privateEvent.id).text,
    "这句赛后私聊已经改好。",
  );

  assert.deepEqual(
    await archive.deleteWerewolfEvent("werewolf-room", restored.game.id, privateEvent.id),
    { gameFound: true, deleted: true },
  );
  assert.deepEqual(
    await archive.deleteWerewolfEvent("werewolf-room", restored.game.id, privateEvent.id),
    { gameFound: true, deleted: false },
  );
  assert.ok(!(await archive.werewolfGame(restored.game.id, { roomId: "werewolf-room" })).game.log
    .some((entry) => entry.id === privateEvent.id));
  database = new DatabaseSync(filePath, { readOnly: true });
  assert.equal(database.prepare("SELECT count(*) AS total FROM werewolf_events WHERE game_id=? AND event_id=?").get(restored.game.id, privateEvent.id).total, 0);
  database.close();
  await archive.close();
});

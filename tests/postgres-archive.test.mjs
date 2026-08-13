import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresArchive, snapshotToArchiveRows } from "../lib/postgres-archive.mjs";

const snapshot = {
  agents: [{
    id: "gpt",
    name: "GPT",
    format: "openai",
    model: "gpt-test",
    persona: "温柔的学生会长",
    memoryEnabled: true,
    memory: "- [群聊] 我记得晨曦。",
    memoryRevision: 7,
  }],
  rooms: [{
    id: "room-one",
    name: "客厅",
    roomPrompt: "轻松聊天",
    participantIds: ["gpt"],
    updatedAt: 2000,
    messages: [{
      id: "message-one",
      kind: "user",
      author: "晨曦",
      text: "这句只给 GPT",
      privacy: "private",
      recipientIds: ["gpt"],
      timestamp: 1000,
    }],
    memory: {
      summary: "长期总结",
      focus: "保留真实原话",
      summarizedThroughId: "message-one",
      summarizedMessageCount: 1,
      updatedAt: 2000,
      stale: false,
    },
  }],
};

test("档案快照保留房间原文、私聊收件人与 AI 私人记忆", () => {
  const rows = snapshotToArchiveRows(snapshot);
  assert.equal(rows.rooms[0].name, "客厅");
  assert.equal(rows.members[0].status, "active");
  assert.equal(rows.messages[0].privacy, "private");
  assert.deepEqual(rows.messages[0].recipient_ids, ["gpt"]);
  assert.equal(rows.summaries[0].summary, "长期总结");
  assert.equal(rows.privateMemories[0].memory, "- [群聊] 我记得晨曦。");
  assert.equal(rows.privateMemories[0].revision, 7);
});

test("未配置数据库时保持 JSON-only 模式且不会建立连接", async () => {
  const archive = createPostgresArchive();
  assert.equal(archive.status().enabled, false);
  assert.equal(archive.status().state, "disabled");
  assert.equal(archive.enqueue(snapshot), false);
  assert.equal(await archive.flush(), true);
  await archive.close();
});

test("启用后会建表并在一个事务里镜像全部档案", async () => {
  const queries = [];
  const client = {
    async query(text, values = []) {
      queries.push({ text, values });
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(text, values = []) {
      queries.push({ text, values });
      return { rows: [] };
    },
    async connect() { return client; },
    async end() {},
  };
  let clock = 1000;
  const archive = createPostgresArchive({ pool, now: () => ++clock });
  const counts = await archive.syncSnapshot(snapshot);

  assert.deepEqual(counts, { rooms: 1, members: 1, messages: 1, summaries: 1, privateMemories: 1 });
  assert.match(queries[0].text, /CREATE TABLE IF NOT EXISTS room_messages/);
  assert.equal(queries.some((query) => query.text === "BEGIN"), true);
  assert.equal(queries.some((query) => query.text === "COMMIT"), true);
  assert.equal(queries.some((query) => /INSERT INTO room_messages/.test(query.text)), true);
  assert.equal(queries.some((query) => /INSERT INTO room_member_events/.test(query.text)), true);
  assert.equal(queries.some((query) => /INSERT INTO agent_private_memories/.test(query.text)), true);
  assert.equal(queries.some((query) => /INSERT INTO room_summary_versions/.test(query.text)), true);
  await archive.close();
});

test("数据库暂时失败时保留最新快照，恢复后可以补存且不向聊天抛错", async () => {
  let schemaShouldFail = true;
  const client = {
    async query() { return { rows: [] }; },
    release() {},
  };
  const pool = {
    async query() {
      if (schemaShouldFail) throw new Error("database unavailable");
      return { rows: [] };
    },
    async connect() { return client; },
    async end() {},
  };
  const archive = createPostgresArchive({
    pool,
    retryMs: 60_000,
    logger: { warn() {} },
  });

  assert.equal(archive.enqueue(snapshot), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(archive.status().state, "error");
  assert.equal(archive.status().pending, true);

  schemaShouldFail = false;
  assert.equal(archive.enqueue(snapshot), true);
  assert.equal(await archive.flush({ timeoutMs: 1_000 }), true);
  assert.equal(archive.status().state, "ready");
  assert.equal(archive.status().pending, false);
  await archive.close();
});

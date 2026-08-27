import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStateStore } from "../lib/state-store.mjs";
import { appendWerewolfLog, archiveWerewolfGame, createWerewolfGame, finishWerewolfGame } from "../public/werewolf-game.js";

test("SQL 主状态优先于旧 JSON 镜像，保存时先写数据库再更新镜像", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-db-primary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "state.json");
  await writeFile(filePath, JSON.stringify({
    version: 3,
    agents: [],
    activeRoomId: "json-room",
    rooms: [{ id: "json-room", name: "过期镜像", participantIds: [], messages: [] }],
  }), "utf8");
  const databaseState = {
    version: 3,
    agents: [],
    activeRoomId: "db-room",
    rooms: [{ id: "db-room", name: "数据库正文", participantIds: [], messages: [] }],
  };
  const saved = [];
  const database = {
    async loadState() { return structuredClone(databaseState); },
    async saveState(value) { saved.push(structuredClone(value)); return true; },
  };
  const store = createStateStore({ filePath, secret: "db-primary-secret", database });

  const initial = await store.clientState();
  assert.equal(initial.activeRoomId, "db-room");
  assert.equal(initial.rooms[0].name, "数据库正文");
  assert.equal(saved.length, 0);

  initial.rooms[0].name = "数据库已更新";
  await store.save(initial);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].rooms[0].name, "数据库已更新");
  assert.match(await readFile(filePath, "utf8"), /数据库已更新/);
});

test("SQL 为空时会从现有 JSON 灾备镜像无损迁移一次", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-db-migrate-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "state.json");
  await writeFile(filePath, JSON.stringify({
    version: 3,
    agents: [{ id: "guest-one", name: "GPT", memoryEnabled: true, memory: "重要旧记忆", memoryRevision: 4 }],
    activeRoomId: "old-room",
    rooms: [{ id: "old-room", name: "旧聊天室", participantIds: ["guest-one"], messages: [{ id: "old-one", text: "第一条", kind: "user", author: "晨曦" }] }],
  }), "utf8");
  const saved = [];
  const store = createStateStore({
    filePath,
    secret: "db-migrate-secret",
    database: {
      async loadState() { return null; },
      async saveState(value) { saved.push(structuredClone(value)); return true; },
    },
  });

  const restored = await store.clientState();
  assert.equal(restored.rooms[0].messages[0].text, "第一条");
  assert.equal(restored.agents[0].memory, "重要旧记忆");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].activeRoomId, "old-room");
});

test("主数据库读取失败时不会静默退回旧 JSON 形成分叉", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-db-unavailable-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "state.json");
  await writeFile(filePath, JSON.stringify({
    version: 3,
    agents: [],
    activeRoomId: "stale-room",
    rooms: [{ id: "stale-room", name: "旧灾备镜像", participantIds: [], messages: [] }],
  }), "utf8");
  const store = createStateStore({
    filePath,
    secret: "db-unavailable-secret",
    database: {
      async loadState() { throw new Error("connection refused"); },
      async saveState() { throw new Error("should not write"); },
    },
  });

  await assert.rejects(() => store.clientState(), /主数据库暂时无法读取：connection refused/);
});

test("同一嘉宾可加入多个房间，离开一个房间不会删除全局嘉宾或私人记忆", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-global-agent-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({ filePath: join(directory, "state.json"), secret: "global-agent-secret" });
  const initial = await store.save({
    agents: [{ id: "guest-one", name: "GPT", memoryEnabled: true, memory: "跨房间记忆", memoryRevision: 5 }],
    activeRoomId: "room-one",
    rooms: [
      { id: "room-one", name: "客厅", participantIds: ["guest-one"], messages: [] },
      { id: "room-two", name: "书房", participantIds: ["guest-one"], messages: [] },
    ],
  });
  assert.deepEqual(initial.rooms.map((room) => room.participantIds), [["guest-one"], ["guest-one"]]);

  initial.activeRoomId = "room-two";
  initial.rooms = [initial.rooms[1]];
  const after = await store.save(initial);
  assert.equal(after.agents.length, 1);
  assert.equal(after.agents[0].memory, "跨房间记忆");
  assert.deepEqual(after.rooms[0].participantIds, ["guest-one"]);
});

test("聊天记录超过五百条时不会静默丢掉最早消息", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-long-history-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({ filePath: join(directory, "state.json"), secret: "long-history-secret" });
  const messages = Array.from({ length: 748 }, (_, index) => ({
    id: `message-${index + 1}`,
    kind: "user",
    author: "晨曦",
    text: `第 ${index + 1} 条`,
    timestamp: index + 1,
  }));

  const saved = await store.save({
    agents: [],
    activeRoomId: "room-long",
    rooms: [{ id: "room-long", name: "群聊", participantIds: [], messages }],
  });

  assert.equal(saved.rooms[0].messages.length, 748);
  assert.equal(saved.rooms[0].messages[0].id, "message-1");
  assert.equal(saved.rooms[0].messages.at(-1).id, "message-748");
});

test("成员簿会迁移旧房间、保留暂离席，并抵抗滞后浏览器覆盖", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-presence-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({ filePath: join(directory, "state.json"), secret: "presence-secret" });
  const stale = await store.save({
    agents: [{ id: "guest-one", name: "GPT", format: "openai", authType: "none" }],
    activeRoomId: "room-one",
    rooms: [{ id: "room-one", name: "房间", participantIds: ["guest-one"], messages: [] }],
  });
  assert.equal(stale.rooms[0].members[0].status, "active");

  const future = Date.now() + 10_000;
  await store.setRoomMemberPresence("room-one", {
    memberId: "guest-one",
    name: "GPT",
    type: "agent",
    status: "away",
    note: "暂时离开",
    at: future,
  });
  const merged = await store.save(stale);
  assert.equal(merged.rooms[0].members[0].status, "away");
  assert.equal(merged.rooms[0].members[0].note, "暂时离开");
  assert.deepEqual(merged.rooms[0].participantIds, ["guest-one"]);

  await store.setRoomMemberPresence("room-one", {
    memberId: "guest-one",
    name: "GPT",
    type: "agent",
    status: "left",
    note: "不会再回来",
    at: future + 1,
  });
  const left = await store.clientState();
  assert.equal(left.rooms[0].members[0].status, "left");
  assert.deepEqual(left.rooms[0].participantIds, []);
});

test("后台长期总结不会被滞后的浏览器状态覆盖", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "background-summary-secret",
  });
  const stale = await store.save({
    agents: [{ id: "guest-one", name: "GPT", format: "openai", authType: "none" }],
    activeRoomId: "room-memory",
    rooms: [{
      id: "room-memory",
      name: "记忆房间",
      participantIds: ["guest-one"],
      messages: [
        { id: "message-one", kind: "user", author: "晨曦", text: "第一条" },
        { id: "message-two", kind: "agent", agentId: "guest-one", author: "GPT", text: "第二条" },
      ],
      memory: {
        enabled: true,
        interval: 20,
        recentMessages: 30,
        focus: "旧重点",
        summary: "旧总结",
        summarizedThroughId: "message-one",
        summarizedMessageCount: 1,
        updatedAt: 100,
      },
    }],
  });

  assert.equal(await store.completeRoomSummary("room-memory", {
    summary: "后台生成的新总结",
    summarizedThroughId: "message-two",
    summarizedMessageCount: 2,
    expectedPreviousMarker: "message-one",
    expectedPreviousUpdatedAt: 100,
    at: 200,
  }), true);

  stale.rooms[0].memory.focus = "浏览器刚改的新重点";
  const merged = await store.save(stale);
  assert.equal(merged.rooms[0].memory.summary, "后台生成的新总结");
  assert.equal(merged.rooms[0].memory.summarizedThroughId, "message-two");
  assert.equal(merged.rooms[0].memory.summarizedMessageCount, 2);
  assert.equal(merged.rooms[0].memory.updatedAt, 200);
  assert.equal(merged.rooms[0].memory.focus, "浏览器刚改的新重点");
});

test("API Key 加密保存且不会返回给浏览器", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "state.json");
  const store = createStateStore({
    filePath,
    secret: "43ce139600db389d60ab016f56e6310818384eafdcc657dea776d1dcc4fca210",
  });

  const saved = await store.save({
    activeRoomId: "room-one",
    agents: [
      {
        id: "guest-one",
        name: "GPT",
        format: "openai",
        baseUrl: "https://example.test/v1",
        model: "strange-[模型]-name",
        authType: "bearer",
        apiKey: "super-secret-key",
        extraHeaders: '{"X-App":"secret-header"}',
      },
    ],
    rooms: [
      {
        id: "room-one",
        name: "测试房间",
        roomPrompt: "轻松聊天，不用总结升华。",
        participantIds: ["guest-one"],
        messages: [{ id: "message-one", kind: "user", author: "晨曦", text: "你好" }],
      },
    ],
  });

  assert.equal(saved.agents[0].apiKey, "");
  assert.equal(saved.agents[0].hasApiKey, true);
  assert.equal(saved.agents[0].extraHeaders, "");
  assert.equal(saved.rooms[0].messages[0].text, "你好");
  assert.equal(saved.rooms[0].roomPrompt, "轻松聊天，不用总结升华。");

  const raw = await readFile(filePath, "utf8");
  assert.doesNotMatch(raw, /super-secret-key/);
  assert.doesNotMatch(raw, /secret-header/);
  const credentials = await store.credentials("guest-one");
  assert.equal(credentials.apiKey, "super-secret-key");
  assert.equal(credentials.extraHeaders, '{"X-App":"secret-header"}');
});

test("嘉宾头像会持久化且只接受受限大小的安全图片 data URL", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-avatar-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({ filePath: join(directory, "state.json"), secret: "avatar-secret" });
  const validAvatar = "data:image/webp;base64,AAAA";
  const saved = await store.save({
    activeRoomId: "room-one",
    agents: [
      { id: "guest-one", name: "GPT", format: "openai", authType: "none", avatar: validAvatar },
      { id: "guest-two", name: "Claude", format: "anthropic", authType: "none", avatar: "https://example.test/avatar.png" },
    ],
    rooms: [{ id: "room-one", name: "群聊", participantIds: ["guest-one", "guest-two"], messages: [] }],
  });
  assert.equal(saved.agents[0].avatar, validAvatar);
  assert.equal(saved.agents[1].avatar, "");
  assert.equal((await store.clientState()).agents[0].avatar, validAvatar);
  const legacyClientSave = await store.save({
    activeRoomId: "room-one",
    agents: [{ id: "guest-one", name: "GPT", format: "openai", authType: "none" }],
    rooms: [{ id: "room-one", name: "群聊", participantIds: ["guest-one"], messages: [] }],
  });
  assert.equal(legacyClientSave.agents[0].avatar, validAvatar);
});

test("留空时保留旧 Key，明确清除时才删除", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "test-secret",
  });
  const base = {
    activeRoomId: "room-one",
    rooms: [{ id: "room-one", name: "房间", participantIds: ["guest-one"], messages: [] }],
  };

  await store.save({
    ...base,
    agents: [{ id: "guest-one", name: "Grok", format: "openai", authType: "bearer", apiKey: "keep-me" }],
  });
  await store.save({
    ...base,
    agents: [{ id: "guest-one", name: "Grok", format: "openai", authType: "bearer", apiKey: "" }],
  });
  assert.equal((await store.credentials("guest-one")).apiKey, "keep-me");

  const cleared = await store.save({
    ...base,
    agents: [{ id: "guest-one", name: "Grok", format: "openai", authType: "bearer", clearApiKey: true }],
  });
  assert.equal(cleared.agents[0].hasApiKey, false);
  assert.equal((await store.credentials("guest-one")).apiKey, "");
});

test("角色私人记忆可以完整保存超过两万字的长记录", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({ filePath: join(directory, "state.json"), secret: "memory-size-secret" });
  const memory = "记忆".repeat(20_000);
  const saved = await store.save({
    activeRoomId: "room-one",
    agents: [{
      id: "guest-one",
      name: "谢知衡",
      format: "anthropic",
      authType: "x-api-key",
      memoryEnabled: true,
      memory,
      memoryRevision: 1,
    }],
    rooms: [{ id: "room-one", name: "竹马群", participantIds: ["guest-one"], messages: [] }],
  });
  assert.equal(saved.agents[0].memory.length, memory.length);
  assert.equal(saved.agents[0].memory, memory);
});

test("嘉宾副本可以在不暴露明文的情况下复制加密凭据并保持独立", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "state.json");
  const store = createStateStore({ filePath, secret: "duplicate-secret" });
  const room = { id: "room-one", name: "狼人杀", participantIds: ["guest-one"], messages: [] };

  await store.save({
    activeRoomId: room.id,
    agents: [{
      id: "guest-one",
      name: "Claude",
      format: "anthropic",
      authType: "x-api-key",
      apiKey: "copy-me-securely",
      extraHeaders: '{"X-Route":"fable"}',
    }],
    rooms: [room],
  });

  const duplicated = await store.save({
    activeRoomId: room.id,
    agents: [
      { id: "guest-one", name: "Claude", format: "anthropic", authType: "x-api-key" },
      {
        id: "guest-werewolf",
        name: "Claude · 狼人杀",
        format: "anthropic",
        authType: "x-api-key",
        credentialSourceId: "guest-one",
        memoryEnabled: true,
        memory: "",
      },
    ],
    rooms: [{ ...room, participantIds: ["guest-one", "guest-werewolf"] }],
  });

  assert.equal(duplicated.agents[1].hasApiKey, true);
  assert.equal(duplicated.agents[1].apiKey, "");
  assert.deepEqual(await store.credentials("guest-werewolf"), {
    apiKey: "copy-me-securely",
    extraHeaders: '{"X-Route":"fable"}',
  });
  assert.doesNotMatch(await readFile(filePath, "utf8"), /copy-me-securely|X-Route/);

  await store.save({
    activeRoomId: room.id,
    agents: [
      { id: "guest-one", name: "Claude", format: "anthropic", authType: "x-api-key", clearApiKey: true },
      { id: "guest-werewolf", name: "Claude · 狼人杀", format: "anthropic", authType: "x-api-key" },
    ],
    rooms: [{ ...room, participantIds: ["guest-one", "guest-werewolf"] }],
  });
  assert.equal((await store.credentials("guest-one")).apiKey, "");
  assert.equal((await store.credentials("guest-werewolf")).apiKey, "copy-me-securely");
});

test("给旧房间增加氛围提示时保留原聊天记录", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "room-migration-secret",
  });
  const agent = { id: "guest-one", name: "Claude", format: "anthropic", authType: "x-api-key" };
  const original = await store.save({
    agents: [agent],
    activeRoomId: "room-old",
    rooms: [
      {
        id: "room-old",
        name: "旧房间",
        participantIds: ["guest-one"],
        messages: [
          { id: "message-a", kind: "user", author: "晨曦", text: "第一条" },
          { id: "message-b", kind: "agent", author: "Claude", text: "第二条" },
        ],
      },
    ],
  });
  original.rooms[0].roomPrompt = "像朋友一样自然接话。";
  const upgraded = await store.save(original);

  assert.equal(upgraded.rooms[0].roomPrompt, "像朋友一样自然接话。");
  assert.equal(upgraded.rooms[0].bubbleSplit, false);
  assert.equal(upgraded.rooms[0].memory.focus, "");
  assert.deepEqual(
    upgraded.rooms[0].messages.map((message) => message.text),
    ["第一条", "第二条"],
  );
});

test("房间连发设置与气泡分段可以持久化", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "bubble-room-secret",
  });
  const saved = await store.save({
    agents: [{
      id: "guest-one",
      name: "GPT",
      format: "openai",
      authType: "none",
      memoryEnabled: true,
      memory: "",
      memoryRevision: 0,
    }],
    activeRoomId: "room-bubbles",
    rooms: [{
      id: "room-bubbles",
      name: "竹马群",
      bubbleSplit: true,
      participantIds: ["guest-one"],
      messages: [{
        id: "message-bubbles",
        kind: "agent",
        author: "GPT",
        text: "旧的原始文本不会作为准本",
        segments: ["你先走。", "等等，我也去。"],
      }],
    }],
  });

  assert.equal(saved.rooms[0].bubbleSplit, true);
  assert.equal(saved.rooms[0].messages[0].text, "你先走。\n等等，我也去。");
  assert.deepEqual(saved.rooms[0].messages[0].segments, ["你先走。", "等等，我也去。"]);
});

test("记忆整理员 Key 加密保存且房间长期记忆可迁移", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "state.json");
  const store = createStateStore({ filePath, secret: "memory-secret" });

  const saved = await store.save({
    agents: [{ id: "guest-one", name: "GPT", format: "openai", authType: "bearer" }],
    summarizer: {
      id: "memory-summarizer",
      format: "openai",
      baseUrl: "https://summary.example/v1",
      model: "summary-model",
      authType: "bearer",
      apiKey: "summary-secret-key",
    },
    activeRoomId: "room-memory",
    rooms: [{
      id: "room-memory",
      name: "记忆房间",
      participantIds: ["guest-one"],
      messages: [{ id: "message-one", kind: "user", author: "晨曦", text: "记住这件事" }],
      memory: {
        enabled: true,
        interval: 20,
        recentMessages: 30,
        focus: "优先保留双方明确做出的承诺。",
        summary: "晨曦希望大家记住这件事。",
        summarizedThroughId: "message-one",
        summarizedMessageCount: 1,
        updatedAt: 123456,
      },
    }],
  });

  assert.equal(saved.version, 3);
  assert.equal(saved.summarizer.apiKey, "");
  assert.equal(saved.summarizer.hasApiKey, true);
  assert.equal(saved.rooms[0].memory.focus, "优先保留双方明确做出的承诺。");
  assert.equal(saved.rooms[0].memory.summary, "晨曦希望大家记住这件事。");
  assert.equal((await store.credentials("memory-summarizer")).apiKey, "summary-secret-key");
  assert.doesNotMatch(await readFile(filePath, "utf8"), /summary-secret-key/);
});

test("房间总结不再截在五万字或把真实整理计数封成五百", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-summary-limit-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "summary-limit-secret",
  });
  const longSummary = "客观事实。".repeat(12_000);
  await store.save({
    agents: [],
    activeRoomId: "room-summary-limit",
    rooms: [{
      id: "room-summary-limit",
      name: "长总结房间",
      participantIds: [],
      messages: [{ id: "message-marker", kind: "user", author: "晨曦", text: "原文仍在" }],
      memory: {
        summary: longSummary,
        summarizedThroughId: "message-marker",
        summarizedMessageCount: 717,
        updatedAt: 100,
      },
    }],
  });

  const saved = await store.clientState();
  assert.equal(saved.rooms[0].memory.summary, longSummary);
  assert.equal(saved.rooms[0].memory.summarizedMessageCount, 717);
});

test("总结超过安全保存上限时拒绝推进锚点而不是静默截断", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-summary-atomic-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "summary-atomic-secret",
  });
  await store.save({
    agents: [],
    activeRoomId: "room-summary-atomic",
    rooms: [{
      id: "room-summary-atomic",
      name: "原子保存房间",
      participantIds: [],
      messages: [
        { id: "message-one", kind: "user", author: "晨曦", text: "第一条" },
        { id: "message-two", kind: "user", author: "晨曦", text: "第二条" },
      ],
      memory: {
        summary: "旧摘要",
        summarizedThroughId: "message-one",
        summarizedMessageCount: 1,
        updatedAt: 100,
      },
    }],
  });

  await assert.rejects(store.completeRoomSummary("room-summary-atomic", {
    summary: "超".repeat(200_001),
    summarizedThroughId: "message-two",
    summarizedMessageCount: 2,
    expectedPreviousMarker: "message-one",
    expectedPreviousUpdatedAt: 100,
    at: 200,
  }), /超过安全保存上限 200000 字，整理锚点未推进/);

  const saved = await store.clientState();
  assert.equal(saved.rooms[0].memory.summary, "旧摘要");
  assert.equal(saved.rooms[0].memory.summarizedThroughId, "message-one");
  assert.equal(saved.rooms[0].memory.summarizedMessageCount, 1);
});

test("MCP 访客不会读取已知被旧上限截断的共同总结", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-summary-mcp-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "summary-mcp-secret",
  });
  await store.save({
    agents: [],
    activeRoomId: "room-summary-mcp",
    rooms: [{
      id: "room-summary-mcp",
      name: "截断总结房间",
      participantIds: [],
      messages: [],
      memory: {
        summary: "旧".repeat(49_993),
        summarizedMessageCount: 500,
        updatedAt: 100,
      },
    }],
  });

  const snapshot = await store.publicRoomSnapshot("room-summary-mcp", { includeContext: true });
  assert.equal(snapshot.longTermSummary, "");
  assert.equal(snapshot.summaryStale, true);
});

test("删除或修改旧楼层不会把可用总结锁成必须重建", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-summary-edit-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "summary-edit-secret",
  });
  await store.save({
    agents: [],
    activeRoomId: "room-summary-edit",
    rooms: [{
      id: "room-summary-edit",
      name: "可随手修记录的房间",
      participantIds: [],
      messages: [{ id: "message-two", kind: "user", author: "晨曦", text: "保留的原文" }],
      memory: {
        enabled: true,
        summary: "仍可继续使用的摘要",
        summarizedThroughId: "message-two",
        summarizedMessageCount: 1,
        stale: true,
      },
    }],
  });

  const saved = await store.clientState();
  const snapshot = await store.publicRoomSnapshot("room-summary-edit", { includeContext: true });
  assert.equal(saved.rooms[0].memory.stale, false);
  assert.equal(snapshot.summaryStale, false);
  assert.equal(snapshot.longTermSummary, "仍可继续使用的摘要");
});

test("后台定时发言不会被滞后的浏览器保存覆盖", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "scheduled-room-secret",
  });
  const stale = await store.save({
    agents: [{
      id: "guest-one",
      name: "GPT",
      format: "openai",
      authType: "none",
      memoryEnabled: true,
      memory: "",
      memoryRevision: 0,
    }],
    activeRoomId: "room-timer",
    rooms: [{
      id: "room-timer",
      name: "定时房间",
      participantIds: ["guest-one"],
      messages: [
        { id: "message-user", kind: "user", author: "晨曦", text: "稍后见" },
        {
          id: "message-existing-private",
          kind: "user",
          author: "晨曦",
          text: "这句话只给GPT",
          privacy: "private",
          recipientIds: ["guest-one"],
        },
      ],
      schedule: {
        enabled: true,
        intervalMinutes: 30,
        maxTurns: 3,
        dailyLimit: 8,
      },
      eventCards: { enabled: true, focus: "只写这个房间里的事件。", recentIds: [], revision: 0 },
    }],
  });

  await store.completeScheduledRun("room-timer", {
    at: Date.now(),
    result: "新增 1 条定时发言",
    mic: {
      scoreHistory: { "guest-one": [3, 7] },
      revision: 2,
    },
    eventCards: {
      enabled: true,
      focus: "只写这个房间里的事件。",
      recentIds: ["old-object"],
      lastEvent: "翻出了一件旧东西。",
      revision: 1,
    },
    privateMemoryItems: {
      "guest-one": ["我想等晨曦回来再把这件事说完。"],
    },
    messages: [{
      id: "message-scheduled",
      kind: "agent",
      author: "GPT",
      text: "没人发话，但我突然想到一件事。",
      agentId: "guest-one",
      timestamp: Date.now(),
    }],
  });

  const merged = await store.save(stale);
  assert.equal(merged.rooms[0].messages.some((message) => message.id === "message-scheduled"), true);
  const retainedPrivate = merged.rooms[0].messages.find((message) => message.id === "message-existing-private");
  assert.equal(retainedPrivate.privacy, "private");
  assert.deepEqual(retainedPrivate.recipientIds, ["guest-one"]);
  assert.equal(merged.rooms[0].schedule.dailyCount, 1);
  assert.deepEqual(merged.rooms[0].mic.scoreHistory["guest-one"], [3, 7]);
  assert.equal(merged.rooms[0].mic.revision, 2);
  assert.deepEqual(merged.rooms[0].eventCards.recentIds, ["old-object"]);
  assert.equal(merged.rooms[0].eventCards.focus, "只写这个房间里的事件。");
  assert.equal(merged.rooms[0].eventCards.revision, 1);
  assert.match(merged.agents[0].memory, /我想等晨曦回来再把这件事说完/);
  assert.equal(merged.agents[0].memoryEnabled, true);
  assert.ok(merged.agents[0].memoryRevision > 0);

  merged.rooms[0].messages = merged.rooms[0].messages.filter((message) => message.id !== "message-scheduled");
  const deleted = await store.save(merged);
  assert.equal(deleted.rooms[0].messages.some((message) => message.id === "message-scheduled"), false);
});

test("私聊收件人结构会持久化，未知收件人不会降级成公开消息", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "private-chat-secret",
  });
  const saved = await store.save({
    agents: [
      { id: "guest-a", name: "A", format: "openai", authType: "none" },
      { id: "guest-b", name: "B", format: "openai", authType: "none" },
    ],
    activeRoomId: "room-private",
    rooms: [{
      id: "room-private",
      name: "私聊房间",
      participantIds: ["guest-a", "guest-b"],
      messages: [
        {
          id: "message-private",
          kind: "agent",
          author: "A",
          text: "只给B",
          agentId: "guest-a",
          privacy: "private",
          recipientIds: ["guest-b"],
        },
        {
          id: "message-needs-repair",
          kind: "agent",
          author: "A",
          text: "我私聊里再说。",
          agentId: "guest-a",
          privateRepairEligible: true,
        },
        {
          id: "message-broken-private",
          kind: "agent",
          author: "A",
          text: "不能意外公开",
          agentId: "guest-a",
          privacy: "private",
          recipientIds: ["not-in-catalog"],
        },
      ],
    }],
  });
  const privateMessage = saved.rooms[0].messages.find((message) => message.id === "message-private");
  const brokenMessage = saved.rooms[0].messages.find((message) => message.id === "message-broken-private");
  const repairMessage = saved.rooms[0].messages.find((message) => message.id === "message-needs-repair");
  assert.equal(privateMessage.privacy, "private");
  assert.deepEqual(privateMessage.recipientIds, ["guest-b"]);
  assert.equal(brokenMessage.privacy, "private");
  assert.deepEqual(brokenMessage.recipientIds, ["__room_user__"]);
  assert.equal(repairMessage.privateRepairEligible, true);
});

test("手动关闭角色记忆时保留内容但后续可再次开启", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "private-memory-secret",
  });
  await store.save({
    activeRoomId: "room-one",
    agents: [{
      id: "guest-one",
      name: "Claude",
      format: "anthropic",
      authType: "none",
      memoryEnabled: true,
      memory: "- 我记得这件事。",
      memoryRevision: 10,
    }],
    rooms: [{ id: "room-one", name: "房间", participantIds: ["guest-one"], messages: [] }],
  });
  const closed = await store.save({
    activeRoomId: "room-one",
    agents: [{
      id: "guest-one",
      name: "Claude",
      format: "anthropic",
      authType: "none",
      memoryEnabled: false,
      memory: "- 我记得这件事。",
      memoryRevision: 20,
    }],
    rooms: [{ id: "room-one", name: "房间", participantIds: ["guest-one"], messages: [] }],
  });
  assert.equal(closed.agents[0].memoryEnabled, false);
  assert.equal(closed.agents[0].memory, "- 我记得这件事。");
});

test("狼人杀房会单独保存临时卷宗，不混入普通聊天与长期总结", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-werewolf-room-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "werewolf-room-secret",
  });
  const participants = Array.from({ length: 6 }, (_, index) => ({
    id: `guest-${index + 1}`,
    name: `嘉宾${index + 1}`,
    type: "agent",
  }));
  const archivedGame = createWerewolfGame({ participants, random: () => 0.2 });
  finishWerewolfGame(archivedGame, "wolf");
  const saved = await store.save({
    agents: participants.map((player) => ({
      id: player.id,
      name: player.name,
      format: "openai",
      authType: "none",
    })),
    activeRoomId: "room-werewolf",
    rooms: [{
      id: "room-werewolf",
      name: "月黑请闭眼",
      roomType: "werewolf",
      participantIds: participants.map((player) => player.id),
      messages: [],
      memory: { summary: "这段普通房间总结不应被游戏改写" },
      werewolf: createWerewolfGame({ participants, random: () => 0.4 }),
      werewolfArchives: [archiveWerewolfGame(archivedGame, 1)],
    }],
  });

  assert.equal(saved.rooms[0].roomType, "werewolf");
  assert.equal(saved.rooms[0].werewolf.players.length, 6);
  assert.equal(saved.rooms[0].werewolf.log[0].text, "身份牌已经发好。天黑请闭眼。");
  assert.equal(saved.rooms[0].werewolfArchives.length, 1);
  assert.match(saved.rooms[0].werewolfArchives[0].archiveTitle, /第 1 局/);
  assert.ok(saved.rooms[0].werewolfArchives[0].log.some((entry) => entry.phase === "debrief"));
  assert.deepEqual(saved.rooms[0].messages, []);
  assert.equal(saved.rooms[0].memory.summary, "这段普通房间总结不应被游戏改写");
});

test("中途刷新与滞后重复保存不会回退狼人杀当前进度", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-werewolf-refresh-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({ filePath: join(directory, "state.json"), secret: "refresh-secret" });
  const participants = Array.from({ length: 6 }, (_, index) => ({
    id: `refresh-${index + 1}`,
    name: `刷新玩家${index + 1}`,
    type: "agent",
  }));
  const agents = participants.map((player) => ({ ...player, format: "openai", authType: "none" }));
  const game = createWerewolfGame({ participants, random: () => 0.2 });
  const first = await store.save({
    agents,
    activeRoomId: "werewolf-refresh-room",
    rooms: [{
      id: "werewolf-refresh-room",
      name: "刷新恢复局",
      roomType: "werewolf",
      participantIds: participants.map((player) => player.id),
      messages: [],
      werewolf: game,
      werewolfArchives: [],
    }],
  });

  const progressed = structuredClone(first);
  const progressedGame = progressed.rooms[0].werewolf;
  appendWerewolfLog(progressedGame, { visibility: "wolves", text: "第二次增量已经落库。" });
  progressedGame.revision = 8;
  const savedProgress = await store.save(progressed);
  assert.equal(savedProgress.rooms[0].werewolf.revision, 8);

  const afterStaleRetry = await store.save(first);
  assert.equal(afterStaleRetry.rooms[0].werewolf.revision, 8);
  assert.ok(afterStaleRetry.rooms[0].werewolf.log.some((entry) => entry.text === "第二次增量已经落库。"));
  assert.equal((await store.clientState()).rooms[0].werewolf.revision, 8);
});

test("修改或删除当前局和历史局消息只改显示日志，不改结构化游戏事实也不会被滞后保存回退", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-werewolf-delete-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "state.json");
  const store = createStateStore({ filePath, secret: "delete-werewolf-secret" });
  const participants = Array.from({ length: 6 }, (_, index) => ({
    id: `delete-${index + 1}`,
    name: `删除玩家${index + 1}`,
    type: "agent",
  }));
  const agents = participants.map((player) => ({ ...player, format: "openai", authType: "none" }));
  const current = createWerewolfGame({ participants, random: () => 0.2 });
  current.nights = [{ day: 1, killTargetId: participants[4].id, deaths: [participants[4].id], resolved: true }];
  current.days = [{ day: 1, votes: { [participants[0].id]: participants[1].id }, eliminatedId: participants[1].id }];
  const currentMessage = appendWerewolfLog(current, { authorId: participants[0].id, author: participants[0].name, text: "删除当前局这条。" });
  const ended = createWerewolfGame({ participants, random: () => 0.3 });
  ended.nights = [{ day: 1, killTargetId: participants[3].id, deaths: [], resolved: true }];
  finishWerewolfGame(ended, "wolf");
  const historyMessage = appendWerewolfLog(ended, { authorId: participants[1].id, author: participants[1].name, text: "删除历史局这条。", phase: "debrief" });
  const archived = archiveWerewolfGame(ended, 1);
  const original = await store.save({
    agents,
    activeRoomId: "werewolf-delete-room",
    rooms: [{
      id: "werewolf-delete-room",
      name: "删除测试",
      roomType: "werewolf",
      participantIds: participants.map((player) => player.id),
      messages: [],
      werewolf: current,
      werewolfArchives: [archived],
    }],
  });
  const factsBefore = {
    currentNights: original.rooms[0].werewolf.nights,
    currentDays: original.rooms[0].werewolf.days,
    archivedNights: original.rooms[0].werewolfArchives[0].nights,
    winner: original.rooms[0].werewolfArchives[0].winner,
  };

  const editedCurrent = await store.editWerewolfEvent("werewolf-delete-room", current.id, currentMessage.id, "当前局已经改好。");
  const editedHistory = await store.editWerewolfEvent("werewolf-delete-room", archived.id, historyMessage.id, "历史局已经改好。");
  assert.equal(editedCurrent.updated, true);
  assert.equal(editedCurrent.text, "当前局已经改好。");
  assert.equal(editedHistory.updated, true);
  assert.equal((await store.editWerewolfEvent("werewolf-delete-room", archived.id, historyMessage.id, "历史局已经改好。")).updated, false);
  let after = await store.clientState();
  assert.equal(after.rooms[0].werewolf.log.find((entry) => entry.id === currentMessage.id).text, "当前局已经改好。");
  assert.equal(after.rooms[0].werewolfArchives[0].log.find((entry) => entry.id === historyMessage.id).text, "历史局已经改好。");
  assert.deepEqual({
    currentNights: after.rooms[0].werewolf.nights,
    currentDays: after.rooms[0].werewolf.days,
    archivedNights: after.rooms[0].werewolfArchives[0].nights,
    winner: after.rooms[0].werewolfArchives[0].winner,
  }, factsBefore);

  assert.equal((await store.deleteWerewolfEvent("werewolf-delete-room", current.id, currentMessage.id)).deleted, true);
  assert.equal((await store.deleteWerewolfEvent("werewolf-delete-room", archived.id, historyMessage.id)).deleted, true);
  assert.equal((await store.deleteWerewolfEvent("werewolf-delete-room", archived.id, historyMessage.id)).deleted, false);
  after = await store.clientState();
  assert.ok(!after.rooms[0].werewolf.log.some((entry) => entry.id === currentMessage.id));
  assert.ok(!after.rooms[0].werewolfArchives[0].log.some((entry) => entry.id === historyMessage.id));
  assert.deepEqual({
    currentNights: after.rooms[0].werewolf.nights,
    currentDays: after.rooms[0].werewolf.days,
    archivedNights: after.rooms[0].werewolfArchives[0].nights,
    winner: after.rooms[0].werewolfArchives[0].winner,
  }, factsBefore);

  after = await store.save(original);
  assert.ok(!after.rooms[0].werewolf.log.some((entry) => entry.id === currentMessage.id));
  assert.ok(!after.rooms[0].werewolfArchives[0].log.some((entry) => entry.id === historyMessage.id));
  assert.doesNotMatch(await readFile(filePath, "utf8"), /删除当前局这条|删除历史局这条/);
});

test("封存后旧局不会被滞后请求复活，新局也不会继承旧复盘或私人日记", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-werewolf-seal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({ filePath: join(directory, "state.json"), secret: "seal-secret" });
  const participants = Array.from({ length: 6 }, (_, index) => ({
    id: `seal-${index + 1}`,
    name: `封存玩家${index + 1}`,
    type: "agent",
  }));
  const agents = participants.map((player) => ({ ...player, format: "openai", authType: "none" }));
  const oldGame = createWerewolfGame({ participants, random: () => 0.3 });
  finishWerewolfGame(oldGame, "wolf");
  oldGame.privateDiaries.push({
    id: "old-private-diary",
    authorId: participants[0].id,
    body: "只属于旧局。",
    audienceIds: [participants[0].id, "werewolf-user"],
    timestamp: Date.now(),
  });
  const activeSnapshot = await store.save({
    agents,
    activeRoomId: "werewolf-seal-room",
    rooms: [{
      id: "werewolf-seal-room",
      name: "封存测试",
      roomType: "werewolf",
      participantIds: participants.map((player) => player.id),
      messages: [],
      werewolf: oldGame,
      werewolfArchives: [],
    }],
  });

  const archived = archiveWerewolfGame(oldGame, 1);
  const sealed = structuredClone(activeSnapshot);
  sealed.rooms[0].werewolf = null;
  sealed.rooms[0].werewolfArchives = [archived];
  await store.save(sealed);

  const newGame = createWerewolfGame({ participants, random: () => 0.6 });
  const next = structuredClone(sealed);
  next.rooms[0].werewolf = newGame;
  const started = await store.save(next);
  assert.equal(started.rooms[0].werewolf.id, newGame.id);
  assert.equal(started.rooms[0].werewolf.privateDiaries.length, 0);
  assert.ok(!started.rooms[0].werewolf.log.some((entry) => entry.phase === "debrief"));
  assert.equal(started.rooms[0].werewolfArchives.length, 1);
  assert.equal(started.rooms[0].werewolfArchives[0].privateDiaries[0].body, "只属于旧局。");

  const afterStaleRetry = await store.save(activeSnapshot);
  assert.equal(afterStaleRetry.rooms[0].werewolf.id, newGame.id);
  assert.equal(afterStaleRetry.rooms[0].werewolfArchives.length, 1);
});

test("已离开的外部访客可从嘉宾席移除且旧聊天保留，滞后保存不会把它复活", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-remove-visitor-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = createStateStore({ filePath: join(directory, "state.json"), secret: "remove-visitor-secret" });
  const initial = await store.save({
    agents: [],
    activeRoomId: "visitor-room",
    rooms: [{
      id: "visitor-room",
      name: "访客房",
      participantIds: [],
      members: [{
        id: "invite-0123456789abcdef",
        name: "旧 MCP",
        type: "mcp",
        status: "left",
        note: "邀请已结束",
        joinedAt: 1,
        statusChangedAt: 2,
      }],
      messages: [{
        id: "visitor-old-message",
        kind: "agent",
        author: "旧 MCP",
        text: "这条过去的聊天要保留",
        source: "mcp",
        externalId: "invite-0123456789abcdef",
        agentId: "invite-0123456789abcdef",
        timestamp: 1,
      }],
    }],
  });

  const removed = await store.removeExternalRoomMember("visitor-room", "invite-0123456789abcdef");
  assert.equal(removed.removed, true);
  let current = await store.clientState();
  assert.equal(current.rooms[0].members.some((member) => member.id === "invite-0123456789abcdef"), false);
  assert.equal(current.rooms[0].messages[0].text, "这条过去的聊天要保留");
  assert.deepEqual(current.rooms[0].hiddenExternalMemberIds, ["invite-0123456789abcdef"]);

  current = await store.save(initial);
  assert.equal(current.rooms[0].members.some((member) => member.id === "invite-0123456789abcdef"), false);
  assert.equal(current.rooms[0].messages[0].text, "这条过去的聊天要保留");

  await store.setRoomMemberPresence("visitor-room", {
    memberId: "invite-0123456789abcdef",
    name: "旧 MCP",
    type: "mcp",
    status: "active",
    touch: true,
  });
  current = await store.clientState();
  assert.equal(current.rooms[0].members.find((member) => member.id === "invite-0123456789abcdef")?.status, "active");
  assert.deepEqual(current.rooms[0].hiddenExternalMemberIds, []);
});

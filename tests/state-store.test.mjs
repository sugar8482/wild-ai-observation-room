import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStateStore } from "../lib/state-store.mjs";

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
  assert.equal(upgraded.rooms[0].memory.focus, "");
  assert.deepEqual(
    upgraded.rooms[0].messages.map((message) => message.text),
    ["第一条", "第二条"],
  );
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

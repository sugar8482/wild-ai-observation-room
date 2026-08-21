import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStateStore } from "../lib/state-store.mjs";
import { createWerewolfGame } from "../public/werewolf-game.js";

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
    }],
  });

  assert.equal(saved.rooms[0].roomType, "werewolf");
  assert.equal(saved.rooms[0].werewolf.players.length, 6);
  assert.equal(saved.rooms[0].werewolf.log[0].text, "身份牌已经发好。天黑请闭眼。");
  assert.deepEqual(saved.rooms[0].messages, []);
  assert.equal(saved.rooms[0].memory.summary, "这段普通房间总结不应被游戏改写");
});

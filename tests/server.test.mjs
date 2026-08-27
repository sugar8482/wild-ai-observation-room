import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { chatRequestPolicy, createAppServer } from "../server.mjs";
import { appendWerewolfLog, createWerewolfGame } from "../public/werewolf-game.js";

test("数据库档案馆状态可查询并能手动触发补存", async (context) => {
  let queued = null;
  const archive = {
    status: () => ({ enabled: true, state: queued ? "syncing" : "ready", counts: { rooms: 1, messages: 2 } }),
    enqueue: (snapshot) => { queued = snapshot; return true; },
  };
  const stateStore = {
    clientState: async () => ({ rooms: [{ id: "room-one" }], agents: [] }),
  };
  const server = createAppServer({ archive, stateStore });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const status = await fetch(`${origin}/api/archive`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).enabled, true);

  const sync = await fetch(`${origin}/api/archive/sync`, { method: "POST" });
  assert.equal(sync.status, 202);
  assert.deepEqual(queued, { rooms: [{ id: "room-one" }], agents: [] });
});

test("刷新时优先恢复数据库中较新的狼人杀进度并同步每次保存", async (context) => {
  const participants = Array.from({ length: 6 }, (_, index) => ({
    id: `server-werewolf-${index + 1}`,
    name: `服务端玩家${index + 1}`,
    type: "agent",
  }));
  const stale = createWerewolfGame({ participants, random: () => 0.2 });
  const recovered = structuredClone(stale);
  appendWerewolfLog(recovered, { visibility: "wolves", text: "数据库中的较新夜间进度" });
  recovered.revision = 5;
  let synced = null;
  const snapshot = {
    version: 3,
    agents: [],
    activeRoomId: "werewolf-room",
    rooms: [{
      id: "werewolf-room",
      roomType: "werewolf",
      werewolf: stale,
      werewolfArchives: [{ id: "sealed-game" }],
      messages: [],
    }],
  };
  const stateStore = {
    clientState: async () => structuredClone(snapshot),
    save: async (payload) => payload,
  };
  const archive = {
    status: () => ({ enabled: true, state: "ready" }),
    currentWerewolfGame: async () => structuredClone(recovered),
    syncWerewolfSnapshot: async (value) => { synced = structuredClone(value); },
  };
  const server = createAppServer({ stateStore, archive });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const refreshed = await fetch(`${origin}/api/state`);
  assert.equal(refreshed.status, 200);
  const restored = await refreshed.json();
  assert.equal(restored.rooms[0].werewolf.revision, 5);
  assert.ok(restored.rooms[0].werewolf.log.some((entry) => entry.text === "数据库中的较新夜间进度"));
  assert.deepEqual(restored.rooms[0].werewolfArchives, []);
  assert.equal(restored.rooms[0].werewolfArchiveCount, 1);

  const saved = await fetch(`${origin}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
  assert.equal(saved.status, 200);
  assert.equal(synced.rooms[0].werewolf.id, stale.id);
});

test("狼人杀当前局可走独立小接口保存，不必上传整间观察室", async (context) => {
  const game = createWerewolfGame({
    participants: Array.from({ length: 6 }, (_, index) => ({
      id: `fast-save-${index + 1}`,
      name: `玩家${index + 1}`,
      type: "agent",
    })),
    random: () => 0.2,
  });
  const calls = [];
  const stateStore = {
    async saveWerewolfGame(roomId, incomingGame) {
      calls.push({ roomId, gameId: incomingGame.id, revision: incomingGame.revision });
      return structuredClone(incomingGame);
    },
  };
  const server = createAppServer({ stateStore });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${origin}/api/werewolf/current`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: "werewolf-room", game }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).game.id, game.id);
  assert.deepEqual(calls, [{ roomId: "werewolf-room", gameId: game.id, revision: game.revision }]);
});

test("狼人杀历史 API 按整局列目录，并在单局内部单独分页事件", async (context) => {
  const calls = [];
  const archive = {
    status: () => ({ enabled: true, state: "ready" }),
    werewolfArchives: async (roomId, options) => {
      calls.push({ kind: "catalog", roomId, options });
      return { items: [{ id: "game-one", archiveTitle: "第 1 局｜狼人胜利" }], offset: 2, limit: 1, total: 4 };
    },
    werewolfGame: async (gameId, options) => {
      calls.push({ kind: "game", gameId, options });
      return { game: { id: gameId, log: [] }, events: { offset: 100, limit: 100, total: 620, hasMore: true } };
    },
  };
  const server = createAppServer({ archive });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const catalog = await fetch(`${origin}/api/werewolf/archives?roomId=room-one&offset=2&limit=1`);
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).items.length, 1);
  const game = await fetch(`${origin}/api/werewolf/games/game-one?roomId=room-one&offset=100&limit=100`);
  assert.equal(game.status, 200);
  assert.equal((await game.json()).events.total, 620);
  assert.deepEqual(calls, [
    { kind: "catalog", roomId: "room-one", options: { offset: "2", limit: "1" } },
    {
      kind: "game",
      gameId: "game-one",
      options: { roomId: "room-one", eventOffset: "100", eventLimit: "100", includeDiaries: true },
    },
  ]);
});

test("当前局与历史局狼人杀消息删除会同步主状态和数据库且重复删除安全", async (context) => {
  const knownGames = new Set(["current-game", "archived-game"]);
  const deleted = new Set();
  const calls = [];
  const stateStore = {
    async deleteWerewolfEvent(roomId, gameId, eventId) {
      calls.push({ kind: "state", roomId, gameId, eventId });
      const key = `${gameId}:${eventId}`;
      const first = !deleted.has(key);
      deleted.add(key);
      return {
        gameFound: knownGames.has(gameId),
        deleted: first,
        snapshot: { rooms: [{ id: roomId, roomType: "werewolf" }] },
      };
    },
  };
  const archive = {
    status: () => ({ enabled: true, state: "ready" }),
    async syncWerewolfSnapshot(snapshot) { calls.push({ kind: "sync", snapshot }); },
    async flush() { calls.push({ kind: "flush" }); return true; },
    async deleteWerewolfEvent(roomId, gameId, eventId) {
      calls.push({ kind: "database", roomId, gameId, eventId });
      return { gameFound: true, deleted: false };
    },
  };
  const server = createAppServer({ stateStore, archive });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  for (const gameId of knownGames) {
    const response = await fetch(`${origin}/api/werewolf/games/${gameId}/events/event-one?roomId=werewolf-room`, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).deleted, true);
  }
  const retry = await fetch(`${origin}/api/werewolf/games/current-game/events/event-one?roomId=werewolf-room`, { method: "DELETE" });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).deleted, false);
  assert.equal(calls.filter((call) => call.kind === "database").length, 3);
  assert.ok(calls.some((call) => call.kind === "database" && call.gameId === "archived-game"));

  const wrongRoom = await fetch(`${origin}/api/werewolf/games/missing-game/events/event-one?roomId=werewolf-room`, { method: "DELETE" });
  assert.equal(wrongRoom.status, 404);
});

test("狼人杀消息修改会同步主状态与数据库并拒绝空正文", async (context) => {
  const calls = [];
  const stateStore = {
    async editWerewolfEvent(roomId, gameId, eventId, text) {
      calls.push({ kind: "state", roomId, gameId, eventId, text });
      return {
        gameFound: gameId === "current-game",
        eventFound: eventId === "event-one",
        updated: true,
        text,
        snapshot: { rooms: [{ id: roomId, roomType: "werewolf" }] },
      };
    },
  };
  const archive = {
    status: () => ({ enabled: true, state: "ready" }),
    async syncWerewolfSnapshot(snapshot) { calls.push({ kind: "sync", snapshot }); },
    async flush() { calls.push({ kind: "flush" }); return true; },
    async editWerewolfEvent(roomId, gameId, eventId, text) {
      calls.push({ kind: "database", roomId, gameId, eventId, text });
      return { gameFound: true, eventFound: true, updated: true, text };
    },
  };
  const server = createAppServer({ stateStore, archive });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${origin}/api/werewolf/games/current-game/events/event-one?roomId=werewolf-room`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "改好的卷宗正文。" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, updated: true, text: "改好的卷宗正文。" });
  assert.ok(calls.some((call) => call.kind === "database" && call.text === "改好的卷宗正文。"));

  const blank = await fetch(`${origin}/api/werewolf/games/current-game/events/event-one?roomId=werewolf-room`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(blank.status, 400);
});

test("后台总结任务接口可以提交、查询和取消任务", async (context) => {
  const job = {
    id: "summary-test",
    roomId: "room-one",
    status: "running",
    processedMessages: 0,
    totalMessages: 12,
  };
  const summaryJobs = {
    list: ({ roomId }) => roomId && roomId !== job.roomId ? [] : [job],
    start: async ({ roomId }) => ({ ...job, roomId }),
    get: (id) => id === job.id ? job : null,
    cancel: (id) => id === job.id ? { ...job, status: "cancelling" } : null,
  };
  const server = createAppServer({ summaryJobs });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const accepted = await fetch(`${origin}/api/room-summary-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: "room-one" }),
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).job.id, job.id);

  const listed = await fetch(`${origin}/api/room-summary-jobs?roomId=room-one`);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).jobs.length, 1);

  const cancelled = await fetch(`${origin}/api/room-summary-jobs/${job.id}`, { method: "DELETE" });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).job.status, "cancelling");
});

test("抢麦评分使用短输出并关闭 DeepSeek 隐藏思考", () => {
  const agent = {
    format: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
  };
  const replyPolicy = chatRequestPolicy(agent, { maxTokens: 300 });
  assert.equal(replyPolicy.upstreamMaxTokens, 8192);
  assert.equal(replyPolicy.thinkingMode, "enabled");

  const scorePolicy = chatRequestPolicy(agent, {
    requestMode: "willingness-score",
    maxTokens: 8,
  });
  assert.equal(scorePolicy.upstreamMaxTokens, 8);
  assert.equal(scorePolicy.thinkingMode, "disabled");
  assert.equal(scorePolicy.timeoutMs, 30_000);

  const summaryPolicy = chatRequestPolicy(agent, {
    requestMode: "memory-summary",
    maxTokens: 1800,
  });
  assert.equal(summaryPolicy.isMemorySummary, true);
  assert.equal(summaryPolicy.timeoutMs, 900_000);
  assert.equal(summaryPolicy.upstreamMaxTokens, 8192);

  const privateSummaryPolicy = chatRequestPolicy(agent, {
    requestMode: "private-memory-summary",
    maxTokens: 2400,
  });
  assert.equal(privateSummaryPolicy.isMemorySummary, true);
  assert.equal(privateSummaryPolicy.timeoutMs, 900_000);
  assert.equal(privateSummaryPolicy.upstreamMaxTokens, 8192);
});

test("普通回复默认 1200、尊重手动值且总结兜底预算不变", () => {
  const agent = {
    format: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-test",
  };
  const defaultPolicy = chatRequestPolicy(agent, {});
  assert.equal(defaultPolicy.visibleTokenTarget, 1200);
  assert.equal(defaultPolicy.upstreamMaxTokens, 1200);

  const manualPolicy = chatRequestPolicy(agent, { maxTokens: 640 });
  assert.equal(manualPolicy.visibleTokenTarget, 640);
  assert.equal(manualPolicy.upstreamMaxTokens, 640);

  const summaryPolicy = chatRequestPolicy(agent, { requestMode: "memory-summary" });
  assert.equal(summaryPolicy.visibleTokenTarget, 300);

  const scorePolicy = chatRequestPolicy(agent, { requestMode: "willingness-score" });
  assert.equal(scorePolicy.visibleTokenTarget, 8);
});

test("Kimi K3 正式发言有隐藏思考余量但抢麦评分仍保持短输出", () => {
  const agent = {
    format: "openai",
    baseUrl: "https://example.com/v1",
    model: "[乾坤按量]kimi-k3",
  };
  const replyPolicy = chatRequestPolicy(agent, { maxTokens: 480 });
  assert.equal(replyPolicy.upstreamMaxTokens, 8192);
  assert.equal(replyPolicy.thinkingMode, undefined);
  assert.equal(replyPolicy.requiredTemperature, undefined);
  assert.equal(replyPolicy.timeoutMs, 600_000);

  const gamePolicy = chatRequestPolicy(agent, {
    requestMode: "werewolf-game",
    maxTokens: 300,
  });
  assert.equal(gamePolicy.upstreamMaxTokens, 4096);
  assert.equal(gamePolicy.timeoutMs, 300_000);
  assert.equal(gamePolicy.reasoningEffort, undefined);
  assert.equal(gamePolicy.retryEmptyLength, false);

  const scorePolicy = chatRequestPolicy(agent, {
    requestMode: "willingness-score",
    maxTokens: 8,
  });
  assert.equal(scorePolicy.upstreamMaxTokens, 8);
  assert.equal(scorePolicy.thinkingMode, undefined);
  assert.equal(scorePolicy.timeoutMs, 30_000);
});

test("Moonshot 官方 Kimi K3 固定使用模型唯一允许的 temperature 1", () => {
  const officialAgent = {
    format: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k3",
  };
  assert.equal(chatRequestPolicy(officialAgent, {}).requiredTemperature, 1);
  assert.equal(
    chatRequestPolicy({ ...officialAgent, baseUrl: "https://api.moonshot.ai/v1" }, {}).requiredTemperature,
    1,
  );
  assert.equal(
    chatRequestPolicy({ ...officialAgent, baseUrl: "https://third-party.example/v1" }, {}).requiredTemperature,
    undefined,
  );
  assert.equal(
    chatRequestPolicy({ ...officialAgent, model: "moonshot-v1-128k" }, {}).requiredTemperature,
    undefined,
  );

  const gamePolicy = chatRequestPolicy(officialAgent, {
    requestMode: "werewolf-game",
    maxTokens: 360,
  });
  assert.equal(gamePolicy.reasoningEffort, "low");
  assert.equal(gamePolicy.retryEmptyLength, true);
  assert.equal(gamePolicy.emptyLengthRecoveryMaxTokens, 8192);
  assert.equal(gamePolicy.timeoutMs, 150_000);
});

test("GLM 5.3 正式发言预留隐藏思考额度并允许空正文补救", () => {
  const agent = {
    name: "GLM",
    format: "openai",
    baseUrl: "https://example.com/v1",
    model: "glm-5.3",
  };
  const replyPolicy = chatRequestPolicy(agent, { maxTokens: 520 });
  assert.equal(replyPolicy.upstreamMaxTokens, 8192);
  assert.equal(replyPolicy.retryEmptyLength, true);
  assert.equal(replyPolicy.timeoutMs, 300_000);

  const gamePolicy = chatRequestPolicy(agent, {
    requestMode: "werewolf-game",
    maxTokens: 300,
  });
  assert.equal(gamePolicy.upstreamMaxTokens, 4096);

  const scorePolicy = chatRequestPolicy(agent, {
    requestMode: "willingness-score",
    maxTokens: 8,
  });
  assert.equal(scorePolicy.upstreamMaxTokens, 8);
  assert.equal(scorePolicy.retryEmptyLength, false);
  assert.equal(scorePolicy.timeoutMs, 30_000);
});

test("GLM 思考用完整次额度而正文为空时只自动补救一次", async (context) => {
  const requestBodies = [];
  const upstream = (await import("node:http")).createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requestBodies.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    if (requestBodies.length === 1) {
      response.end(JSON.stringify({
        choices: [{ message: { content: "", reasoning_content: "想了很久" }, finish_reason: "length" }],
      }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{ message: { content: "这是补回来的公开正文。" }, finish_reason: "stop" }],
      usage: { completion_tokens: 12 },
    }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(() => upstream.close());

  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: {
        name: "GLM",
        format: "openai",
        baseUrl: `http://127.0.0.1:${upstream.address().port}`,
        model: "glm-5.3",
        apiKey: "test-key",
      },
      maxTokens: 520,
      messages: [{ role: "user", content: "轮到你发言。" }],
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.text, "这是补回来的公开正文。");
  assert.equal(payload.recoveredFromEmptyLength, true);
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].max_tokens, 8192);
  assert.equal(requestBodies[1].max_tokens, 16384);
  assert.match(requestBodies[1].messages.at(-1).content, /直接给出本轮最终发言或游戏动作/);
});

test("Claude 正式发言允许更长思考但抢麦评分仍保持短超时", () => {
  const agent = {
    name: "Claude",
    format: "openai",
    baseUrl: "https://example.com/v1",
    model: "claude-opus-4-6-thinking",
  };
  const replyPolicy = chatRequestPolicy(agent, { maxTokens: 300 });
  assert.equal(replyPolicy.timeoutMs, 300_000);

  const scorePolicy = chatRequestPolicy(agent, {
    requestMode: "willingness-score",
    maxTokens: 8,
  });
  assert.equal(scorePolicy.timeoutMs, 30_000);
});

test("本地服务提供健康检查和主页面", async (context) => {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "wild-ai-observation-room",
  });

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  const html = await page.text();
  assert.match(html, /野生 AI 观察室/);
  assert.match(html, /配置已保存/);
  assert.match(html, /每个房间有自己的嘉宾阵容和聊天记录/);
});

test("配置错误不会把请求转发到上游", async (context) => {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: {}, messages: [] }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(typeof payload.error, "string");
  assert.ok(payload.error.length > 0);
});

test("Gemini 普通回复超过旧 300 上限时仍完整返回并使用新默认预算", async (context) => {
  const longReply = Array.from({ length: 640 }, () => "hello").join(" ");
  const requestBodies = [];
  const upstream = (await import("node:http")).createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requestBodies.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: longReply }] },
        finishReason: "STOP",
      }],
    }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(() => upstream.close());

  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const agent = {
    name: "Gemini（新）",
    format: "gemini",
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1beta`,
    model: "gemini-test",
    authType: "none",
  };

  const defaultResponse = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent,
      messages: [{ role: "user", content: "请自然回答。" }],
    }),
  });
  const defaultPayload = await defaultResponse.json();
  assert.equal(defaultResponse.status, 200);
  assert.equal(defaultPayload.text, longReply);
  assert.equal(defaultPayload.finishReason, "stop");
  assert.equal(requestBodies[0].generationConfig.maxOutputTokens, 1200);

  const manualResponse = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent,
      maxTokens: 640,
      messages: [{ role: "user", content: "请自然回答。" }],
    }),
  });
  assert.equal(manualResponse.status, 200);
  assert.equal(requestBodies[1].generationConfig.maxOutputTokens, 640);
});

test("局域网模式要求访问码并签发仅限本站的会话 Cookie", async (context) => {
  const changedSettings = [];
  const server = createAppServer({
    accessCode: "87654321",
    sessionToken: "test-session-token",
    forceAccessCode: true,
    onAccessRequiredChange: async (enabled) => changedSettings.push(enabled),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const initial = await fetch(`${origin}/api/access`);
  assert.deepEqual(await initial.json(), {
    required: true,
    authenticated: false,
    protectionEnabled: true,
  });

  const denied = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(denied.status, 401);

  const wrong = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "00000000" }),
  });
  assert.equal(wrong.status, 401);

  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "87654321" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /^observation_session=test-session-token;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=15552000/);

  const authenticated = await fetch(`${origin}/api/access`, {
    headers: { cookie },
  });
  assert.deepEqual(await authenticated.json(), {
    required: true,
    authenticated: true,
    protectionEnabled: true,
  });

  const disabled = await fetch(`${origin}/api/access`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { ok: true, protectionEnabled: false });
  assert.deepEqual(changedSettings, [false]);

  const openAccess = await fetch(`${origin}/api/access`);
  assert.deepEqual(await openAccess.json(), {
    required: false,
    authenticated: true,
    protectionEnabled: false,
  });

  const enabled = await fetch(`${origin}/api/access`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { ok: true, protectionEnabled: true });
  assert.deepEqual(changedSettings, [false, true]);
});

test("观察室状态可以通过本地接口读取和保存", async (context) => {
  let savedPayload = null;
  const autoSummaryRooms = [];
  const stateStore = {
    async clientState() {
      return { version: 2, agents: [], rooms: [], activeRoomId: "" };
    },
    async save(payload) {
      savedPayload = payload;
      return payload;
    },
    async credentials() {
      return { apiKey: "", extraHeaders: "" };
    },
  };
  const server = createAppServer({
    stateStore,
    summaryJobs: {
      async maybeStart(roomId) { autoSummaryRooms.push(roomId); return null; },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const initial = await fetch(`${origin}/api/state`);
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), {
    version: 2,
    agents: [],
    rooms: [],
    activeRoomId: "",
  });

  const payload = {
    version: 2,
    agents: [{ id: "guest-grok", name: "Grok" }],
    rooms: [{ id: "room-one", name: "新房间", participantIds: ["guest-grok"], messages: [] }],
    activeRoomId: "room-one",
  };
  const saved = await fetch(`${origin}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(savedPayload, payload);
  assert.deepEqual(autoSummaryRooms, ["room-one"]);
});

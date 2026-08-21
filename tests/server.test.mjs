import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { chatRequestPolicy, createAppServer } from "../server.mjs";

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

test("Kimi K3 正式发言有隐藏思考余量但抢麦评分仍保持短输出", () => {
  const agent = {
    format: "openai",
    baseUrl: "https://example.com/v1",
    model: "[乾坤按量]kimi-k3",
  };
  const replyPolicy = chatRequestPolicy(agent, { maxTokens: 480 });
  assert.equal(replyPolicy.upstreamMaxTokens, 8192);
  assert.equal(replyPolicy.thinkingMode, undefined);
  assert.equal(replyPolicy.timeoutMs, 600_000);

  const scorePolicy = chatRequestPolicy(agent, {
    requestMode: "willingness-score",
    maxTokens: 8,
  });
  assert.equal(scorePolicy.upstreamMaxTokens, 8);
  assert.equal(scorePolicy.thinkingMode, undefined);
  assert.equal(scorePolicy.timeoutMs, 30_000);
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
  const server = createAppServer({ stateStore });
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
});

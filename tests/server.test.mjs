import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { chatRequestPolicy, createAppServer } from "../server.mjs";

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
  assert.equal(summaryPolicy.timeoutMs, 300_000);
  assert.equal(summaryPolicy.upstreamMaxTokens, 8192);
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
  const server = createAppServer({
    accessCode: "87654321",
    sessionToken: "test-session-token",
    forceAccessCode: true,
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

  const authenticated = await fetch(`${origin}/api/access`, {
    headers: { cookie },
  });
  assert.deepEqual(await authenticated.json(), {
    required: true,
    authenticated: true,
  });
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

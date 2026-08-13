import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVisitorManager } from "../lib/visitor-mode.mjs";
import { createStateStore } from "../lib/state-store.mjs";
import { createAppServer } from "../server.mjs";

test("访客邀请只保存令牌摘要，并可撤销", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-visitors-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "visitors.json");
  const manager = createVisitorManager({ filePath });

  const created = await manager.create({
    roomId: "room-one",
    type: "human",
    name: "小雨",
    expiresInHours: 2,
  });
  assert.ok(created.token.length > 20);
  assert.equal((await manager.authorize(created.token, "human"))?.name, "小雨");
  assert.equal(await manager.authorize(created.token, "mcp"), null);
  assert.doesNotMatch(await readFile(filePath, "utf8"), new RegExp(created.token));

  assert.equal(await manager.revoke(created.invite.id), true);
  assert.equal(await manager.authorize(created.token, "human"), null);
});

test("人类访客和 MCP 访客只能读取公开消息并能公开发言", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-visitor-server-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const stateStore = createStateStore({
    filePath: join(directory, "state.json"),
    secret: "visitor-test-secret",
  });
  await stateStore.save({
    activeRoomId: "room-one",
    agents: [{ id: "gpt", name: "GPT", format: "openai" }],
    rooms: [{
      id: "room-one",
      name: "测试群",
      roomPrompt: "这是一间轻松但允许认真争论的聊天室。",
      memory: { enabled: true, summary: "大家刚讨论过 AI 是否会主动想念一个人。" },
      participantIds: ["gpt"],
      messages: [
        { id: "public-one", kind: "user", author: "晨曦", text: "公开消息", timestamp: 1 },
        {
          id: "private-one",
          kind: "agent",
          author: "GPT",
          agentId: "gpt",
          text: "私聊秘密",
          privacy: "private",
          recipientIds: ["room-user"],
          timestamp: 2,
        },
      ],
    }],
  });
  const visitorManager = createVisitorManager({ filePath: join(directory, "visitors.json") });
  const server = createAppServer({ stateStore, visitorManager });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const humanCreate = await fetch(`${origin}/api/visitors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: "room-one", type: "human", name: "小雨" }),
  });
  assert.equal(humanCreate.status, 201);
  const humanEndpoint = (await humanCreate.json()).endpoint;
  const humanToken = new URL(humanEndpoint).hash.slice(1);
  const humanPage = await fetch(humanEndpoint);
  assert.equal(humanPage.status, 200);
  assert.match(await humanPage.text(), /访客入席/);

  const sync = await fetch(`${origin}/api/visit/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: humanToken }),
  });
  assert.equal(sync.status, 200);
  const syncPayload = await sync.json();
  assert.deepEqual(syncPayload.room.messages.map((message) => message.text), ["公开消息"]);
  assert.equal(JSON.stringify(syncPayload).includes("私聊秘密"), false);

  const sent = await fetch(`${origin}/api/visit/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: humanToken, text: "朋友来啦" }),
  });
  assert.equal(sent.status, 201);
  assert.equal((await sent.json()).message.source, "visitor");

  const mcpCreate = await fetch(`${origin}/api/visitors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: "room-one", type: "mcp", name: "外援 AI" }),
  });
  assert.equal(mcpCreate.status, 201);
  const mcpPayload = await mcpCreate.json();
  const mcpEndpoint = mcpPayload.endpoint;
  const mcpLanding = await fetch(mcpEndpoint);
  assert.equal(mcpLanding.status, 200);
  assert.match(await mcpLanding.text(), /MCP 入口已经准备好了/);

  const tools = await fetch(mcpEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(tools.status, 200);
  assert.deepEqual((await tools.json()).result.tools.map((tool) => tool.name), [
    "room_info",
    "read_room",
    "set_presence",
    "send_message",
    "send_private_message",
  ]);

  const readRoom = await fetch(mcpEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "read_room", arguments: {} },
    }),
  });
  const readPayload = await readRoom.json();
  assert.equal(readPayload.result.structuredContent.roomPrompt, "这是一间轻松但允许认真争论的聊天室。");
  assert.equal(readPayload.result.structuredContent.longTermSummary, "大家刚讨论过 AI 是否会主动想念一个人。");
  assert.equal(JSON.stringify(readPayload).includes("私聊秘密"), false);

  const away = await fetch(mcpEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "set_presence", arguments: { status: "away", note: "晚点回来" } },
    }),
  });
  const awayPayload = await away.json();
  assert.equal(awayPayload.result.structuredContent.member.status, "away");
  assert.equal(awayPayload.result.structuredContent.member.note, "晚点回来");

  const back = await fetch(mcpEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "set_presence", arguments: { status: "active" } },
    }),
  });
  assert.equal((await back.json()).result.structuredContent.member.status, "active");

  const mcpSend = await fetch(mcpEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "send_message", arguments: { text: "AI 访客报到" } },
    }),
  });
  assert.equal(mcpSend.status, 200);
  assert.equal((await mcpSend.json()).result.structuredContent.message.source, "mcp");

  const mcpPrivate = await fetch(mcpEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "send_private_message", arguments: { to: "gpt", text: "只告诉 GPT" } },
    }),
  });
  assert.equal(mcpPrivate.status, 200);
  const privateMessage = (await mcpPrivate.json()).result.structuredContent.message;
  assert.equal(privateMessage.privacy, "private");
  assert.deepEqual(privateMessage.recipientIds, ["gpt"]);

  const hostState = await stateStore.clientState();
  hostState.rooms[0].messages.push({
    id: "gpt-private-reply",
    kind: "agent",
    author: "GPT",
    agentId: "gpt",
    text: "只回给外援 AI",
    privacy: "private",
    recipientIds: [mcpPayload.invite.id],
    timestamp: Date.now() + 1,
  });
  await stateStore.save(hostState);

  const finalRoom = await stateStore.publicRoomSnapshot("room-one");
  assert.deepEqual(finalRoom.messages.map((message) => message.text), [
    "公开消息",
    "朋友来啦",
    "AI 访客报到",
  ]);
  const mcpRoom = await stateStore.publicRoomSnapshot("room-one", {
    externalViewerId: mcpPayload.invite.id,
    includeContext: true,
  });
  assert.equal(mcpRoom.messages.at(-2).text, "只告诉 GPT");
  assert.equal(mcpRoom.messages.at(-2).privacy, "private");
  assert.equal(mcpRoom.messages.at(-1).text, "只回给外援 AI");
  assert.equal(mcpRoom.messages.at(-1).privacy, "private");
});

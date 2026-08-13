import assert from "node:assert/strict";
import test from "node:test";

import {
  activeRoomAgents,
  roomMembers,
  roomPresenceContext,
} from "../public/room-presence.js";

const agents = [
  { id: "gpt", name: "GPT" },
  { id: "claude", name: "Claude" },
];

test("旧房间会把 participantIds 自动迁移为在席成员", () => {
  const room = { participantIds: ["gpt"], createdAt: 100 };
  assert.deepEqual(roomMembers(room, agents).map(({ id, name, status }) => ({ id, name, status })), [
    { id: "gpt", name: "GPT", status: "active" },
  ]);
});

test("暂离席保留座位和门牌，但不会再参加发言", () => {
  const room = {
    participantIds: ["gpt", "claude"],
    members: [
      { id: "gpt", name: "GPT", type: "agent", status: "active", joinedAt: 1, statusChangedAt: 1 },
      { id: "claude", name: "Claude", type: "agent", status: "away", note: "去写一份报告", joinedAt: 1, statusChangedAt: 2 },
      { id: "old", name: "旧访客", type: "mcp", status: "left", note: "不会回来了", joinedAt: 1, statusChangedAt: 3 },
    ],
  };
  assert.deepEqual(activeRoomAgents(room, agents).map((agent) => agent.id), ["gpt"]);
  const context = roomPresenceContext(room, agents);
  assert.match(context, /在席：GPT/);
  assert.match(context, /暂离席：Claude（挂牌：去写一份报告）/);
  assert.match(context, /已离开：旧访客（挂牌：不会回来了）/);
  assert.match(context, /不要擅自推断原因/);
});

test("旧记录里的 MCP 与已移除嘉宾会自动补进成员簿", () => {
  const room = {
    createdAt: 1,
    participantIds: ["gpt"],
    messages: [
      { kind: "agent", agentId: "gpt", author: "GPT", timestamp: 10 },
      { kind: "agent", agentId: "visitor-old", externalId: "visitor-old", source: "mcp", author: "阿砚", timestamp: 20 },
      { kind: "agent", agentId: "removed", author: "旧嘉宾", timestamp: 30 },
    ],
  };
  const members = roomMembers(room, agents);
  assert.equal(members.find((member) => member.id === "visitor-old")?.status, "away");
  assert.equal(members.find((member) => member.id === "visitor-old")?.name, "阿砚");
  assert.equal(members.find((member) => member.id === "removed")?.status, "left");
  assert.equal(members.find((member) => member.id === "gpt")?.lastSeenAt, 10);
});

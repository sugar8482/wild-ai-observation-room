import assert from "node:assert/strict";
import test from "node:test";
import { isQuietTime, nextQuietEnd, runScheduledRoom } from "../lib/scheduled-chat.mjs";

function roomFixture(maxTurns = 3) {
  return {
    id: "room-timer",
    name: "竹马群",
    roomPrompt: "像熟人群聊一样自然接话。",
    bubbleSplit: false,
    participantIds: ["guest-a", "guest-b"],
    messages: [{
      id: "message-user",
      kind: "user",
      author: "晨曦",
      text: "我先离开一会儿。",
      timestamp: 1,
    }],
    memory: { enabled: true, recentMessages: 30, summary: "", stale: false },
    schedule: { maxTurns },
  };
}

const agents = [
  { id: "guest-a", name: "A", format: "openai", baseUrl: "https://a.example/v1", model: "a", authType: "none", persona: "" },
  { id: "guest-b", name: "B", format: "openai", baseUrl: "https://b.example/v1", model: "b", authType: "none", persona: "" },
];

test("跨零点的免打扰时段可以正确延后", () => {
  const schedule = { quietEnabled: true, quietStart: "23:00", quietEnd: "08:00" };
  const late = new Date(2026, 7, 6, 23, 30);
  const early = new Date(2026, 7, 7, 7, 30);
  const daytime = new Date(2026, 7, 7, 10, 0);
  assert.equal(isQuietTime(schedule, late), true);
  assert.equal(isQuietTime(schedule, early), true);
  assert.equal(isQuietTime(schedule, daytime), false);
  assert.equal(new Date(nextQuietEnd(schedule, late)).getHours(), 8);
});

test("定时唤醒会连续抢麦，全员弃权后立即收场", async () => {
  const scorePlan = new Map([
    ["guest-a", [8, 2, 0]],
    ["guest-b", [2, 9, 0]],
  ]);
  const scoreIndex = new Map();
  let replyCalls = 0;
  const chat = async (payload) => {
    if (payload.requestMode === "willingness-score") {
      const index = scoreIndex.get(payload.agent.id) || 0;
      scoreIndex.set(payload.agent.id, index + 1);
      assert.match(payload.messages[0].content, /用户没有刚刚发新消息/);
      return { text: String(scorePlan.get(payload.agent.id)[index]) };
    }
    replyCalls += 1;
    assert.match(payload.messages[1].content, /不要假装用户刚说了什么/);
    return { text: payload.agent.id === "guest-a" ? "B，你还记得那件事吗？" : "记得，你居然现在提起来。" };
  };

  const outcome = await runScheduledRoom({
    room: roomFixture(3),
    agents,
    chat,
    random: () => 0,
    at: 100,
  });
  assert.equal(replyCalls, 2);
  assert.deepEqual(outcome.messages.map((message) => message.author), ["A", "B"]);
  assert.equal(outcome.messages.every((message) => message.source === "scheduled"), true);
  assert.match(outcome.result, /全员弃权收场/);
});

test("第一轮全员弃权时不会生成硬凑的聊天", async () => {
  let replyCalls = 0;
  const outcome = await runScheduledRoom({
    room: roomFixture(4),
    agents,
    chat: async (payload) => {
      if (payload.requestMode === "willingness-score") return { text: "1" };
      replyCalls += 1;
      return { text: "不该出现" };
    },
  });
  assert.equal(replyCalls, 0);
  assert.deepEqual(outcome.messages, []);
  assert.match(outcome.result, /全员弃权/);
});

test("定时聊天也会按房间设置保存连续气泡", async () => {
  const room = roomFixture(1);
  room.bubbleSplit = true;
  const outcome = await runScheduledRoom({
    room,
    agents,
    random: () => 0,
    chat: async (payload) => {
      if (payload.requestMode === "willingness-score") return { text: payload.agent.id === "guest-a" ? "9" : "0" };
      assert.match(payload.messages[0].content, /聊天软件式的连续气泡/);
      return { text: "你们人呢？〔分条〕算了，我先写作业。" };
    },
  });
  assert.equal(outcome.messages.length, 1);
  assert.equal(outcome.messages[0].text, "你们人呢？\n算了，我先写作业。");
  assert.deepEqual(outcome.messages[0].segments, ["你们人呢？", "算了，我先写作业。"]);
});

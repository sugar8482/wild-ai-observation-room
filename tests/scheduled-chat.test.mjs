import assert from "node:assert/strict";
import test from "node:test";
import {
  isQuietTime,
  maybeSummarizeRoom,
  nextQuietEnd,
  runScheduledRoom,
} from "../lib/scheduled-chat.mjs";

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

test("自动整理逐批重写同一份摘要并保存真实消息计数", async () => {
  const room = roomFixture(1);
  room.messages = Array.from({ length: 10 }, (_, index) => ({
    id: `message-${index + 1}`,
    kind: "user",
    author: "晨曦",
    text: `第 ${index + 1} 条`,
    timestamp: index + 1,
  }));
  room.memory = {
    enabled: true,
    interval: 5,
    recentMessages: 30,
    summary: "旧摘要",
    summarizedThroughId: "",
    summarizedMessageCount: 0,
    updatedAt: null,
    stale: false,
  };
  const state = {
    rooms: [room],
    summarizer: {
      id: "memory-summarizer",
      baseUrl: "https://summary.example/v1",
      model: "summary-model",
      authType: "none",
    },
  };
  const saves = [];
  const requests = [];
  const stateStore = {
    async clientState() { return structuredClone(state); },
    async completeRoomSummary(roomId, update) {
      const current = state.rooms.find((item) => item.id === roomId);
      Object.assign(current.memory, {
        summary: update.summary,
        summarizedThroughId: update.summarizedThroughId,
        summarizedMessageCount: update.summarizedMessageCount,
        updatedAt: update.at,
      });
      saves.push(structuredClone(update));
      return true;
    },
  };

  const completed = await maybeSummarizeRoom(stateStore, async (payload) => {
    requests.push(structuredClone(payload));
    return { text: `滚动摘要 ${requests.length}` };
  }, room.id);

  assert.equal(completed, true);
  assert.equal(saves.length, 2);
  assert.equal(saves[0].summarizedMessageCount, 5);
  assert.equal(saves[1].summarizedMessageCount, 10);
  assert.equal(state.rooms[0].memory.summary, "滚动摘要 2");
  assert.match(requests[1].messages[1].content, /已有工作摘要：\n滚动摘要 1/);
  assert.equal(requests[0].maxTokens, 4096);
});

test("自动整理不会继续推进旧版截断总结", async () => {
  const room = roomFixture(1);
  room.memory = {
    enabled: true,
    interval: 5,
    summary: "旧".repeat(49_993),
    summarizedThroughId: "",
    summarizedMessageCount: 500,
    stale: false,
  };
  let calls = 0;
  const completed = await maybeSummarizeRoom({
    async clientState() {
      return {
        rooms: [room],
        summarizer: { baseUrl: "https://summary.example/v1", model: "summary", authType: "none" },
      };
    },
  }, async () => {
    calls += 1;
    return { text: "不应调用" };
  }, room.id);

  assert.equal(completed, false);
  assert.equal(calls, 0);
});

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

test("暂离席嘉宾不会参与后台抢麦，但仍保留在房间成员簿", async () => {
  const room = roomFixture(1);
  room.members = [
    { id: "guest-a", name: "A", type: "agent", status: "away", note: "休息一下", joinedAt: 1, statusChangedAt: 2 },
    { id: "guest-b", name: "B", type: "agent", status: "active", note: "", joinedAt: 1, statusChangedAt: 1 },
  ];
  const called = [];
  const outcome = await runScheduledRoom({
    room,
    agents,
    random: () => 0,
    chat: async (payload) => {
      called.push(payload.agent.id);
      if (payload.requestMode === "willingness-score") return { text: "0" };
      return { text: "不会执行" };
    },
  });
  assert.deepEqual(called, ["guest-b"]);
  assert.equal(outcome.messages.length, 0);
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
      assert.match(payload.messages[0].content, /当前时间：1970年1月1日/);
      assert.match(payload.messages[0].content, /群聊不必围着用户进行/);
      assert.match(payload.messages[0].content, /不要据此认定用户迟到、旷课、失约/);
      assert.match(payload.messages[1].content, /\[1970年1月1日/);
      return { text: String(scorePlan.get(payload.agent.id)[index]) };
    }
    replyCalls += 1;
    assert.match(payload.messages[1].content, /不要假装用户刚说了什么/);
    assert.match(payload.messages[1].content, /只和其他嘉宾聊天/);
    assert.doesNotMatch(payload.messages[0].content, /低信息、没营养、突然中断/);
    assert.equal(payload.maxTokens, 1200);
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
  assert.deepEqual(outcome.mic.scoreHistory["guest-a"], [8, 2, 0]);
  assert.deepEqual(outcome.mic.scoreHistory["guest-b"], [2, 9, 0]);
  assert.equal(outcome.mic.revision, 3);
  assert.match(outcome.result, /全员弃权收场/);
});

test("定时唤醒会告知真实时间和距上次发言的时长", async () => {
  const lastMessageAt = new Date(2026, 7, 7, 1, 0).getTime();
  const wakeAt = new Date(2026, 7, 7, 7, 45).getTime();
  const room = roomFixture(1);
  room.messages[0].timestamp = lastMessageAt;
  let checkedReply = false;
  const outcome = await runScheduledRoom({
    room,
    agents,
    at: wakeAt,
    random: () => 0,
    chat: async (payload) => {
      if (payload.requestMode === "willingness-score") {
        assert.match(payload.messages[0].content, /2026年8月7日 星期五 07:45/);
        assert.match(payload.messages[0].content, /6 小时 45 分钟/);
        return { text: payload.agent.id === "guest-a" ? "9" : "0" };
      }
      assert.match(payload.messages[0].content, /2026年8月7日 星期五 07:45/);
      assert.match(payload.messages[1].content, /用户没有刚刚发新消息/);
      assert.match(payload.messages[0].content, /不代表虚构世界必须与现实严格同步/);
      checkedReply = true;
      return { text: "B，醒了吗？" };
    },
  });
  assert.equal(checkedReply, true);
  assert.equal(outcome.messages.length, 1);
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
      assert.match(payload.messages[0].content, /低信息、没营养、突然中断/);
      assert.match(payload.messages[0].content, /无需逐条回应上一位的所有内容/);
      assert.match(payload.messages[0].content, /不要每次都点名用户/);
      assert.equal(payload.maxTokens, 180);
      return { text: "你们人呢？〔分条〕算了，我先写作业。" };
    },
  });
  assert.equal(outcome.messages.length, 1);
  assert.equal(outcome.messages[0].text, "你们人呢？\n算了，我先写作业。");
  assert.deepEqual(outcome.messages[0].segments, ["你们人呢？", "算了，我先写作业。"]);
});

test("定时聊天用同一次回复提取角色私人记忆", async () => {
  const room = roomFixture(1);
  const memoryAgents = agents.map((agent, index) => ({
    ...agent,
    memoryEnabled: index === 0,
    memory: index === 0 ? "- 我记得晨曦说她会回来。" : "",
  }));
  const outcome = await runScheduledRoom({
    room,
    agents: memoryAgents,
    random: () => 0,
    at: new Date(2026, 7, 7, 9, 0).getTime(),
    chat: async (payload) => {
      if (payload.requestMode === "willingness-score") {
        if (payload.agent.id === "guest-a") {
          assert.match(payload.messages[0].content, /只属于“A”的角色私人记忆/);
          return { text: "9" };
        }
        assert.doesNotMatch(payload.messages[0].content, /角色私人记忆/);
        return { text: "0" };
      }
      assert.equal(payload.maxTokens, 1380);
      assert.match(payload.messages[0].content, /<self_memory>/);
      return {
        text: "B，你今天怎么这么安静？\n<self_memory>\n- 我有点在意B一直没说话。\n</self_memory>",
      };
    },
  });
  assert.equal(outcome.messages[0].text, "B，你今天怎么这么安静？");
  assert.deepEqual(outcome.privateMemoryItems["guest-a"], ["我有点在意B一直没说话。"]);
});

test("定时私聊只进入发送者与收件人的后续上下文", async () => {
  const room = roomFixture(2);
  room.participantIds.push("guest-c");
  const privateAgents = [
    ...agents,
    { id: "guest-c", name: "C", format: "openai", baseUrl: "https://c.example/v1", model: "c", authType: "none", persona: "" },
  ];
  const scoreIndex = new Map();
  const chat = async (payload) => {
    if (payload.requestMode === "willingness-score") {
      const index = scoreIndex.get(payload.agent.id) || 0;
      scoreIndex.set(payload.agent.id, index + 1);
      if (index === 1 && payload.agent.id === "guest-b") {
        assert.match(payload.messages[1].content, /【A 私聊给你】今晚看旧仓库/);
      }
      if (index === 1 && payload.agent.id === "guest-c") {
        assert.doesNotMatch(payload.messages[1].content, /今晚看旧仓库|私聊/);
      }
      if (index === 0) return { text: payload.agent.id === "guest-a" ? "9" : "0" };
      return { text: payload.agent.id === "guest-b" ? "9" : "0" };
    }
    if (payload.agent.id === "guest-a") {
      assert.match(payload.messages[0].content, /to="guest-b"（B）/);
      return { text: '<private_message to="guest-b">今晚看旧仓库</private_message>' };
    }
    assert.match(payload.messages[1].content, /【A 私聊给你】今晚看旧仓库/);
    return { text: "行，我知道了。" };
  };

  const outcome = await runScheduledRoom({ room, agents: privateAgents, chat, random: () => 0, at: 100 });
  assert.equal(outcome.messages.length, 2);
  assert.equal(outcome.messages[0].privacy, "private");
  assert.deepEqual(outcome.messages[0].recipientIds, ["guest-b"]);
  assert.equal(outcome.messages[1].privacy, undefined);
});

test("轻量定时抢麦不调用意愿评分，并可用一张不强制发生的生活事件卡", async () => {
  const room = roomFixture(1);
  room.schedule.strategy = "light-mic";
  room.eventCards = { enabled: true, focus: "只写架空古代客栈里的日常，不出现学校。", recentIds: [], revision: 0 };
  let scoreCalls = 0;
  let replyCalls = 0;
  const randomValues = [0, 0.9, 0];
  const outcome = await runScheduledRoom({
    room,
    agents,
    random: () => randomValues.shift() ?? 0.5,
    at: new Date(2026, 7, 8, 10, 0).getTime(),
    chat: async (payload) => {
      if (payload.requestMode === "willingness-score") scoreCalls += 1;
      replyCalls += 1;
      assert.match(payload.messages[0].content, /谈资卡，不是已经发生的事实/);
      assert.match(payload.messages[0].content, /只写架空古代客栈里的日常，不出现学校/);
      assert.match(payload.messages[0].content, /不得替用户决定行程、位置、健康、迟到、失踪/);
      assert.match(payload.messages[1].content, /本地轻量轮候/);
      return { text: "B，学校刚来了个临时通知，你看了吗？" };
    },
  });
  assert.equal(scoreCalls, 0);
  assert.equal(replyCalls, 1);
  assert.equal(outcome.messages.length, 1);
  assert.equal(outcome.mic, null);
  assert.equal(outcome.eventCards.revision, 1);
  assert.equal(outcome.eventCards.recentIds.length, 1);
});

import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";

import { createRoomSummaryJobs } from "../lib/room-summary-jobs.mjs";

function fixture({ chat } = {}) {
  let clock = 1000;
  const checkpoints = [];
  const requests = [];
  const state = {
    summarizer: {
      id: "memory-summarizer",
      baseUrl: "https://summary.example/v1",
      model: "summary-model",
      authType: "none",
    },
    rooms: [{
      id: "room-one",
      name: "测试房间",
      messages: Array.from({ length: 7 }, (_, index) => ({
        id: `message-${index + 1}`,
        kind: "user",
        author: "晨曦",
        text: `第 ${index + 1} 条消息`,
      })),
      memory: {
        enabled: true,
        interval: 5,
        recentMessages: 30,
        focus: "",
        summary: "",
        summarizedThroughId: "",
        summarizedMessageCount: 0,
        updatedAt: null,
        stale: false,
      },
    }],
  };
  const stateStore = {
    async clientState() {
      return structuredClone(state);
    },
    async completeRoomSummary(roomId, update) {
      const room = state.rooms.find((item) => item.id === roomId);
      if (!room) return false;
      if ((room.memory.summarizedThroughId || "") !== (update.expectedPreviousMarker || "")) return false;
      if ((Number(room.memory.updatedAt) || 0) !== (Number(update.expectedPreviousUpdatedAt) || 0)) return false;
      Object.assign(room.memory, {
        summary: update.summary,
        summarizedThroughId: update.summarizedThroughId,
        summarizedMessageCount: update.summarizedMessageCount,
        updatedAt: update.at,
        stale: false,
      });
      checkpoints.push(structuredClone(update));
      return true;
    },
  };
  const jobs = createRoomSummaryJobs({
    stateStore,
    chat: async (...args) => {
      requests.push(structuredClone(args[0]));
      return chat ? chat(...args) : { text: `批次摘要 ${requests.length}` };
    },
    now: () => ++clock,
    createId: () => "test-job",
  });
  return { jobs, state, checkpoints, requests };
}

async function waitForTerminal(jobs, id) {
  for (let index = 0; index < 100; index += 1) {
    const job = jobs.get(id);
    if (["completed", "cancelled", "error"].includes(job?.status)) return job;
    await waitForImmediate();
  }
  throw new Error("后台总结任务没有结束");
}

test("后台总结会逐批存档，并让后一批重写同一份客观摘要", async () => {
  const { jobs, state, checkpoints, requests } = fixture();
  const accepted = await jobs.start({ roomId: "room-one" });

  assert.equal(accepted.id, "summary-test-job");
  assert.equal(["queued", "running"].includes(accepted.status), true);

  const completed = await waitForTerminal(jobs, accepted.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.processedMessages, 7);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0].summarizedThroughId, "message-5");
  assert.equal(checkpoints[1].summarizedThroughId, "message-7");
  assert.equal(state.rooms[0].memory.summary, "批次摘要 2");
  assert.match(requests[1].messages[1].content, /已有工作摘要：\n批次摘要 1/);
  assert.equal(requests[0].maxTokens, 4096);
});

test("自动总结只吃完整批次，立即总结再从锚点接走剩余楼层", async () => {
  const automatic = fixture();
  const accepted = await automatic.jobs.start({ roomId: "room-one", automatic: true });
  assert.equal(accepted.automatic, true);
  const completed = await waitForTerminal(automatic.jobs, accepted.id);
  assert.equal(completed.processedMessages, 5);
  assert.equal(automatic.checkpoints.length, 1);
  assert.equal(automatic.checkpoints[0].summarizedThroughId, "message-5");

  const immediate = await automatic.jobs.start({ roomId: "room-one" });
  const immediateCompleted = await waitForTerminal(automatic.jobs, immediate.id);
  assert.equal(immediateCompleted.processedMessages, 2);
  assert.equal(automatic.checkpoints.length, 2);
  assert.equal(automatic.checkpoints[1].summarizedThroughId, "message-7");
});

test("自动总结不足完整批次时不建立空任务", async () => {
  const { jobs, state, checkpoints } = fixture();
  state.rooms[0].messages = state.rooms[0].messages.slice(0, 4);
  assert.equal(await jobs.maybeStart("room-one"), null);
  assert.equal(jobs.list({ roomId: "room-one" }).length, 0);
  assert.equal(checkpoints.length, 0);
});

test("旧楼层被删除后不强制重建，并从保存的计数继续整理", async () => {
  const { jobs, state, checkpoints } = fixture();
  state.rooms[0].memory.summary = "已有摘要";
  state.rooms[0].memory.summarizedThroughId = "message-deleted";
  state.rooms[0].memory.summarizedMessageCount = 5;
  state.rooms[0].memory.stale = true;

  const accepted = await jobs.start({ roomId: "room-one" });
  const completed = await waitForTerminal(jobs, accepted.id);

  assert.equal(completed.status, "completed");
  assert.equal(completed.processedMessages, 2);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].expectedPreviousMarker, "message-deleted");
  assert.equal(checkpoints[0].summarizedThroughId, "message-7");
});

test("旧版五万字截断总结拒绝继续推进锚点并要求全篇重建", async () => {
  const { jobs, state, checkpoints } = fixture();
  state.rooms[0].memory.summary = "旧".repeat(49_993);
  state.rooms[0].memory.summarizedMessageCount = 500;

  await assert.rejects(
    jobs.start({ roomId: "room-one" }),
    /旧版长期总结已在保存上限处截断，请使用重新生成/,
  );
  assert.equal(checkpoints.length, 0);
});

test("后台总结接收任务时不会等待慢模型返回", async () => {
  let releaseChat;
  let chatStarted = false;
  const deferred = new Promise((resolve) => { releaseChat = resolve; });
  const { jobs } = fixture({
    chat: async () => {
      chatStarted = true;
      await deferred;
      return { text: "慢模型终于返回" };
    },
  });

  const accepted = await jobs.start({ roomId: "room-one" });
  assert.equal(accepted.id, "summary-test-job");
  for (let index = 0; index < 20 && !chatStarted; index += 1) await waitForImmediate();
  assert.equal(chatStarted, true);
  assert.equal(jobs.isActive("room-one"), true);

  releaseChat();
  const completed = await waitForTerminal(jobs, accepted.id);
  assert.equal(completed.status, "completed");
});

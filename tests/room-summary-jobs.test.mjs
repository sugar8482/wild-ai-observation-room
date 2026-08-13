import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";

import { createRoomSummaryJobs } from "../lib/room-summary-jobs.mjs";

function fixture({ chat } = {}) {
  let clock = 1000;
  const checkpoints = [];
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
    chat: chat || (async () => ({ text: `批次摘要 ${checkpoints.length + 1}` })),
    now: () => ++clock,
    createId: () => "test-job",
  });
  return { jobs, state, checkpoints };
}

async function waitForTerminal(jobs, id) {
  for (let index = 0; index < 100; index += 1) {
    const job = jobs.get(id);
    if (["completed", "cancelled", "error"].includes(job?.status)) return job;
    await waitForImmediate();
  }
  throw new Error("后台总结任务没有结束");
}

test("后台总结会逐批存档，页面请求返回后仍继续运行", async () => {
  const { jobs, state, checkpoints } = fixture();
  const accepted = await jobs.start({ roomId: "room-one" });

  assert.equal(accepted.id, "summary-test-job");
  assert.equal(["queued", "running"].includes(accepted.status), true);

  const completed = await waitForTerminal(jobs, accepted.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.processedMessages, 7);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0].summarizedThroughId, "message-5");
  assert.equal(checkpoints[1].summarizedThroughId, "message-7");
  assert.match(state.rooms[0].memory.summary, /批次摘要 1/);
  assert.match(state.rooms[0].memory.summary, /批次摘要 2/);
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

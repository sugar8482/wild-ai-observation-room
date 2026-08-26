import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppendSummaryMessages,
  buildRebuildSectionMessages,
  completeAutomaticSummaryBatch,
  isLegacyTruncatedRoomSummary,
} from "../public/memory-prompt.js";

const room = {
  name: "竹马群",
  memory: { focus: "保留共同经历和仍未回答的问题" },
};

const messages = [
  { kind: "user", author: "晨曦", text: "你们还记得那件事吗？", timestamp: Date.UTC(2026, 7, 7, 1, 0) },
  { kind: "agent", author: "谢知衡", text: "记得。", timestamp: Date.UTC(2026, 7, 7, 1, 1) },
];

test("追加整理把旧摘要和新原文合成一份客观事实索引", () => {
  const prompt = buildAppendSummaryMessages(room, messages, "晨曦已经决定周末见面。");
  assert.match(prompt[0].content, /输出合并、去重、更新后的完整工作摘要/);
  assert.match(prompt[0].content, /直接替换旧摘要，不要只输出新增片段/);
  assert.match(prompt[0].content, /保留共同经历和仍未回答的问题/);
  assert.match(prompt[0].content, /不要逐个点名复述每位嘉宾的比喻、吐槽、附和和文风/);
  assert.match(prompt[0].content, /不要模仿原聊天或旧总结的修辞口吻/);
  assert.match(prompt[1].content, /已有工作摘要：\n晨曦已经决定周末见面/);
  assert.match(prompt[1].content, /本批新增聊天原文/);
  assert.match(prompt[1].content, /【用户原话｜晨曦】：你们还记得那件事吗？/);
  assert.match(prompt[1].content, /谢知衡：记得。/);
});

test("全篇重建逐批更新同一份摘要而不是拼接时间片段", () => {
  const sectionPrompt = buildRebuildSectionMessages(room, messages, "上一批已经确认一项事实。");
  assert.match(sectionPrompt[1].content, /本批现存聊天原文/);
  assert.match(sectionPrompt[1].content, /上一批已经确认一项事实/);
  assert.match(sectionPrompt[0].content, /同一事实只保留一处/);
  assert.match(sectionPrompt[0].content, /稳定事实、近期进展、未决事项/);
  assert.match(sectionPrompt[0].content, /约 1800～3200 个简体中文字/);
});

test("自动整理只取完整批次并把零头留到下一批", () => {
  const pending = Array.from({ length: 41 }, (_, index) => ({ id: `message-${index + 1}` }));
  assert.equal(completeAutomaticSummaryBatch(pending.slice(0, 19), 20).length, 0);
  assert.equal(completeAutomaticSummaryBatch(pending.slice(0, 21), 20).length, 20);
  assert.equal(completeAutomaticSummaryBatch(pending, 20).length, 40);
  assert.equal(completeAutomaticSummaryBatch(pending, 20).at(-1).id, "message-40");
});

test("整理提示不会把条件和猜测升级成事实", () => {
  const prompt = buildAppendSummaryMessages(room, messages.slice(0, 1));
  assert.match(prompt[0].content, /条件或推测意味的内容/);
  assert.match(prompt[0].content, /绝不能升级成已经确认的事实/);
  assert.match(prompt[0].content, /上限而非写作目标，不要凑字数/);
});

test("能识别旧版五万字截断状态而不误伤普通长摘要", () => {
  assert.equal(isLegacyTruncatedRoomSummary({
    summary: "旧".repeat(49_993),
    summarizedMessageCount: 500,
  }), true);
  assert.equal(isLegacyTruncatedRoomSummary({
    summary: "新".repeat(49_993),
    summarizedMessageCount: 499,
  }), false);
  assert.equal(isLegacyTruncatedRoomSummary({
    summary: "新".repeat(60_000),
    summarizedMessageCount: 700,
  }), false);
});

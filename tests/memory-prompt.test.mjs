import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppendSummaryMessages,
  buildRebuildOverviewMessages,
  buildRebuildSectionMessages,
  formatMemorySegment,
} from "../public/memory-prompt.js";

const room = {
  name: "竹马群",
  memory: { focus: "保留共同经历和仍未回答的问题" },
};

const messages = [
  { author: "晨曦", text: "你们还记得那件事吗？", timestamp: Date.UTC(2026, 7, 7, 1, 0) },
  { author: "谢知衡", text: "记得。", timestamp: Date.UTC(2026, 7, 7, 1, 1) },
];

test("追加整理只读取本批原文，不要求重写旧总结", () => {
  const prompt = buildAppendSummaryMessages(room, messages);
  assert.match(prompt[0].content, /独立的记忆片段/);
  assert.match(prompt[0].content, /不要重写、压缩或评价此前的长期记忆/);
  assert.match(prompt[0].content, /保留共同经历和仍未回答的问题/);
  assert.match(prompt[1].content, /本批新增聊天原文/);
  assert.doesNotMatch(prompt[1].content, /现有长期总结/);
});

test("全篇重建先细读现存原文，再把旧总结作为非权威线索", () => {
  const sectionPrompt = buildRebuildSectionMessages(room, messages);
  assert.match(sectionPrompt[0].content, /全篇重建中的分段阅读/);
  assert.match(sectionPrompt[1].content, /本段现存聊天原文/);

  const overviewPrompt = buildRebuildOverviewMessages(
    room,
    "旧总结线索",
    ["第一段现存记录", "第二段现存记录"],
    messages.slice(-1),
  );
  assert.match(overviewPrompt[0].content, /目标约 1600 至 2800 个中文字/);
  assert.match(overviewPrompt[0].content, /已经删除、无法核对或与现存记录冲突的内容必须舍弃/);
  assert.match(overviewPrompt[1].content, /旧总结线索/);
  assert.match(overviewPrompt[1].content, /第一段现存记录/);
  assert.match(overviewPrompt[1].content, /最近原文校对/);
});

test("记忆片段带消息范围且保留模型正文", () => {
  const segment = formatMemorySegment(messages, "这一段发生了两件事。", 21, 22);
  assert.match(segment, /^## 记忆片段 · 第 21–22 条/);
  assert.match(segment, /这一段发生了两件事。$/);
});

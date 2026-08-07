import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppendSummaryMessages,
  buildRebuildSectionMessages,
  formatMemorySegment,
} from "../public/memory-prompt.js";

const room = {
  name: "竹马群",
  memory: { focus: "保留共同经历和仍未回答的问题" },
};

const messages = [
  { kind: "user", author: "晨曦", text: "你们还记得那件事吗？", timestamp: Date.UTC(2026, 7, 7, 1, 0) },
  { kind: "agent", author: "谢知衡", text: "记得。", timestamp: Date.UTC(2026, 7, 7, 1, 1) },
];

test("追加整理只读取本批原文，不要求重写旧总结", () => {
  const prompt = buildAppendSummaryMessages(room, messages);
  assert.match(prompt[0].content, /独立的时间记录片段/);
  assert.match(prompt[0].content, /不要重写、压缩或评价此前的长期记忆/);
  assert.match(prompt[0].content, /保留共同经历和仍未回答的问题/);
  assert.match(prompt[0].content, /用户原话较短时尽量完整引用/);
  assert.match(prompt[1].content, /本批新增聊天原文/);
  assert.match(prompt[1].content, /【用户原话｜晨曦】：你们还记得那件事吗？/);
  assert.match(prompt[1].content, /谢知衡：记得。/);
  assert.doesNotMatch(prompt[1].content, /现有长期总结/);
});

test("全篇重建按时间分段且明确禁止重复归类", () => {
  const sectionPrompt = buildRebuildSectionMessages(room, messages);
  assert.match(sectionPrompt[0].content, /全篇重建中的分段阅读/);
  assert.match(sectionPrompt[1].content, /本段现存聊天原文/);
  assert.match(sectionPrompt[0].content, /不会再生成另一份总概括/);
  assert.match(sectionPrompt[0].content, /同一事实只能出现一次/);
  assert.match(sectionPrompt[0].content, /不要另设重要事实、总概括、关系、性格、梗或待办栏目/);
  assert.match(sectionPrompt[0].content, /整间房不设固定总字数/);
});

test("记忆片段带消息范围且保留模型正文", () => {
  const segment = formatMemorySegment(messages, "这一段发生了两件事。", 21, 22);
  assert.match(segment, /^## 记忆片段 · 第 21–22 条/);
  assert.match(segment, /这一段发生了两件事。$/);
});

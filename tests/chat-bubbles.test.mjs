import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_BUBBLE_SEPARATOR,
  bubbleSplitInstruction,
  formatChatBubbleReply,
  parseChatBubbleSegments,
} from "../public/chat-bubbles.js";

test("只有明确分隔符会拆成连续气泡", () => {
  assert.deepEqual(
    parseChatBubbleSegments(`到家了吗？${CHAT_BUBBLE_SEPARATOR}给群里回一声。`),
    ["到家了吗？", "给群里回一声。"],
  );
  assert.deepEqual(parseChatBubbleSegments("第一段\n\n第二段"), ["第一段\n\n第二段"]);
});

test("连续气泡最多三条，空段会被忽略", () => {
  assert.deepEqual(
    parseChatBubbleSegments(`一${CHAT_BUBBLE_SEPARATOR} ${CHAT_BUBBLE_SEPARATOR}二${CHAT_BUBBLE_SEPARATOR}三${CHAT_BUBBLE_SEPARATOR}四`),
    ["一", "二", "三 四"],
  );
});

test("启用后清理分隔符并保留一条上下文文本", () => {
  const formatted = formatChatBubbleReply(`等等${CHAT_BUBBLE_SEPARATOR}我也去。`, true);
  assert.equal(formatted.text, "等等\n我也去。");
  assert.deepEqual(formatted.segments, ["等等", "我也去。"]);
  assert.match(bubbleSplitInstruction(true), /1 至 3 条短消息/);
  assert.equal(bubbleSplitInstruction(false), "");
});

test("关闭时保持模型原文，不做隐式切分", () => {
  const source = `等等${CHAT_BUBBLE_SEPARATOR}我也去。`;
  assert.deepEqual(formatChatBubbleReply(source, false), { text: source, segments: [] });
});

import assert from "node:assert/strict";
import test from "node:test";
import { formatChatBubbleReply } from "../public/chat-bubbles.js";
import { parsePrivateMessageReply } from "../public/private-messages.js";
import {
  DEFAULT_VISIBLE_REPLY_TOKENS,
  VISIBLE_REPLY_LIMIT_VERSION,
  clampVisibleReplyTokens,
  replyLengthNotice,
  resolveStoredVisibleReplyTokens,
} from "../public/reply-limits.js";

test("普通回复默认上限迁移到 1200 且保留新版手动值", () => {
  assert.equal(DEFAULT_VISIBLE_REPLY_TOKENS, 1200);
  assert.equal(resolveStoredVisibleReplyTokens({}), 1200);
  assert.equal(resolveStoredVisibleReplyTokens({ visibleTokenTarget: 300 }), 1200);
  assert.equal(resolveStoredVisibleReplyTokens({ visibleTokenTarget: 640 }), 640);
  assert.equal(resolveStoredVisibleReplyTokens({
    visibleTokenTarget: 300,
    visibleTokenLimitVersion: VISIBLE_REPLY_LIMIT_VERSION,
  }), 300);
  assert.equal(clampVisibleReplyTokens(9000), 4096);
});

test("超过旧 300 且低于新 1200 的普通正文会完整显示且不产生截断提示", () => {
  const text = Array.from({ length: 640 }, () => "hello").join(" ");
  const parsed = parsePrivateMessageReply(text);
  const displayed = formatChatBubbleReply(parsed.publicText, false);

  assert.equal(displayed.text, text);
  assert.equal(displayed.segments.length, 0);
  assert.equal(replyLengthNotice("Gemini（新）", "stop"), null);
  assert.match(replyLengthNotice("Gemini（新）", "length"), /达到了单次回复上限/);
});

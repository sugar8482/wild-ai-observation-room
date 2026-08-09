import assert from "node:assert/strict";
import test from "node:test";
import {
  ROOM_USER_ID,
  formatMessageForAgent,
  isAgentToAgentPrivateMessage,
  messageVisibleToAgent,
  parsePrivateMessageReply,
  privateMessageOutputInstruction,
  publicRoomMessages,
  visibleMessagesForAgent,
} from "../public/private-messages.js";

const agents = [
  { id: "guest-a", name: "A" },
  { id: "guest-b", name: "B" },
  { id: "guest-c", name: "C" },
];

test("私聊只对发送者和收件嘉宾可见，房主仍可在页面读取原文", () => {
  const message = {
    kind: "agent",
    author: "A",
    text: "今晚投C。",
    agentId: "guest-a",
    privacy: "private",
    recipientIds: ["guest-b"],
  };
  assert.equal(messageVisibleToAgent(message, "guest-a"), true);
  assert.equal(messageVisibleToAgent(message, "guest-b"), true);
  assert.equal(messageVisibleToAgent(message, "guest-c"), false);
  assert.equal(isAgentToAgentPrivateMessage(message), true);
  assert.equal(formatMessageForAgent(message, agents[1], agents), "【A 私聊给你】今晚投C。");
  assert.equal(formatMessageForAgent(message, agents[0], agents), "【你私聊给 B】今晚投C。");
});

test("用户私聊不会进入其他嘉宾或房间公开时间线", () => {
  const publicMessage = { kind: "user", author: "晨曦", text: "大家早。" };
  const privateMessage = {
    kind: "user",
    author: "晨曦",
    text: "只问你一件事。",
    privacy: "private",
    recipientIds: ["guest-a"],
  };
  assert.deepEqual(visibleMessagesForAgent([publicMessage, privateMessage], "guest-a"), [publicMessage, privateMessage]);
  assert.deepEqual(visibleMessagesForAgent([publicMessage, privateMessage], "guest-b"), [publicMessage]);
  assert.deepEqual(publicRoomMessages([publicMessage, privateMessage]), [publicMessage]);
});

test("模型可在同一次回复附一条有效私聊，错误或截断标签不会泄漏到公开正文", () => {
  const parsed = parsePrivateMessageReply(
    '群里先说这句。\n<private_message to="guest-b">别告诉C。</private_message>',
    { agentId: "guest-a", recipients: agents },
  );
  assert.equal(parsed.publicText, "群里先说这句。");
  assert.deepEqual(parsed.privateMessages, [{ recipientIds: ["guest-b"], text: "别告诉C。" }]);

  const toUser = parsePrivateMessageReply(
    '<private_message to="user">我只告诉晨曦。</private_message>',
    { agentId: "guest-a", recipients: agents },
  );
  assert.deepEqual(toUser.privateMessages, [{ recipientIds: [ROOM_USER_ID], text: "我只告诉晨曦。" }]);

  const truncated = parsePrivateMessageReply(
    '公开部分。\n<private_message to="guest-b">秘密还没写完',
    { agentId: "guest-a", recipients: agents },
  );
  assert.equal(truncated.publicText, "公开部分。");
  assert.deepEqual(truncated.privateMessages, []);
});

test("私聊协议列出稳定收件人并说明被用户私聊时正文默认保密", () => {
  const instruction = privateMessageOutputInstruction(agents[0], agents, { defaultPrivateToUser: true });
  assert.match(instruction, /to="user"（晨曦）/);
  assert.match(instruction, /to="guest-b"（B）/);
  assert.doesNotMatch(instruction, /to="guest-a"（A）/);
  assert.match(instruction, /普通正文会自动作为你私聊给晨曦的回复/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  ROOM_USER_ID,
  formatMessageForAgent,
  isAgentToAgentPrivateMessage,
  isExplicitPrivateMessageTask,
  messageVisibleToAgent,
  parsePrivateMessageReply,
  privateMessageImmediateReminder,
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

test("普通群聊允许角色按语境主动私聊，但不把私聊变成每轮任务", () => {
  const instruction = privateMessageOutputInstruction(agents[0], agents);
  assert.match(instruction, /自行发起私聊，不必等晨曦点名或要求/);
  assert.match(instruction, /当前真实对话/);
  assert.match(instruction, /大多数普通轮次不私聊完全正常/);
  assert.match(instruction, /不要机械地一来一回/);
  assert.match(instruction, /公开正文不必宣布自己另发了私聊/);
});

test("临场提醒明确口头声称不等于真正发送私聊", () => {
  const publicReminder = privateMessageImmediateReminder();
  assert.match(publicReminder, /<private_message to="user">/);
  assert.match(publicReminder, /“我私聊了”“已经发了”不算发送/);

  const directReminder = privateMessageImmediateReminder({ defaultPrivateToUser: true });
  assert.match(directReminder, /普通正文会自动保密/);
  assert.doesNotMatch(directReminder, /<private_message to="user">/);
});

test("明确私聊任务会要求先交标签，普通权限讨论不会误判", () => {
  assert.equal(isExplicitPrivateMessageTask("每个人挑一个成员，发送一条私聊内容。"), true);
  assert.equal(isExplicitPrivateMessageTask("公开回一句，并额外私聊给我一句。"), true);
  assert.equal(isExplicitPrivateMessageTask("是不是只能看到自己的私聊内容？"), false);
  const reminder = privateMessageImmediateReminder({ privateMessageRequired: true });
  assert.match(reminder, /先输出一条完整的 <private_message>/);
  assert.match(reminder, /私聊里说.*不算完成/);
});

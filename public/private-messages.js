export const ROOM_USER_ID = "__room_user__";
export const MAX_PRIVATE_MESSAGES_PER_REPLY = 1;

function compactText(value, maxLength = 12_000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}

export function isPrivateMessage(message) {
  return message?.privacy === "private" && uniqueIds(message?.recipientIds).length > 0;
}

export function privateMessageRecipientIds(message) {
  return isPrivateMessage(message) ? uniqueIds(message.recipientIds) : [];
}

export function messageVisibleToAgent(message, agentId) {
  if (!isPrivateMessage(message)) return true;
  const viewerId = String(agentId || "");
  if (!viewerId) return false;
  return message?.agentId === viewerId || privateMessageRecipientIds(message).includes(viewerId);
}

export function visibleMessagesForAgent(messages, agentId) {
  return (Array.isArray(messages) ? messages : []).filter((message) => messageVisibleToAgent(message, agentId));
}

export function publicRoomMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => !isPrivateMessage(message));
}

export function privateRecipientLabel(message, agents = [], userName = "晨曦") {
  const names = new Map((Array.isArray(agents) ? agents : []).map((agent) => [agent.id, agent.name]));
  return privateMessageRecipientIds(message)
    .map((id) => id === ROOM_USER_ID ? userName : (names.get(id) || "未知嘉宾"))
    .join("、");
}

export function formatMessageForAgent(message, agent, agents = [], userName = "晨曦") {
  if (!isPrivateMessage(message)) return `${message.author}：${message.text}`;
  const recipient = privateRecipientLabel(message, agents, userName) || "未知对象";
  if (message.agentId === agent?.id) return `【你私聊给 ${recipient}】${message.text}`;
  return `【${message.author} 私聊给你】${message.text}`;
}

function privateDestinations(agent, agents = []) {
  return [
    { id: ROOM_USER_ID, protocolId: "user", name: "晨曦" },
    ...(Array.isArray(agents) ? agents : [])
      .filter((candidate) => candidate?.id && candidate.id !== agent?.id)
      .map((candidate) => ({ id: candidate.id, protocolId: candidate.id, name: candidate.name })),
  ];
}

export function privateMessageOutputInstruction(agent, agents = [], { defaultPrivateToUser = false } = {}) {
  const destinations = privateDestinations(agent, agents);
  if (!destinations.length) return "";
  const destinationText = destinations
    .map((destination) => `to="${destination.protocolId}"（${destination.name}）`)
    .join("；");
  return [
    "【可选私聊】",
    defaultPrivateToUser
      ? "你这次是被晨曦私聊点名的。普通正文会自动作为你私聊给晨曦的回复，不会公开到其他嘉宾的上下文；不需要再为这段正文套私聊标签。"
      : "除正常公开发言外，如果此刻确实有一句只想让某位对象知道的话，你可以额外发送最多一条私聊；没有必要就不要写。",
    `本轮允许的收件人：${destinationText}。必须原样复制其中一个 to 值，不得写自己或房间外的人。`,
    '<private_message to="收件人值">只给对方看的内容</private_message>',
    "私聊标签放在公开正文之后、<self_memory> 私人记忆便笺之前。若只想私聊，可以不写公开正文，直接输出完整私聊标签。",
    "私聊内容不会出现在房间长期总结里；除发送者、接收者和作为房主可选择查看记录的晨曦外，其他嘉宾连这次私聊发生过都不会知道。不要为了展示功能而滥发，也不要在公开正文中复述私聊内容。",
  ].join("\n");
}

function resolveRecipient(rawValue, recipients) {
  const raw = String(rawValue || "").trim();
  if (["user", "晨曦", ROOM_USER_ID].includes(raw)) return ROOM_USER_ID;
  const byId = recipients.find((recipient) => recipient.id === raw);
  if (byId) return byId.id;
  const byName = recipients.filter((recipient) => recipient.name === raw);
  return byName.length === 1 ? byName[0].id : "";
}

export function parsePrivateMessageReply(value, { agentId = "", recipients = [] } = {}) {
  const original = compactText(value, 50_000);
  if (!original) return { publicText: "", privateMessages: [], invalidRecipients: [] };

  const knownRecipients = (Array.isArray(recipients) ? recipients : [])
    .filter((recipient) => recipient?.id && recipient.id !== agentId)
    .map((recipient) => ({ id: String(recipient.id), name: String(recipient.name || "") }));
  const privateMessages = [];
  const invalidRecipients = [];
  const completePattern = /\s*```(?:xml)?\s*<private_message\s+to=["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/private_message>\s*```|\s*<private_message\s+to=["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/private_message>/gi;
  const publicText = original.replace(completePattern, (_match, fencedTo, fencedBody, plainTo, plainBody) => {
    const rawRecipient = fencedTo || plainTo || "";
    const recipientId = resolveRecipient(rawRecipient, knownRecipients);
    const text = compactText(fencedBody || plainBody);
    if (!recipientId || recipientId === agentId || !text) {
      invalidRecipients.push(rawRecipient || "未知对象");
    } else if (privateMessages.length < MAX_PRIVATE_MESSAGES_PER_REPLY) {
      privateMessages.push({ recipientIds: [recipientId], text });
    }
    return "";
  }).trim();

  const lower = publicText.toLowerCase();
  const openIndex = lower.lastIndexOf("<private_message");
  const safePublicText = openIndex >= 0 && lower.indexOf("</private_message>", openIndex) < 0
    ? publicText.slice(0, openIndex).trim()
    : publicText;
  return { publicText: safePublicText, privateMessages, invalidRecipients };
}

export function isAgentToAgentPrivateMessage(message) {
  return isPrivateMessage(message)
    && message?.kind === "agent"
    && privateMessageRecipientIds(message).some((id) => id !== ROOM_USER_ID);
}

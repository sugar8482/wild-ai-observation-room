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
    defaultPrivateToUser
      ? "直接回应晨曦即可。"
      : "你可以自行发起私聊，不必等晨曦点名或要求。先根据当前真实对话判断：这句话是否有明确的特定对象，而且公开说会泄露小秘密、破坏惊喜或计划、让对方难堪，或改变一句偏向、安慰、试探、提醒、悄悄话原本的意味；只有确实更适合单独说时才私聊。",
    defaultPrivateToUser
      ? ""
      : "不要为了展示功能、凑互动、刻意制造暧昧，或因为每轮都看见这段说明就发送私聊；大多数普通轮次不私聊完全正常。收到私聊后可以在合适时自然私聊回复，也可以不回，不要机械地一来一回。",
    `本轮允许的收件人：${destinationText}。必须原样复制其中一个 to 值，不得写自己或房间外的人。`,
    '<private_message to="收件人值">只给对方看的内容</private_message>',
    "私聊标签通常放在公开正文之后、<self_memory> 私人记忆便笺之前；如果临场提醒明确说本轮必须私聊，则把私聊标签放在最前面。若只想私聊，可以不写公开正文；若公开和私聊都写，两边应当各自有意义，公开正文不必宣布自己另发了私聊。",
    "私聊内容不会出现在房间长期总结里；除发送者、接收者和作为房主可选择查看记录的晨曦外，其他嘉宾连这次私聊发生过都不会知道。不要为了展示功能而滥发，也不要在公开正文中复述私聊内容。",
  ].filter(Boolean).join("\n");
}

export function isExplicitPrivateMessageTask(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text.includes("私聊")) return false;
  return /(?:发送|补发|重发|试着|尝试|额外|分别|每个人|每位|挑一个|选一个|选择一个).{0,24}私聊|私聊.{0,24}(?:发送|发一次|发一条|发一句|补发|重发|试试|尝试|挑一个|选一个|给我|给他|给她|一句|一条)/.test(text);
}

export function privateMessageImmediateReminder({ defaultPrivateToUser = false, privateMessageRequired = false } = {}) {
  if (defaultPrivateToUser) {
    return "【本轮私聊】晨曦这次直接私聊点名了你；普通正文会自动保密，不要再套私聊标签，也不要把回复另发到公屏。";
  }
  if (privateMessageRequired) {
    return [
      "【本轮必须实际发送私聊】先输出一条完整的 <private_message> 私聊标签，再写公开正文；不要先写公开内容，以免写着写着忘掉格式。",
      '给晨曦的写法：<private_message to="user">只给晨曦看的内容</private_message>',
      "也可以把 user 换成本轮允许名单中的嘉宾ID。只说“我会私聊”“私聊里说”不算完成；禁止把私聊原文复述到公屏。",
    ].join("\n");
  }
  return [
    "【私聊格式临场提醒】如果决定发送私聊，必须在本次最终输出里实际写出完整的 <private_message> 标签，程序才会创建私聊。",
    '给晨曦的写法：<private_message to="user">只给晨曦看的内容</private_message>',
    "只在公开正文里说“我私聊了”“已经发了”不算发送；也不要把准备私聊的原文复述到公屏。若没有私聊，就不要写标签，也不要声称已经发送。",
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

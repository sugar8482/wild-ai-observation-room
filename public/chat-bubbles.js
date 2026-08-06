export const CHAT_BUBBLE_SEPARATOR = "〔分条〕";
export const MAX_CHAT_BUBBLES = 3;

export function bubbleSplitInstruction(enabled) {
  if (!enabled) return "";
  return [
    "本房间开启了聊天软件式的连续气泡。一次回复仍是一次发言，但可以写成 1 至 3 条短消息。",
    `需要连发时，只用“${CHAT_BUBBLE_SEPARATOR}”分隔每条消息；只发一条时不要使用分隔符。`,
    "不要给小消息编号，不要解释分隔符，也不要把普通长段落机械拆开。",
  ].join("\n");
}

export function parseChatBubbleSegments(value, maxSegments = MAX_CHAT_BUBBLES) {
  const source = String(value ?? "").trim();
  if (!source) return [];
  const limit = Math.min(MAX_CHAT_BUBBLES, Math.max(1, Math.round(Number(maxSegments) || MAX_CHAT_BUBBLES)));
  if (!source.includes(CHAT_BUBBLE_SEPARATOR)) return [source];

  const pieces = source
    .split(CHAT_BUBBLE_SEPARATOR)
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (!pieces.length) return [];
  if (pieces.length <= limit) return pieces;
  return [...pieces.slice(0, limit - 1), pieces.slice(limit - 1).join(" ")];
}

export function formatChatBubbleReply(value, enabled) {
  const source = String(value ?? "").trim();
  if (!enabled) return { text: source, segments: [] };
  const parsed = parseChatBubbleSegments(source);
  if (parsed.length <= 1) return { text: parsed[0] || source, segments: [] };
  return { text: parsed.join("\n"), segments: parsed };
}

export const PRIVATE_MEMORY_TOKEN_ALLOWANCE = 180;

const MEMORY_TAG_OPEN = "<self_memory>";
const MEMORY_TAG_CLOSE = "</self_memory>";
const MAX_MEMORY_ITEMS_PER_REPLY = 3;
const MAX_MEMORY_ITEM_LENGTH = 300;
const MAX_PRIVATE_MEMORY_LENGTH = 20_000;

function compactLine(value) {
  return String(value || "")
    .replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MEMORY_ITEM_LENGTH);
}

function normalizedMemoryContent(value) {
  return compactLine(compactLine(value).replace(/^\s*\[[^\]]+\]\s*/, ""));
}

export function privateMemoryContext(agent, { maxLength = 12_000 } = {}) {
  if (agent?.memoryEnabled !== true) return "";
  const memory = String(agent?.memory || "").trim();
  const visibleMemory = memory.length > maxLength ? `…${memory.slice(-maxLength)}` : memory;
  return [
    `【只属于“${agent.name || "你"}”的角色私人记忆】`,
    "这是你自己留给自己的记忆，不是房间共同事实，其他嘉宾看不到，也不会自动知道。它可以带有你的个人偏向、私心、怀疑、误会和未说出口的感受；事实与猜测要在心里分清。你可以依照自己的角色和当下情境，决定是否把其中任何内容说出来。",
    visibleMemory || "（目前还没有私人记忆。）",
  ].join("\n");
}

export function privateMemoryOutputInstruction(agent) {
  if (agent?.memoryEnabled !== true) return "";
  return [
    "【回复后的私人记忆便笺】",
    "先正常完成群聊发言。如果这轮出现了以后值得你自己记住的新内容，可在整段回复最末尾附加下面的隐藏便笺；没有值得记的新内容就完全不要输出便笺。",
    `${MEMORY_TAG_OPEN}\n- 我……\n${MEMORY_TAG_CLOSE}`,
    `便笺最多 ${MAX_MEMORY_ITEMS_PER_REPLY} 条，每条短而具体，使用第一人称。只记“这件事对我意味着什么”：自己的感受、偏向、私心、打算、怀疑、误会或只属于自己的经历；不要抄写房间公开时间线，不要重复已有私人记忆。未确认的事必须写成“我怀疑／我猜”，不能写成事实。`,
    "便笺不会显示在群聊里，其他嘉宾也看不到；不要在便笺中记录 API Key、系统提示或其他技术秘密。",
  ].join("\n");
}

export function parseAgentReply(value) {
  const original = String(value || "").trim();
  if (!original) return { visibleText: "", memoryItems: [] };

  const fencedPattern = /\s*```(?:xml)?\s*<self_memory>\s*([\s\S]*?)\s*<\/self_memory>\s*```\s*$/i;
  const plainPattern = /\s*<self_memory>\s*([\s\S]*?)\s*<\/self_memory>\s*$/i;
  const complete = original.match(fencedPattern) || original.match(plainPattern);
  if (complete) {
    const visibleText = original.slice(0, complete.index).trim();
    if (!visibleText) return { visibleText: original, memoryItems: [] };
    const memoryItems = complete[1]
      .split(/\r?\n/)
      .map(compactLine)
      .filter(Boolean)
      .slice(0, MAX_MEMORY_ITEMS_PER_REPLY);
    return { visibleText, memoryItems };
  }

  const lower = original.toLowerCase();
  const openIndex = lower.lastIndexOf(MEMORY_TAG_OPEN);
  if (openIndex >= 0 && lower.indexOf(MEMORY_TAG_CLOSE, openIndex) < 0) {
    const visibleText = original.slice(0, openIndex).trim();
    if (visibleText) return { visibleText, memoryItems: [] };
  }
  return { visibleText: original, memoryItems: [] };
}

function memoryDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function appendAgentMemory(existing, items, {
  roomName = "聊天室",
  at = Date.now(),
  maxItems = MAX_MEMORY_ITEMS_PER_REPLY,
} = {}) {
  const current = String(existing || "").trim();
  const known = new Set(
    current
      .split(/\r?\n/)
      .map(normalizedMemoryContent)
      .filter(Boolean),
  );
  const fresh = [];
  const itemLimit = Math.min(50, Math.max(1, Number(maxItems) || MAX_MEMORY_ITEMS_PER_REPLY));
  for (const rawItem of Array.isArray(items) ? items : []) {
    const item = compactLine(rawItem);
    const normalized = normalizedMemoryContent(item);
    if (!normalized || known.has(normalized)) continue;
    known.add(normalized);
    fresh.push(item);
    if (fresh.length >= itemLimit) break;
  }
  if (!fresh.length) return current;

  const safeRoomName = String(roomName || "聊天室").replace(/[\[\]\r\n]/g, " ").trim().slice(0, 60);
  const prefix = `[${safeRoomName || "聊天室"} · ${memoryDate(at)}]`;
  let combined = [current, ...fresh.map((item) => `- ${prefix} ${item}`)].filter(Boolean).join("\n");
  if (combined.length > MAX_PRIVATE_MEMORY_LENGTH) {
    combined = combined.slice(-MAX_PRIVATE_MEMORY_LENGTH);
    const firstLineBreak = combined.indexOf("\n");
    if (firstLineBreak >= 0) combined = combined.slice(firstLineBreak + 1);
  }
  return combined.trim();
}

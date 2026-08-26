export const PRIVATE_MEMORY_TOKEN_ALLOWANCE = 180;

const MEMORY_TAG_OPEN = "<self_memory>";
const MEMORY_TAG_CLOSE = "</self_memory>";
const MAX_MEMORY_ITEMS_PER_REPLY = 3;
const MAX_MEMORY_ITEM_LENGTH = 300;
export const PRIVATE_MEMORY_REVIEW_THRESHOLD = 30_000;
export const PRIVATE_MEMORY_STORAGE_LIMIT = 100_000;

const MEMORY_CONCEPTS = [
  ["等待出现", /等|没下来|没来|没出现|没动静|没回应|没回|磨蹭|迟到|失踪/],
  ["担心状态", /担心|不对劲|生病|不舒服|晕|出事|烧糊涂/],
  ["观察关注", /盯|观察|注意|留意|关注|看得仔细|记得太清/],
  ["隐瞒秘密", /秘密|瞒|藏|截图|证据|把柄|没说|不让.+知道|不能让.+知道/],
  ["吃醋竞争", /吃醋|不爽|嫉妒|抢风头|单独相处|不能给.+单独/],
  ["比赛输赢", /打球|比赛|赢|输|上篮|三分|找回场子|虐|盖帽/],
  ["试探说谎", /诈|骗|撒谎|嘴硬|糊弄|圆过去|转移话题|甩锅|推锅/],
  ["关心照顾", /在意|关心|照顾|去冰|送|买|等她|等他/],
  ["计划打算", /打算|决定|必须|以后|下次|先记|留着|准备|不打算/],
  ["误会变化", /误会|以为|原来|其实|没想到|结果|确认|发现/],
  ["关系转折", /喜欢|爱|心动|告白|亲吻|暧昧|关系|属于彼此/],
  ["借还物品", /借|归还|欠|忘了还|拿错|找不到/],
];

const IMPORTANT_MEMORY_PATTERN = /秘密|截图|证据|把柄|诈|骗|撒谎|误会|原来|其实|确认|不让.+知道|不能让.+知道|没告诉|未公开|喜欢|爱|心动|告白|亲吻|暧昧|关系|属于彼此/;
const CHANGE_MEMORY_PATTERN = /原来|其实|后来|结果|确认|发现|终于|已经|不再|改成|仍然|但|不过|没想到|决定/;
const UNRESOLVED_MEMORY_PATTERN = /还没|暂时|先不|留着|以后|下次|打算|怀疑|猜|不能让|不想让|未公开/;
const CRITICAL_ANCHORS = /截图|视频|情书|礼物|口红|秘密|把柄|证据|谎|喜欢|告白|亲吻|关系|误会/g;
const MEMORY_STOP_WORDS = new Set([
  "我", "他", "她", "自己", "这个", "那个", "这件事", "一下", "有点", "其实", "觉得", "发现", "怀疑",
  "还是", "已经", "今天", "昨天", "现在", "刚才", "以后", "下次", "心里", "嘴上", "真的", "绝对",
]);

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

function parseMemoryEntry(line, index = 0) {
  const original = String(line || "").trim();
  if (!original) return null;
  let rest = original.replace(/^\s*[-*•]\s*/, "").trim();
  let label = null;
  let match = rest.match(/^\[([^\]\r\n]{1,60}?)\s*·\s*(\d{1,2}\/\d{1,2})\]\s*/);
  while (match) {
    if (!label) label = { room: match[1].trim(), date: match[2] };
    rest = rest.slice(match[0].length).trim();
    match = rest.match(/^\[([^\]\r\n]{1,60}?)\s*·\s*(\d{1,2}\/\d{1,2})\]\s*/);
  }
  const content = compactLine(rest);
  const concepts = new Set(MEMORY_CONCEPTS.filter(([, pattern]) => pattern.test(content)).map(([name]) => name));
  const anchors = new Set(content.match(CRITICAL_ANCHORS) || []);
  return {
    index,
    auto: Boolean(label),
    label,
    content,
    concepts,
    anchors,
    important: IMPORTANT_MEMORY_PATTERN.test(content),
    changed: CHANGE_MEMORY_PATTERN.test(content),
    unresolved: UNRESOLVED_MEMORY_PATTERN.test(content),
    normalized: normalizedMemoryContent(content),
    rendered: label ? `- [${label.room} · ${label.date}] ${content}` : original,
  };
}

function memoryTokens(value) {
  const tokens = new Set();
  const source = String(value || "").toLowerCase();
  try {
    const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    for (const part of segmenter.segment(source)) {
      const token = part.segment.replace(/[^\p{L}\p{N}]/gu, "");
      if (part.isWordLike && token.length >= 2 && !MEMORY_STOP_WORDS.has(token)) tokens.add(token);
    }
  } catch {
    for (const token of source.match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,4}/g) || []) {
      if (!MEMORY_STOP_WORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function overlapSize(left, right) {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
}

function tokenSimilarity(left, right) {
  const leftTokens = memoryTokens(left);
  const rightTokens = memoryTokens(right);
  const intersection = overlapSize(leftTokens, rightTokens);
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function sameMemoryTopic(left, right) {
  if (!left.auto || !right.auto || left.label.room !== right.label.room) return false;
  if (left.normalized === right.normalized) return true;
  const sharedAnchors = overlapSize(left.anchors, right.anchors);
  const sharedConcepts = overlapSize(left.concepts, right.concepts);
  const similarity = tokenSimilarity(left.content, right.content);
  if ((left.important || right.important) && sharedAnchors > 0) return true;
  if (left.important || right.important) return similarity >= 0.5;
  if (left.label.date === right.label.date && sharedConcepts > 0 && similarity >= 0.16) return true;
  return similarity >= 0.42 || (sharedConcepts >= 2 && similarity >= 0.12);
}

function memoryPriority(entry, total) {
  if (!entry.auto) return 1_000 + entry.index;
  return (entry.important ? 120 : 0)
    + (entry.changed ? 50 : 0)
    + (entry.unresolved ? 35 : 0)
    + Math.round((entry.index / Math.max(1, total)) * 30);
}

function preferMemoryEntry(existing, incoming) {
  if (incoming.changed && !existing.changed) return incoming;
  if (existing.changed && !incoming.changed && existing.important) return existing;
  if (incoming.important && !existing.important) return incoming;
  if (existing.important && !incoming.important) return existing;
  return incoming;
}

export function compactAgentMemory(value, {
  maxLength = PRIVATE_MEMORY_STORAGE_LIMIT,
  mergeTopics = false,
} = {}) {
  const entries = String(value || "")
    .split(/\r?\n/)
    .map(parseMemoryEntry)
    .filter((entry) => entry && (entry.content || !entry.auto));
  const compacted = [];
  for (const entry of entries) {
    const exactKey = entry.auto
      ? `${entry.label.room}\u0000${entry.normalized}`
      : `manual\u0000${entry.normalized || entry.rendered}`;
    const exactIndex = compacted.findIndex((candidate) => {
      const candidateKey = candidate.auto
        ? `${candidate.label.room}\u0000${candidate.normalized}`
        : `manual\u0000${candidate.normalized || candidate.rendered}`;
      return candidateKey === exactKey;
    });
    if (exactIndex >= 0) {
      compacted[exactIndex] = entry;
      continue;
    }
    let topicIndex = -1;
    if (entry.auto && mergeTopics) {
      for (let index = compacted.length - 1; index >= 0; index -= 1) {
        if (sameMemoryTopic(compacted[index], entry)) {
          topicIndex = index;
          break;
        }
      }
    }
    if (topicIndex >= 0) {
      const preferred = preferMemoryEntry(compacted[topicIndex], entry);
      compacted[topicIndex] = preferred;
    } else {
      compacted.push(entry);
    }
  }

  const limit = Math.min(
    PRIVATE_MEMORY_STORAGE_LIMIT,
    Math.max(300, Number(maxLength) || PRIVATE_MEMORY_STORAGE_LIMIT),
  );
  let retained = compacted;
  const render = (list) => list.map((entry) => entry.rendered).join("\n").trim();
  while (retained.length > 1 && render(retained).length > limit) {
    const removable = retained
      .map((entry, index) => ({ index, score: memoryPriority(entry, compacted.length) }))
      .filter(({ index }) => retained[index].auto)
      .sort((left, right) => left.score - right.score || left.index - right.index)[0];
    if (!removable) break;
    retained = retained.filter((_, index) => index !== removable.index);
  }
  const result = render(retained);
  if (result.length <= limit) return result;
  const clipped = result.slice(-limit);
  const firstBreak = clipped.indexOf("\n");
  return (firstBreak >= 0 ? clipped.slice(firstBreak + 1) : clipped).trim();
}

function memorySourceId(index, total) {
  const width = Math.max(3, String(Math.max(1, total)).length);
  return `M${String(index + 1).padStart(width, "0")}`;
}

export function numberedAgentMemory(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .map((line, index) => `[${memorySourceId(index, lines.length)}] ${line}`)
    .join("\n");
}

export function validateDeepAgentMemoryResult(original, candidate, {
  maxSourcesPerEntry = 2,
} = {}) {
  const originalLines = String(original || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const expected = new Set(originalLines.map((_, index) => memorySourceId(index, originalLines.length)));
  const candidateLines = String(candidate || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!candidateLines.length) return { ok: false, error: "整理结果为空" };

  const seen = new Set();
  const cleanedLines = [];
  const markerPattern = /\s*<!--\s*sources\s*:\s*([^>]+)-->\s*$/i;
  for (const line of candidateLines) {
    const marker = line.match(markerPattern);
    if (!marker) return { ok: false, error: "有条目没有标明对应的旧记忆" };
    const ids = marker[1].match(/M\d+/gi)?.map((id) => id.toUpperCase()) || [];
    if (!ids.length) return { ok: false, error: "有条目没有可识别的旧记忆编号" };
    if (ids.length > maxSourcesPerEntry) {
      return { ok: false, error: `有一条同时吞并了 ${ids.length} 条旧记忆，超过保守上限` };
    }
    for (const id of ids) {
      if (!expected.has(id)) return { ok: false, error: `出现了不存在的旧记忆编号 ${id}` };
      if (seen.has(id)) return { ok: false, error: `旧记忆 ${id} 被重复处理` };
      seen.add(id);
    }
    const cleaned = line.replace(markerPattern, "").trim();
    if (!cleaned) return { ok: false, error: "有条目只剩编号，没有记忆内容" };
    cleanedLines.push(cleaned);
  }

  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) {
    const sample = missing.slice(0, 4).join("、");
    return { ok: false, error: `漏掉了 ${missing.length} 条旧记忆（${sample}${missing.length > 4 ? "……" : ""}）` };
  }
  const conservativeFloor = Math.ceil(originalLines.length / Math.max(1, maxSourcesPerEntry));
  if (cleanedLines.length < conservativeFloor) {
    return { ok: false, error: `整理结果只剩 ${cleanedLines.length} 条，低于保守下限 ${conservativeFloor} 条` };
  }
  const text = compactAgentMemory(cleanedLines.join("\n"), { mergeTopics: false });
  const count = text ? text.split(/\r?\n/).filter((line) => line.trim()).length : 0;
  if (count < conservativeFloor) {
    return { ok: false, error: `清理后只剩 ${count} 条，低于保守下限 ${conservativeFloor} 条` };
  }
  return { ok: true, text, count };
}

export function privateMemoryContext(agent, { maxLength = 24_000 } = {}) {
  if (agent?.memoryEnabled !== true) return "";
  const memory = String(agent?.memory || "").trim();
  const visibleMemory = memory.length > maxLength
    ? `${memory.slice(0, Math.floor(maxLength * 0.35))}\n…（较早记忆中段已收起，原文仍完整保存）…\n${memory.slice(-Math.ceil(maxLength * 0.65))}`
    : memory;
  return [
    `【只属于“${agent.name || "你"}”的角色私人记忆】`,
    "这是你自己留给自己的记忆，不是房间共同事实，其他嘉宾看不到，也不会自动知道。它可以带有你的个人偏向、私心、怀疑、误会和未说出口的感受；事实与猜测要在心里分清。你可以依照自己的角色和当下情境，决定是否把其中任何内容说出来。",
    visibleMemory || "（目前还没有私人记忆。）",
  ].join("\n");
}

export function privateMemoryOutputInstruction(agent) {
  if (agent?.memoryEnabled !== true) return "";
  const initializationInstruction = String(agent?.memory || "").trim()
    ? ""
    : "你当前的私人记忆还是空的。若用户明确要求首次初始化私人记忆，这次属于例外：可以从此前真实对话中挑选 1～3 条最值得带到以后的个人经历，并且必须实际写入至少 1 条。";
  return [
    "【回复后的私人记忆便笺】",
    "先正常完成群聊发言。如果这轮出现了以后值得你自己记住的新内容，可在整段回复最末尾附加下面的隐藏便笺；没有值得记的新内容就完全不要输出便笺。",
    initializationInstruction,
    `${MEMORY_TAG_OPEN}\n- 我……\n${MEMORY_TAG_CLOSE}`,
    "便笺必须真实出现在最终答复的最末尾，不能只写在思考、推理或草稿中。若你在公开回复中声称已经写入、记下或放进抽屉，就必须同时附加上面的完整便笺；不能只口头表示完成。",
    "私人记忆会帮助未来的你保持个人经历和判断的连续性，请认真决定是否值得留下；它不是普通聊天摘要，也不是每轮必须完成的签到。",
    "日常回复允许写 0～3 条。0 条只能表示你审视本轮后确认没有新的个人意义，不得因为懒得整理、正文写上头或嫌格式麻烦而跳过真正重要的内容；同样不要为了证明自己有在记录而凑数。首次初始化同样可写 1～3 条。",
    "完成正文后，用很短的一次自检来决定：本轮是否有某句话、一次私聊或一个细节，是未来的我会希望自己仍记得的？我是否新形成或修正了对某个人、某段关系或自己的看法、偏向、介意、感激、失望、好奇、打算或戒心？如果遗忘它会让未来的反应少一层依据，就写 1 条；两三件彼此独立的事都满足时可分别写 2～3 条；都不满足才写 0 条。不同嘉宾可以因为各自的经历和判断留下完全不同的内容，不必追求一份共同标准答案。不要在公开正文中讲解这次自检。",
    `每条便笺短而具体，使用第一人称；程序最多接受 ${MAX_MEMORY_ITEMS_PER_REPLY} 条。只记“这件事对我意味着什么”：自己的感受、偏向、私心、打算、怀疑、误会或只属于自己的经历；不要抄写房间公开时间线，不要重复已有私人记忆。未确认的事必须写成“我怀疑／我猜”，不能写成事实。`,
    "值得留下的不一定是大事件：一句真正触动你的评价、一次被选择或被忽略、对某人的小幅改观、只愿私下承认的领情或不快，只要以后仍可能影响你，就可以记。相同情绪、相同等待、相同担心或同一计划只是又发生了一轮时，不要换句话重复记录。",
    "便笺不会显示在群聊里，其他嘉宾也看不到；不要在便笺中记录 API Key、系统提示或其他技术秘密。",
  ].filter(Boolean).join("\n");
}

export function privateMemoryImmediateReminder(agent, {
  defaultPrivateToUser = false,
  privateRepairOnly = false,
} = {}) {
  if (agent?.memoryEnabled !== true || privateRepairOnly) return "";
  const directPrivateLine = defaultPrivateToUser
    ? "本轮普通正文会自动作为你回复晨曦的私聊，但这仍然只是消息，不是私人记忆。"
    : "<private_message> 只发送一次私聊，不会写进私人记忆。";
  return [
    "【末尾双通道检查｜私聊 ≠ 私人记忆】",
    directPrivateLine,
    "<self_memory> 才会写进你自己的长期私人记忆；它不会作为私聊发送给任何人。两项要分别判断：可以都不用、只用一项，也可以同时使用。",
    "如果同时使用，严格按“公开正文 → <private_message> → <self_memory>”排列；完整的 </self_memory> 必须是最终输出的最后内容。",
    "在公开正文或私聊里说“我记了”“已经存档”“放进抽屉”都不算写入。只有真正输出完整 <self_memory> 便笺，程序才会保存。",
    "写完正文和可能的私聊后，再独立检查一次是否有值得未来的自己记住的新内容；确实没有可以不写，不要因已发送私聊而跳过这次检查。",
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
  const current = compactAgentMemory(existing, { mergeTopics: false });
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
  const combined = [current, ...fresh.map((item) => `- ${prefix} ${item}`)].filter(Boolean).join("\n");
  return compactAgentMemory(combined, { mergeTopics: false });
}

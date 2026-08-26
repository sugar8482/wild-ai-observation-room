function transcript(messages) {
  return messages.map((message) => {
    const author = message.kind === "user"
      ? `【用户原话｜${message.author}】`
      : message.author;
    return `${author}：${message.text}`;
  }).join("\n\n");
}

export const ROOM_SUMMARY_STORAGE_LIMIT = 200_000;
export const LEGACY_ROOM_SUMMARY_LIMIT = 50_000;
const LEGACY_TRUNCATION_MARGIN = 100;

export function isLegacyTruncatedRoomSummary(memory) {
  const summaryLength = String(memory?.summary || "").length;
  const summarizedCount = Math.max(0, Number(memory?.summarizedMessageCount) || 0);
  return summaryLength >= LEGACY_ROOM_SUMMARY_LIMIT - LEGACY_TRUNCATION_MARGIN
    && summaryLength <= LEGACY_ROOM_SUMMARY_LIMIT
    && summarizedCount >= 500;
}

function focusRule(room) {
  const focus = String(room?.memory?.focus || "").trim();
  return focus
    ? `【本房间的额外记忆重点】\n${focus}\n这些要求只决定优先保留什么，不得覆盖“不编造、不把推断当事实”的原则。`
    : "";
}

export function completeAutomaticSummaryBatch(messages, interval = 20) {
  const chunkSize = Math.min(100, Math.max(5, Math.floor(Number(interval) || 20)));
  const completeCount = Math.floor(messages.length / chunkSize) * chunkSize;
  return messages.slice(0, completeCount);
}

const FACT_RULES = [
  "你是通用的群聊客观事实记录员，不是人物评委、角色编剧或逐句复述员。无论房间是日常聊天、朋友群、角色扮演、工作讨论或其他用途，都只记录有原文依据、以后接话仍需要知道的事实。",
  "优先保留：用户明确设定的房间规则、决定和纠正；已经发生的具体事件；仍有效的承诺、称呼和关系状态；重要对象或作品的确定版本；尚未解决的问题；最近仍在推进的话题。",
  "成员亲口表达的感受、立场或关系变化，可以记录成“某人明确说／决定／承认了什么”，但不得从一句话外推成固定人格。",
  "绝对不要写成员档案、人格画像或能力排名；不要写“X 是……的人”“X 喜欢、擅长、不擅长、总是、习惯……”这类标签；不要把互评中的人物判断当作事实。",
  "区分事实、玩笑、成员当时的观点和不确定猜测；不要脑补任何人的感情、动机或固定性格。",
  "房间长期记忆是所有成员可见的公开故事时间线，只记录群聊中说出口或明确做出的事。不要推断、代写或记录任何成员未公开的私心、隐藏动机、个人偏向、内心独白或秘密猜测；这些属于各角色自己的私人记忆，不属于房间总结。",
  "凡是带有“如果、可能、猜、不会、难道、估计、听说”等条件或推测意味的内容，都必须保留为某位成员当时的条件句或猜测，绝不能升级成已经确认的事实。",
  "原文中标为“【用户原话｜名字】”的消息具有最高保留优先级。用户的提问、要求、纠正、话题转换、决定，以及对感受或关系的亲口表达，通常是理解对话走向的关键节点。",
  "用户原话要忠实保留实际内容，但只有称呼、规则、决定或关键措辞需要短引语；其他内容用客观转述压缩，不能只写成“用户询问了某事”这类空泛概括。纯表情、重复确认、无后续寒暄可以省略。",
];

const COMPACTION_RULES = [
  "把围绕同一件事的多轮发言合并成一条事实，不要逐个点名复述每位嘉宾的比喻、吐槽、附和和文风；除非某句话形成了决定、纠正、承诺或仍待回应的问题，否则不值得进入共同总结。",
  "同一事实只保留一处。新原文确认了旧事的结果，就直接更新旧条目；旧观点已经失效或不再影响后续时删除，不要同时保留多个版本。",
  "共同梗只有仍被近期对话持续引用、且不知道来源就无法接话时才留一句由来；不要保存整段包袱、判词或成员各自的发挥。",
  "不要模仿原聊天或旧总结的修辞口吻。总结是中性的事实索引，不承担任何嘉宾的人设、语气或关系解读。",
  "通常控制在约 1800～3200 个简体中文字，事实少时应更短；信息确实密集时也不要超过约 4000 字。这个范围是上限而非写作目标，不要凑字数。",
  "使用简短标题或项目符号组织成稳定事实、近期进展、未决事项等自然分区；没有内容的分区不要输出。不要附加消息编号、整理说明或第二份总概括。",
];

function buildRollingSummaryMessages(room, messages, currentSummary, sourceLabel) {
  const previous = String(currentSummary || "").trim();
  return [
    {
      role: "system",
      content: [
        ...FACT_RULES,
        "你会收到一份已有工作摘要和一批按时间排在它之后的聊天原文。请输出合并、去重、更新后的完整工作摘要；它将直接替换旧摘要，不要只输出新增片段。",
        "已有工作摘要也是待校订材料，不是权威事实；其中冗长的逐人复述、人物标签、重复时间片段和被新原文推翻的内容应在本轮压缩或修正。",
        ...COMPACTION_RULES,
        focusRule(room),
        "只输出更新后的客观事实摘要，不解释过程，不提及你是整理员。",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: [
        `房间名称：${room.name}`,
        `已有工作摘要：\n${previous || "（尚无；请从本批原文开始建立。）"}`,
        `${sourceLabel}：\n${transcript(messages)}`,
      ].join("\n\n"),
    },
  ];
}

export function buildAppendSummaryMessages(room, messages, currentSummary = room?.memory?.summary) {
  return buildRollingSummaryMessages(room, messages, currentSummary, "本批新增聊天原文");
}

export function buildRebuildSectionMessages(room, messages, currentSummary = "") {
  return buildRollingSummaryMessages(room, messages, currentSummary, "本批现存聊天原文");
}

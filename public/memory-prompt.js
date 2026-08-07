function transcript(messages) {
  return messages.map((message) => `${message.author}：${message.text}`).join("\n\n");
}

function focusRule(room) {
  return room.memory.focus.trim()
    ? `【本房间的额外记忆重点】\n${room.memory.focus.trim()}\n这些要求只决定优先保留什么，不得覆盖“不编造、不把推断当事实”的原则。`
    : "";
}

export function formatMemorySegment(messages, body, startNumber, endNumber) {
  const firstTime = Number(messages[0]?.timestamp);
  const lastTime = Number(messages.at(-1)?.timestamp);
  const dateOptions = { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" };
  const firstLabel = Number.isFinite(firstTime)
    ? new Date(firstTime).toLocaleString("zh-CN", dateOptions)
    : "时间未知";
  const lastLabel = Number.isFinite(lastTime)
    ? new Date(lastTime).toLocaleString("zh-CN", dateOptions)
    : firstLabel;
  const timeLabel = firstLabel === lastLabel ? firstLabel : `${firstLabel}—${lastLabel}`;
  return `## 记忆片段 · 第 ${startNumber}–${endNumber} 条 · ${timeLabel}\n\n${body.trim()}`;
}

const FACT_RULES = [
  "你是群聊的长期记录员，不是人物评委或角色编剧。只记录有原文依据的内容，不把一次行为固化成成员人格。",
  "可以记录：用户明确设定的房间规则、决定和重要事实；具体事件与观点；尚未回应的问题；仍在本批聊天中被使用的共同梗或引用。",
  "成员明确建立的关系状态、彼此使用的称呼、做出的承诺、共同经历，以及亲口表达的感受，属于关系事实。只按原文含义记录，不得延伸推断。",
  "绝对不要写成员档案、人格画像或能力排名；不要写“X 是……的人”“X 喜欢、擅长、不擅长、总是、习惯……”这类标签；不要把互评中的人物判断当作事实。",
  "区分事实、玩笑、成员当时的观点和不确定猜测；不要脑补任何人的感情、动机或固定性格。",
];

export function buildAppendSummaryMessages(room, messages) {
  return [
    {
      role: "system",
      content: [
        ...FACT_RULES,
        "这次只为本批新增聊天写一个独立的记忆片段。不要重写、压缩或评价此前的长期记忆，也不要假装输出全篇总结。",
        "尽量保留能帮助后续接话的具体细节、原话含义、谁回应了谁、仍未收尾的话题。合并本批内真正重复的内容，但不要为了简短而删掉有辨识度的细节。",
        "目标约 500 至 1000 个中文字；信息较少时不要凑字数。可以使用小标题，但不要输出“记忆片段”总标题，外层会自动添加。",
        focusRule(room),
        "只输出本批记忆正文，不解释过程，不提及你是整理员。",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: `房间名称：${room.name}\n\n本批新增聊天原文：\n${transcript(messages)}`,
    },
  ];
}

export function buildRebuildSectionMessages(room, messages) {
  return [
    {
      role: "system",
      content: [
        ...FACT_RULES,
        "这是一次全篇重建中的分段阅读。请把本批现存聊天整理成较详细、可独立核对的分段记录，之后另一轮整理会据此制作全篇概览。",
        "尽量保留事件顺序、具体观点、关系进展、称呼、承诺、活跃的梗和未解决问题。不要擅自替故事收尾。",
        "目标约 700 至 1400 个中文字；内容较少时不要凑字数。不要输出分段编号或总标题，外层会自动添加。",
        focusRule(room),
        "只输出本段记录正文，不解释过程，不提及你是整理员。",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: `房间名称：${room.name}\n\n本段现存聊天原文：\n${transcript(messages)}`,
    },
  ];
}

export function buildRebuildOverviewMessages(room, previousSummary, sections, recentMessages) {
  return [
    {
      role: "system",
      content: [
        ...FACT_RULES,
        "请根据现存原文的分段记录，为整个房间写一份连贯、较完整的全篇概览。它会与下方的逐段记录同时保存，因此不要机械复制每一条，但要保留贯穿多轮的重要事实、关系进展、话题脉络和待继续事项。",
        "旧总结只用于提醒可能被忽略的线索，不是权威事实。只有能在现存原文分段记录中找到支持的内容才能保留；已经删除、无法核对或与现存记录冲突的内容必须舍弃。",
        "最近原文用于校对当前状态和说话归属；若与旧总结冲突，以最近原文和现存分段记录为准。",
        "目标约 1600 至 2800 个中文字，信息丰富时可以写满，不必强行压缩成短摘要。可以使用“重要事实与决定”“已发生的讨论”“关系与共同经历”“仍活跃的梗”“待继续”等标题，但不得列成员性格档案。",
        focusRule(room),
        "只输出全篇概览正文，不解释过程，不提及你是整理员。",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: [
        `房间名称：${room.name}`,
        `旧总结（仅作线索参考）：\n${previousSummary.trim() || "（无）"}`,
        `根据全部现存原文生成的分段记录：\n${sections.join("\n\n---\n\n")}`,
        `最近原文校对：\n${transcript(recentMessages) || "（无）"}`,
      ].join("\n\n"),
    },
  ];
}

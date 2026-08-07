function transcript(messages) {
  return messages.map((message) => {
    const author = message.kind === "user"
      ? `【用户原话｜${message.author}】`
      : message.author;
    return `${author}：${message.text}`;
  }).join("\n\n");
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

export function completeAutomaticSummaryBatch(messages, interval = 20) {
  const chunkSize = Math.min(100, Math.max(5, Math.floor(Number(interval) || 20)));
  const completeCount = Math.floor(messages.length / chunkSize) * chunkSize;
  return messages.slice(0, completeCount);
}

const FACT_RULES = [
  "你是通用的群聊长期记录员，不是人物评委或角色编剧。无论房间是日常聊天、朋友群、角色扮演、工作讨论或其他用途，都只记录有原文依据的内容，不预设成员身份和关系。",
  "可以记录：用户明确设定的房间规则、决定和重要事实；具体事件与观点；尚未回应的问题；仍在本批聊天中被使用的共同梗或引用。",
  "成员明确建立的关系状态、彼此使用的称呼、做出的承诺、共同经历，以及亲口表达的感受，属于关系事实。只按原文含义记录，不得延伸推断。",
  "绝对不要写成员档案、人格画像或能力排名；不要写“X 是……的人”“X 喜欢、擅长、不擅长、总是、习惯……”这类标签；不要把互评中的人物判断当作事实。",
  "区分事实、玩笑、成员当时的观点和不确定猜测；不要脑补任何人的感情、动机或固定性格。",
  "凡是带有“如果、可能、猜、不会、难道、估计、听说”等条件或推测意味的内容，都必须保留为某位成员当时的条件句或猜测，绝不能升级成已经确认的事实。",
  "原文中标为“【用户原话｜名字】”的消息具有最高保留优先级。用户的提问、要求、纠正、话题转换、决定，以及对感受或关系的亲口表达，通常是理解对话走向的关键节点。",
  "用户原话较短时尽量完整引用，保留其语气和关键措辞；较长时可以忠实压缩，但不得只写成“用户询问了某事”“用户表达了看法”这类失去内容的空泛概括。纯表情、重复确认、无后续的寒暄可以省略。",
];

const TIMELINE_RULES = [
  "按发生顺序记录真正推动聊天、形成后续背景或仍可能被接起的事件。连续围绕同一件事的来回应合并成一项，不要把原文逐句改写；同一事实只能出现一次，也不要在段尾再次总结本段。",
  "关系变化、共同梗、称呼、承诺或未解决问题若确实影响后续，就放在它发生的时间位置写一次；不要另设重要事实、总概括、关系、性格、梗或待办栏目重复归类。",
  "自我介绍、成员所属、临时规则、一次性评价和普通附和，除非随后持续影响聊天，否则省略。不要擅自替故事收尾。",
];

export function buildAppendSummaryMessages(room, messages) {
  return [
    {
      role: "system",
      content: [
        ...FACT_RULES,
        "这次只为本批新增聊天写一个独立的时间记录片段。不要重写、压缩或评价此前的长期记忆，也不要假装输出全篇总结。",
        ...TIMELINE_RULES,
        "尽量保留能帮助后续接话的具体细节、关键原话含义和谁回应了谁，但不要为了显得完整而记录每次附和、调侃或临时规则。",
        "如果本批少于 5 条，只写一段简短自然的时间记录，不要列小标题、清单、备注、关系分析或未收尾事项。",
        "目标约 500 至 1000 个中文字；信息较少时不要凑字数。不要输出分段编号或总标题，外层会自动添加。",
        focusRule(room),
        "只输出本批时间记录正文，不解释过程，不提及你是整理员。",
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
        "这是一次全篇重建中的分段阅读。请把本批现存聊天写成一段可独立核对的时间记录，之后会按时间顺序与其他分段直接拼接，不会再生成另一份总概括。",
        ...TIMELINE_RULES,
        "篇幅随原文密度自然变化：通常约 700 至 1400 个中文字，内容非常丰富时可到约 1800 字；内容较少时不要凑字数。整间房不设固定总字数，记录越长就生成越多分段。不要输出分段编号或总标题，外层会自动添加。",
        focusRule(room),
        "只输出本段时间记录正文，不解释过程，不提及你是整理员。",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: `房间名称：${room.name}\n\n本段现存聊天原文：\n${transcript(messages)}`,
    },
  ];
}

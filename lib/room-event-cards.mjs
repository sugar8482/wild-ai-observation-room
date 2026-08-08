export const ROOM_EVENT_CARDS = Object.freeze([
  {
    id: "temporary-notice",
    text: "收到一则与嘉宾自身学习、工作或日常安排有关的临时通知，值得在群里商量一下。",
  },
  {
    id: "activity-or-match",
    text: "近期出现一场比赛、活动、社团任务或临时合作，嘉宾之间可以讨论参加、分工或打赌。",
  },
  {
    id: "neighborhood-news",
    text: "居住地、学校、单位或常去的地方出现一件小小的新鲜事，但它与用户是否在场无关。",
  },
  {
    id: "old-object",
    text: "某位嘉宾偶然翻出一件和共同过去有关的旧东西，记忆可能一致，也可能各自记得不同。",
  },
  {
    id: "borrowed-item",
    text: "嘉宾之间有件借走后忘记归还、归还错了或已经找不到的小东西，可以自然追问或翻旧账。",
  },
  {
    id: "chance-encounter",
    text: "两位嘉宾不久前临时碰见或顺路做了件小事；只涉及实际在场的嘉宾，不自动把用户写进去。",
  },
  {
    id: "misunderstanding-or-bet",
    text: "嘉宾之间出现一个不严重的小误会、赌约或彼此知道但还没说开的共同秘密。",
  },
  {
    id: "outside-friend",
    text: "聊起一个与用户无关的同学、同事、朋友或熟人，让嘉宾展示各自独立的人际关系和生活。",
  },
  {
    id: "unfinished-plan",
    text: "嘉宾自己有一件拖着没做、临时改变或想找人搭把手的事，可以邀请别人，也可以被拒绝。",
  },
  {
    id: "different-memory",
    text: "嘉宾对一件共同经历的细节记得不一样，可以争论、求证或顺势发现新的共同信息。",
  },
]);

function safeRecentIds(eventCards) {
  return Array.isArray(eventCards?.recentIds)
    ? eventCards.recentIds.map(String).filter(Boolean).slice(-4)
    : [];
}

export function drawRoomEventCard(eventCards, random = Math.random) {
  if (eventCards?.enabled !== true) return null;
  const recent = new Set(safeRecentIds(eventCards));
  const available = ROOM_EVENT_CARDS.filter((card) => !recent.has(card.id));
  const pool = available.length ? available : ROOM_EVENT_CARDS;
  const index = Math.min(pool.length - 1, Math.floor(Math.max(0, Math.min(0.999999, random())) * pool.length));
  return pool[index] || null;
}

export function recordRoomEventCard(eventCards, card) {
  if (!card) return {
    enabled: eventCards?.enabled === true,
    recentIds: safeRecentIds(eventCards),
    lastEvent: String(eventCards?.lastEvent || ""),
    revision: Math.max(0, Number(eventCards?.revision) || 0),
  };
  return {
    enabled: eventCards?.enabled === true,
    recentIds: [...safeRecentIds(eventCards).filter((id) => id !== card.id), card.id].slice(-4),
    lastEvent: card.text,
    revision: Math.max(0, Number(eventCards?.revision) || 0) + 1,
  };
}

export function roomEventCardPrompt(card) {
  if (!card) return "";
  return [
    `【本轮可选生活事件｜${card.id}】`,
    card.text,
    "这是一张谈资卡，不是已经发生的事实。可以结合既有设定自然采用，也可以觉得不合适而不接。",
    "若采用，只能先由嘉宾提出与自身生活有关的具体小事，再让其他嘉宾回应；不得替用户决定行程、位置、健康、迟到、失踪、承诺或已经参与了什么。",
  ].join("\n");
}

import {
  WEREWOLF_PHASE_META,
  WEREWOLF_ROLE_META,
  WEREWOLF_USER_ID,
  appendWerewolfLog,
  appendWerewolfPrivateDiary,
  archiveWerewolfGame,
  beginWerewolfDebrief,
  checkWerewolfWinner,
  createWerewolfGame,
  werewolfRoleDeck,
  finishWerewolfGame,
  livingWerewolfPlayers,
  parseWerewolfTarget,
  parseWitchAction,
  recordWerewolfIncident,
  resolveWerewolfNight,
  shuffleWerewolfItems,
  stripWerewolfControls,
  visibleWerewolfLog,
  visibleWerewolfPrivateDiaries,
  voteOutcome,
  werewolfPlayer,
} from "./werewolf-game.js";
import {
  HISTORY_WINDOW_BATCH,
  historyWindow,
  nextHistoryWindowLimit,
} from "./history-window.js";
import {
  PRIVATE_MEMORY_TOKEN_ALLOWANCE,
  appendAgentMemory,
  parseAgentReply,
  privateMemoryContext,
  privateMemoryImmediateReminder,
  privateMemoryOutputInstruction,
} from "./agent-memory.js";
import {
  ROOM_USER_ID,
  parsePrivateMessageReply,
  privateMessageImmediateReminder,
  privateMessageOutputInstruction,
} from "./private-messages.js";
import { appendBoldText } from "./rich-text.js";
import { createMessageActionButton, openMessageEditor } from "./message-actions.js";

const DEBRIEF_VISIBLE_REPLY_TOKENS = 520;
const DEBRIEF_FORMAT_TOKEN_ALLOWANCE = 360;

const byId = (id) => document.getElementById(id);

const WEREWOLF_ROLE_AVATARS = Object.freeze({
  villager: "/assets/werewolf-villager.svg",
  wolf: "/assets/werewolf-wolf.svg",
  witch: "/assets/werewolf-witch.svg",
  seer: "/assets/werewolf-seer.svg",
});

function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(timestamp))
    .replace(/\//g, "-");
}

function optionList(select, players, { placeholder = "请选择", selected = "" } = {}) {
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.append(empty);
  for (const player of players) {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = player.name;
    select.append(option);
  }
  select.value = players.some((player) => player.id === selected) ? selected : "";
}

function selectedRadio(name, fallback) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || fallback;
}

function currentNight(game) {
  let night = game.nights.find((entry) => entry.day === game.day);
  if (!night) {
    night = {
      day: game.day,
      wolfVotes: {},
      killTargetId: null,
      seerTargetId: null,
      seerResult: null,
      witchSave: false,
      poisonTargetId: null,
      deaths: [],
      resolved: false,
    };
    game.nights.push(night);
  }
  return night;
}

function currentDay(game) {
  let day = game.days.find((entry) => entry.day === game.day);
  if (!day) {
    day = {
      day: game.day,
      speechOrder: shuffleWerewolfItems(livingWerewolfPlayers(game).map((player) => player.id)),
      speeches: {},
      provisionalVotes: {},
      votes: {},
      tieVotes: {},
      voteCounts: {},
      tiedIds: [],
      eliminatedId: null,
    };
    game.days.push(day);
  }
  return day;
}

export function werewolfVoteProgress(game, {
  tiedOnly = game?.phase === "tie_vote",
  currentPlayerId = "",
} = {}) {
  const day = game?.days?.find((entry) => entry.day === game.day);
  const votes = tiedOnly ? day?.tieVotes : day?.votes;
  const completed = (game?.players || []).flatMap((voter) => {
    const targetId = votes?.[voter.id];
    if (!targetId) return [];
    const target = werewolfPlayer(game, targetId);
    return [`${voter.name}→${target?.name || targetId}`];
  });
  const currentPlayer = werewolfPlayer(game, currentPlayerId);
  return [
    `已投：${completed.length ? completed.join("、") : "暂无"}`,
    currentPlayer ? `卡在：${currentPlayer.name}` : "",
  ].filter(Boolean).join("｜");
}

function werewolfSpeechSeatIds(game, tiedOnly = game?.phase === "tie_speech") {
  if (!game) return [];
  const candidateIds = tiedOnly
    ? new Set(game.pending?.tieIds || game.days?.find((entry) => entry.day === game.day)?.tiedIds || [])
    : null;
  return game.players
    .filter((player) => player.alive && (!candidateIds || candidateIds.has(player.id)))
    .map((player) => player.id);
}

function werewolfPlayerHasSpoken(game, playerId, tiedOnly = game?.phase === "tie_speech") {
  const day = game?.days?.find((entry) => entry.day === game.day);
  return Boolean(day?.speeches?.[tiedOnly ? `${playerId}-tie` : playerId]);
}

export function werewolfDirectorSnapshot(game, { speakingPlayerId = "" } = {}) {
  if (!game) {
    return {
      kind: "setup",
      locked: true,
      tiedOnly: false,
      roster: [],
      eligibleSpeakerIds: [],
      roundSpeakerIds: [],
    };
  }
  const ended = game.status === "ended";
  const tiedOnly = !ended && game.phase === "tie_speech";
  const speechPhase = !ended && ["day_speech", "tie_speech"].includes(game.phase);
  const visibleIds = tiedOnly ? new Set(werewolfSpeechSeatIds(game, true)) : null;
  const visiblePlayers = ended
    ? game.players.filter((player) => player.type === "agent")
    : game.players.filter((player) => !visibleIds || visibleIds.has(player.id));
  const seatById = new Map(game.players.map((player, index) => [player.id, index + 1]));
  const eligibleSpeakerIds = ended
    ? visiblePlayers.map((player) => player.id)
    : speechPhase
      ? visiblePlayers
        .filter((player) => player.type === "agent" && player.alive && !werewolfPlayerHasSpoken(game, player.id, tiedOnly))
        .map((player) => player.id)
      : [];
  const roundDone = new Set(game.debrief?.roundDone || []);
  const roster = visiblePlayers.map((player) => {
    const speaking = player.id === speakingPlayerId;
    const spoken = ended ? roundDone.has(player.id) : werewolfPlayerHasSpoken(game, player.id, tiedOnly);
    let status = "等待行动";
    if (speaking) status = ended ? "正在复盘……" : "正在发言……";
    else if (ended && spoken) status = "已复盘 · 可再点";
    else if (ended && !player.alive) status = "已出局 · 可复盘";
    else if (ended) status = "可复盘";
    else if (!player.alive) status = "已出局";
    else if (spoken) status = "已发言";
    else if (speechPhase && player.type === "user") status = "用主输入框";
    else if (speechPhase) status = "待发言";
    return {
      id: player.id,
      name: player.name,
      type: player.type,
      seat: seatById.get(player.id) || 0,
      alive: player.alive !== false,
      speaking,
      spoken,
      status,
    };
  });
  return {
    kind: ended ? "debrief" : tiedOnly ? "tie" : speechPhase ? "day" : "locked",
    locked: !ended && !speechPhase,
    tiedOnly,
    roster,
    eligibleSpeakerIds,
    roundSpeakerIds: [...eligibleSpeakerIds],
  };
}

export function pickWerewolfDirectorSpeaker(speakerIds, random = Math.random) {
  const ids = Array.isArray(speakerIds) ? speakerIds.filter(Boolean) : [];
  if (!ids.length) return null;
  const roll = Number(random());
  const index = Math.min(ids.length - 1, Math.max(0, Math.floor((Number.isFinite(roll) ? roll : 0) * ids.length)));
  return ids[index] || null;
}

function namesFor(game, ids) {
  return ids.map((id) => werewolfPlayer(game, id)?.name || id).join("、");
}

function publicHistory(game, limit = 80) {
  return game.log
    .filter((entry) => entry.visibility === "public")
    .slice(-limit)
    .map((entry) => `${entry.author}：${entry.text}`)
    .join("\n");
}

export function werewolfNightPublicBriefing(game, limit = 80) {
  return `截至今晚的公屏记录（包括此前白天发言、投票、遗言与天亮结果）：\n${publicHistory(game, limit) || "公屏还没有任何记录。"}`;
}

export function werewolfRosterStatus(game) {
  return game.players
    .map((player) => `${player.name}（${player.alive ? "存活" : "已出局"}）`)
    .join("、");
}

export function wolfNightBriefing(game) {
  const publicTranscript = publicHistory(game) || "公屏还没有任何记录。";
  const wolfTranscript = game.log
    .filter((entry) => entry.day === game.day && entry.visibility === "wolves")
    .map((entry) => `${entry.author}：${entry.text}`)
    .join("\n") || "本夜狼队频道还没人说话。";
  return [
    `全体玩家当前状态：${werewolfRosterStatus(game)}。`,
    `截至当前的公屏记录（包括白天发言、投票和遗言）：\n${publicTranscript}`,
    `本夜狼队密谈记录：\n${wolfTranscript}`,
  ].join("\n\n");
}

function completedNights(game) {
  const unresolvedPhases = new Set(["night_wolves", "night_seer", "night_witch", "dawn"]);
  return game.nights.filter((night) => (
    night.resolved === true
    || night.day < game.day
    || (night.day === game.day && !unresolvedPhases.has(game.phase))
  ));
}

export function roleKnowledge(game, player) {
  const nights = completedNights(game);
  if (player.role === "wolf") {
    const teammates = game.players.filter((item) => item.role === "wolf" && item.id !== player.id);
    const teammateStatus = teammates
      .map((item) => `${item.name}（${item.alive ? "存活" : "已出局"}）`)
      .join("、");
    const history = nights.map((night) => {
      const finalTarget = werewolfPlayer(game, night.killTargetId)?.name || "无人";
      const ownTarget = werewolfPlayer(game, night.wolfVotes?.[player.id])?.name || "未落刀";
      return `第${night.day}夜狼队最终刀口=${finalTarget}，你的选择=${ownTarget}`;
    }).join("；");
    const rememberedWolfChat = game.log
      .filter((entry) => (
        entry.visibility === "wolves"
        && (entry.day < game.day || game.phase !== "night_wolves")
      ))
      .slice(-20)
      .map((entry) => `第${entry.day}夜 ${entry.author}：${entry.text}`)
      .join("\n")
      .slice(-6_000);
    return [
      `你的狼队友：${teammateStatus || "没有"}。已出局狼队友不能参与今晚行动，也不会再回复密谈；狼人允许自刀或刀仍存活的狼队友。`,
      history ? `你记得的狼队夜间行动：${history}。` : "狼队还没有已结算的夜间行动。",
      rememberedWolfChat ? `你记得此前的狼队密谈，白天也可以继续利用这些信息：\n${rememberedWolfChat}` : "此前没有需要回忆的狼队密谈。",
    ].join("");
  }
  if (player.role === "seer") {
    const checks = game.seerChecks
      .filter((entry) => !entry.seerId || entry.seerId === player.id)
      .map((entry) => `第${entry.day}夜 ${werewolfPlayer(game, entry.targetId)?.name || entry.targetId}=${entry.result === "wolf" ? "狼人" : "好人"}`)
      .join("；");
    return checks ? `你已经验过：${checks}。` : "你还没有验人结果。";
  }
  if (player.role === "witch") {
    const history = nights.map((night) => {
      const knife = werewolfPlayer(game, night.killTargetId)?.name || "无人";
      const saved = night.witchSave ? `使用解药救了${knife}` : "没有使用解药";
      const poisoned = night.poisonTargetId
        ? `使用毒药毒了${werewolfPlayer(game, night.poisonTargetId)?.name || night.poisonTargetId}`
        : "没有使用毒药";
      return `第${night.day}夜刀口=${knife}，${saved}，${poisoned}`;
    }).join("；");
    return [
      `你的解药${game.witch.healAvailable ? "还在" : "已经用掉"}，毒药${game.witch.poisonAvailable ? "还在" : "已经用掉"}。`,
      history ? `你记得的女巫行动：${history}。` : "你还没有已结算的夜间行动。",
    ].join("");
  }
  return "你没有额外的夜间信息。";
}

export function viewerRoleKnowledge(game, player) {
  if (!game || !player) return { kind: "hidden" };
  if (game.status === "ended" || game.viewMode === "god") {
    return { kind: "role", role: player.role };
  }
  const user = werewolfPlayer(game, WEREWOLF_USER_ID);
  if (player.id === WEREWOLF_USER_ID || (user?.role === "wolf" && player.role === "wolf")) {
    return { kind: "role", role: player.role };
  }
  if (user?.role === "seer") {
    const check = [...(game.seerChecks || [])]
      .reverse()
      .find((entry) => (
        (!entry.seerId || entry.seerId === user.id)
        && entry.targetId === player.id
      ));
    if (check?.result === "wolf") return { kind: "role", role: "wolf" };
    if (check?.result === "good") return { kind: "team", team: "good" };
  }
  return { kind: "hidden" };
}

export function gameSystemPrompt(agent, game, player, task, { includePrivateMemory = true } = {}) {
  const living = livingWerewolfPlayers(game).map((item) => item.name).join("、");
  const eliminated = game.players.filter((item) => !item.alive).map((item) => item.name).join("、");
  const readOnlyMemory = includePrivateMemory ? privateMemoryContext(agent) : "";
  const continuityRule = readOnlyMemory
    ? "这是一份规则与原始卷宗都独立的临时对局。上面属于你自己的长期私人记忆是只读背景：它可以自然影响你对玩家的信任、怀疑、偏向和策略；你仍看不到任何旧局原文、旧复盘或旧局私人日记。不要把旧局身份当成本局身份。"
    : "这是一份规则与原始卷宗都独立的临时对局。本次纠错只使用本局公屏、你的合法秘密频道和身份信息。不要把旧局身份当成本局身份。";
  const outputRule = readOnlyMemory
    ? "这局里的欺骗、站队和敌意不自动代表永久人格或真实关系。对局进行中没有新增、修改或归档私人记忆及局内日记的功能：不得输出 <self_memory>、<game_diary>、私人记忆便笺、记忆档案或声称已经存档。有想长期保留的内容，等游戏结束进入赛后复盘后再决定。"
    : "这局里的欺骗、站队和敌意不自动代表永久人格或真实关系。最终答案只能是当前游戏动作所需的一段简体中文正文；不要附加 XML 标签、标题、档案、便笺、解释或元话语。";
  return [
    `你是“${agent.name}”，正在聊天室里参加一局临时狼人杀。你的身份是${WEREWOLF_ROLE_META[player.role].label}。`,
    agent.persona?.trim() ? `你平时的个人设定：\n${agent.persona.trim().slice(0, 4_000)}` : "保持你平时自然的判断与说话方式。",
    readOnlyMemory,
    continuityRule,
    outputRule,
    `全体玩家生存状态：${werewolfRosterStatus(game)}。还活着的玩家：${living || "无人"}。已出局玩家：${eliminated || "暂无"}。${roleKnowledge(game, player)}`,
    "你可以撒谎、悍跳、伪装、质疑晨曦，狼人也可以倒钩队友。不要因为晨曦是用户就默认她可信或不投她。",
    "只能使用公屏发言和你的合法身份信息。不得猜 API 速度、报错、模型风格或接口故障，不得读取他人的身份和秘密频道。",
    task,
  ].filter(Boolean).join("\n\n");
}

function gameDiaryOutputInstruction(agent) {
  return [
    `完成公开复盘后，请为“${agent.name}”写 2～4 条只属于本局的简短私人日记。`,
    "它只随本局卷宗封存，晨曦和你自己可以查看；不会自动带到下一局。其他嘉宾不会自动看到。",
    "把本局日记放在公开正文之后、长期私人记忆之前，并严格使用：",
    "<game_diary>\n- 我……\n</game_diary>",
    "日记使用第一人称，优先记自己的选择、判断失误、关系变化、仍介意或没说完的话；不要抄整份公开时间线，也不要记录 API、系统提示或技术秘密。",
    "不要模仿档案标题、正文区、存疑区、来源、作废条件等公开卷宗格式。程序只识别完整的 <game_diary> 标签；口头说已建档不会保存。",
  ].join("\n");
}

function rememberAgent(agent, items, roomName = "狼人杀") {
  if (!agent?.memoryEnabled || !Array.isArray(items) || !items.length) return false;
  const nextMemory = appendAgentMemory(agent.memory, items, {
    roomName,
    at: Date.now(),
    maxItems: 18,
  });
  if (nextMemory === String(agent.memory || "")) return false;
  agent.memory = nextMemory;
  agent.memoryRevision = Math.max(Date.now(), Number(agent.memoryRevision || 0) + 1);
  return true;
}

function diaryItems(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

function extractGameDiary(value) {
  const items = [];
  const completePattern = /\s*```(?:xml)?\s*<game_diary>\s*([\s\S]*?)\s*<\/game_diary>\s*```|\s*<game_diary>\s*([\s\S]*?)\s*<\/game_diary>/gi;
  let visibleText = String(value || "").replace(completePattern, (_match, fencedBody, plainBody) => {
    items.push(...diaryItems(fencedBody || plainBody));
    return "";
  }).trim();
  const lower = visibleText.toLowerCase();
  const openIndex = lower.lastIndexOf("<game_diary>");
  if (openIndex >= 0 && lower.indexOf("</game_diary>", openIndex) < 0) {
    visibleText = visibleText.slice(0, openIndex).trim();
  }
  return { visibleText, diaryItems: items.slice(0, 4) };
}

export function stripPseudoDebriefArchive(value) {
  const original = String(value || "").trim();
  const markerPattern = /^(?:#{1,6}\s*)?(?:【\s*)?(私人记忆档案|正文区|存疑区|来源|作废条件)(?:\s*】)?\s*[:：]?\s*$/gmi;
  const markers = [...original.matchAll(markerPattern)];
  if (markers.length < 2) return original;
  const firstIndex = markers[0].index || 0;
  const prefix = original.slice(0, firstIndex).trim();
  if (prefix.length >= 20) return prefix;
  const bodyMarkerIndex = markers.findIndex((match) => match[1] === "正文区");
  if (bodyMarkerIndex < 0) return "";
  const bodyStart = (markers[bodyMarkerIndex].index || 0) + markers[bodyMarkerIndex][0].length;
  const nextMarker = markers[bodyMarkerIndex + 1];
  return original.slice(bodyStart, nextMarker?.index ?? original.length).trim();
}

export function parseWerewolfDebriefReply(rawText, { recipients = [], agentId = "" } = {}) {
  const privateParsed = parsePrivateMessageReply(String(rawText || ""), { agentId, recipients });
  const diaryParsed = extractGameDiary(privateParsed.publicText);
  const parsed = parseAgentReply(diaryParsed.visibleText);
  return {
    text: stripPseudoDebriefArchive(stripWerewolfControls(parsed.visibleText)),
    diaryItems: diaryParsed.diaryItems,
    memoryItems: parsed.memoryItems,
    privateMessages: privateParsed.privateMessages.map((message) => ({
      ...message,
      recipientIds: message.recipientIds.map((id) => id === ROOM_USER_ID ? WEREWOLF_USER_ID : id),
    })),
    invalidRecipients: privateParsed.invalidRecipients,
  };
}

export function parseWerewolfGameReply(rawText) {
  const forbiddenMemoryBlock = /\s*```(?:xml)?\s*<(self_memory|game_diary|private_memory)>\s*[\s\S]*?\s*<\/\1>\s*```|\s*<(self_memory|game_diary|private_memory)>\s*[\s\S]*?\s*<\/\2>/gi;
  let visibleText = String(rawText || "").replace(forbiddenMemoryBlock, "").trim();
  const unclosedMarker = /<(?:self_memory|game_diary|private_memory)>/i.exec(visibleText);
  if (unclosedMarker) visibleText = visibleText.slice(0, unclosedMarker.index).trim();
  visibleText = visibleText.replace(/<\/(?:self_memory|game_diary|private_memory)>/gi, "").trim();
  const pseudoArchiveMarker = /^(?:#{1,6}\s*)?(?:【\s*)?(?:私人记忆(?:档案|便笺|记录)?|长期记忆|正文区|存疑区|来源|作废条件)(?:\s*】)?\s*[:：]?\s*$/gmi;
  const archiveMarkers = [...visibleText.matchAll(pseudoArchiveMarker)];
  if (archiveMarkers.length >= 2 || (archiveMarkers.length && (archiveMarkers[0].index || 0) < 80)) {
    visibleText = visibleText.slice(0, archiveMarkers[0].index || 0).trim();
  }
  // Keep legal game controls until the phase-specific parser has consumed them.
  // Public speeches and logs strip these markers at their display boundary.
  return visibleText.trim();
}

export function werewolfRequestAgent(agent) {
  const {
    memory: _memory,
    memoryEnabled: _memoryEnabled,
    memoryRevision: _memoryRevision,
    ...requestAgent
  } = agent || {};
  return requestAgent;
}

export async function chatRequest(agent, game, player, task, userContent, signal, maxTokens = 260) {
  const systemPrompt = gameSystemPrompt(agent, game, player, task);
  const correctionPrompt = gameSystemPrompt(agent, game, player, task, { includePrivateMemory: false });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const correctingMemoryOnlyReply = attempt > 0;
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: werewolfRequestAgent(agent),
        requestMode: "werewolf-game",
        temperature: correctingMemoryOnlyReply ? 0.25 : 0.9,
        maxTokens,
        messages: [
          {
            role: "system",
            content: correctingMemoryOnlyReply
              ? `${correctionPrompt}\n\n【重新作答】上一轮没有形成有效的游戏动作或公屏发言，已被丢弃。直接完成当前任务，只输出答案正文。`
              : systemPrompt,
          },
          { role: "user", content: userContent },
        ],
      }),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `${agent.name} 没有接通`);
    if (!String(payload.text || "").trim()) {
      if (!correctingMemoryOnlyReply) continue;
      throw new Error(`${agent.name} 连续两次没有留下有效发言`);
    }
    const visibleText = parseWerewolfGameReply(String(payload.text));
    if (visibleText) return visibleText;
  }
  throw new Error(`${agent.name} 连续两次只输出了局中禁用的记忆内容，均已拦截`);
}

function completeGameHistory(game, viewerId) {
  return visibleWerewolfLog(game, viewerId)
    .filter((entry) => entry.phase !== "debrief")
    .map((entry) => {
      const channel = entry.visibility === "public" ? "公屏" : entry.visibility;
      return `第${entry.day}天／夜｜${channel}｜${entry.author}：${entry.text}`;
    })
    .join("\n")
    .slice(-45_000);
}

function latestDebriefUserMessage(game, viewerId) {
  return [...visibleWerewolfLog(game, viewerId)]
    .reverse()
    .find((entry) => entry.phase === "debrief" && entry.authorId === WEREWOLF_USER_ID)?.text || "";
}

function explicitMemoryRequest(value) {
  return /(?:记住|记一下|记下来|私人记忆|写进.{0,8}记忆|存进.{0,8}记忆|记到.{0,8}记忆)/.test(String(value || ""));
}

async function repairDebriefFormats(agent, game, player, signal, sourceText, {
  needDiary = false,
  needMemory = false,
} = {}) {
  if (!needDiary && !needMemory) return { diaryItems: [], memoryItems: [] };
  const required = [
    needDiary ? "必须补交 <game_diary>，写 2～4 条第一人称局内私人日记。" : "不要输出 <game_diary>。",
    needMemory ? "晨曦明确要求写入长期私人记忆；必须补交 <self_memory>，写 1～2 条第一人称长期记忆。" : "不要输出 <self_memory>。",
  ].join("\n");
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent,
      requestMode: "werewolf-game",
      temperature: 0.3,
      maxTokens: DEBRIEF_FORMAT_TOKEN_ALLOWANCE + (needMemory ? PRIVATE_MEMORY_TOKEN_ALLOWANCE : 0),
      messages: [
        { role: "system", content: [
          `你是“${agent.name}”。刚才的狼人杀复盘正文已经发送，但机器便笺格式缺失。`,
          "现在只补机器标签，不要重写公开正文，不要写标题、解释、卷宗格式或 Markdown 代码块。",
          required,
        ].join("\n") },
        { role: "user", content: `你刚才的复盘正文：\n${String(sourceText || "").slice(0, 4_000)}` },
      ],
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !String(payload.text || "").trim()) return { diaryItems: [], memoryItems: [] };
  // parseAgentReply intentionally rejects a bare memory tag in ordinary chat.
  // The hidden repair path is tag-only by design, so add a disposable sentinel.
  const parsed = parseWerewolfDebriefReply(`格式补交\n${String(payload.text)}`, { agentId: agent.id, recipients: [] });
  return { diaryItems: parsed.diaryItems, memoryItems: parsed.memoryItems };
}

export async function requestWerewolfDebrief(agent, game, player, signal, {
  agents = [],
  defaultPrivateToUser = false,
} = {}) {
  const recap = game.debrief?.recap || "";
  const visibleLog = visibleWerewolfLog(game, agent.id);
  const recentDebrief = visibleLog
    .filter((entry) => entry.phase === "debrief")
    .slice(-24)
    .map((entry) => `${entry.author}：${entry.text}`)
    .join("\n");
  const system = [
    `你是“${agent.name}”。狼人杀已经结束，你当局的真实身份是${WEREWOLF_ROLE_META[player.role].label}。`,
    agent.persona?.trim() ? `你平时的个人设定：\n${agent.persona.trim().slice(0, 4_000)}` : "保持你平时自然的判断与说话方式。",
    privateMemoryContext(agent),
    "这份复盘只公开本局卷宗，不会向你提供其他旧局原文、旧复盘或旧局私人日记；属于你自己的长期私人记忆仍可使用。",
    "现在所有身份、狼队密谈、验人、女巫行动、刀口、票型和遗言都已经公开。你可以认错、邀功、吐槽、反驳、追问或清算，但不要继续把游戏里的假身份当事实硬演。",
    "本局卷宗与赛后公开发言不会整包灌进普通聊天室总结或长期私人记忆；只有你在 <self_memory> 中亲自挑选的少量长期认识才会保存。",
    "说人话，不要只写分析报告，也不要替别人宣布感受。",
    "公开复盘只说一个最值得回应的新观点，控制在 160～320 个简体中文字、1～3 个短段落；不要重抄身份表、逐日流水账或别人刚说过的结论。字数是上限，不是必须写满。",
    privateMessageOutputInstruction(agent, agents, { defaultPrivateToUser }),
    gameDiaryOutputInstruction(agent),
    privateMemoryOutputInstruction(agent),
    privateMessageImmediateReminder({ defaultPrivateToUser }),
    privateMemoryImmediateReminder(agent, { defaultPrivateToUser }),
    "【最终输出顺序】公开复盘正文（直接私聊时是保密正文）→ 可选 <private_message> → 必交 <game_diary> → 可选 <self_memory>。机器标签不要出现在公开正文里。",
  ].join("\n\n");
  const latestUserMessage = latestDebriefUserMessage(game, agent.id);
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent,
      requestMode: "werewolf-game",
      temperature: 0.9,
      maxTokens: DEBRIEF_VISIBLE_REPLY_TOKENS
        + DEBRIEF_FORMAT_TOKEN_ALLOWANCE
        + (agent.memoryEnabled ? PRIVATE_MEMORY_TOKEN_ALLOWANCE : 0),
      messages: [
        { role: "system", content: system },
        { role: "user", content: `【法官事实复盘】\n${recap}\n\n【本局完整卷宗】\n${completeGameHistory(game, agent.id)}\n\n【赛后茶话会最近发言】\n${recentDebrief || "还没人开口。"}\n\n现在轮到你复盘。优先回应晨曦最近点到你的内容；若没有明确追问，就只说你最想认领、解释或吐槽的一件事。` },
      ],
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${agent.name} 没有接通`);
  if (!String(payload.text || "").trim()) throw new Error(`${agent.name} 没有留下有效复盘`);
  const parsed = parseWerewolfDebriefReply(String(payload.text), { agentId: agent.id, recipients: agents });
  const needMemory = agent.memoryEnabled === true && explicitMemoryRequest(latestUserMessage) && !parsed.memoryItems.length;
  if (parsed.diaryItems.length < 2 || needMemory) {
    const repaired = await repairDebriefFormats(agent, game, player, signal, parsed.text, {
      needDiary: parsed.diaryItems.length < 2,
      needMemory,
    });
    parsed.diaryItems = [...parsed.diaryItems, ...repaired.diaryItems].slice(0, 4);
    parsed.memoryItems.push(...repaired.memoryItems);
  }
  if (!parsed.text && !parsed.privateMessages.length) {
    throw new Error(`${agent.name} 只交了机器便笺，没有留下复盘正文或私聊`);
  }
  rememberAgent(agent, parsed.memoryItems);
  return parsed;
}

export function validTargets(game, playerId, { wolvesExcluded = false, candidateIds = null, includeSelf = false } = {}) {
  const candidates = livingWerewolfPlayers(game).filter((player) => includeSelf || player.id !== playerId);
  const allowed = candidateIds ? new Set(candidateIds) : null;
  return candidates.filter((player) => (
    (!wolvesExcluded || player.role !== "wolf")
    && (!allowed || allowed.has(player.id))
  ));
}

function fallbackTarget(players) {
  return players[0]?.id || null;
}

export function createWerewolfController({ getRoom, getRoomAgents, getAllAgents, persist, toast, copyText, openCopyFallback }) {
  const dialog = byId("werewolf-dialog");
  const setup = byId("werewolf-setup");
  const gameSection = byId("werewolf-game");
  const setupStatus = byId("werewolf-setup-status");
  const gameStatus = byId("werewolf-game-status");
  const advanceButton = byId("werewolf-advance");
  const stopButton = byId("werewolf-stop");
  const manualDealInput = byId("werewolf-manual-deal");
  const roomStage = byId("werewolf-room-stage");
  const roomEmpty = byId("werewolf-room-empty");
  const mainTable = byId("werewolf-main-table");
  const archiveButton = byId("werewolf-archive-game");
  const composer = byId("composer");
  const messageInput = byId("message-input");
  const messageRecipient = byId("message-recipient");
  const composerPrivacyNote = byId("composer-privacy-note");
  const sendButton = byId("send-button");
  const modeButtons = [...document.querySelectorAll("#mode-switch [data-mode]")];
  const modeHelp = byId("mode-help");
  const speakerControl = byId("speaker-control");
  const speakerSelect = byId("speaker-select");
  const speakerSelectLabel = byId("speaker-select-label");
  const speakerStatus = byId("director-speaker-status");
  const speakerList = byId("director-speaker-list");
  const actionControl = byId("director-action-control");
  const actionButton = byId("director-action-button");
  let running = false;
  let abortController = null;
  let speakingPlayerId = "";
  let gameSaveChain = Promise.resolve();
  let directorMode = "point";
  let renderedGameId = "";
  let logRenderLimit = HISTORY_WINDOW_BATCH;
  let logHistoryObserver = null;
  let loadingOlderLog = false;
  let logPullIntent = false;
  let logLastScrollTop = 0;
  let logLastTouchY = null;
  let archiveRoomId = "";
  let archiveOffset = 0;
  let archiveTotal = null;
  let archiveLoading = false;
  let loadedArchives = [];

  function game() {
    return getRoom()?.werewolf || null;
  }

  function agentFor(playerId) {
    return (getAllAgents?.() || getRoomAgents()).find((agent) => agent.id === playerId) || null;
  }

  function debriefAgents(current) {
    const participantIds = new Set(current.players
      .filter((player) => player.type === "agent")
      .map((player) => player.id));
    return (getAllAgents?.() || getRoomAgents()).filter((agent) => participantIds.has(agent.id));
  }

  function baseAvatar(author, authorId) {
    const avatar = String(agentFor(authorId)?.avatar || "").trim();
    if (/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(avatar)) {
      const image = document.createElement("img");
      image.className = "werewolf-avatar-face is-image";
      image.src = avatar;
      image.alt = `${author}的头像`;
      image.decoding = "async";
      return image;
    }
    const fallback = createElement("span", "werewolf-avatar-face is-fallback", String(author || "?").trim().slice(0, 1) || "?");
    fallback.setAttribute("aria-label", `${author}的默认头像`);
    return fallback;
  }

  function playerAvatar(current, author, authorId, className = "werewolf-entry-avatar") {
    const wrapper = createElement("span", className);
    const player = current ? werewolfPlayer(current, authorId) : null;
    if (!player) {
      wrapper.classList.add("is-plain-avatar");
      wrapper.append(baseAvatar(author, authorId));
      return wrapper;
    }
    const knowledge = viewerRoleKnowledge(current, player);
    if (knowledge.kind === "role") {
      const meta = WEREWOLF_ROLE_META[knowledge.role] || WEREWOLF_ROLE_META.villager;
      const image = document.createElement("img");
      image.className = "werewolf-role-badge";
      image.src = WEREWOLF_ROLE_AVATARS[knowledge.role] || WEREWOLF_ROLE_AVATARS.villager;
      image.alt = `${player.name}：${meta.label}`;
      image.decoding = "async";
      wrapper.classList.add("is-known-role", `is-role-${knowledge.role}`);
      wrapper.title = `${player.name} · ${meta.label}`;
      wrapper.append(image);
      return wrapper;
    }
    wrapper.append(baseAvatar(author, authorId));
    const marker = createElement("span", "werewolf-avatar-marker", knowledge.kind === "team" ? "✓" : "?");
    if (knowledge.kind === "team") {
      wrapper.classList.add("is-known-good");
      wrapper.title = `${player.name} · 已验为好人（具体身份未知）`;
      marker.setAttribute("aria-label", "已验为好人，具体身份未知");
    } else {
      wrapper.classList.add("is-hidden-role");
      wrapper.title = `${player.name} · 身份尚未公开`;
      marker.setAttribute("aria-label", "身份尚未公开");
    }
    wrapper.append(marker);
    return wrapper;
  }

  function logEntry(current, entry, { archived = false } = {}) {
    const secret = entry.visibility !== "public";
    const item = createElement("article", `werewolf-log-entry${entry.authorId === "system" ? " is-system" : ""}${secret ? " is-secret" : ""}`);
    const content = createElement("div", "werewolf-entry-content");
    const header = document.createElement("header");
    const privateRecipients = (entry.recipientIds || []).map((id) => (
      id === WEREWOLF_USER_ID ? "晨曦" : (werewolfPlayer(current, id)?.name || id)
    )).join("、");
    const route = secret
      ? entry.visibility === "private"
        ? `🔒 私聊给 ${privateRecipients || "指定对象"}`
        : { wolves: "🐺 狼队密谈", seer: "🔮 验人结果", witch: "🧪 女巫视角", god: "👁 法官暗牌" }[entry.visibility]
      : WEREWOLF_PHASE_META[entry.phase];
    const label = archived && !route ? entry.phase : route;
    header.append(createElement("span", "", `${entry.author}${label ? ` · ${label}` : ""}`), createElement("time", "", formatTime(entry.timestamp)));
    const body = createElement("p");
    appendBoldText(body, entry.text);
    body.classList.add("has-actions");
    const actions = createElement("div", "message-actions");
    const copyButton = createMessageActionButton("copy", `复制 ${entry.author} 的这条狼人杀消息`);
    copyButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (await copyText?.(entry.text)) toast("已复制");
      else {
        openCopyFallback?.(entry.text);
        toast("浏览器拦住了自动复制，已为你选中原文");
      }
    });
    const editButton = createMessageActionButton("edit", `修改 ${entry.author} 的这条狼人杀消息`);
    editButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void editWerewolfLogEntry(current.id, entry.id, { archived });
    });
    const deleteButton = createMessageActionButton("delete", `删除 ${entry.author} 的这条狼人杀消息`);
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteWerewolfLogEntry(current.id, entry.id, { archived });
    });
    actions.append(copyButton, editButton, deleteButton);
    body.append(actions);
    content.append(header, body);
    item.append(playerAvatar(current, entry.author, entry.authorId), content);
    item.addEventListener("click", (event) => {
      if (event.target.closest(".message-actions")) return;
      const wasVisible = item.classList.contains("is-actions-visible");
      for (const message of roomStage.querySelectorAll(".werewolf-log-entry.is-actions-visible")) {
        message.classList.remove("is-actions-visible");
      }
      if (!wasVisible) item.classList.add("is-actions-visible");
    });
    return item;
  }

  function configuredAgents() {
    return getRoomAgents().filter((agent) => (
      agent.baseUrl?.trim()
      && agent.model?.trim()
      && (agent.authType === "none" || agent.hasApiKey || agent.apiKey?.trim())
    ));
  }

  function persistGame() {
    const room = getRoom();
    const current = game();
    if (!room?.id || !current) return persist();
    current.updatedAt = Date.now();
    current.revision = Math.max(1, Number(current.revision) || 1) + 1;
    const gameSnapshot = JSON.parse(JSON.stringify(current));
    const save = async () => {
      const response = await fetch("/api/werewolf/current", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: room.id, game: gameSnapshot }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "狼人杀进度没有保存成功");
      const localGame = room.werewolf;
      if (
        payload.game?.id === localGame?.id
        && Number(payload.game.revision) > Number(localGame.revision)
      ) {
        room.werewolf = payload.game;
      }
      return payload.game;
    };
    gameSaveChain = gameSaveChain.then(save, save);
    return gameSaveChain;
  }

  async function persistAll() {
    await gameSaveChain.catch(() => undefined);
    return persist();
  }

  async function deleteWerewolfLogEntry(gameId, eventId, { archived = false } = {}) {
    if (running) {
      toast("先停下当前狼人杀发言，再删除消息");
      return;
    }
    const room = getRoom();
    if (!room?.id || !gameId || !eventId) return;
    if (!globalThis.confirm("删除这条狼人杀消息？\n\n只删除显示日志，不会改写身份、刀口、验人、用药、票型或胜负。")) return;
    try {
      const response = await fetch(`/api/werewolf/games/${encodeURIComponent(gameId)}/events/${encodeURIComponent(eventId)}?roomId=${encodeURIComponent(room.id)}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "狼人杀消息没有删除成功");
      if (room.werewolf?.id === gameId) {
        room.werewolf.log = room.werewolf.log.filter((entry) => entry.id !== eventId);
      }
      const localArchive = room.werewolfArchives?.find((entry) => entry.id === gameId);
      if (localArchive) localArchive.log = localArchive.log.filter((entry) => entry.id !== eventId);
      const record = loadedArchives.find((entry) => entry.game.id === gameId);
      if (record) {
        const before = record.game.log.length;
        record.game.log = record.game.log.filter((entry) => entry.id !== eventId);
        if (record.game.log.length !== before) {
          record.loadedEventCount = Math.max(0, record.loadedEventCount - 1);
          record.events.total = Math.max(0, Number(record.events.total) - 1);
        }
      }
      if (archived) renderArchives({ openGameId: gameId });
      else renderGame();
      toast(payload.deleted ? "这一条已经从狼人杀卷宗中删除" : "这条消息此前已经删除");
    } catch (error) {
      toast(error.message);
    }
  }

  async function editWerewolfLogEntry(gameId, eventId, { archived = false } = {}) {
    if (running) {
      toast("先停下当前狼人杀发言，再修改消息");
      return;
    }
    const room = getRoom();
    if (!room?.id || !gameId || !eventId) return;
    const sources = [
      room.werewolf,
      ...(room.werewolfArchives || []),
      ...loadedArchives.map((record) => record.game),
    ].filter((entry) => entry?.id === gameId);
    const existing = sources.flatMap((entry) => entry.log || []).find((entry) => entry.id === eventId);
    if (!existing) {
      toast("没有找到这条狼人杀消息");
      return;
    }
    let nextText;
    try {
      nextText = await openMessageEditor({
        title: `修改 ${existing.author} 的狼人杀消息`,
        description: "只修改卷宗里的显示文字，不会改写身份、刀口、验人、用药、票型或胜负。",
        value: existing.text,
      });
    } catch (error) {
      toast(error.message);
      return;
    }
    if (nextText === null) return;
    const cleanText = String(nextText).trim();
    if (!cleanText) {
      toast("内容不能为空；要移除这条请用删除");
      return;
    }
    if (cleanText === existing.text) return;
    try {
      const response = await fetch(`/api/werewolf/games/${encodeURIComponent(gameId)}/events/${encodeURIComponent(eventId)}?roomId=${encodeURIComponent(room.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: cleanText }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "狼人杀消息没有修改成功");
      for (const source of sources) {
        const item = source.log?.find((entry) => entry.id === eventId);
        if (item) item.text = payload.text || cleanText;
      }
      if (archived) renderArchives({ openGameId: gameId });
      else renderGame();
      toast(payload.updated ? "这一条已经改好并同步到狼人杀卷宗" : "这条消息此前已经是这个内容");
    } catch (error) {
      toast(error.message);
    }
  }

  function saveDebriefDiary(current, agent, diaryItems) {
    let saved = false;
    for (const body of Array.isArray(diaryItems) ? diaryItems : []) {
      const entry = appendWerewolfPrivateDiary(current, {
        authorId: agent.id,
        body,
        audienceIds: [WEREWOLF_USER_ID, agent.id],
      });
      saved ||= Boolean(entry);
    }
    return saved;
  }

  function appendDebriefReply(current, player, agent, reply, { defaultPrivateToUser = false } = {}) {
    if (reply.text) {
      appendWerewolfLog(current, {
        visibility: defaultPrivateToUser ? "private" : "public",
        recipientIds: defaultPrivateToUser ? [WEREWOLF_USER_ID] : [],
        authorId: player.id,
        author: player.name,
        text: reply.text,
        phase: "debrief",
      });
    }
    for (const privateMessage of reply.privateMessages || []) {
      appendWerewolfLog(current, {
        visibility: "private",
        recipientIds: privateMessage.recipientIds,
        authorId: player.id,
        author: player.name,
        text: privateMessage.text,
        phase: "debrief",
      });
    }
    saveDebriefDiary(current, agent, reply.diaryItems);
  }

  function setGameStatus(message, isError = false) {
    gameStatus.textContent = message;
    gameStatus.classList.toggle("is-error", isError);
  }

  function setupSelectionLimits() {
    const viewMode = selectedRadio("werewolf-view", "player");
    byId("werewolf-player-help").textContent = viewMode === "player"
      ? "玩家模式请选择 5～6 位 AI（加上曦曦共 6～7 人）。"
      : "上帝模式请选择 6～7 位 AI（曦曦只围观，不占身份牌）。";
    byId("werewolf-manual-toggle").classList.toggle("is-hidden", viewMode !== "god");
    renderRoleAssignment();
    updateSetupStatus();
  }

  function selectedAgentIds() {
    return [...byId("werewolf-participant-list").querySelectorAll("input:checked")].map((input) => input.value);
  }

  function manualDealEnabled() {
    return selectedRadio("werewolf-view", "player") === "god" && manualDealInput.checked;
  }

  function selectedRoleAssignments() {
    return Object.fromEntries([...byId("werewolf-role-assignment-list").querySelectorAll("select")]
      .map((select) => [select.dataset.playerId, select.value]));
  }

  function roleAssignmentsAreValid(assignments, playerCount) {
    if (![6, 7].includes(playerCount)) return false;
    const selectedRoles = Object.values(assignments).sort().join("|");
    return selectedRoles === werewolfRoleDeck(playerCount).sort().join("|");
  }

  function renderRoleAssignment() {
    const fieldset = byId("werewolf-role-assignment");
    const list = byId("werewolf-role-assignment-list");
    const enabled = manualDealEnabled();
    fieldset.classList.toggle("is-hidden", !enabled);
    if (!enabled) return;
    const previous = selectedRoleAssignments();
    const ids = selectedAgentIds();
    const agentsById = new Map(configuredAgents().map((agent) => [agent.id, agent]));
    const defaults = [6, 7].includes(ids.length) ? werewolfRoleDeck(ids.length) : [];
    list.replaceChildren();
    ids.forEach((id, index) => {
      const row = createElement("label", "werewolf-role-assignment-row");
      const select = document.createElement("select");
      select.dataset.playerId = id;
      for (const [role, meta] of Object.entries(WEREWOLF_ROLE_META)) {
        const option = document.createElement("option");
        option.value = role;
        option.textContent = `${meta.icon} ${meta.label}`;
        select.append(option);
      }
      select.value = previous[id] || defaults[index] || "villager";
      select.addEventListener("change", updateSetupStatus);
      row.append(createElement("span", "", agentsById.get(id)?.name || id), select);
      list.append(row);
    });
  }

  function updateSetupStatus() {
    const count = selectedAgentIds().length;
    const playerCount = count + (selectedRadio("werewolf-view", "player") === "player" ? 1 : 0);
    const validCount = playerCount === 6 || playerCount === 7;
    const validRoles = !manualDealEnabled() || roleAssignmentsAreValid(selectedRoleAssignments(), playerCount);
    const valid = validCount && validRoles;
    setupStatus.textContent = !validCount
      ? `现在共 ${playerCount} 位玩家，还需要凑成 6 或 7 人。`
      : !validRoles
        ? "身份牌数量不对：需要正好 2 狼、1 预言家、1 女巫，其余村民。"
        : `已选 ${count} 位 AI，本局共 ${playerCount} 位玩家。${manualDealEnabled() ? "身份由曦曦亲手安排。" : "身份随机洗牌。"}`;
    setupStatus.classList.toggle("is-error", !valid);
    byId("start-werewolf-game").disabled = !valid || running;
  }

  function renderParticipantSetup() {
    const list = byId("werewolf-participant-list");
    const agents = configuredAgents();
    const previous = new Set(selectedAgentIds());
    list.replaceChildren();
    agents.forEach((agent, index) => {
      const label = createElement("label", "werewolf-participant");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = agent.id;
      input.checked = previous.size ? previous.has(agent.id) : index < 6;
      input.addEventListener("change", () => {
        renderRoleAssignment();
        updateSetupStatus();
      });
      label.append(input, createElement("span", "", agent.name));
      list.append(label);
    });
    if (!agents.length) list.append(createElement("p", "field-help", "本房间还没有配置好接口的 AI 嘉宾。"));
    setupSelectionLimits();
  }

  function renderRoleCard(current) {
    const card = byId("werewolf-role-card");
    card.replaceChildren();
    if (current.status === "ended") {
      const result = current.winner === "wolf" ? "狼人胜利" : current.winner === "good" ? "好人胜利" : "本局提前结束";
      card.append(createElement("strong", "", `📜 复盘卷宗 · ${result}`));
      const roles = current.players.map((player) => `${player.name}＝${WEREWOLF_ROLE_META[player.role].label}`).join("；");
      card.append(createElement("p", "", roles));
      return;
    }
    if (current.viewMode === "god") {
      card.append(createElement("strong", "", "👁 上帝席已开全视野"));
      card.append(createElement("p", "", current.players.map((player) => `${player.name}＝${WEREWOLF_ROLE_META[player.role].label}`).join("；")));
      return;
    }
    const user = werewolfPlayer(current, WEREWOLF_USER_ID);
    const meta = WEREWOLF_ROLE_META[user?.role] || WEREWOLF_ROLE_META.villager;
    card.append(createElement("strong", "", `${meta.icon} 你的身份：${meta.label}`));
    const extra = user?.role === "wolf"
      ? `狼队友：${current.players.filter((player) => player.role === "wolf" && player.id !== WEREWOLF_USER_ID).map((player) => player.name).join("、")}`
      : roleKnowledge(current, user || { role: "villager" });
    card.append(createElement("p", "", extra));
  }

  function renderPlayerBoard(current) {
    const board = byId("werewolf-player-board");
    board.replaceChildren();
    for (const player of current.players) {
      const knowledge = viewerRoleKnowledge(current, player);
      const visible = knowledge.kind === "role";
      const chip = createElement("div", `werewolf-player-chip${player.alive ? "" : " is-dead"}${visible && knowledge.role === "wolf" ? " is-wolf" : ""}${knowledge.kind === "team" ? " is-known-good" : ""}`);
      chip.append(
        playerAvatar(current, player.name, player.id, "werewolf-player-avatar"),
        createElement("strong", "werewolf-player-name", player.name),
        createElement("span", "werewolf-player-state", player.alive
          ? (visible ? WEREWOLF_ROLE_META[knowledge.role].label : knowledge.kind === "team" ? "已验好人" : "存活")
          : `${visible ? `${WEREWOLF_ROLE_META[knowledge.role].label} · ` : knowledge.kind === "team" ? "已验好人 · " : ""}已离场`),
      );
      board.append(chip);
    }
  }

  function revealOlderLog(current) {
    const entries = visibleWerewolfLog(current);
    if (loadingOlderLog || logRenderLimit >= entries.length) return;
    loadingOlderLog = true;
    logPullIntent = false;
    logRenderLimit = nextHistoryWindowLimit(entries.length, logRenderLimit);
    renderLog(current, { preservePrepend: true });
  }

  function roomStageOwnsScroll() {
    return roomStage.scrollHeight > roomStage.clientHeight + 2;
  }

  function logScrollMetrics() {
    if (roomStageOwnsScroll()) {
      return { owner: roomStage, top: roomStage.scrollTop, height: roomStage.scrollHeight };
    }
    const root = document.scrollingElement || document.documentElement;
    return { owner: window, top: window.scrollY || root.scrollTop || 0, height: root.scrollHeight };
  }

  function restoreLogScroll(owner, top) {
    if (owner === roomStage && roomStageOwnsScroll()) roomStage.scrollTop = top;
    else window.scrollTo({ top, behavior: "auto" });
  }

  function logLoaderIsNearView() {
    const loader = roomStage.querySelector(".werewolf-history-loader");
    if (!loader) return false;
    const loaderRect = loader.getBoundingClientRect();
    if (roomStageOwnsScroll()) {
      const stageRect = roomStage.getBoundingClientRect();
      return loaderRect.bottom >= stageRect.top - 56 && loaderRect.top <= stageRect.bottom + 56;
    }
    return loaderRect.bottom >= -56 && loaderRect.top <= window.innerHeight + 56;
  }

  function maybeRevealOlderLogFromPull() {
    const current = game();
    if (!current || !logPullIntent) return;
    if (logLoaderIsNearView()) {
      revealOlderLog(current);
      return;
    }
    const metrics = logScrollMetrics();
    if (metrics.top <= 72) void loadPreviousArchive({ preservePosition: true });
  }

  function handleLogScroll(event) {
    const metrics = logScrollMetrics();
    if ((event.currentTarget === window && metrics.owner !== window)
      || (event.currentTarget === roomStage && metrics.owner !== roomStage)) return;
    if (metrics.top < logLastScrollTop - 1) logPullIntent = true;
    logLastScrollTop = metrics.top;
    maybeRevealOlderLogFromPull();
  }

  function createLogHistoryLoader(current, hiddenCount) {
    const button = createElement(
      "button",
      "history-window-loader werewolf-history-loader",
      `↑ 还有 ${hiddenCount} 条较早记录，继续上拉或点这里`,
    );
    button.type = "button";
    button.addEventListener("click", () => revealOlderLog(current));
    return button;
  }

  function observeLogHistoryLoader(current, loader) {
    logHistoryObserver?.disconnect();
    logHistoryObserver = null;
    if (!loader || typeof IntersectionObserver !== "function") return;
    logHistoryObserver = new IntersectionObserver((entries) => {
      if (logPullIntent && entries.some((entry) => entry.isIntersecting)) revealOlderLog(current);
    }, { root: roomStageOwnsScroll() ? roomStage : null, rootMargin: "56px 0px 0px" });
    logHistoryObserver.observe(loader);
  }

  function renderLog(current, { preservePrepend = false } = {}) {
    const log = byId("werewolf-log");
    if (!log) return;
    if (renderedGameId !== current.id) {
      renderedGameId = current.id;
      logRenderLimit = HISTORY_WINDOW_BATCH;
      logPullIntent = false;
    }
    const previousScroll = logScrollMetrics();
    const windowed = historyWindow(visibleWerewolfLog(current), logRenderLimit);
    logHistoryObserver?.disconnect();
    logHistoryObserver = null;
    log.replaceChildren();
    const historyLoader = windowed.hiddenCount
      ? createLogHistoryLoader(current, windowed.hiddenCount)
      : null;
    if (historyLoader) log.append(historyLoader);
    for (const entry of windowed.items) {
      log.append(logEntry(current, entry));
    }
    if (preservePrepend) {
      requestAnimationFrame(() => {
        const currentScroll = logScrollMetrics();
        const addedHeight = Math.max(0, currentScroll.height - previousScroll.height);
        restoreLogScroll(previousScroll.owner, previousScroll.top + addedHeight);
        logLastScrollTop = previousScroll.top + addedHeight;
        loadingOlderLog = false;
        observeLogHistoryLoader(current, historyLoader);
      });
      return;
    }
    loadingOlderLog = false;
    observeLogHistoryLoader(current, historyLoader);
    log.dataset.rendered = "true";
  }

  function archiveResultLabel(archived) {
    if (archived.winner === "wolf") return "狼人胜利";
    if (archived.winner === "good") return "好人胜利";
    return "提前结束";
  }

  function resetArchiveHistoryIfNeeded() {
    const roomId = getRoom()?.id || "";
    if (archiveRoomId === roomId) return;
    archiveRoomId = roomId;
    archiveOffset = 0;
    archiveTotal = null;
    archiveLoading = false;
    loadedArchives = [];
  }

  function archiveFallbackAt(offset) {
    const archives = [...(getRoom()?.werewolfArchives || [])].reverse();
    const game = archives[offset] || null;
    return game ? {
      game,
      events: { offset: 0, limit: HISTORY_WINDOW_BATCH, total: game.log.length, hasMore: false },
      loadedEventCount: game.log.length,
      logRenderLimit: HISTORY_WINDOW_BATCH,
      source: "json",
    } : null;
  }

  async function fetchArchiveRecord(offset) {
    const roomId = getRoom()?.id;
    if (!roomId) return null;
    const catalogResponse = await fetch(`/api/werewolf/archives?roomId=${encodeURIComponent(roomId)}&offset=${offset}&limit=1`, {
      cache: "no-store",
    });
    if (!catalogResponse.ok) throw new Error("数据库历史目录暂时不可用");
    const catalog = await catalogResponse.json();
    archiveTotal = Number(catalog.total) || 0;
    const metadata = catalog.items?.[0];
    if (!metadata) return null;
    const gameResponse = await fetch(`/api/werewolf/games/${encodeURIComponent(metadata.id)}?roomId=${encodeURIComponent(roomId)}&offset=0&limit=${HISTORY_WINDOW_BATCH}`, {
      cache: "no-store",
    });
    if (!gameResponse.ok) throw new Error("数据库卷宗正文暂时不可用");
    const payload = await gameResponse.json();
    return {
      game: payload.game,
      events: payload.events,
      loadedEventCount: payload.game?.log?.length || 0,
      logRenderLimit: HISTORY_WINDOW_BATCH,
      source: "database",
    };
  }

  async function loadPreviousArchive({ preservePosition = false } = {}) {
    resetArchiveHistoryIfNeeded();
    if (archiveLoading || (archiveTotal !== null && archiveOffset >= archiveTotal)) return;
    archiveLoading = true;
    logPullIntent = false;
    const previousScroll = logScrollMetrics();
    try {
      let record;
      try {
        record = await fetchArchiveRecord(archiveOffset);
      } catch {
        record = archiveFallbackAt(archiveOffset);
        if (archiveTotal === null) archiveTotal = getRoom()?.werewolfArchives?.length || 0;
      }
      if (!record) {
        archiveTotal = Math.min(archiveTotal ?? archiveOffset, archiveOffset);
        archiveLoading = false;
        renderArchives();
        return;
      }
      loadedArchives.push(record);
      archiveOffset += 1;
      archiveLoading = false;
      renderArchives();
      if (preservePosition) {
        requestAnimationFrame(() => {
          const nextScroll = logScrollMetrics();
          const addedHeight = Math.max(0, nextScroll.height - previousScroll.height);
          restoreLogScroll(previousScroll.owner, previousScroll.top + addedHeight);
          logLastScrollTop = previousScroll.top + addedHeight;
        });
      }
    } finally {
      archiveLoading = false;
    }
  }

  async function loadOlderArchiveEvents(record, details) {
    if (record.source !== "database" || !record.events?.hasMore || archiveLoading) {
      record.logRenderLimit = nextHistoryWindowLimit(record.game.log.length, record.logRenderLimit);
      renderArchives();
      return;
    }
    archiveLoading = true;
    const previousScroll = logScrollMetrics();
    try {
      const roomId = getRoom()?.id || "";
      const response = await fetch(`/api/werewolf/games/${encodeURIComponent(record.game.id)}?roomId=${encodeURIComponent(roomId)}&offset=${record.loadedEventCount}&limit=${HISTORY_WINDOW_BATCH}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("更早的局内记录暂时没有加载成功");
      const payload = await response.json();
      const known = new Set(record.game.log.map((entry) => entry.id));
      const older = (payload.game?.log || []).filter((entry) => !known.has(entry.id));
      record.game.log = [...older, ...record.game.log];
      record.loadedEventCount += payload.game?.log?.length || 0;
      record.events = payload.events;
      record.logRenderLimit = nextHistoryWindowLimit(record.game.log.length, record.logRenderLimit);
      archiveLoading = false;
      renderArchives({ openGameId: record.game.id });
      requestAnimationFrame(() => {
        const nextScroll = logScrollMetrics();
        const addedHeight = Math.max(0, nextScroll.height - previousScroll.height);
        restoreLogScroll(previousScroll.owner, previousScroll.top + addedHeight);
        logLastScrollTop = previousScroll.top + addedHeight;
      });
    } catch (error) {
      toast(error.message);
      details.open = true;
    } finally {
      archiveLoading = false;
    }
  }

  function archiveDiarySection(archived) {
    const section = createElement("section", "werewolf-archive-diaries");
    section.append(createElement("strong", "", "本局私人日记"));
    const diaries = visibleWerewolfPrivateDiaries(archived, WEREWOLF_USER_ID);
    if (!diaries.length) {
      section.append(createElement("p", "field-help", "本局没有留下私人日记。"));
      return section;
    }
    for (const diary of diaries) {
      const author = werewolfPlayer(archived, diary.authorId)?.name || diary.authorId;
      section.append(createElement("p", "field-help", `${author}：${diary.body}`));
    }
    return section;
  }

  function renderArchives({ openGameId = "" } = {}) {
    resetArchiveHistoryIfNeeded();
    const list = byId("werewolf-archive-list");
    const openIds = new Set([...list.querySelectorAll("details[open]")].map((item) => item.dataset.gameId));
    if (openGameId) openIds.add(openGameId);
    list.replaceChildren();
    const canLoadMore = archiveTotal === null || archiveOffset < archiveTotal;
    if (canLoadMore) {
      const loader = createElement(
        "button",
        "history-window-loader werewolf-archive-loader",
        archiveLoading ? "正在取上一局卷宗……" : "↑ 继续上拉或点这里，加载上一整局",
      );
      loader.type = "button";
      loader.disabled = archiveLoading;
      loader.addEventListener("click", () => void loadPreviousArchive({ preservePosition: true }));
      list.append(loader);
    }
    for (const record of [...loadedArchives].reverse()) {
      const archived = record.game;
      const details = createElement("details", "werewolf-archive-card");
      details.dataset.gameId = archived.id;
      details.open = openIds.has(archived.id);
      const summary = document.createElement("summary");
      const date = new Date(archived.archivedAt || archived.updatedAt).toLocaleDateString("zh-CN");
      summary.append(createElement("strong", "", `${archived.archiveTitle || archiveResultLabel(archived)}｜${date}｜展开/收起`));
      const recap = createElement("pre", "werewolf-archive-recap", archived.debrief?.recap || "本局没有生成事实复盘。");
      const transcript = createElement("div", "werewolf-archive-transcript");
      const renderTranscript = () => {
        transcript.replaceChildren();
        const windowed = historyWindow(archived.log, record.logRenderLimit);
        const remaining = Math.max(
          Number(record.events?.total) - Math.min(record.loadedEventCount, record.logRenderLimit),
          windowed.hiddenCount,
          0,
        );
        if (remaining > 0) {
          const loader = createElement("button", "history-window-loader", `↑ 本局还有 ${remaining} 条较早记录`);
          loader.type = "button";
          loader.addEventListener("click", () => void loadOlderArchiveEvents(record, details));
          transcript.append(loader);
        }
        for (const entry of windowed.items) transcript.append(logEntry(archived, entry, { archived: true }));
        transcript.dataset.rendered = "true";
      };
      details.addEventListener("toggle", () => {
        if (details.open && !transcript.dataset.rendered) renderTranscript();
      });
      details.append(summary, recap, archiveDiarySection(archived), transcript);
      if (details.open) renderTranscript();
      list.append(details);
    }
  }

  function speechPlayerIds(current, tiedOnly = current.phase === "tie_speech") {
    return werewolfSpeechSeatIds(current, tiedOnly);
  }

  function playerHasSpoken(current, playerId, tiedOnly = current.phase === "tie_speech") {
    return werewolfPlayerHasSpoken(current, playerId, tiedOnly);
  }

  function allSpeakersDone(current, tiedOnly = current.phase === "tie_speech") {
    return speechPlayerIds(current, tiedOnly).every((id) => playerHasSpoken(current, id, tiedOnly));
  }

  function directorHelp(snapshot) {
    if (snapshot.kind === "setup") return "先从“身份与行动”开一局，导演台会在白天自动解锁。";
    if (snapshot.kind === "locked") return "夜晚、投票和遗言阶段暂不开放导演台，请去“身份与行动”完成本阶段。";
    if (snapshot.kind === "debrief") {
      if (directorMode === "point") return "可反复点名同一位嘉宾追问；主输入框仍可公开或私聊。";
      if (directorMode === "roundtable") return "每次都按座位顺序请全体嘉宾复盘，不限制轮数。";
      return "从全部嘉宾中本地随机抽一位复盘，不会额外调用意愿评分。";
    }
    if (!snapshot.eligibleSpeakerIds.length) return "可点名的 AI 嘉宾都已发言；晨曦仍可用主输入框最后压轴。";
    if (directorMode === "point") return snapshot.tiedOnly
      ? "只列出进入平票的候选人；点一位只调用一位。"
      : "只列出尚未发言的存活嘉宾；晨曦可以一直等到最后再用主输入框发言。";
    if (directorMode === "roundtable") return "按座位顺序依次请尚未发言的存活嘉宾发言，已发言者会自动跳过。";
    return "从尚未发言的存活嘉宾中本地随机抽一位，只调用抽中的嘉宾，不做 AI 评分。";
  }

  function directorActionCopy(snapshot) {
    if (snapshot.locked) return "当前阶段已锁定";
    if (directorMode === "point") return snapshot.kind === "debrief" ? "请 TA 复盘" : "请 TA 发言";
    if (directorMode === "roundtable") return snapshot.kind === "debrief" ? "开始全体圆桌" : "开始依次圆桌";
    return "随机抽一位";
  }

  function renderDirector() {
    if (getRoom()?.roomType !== "werewolf") return;
    const current = game();
    const snapshot = werewolfDirectorSnapshot(current, { speakingPlayerId });
    const labels = { point: "点名", roundtable: "依次圆桌", free: "随机" };
    for (const button of modeButtons) {
      button.textContent = labels[button.dataset.mode] || button.textContent;
      button.classList.toggle("is-active", button.dataset.mode === directorMode);
      button.disabled = running || snapshot.locked;
    }
    for (const element of document.querySelectorAll("#director-panel [data-director-chat-only]")) {
      element.classList.add("is-hidden");
    }
    byId("free-strategy-control").classList.add("is-hidden");
    byId("rounds-control").classList.add("is-hidden");
    speakerStatus.classList.remove("is-hidden");
    actionControl.classList.remove("is-hidden");
    modeHelp.textContent = directorHelp(snapshot);
    speakerSelectLabel.textContent = snapshot.kind === "debrief" ? "点名复盘" : snapshot.tiedOnly ? "平票候选人" : "下一位发言";
    const previous = speakerSelect.value;
    speakerSelect.replaceChildren();
    for (const playerId of snapshot.eligibleSpeakerIds) {
      const row = snapshot.roster.find((item) => item.id === playerId);
      if (!row) continue;
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = `${row.seat} 号 · ${row.name}`;
      speakerSelect.append(option);
    }
    if (snapshot.eligibleSpeakerIds.includes(previous)) speakerSelect.value = previous;
    speakerSelect.disabled = running || snapshot.locked || !snapshot.eligibleSpeakerIds.length;
    speakerControl.classList.toggle("is-hidden", directorMode !== "point" || snapshot.locked);
    speakerList.replaceChildren();
    for (const row of snapshot.roster) {
      const item = createElement("div", `director-speaker-item${row.speaking ? " is-speaking" : ""}${row.spoken ? " is-done" : ""}${!row.alive ? " is-eliminated" : ""}`);
      item.dataset.playerId = row.id;
      item.append(
        createElement("span", "director-speaker-seat", String(row.seat).padStart(2, "0")),
        createElement("strong", "director-speaker-name", row.name),
        createElement("span", "director-speaker-state", row.status),
      );
      speakerList.append(item);
    }
    if (!snapshot.roster.length) speakerList.append(createElement("p", "field-help", "开局后这里会显示发言状态。"));
    actionButton.textContent = directorActionCopy(snapshot);
    actionButton.disabled = running
      || snapshot.locked
      || !snapshot.eligibleSpeakerIds.length
      || (directorMode === "point" && !speakerSelect.value);
  }

  function setDirectorMode(mode) {
    if (!["point", "roundtable", "free"].includes(mode)) return;
    directorMode = mode;
    renderDirector();
  }

  async function runDirectorAction() {
    const current = game();
    const snapshot = werewolfDirectorSnapshot(current, { speakingPlayerId });
    if (!current || snapshot.locked || running || !snapshot.eligibleSpeakerIds.length) return;
    if (directorMode === "roundtable") {
      if (snapshot.kind === "debrief") await runDebriefRound();
      else await runSpeechRound(snapshot.tiedOnly);
      return;
    }
    const playerId = directorMode === "free"
      ? pickWerewolfDirectorSpeaker(snapshot.eligibleSpeakerIds)
      : speakerSelect.value;
    if (!playerId || !snapshot.eligibleSpeakerIds.includes(playerId)) return;
    if (snapshot.kind === "debrief") await runDebriefSpeaker(playerId);
    else await runSpeechSpeaker(playerId, snapshot.tiedOnly);
  }

  function selectField(id, labelText, candidates, selected = "") {
    const wrapper = createElement("div");
    const label = createElement("label", "", labelText);
    label.htmlFor = id;
    const select = document.createElement("select");
    select.id = id;
    optionList(select, candidates, { selected });
    wrapper.append(label, select);
    return wrapper;
  }

  function textareaField(id, labelText, placeholder = "") {
    const wrapper = createElement("div");
    const label = createElement("label", "", labelText);
    label.htmlFor = id;
    const textarea = document.createElement("textarea");
    textarea.id = id;
    textarea.placeholder = placeholder;
    wrapper.append(label, textarea);
    return wrapper;
  }

  function renderReview(current, panel) {
    panel.append(createElement("strong", "werewolf-action-title", "本局行动记录"));
    for (const night of current.nights) {
      const deaths = namesFor(current, night.deaths || []) || "平安夜";
      panel.append(createElement("p", "field-help", `第 ${night.day} 夜：狼刀 ${namesFor(current, [night.killTargetId].filter(Boolean)) || "无"}；验人 ${namesFor(current, [night.seerTargetId].filter(Boolean)) || "无"}；解药 ${night.witchSave ? "使用" : "未用"}；毒药 ${namesFor(current, [night.poisonTargetId].filter(Boolean)) || "未用"}；出局 ${deaths}`));
    }
    for (const day of current.days) {
      panel.append(createElement("p", "field-help", `第 ${day.day} 天：投票结果 ${Object.entries(day.voteCounts || {}).map(([id, count]) => `${werewolfPlayer(current, id)?.name || id} ${count}票`).join("、") || "无"}；放逐 ${namesFor(current, [day.eliminatedId].filter(Boolean)) || "无人"}`));
    }
    const diaries = visibleWerewolfPrivateDiaries(current, WEREWOLF_USER_ID);
    if (diaries.length) {
      panel.append(createElement("strong", "werewolf-action-title", "本局私人日记"));
      for (const diary of diaries) {
        const author = werewolfPlayer(current, diary.authorId)?.name || diary.authorId;
        panel.append(createElement("p", "field-help", `${author}：${diary.body}`));
      }
    }
  }

  function renderActionPanel(current) {
    const panel = byId("werewolf-action-panel");
    panel.replaceChildren();
    if (current.status === "ended") {
      renderReview(current, panel);
      return;
    }
    const user = werewolfPlayer(current, WEREWOLF_USER_ID);
    if (current.viewMode === "god" || !user?.alive) return;
    const living = livingWerewolfPlayers(current);
    if (current.phase === "night_wolves" && user.role === "wolf" && !current.pending?.userWolfReady) {
      panel.append(createElement("strong", "werewolf-action-title", "🐺 狼队今晚刀谁？你写的话只给狼队看。"));
      const grid = createElement("div", "werewolf-action-grid");
      grid.append(
        selectField("werewolf-user-target", "落刀目标（允许自刀或刀狼队友）", validTargets(current, user.id, { includeSelf: true })),
        textareaField("werewolf-user-secret", "给狼队的话（可空）", "可以骗、倒钩、商量战术……"),
      );
      panel.append(grid);
    } else if (current.phase === "night_seer" && user.role === "seer" && !current.pending?.userSeerReady) {
      panel.append(selectField("werewolf-user-check", "🔮 今晚验谁？", validTargets(current, user.id)));
    } else if (current.phase === "night_witch" && user.role === "witch" && !current.pending?.userWitchReady) {
      const night = currentNight(current);
      panel.append(createElement("strong", "werewolf-action-title", `🧪 今晚倒牌的是：${werewolfPlayer(current, night.killTargetId)?.name || "无人"}`));
      const grid = createElement("div", "werewolf-action-grid");
      if (current.witch.healAvailable && night.killTargetId) {
        const saveLabel = createElement("label", "werewolf-radio");
        const save = document.createElement("input");
        save.type = "checkbox";
        save.id = "werewolf-user-save";
        saveLabel.append(save, createElement("span", "", "使用解药救人"));
        grid.append(saveLabel);
      }
      if (current.witch.poisonAvailable) grid.append(selectField("werewolf-user-poison", "毒谁（可不选）", validTargets(current, user.id)));
      panel.append(grid);
    } else if (current.phase === "day_speech") {
      const day = currentDay(current);
      if (!day.speeches[user.id]) {
        panel.append(createElement("p", "field-help", "曦曦的白天发言请直接写在主页面下方输入框；想压轴就先点其他人。"));
      } else if (current.costMode === "economy" && !day.provisionalVotes[user.id]) {
        panel.append(selectField("werewolf-user-vote", "省钱局：曦曦发言后补交这一票", validTargets(current, user.id)));
      } else {
        panel.append(createElement("p", "field-help", "曦曦已经发言。等所有存活玩家说完即可进入下一阶段。"));
      }
    } else if (current.phase === "day_vote") {
      panel.append(selectField("werewolf-user-vote", "🗳️ 曦曦这一票投给谁？", validTargets(current, user.id)));
    } else if (current.phase === "tie_speech" && current.pending?.tieIds?.includes(user.id)) {
      panel.append(createElement("p", "field-help", playerHasSpoken(current, user.id, true)
        ? "平票辩护已经说完。"
        : "平票辩护请直接写在主页面下方输入框。"));
    } else if (current.phase === "tie_vote") {
      panel.append(selectField("werewolf-user-tie-vote", "平票重投", validTargets(current, user.id, { candidateIds: current.pending?.tieIds || [] })));
    } else if (current.phase === "last_words" && current.pending?.eliminatedId === user.id) {
      panel.append(createElement("p", "field-help", current.pending.userLastWordsReady
        ? "遗言已经留下，可以让法官继续。"
        : "遗言请直接写在主页面下方输入框。"));
    }
  }

  function phaseButtonCopy(current) {
    if (current.status === "ended") return "复盘进行中";
    return {
      night_wolves: "收狼刀",
      night_seer: "完成验人",
      night_witch: "女巫落药",
      dawn: "宣布天亮",
      day_speech: allSpeakersDone(current, false) ? (current.costMode === "economy" ? "结算发言与投票" : "进入公开投票") : "等待全员发言",
      day_vote: "开始公开投票",
      tie_speech: allSpeakersDone(current, true) ? "进入平票重投" : "等待辩护完成",
      tie_vote: "开始平票重投",
      last_words: "留下遗言",
    }[current.phase] || "推进本阶段";
  }

  function syncWerewolfComposer(current) {
    const isRoom = getRoom()?.roomType === "werewolf";
    if (!isRoom) return;
    const user = current ? werewolfPlayer(current, WEREWOLF_USER_ID) : null;
    const canDaySpeak = current?.status === "active"
      && current.viewMode === "player"
      && user?.alive
      && current.phase === "day_speech"
      && !playerHasSpoken(current, user.id, false);
    const canTieSpeak = current?.status === "active"
      && current.viewMode === "player"
      && user?.alive
      && current.phase === "tie_speech"
      && current.pending?.tieIds?.includes(user.id)
      && !playerHasSpoken(current, user.id, true);
    const canDebrief = current?.status === "ended";
    const canLastWords = current?.status === "active"
      && current.viewMode === "player"
      && current.phase === "last_words"
      && current.pending?.eliminatedId === user?.id
      && !current.pending?.userLastWordsReady;
    const enabled = Boolean(canDaySpeak || canTieSpeak || canLastWords || canDebrief);
    const previousRecipient = messageRecipient.value;
    messageRecipient.replaceChildren();
    const publicOption = document.createElement("option");
    publicOption.value = "public";
    publicOption.textContent = canDebrief ? "公开复盘" : "公开";
    messageRecipient.append(publicOption);
    if (canDebrief) {
      for (const player of current.players.filter((item) => item.type === "agent")) {
        const option = document.createElement("option");
        option.value = player.id;
        option.textContent = `私聊 · ${player.name}${player.alive ? "" : "（已出局）"}`;
        messageRecipient.append(option);
      }
    }
    const privateTarget = canDebrief
      ? current.players.find((player) => player.type === "agent" && player.id === previousRecipient)
      : null;
    messageRecipient.value = privateTarget?.id || "public";
    messageRecipient.disabled = !canDebrief;
    composer.classList.toggle("is-private-compose", Boolean(privateTarget));
    composerPrivacyNote.textContent = privateTarget
      ? `只有你和 ${privateTarget.name} 能看到；发送后自动回到公开复盘`
      : canDebrief ? "本局赛后公屏可供全部嘉宾复盘" : "游戏进行中只开放依法可见的阶段发言";
    messageInput.disabled = !enabled;
    sendButton.disabled = !enabled || running;
    messageInput.placeholder = canDebrief
      ? privateTarget ? `私聊给 ${privateTarget.name}……` : "赛后想审谁、夸谁、骂谁，直接说……"
      : canLastWords
        ? "留下最后一句话；发出后再让法官继续……"
      : canTieSpeak
        ? "为自己辩一句，再看他们怎么投……"
        : canDaySpeak
          ? "盘逻辑、跳身份、抬杠；想压轴就最后再发……"
          : current
            ? "当前阶段不需要公开发言，请打开身份与行动……"
            : "先开一局狼人杀……";
    sendButton.textContent = canDebrief ? (privateTarget ? "发送私聊" : "加入复盘") : canLastWords ? "留下遗言" : "公开发言";
  }

  function renderGame() {
    const current = game();
    const hasGame = Boolean(current);
    renderArchives();
    roomEmpty.classList.toggle("is-hidden", hasGame);
    mainTable.classList.toggle("is-hidden", !hasGame);
    setup.classList.toggle("is-hidden", hasGame);
    gameSection.classList.toggle("is-hidden", !hasGame);
    dialog.classList.toggle("is-control-mode", hasGame);
    if (!current) {
      renderParticipantSetup();
      renderDirector();
      syncWerewolfComposer(null);
      return;
    }
    if (current.status === "ended" && (current.phase !== "debrief" || !current.debrief?.recap)) {
      beginWerewolfDebrief(current);
      void persistGame();
    }
    byId("werewolf-phase").textContent = current.status === "ended"
      ? WEREWOLF_PHASE_META.ended
      : `${current.phase.startsWith("night") || current.phase === "dawn" ? `第 ${current.day} 夜` : `第 ${current.day} 天`} · ${WEREWOLF_PHASE_META[current.phase]}`;
    byId("werewolf-mode-copy").textContent = `${current.viewMode === "god" ? "上帝模式" : "玩家模式"} · ${current.costMode === "standard" ? "标准局" : "省钱局"}`;
    byId("werewolf-main-phase").textContent = current.status === "ended"
      ? `${archiveResultLabel(current)} · 赛后复盘`
      : `${current.phase.startsWith("night") || current.phase === "dawn" ? `第 ${current.day} 夜` : `第 ${current.day} 天`} · ${WEREWOLF_PHASE_META[current.phase]}`;
    byId("werewolf-cost-note").textContent = current.costMode === "standard"
      ? "标准局会把发言与投票分开调用。"
      : "省钱局会从发言末尾读取预投票。";
    advanceButton.textContent = phaseButtonCopy(current);
    const waitingForSpeech = current.phase === "day_speech" && !allSpeakersDone(current, false);
    const waitingForTieSpeech = current.phase === "tie_speech" && !allSpeakersDone(current, true);
    advanceButton.disabled = running || current.status === "ended" || waitingForSpeech || waitingForTieSpeech;
    stopButton.classList.toggle("is-hidden", !running);
    byId("werewolf-end-game").classList.toggle("is-hidden", current.status === "ended");
    archiveButton.classList.toggle("is-hidden", current.status !== "ended");
    advanceButton.classList.toggle("is-hidden", current.status === "ended");
    renderRoleCard(current);
    renderPlayerBoard(current);
    renderLog(current);
    renderActionPanel(current);
    renderDirector();
    syncWerewolfComposer(current);
  }

  function open() {
    setGameStatus("");
    renderGame();
    if (!dialog.open) dialog.showModal();
  }

  function captureUserAction(current) {
    if (current.viewMode !== "player") return false;
    const user = werewolfPlayer(current, WEREWOLF_USER_ID);
    if (!user?.alive && current.phase !== "last_words") return false;
    let changed = false;
    if (current.phase === "night_wolves" && user.role === "wolf" && !current.pending.userWolfReady) {
      const target = byId("werewolf-user-target")?.value;
      if (!target) throw new Error("先替狼队选一个落刀目标");
      currentNight(current).wolfVotes[user.id] = target;
      const secret = byId("werewolf-user-secret")?.value.trim();
      if (secret) appendWerewolfLog(current, { visibility: "wolves", authorId: user.id, author: user.name, text: secret });
      current.pending.userWolfReady = true;
      changed = true;
    } else if (current.phase === "night_seer" && user.role === "seer" && !current.pending.userSeerReady) {
      const target = byId("werewolf-user-check")?.value;
      if (!target) throw new Error("先选今晚要验的人");
      recordSeerCheck(current, target, user);
      current.pending.userSeerReady = true;
      changed = true;
    } else if (current.phase === "night_witch" && user.role === "witch" && !current.pending.userWitchReady) {
      const night = currentNight(current);
      night.witchSave = Boolean(byId("werewolf-user-save")?.checked && current.witch.healAvailable && night.killTargetId);
      night.poisonTargetId = byId("werewolf-user-poison")?.value || null;
      current.pending.userWitchReady = true;
      changed = true;
    } else if (current.phase === "day_speech") {
      const day = currentDay(current);
      if (current.costMode === "economy" && day.speeches[user.id] && !day.provisionalVotes[user.id]) {
        const vote = byId("werewolf-user-vote")?.value;
        if (!vote) throw new Error("省钱局还差曦曦这一票，请在身份与行动里选好");
        day.provisionalVotes[user.id] = vote;
        changed = true;
      }
    } else if (current.phase === "day_vote" && !current.pending.userVoteReady) {
      const vote = byId("werewolf-user-vote")?.value;
      if (!vote) throw new Error("先投出曦曦这一票");
      currentDay(current).votes[user.id] = vote;
      current.pending.userVoteReady = true;
      changed = true;
    } else if (current.phase === "tie_vote" && !current.pending.userTieVoteReady) {
      const vote = byId("werewolf-user-tie-vote")?.value;
      if (!vote) throw new Error("先投出平票重投这一票");
      currentDay(current).tieVotes[user.id] = vote;
      current.pending.userTieVoteReady = true;
      changed = true;
    } else if (current.phase === "last_words" && current.pending?.eliminatedId === user.id && !current.pending.userLastWordsReady) {
      current.pending.userLastWords = byId("werewolf-user-last-words")?.value.trim() || "晨曦没有留下遗言。";
      current.pending.userLastWordsReady = true;
      changed = true;
    }
    return changed;
  }

  function recordSeerCheck(current, targetId, seer) {
    const target = werewolfPlayer(current, targetId);
    if (!target) return;
    const result = target.role === "wolf" ? "wolf" : "good";
    const night = currentNight(current);
    night.seerTargetId = targetId;
    night.seerResult = result;
    current.seerChecks.push({ day: current.day, seerId: seer.id, targetId, result });
    appendWerewolfLog(current, {
      visibility: "seer",
      authorId: "system",
      author: "法官",
      text: `${target.name} 的查验结果是：${result === "wolf" ? "狼人" : "好人"}。`,
    });
  }

  async function runWolves(current, signal) {
    const night = currentNight(current);
    const wolves = livingWerewolfPlayers(current).filter((player) => player.role === "wolf");
    const discussionRounds = 2;
    const shouldDiscuss = wolves.length > 1;
    if (shouldDiscuss) {
      current.pending.wolfTalkDone ||= {};
      for (let round = 1; round <= discussionRounds; round += 1) {
        const roundKey = String(round);
        current.pending.wolfTalkDone[roundKey] ||= [];
        for (const player of wolves) {
          if (player.type !== "agent" || current.pending.wolfTalkDone[roundKey].includes(player.id)) continue;
          const agent = agentFor(player.id);
          if (!agent) continue;
          const raw = await chatRequest(
            agent,
            current,
            player,
            `现在是狼人夜间密谈第 ${round}/${discussionRounds} 轮。阅读完整公屏、生存状态和本夜狼聊后，简短说你的判断；要回应队友的分歧。此轮只讨论，不投票，不要写 [TARGET]。这段话不会公开。`,
            wolfNightBriefing(current),
            signal,
            220,
          );
          appendWerewolfLog(current, {
            visibility: "wolves",
            authorId: player.id,
            author: player.name,
            text: stripWerewolfControls(raw) || "这一轮我暂时没有补充。",
          });
          current.pending.wolfTalkDone[roundKey].push(player.id);
          await persistGame();
        }
      }
    }
    current.pending.wolfDone ||= [];
    for (const player of wolves) {
      if (player.type !== "agent" || current.pending.wolfDone.includes(player.id)) continue;
      const agent = agentFor(player.id);
      if (!agent) continue;
      const targets = validTargets(current, player.id, { includeSelf: true });
      const raw = await chatRequest(
        agent,
        current,
        player,
        shouldDiscuss
          ? "两轮狼队密谈已经结束。重新阅读完整公屏、生存状态和本夜全部密谈，独立投出最终刀口；可以用一句话说明理由，最后必须单独写 [TARGET:玩家名字]。只有仍存活的狼可以投票。"
          : "你是目前唯一存活的狼人，没有可密谈的队友。阅读完整公屏、死亡名单和旧狼队记录后直接秘密决定刀口。不要输出分析或自言自语，只输出 [TARGET:玩家名字]。",
        `${wolfNightBriefing(current)}\n\n可刀目标：${targets.map((target) => target.name).join("、")}`,
        signal,
        shouldDiscuss ? 140 : 60,
      );
      const targetId = parseWerewolfTarget(raw, "TARGET", current.players, targets.map((target) => target.id)) || fallbackTarget(targets);
      night.wolfVotes[player.id] = targetId;
      if (shouldDiscuss) {
        appendWerewolfLog(current, {
          visibility: "wolves",
          authorId: player.id,
          author: player.name,
          text: stripWerewolfControls(raw) || `我的最终票是 ${werewolfPlayer(current, targetId)?.name || "这位"}。`,
        });
      }
      current.pending.wolfDone.push(player.id);
      await persistGame();
    }
    const killTargets = validTargets(current, "", { includeSelf: true });
    const outcome = voteOutcome(night.wolfVotes, killTargets.map((player) => player.id));
    night.killTargetId = outcome.eliminatedId || outcome.tiedIds[0] || fallbackTarget(killTargets);
    appendWerewolfLog(current, { visibility: "god", text: `狼队最终选择：${werewolfPlayer(current, night.killTargetId)?.name || "无人"}。` });
    current.phase = "night_seer";
    current.pending = {};
  }

  async function runSeer(current, signal) {
    const seer = livingWerewolfPlayers(current).find((player) => player.role === "seer");
    if (seer?.type === "agent") {
      const agent = agentFor(seer.id);
      const targets = validTargets(current, seer.id);
      const raw = await chatRequest(
        agent,
        current,
        seer,
        "现在是预言家验人。只在候选人里选一位，最后写 [CHECK:玩家名字]。不要发表公开发言。",
        `${werewolfNightPublicBriefing(current)}\n\n可查验：${targets.map((target) => target.name).join("、")}`,
        signal,
        80,
      );
      const targetId = parseWerewolfTarget(raw, "CHECK", current.players, targets.map((target) => target.id)) || fallbackTarget(targets);
      recordSeerCheck(current, targetId, seer);
    }
    current.phase = "night_witch";
    current.pending = {};
  }

  async function runWitch(current, signal) {
    const night = currentNight(current);
    const witch = livingWerewolfPlayers(current).find((player) => player.role === "witch");
    if (witch?.type === "agent") {
      const agent = agentFor(witch.id);
      const poisonTargets = validTargets(current, witch.id);
      const raw = await chatRequest(
        agent,
        current,
        witch,
        "现在是女巫行动。只能按你拥有的药作决定。最后严格写 [WITCH:save=yes/no,poison=玩家名字/none]。不要公开发言。",
        `${werewolfNightPublicBriefing(current)}\n\n今晚被刀：${werewolfPlayer(current, night.killTargetId)?.name || "无人"}\n解药：${current.witch.healAvailable ? "可用" : "已用"}\n毒药：${current.witch.poisonAvailable ? "可用" : "已用"}\n可毒目标：${poisonTargets.map((player) => player.name).join("、")}`,
        signal,
        100,
      );
      const action = parseWitchAction(raw, current.players, poisonTargets.map((player) => player.id));
      night.witchSave = current.witch.healAvailable && Boolean(night.killTargetId) && action.save;
      night.poisonTargetId = current.witch.poisonAvailable ? action.poisonTargetId : null;
    }
    if (night.witchSave) current.witch.healAvailable = false;
    if (night.poisonTargetId) current.witch.poisonAvailable = false;
    appendWerewolfLog(current, {
      visibility: "witch",
      text: `本夜决定：${night.witchSave ? "使用解药" : "不用解药"}；${night.poisonTargetId ? `毒 ${werewolfPlayer(current, night.poisonTargetId)?.name}` : "不用毒药"}。`,
    });
    current.phase = "dawn";
    current.pending = {};
  }

  function runDawn(current) {
    const night = currentNight(current);
    night.deaths = resolveWerewolfNight(current, {
      killTargetId: night.killTargetId,
      save: night.witchSave,
      poisonTargetId: night.poisonTargetId,
    });
    night.resolved = true;
    appendWerewolfLog(current, {
      visibility: "public",
      text: night.deaths.length ? `昨夜出局：${namesFor(current, night.deaths)}。` : "昨夜是平安夜，无人出局。",
      phase: "dawn",
    });
    const winner = checkWerewolfWinner(current);
    if (winner) {
      finishWerewolfGame(current, winner);
      return;
    }
    current.phase = "day_speech";
    current.pending = {};
    currentDay(current);
  }

  async function generateSpeech(current, playerId, signal, { tiedOnly = false } = {}) {
    const day = currentDay(current);
    const player = werewolfPlayer(current, playerId);
    if (!player?.alive || player.type !== "agent" || playerHasSpoken(current, playerId, tiedOnly)) return;
    const agent = agentFor(player.id);
    if (!agent) throw new Error(`${player.name} 没有可用的接口配置`);
    const targets = validTargets(current, player.id, { candidateIds: tiedOnly ? (current.pending.tieIds || []) : null });
    const economyInstruction = !tiedOnly && current.costMode === "economy"
      ? "发言最后另起一行写 [VOTE:玩家名字]，作为你今天的正式投票。"
      : "这一轮只发言，不要输出投票标签。";
    const raw = await chatRequest(
      agent,
      current,
      player,
      `${tiedOnly ? "你在平票名单里，做一次简短辩护。" : "现在是白天公开发言，房主刚刚点到你。"}可以跳身份、撒谎、盘逻辑或反驳别人。${economyInstruction}`,
      `今天目前的公屏：\n${publicHistory(current)}\n\n${targets.length ? `可投目标：${targets.map((target) => target.name).join("、")}` : ""}`,
      signal,
      tiedOnly ? 220 : 360,
    );
    const speech = stripWerewolfControls(raw) || "我暂时没有更多补充。";
    day.speeches[tiedOnly ? `${player.id}-tie` : player.id] = speech;
    if (!tiedOnly && current.costMode === "economy") {
      day.provisionalVotes[player.id] = parseWerewolfTarget(raw, "VOTE", current.players, targets.map((target) => target.id)) || fallbackTarget(targets);
    }
    appendWerewolfLog(current, { authorId: player.id, author: player.name, text: speech, phase: current.phase });
    await persistGame();
  }

  async function runSpeechSpeaker(playerId, tiedOnly = false) {
    const current = game();
    if (!current || running || current.status !== "active") return;
    if (current.phase !== (tiedOnly ? "tie_speech" : "day_speech")) return;
    running = true;
    speakingPlayerId = playerId;
    abortController = new AbortController();
    setGameStatus(`${werewolfPlayer(current, playerId)?.name || "这位嘉宾"}正在发言……`);
    renderGame();
    try {
      await generateSpeech(current, playerId, abortController.signal, { tiedOnly });
      setGameStatus("这一位说完了。可以继续点名，晨曦也可以最后压轴。");
    } catch (error) {
      if (error.name === "AbortError") setGameStatus("停在这里了；前面已经说完的发言都还在。", true);
      else {
        recordWerewolfIncident(current, `${werewolfPlayer(current, playerId)?.name || playerId} 发言请求失败：${error.message}`);
        setGameStatus(`${error.message}。只需重试这一位，其他人的发言不会丢。`, true);
        await persistGame();
      }
    } finally {
      running = false;
      speakingPlayerId = "";
      abortController = null;
      renderGame();
    }
  }

  async function runSpeechRound(tiedOnly = false) {
    const current = game();
    if (!current || running || current.status !== "active") return;
    if (current.phase !== (tiedOnly ? "tie_speech" : "day_speech")) return;
    running = true;
    abortController = new AbortController();
    try {
      for (const playerId of speechPlayerIds(current, tiedOnly)) {
        const player = werewolfPlayer(current, playerId);
        if (player?.type !== "agent" || playerHasSpoken(current, playerId, tiedOnly)) continue;
        speakingPlayerId = playerId;
        setGameStatus(`${player.name}正在发言……`);
        renderGame();
        await generateSpeech(current, playerId, abortController.signal, { tiedOnly });
        speakingPlayerId = "";
        renderGame();
      }
      setGameStatus(allSpeakersDone(current, tiedOnly) ? "这一轮全员说完了，可以进入下一阶段。" : "AI 嘉宾说完了，等晨曦用下方输入框发言。" );
    } catch (error) {
      const failedId = speakingPlayerId;
      if (error.name === "AbortError") setGameStatus("停在这里了；已经说完的都保留。", true);
      else {
        recordWerewolfIncident(current, `${werewolfPlayer(current, failedId)?.name || failedId} 发言请求失败：${error.message}`);
        setGameStatus(`${error.message}。重试这一位即可。`, true);
      }
    } finally {
      running = false;
      speakingPlayerId = "";
      abortController = null;
      await persistGame();
      renderGame();
    }
  }

  function completeSpeechPhase(current, tiedOnly = false) {
    if (!allSpeakersDone(current, tiedOnly)) throw new Error(tiedOnly ? "平票席还没有全部辩护" : "还有存活玩家没有发言");
    if (tiedOnly) {
      const tieIds = [...(current.pending.tieIds || currentDay(current).tiedIds || [])];
      current.phase = "tie_vote";
      current.pending = { tieIds };
      return;
    }
    const day = currentDay(current);
    if (current.costMode === "economy") resolveDayVotes(current, day.provisionalVotes, false);
    else {
      current.phase = "day_vote";
      current.pending = {};
    }
  }

  async function runDebriefSpeaker(playerId, { defaultPrivateToUser = false } = {}) {
    const current = game();
    if (!current || current.status !== "ended" || running) return;
    const player = werewolfPlayer(current, playerId);
    const agent = player?.type === "agent" ? agentFor(player.id) : null;
    if (!player || !agent) return;
    running = true;
    speakingPlayerId = playerId;
    abortController = new AbortController();
    setGameStatus(`${player.name}正在看完整卷宗……`);
    renderGame();
    try {
      const reply = await requestWerewolfDebrief(agent, current, player, abortController.signal, {
        agents: debriefAgents(current),
        defaultPrivateToUser,
      });
      appendDebriefReply(current, player, agent, reply, { defaultPrivateToUser });
      current.debrief.roundDone ||= [];
      if (!current.debrief.roundDone.includes(player.id)) current.debrief.roundDone.push(player.id);
      setGameStatus(defaultPrivateToUser
        ? `${player.name}私下回复了你。`
        : `${player.name}复盘完了。可以继续追问同一个人。`);
      await persistAll();
    } catch (error) {
      if (error.name === "AbortError") setGameStatus("复盘暂停了，前面的内容都还在。", true);
      else {
        recordWerewolfIncident(current, `${player.name} 赛后复盘请求失败：${error.message}`);
        setGameStatus(`${error.message}。只重试这一位即可。`, true);
        await persistGame();
      }
    } finally {
      running = false;
      speakingPlayerId = "";
      abortController = null;
      renderGame();
    }
  }

  async function runDebriefRound() {
    const current = game();
    if (!current || current.status !== "ended" || running) return;
    const ids = current.players.filter((player) => player.type === "agent").map((player) => player.id);
    running = true;
    abortController = new AbortController();
    try {
      for (const playerId of ids) {
        const player = werewolfPlayer(current, playerId);
        const agent = agentFor(playerId);
        if (!player || !agent) continue;
        speakingPlayerId = playerId;
        setGameStatus(`${player.name}正在看完整卷宗……`);
        renderGame();
        const reply = await requestWerewolfDebrief(agent, current, player, abortController.signal, {
          agents: debriefAgents(current),
        });
        appendDebriefReply(current, player, agent, reply);
        current.debrief.roundDone ||= [];
        if (!current.debrief.roundDone.includes(player.id)) current.debrief.roundDone.push(player.id);
        speakingPlayerId = "";
        await persistAll();
        renderGame();
      }
      setGameStatus("这一轮全体复盘说完了。可以继续点名、随机抽人或再开一轮。" );
    } catch (error) {
      const failedId = speakingPlayerId;
      if (error.name === "AbortError") setGameStatus("复盘停在这里了；已经说完的都保留。", true);
      else {
        recordWerewolfIncident(current, `${werewolfPlayer(current, failedId)?.name || failedId} 赛后复盘请求失败：${error.message}`);
        setGameStatus(`${error.message}。重试当前这一位即可。`, true);
      }
    } finally {
      running = false;
      speakingPlayerId = "";
      abortController = null;
      await persistGame();
      renderGame();
    }
  }

  async function runVotes(current, signal, { tiedOnly = false } = {}) {
    const day = currentDay(current);
    const votes = tiedOnly ? day.tieVotes : day.votes;
    const doneKey = tiedOnly ? "tieVoteDone" : "voteDone";
    current.pending[doneKey] ||= [];
    const candidateIds = tiedOnly ? (current.pending.tieIds || []) : livingWerewolfPlayers(current).map((player) => player.id);
    for (const player of livingWerewolfPlayers(current)) {
      if (player.type !== "agent" || current.pending[doneKey].includes(player.id)) continue;
      const agent = agentFor(player.id);
      if (!agent) continue;
      const targets = validTargets(current, player.id, { candidateIds });
      speakingPlayerId = player.id;
      setGameStatus(`${player.name}正在投票……`);
      renderGame();
      const raw = await chatRequest(
        agent,
        current,
        player,
        "现在只进行公开投票。根据刚才发言做决定，只输出 [VOTE:玩家名字]，不要解释。",
        `公屏记录：\n${publicHistory(current)}\n\n可投目标：${targets.map((target) => target.name).join("、")}`,
        signal,
        50,
      );
      votes[player.id] = parseWerewolfTarget(raw, "VOTE", current.players, targets.map((target) => target.id)) || fallbackTarget(targets);
      current.pending[doneKey].push(player.id);
      speakingPlayerId = "";
      await persistGame();
    }
    resolveDayVotes(current, votes, tiedOnly);
  }

  function resolveDayVotes(current, votes, wasTieVote) {
    const day = currentDay(current);
    const candidates = wasTieVote ? (current.pending.tieIds || []) : livingWerewolfPlayers(current).map((player) => player.id);
    const outcome = voteOutcome(votes, candidates);
    day.voteCounts = outcome.counts;
    const resultText = Object.entries(outcome.counts)
      .filter(([, count]) => count > 0)
      .map(([id, count]) => `${werewolfPlayer(current, id)?.name || id} ${count} 票`)
      .join("，") || "无人得票";
    appendWerewolfLog(current, { text: `投票结果：${resultText}。`, phase: current.phase });
    if (outcome.tiedIds.length) {
      if (wasTieVote) {
        appendWerewolfLog(current, { text: "第二次投票仍然平票，今天无人被放逐。", phase: "tie_vote" });
        startNextNight(current);
        return;
      }
      day.tiedIds = outcome.tiedIds;
      current.phase = "tie_speech";
      current.tieRound = 1;
      current.pending = { tieIds: outcome.tiedIds };
      appendWerewolfLog(current, { text: `${namesFor(current, outcome.tiedIds)} 平票，进入辩护与重投。`, phase: "tie_speech" });
      return;
    }
    const eliminated = werewolfPlayer(current, outcome.eliminatedId);
    if (!eliminated) {
      appendWerewolfLog(current, { text: "今天无人被放逐。" });
      startNextNight(current);
      return;
    }
    eliminated.alive = false;
    eliminated.eliminatedDay = current.day;
    day.eliminatedId = eliminated.id;
    current.phase = "last_words";
    current.pending = { eliminatedId: eliminated.id };
    appendWerewolfLog(current, { text: `${eliminated.name} 被投票放逐，留下最后一句话。`, phase: "last_words" });
  }

  async function runLastWords(current, signal) {
    const eliminated = werewolfPlayer(current, current.pending.eliminatedId);
    if (!eliminated) {
      startNextNight(current);
      return;
    }
    let words = "";
    if (eliminated.type === "user") {
      words = current.pending.userLastWords
        || byId("werewolf-user-last-words")?.value.trim()
        || "晨曦没有留下遗言。";
    } else {
      const agent = agentFor(eliminated.id);
      if (agent) {
        words = stripWerewolfControls(await chatRequest(
          agent,
          current,
          eliminated,
          "你刚被放逐。留下最后一段公开遗言，可以认身份、诈人或继续盘逻辑。说完后不能再参与本局。",
          `最后看到的公屏：\n${publicHistory(current)}`,
          signal,
          220,
        ));
      }
    }
    // A slow duplicate request must not append a second last word or advance
    // another night after the first request has already left this phase.
    if (current.phase !== "last_words" || current.pending?.eliminatedId !== eliminated.id) return;
    appendWerewolfLog(current, { authorId: eliminated.id, author: eliminated.name, text: words || "我没有遗言。", phase: "last_words" });
    const winner = checkWerewolfWinner(current);
    if (winner) finishWerewolfGame(current, winner);
    else startNextNight(current);
  }

  function startNextNight(current) {
    current.day += 1;
    current.phase = "night_wolves";
    current.tieRound = 0;
    current.pending = {};
    appendWerewolfLog(current, { text: `第 ${current.day} 夜，天黑请闭眼。`, phase: "night_wolves" });
  }

  async function advance() {
    const current = game();
    if (!current || running || current.status === "ended") return;
    try {
      // Read the human player's controls before renderGame rebuilds the action panel.
      const capturedUserAction = captureUserAction(current);
      // Lock synchronously before the first await. Otherwise a second tap can
      // enter while the initial save is still pending and advance twice.
      running = true;
      abortController = new AbortController();
      setGameStatus("法官正在收这一阶段的行动……");
      renderGame();
      if (capturedUserAction) await persistGame();
    } catch (error) {
      running = false;
      abortController = null;
      setGameStatus(error.message, true);
      renderGame();
      return;
    }
    try {
      if (current.phase === "night_wolves") await runWolves(current, abortController.signal);
      else if (current.phase === "night_seer") await runSeer(current, abortController.signal);
      else if (current.phase === "night_witch") await runWitch(current, abortController.signal);
      else if (current.phase === "dawn") runDawn(current);
      else if (current.phase === "day_speech") completeSpeechPhase(current, false);
      else if (current.phase === "day_vote") await runVotes(current, abortController.signal);
      else if (current.phase === "tie_speech") completeSpeechPhase(current, true);
      else if (current.phase === "tie_vote") await runVotes(current, abortController.signal, { tiedOnly: true });
      else if (current.phase === "last_words") await runLastWords(current, abortController.signal);
      setGameStatus(current.status === "ended" ? "卷宗已解锁，可以往回翻所有密谈。" : "这一阶段完成了。先看戏，再继续。🐺");
      await persistGame();
    } catch (error) {
      const votePhase = ["day_vote", "tie_vote"].includes(current.phase);
      const voteProgress = votePhase
        ? werewolfVoteProgress(current, {
          tiedOnly: current.phase === "tie_vote",
          currentPlayerId: speakingPlayerId,
        })
        : "";
      if (error.name === "AbortError") {
        setGameStatus(voteProgress
          ? `停在这里了，已经完成的投票会保留。｜${voteProgress}`
          : "停在这里了，已经完成的发言会保留。");
      }
      else {
        const diagnosticMessage = voteProgress ? `${error.message}｜${voteProgress}` : error.message;
        recordWerewolfIncident(current, `${WEREWOLF_PHASE_META[current.phase] || current.phase}：${diagnosticMessage}`);
        setGameStatus(diagnosticMessage, true);
        await persistGame();
      }
    } finally {
      running = false;
      speakingPlayerId = "";
      abortController = null;
      renderGame();
    }
  }

  function start() {
    const room = getRoom();
    if (!room) return;
    const viewMode = selectedRadio("werewolf-view", "player");
    const costMode = selectedRadio("werewolf-cost", "economy");
    const chosen = new Set(selectedAgentIds());
    const agents = configuredAgents().filter((agent) => chosen.has(agent.id));
    const participants = agents.map((agent) => ({ id: agent.id, name: agent.name, type: "agent" }));
    if (viewMode === "player") participants.unshift({ id: WEREWOLF_USER_ID, name: "晨曦", type: "user" });
    if (![6, 7].includes(participants.length)) {
      setupStatus.textContent = "人数不对：经典首版需要 6 或 7 位玩家。";
      setupStatus.classList.add("is-error");
      return;
    }
    const roleAssignments = manualDealEnabled() ? selectedRoleAssignments() : null;
    room.werewolf = createWerewolfGame({ participants, viewMode, costMode, roleAssignments });
    archiveRoomId = "";
    void persistGame();
    renderGame();
    toast(viewMode === "god" ? "上帝视角已开，今晚谁刀谁都瞒不过你" : "身份发好了——先别露牌 😼");
  }

  function submitUserMessage(rawText, { recipientId = "public" } = {}) {
    const current = game();
    const body = String(rawText || "").trim();
    if (!current || !body || running) return false;
    if (current.status === "ended") {
      const privateTarget = current.players.find((player) => (
        player.type === "agent" && player.id === recipientId
      ));
      appendWerewolfLog(current, {
        visibility: privateTarget ? "private" : "public",
        recipientIds: privateTarget ? [privateTarget.id] : [],
        authorId: WEREWOLF_USER_ID,
        author: "晨曦",
        text: body,
        phase: "debrief",
      });
      void persistGame();
      renderGame();
      if (privateTarget) void runDebriefSpeaker(privateTarget.id, { defaultPrivateToUser: true });
      return true;
    }
    const user = werewolfPlayer(current, WEREWOLF_USER_ID);
    if (!user) {
      toast("上帝席这局只主持和围观，不向存活玩家递话");
      return false;
    }
    if (current.phase === "day_speech" && user.alive && !playerHasSpoken(current, user.id, false)) {
      currentDay(current).speeches[user.id] = body;
      appendWerewolfLog(current, { authorId: user.id, author: user.name, text: body, phase: "day_speech" });
      setGameStatus(current.costMode === "economy" ? "曦曦说完了；记得在身份与行动里补交一票。" : "曦曦说完了，可以继续点名其他人。" );
    } else if (current.phase === "tie_speech" && user.alive && current.pending?.tieIds?.includes(user.id) && !playerHasSpoken(current, user.id, true)) {
      currentDay(current).speeches[`${user.id}-tie`] = body;
      appendWerewolfLog(current, { authorId: user.id, author: user.name, text: body, phase: "tie_speech" });
      setGameStatus("平票辩护已经记下。" );
    } else if (current.phase === "last_words" && current.pending?.eliminatedId === user.id && !current.pending.userLastWordsReady) {
      current.pending.userLastWords = body;
      current.pending.userLastWordsReady = true;
      setGameStatus("遗言已收好，让法官继续即可。" );
    } else {
      toast("现在不是曦曦的公开发言阶段");
      return false;
    }
    void persistGame();
    renderGame();
    return true;
  }

  function archiveCurrentGame(confirmActive = true) {
    const room = getRoom();
    const current = room?.werewolf;
    if (!room || !current) return;
    if (current.status === "active") {
      if (confirmActive && !window.confirm("这局还没结束。确定提前结束、封存整局，再重新洗牌？")) return;
      current.winner = null;
      appendWerewolfLog(current, { text: "房主提前结束了本局。所有身份与夜间密谈现已解锁。", phase: "ended" });
      beginWerewolfDebrief(current);
    }
    room.werewolfArchives ||= [];
    if (!room.werewolfArchives.some((item) => item.id === current.id)) {
      const sequence = Math.max(Number(room.werewolfArchiveCount) || 0, room.werewolfArchives.length) + 1;
      room.werewolfArchives.push(archiveWerewolfGame(current, sequence));
      room.werewolfArchiveCount = sequence;
    }
    room.werewolf = null;
    archiveRoomId = "";
    void persistAll();
    setGameStatus("");
    renderGame();
    if (!dialog.open) dialog.showModal();
    toast("本局卷宗和赛后复盘都收好了，可以重新发牌");
  }

  function clearGame(confirmActive = true) {
    archiveCurrentGame(confirmActive);
  }

  function endGame() {
    const current = game();
    if (!current || current.status === "ended") return;
    if (!window.confirm("确定提前结束这局？身份和夜间密谈会立刻解锁。")) return;
    current.winner = null;
    appendWerewolfLog(current, { text: "房主提前结束了本局。所有身份与夜间密谈现已解锁。", phase: "ended" });
    beginWerewolfDebrief(current);
    void persistGame();
    renderGame();
  }

  byId("werewolf-button").addEventListener("click", open);
  byId("werewolf-open-controls").addEventListener("click", open);
  byId("close-werewolf-dialog").addEventListener("click", () => dialog.close());
  byId("start-werewolf-game").addEventListener("click", start);
  byId("werewolf-advance").addEventListener("click", () => void advance());
  byId("werewolf-stop").addEventListener("click", () => abortController?.abort());
  actionButton.addEventListener("click", () => void runDirectorAction());
  byId("werewolf-new-game").addEventListener("click", () => clearGame(true));
  archiveButton.addEventListener("click", () => archiveCurrentGame(false));
  byId("werewolf-end-game").addEventListener("click", endGame);
  document.querySelectorAll('input[name="werewolf-view"]').forEach((input) => input.addEventListener("change", setupSelectionLimits));
  manualDealInput.addEventListener("change", () => {
    renderRoleAssignment();
    updateSetupStatus();
  });
  window.addEventListener("scroll", handleLogScroll, { passive: true });
  roomStage.addEventListener("scroll", handleLogScroll, { passive: true });
  roomStage.addEventListener("wheel", (event) => {
    if (event.deltaY >= 0) return;
    logPullIntent = true;
    maybeRevealOlderLogFromPull();
  }, { passive: true });
  roomStage.addEventListener("touchstart", (event) => {
    logLastTouchY = event.touches?.[0]?.clientY ?? null;
  }, { passive: true });
  roomStage.addEventListener("touchmove", (event) => {
    const nextY = event.touches?.[0]?.clientY;
    if (!Number.isFinite(nextY)) return;
    if (Number.isFinite(logLastTouchY) && nextY > logLastTouchY + 6) {
      logPullIntent = true;
      maybeRevealOlderLogFromPull();
    }
    logLastTouchY = nextY;
  }, { passive: true });
  document.addEventListener("click", (event) => {
    if (roomStage.contains(event.target)) return;
    for (const message of roomStage.querySelectorAll(".werewolf-log-entry.is-actions-visible")) {
      message.classList.remove("is-actions-visible");
    }
  });

  return {
    open,
    render: renderGame,
    renderComposer: () => syncWerewolfComposer(game()),
    renderDirector,
    setDirectorMode,
    submitUserMessage,
  };
}

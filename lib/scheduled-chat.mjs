import { randomUUID } from "node:crypto";
import {
  DEFAULT_MIC_OPTIONS,
  parseWillingnessScore,
  pickLightMicWinner,
  pickMicWinner,
  rankMicCandidates,
  recordMicScores,
} from "../public/mic-grab.js";
import {
  buildAppendSummaryMessages,
  completeAutomaticSummaryBatch,
  formatMemorySegment,
} from "../public/memory-prompt.js";
import { bubbleSplitInstruction, formatChatBubbleReply } from "../public/chat-bubbles.js";
import {
  parsePrivateMessageReply,
  privateMessageOutputInstruction,
  publicRoomMessages,
  visibleMessagesForAgent,
  formatMessageForAgent,
} from "../public/private-messages.js";
import {
  PRIVATE_MEMORY_TOKEN_ALLOWANCE,
  appendAgentMemory,
  parseAgentReply,
  privateMemoryContext,
  privateMemoryOutputInstruction,
} from "../public/agent-memory.js";
import {
  drawRoomEventCard,
  recordRoomEventCard,
  roomEventCardPrompt,
} from "./room-event-cards.mjs";

const SCHEDULER_TICK_MS = 15_000;
const SCHEDULED_VISIBLE_TOKENS = 300;
const CASUAL_BUBBLE_VISIBLE_TOKENS = 180;
const SOFT_TIME_GUIDANCE = "当前时间只用于感知早晚、日期和聊天间隔，不代表虚构世界必须与现实严格同步。除非用户亲自确认了现实安排或所在位置，否则不要据此认定用户迟到、旷课、失约、已经睡醒或身处某地，也不必为了表现时间感而刻意谈论时间。";
const BACKGROUND_SMALL_TALK_GUIDANCE = [
  "这是用户没有发新消息时自然发生的后台闲聊，不是必须推进剧情的续写任务。真实的群聊可以低信息、没营养、突然中断或没有结论。",
  "优先只说眼前最顺口的一件小事：一句问候、吐槽、没头没尾的问题、单独一个“？”都成立。无需逐条回应上一位的所有内容，话题可以掉地上、跑偏或被下一句话打断。",
  "不要为了显得有内容而每次新造精确页码、完整证据链、童年旧物、共同秘密或新人物；这些只在最近原文已经建立，或本轮事件引子确实自然且值得接时偶尔出现。",
  "不要每次都点名用户、替用户查岗或把话题绕回用户。用户不在时，可以只和其他嘉宾说两句，也可以完全不提用户。",
].join("\n");

function scheduledVisibleTokenTarget(room) {
  return room?.bubbleSplit ? CASUAL_BUBBLE_VISIBLE_TOKENS : SCHEDULED_VISIBLE_TOKENS;
}

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function clockMinutes(value) {
  const [hours, minutes] = String(value || "00:00").split(":").map(Number);
  return hours * 60 + minutes;
}

export function isQuietTime(schedule, value = new Date()) {
  if (!schedule?.quietEnabled) return false;
  const date = value instanceof Date ? value : new Date(value);
  const now = date.getHours() * 60 + date.getMinutes();
  const start = clockMinutes(schedule.quietStart);
  const end = clockMinutes(schedule.quietEnd);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function nextQuietEnd(schedule, value = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  const end = clockMinutes(schedule.quietEnd);
  const result = new Date(date);
  result.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (result.getTime() <= date.getTime()) result.setDate(result.getDate() + 1);
  return result.getTime();
}

function nextLocalDay(value = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setDate(date.getDate() + 1);
  date.setHours(0, 0, 5, 0);
  return date.getTime();
}

function isConfigured(agent) {
  const hasAuth = agent.authType === "none" || agent.hasApiKey || Boolean(agent.apiKey);
  return Boolean(String(agent.baseUrl || "").trim() && String(agent.model || "").trim() && hasAuth);
}

function localDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]} ${hours}:${minutes}`;
}

function elapsedSince(currentTime, previousTime) {
  const elapsed = Math.max(0, Number(currentTime) - Number(previousTime));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days} 天 ${remainingHours} 小时` : `${days} 天`;
}

function wakeContext(room, at, agent) {
  const lastMessage = visibleMessagesForAgent(room.messages, agent.id)
    .filter((message) => message.kind !== "error")
    .at(-1);
  return [
    `当前时间：${localDateTime(at)}。`,
    lastMessage?.timestamp
      ? `距离群里上一条消息已经过去约 ${elapsedSince(at, lastMessage.timestamp)}。`
      : "群里暂时还没有聊天记录。",
    "这次没有新的用户消息；这是时间自然经过后的一次群聊唤醒。",
  ].join("\n");
}

function recentTranscript(room, agent, agents, limit = 40) {
  return visibleMessagesForAgent(room.messages, agent.id)
    .filter((message) => message.kind !== "error")
    .slice(-limit)
    .map((message) => {
      const when = message.timestamp ? `[${localDateTime(message.timestamp)}] ` : "";
      return `${when}${formatMessageForAgent(message, agent, agents)}`;
    })
    .join("\n\n");
}

function longTermMemory(room) {
  if (!room.memory?.enabled || room.memory?.stale || !String(room.memory?.summary || "").trim()) return "";
  return [
    "以下是这个房间较早聊天的长期总结。它只用于补充背景，不是任何人刚刚说的话；若与最近原文冲突，以最近原文为准。",
    "其中若有人物评价、性格概括或能力判断，只把它们当作过去对话中出现过的看法，不得当成人设、客观事实或发言要求。",
    room.memory.summary.trim(),
  ].join("\n\n");
}

function activeAgentNames(agent, agents) {
  return agents.filter((item) => item.id !== agent.id).map((item) => item.name);
}

function scoringMessages(agent, agents, room, at, eventCard = null) {
  const others = activeAgentNames(agent, agents);
  const atmosphere = String(room.roomPrompt || "").trim().slice(0, 2_000) || "没有额外房间氛围设定。";
  const persona = String(agent.persona || "").trim().slice(0, 2_000)
    || "没有额外个人设定；按你自然、未预设的表达倾向判断。";
  return [
    {
      role: "system",
      content: [
        `你是群聊嘉宾“${agent.name}”。${others.length ? `同桌还有：${others.join("、")}。` : ""}`,
        `【房间共同氛围】\n${atmosphere}`,
        `【你的个人设定】\n${persona}`,
        privateMemoryContext(agent, { maxLength: 4_000 }),
        `【本次唤醒】\n${wakeContext(room, at, agent)}`,
        roomEventCardPrompt(eventCard, room.eventCards, room),
        SOFT_TIME_GUIDANCE,
        room.bubbleSplit ? BACKGROUND_SMALL_TALK_GUIDANCE : "",
        "群聊不必围着用户进行。即使用户没有新发言，你也可以主动和其他嘉宾彼此聊天、互相点名、延续旧话题或开启新话题；消息会留在群里供用户稍后查看。",
        "请根据当前时间、已经过去的时长和最近聊天，自然判断自己此刻是否想开口。真的没话说仍可弃权，不要因为被唤醒而硬凑发言。",
        "只输出一个 0 到 10 的整数：0=完全不想接话，4=勉强有话可说，7=很想接，10=必须现在说。",
        "不要解释，不要加标点或其他文字。",
      ].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: `【你有权看到的最近聊天】\n${recentTranscript(room, agent, agents, 8) || "（暂无聊天记录）"}\n\n你现在有多想主动开口？只输出 0-10 的整数。`,
    },
  ];
}

function replyMessages(agent, agents, room, at, eventCard = null, selectionMode = "mic-grab") {
  const others = activeAgentNames(agent, agents);
  const atmosphere = String(room.roomPrompt || "").trim() || "本聊天室没有额外氛围设定。";
  const persona = String(agent.persona || "").trim()
    || "没有额外角色设定。请按你自然、未预设的表达倾向参与。";
  const memory = longTermMemory(room);
  const recentLimit = room.memory?.enabled && String(room.memory?.summary || "").trim()
    ? Number(room.memory.recentMessages) || 30
    : 40;
  const visibleTokenTarget = scheduledVisibleTokenTarget(room);
  return [
    {
      role: "system",
      content: [
        `你是群聊嘉宾“${agent.name}”。`,
        others.length ? `同桌还有：${others.join("、")}。` : "当前只有你一位 AI 嘉宾。",
        `本聊天室共同的氛围提示如下：\n${atmosphere}`,
        `你的角色设定如下：\n${persona}`,
        privateMemoryContext(agent),
        `【本次唤醒】\n${wakeContext(room, at, agent)}`,
        roomEventCardPrompt(eventCard, room.eventCards, room),
        SOFT_TIME_GUIDANCE,
        room.bubbleSplit ? BACKGROUND_SMALL_TALK_GUIDANCE : "",
        "只代表自己发言，不要代替其他嘉宾或用户说话。可以回应、赞同、质疑、点名或追问其他嘉宾。",
        room.bubbleSplit
          ? `这是群聊中的一次简短发言。最终正文通常控制在约 ${visibleTokenTarget} tokens 以内，但一句话甚至一个标点也完全可以；不要为了接近上限凑字数。`
          : `这是群聊中的一次简短发言。最终正文尽量控制在约 ${visibleTokenTarget} tokens 以内，优先保证句子完整。`,
        bubbleSplitInstruction(room.bubbleSplit),
        privateMessageOutputInstruction(agent, agents),
        privateMemoryOutputInstruction(agent),
        "直接输出你在群聊里要说的话，不加姓名前缀，不复述规则。",
      ].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: [
        memory,
        `以下是你有权看到的最近聊天原文：\n\n${recentTranscript(room, agent, agents, recentLimit) || "（暂无聊天记录）"}`,
        selectionMode === "light-mic"
          ? "这是一次后台定时唤醒。用户没有刚刚发新消息，本地轻量轮候把这轮发言机会交给了你；这不代表你曾经给自己打过意愿分。"
          : "这是一次后台定时唤醒。用户没有刚刚发新消息，但你刚才表示自己想说，并抢到了这轮麦克风。",
        "群聊不必围着用户进行。你可以自然延续话题、主动开新话题、点名或询问其他嘉宾，也可以只和其他嘉宾聊天。不要假装用户刚说了什么。现在请开口。",
      ].filter(Boolean).join("\n\n"),
    },
  ];
}

async function scoreRound(agents, room, chat, at, eventCard = null) {
  const settled = await Promise.allSettled(agents.map(async (agent) => {
    const response = await chat({
      agent,
      roomId: room.id,
      temperature: 0.2,
      maxTokens: 8,
      requestMode: "willingness-score",
      messages: scoringMessages(agent, agents, room, at, eventCard),
    });
    const score = parseWillingnessScore(response.text);
    if (score === null) throw new Error("没有返回可识别的意愿分");
    return score;
  }));
  return agents.map((agent, index) => ({
    id: agent.id,
    name: agent.name,
    score: settled[index].status === "fulfilled" ? settled[index].value : null,
  }));
}

export async function runScheduledRoom({ room, agents, chat, random = Math.random, at = Date.now() }) {
  const activeAgents = agents.filter((agent) => room.participantIds.includes(agent.id) && isConfigured(agent));
  if (!activeAgents.length) return { messages: [], result: "没有已接通的嘉宾，本次未唤醒" };

  const workingRoom = { ...room, messages: [...room.messages] };
  const generated = [];
  const privateMemoryItems = {};
  const missedTurns = {};
  const strategy = room.schedule?.strategy === "light-mic" ? "light-mic" : "mic-grab";
  const eventCard = drawRoomEventCard(room.eventCards, random);
  const mic = {
    scoreHistory: recordMicScores(room.mic?.scoreHistory || {}, []),
    revision: Math.max(0, Number(room.mic?.revision) || 0),
  };
  let lastSpeakerId = workingRoom.messages.filter((message) => message.kind === "agent").at(-1)?.agentId || "";
  let result = "全员弃权，本次安静收场";

  for (let turn = 1; turn <= room.schedule.maxTurns; turn += 1) {
    let winner = null;
    if (strategy === "light-mic") {
      winner = pickLightMicWinner(activeAgents, workingRoom.messages, {
        missedTurns,
        lastSpeakerId,
        roundNumber: turn,
        hasEventCard: Boolean(eventCard),
      }, random);
    } else {
      const scores = await scoreRound(activeAgents, workingRoom, chat, at, eventCard);
      if (scores.every((entry) => entry.score === null)) {
        result = "所有抢麦评分都未接通";
        break;
      }
      const micOptions = {
        ...DEFAULT_MIC_OPTIONS,
        missedTurns,
        lastSpeakerId,
        scoreHistory: mic.scoreHistory,
      };
      const rankedScores = rankMicCandidates(scores, micOptions);
      winner = pickMicWinner(scores, micOptions, random);
      mic.scoreHistory = recordMicScores(mic.scoreHistory, scores);
      if (scores.some((entry) => Number.isFinite(entry.score))) mic.revision += 1;
      for (const entry of rankedScores) {
        if (!entry.eligible) continue;
        missedTurns[entry.id] = entry.id === winner?.id ? 0 : (missedTurns[entry.id] || 0) + 1;
      }
    }
    if (!winner) {
      result = generated.length
        ? `新增 ${generated.length} 条发言，随后全员弃权收场`
        : "全员弃权，本次安静收场";
      break;
    }

    if (strategy === "light-mic") {
      for (const agent of activeAgents) {
        missedTurns[agent.id] = agent.id === winner.id ? 0 : (missedTurns[agent.id] || 0) + 1;
      }
    }
    const speaker = activeAgents.find((agent) => agent.id === winner.id);
    try {
      const reply = await chat({
        agent: speaker,
        roomId: room.id,
        temperature: 0.8,
        maxTokens: Math.min(
          4096,
          scheduledVisibleTokenTarget(room) + (speaker.memoryEnabled ? PRIVATE_MEMORY_TOKEN_ALLOWANCE : 0),
        ),
        messages: replyMessages(speaker, activeAgents, workingRoom, at, eventCard, strategy),
      });
      const parsedReply = speaker.memoryEnabled
        ? parseAgentReply(reply.text)
        : { visibleText: reply.text, memoryItems: [] };
      if (parsedReply.memoryItems.length) {
        privateMemoryItems[speaker.id] = [
          ...(privateMemoryItems[speaker.id] || []),
          ...parsedReply.memoryItems,
        ];
        speaker.memory = appendAgentMemory(speaker.memory, parsedReply.memoryItems, {
          roomName: room.name,
          at,
        });
      }
      const parsedMessages = parsePrivateMessageReply(parsedReply.visibleText, {
        agentId: speaker.id,
        recipients: activeAgents,
      });
      const replyMessagesToSave = [
        ...(parsedMessages.publicText
          ? [{ text: parsedMessages.publicText, privacy: null, recipientIds: [] }]
          : []),
        ...parsedMessages.privateMessages.map((message) => ({
          text: message.text,
          privacy: "private",
          recipientIds: message.recipientIds,
        })),
      ];
      for (const replyMessage of replyMessagesToSave) {
        const formatted = formatChatBubbleReply(replyMessage.text, room.bubbleSplit);
        const message = {
          id: `message-${randomUUID()}`,
          kind: "agent",
          author: speaker.name,
          text: formatted.text,
          ...(formatted.segments.length ? { segments: formatted.segments } : {}),
          agentId: speaker.id,
          ...(replyMessage.privacy === "private"
            ? { privacy: "private", recipientIds: replyMessage.recipientIds }
            : {}),
          source: "scheduled",
          timestamp: at + generated.length,
        };
        generated.push(message);
        workingRoom.messages.push(message);
      }
      lastSpeakerId = speaker.id;
      result = replyMessagesToSave.length
        ? `新增 ${generated.length} 条定时发言`
        : `${speaker.name} 抢到麦，但没有留下可显示内容`;
    } catch (error) {
      result = `${speaker.name} 抢到麦后未接通：${error.message}`;
      break;
    }
  }
  const nextEventCards = generated.length && eventCard
    ? recordRoomEventCard(room.eventCards, eventCard)
    : null;
  return {
    messages: generated,
    result,
    mic: strategy === "mic-grab" ? mic : null,
    eventCards: nextEventCards,
    privateMemoryItems,
  };
}

async function maybeSummarizeRoom(stateStore, chat, roomId) {
  const snapshot = await stateStore.clientState();
  const room = snapshot.rooms.find((item) => item.id === roomId);
  const summarizer = snapshot.summarizer;
  if (!room?.memory?.enabled || room.memory.stale || !isConfigured(summarizer)) return false;
  const messages = publicRoomMessages(room.messages)
    .filter((message) => message.kind !== "error" && String(message.text || "").trim());
  const previousMarker = room.memory.summarizedThroughId || "";
  const markerIndex = previousMarker ? messages.findIndex((message) => message.id === previousMarker) : -1;
  if (previousMarker && markerIndex < 0) return false;
  const pending = messages.slice(markerIndex + 1);
  const source = completeAutomaticSummaryBatch(pending, room.memory.interval);
  if (!source.length) return false;

  const sections = [];
  const chunkSize = Math.max(5, Number(room.memory.interval) || 20);
  const startOffset = Math.max(0, Number(room.memory.summarizedMessageCount) || 0);
  for (let index = 0; index < source.length; index += chunkSize) {
    const chunk = source.slice(index, index + chunkSize);
    const startNumber = startOffset + index + 1;
    const endNumber = startOffset + index + chunk.length;
    const response = await chat({
      agent: summarizer,
      roomId,
      temperature: 0.2,
      maxTokens: 1400,
      requestMode: "memory-summary",
      messages: buildAppendSummaryMessages(room, chunk),
    });
    sections.push(formatMemorySegment(chunk, response.text, startNumber, endNumber));
  }
  const summary = [String(room.memory.summary || "").trim(), ...sections]
    .filter(Boolean)
    .join("\n\n---\n\n");
  const lastId = source.at(-1).id;
  return stateStore.completeRoomSummary(roomId, {
    summary,
    summarizedThroughId: lastId,
    summarizedMessageCount: messages.findIndex((message) => message.id === lastId) + 1,
    expectedPreviousMarker: previousMarker,
  });
}

export function createRoomScheduler({ stateStore, chat, tickMs = SCHEDULER_TICK_MS, now = Date.now }) {
  const runningRooms = new Set();
  let timer = null;
  let ticking = false;

  async function processRoom(room, agents, currentTime) {
    runningRooms.add(room.id);
    try {
      const outcome = await runScheduledRoom({ room, agents, chat, at: currentTime });
      await stateStore.completeScheduledRun(room.id, {
        messages: outcome.messages,
        result: outcome.result,
        mic: outcome.mic,
        eventCards: outcome.eventCards,
        privateMemoryItems: outcome.privateMemoryItems,
        at: Date.now(),
      });
      try {
        await maybeSummarizeRoom(stateStore, chat, room.id);
      } catch {
        // Scheduled chat stays saved even when the optional memory editor is unavailable.
      }
    } finally {
      runningRooms.delete(room.id);
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const snapshot = await stateStore.clientState();
      const currentTime = now();
      for (const room of snapshot.rooms) {
        const schedule = room.schedule;
        if (!schedule?.enabled || runningRooms.has(room.id)) continue;
        if (!schedule.nextWakeAt) {
          await stateStore.deferScheduledRoom(room.id, {
            nextWakeAt: currentTime + schedule.intervalMinutes * 60_000,
            result: "已排好下一次定时唤醒",
          });
          continue;
        }
        if (schedule.nextWakeAt > currentTime) continue;
        const today = localDayKey(currentTime);
        const usedToday = schedule.dayKey === today ? schedule.dailyCount : 0;
        if (usedToday >= schedule.dailyLimit) {
          await stateStore.deferScheduledRoom(room.id, {
            nextWakeAt: nextLocalDay(currentTime),
            result: `今日已达 ${schedule.dailyLimit} 次唤醒上限，明天再聊`,
          });
          continue;
        }
        if (isQuietTime(schedule, currentTime)) {
          await stateStore.deferScheduledRoom(room.id, {
            nextWakeAt: nextQuietEnd(schedule, currentTime),
            result: "现在是免打扰时段，已延后唤醒",
          });
          continue;
        }
        await processRoom(room, snapshot.agents, currentTime);
      }
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    void tick();
    timer = setInterval(() => void tick(), tickMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick };
}

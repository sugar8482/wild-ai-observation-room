import { randomUUID } from "node:crypto";
import { DEFAULT_MIC_OPTIONS, parseWillingnessScore, pickMicWinner } from "../public/mic-grab.js";
import { buildSummaryMessages } from "../public/memory-prompt.js";
import { bubbleSplitInstruction, formatChatBubbleReply } from "../public/chat-bubbles.js";

const SCHEDULER_TICK_MS = 15_000;
const SCHEDULED_VISIBLE_TOKENS = 300;

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

function recentTranscript(room, limit = 40) {
  return room.messages
    .filter((message) => message.kind !== "error")
    .slice(-limit)
    .map((message) => `${message.author}：${message.text}`)
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

function scoringMessages(agent, agents, room) {
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
        "这是一次后台定时唤醒，用户没有刚刚发新消息。你只需决定自己是否真的想主动开口。",
        "可以延续旧话题、提起新想法、点名或追问其他嘉宾；没话说就弃权，不要因为被唤醒而硬凑发言。",
        "只输出一个 0 到 10 的整数：0=完全不想接话，4=勉强有话可说，7=很想接，10=必须现在说。",
        "不要解释，不要加标点或其他文字。",
      ].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: `【最近群聊】\n${recentTranscript(room, 8) || "（暂无聊天记录）"}\n\n你现在有多想主动开口？只输出 0-10 的整数。`,
    },
  ];
}

function replyMessages(agent, agents, room) {
  const others = activeAgentNames(agent, agents);
  const atmosphere = String(room.roomPrompt || "").trim() || "本聊天室没有额外氛围设定。";
  const persona = String(agent.persona || "").trim()
    || "没有额外角色设定。请按你自然、未预设的表达倾向参与。";
  const memory = longTermMemory(room);
  const recentLimit = room.memory?.enabled && String(room.memory?.summary || "").trim()
    ? Number(room.memory.recentMessages) || 30
    : 40;
  return [
    {
      role: "system",
      content: [
        `你是群聊嘉宾“${agent.name}”。`,
        others.length ? `同桌还有：${others.join("、")}。` : "当前只有你一位 AI 嘉宾。",
        `本聊天室共同的氛围提示如下：\n${atmosphere}`,
        `你的角色设定如下：\n${persona}`,
        "只代表自己发言，不要代替其他嘉宾或用户说话。可以回应、赞同、质疑、点名或追问其他嘉宾。",
        `这是群聊中的一次简短发言。最终正文尽量控制在约 ${SCHEDULED_VISIBLE_TOKENS} tokens 以内，优先保证句子完整。`,
        bubbleSplitInstruction(room.bubbleSplit),
        "直接输出你在群聊里要说的话，不加姓名前缀，不复述规则。",
      ].filter(Boolean).join("\n\n"),
    },
    {
      role: "user",
      content: [
        memory,
        `以下是最近的群聊原文：\n\n${recentTranscript(room, recentLimit) || "（暂无聊天记录）"}`,
        "这是一次后台定时唤醒，用户没有刚刚发新消息。你刚才表示自己想说，并抢到了这轮麦克风。",
        "可以自然延续话题、主动开新话题、点名或询问其他嘉宾。不要假装用户刚说了什么。现在请开口。",
      ].filter(Boolean).join("\n\n"),
    },
  ];
}

async function scoreRound(agents, room, chat) {
  const settled = await Promise.allSettled(agents.map(async (agent) => {
    const response = await chat({
      agent,
      roomId: room.id,
      temperature: 0.2,
      maxTokens: 8,
      requestMode: "willingness-score",
      messages: scoringMessages(agent, agents, room),
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
  const missedTurns = {};
  let lastSpeakerId = workingRoom.messages.filter((message) => message.kind === "agent").at(-1)?.agentId || "";
  let result = "全员弃权，本次安静收场";

  for (let turn = 1; turn <= room.schedule.maxTurns; turn += 1) {
    const scores = await scoreRound(activeAgents, workingRoom, chat);
    if (scores.every((entry) => entry.score === null)) {
      result = "所有抢麦评分都未接通";
      break;
    }
    const winner = pickMicWinner(scores, {
      ...DEFAULT_MIC_OPTIONS,
      missedTurns,
      lastSpeakerId,
    }, random);
    if (!winner) {
      result = generated.length
        ? `新增 ${generated.length} 条发言，随后全员弃权收场`
        : "全员弃权，本次安静收场";
      break;
    }

    for (const entry of scores) {
      if (entry.score === null || entry.score < DEFAULT_MIC_OPTIONS.threshold) continue;
      missedTurns[entry.id] = entry.id === winner.id ? 0 : (missedTurns[entry.id] || 0) + 1;
    }
    const speaker = activeAgents.find((agent) => agent.id === winner.id);
    try {
      const reply = await chat({
        agent: speaker,
        roomId: room.id,
        temperature: 0.8,
        maxTokens: SCHEDULED_VISIBLE_TOKENS,
        messages: replyMessages(speaker, activeAgents, workingRoom),
      });
      const formatted = formatChatBubbleReply(reply.text, room.bubbleSplit);
      const message = {
        id: `message-${randomUUID()}`,
        kind: "agent",
        author: speaker.name,
        text: formatted.text,
        ...(formatted.segments.length ? { segments: formatted.segments } : {}),
        agentId: speaker.id,
        source: "scheduled",
        timestamp: at + generated.length,
      };
      generated.push(message);
      workingRoom.messages.push(message);
      lastSpeakerId = speaker.id;
      result = `新增 ${generated.length} 条定时发言`;
    } catch (error) {
      result = `${speaker.name} 抢到麦后未接通：${error.message}`;
      break;
    }
  }
  return { messages: generated, result };
}

async function maybeSummarizeRoom(stateStore, chat, roomId) {
  const snapshot = await stateStore.clientState();
  const room = snapshot.rooms.find((item) => item.id === roomId);
  const summarizer = snapshot.summarizer;
  if (!room?.memory?.enabled || room.memory.stale || !isConfigured(summarizer)) return false;
  const messages = room.messages.filter((message) => message.kind !== "error" && String(message.text || "").trim());
  const previousMarker = room.memory.summarizedThroughId || "";
  const markerIndex = previousMarker ? messages.findIndex((message) => message.id === previousMarker) : -1;
  if (previousMarker && markerIndex < 0) return false;
  const pending = messages.slice(markerIndex + 1);
  if (pending.length < room.memory.interval) return false;

  let summary = room.memory.summary || "";
  for (let index = 0; index < pending.length; index += 40) {
    const response = await chat({
      agent: summarizer,
      roomId,
      temperature: 0.2,
      maxTokens: 1800,
      requestMode: "memory-summary",
      messages: buildSummaryMessages(room, summary, pending.slice(index, index + 40)),
    });
    summary = response.text.trim();
  }
  const lastId = pending.at(-1).id;
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

import { randomUUID } from "node:crypto";

import {
  DEFAULT_ROOM_SUMMARY_INTERVAL,
  buildAppendSummaryMessages,
  buildRebuildSectionMessages,
  completeAutomaticSummaryBatch,
  isLegacyTruncatedRoomSummary,
} from "../public/memory-prompt.js";
import { publicRoomMessages } from "../public/private-messages.js";

const TERMINAL_JOB_TTL_MS = 6 * 60 * 60_000;

function configured(agent) {
  const hasAuth = agent?.authType === "none" || agent?.hasApiKey || Boolean(agent?.apiKey);
  return Boolean(String(agent?.baseUrl || "").trim() && String(agent?.model || "").trim() && hasAuth);
}

function roomMessages(room) {
  return publicRoomMessages(room?.messages || [])
    .filter((message) => message.kind !== "error" && String(message.text || "").trim());
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    roomId: job.roomId,
    rebuild: job.rebuild,
    automatic: job.automatic,
    status: job.status,
    phase: job.phase,
    totalMessages: job.totalMessages,
    processedMessages: job.processedMessages,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  };
}

function summaryError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

export function createRoomSummaryJobs({ stateStore, chat, now = Date.now, createId = randomUUID }) {
  const jobs = new Map();
  const latestByRoom = new Map();
  const activeByRoom = new Map();

  function prune() {
    const cutoff = now() - TERMINAL_JOB_TTL_MS;
    for (const [id, job] of jobs) {
      if (!job.finishedAt || job.finishedAt >= cutoff) continue;
      jobs.delete(id);
      if (latestByRoom.get(job.roomId) === id) latestByRoom.delete(job.roomId);
    }
  }

  function touch(job, changes = {}) {
    Object.assign(job, changes, { updatedAt: now() });
  }

  async function run(job) {
    touch(job, { status: "running" });
    try {
      for (let offset = 0; offset < job.messageIds.length; offset += job.chunkSize) {
        if (job.controller.signal.aborted) throw new DOMException("已取消", "AbortError");

        const snapshot = await stateStore.clientState();
        const room = snapshot.rooms.find((item) => item.id === job.roomId);
        const summarizer = snapshot.summarizer;
        if (!room) throw summaryError("房间已经不存在", 404);
        if (!configured(summarizer)) throw summaryError("记忆整理员尚未接通", 409);
        const currentMessages = roomMessages(room);
        const currentById = new Map(currentMessages.map((message) => [message.id, message]));
        const ids = job.messageIds.slice(offset, offset + job.chunkSize);
        const chunk = ids.map((id) => currentById.get(id));
        if (chunk.some((message) => !message)) {
          throw summaryError("整理期间聊天记录发生了变化，请重新开始", 409);
        }

        touch(job, {
          phase: `正在后台整理第 ${job.processedMessages + 1}–${job.processedMessages + chunk.length} / ${job.totalMessages} 条`,
        });

        const currentSummary = job.rebuild && offset === 0
          ? ""
          : String(room.memory?.summary || "").trim();

        const response = await chat({
          agent: summarizer,
          roomId: room.id,
          temperature: 0.2,
          maxTokens: 4096,
          requestMode: "memory-summary",
          messages: job.rebuild
            ? buildRebuildSectionMessages(room, chunk, currentSummary)
            : buildAppendSummaryMessages(room, chunk, currentSummary),
        }, { signal: job.controller.signal });
        const body = String(response?.text || "").trim();
        if (!body) throw summaryError("整理模型没有返回文字", 502);

        const lastId = chunk.at(-1).id;
        const saved = await stateStore.completeRoomSummary(room.id, {
          summary: body,
          summarizedThroughId: lastId,
          summarizedMessageCount: currentMessages.findIndex((message) => message.id === lastId) + 1,
          expectedPreviousMarker: room.memory?.summarizedThroughId || "",
          expectedPreviousUpdatedAt: room.memory?.updatedAt ?? null,
          at: now(),
        });
        if (!saved) throw summaryError("房间记忆刚被其他操作更新，请重新开始", 409);

        touch(job, { processedMessages: job.processedMessages + chunk.length });
      }

      const finishedAt = now();
      touch(job, {
        status: "completed",
        phase: job.totalMessages ? `已在后台整理 ${job.totalMessages} 条记录` : "没有新的记录需要整理",
        finishedAt,
      });
    } catch (error) {
      const finishedAt = now();
      if (isAbortError(error) || job.controller.signal.aborted) {
        touch(job, {
          status: "cancelled",
          phase: "后台整理已取消；已经完成的批次仍然保留",
          finishedAt,
        });
      } else {
        touch(job, {
          status: "error",
          phase: "后台整理没有完成",
          error: error?.message || "后台整理失败",
          finishedAt,
        });
      }
    } finally {
      if (activeByRoom.get(job.roomId) === job.id) activeByRoom.delete(job.roomId);
    }
  }

  async function start({ roomId, rebuild = false, automatic = false } = {}) {
    prune();
    const id = String(roomId || "").trim();
    if (!id) throw summaryError("缺少房间编号");
    const activeId = activeByRoom.get(id);
    if (activeId) return publicJob(jobs.get(activeId));

    const snapshot = await stateStore.clientState();
    const room = snapshot.rooms.find((item) => item.id === id);
    if (!room) throw summaryError("没有找到要整理的房间", 404);
    const isAutomatic = automatic === true && rebuild !== true;
    if (isAutomatic && (room.roomType === "werewolf" || !room.memory?.enabled)) return null;
    if (!configured(snapshot.summarizer)) {
      if (isAutomatic) return null;
      throw summaryError("请先配置记忆整理员", 409);
    }
    const messages = roomMessages(room);
    let source = messages;
    if (!rebuild && isLegacyTruncatedRoomSummary(room.memory)) {
      if (isAutomatic) return null;
      throw summaryError("旧版长期总结已在保存上限处截断，请使用重新生成", 409);
    }
    if (!rebuild && String(room.memory?.summary || "").trim() && room.memory?.summarizedThroughId) {
      const markerIndex = messages.findIndex((message) => message.id === room.memory.summarizedThroughId);
      const fallbackCount = Math.min(
        messages.length,
        Math.max(0, Number(room.memory?.summarizedMessageCount) || 0),
      );
      source = messages.slice(markerIndex >= 0 ? markerIndex + 1 : fallbackCount);
    }
    if (isAutomatic) {
      source = completeAutomaticSummaryBatch(source, room.memory?.interval);
      if (!source.length) return null;
    }

    const startedAt = now();
    const job = {
      id: `summary-${createId()}`,
      roomId: id,
      rebuild: rebuild === true,
      automatic: isAutomatic,
      status: "queued",
      phase: source.length ? `后台任务已接收，准备整理 ${source.length} 条记录` : "没有新的记录需要整理",
      totalMessages: source.length,
      processedMessages: 0,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      error: "",
      chunkSize: rebuild
        ? DEFAULT_ROOM_SUMMARY_INTERVAL
        : Math.max(5, Math.min(100, Number(room.memory?.interval) || DEFAULT_ROOM_SUMMARY_INTERVAL)),
      messageIds: source.map((message) => message.id),
      controller: new AbortController(),
    };
    jobs.set(job.id, job);
    latestByRoom.set(id, job.id);
    if (source.length) {
      activeByRoom.set(id, job.id);
      queueMicrotask(() => void run(job));
    } else {
      const finishedAt = now();
      touch(job, { status: "completed", finishedAt });
    }
    return publicJob(job);
  }

  function get(jobId) {
    prune();
    return publicJob(jobs.get(String(jobId || "")));
  }

  function list({ roomId = "" } = {}) {
    prune();
    const id = String(roomId || "").trim();
    if (id) return [publicJob(jobs.get(latestByRoom.get(id)))].filter(Boolean);
    return [...latestByRoom.values()].map((jobId) => publicJob(jobs.get(jobId))).filter(Boolean);
  }

  function cancel(jobId) {
    const job = jobs.get(String(jobId || ""));
    if (!job) return null;
    if (["queued", "running"].includes(job.status)) {
      touch(job, { status: "cancelling", phase: "正在请后台整理员停在当前批次" });
      job.controller.abort();
    }
    return publicJob(job);
  }

  function isActive(roomId) {
    return activeByRoom.has(String(roomId || ""));
  }

  async function maybeStart(roomId) {
    try {
      return await start({ roomId, automatic: true });
    } catch {
      return null;
    }
  }

  async function scan() {
    const snapshot = await stateStore.clientState();
    return Promise.all((snapshot.rooms || []).map((room) => maybeStart(room.id)));
  }

  function stop() {
    for (const job of jobs.values()) {
      if (["queued", "running", "cancelling"].includes(job.status)) job.controller.abort();
    }
  }

  return { start, maybeStart, scan, get, list, cancel, isActive, stop };
}

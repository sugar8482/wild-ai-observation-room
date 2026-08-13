import { randomUUID } from "node:crypto";

import {
  buildAppendSummaryMessages,
  buildRebuildSectionMessages,
  formatMemorySegment,
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
        if (room.memory?.stale && !job.rebuild) {
          throw summaryError("旧记忆已经变动，请改用重新生成", 409);
        }

        const currentMessages = roomMessages(room);
        const currentById = new Map(currentMessages.map((message) => [message.id, message]));
        const ids = job.messageIds.slice(offset, offset + job.chunkSize);
        const chunk = ids.map((id) => currentById.get(id));
        if (chunk.some((message) => !message)) {
          throw summaryError("整理期间聊天记录发生了变化，请重新开始", 409);
        }

        const startNumber = job.rebuild && offset === 0
          ? 1
          : Math.max(0, Number(room.memory?.summarizedMessageCount) || 0) + 1;
        const endNumber = startNumber + chunk.length - 1;
        touch(job, {
          phase: `正在后台整理第 ${job.processedMessages + 1}–${job.processedMessages + chunk.length} / ${job.totalMessages} 条`,
        });

        const response = await chat({
          agent: summarizer,
          roomId: room.id,
          temperature: 0.2,
          maxTokens: job.rebuild ? 2200 : 1400,
          requestMode: "memory-summary",
          messages: job.rebuild
            ? buildRebuildSectionMessages(room, chunk)
            : buildAppendSummaryMessages(room, chunk),
        }, { signal: job.controller.signal });
        const body = String(response?.text || "").trim();
        if (!body) throw summaryError("整理模型没有返回文字", 502);

        const segment = formatMemorySegment(chunk, body, startNumber, endNumber);
        const currentSummary = String(room.memory?.summary || "").trim();
        const summary = job.rebuild && offset === 0
          ? `# 全篇时间记录\n\n${segment}`
          : [currentSummary, segment].filter(Boolean).join("\n\n---\n\n");
        const lastId = chunk.at(-1).id;
        const saved = await stateStore.completeRoomSummary(room.id, {
          summary,
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

  async function start({ roomId, rebuild = false } = {}) {
    prune();
    const id = String(roomId || "").trim();
    if (!id) throw summaryError("缺少房间编号");
    const activeId = activeByRoom.get(id);
    if (activeId) return publicJob(jobs.get(activeId));

    const snapshot = await stateStore.clientState();
    const room = snapshot.rooms.find((item) => item.id === id);
    if (!room) throw summaryError("没有找到要整理的房间", 404);
    if (!configured(snapshot.summarizer)) throw summaryError("请先配置记忆整理员", 409);
    if (room.memory?.stale && !rebuild) throw summaryError("旧记忆已经变动，请改用重新生成", 409);

    const messages = roomMessages(room);
    let source = messages;
    if (!rebuild && String(room.memory?.summary || "").trim() && room.memory?.summarizedThroughId) {
      const markerIndex = messages.findIndex((message) => message.id === room.memory.summarizedThroughId);
      if (markerIndex < 0) throw summaryError("旧记忆的整理位置已经失效，请重新生成", 409);
      source = messages.slice(markerIndex + 1);
    }

    const startedAt = now();
    const job = {
      id: `summary-${createId()}`,
      roomId: id,
      rebuild: rebuild === true,
      status: "queued",
      phase: source.length ? `后台任务已接收，准备整理 ${source.length} 条记录` : "没有新的记录需要整理",
      totalMessages: source.length,
      processedMessages: 0,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      error: "",
      chunkSize: rebuild ? 40 : Math.max(5, Math.min(100, Number(room.memory?.interval) || 20)),
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

  function stop() {
    for (const job of jobs.values()) {
      if (["queued", "running", "cancelling"].includes(job.status)) job.controller.abort();
    }
  }

  return { start, get, list, cancel, isActive, stop };
}

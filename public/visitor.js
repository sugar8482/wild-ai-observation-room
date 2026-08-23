const byId = (id) => document.getElementById(id);
const feed = byId("visitor-feed");
const empty = byId("visitor-empty");
const emptyCopy = byId("visitor-empty-copy");
const form = byId("visitor-composer");
const input = byId("visitor-message");
const sendButton = byId("visitor-send");
const status = byId("visitor-status");

const hashToken = decodeURIComponent(location.hash.replace(/^#/, "").trim());
if (hashToken) sessionStorage.setItem("observation_visitor_token", hashToken);
const token = hashToken || sessionStorage.getItem("observation_visitor_token") || "";
if (location.hash) history.replaceState(null, "", "/visitor.html");

let invite = null;
let room = null;
let syncCount = 0;
let syncing = false;

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function render() {
  byId("visitor-name").textContent = invite?.name || "访客";
  byId("visitor-room-name").textContent = room?.name || "邀请尚未生效";
  byId("visitor-room-members").textContent = room?.participantNames?.length
    ? `房间嘉宾：${room.participantNames.join("、")}`
    : "只会显示公开消息";

  feed.querySelectorAll(".visitor-message").forEach((element) => element.remove());
  const messages = room?.messages || [];
  empty.classList.toggle("is-hidden", messages.length > 0);
  for (const message of messages) {
    const article = document.createElement("article");
    const own = message.externalId && message.externalId === invite?.id;
    article.className = `visitor-message${own ? " is-own" : ""}`;
    const meta = document.createElement("div");
    meta.className = "visitor-message-meta";
    const author = document.createElement("strong");
    author.textContent = message.author;
    const source = document.createElement("span");
    source.textContent = message.source === "mcp" ? "MCP 访客" : message.source === "visitor" ? "朋友访客" : "";
    const time = document.createElement("time");
    time.textContent = formatTime(message.timestamp);
    meta.append(author);
    if (source.textContent) meta.append(source);
    meta.append(time);
    const body = document.createElement("div");
    body.className = "visitor-message-body";
    body.textContent = message.text;
    article.append(meta, body);
    feed.append(article);
  }
}

function setUnavailable(message) {
  empty.classList.remove("is-hidden");
  emptyCopy.textContent = message;
  status.textContent = message;
  input.disabled = true;
  sendButton.disabled = true;
}

async function sync({ forceFull = false, scroll = false } = {}) {
  if (!token || syncing) {
    if (!token) setUnavailable("邀请地址不完整，请让房主重新复制链接。");
    return;
  }
  syncing = true;
  try {
    const knownMessages = room?.messages || [];
    const after = forceFull || !knownMessages.length
      ? 0
      : Math.max(...knownMessages.map((message) => Number(message.timestamp) || 0));
    const response = await fetch("/api/visit/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, after }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "邀请暂时无法使用");
    invite = payload.invite;
    if (!room || !after) {
      room = payload.room;
    } else {
      const existing = new Map(room.messages.map((message) => [message.id, message]));
      for (const message of payload.room.messages || []) existing.set(message.id, message);
      room = {
        ...room,
        ...payload.room,
        messages: [...existing.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-500),
      };
    }
    input.disabled = false;
    sendButton.disabled = false;
    status.textContent = "";
    render();
    if (scroll) feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
  } catch (error) {
    setUnavailable(error.message);
  } finally {
    syncing = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !token) return;
  input.disabled = true;
  sendButton.disabled = true;
  status.textContent = "正在送进房间……";
  try {
    const response = await fetch("/api/visit/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, text }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "消息没有发送成功");
    input.value = "";
    await sync({ forceFull: true, scroll: true });
  } catch (error) {
    status.textContent = error.message;
    input.disabled = false;
    sendButton.disabled = false;
  }
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

void sync({ forceFull: true, scroll: true });
setInterval(() => {
  syncCount += 1;
  void sync({ forceFull: syncCount % 20 === 0 });
}, 3_000);

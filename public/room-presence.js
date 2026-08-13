export const ROOM_MEMBER_STATUSES = Object.freeze(["active", "away", "left"]);

export const ROOM_MEMBER_STATUS_LABELS = Object.freeze({
  active: "在席",
  away: "暂离席",
  left: "已离开",
});

function safeStatus(value) {
  return ROOM_MEMBER_STATUSES.includes(value) ? value : "active";
}

export function roomMembers(room, agents = []) {
  const agentNames = new Map(agents.map((agent) => [String(agent.id), String(agent.name || "未命名嘉宾")]));
  const members = new Map();
  for (const rawMember of Array.isArray(room?.members) ? room.members : []) {
    const id = String(rawMember?.id || "").trim();
    if (!id) continue;
    members.set(id, {
      id,
      name: String(rawMember.name || agentNames.get(id) || "未命名嘉宾"),
      type: ["agent", "mcp", "human"].includes(rawMember.type) ? rawMember.type : "agent",
      status: safeStatus(rawMember.status),
      note: String(rawMember.note || ""),
      joinedAt: Number(rawMember.joinedAt) || Number(room?.createdAt) || Date.now(),
      statusChangedAt: Number(rawMember.statusChangedAt) || Number(room?.updatedAt) || Date.now(),
      lastSeenAt: Number(rawMember.lastSeenAt) || null,
    });
  }
  for (const rawId of Array.isArray(room?.participantIds) ? room.participantIds : []) {
    const id = String(rawId || "").trim();
    if (!id || members.has(id)) continue;
    members.set(id, {
      id,
      name: agentNames.get(id) || "未命名嘉宾",
      type: "agent",
      status: "active",
      note: "",
      joinedAt: Number(room?.createdAt) || Date.now(),
      statusChangedAt: Number(room?.createdAt) || Date.now(),
      lastSeenAt: null,
    });
  }

  // Backfill the ledger from old room history. External visitors are treated as
  // away (they came by, but are not currently connected); former internal
  // agents are treated as left. Neither status claims why they went away or
  // whether they will return.
  for (const message of Array.isArray(room?.messages) ? room.messages : []) {
    const external = message?.source === "mcp" || message?.source === "visitor";
    const id = String(external ? (message?.externalId || message?.agentId || "") : (message?.agentId || "")).trim();
    if (!id || message?.kind !== "agent") continue;
    const timestamp = Number(message?.timestamp) || Number(room?.createdAt) || Date.now();
    const existing = members.get(id);
    if (existing) {
      existing.joinedAt = Math.min(existing.joinedAt || timestamp, timestamp);
      existing.lastSeenAt = Math.max(existing.lastSeenAt || 0, timestamp);
      continue;
    }
    members.set(id, {
      id,
      name: String(message?.author || agentNames.get(id) || "未命名嘉宾"),
      type: external ? (message?.source === "visitor" ? "human" : "mcp") : "agent",
      status: external ? "away" : "left",
      note: "",
      joinedAt: timestamp,
      statusChangedAt: timestamp,
      lastSeenAt: timestamp,
    });
  }
  return [...members.values()];
}

export function roomMember(room, memberId, agents = []) {
  return roomMembers(room, agents).find((member) => member.id === String(memberId || "")) || null;
}

export function activeRoomAgents(room, agents = []) {
  const statusById = new Map(roomMembers(room, agents).map((member) => [member.id, member.status]));
  const participantIds = new Set(Array.isArray(room?.participantIds) ? room.participantIds.map(String) : []);
  return agents.filter((agent) => participantIds.has(String(agent.id)) && statusById.get(String(agent.id)) !== "away" && statusById.get(String(agent.id)) !== "left");
}

export function availableRoomMembers(room, agents = []) {
  return roomMembers(room, agents).filter((member) => member.status !== "left");
}

export function roomPresenceContext(room, agents = []) {
  const members = roomMembers(room, agents);
  if (!members.length) return "";
  const lines = [];
  for (const status of ROOM_MEMBER_STATUSES) {
    const matching = members.filter((member) => member.status === status);
    if (!matching.length) continue;
    lines.push(`${ROOM_MEMBER_STATUS_LABELS[status]}：${matching.map((member) => (
      member.note ? `${member.name}（挂牌：${member.note}）` : member.name
    )).join("、")}`);
  }
  return [
    "【本房成员簿】",
    ...lines,
    "成员状态只表示谁正在参与、暂时不参与或已经离开本房。不要擅自推断原因、替离席者发言，或承诺其何时回来。",
  ].join("\n");
}

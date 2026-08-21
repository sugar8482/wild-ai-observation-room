export const WEREWOLF_USER_ID = "werewolf-user";

export const WEREWOLF_ROLE_META = Object.freeze({
  wolf: { label: "狼人", team: "wolf", icon: "🐺" },
  seer: { label: "预言家", team: "good", icon: "🔮" },
  witch: { label: "女巫", team: "good", icon: "🧪" },
  villager: { label: "村民", team: "good", icon: "🌾" },
});

export const WEREWOLF_PHASE_META = Object.freeze({
  night_wolves: "狼人睁眼",
  night_seer: "预言家验人",
  night_witch: "女巫用药",
  dawn: "天亮了",
  day_speech: "白天发言",
  day_vote: "公开投票",
  tie_speech: "平票辩护",
  tie_vote: "平票重投",
  last_words: "离场遗言",
  ended: "游戏结束",
});

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function text(value, maxLength = 20_000) {
  return String(value ?? "").slice(0, maxLength);
}

function cleanId(value) {
  const id = text(value, 120);
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : "";
}

export function shuffleWerewolfItems(items, random = Math.random) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

export function werewolfRoleDeck(playerCount) {
  if (playerCount === 6) return ["wolf", "wolf", "seer", "witch", "villager", "villager"];
  if (playerCount === 7) return ["wolf", "wolf", "seer", "witch", "villager", "villager", "villager"];
  throw new Error("经典首版只支持 6 或 7 位玩家");
}

function gameId() {
  return `werewolf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createWerewolfGame({ participants, viewMode = "player", costMode = "economy", roleAssignments = null, random = Math.random }) {
  const unique = [];
  const seen = new Set();
  for (const participant of Array.isArray(participants) ? participants : []) {
    const id = cleanId(participant?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push({
      id,
      name: text(participant?.name, 80).trim() || "未命名玩家",
      type: participant?.type === "user" ? "user" : "agent",
    });
  }
  const deck = werewolfRoleDeck(unique.length);
  const assignedRoles = roleAssignments && typeof roleAssignments === "object"
    ? unique.map((participant) => roleAssignments[participant.id])
    : null;
  const hasManualDeal = assignedRoles
    && assignedRoles.every((role) => Object.hasOwn(WEREWOLF_ROLE_META, role))
    && [...assignedRoles].sort().join("|") === [...deck].sort().join("|");
  const seatedParticipants = hasManualDeal ? unique : shuffleWerewolfItems(unique, random);
  const roles = hasManualDeal ? assignedRoles : shuffleWerewolfItems(deck, random);
  const players = seatedParticipants.map((participant, index) => ({
    ...participant,
    role: roles[index],
    alive: true,
    eliminatedDay: null,
  }));
  const now = Date.now();
  return {
    version: 1,
    id: gameId(),
    status: "active",
    viewMode: viewMode === "god" ? "god" : "player",
    costMode: costMode === "standard" ? "standard" : "economy",
    dealMode: hasManualDeal ? "manual" : "random",
    day: 1,
    phase: "night_wolves",
    players,
    log: [{
      id: `game-log-${now}`,
      day: 1,
      phase: "night_wolves",
      visibility: "public",
      authorId: "system",
      author: "法官",
      text: "身份牌已经发好。天黑请闭眼。",
      timestamp: now,
    }],
    nights: [],
    days: [],
    seerChecks: [],
    witch: { healAvailable: true, poisonAvailable: true },
    pending: {},
    tieRound: 0,
    winner: null,
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizePlayer(player) {
  const role = Object.hasOwn(WEREWOLF_ROLE_META, player?.role) ? player.role : "villager";
  return {
    id: cleanId(player?.id),
    name: text(player?.name, 80).trim() || "未命名玩家",
    type: player?.type === "user" ? "user" : "agent",
    role,
    alive: player?.alive !== false,
    eliminatedDay: Number.isFinite(Number(player?.eliminatedDay)) ? Number(player.eliminatedDay) : null,
  };
}

function sanitizeLogEntry(entry) {
  const visibility = ["public", "wolves", "seer", "witch", "god"].includes(entry?.visibility)
    ? entry.visibility
    : "public";
  return {
    id: cleanId(entry?.id) || `game-log-${Math.random().toString(36).slice(2, 10)}`,
    day: boundedInteger(entry?.day, 1, 1, 99),
    phase: Object.hasOwn(WEREWOLF_PHASE_META, entry?.phase) ? entry.phase : "day_speech",
    visibility,
    authorId: cleanId(entry?.authorId) || "system",
    author: text(entry?.author, 80).trim() || "法官",
    text: text(entry?.text, 20_000),
    timestamp: Number.isFinite(Number(entry?.timestamp)) ? Number(entry.timestamp) : Date.now(),
  };
}

function sanitizeRecordList(value, limit = 50) {
  return (Array.isArray(value) ? value : []).slice(-limit).map((entry) => ({
    ...entry,
    day: boundedInteger(entry?.day, 1, 1, 99),
  }));
}

export function sanitizeWerewolfGame(game) {
  if (!game || typeof game !== "object" || !String(game.id || "")) return null;
  const players = (Array.isArray(game.players) ? game.players : [])
    .slice(0, 7)
    .map(sanitizePlayer)
    .filter((player) => player.id);
  if (![6, 7].includes(players.length)) return null;
  const status = game.status === "ended" ? "ended" : "active";
  const phase = status === "ended" || !Object.hasOwn(WEREWOLF_PHASE_META, game.phase)
    ? (status === "ended" ? "ended" : "night_wolves")
    : game.phase;
  return {
    version: 1,
    id: cleanId(game.id) || gameId(),
    status,
    viewMode: game.viewMode === "god" ? "god" : "player",
    costMode: game.costMode === "standard" ? "standard" : "economy",
    dealMode: game.dealMode === "manual" ? "manual" : "random",
    day: boundedInteger(game.day, 1, 1, 99),
    phase,
    players,
    log: (Array.isArray(game.log) ? game.log : []).slice(-500).map(sanitizeLogEntry),
    nights: sanitizeRecordList(game.nights),
    days: sanitizeRecordList(game.days),
    seerChecks: sanitizeRecordList(game.seerChecks, 100),
    witch: {
      healAvailable: game.witch?.healAvailable !== false,
      poisonAvailable: game.witch?.poisonAvailable !== false,
    },
    pending: game.pending && typeof game.pending === "object" ? game.pending : {},
    tieRound: boundedInteger(game.tieRound, 0, 0, 2),
    winner: ["good", "wolf"].includes(game.winner) ? game.winner : null,
    createdAt: Number.isFinite(Number(game.createdAt)) ? Number(game.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(game.updatedAt)) ? Number(game.updatedAt) : Date.now(),
  };
}

export function appendWerewolfLog(game, { visibility = "public", authorId = "system", author = "法官", text: body, phase = game.phase }) {
  const content = text(body, 20_000).trim();
  if (!content) return null;
  const timestamp = Date.now();
  const entry = sanitizeLogEntry({
    id: `game-log-${timestamp.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    day: game.day,
    phase,
    visibility,
    authorId,
    author,
    text: content,
    timestamp,
  });
  game.log.push(entry);
  game.log = game.log.slice(-500);
  game.updatedAt = timestamp;
  return entry;
}

export function livingWerewolfPlayers(game) {
  return game.players.filter((player) => player.alive);
}

export function werewolfPlayer(game, id) {
  return game.players.find((player) => player.id === id) || null;
}

export function visibleWerewolfLog(game, viewerId = WEREWOLF_USER_ID) {
  if (game.viewMode === "god" || game.status === "ended") return game.log;
  const viewer = werewolfPlayer(game, viewerId);
  return game.log.filter((entry) => (
    entry.visibility === "public"
    || (entry.visibility === "wolves" && viewer?.role === "wolf")
    || (entry.visibility === "seer" && viewer?.role === "seer")
    || (entry.visibility === "witch" && viewer?.role === "witch")
    || entry.authorId === viewerId
  ));
}

export function parseWerewolfTarget(rawText, marker, players, validIds = null) {
  const source = String(rawText || "");
  const safeMarker = String(marker || "TARGET").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`\\[${safeMarker}\\s*[:：]\\s*([^\\]\\n]+)\\]`, "i"));
  if (!match) return null;
  const candidate = match[1].trim();
  const valid = validIds ? new Set(validIds) : null;
  const player = players.find((item) => (
    (item.id === candidate || item.name === candidate)
    && (!valid || valid.has(item.id))
  ));
  return player?.id || null;
}

export function stripWerewolfControls(rawText) {
  return String(rawText || "")
    .replace(/\[(?:TARGET|CHECK|VOTE)\s*[:：]\s*[^\]\n]+\]/gi, "")
    .replace(/\[WITCH\s*[:：][^\]\n]*\]/gi, "")
    .trim();
}

export function parseWitchAction(rawText, players, validPoisonIds) {
  const source = String(rawText || "");
  const match = source.match(/\[WITCH\s*[:：]\s*save\s*=\s*(yes|no|是|否)\s*[,，]\s*poison\s*=\s*([^\]\n]+)\]/i);
  if (!match) return { save: false, poisonTargetId: null };
  const save = /^(?:yes|是)$/i.test(match[1]);
  const poisonRaw = match[2].trim();
  const poisonTargetId = /^(?:none|无|不用|no)$/i.test(poisonRaw)
    ? null
    : players.find((player) => (
      (player.id === poisonRaw || player.name === poisonRaw)
      && new Set(validPoisonIds).has(player.id)
    ))?.id || null;
  return { save, poisonTargetId };
}

export function voteOutcome(votes, candidateIds) {
  const allowed = new Set(candidateIds);
  const counts = new Map(candidateIds.map((id) => [id, 0]));
  for (const targetId of Object.values(votes || {})) {
    if (allowed.has(targetId)) counts.set(targetId, (counts.get(targetId) || 0) + 1);
  }
  const maximum = Math.max(0, ...counts.values());
  if (!maximum) return { eliminatedId: null, tiedIds: [], counts: Object.fromEntries(counts) };
  const tiedIds = [...counts.entries()].filter(([, count]) => count === maximum).map(([id]) => id);
  return {
    eliminatedId: tiedIds.length === 1 ? tiedIds[0] : null,
    tiedIds: tiedIds.length > 1 ? tiedIds : [],
    counts: Object.fromEntries(counts),
  };
}

export function resolveWerewolfNight(game, { killTargetId = null, save = false, poisonTargetId = null } = {}) {
  const livingIds = new Set(livingWerewolfPlayers(game).map((player) => player.id));
  const validKill = livingIds.has(killTargetId) ? killTargetId : null;
  const validPoison = livingIds.has(poisonTargetId) ? poisonTargetId : null;
  const deaths = [];
  if (validKill && !save) deaths.push(validKill);
  if (validPoison && !deaths.includes(validPoison)) deaths.push(validPoison);
  for (const id of deaths) {
    const player = werewolfPlayer(game, id);
    if (player) {
      player.alive = false;
      player.eliminatedDay = game.day;
    }
  }
  return deaths;
}

export function checkWerewolfWinner(game) {
  const living = livingWerewolfPlayers(game);
  const wolves = living.filter((player) => player.role === "wolf").length;
  const good = living.length - wolves;
  if (wolves === 0) return "good";
  if (wolves >= good) return "wolf";
  return null;
}

export function finishWerewolfGame(game, winner) {
  game.status = "ended";
  game.phase = "ended";
  game.winner = winner;
  game.updatedAt = Date.now();
  appendWerewolfLog(game, {
    visibility: "public",
    text: winner === "wolf" ? "狼人阵营获胜。所有身份与夜间密谋现已解锁。" : "好人阵营获胜。所有身份与夜间密谋现已解锁。",
    phase: "ended",
  });
}

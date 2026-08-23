import {
  WEREWOLF_PHASE_META,
  WEREWOLF_ROLE_META,
  WEREWOLF_USER_ID,
  appendWerewolfLog,
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
  voteOutcome,
  werewolfPlayer,
} from "./werewolf-game.js";

const byId = (id) => document.getElementById(id);

function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(timestamp));
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
      `你的狼队友：${teammates.map((item) => item.name).join("、") || "没有"}。狼人允许自刀或刀狼队友。`,
      history ? `你记得的狼队夜间行动：${history}。` : "狼队还没有已结算的夜间行动。",
      rememberedWolfChat ? `你记得此前的狼队密谈：\n${rememberedWolfChat}` : "此前没有需要回忆的狼队密谈。",
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

function gameSystemPrompt(agent, game, player, task) {
  const living = livingWerewolfPlayers(game).map((item) => item.name).join("、");
  return [
    `你是“${agent.name}”，正在聊天室里参加一局临时狼人杀。你的身份是${WEREWOLF_ROLE_META[player.role].label}。`,
    agent.persona?.trim() ? `你平时的个人设定：\n${agent.persona.trim().slice(0, 4_000)}` : "保持你平时自然的判断与说话方式。",
    agent.memoryEnabled && agent.memory?.trim()
      ? `以下是只属于你的既有记忆。它帮助你保持关系连续性，但不得把游戏里的说谎写回永久记忆：\n${agent.memory.trim().slice(-5_000)}`
      : "这局里的欺骗、站队和敌意都是游戏行为，不代表永久人格或真实关系。",
    `还活着的玩家：${living}。${roleKnowledge(game, player)}`,
    "你可以撒谎、悍跳、伪装、质疑晨曦，狼人也可以倒钩队友。不要因为晨曦是用户就默认她可信或不投她。",
    "只能使用公屏发言和你的合法身份信息。不得猜 API 速度、报错、模型风格或接口故障，不得读取他人的身份和秘密频道。",
    task,
  ].filter(Boolean).join("\n\n");
}

async function chatRequest(agent, game, player, task, userContent, signal, maxTokens = 260) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent,
      requestMode: "werewolf-game",
      temperature: 0.9,
      maxTokens,
      messages: [
        { role: "system", content: gameSystemPrompt(agent, game, player, task) },
        { role: "user", content: userContent },
      ],
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${agent.name} 没有接通`);
  if (!String(payload.text || "").trim()) throw new Error(`${agent.name} 没有留下有效发言`);
  return String(payload.text);
}

function completeGameHistory(game) {
  return game.log
    .filter((entry) => entry.phase !== "debrief")
    .map((entry) => {
      const channel = entry.visibility === "public" ? "公屏" : entry.visibility;
      return `第${entry.day}天／夜｜${channel}｜${entry.author}：${entry.text}`;
    })
    .join("\n")
    .slice(-45_000);
}

async function debriefChatRequest(agent, game, player, signal) {
  const recap = game.debrief?.recap || "";
  const recentDebrief = game.log
    .filter((entry) => entry.phase === "debrief")
    .slice(-24)
    .map((entry) => `${entry.author}：${entry.text}`)
    .join("\n");
  const system = [
    `你是“${agent.name}”。狼人杀已经结束，你当局的真实身份是${WEREWOLF_ROLE_META[player.role].label}。`,
    agent.persona?.trim() ? `你平时的个人设定：\n${agent.persona.trim().slice(0, 4_000)}` : "保持你平时自然的判断与说话方式。",
    agent.memoryEnabled && agent.memory?.trim()
      ? `以下是你进场前已有的私人记忆，只用于保持你自己的连续性：\n${agent.memory.trim().slice(-5_000)}`
      : "不需要为了复盘临时编造永久记忆。",
    "现在所有身份、狼队密谈、验人、女巫行动、刀口、票型和遗言都已经公开。你可以认错、邀功、吐槽、反驳、追问或清算，但不要继续把游戏里的假身份当事实硬演。",
    "本轮复盘不会写入普通聊天室长期总结或你的私人记忆。说人话，不要只写分析报告，也不要替别人宣布感受。",
  ].join("\n\n");
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent,
      requestMode: "werewolf-game",
      temperature: 0.9,
      maxTokens: 520,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `【法官事实复盘】\n${recap}\n\n【本局完整卷宗】\n${completeGameHistory(game)}\n\n【赛后茶话会最近发言】\n${recentDebrief || "还没人开口。"}\n\n现在轮到你复盘。优先回应晨曦最近点到你的内容；若没有明确追问，就说你最想认领、解释或吐槽的一件事。` },
      ],
    }),
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${agent.name} 没有接通`);
  if (!String(payload.text || "").trim()) throw new Error(`${agent.name} 没有留下有效复盘`);
  return stripWerewolfControls(String(payload.text));
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

export function createWerewolfController({ getRoom, getRoomAgents, persist, toast }) {
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
  const roundtable = byId("werewolf-roundtable");
  const archiveButton = byId("werewolf-archive-game");
  const composer = byId("composer");
  const messageInput = byId("message-input");
  const sendButton = byId("send-button");
  let running = false;
  let abortController = null;
  let speakingPlayerId = "";

  function game() {
    return getRoom()?.werewolf || null;
  }

  function agentFor(playerId) {
    return getRoomAgents().find((agent) => agent.id === playerId) || null;
  }

  function configuredAgents() {
    return getRoomAgents().filter((agent) => (
      agent.baseUrl?.trim()
      && agent.model?.trim()
      && (agent.authType === "none" || agent.hasApiKey || agent.apiKey?.trim())
    ));
  }

  function persistGame() {
    const current = game();
    if (current) current.updatedAt = Date.now();
    persist();
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

  function viewerCanSeeRole(current, player) {
    if (current.status === "ended" || current.viewMode === "god") return true;
    const user = werewolfPlayer(current, WEREWOLF_USER_ID);
    return player.id === WEREWOLF_USER_ID || (user?.role === "wolf" && player.role === "wolf");
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
      const visible = viewerCanSeeRole(current, player);
      const chip = createElement("div", `werewolf-player-chip${player.alive ? "" : " is-dead"}${visible && player.role === "wolf" ? " is-wolf" : ""}`);
      chip.append(
        createElement("strong", "", player.name),
        createElement("span", "", player.alive
          ? (visible ? `${WEREWOLF_ROLE_META[player.role].icon} ${WEREWOLF_ROLE_META[player.role].label}` : "存活")
          : `${visible ? `${WEREWOLF_ROLE_META[player.role].label} · ` : ""}已离场`),
      );
      board.append(chip);
    }
  }

  function renderLog(current) {
    const log = byId("werewolf-log");
    if (!log) return;
    const entries = visibleWerewolfLog(current);
    const wasNearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    log.replaceChildren();
    for (const entry of entries) {
      const secret = entry.visibility !== "public";
      const item = createElement("article", `werewolf-log-entry${entry.authorId === "system" ? " is-system" : ""}${secret ? " is-secret" : ""}`);
      const header = document.createElement("header");
      const route = secret
        ? { wolves: "🐺 狼队密谈", seer: "🔮 验人结果", witch: "🧪 女巫视角", god: "👁 法官暗牌" }[entry.visibility]
        : WEREWOLF_PHASE_META[entry.phase];
      header.append(createElement("span", "", `${entry.author}${route ? ` · ${route}` : ""}`), createElement("time", "", formatTime(entry.timestamp)));
      item.append(header, createElement("p", "", entry.text));
      log.append(item);
    }
    if (wasNearBottom || !log.dataset.rendered) {
      requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    }
    log.dataset.rendered = "true";
  }

  function archiveResultLabel(archived) {
    if (archived.winner === "wolf") return "狼人胜利";
    if (archived.winner === "good") return "好人胜利";
    return "提前结束";
  }

  function renderArchives() {
    const list = byId("werewolf-archive-list");
    const archives = getRoom()?.werewolfArchives || [];
    list.replaceChildren();
    for (const archived of [...archives].reverse()) {
      const details = createElement("details", "werewolf-archive-card");
      const summary = document.createElement("summary");
      summary.append(
        createElement("strong", "", archived.archiveTitle || archiveResultLabel(archived)),
        createElement("span", "", new Date(archived.archivedAt || archived.updatedAt).toLocaleString("zh-CN")),
      );
      const recap = createElement("pre", "werewolf-archive-recap", archived.debrief?.recap || "本局没有生成事实复盘。");
      const transcript = createElement("div", "werewolf-archive-transcript");
      for (const entry of archived.log) {
        const row = createElement("article", `werewolf-log-entry${entry.authorId === "system" ? " is-system" : ""}${entry.visibility !== "public" ? " is-secret" : ""}`);
        const header = document.createElement("header");
        header.append(createElement("span", "", `${entry.author} · ${WEREWOLF_PHASE_META[entry.phase] || entry.phase}`), createElement("time", "", formatTime(entry.timestamp)));
        row.append(header, createElement("p", "", entry.text));
        transcript.append(row);
      }
      details.append(summary, recap, transcript);
      list.append(details);
    }
  }

  function speechPlayerIds(current, tiedOnly = current.phase === "tie_speech") {
    const day = currentDay(current);
    const ids = tiedOnly ? (current.pending?.tieIds || day.tiedIds || []) : day.speechOrder;
    return ids.filter((id) => werewolfPlayer(current, id)?.alive);
  }

  function playerHasSpoken(current, playerId, tiedOnly = current.phase === "tie_speech") {
    const day = currentDay(current);
    return Boolean(day.speeches[tiedOnly ? `${playerId}-tie` : playerId]);
  }

  function allSpeakersDone(current, tiedOnly = current.phase === "tie_speech") {
    return speechPlayerIds(current, tiedOnly).every((id) => playerHasSpoken(current, id, tiedOnly));
  }

  function renderRoundtable(current) {
    roundtable.replaceChildren();
    if (!current) return;
    if (current.status === "ended") {
      const heading = createElement("div", "werewolf-roundtable-heading");
      const copy = createElement("div");
      copy.append(createElement("strong", "", "赛后茶话会"), createElement("p", "", "身份和全部秘密已经解锁。点谁谁复盘，也可以让全员依次说；说过的人仍能继续追问。"));
      const runAll = createElement("button", "button button-quiet", "全体依次复盘");
      runAll.type = "button";
      runAll.disabled = running;
      runAll.addEventListener("click", () => void runDebriefRound());
      heading.append(copy, runAll);
      const speakers = createElement("div", "werewolf-speaker-grid");
      for (const player of current.players.filter((item) => item.type === "agent")) {
        const done = current.debrief?.roundDone?.includes(player.id);
        const button = createElement("button", `werewolf-speaker${done ? " is-done" : ""}${speakingPlayerId === player.id ? " is-speaking" : ""}`);
        button.type = "button";
        button.disabled = running;
        button.append(createElement("strong", "", player.name), createElement("span", "", speakingPlayerId === player.id ? "正在复盘……" : done ? "已复盘 · 可再点" : WEREWOLF_ROLE_META[player.role].label));
        button.addEventListener("click", () => void runDebriefSpeaker(player.id));
        speakers.append(button);
      }
      roundtable.append(heading, speakers);
      return;
    }
    if (!["day_speech", "tie_speech"].includes(current.phase)) {
      roundtable.append(createElement("p", "werewolf-roundtable-idle", "现在是夜间或投票阶段。打开“身份与行动”完成本阶段。"));
      return;
    }
    const tiedOnly = current.phase === "tie_speech";
    const ids = speechPlayerIds(current, tiedOnly);
    const heading = createElement("div", "werewolf-roundtable-heading");
    const copy = createElement("div");
    copy.append(
      createElement("strong", "", tiedOnly ? "平票辩护席" : `第 ${current.day} 天 · 自由点名发言`),
      createElement("p", "", "点一位只调用一位，回复会立刻落在上方。晨曦想压轴，就最后再用下面输入框发言。"),
    );
    const runAll = createElement("button", "button button-quiet", "依次叫未发言嘉宾");
    runAll.type = "button";
    runAll.disabled = running || allSpeakersDone(current, tiedOnly);
    runAll.addEventListener("click", () => void runSpeechRound(tiedOnly));
    heading.append(copy, runAll);
    const speakers = createElement("div", "werewolf-speaker-grid");
    for (const id of ids) {
      const player = werewolfPlayer(current, id);
      const done = playerHasSpoken(current, id, tiedOnly);
      const button = createElement("button", `werewolf-speaker${done ? " is-done" : ""}${speakingPlayerId === id ? " is-speaking" : ""}`);
      button.type = "button";
      button.disabled = running || done || player.type === "user";
      button.append(
        createElement("strong", "", player.name),
        createElement("span", "", speakingPlayerId === id ? "正在发言……" : done ? "已发言" : player.type === "user" ? "用下方输入框" : "点名发言"),
      );
      if (player.type === "agent") button.addEventListener("click", () => void runSpeechSpeaker(id, tiedOnly));
      speakers.append(button);
    }
    roundtable.append(heading, speakers);
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
    messageInput.disabled = !enabled;
    sendButton.disabled = !enabled || running;
    messageInput.placeholder = canDebrief
      ? "赛后想审谁、夸谁、骂谁，直接说……"
      : canLastWords
        ? "留下最后一句话；发出后再让法官继续……"
      : canTieSpeak
        ? "为自己辩一句，再看他们怎么投……"
        : canDaySpeak
          ? "盘逻辑、跳身份、抬杠；想压轴就最后再发……"
          : current
            ? "当前阶段不需要公开发言，请打开身份与行动……"
            : "先开一局狼人杀……";
    sendButton.textContent = canDebrief ? "加入复盘" : canLastWords ? "留下遗言" : "公开发言";
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
      roundtable.replaceChildren();
      syncWerewolfComposer(null);
      return;
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
    renderRoundtable(current);
    syncWerewolfComposer(current);
  }

  function open() {
    setGameStatus("");
    renderGame();
    if (!dialog.open) dialog.showModal();
  }

  function captureUserAction(current) {
    if (current.viewMode !== "player") return;
    const user = werewolfPlayer(current, WEREWOLF_USER_ID);
    if (!user?.alive && current.phase !== "last_words") return;
    if (current.phase === "night_wolves" && user.role === "wolf" && !current.pending.userWolfReady) {
      const target = byId("werewolf-user-target")?.value;
      if (!target) throw new Error("先替狼队选一个落刀目标");
      currentNight(current).wolfVotes[user.id] = target;
      const secret = byId("werewolf-user-secret")?.value.trim();
      if (secret) appendWerewolfLog(current, { visibility: "wolves", authorId: user.id, author: user.name, text: secret });
      current.pending.userWolfReady = true;
    } else if (current.phase === "night_seer" && user.role === "seer" && !current.pending.userSeerReady) {
      const target = byId("werewolf-user-check")?.value;
      if (!target) throw new Error("先选今晚要验的人");
      recordSeerCheck(current, target, user);
      current.pending.userSeerReady = true;
    } else if (current.phase === "night_witch" && user.role === "witch" && !current.pending.userWitchReady) {
      const night = currentNight(current);
      night.witchSave = Boolean(byId("werewolf-user-save")?.checked && current.witch.healAvailable && night.killTargetId);
      night.poisonTargetId = byId("werewolf-user-poison")?.value || null;
      current.pending.userWitchReady = true;
    } else if (current.phase === "day_speech") {
      const day = currentDay(current);
      if (current.costMode === "economy" && day.speeches[user.id] && !day.provisionalVotes[user.id]) {
        const vote = byId("werewolf-user-vote")?.value;
        if (!vote) throw new Error("省钱局还差曦曦这一票，请在身份与行动里选好");
        day.provisionalVotes[user.id] = vote;
      }
    } else if (current.phase === "day_vote" && !current.pending.userVoteReady) {
      const vote = byId("werewolf-user-vote")?.value;
      if (!vote) throw new Error("先投出曦曦这一票");
      currentDay(current).votes[user.id] = vote;
      current.pending.userVoteReady = true;
    } else if (current.phase === "tie_vote" && !current.pending.userTieVoteReady) {
      const vote = byId("werewolf-user-tie-vote")?.value;
      if (!vote) throw new Error("先投出平票重投这一票");
      currentDay(current).tieVotes[user.id] = vote;
      current.pending.userTieVoteReady = true;
    } else if (current.phase === "last_words" && current.pending?.eliminatedId === user.id && !current.pending.userLastWordsReady) {
      current.pending.userLastWords = byId("werewolf-user-last-words")?.value.trim() || "晨曦没有留下遗言。";
      current.pending.userLastWordsReady = true;
    }
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
    current.pending.wolfDone ||= [];
    for (const player of wolves) {
      if (player.type !== "agent" || current.pending.wolfDone.includes(player.id)) continue;
      const agent = agentFor(player.id);
      if (!agent) continue;
      const targets = validTargets(current, player.id, { includeSelf: true });
      const prior = current.log.filter((entry) => entry.day === current.day && entry.visibility === "wolves")
        .map((entry) => `${entry.author}：${entry.text}`).join("\n") || "狼队频道还没人说话。";
      const raw = await chatRequest(
        agent,
        current,
        player,
        "现在是狼人夜间密谈。你可以自刀或刀狼队友。简短说你的判断，并在最后单独写 [TARGET:玩家名字]。这段话不会公开。",
        `可刀目标：${targets.map((target) => target.name).join("、")}\n\n狼队已有密谈：\n${prior}`,
        signal,
        180,
      );
      const targetId = parseWerewolfTarget(raw, "TARGET", current.players, targets.map((target) => target.id)) || fallbackTarget(targets);
      night.wolfVotes[player.id] = targetId;
      appendWerewolfLog(current, {
        visibility: "wolves",
        authorId: player.id,
        author: player.name,
        text: stripWerewolfControls(raw) || `我倾向于刀 ${werewolfPlayer(current, targetId)?.name || "这位"}。`,
      });
      current.pending.wolfDone.push(player.id);
      persistGame();
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
        `可查验：${targets.map((target) => target.name).join("、")}`,
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
        `今晚被刀：${werewolfPlayer(current, night.killTargetId)?.name || "无人"}\n解药：${current.witch.healAvailable ? "可用" : "已用"}\n毒药：${current.witch.poisonAvailable ? "可用" : "已用"}\n可毒目标：${poisonTargets.map((player) => player.name).join("、")}`,
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
    persistGame();
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
      persistGame();
    } catch (error) {
      if (error.name === "AbortError") setGameStatus("停在这里了；前面已经说完的发言都还在。", true);
      else {
        recordWerewolfIncident(current, `${werewolfPlayer(current, playerId)?.name || playerId} 发言请求失败：${error.message}`);
        setGameStatus(`${error.message}。只需重试这一位，其他人的发言不会丢。`, true);
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
      persistGame();
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

  async function runDebriefSpeaker(playerId) {
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
      const reply = await debriefChatRequest(agent, current, player, abortController.signal);
      appendWerewolfLog(current, { authorId: player.id, author: player.name, text: reply || "我暂时没什么要补。", phase: "debrief" });
      current.debrief.roundDone ||= [];
      if (!current.debrief.roundDone.includes(player.id)) current.debrief.roundDone.push(player.id);
      setGameStatus(`${player.name}复盘完了。可以继续追问同一个人。`);
      persistGame();
    } catch (error) {
      if (error.name === "AbortError") setGameStatus("复盘暂停了，前面的内容都还在。", true);
      else {
        recordWerewolfIncident(current, `${player.name} 赛后复盘请求失败：${error.message}`);
        setGameStatus(`${error.message}。只重试这一位即可。`, true);
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
        if (current.debrief?.roundDone?.includes(playerId)) continue;
        const player = werewolfPlayer(current, playerId);
        const agent = agentFor(playerId);
        if (!player || !agent) continue;
        speakingPlayerId = playerId;
        setGameStatus(`${player.name}正在看完整卷宗……`);
        renderGame();
        const reply = await debriefChatRequest(agent, current, player, abortController.signal);
        appendWerewolfLog(current, { authorId: player.id, author: player.name, text: reply || "我暂时没什么要补。", phase: "debrief" });
        current.debrief.roundDone ||= [];
        if (!current.debrief.roundDone.includes(player.id)) current.debrief.roundDone.push(player.id);
        speakingPlayerId = "";
        persistGame();
        renderGame();
      }
      setGameStatus("第一轮复盘说完了。现在可以自由点名继续审。" );
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
      persistGame();
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
      persistGame();
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
      captureUserAction(current);
    } catch (error) {
      setGameStatus(error.message, true);
      return;
    }
    running = true;
    abortController = new AbortController();
    setGameStatus("法官正在收这一阶段的行动……");
    renderGame();
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
      persistGame();
    } catch (error) {
      if (error.name === "AbortError") setGameStatus("停在这里了，已经完成的发言会保留。");
      else {
        recordWerewolfIncident(current, `${WEREWOLF_PHASE_META[current.phase] || current.phase}：${error.message}`);
        setGameStatus(error.message, true);
      }
    } finally {
      running = false;
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
    persistGame();
    renderGame();
    toast(viewMode === "god" ? "上帝视角已开，今晚谁刀谁都瞒不过你" : "身份发好了——先别露牌 😼");
  }

  function submitUserMessage(rawText) {
    const current = game();
    const body = String(rawText || "").trim();
    if (!current || !body || running) return false;
    if (current.status === "ended") {
      appendWerewolfLog(current, { authorId: WEREWOLF_USER_ID, author: "晨曦", text: body, phase: "debrief" });
      persistGame();
      renderGame();
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
    persistGame();
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
      room.werewolfArchives.push(archiveWerewolfGame(current, room.werewolfArchives.length + 1));
    }
    room.werewolf = null;
    persist();
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
    persistGame();
    renderGame();
  }

  byId("werewolf-button").addEventListener("click", open);
  byId("werewolf-open-controls").addEventListener("click", open);
  byId("close-werewolf-dialog").addEventListener("click", () => dialog.close());
  byId("start-werewolf-game").addEventListener("click", start);
  byId("werewolf-advance").addEventListener("click", () => void advance());
  byId("werewolf-stop").addEventListener("click", () => abortController?.abort());
  byId("werewolf-new-game").addEventListener("click", () => clearGame(true));
  archiveButton.addEventListener("click", () => archiveCurrentGame(false));
  byId("werewolf-end-game").addEventListener("click", endGame);
  document.querySelectorAll('input[name="werewolf-view"]').forEach((input) => input.addEventListener("change", setupSelectionLimits));
  manualDealInput.addEventListener("change", () => {
    renderRoleAssignment();
    updateSetupStatus();
  });

  return { open, render: renderGame, submitUserMessage };
}

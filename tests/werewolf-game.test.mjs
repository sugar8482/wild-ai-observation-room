import assert from "node:assert/strict";
import test from "node:test";
import {
  WEREWOLF_USER_ID,
  appendWerewolfLog,
  archiveWerewolfGame,
  beginWerewolfDebrief,
  buildWerewolfRecap,
  checkWerewolfWinner,
  createWerewolfGame,
  finishWerewolfGame,
  parseWerewolfTarget,
  parseWitchAction,
  resolveWerewolfNight,
  sanitizeWerewolfGame,
  sanitizeWerewolfArchives,
  visibleWerewolfLog,
  voteOutcome,
} from "../public/werewolf-game.js";

function participants(count = 6, includeUser = false) {
  const agents = Array.from({ length: count }, (_, index) => ({
    id: `guest-${index + 1}`,
    name: `嘉宾${index + 1}`,
    type: "agent",
  }));
  return includeUser
    ? [{ id: WEREWOLF_USER_ID, name: "晨曦", type: "user" }, ...agents]
    : agents;
}

test("六人和七人经典局都会发出两狼、预言家、女巫与正确数量的村民", () => {
  for (const players of [participants(6), participants(6, true)]) {
    const game = createWerewolfGame({ participants: players, random: () => 0.42 });
    const counts = game.players.reduce((result, player) => ({
      ...result,
      [player.role]: (result[player.role] || 0) + 1,
    }), {});
    assert.equal(counts.wolf, 2);
    assert.equal(counts.seer, 1);
    assert.equal(counts.witch, 1);
    assert.equal(counts.villager, players.length - 4);
  }
});

test("上帝席可以亲手指定每位 AI 的身份，非法牌组会安全退回随机发牌", () => {
  const players = participants(6);
  const roleAssignments = {
    "guest-1": "wolf",
    "guest-2": "wolf",
    "guest-3": "seer",
    "guest-4": "witch",
    "guest-5": "villager",
    "guest-6": "villager",
  };
  const manual = createWerewolfGame({ participants: players, viewMode: "god", roleAssignments, random: () => 0.8 });
  assert.equal(manual.dealMode, "manual");
  assert.deepEqual(Object.fromEntries(manual.players.map((player) => [player.id, player.role])), roleAssignments);

  const invalid = createWerewolfGame({
    participants: players,
    viewMode: "god",
    roleAssignments: Object.fromEntries(players.map((player) => [player.id, "wolf"])),
    random: () => 0.8,
  });
  assert.equal(invalid.dealMode, "random");
  assert.equal(invalid.players.filter((player) => player.role === "wolf").length, 2);
});

test("玩家模式隔离秘密频道，散场后自动解锁完整卷宗", () => {
  const game = createWerewolfGame({ participants: participants(6, true), viewMode: "player", random: () => 0.3 });
  const user = game.players.find((player) => player.id === WEREWOLF_USER_ID);
  user.role = "villager";
  appendWerewolfLog(game, { visibility: "public", author: "法官", text: "公开消息" });
  appendWerewolfLog(game, { visibility: "wolves", author: "狼人", text: "今晚刀晨曦" });
  appendWerewolfLog(game, { visibility: "seer", author: "法官", text: "验人是狼" });
  const playing = visibleWerewolfLog(game).map((entry) => entry.text);
  assert.ok(playing.includes("公开消息"));
  assert.ok(!playing.includes("今晚刀晨曦"));
  assert.ok(!playing.includes("验人是狼"));

  finishWerewolfGame(game, "good");
  const ended = visibleWerewolfLog(game).map((entry) => entry.text);
  assert.ok(ended.includes("今晚刀晨曦"));
  assert.ok(ended.includes("验人是狼"));
});

test("夜间结算支持解药、毒药去重，并能正确判断阵营胜负", () => {
  const game = createWerewolfGame({ participants: participants(6), random: () => 0.6 });
  const living = [...game.players];
  const saved = living[0];
  const poisoned = living[1];
  const deaths = resolveWerewolfNight(game, {
    killTargetId: saved.id,
    save: true,
    poisonTargetId: poisoned.id,
  });
  assert.deepEqual(deaths, [poisoned.id]);
  assert.equal(saved.alive, true);
  assert.equal(poisoned.alive, false);

  for (const player of game.players) {
    if (player.role === "wolf") player.alive = false;
  }
  assert.equal(checkWerewolfWinner(game), "good");
});

test("结构化目标与女巫行动兼容名字，平票不会误放逐", () => {
  const game = createWerewolfGame({ participants: participants(6), random: () => 0.2 });
  const [first, second] = game.players;
  assert.equal(parseWerewolfTarget(`[VOTE:${first.name}]`, "VOTE", game.players, [first.id]), first.id);
  assert.deepEqual(
    parseWitchAction(`[WITCH:save=yes,poison=${second.name}]`, game.players, [second.id]),
    { save: true, poisonTargetId: second.id },
  );
  const outcome = voteOutcome({ a: first.id, b: second.id }, [first.id, second.id]);
  assert.equal(outcome.eliminatedId, null);
  assert.deepEqual(new Set(outcome.tiedIds), new Set([first.id, second.id]));
});

test("狼人杀状态会限长清洗，但不会混进普通消息或长期总结", () => {
  const game = createWerewolfGame({ participants: participants(6), random: () => 0.1 });
  game.log.push(...Array.from({ length: 510 }, (_, index) => ({
    id: `log-${index}`,
    day: 1,
    phase: "day_speech",
    visibility: "wolves",
    authorId: "guest-1",
    author: "狼",
    text: `密谈${index}`,
    timestamp: index,
  })));
  const saved = sanitizeWerewolfGame(game);
  assert.equal(saved.log.length, 500);
  assert.equal(saved.log.at(-1).text, "密谈509");
  assert.equal(Object.hasOwn(saved, "messages"), false);
  assert.equal(Object.hasOwn(saved, "memory"), false);
});

test("散场会生成完整事实复盘，封存后保留茶话会但不会串进下一局", () => {
  const game = createWerewolfGame({ participants: participants(6), random: () => 0.1 });
  const [wolf, , seer, witch] = game.players;
  wolf.role = "wolf";
  seer.role = "seer";
  witch.role = "witch";
  game.nights.push({
    day: 1,
    killTargetId: seer.id,
    seerTargetId: wolf.id,
    seerResult: "wolf",
    witchSave: true,
    poisonTargetId: null,
    deaths: [],
  });
  game.days.push({ day: 1, voteCounts: { [wolf.id]: 3 }, eliminatedId: wolf.id });
  game.winner = "good";
  beginWerewolfDebrief(game);
  appendWerewolfLog(game, { authorId: "guest-2", author: "嘉宾2", text: "赛后我认。", phase: "debrief" });

  const recap = buildWerewolfRecap(game);
  assert.match(recap, /【身份表】/);
  assert.match(recap, new RegExp(`狼刀 ${seer.name}`));
  assert.match(recap, /解药已用/);
  assert.equal(game.phase, "debrief");
  assert.ok(game.log.some((entry) => entry.authorId === "recap"));

  const archived = archiveWerewolfGame(game, 1);
  const archives = sanitizeWerewolfArchives([archived]);
  assert.equal(archives.length, 1);
  assert.match(archives[0].archiveTitle, /第 1 局/);
  assert.ok(archives[0].log.some((entry) => entry.text === "赛后我认。"));
});

test("历史卷宗不会因为局数多而被静默截断", () => {
  const archives = Array.from({ length: 35 }, (_, index) => ({
    ...createWerewolfGame({ participants: participants(6), random: () => 0.1 }),
    id: `game-${index + 1}`,
    status: "ended",
    phase: "debrief",
    winner: index % 2 ? "wolf" : "good",
  }));

  const sanitized = sanitizeWerewolfArchives(archives);
  assert.equal(sanitized.length, 35);
  assert.equal(sanitized[0].id, "game-1");
  assert.equal(sanitized.at(-1).id, "game-35");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  gameSystemPrompt,
  parseWerewolfDebriefReply,
  roleKnowledge,
  validTargets,
  viewerRoleKnowledge,
} from "../public/werewolf-controller.js";
import { WEREWOLF_USER_ID, createWerewolfGame } from "../public/werewolf-game.js";

function manualGame() {
  const participants = Array.from({ length: 6 }, (_, index) => ({
    id: `guest-${index + 1}`,
    name: `玩家${index + 1}`,
    type: "agent",
  }));
  return createWerewolfGame({
    participants,
    viewMode: "god",
    roleAssignments: {
      "guest-1": "wolf",
      "guest-2": "wolf",
      "guest-3": "seer",
      "guest-4": "witch",
      "guest-5": "villager",
      "guest-6": "villager",
    },
  });
}

test("狼人夜间目标允许自己与狼队友，普通投票仍不能投自己", () => {
  const game = manualGame();
  const wolf = game.players.find((player) => player.id === "guest-1");
  const teammate = game.players.find((player) => player.id === "guest-2");

  const knifeTargets = validTargets(game, wolf.id, { includeSelf: true });
  assert.ok(knifeTargets.some((player) => player.id === wolf.id));
  assert.ok(knifeTargets.some((player) => player.id === teammate.id));

  const voteTargets = validTargets(game, wolf.id);
  assert.ok(!voteTargets.some((player) => player.id === wolf.id));
  assert.ok(voteTargets.some((player) => player.id === teammate.id));
});

test("狼人、预言家和女巫会在后续请求中拿回各自合法的夜间记录", () => {
  const game = manualGame();
  const [wolf, , seer, witch, poisoned] = game.players;
  game.day = 1;
  game.phase = "day_speech";
  game.nights = [{
    day: 1,
    wolfVotes: { [wolf.id]: wolf.id },
    killTargetId: witch.id,
    seerTargetId: wolf.id,
    seerResult: "wolf",
    witchSave: true,
    poisonTargetId: poisoned.id,
    deaths: [poisoned.id],
  }];
  game.seerChecks = [{ day: 1, seerId: seer.id, targetId: wolf.id, result: "wolf" }];
  game.witch = { healAvailable: false, poisonAvailable: false };
  game.log.push(
    {
      day: 1,
      phase: "night_wolves",
      visibility: "wolves",
      authorId: wolf.id,
      author: wolf.name,
      text: "我先刀玩家5。",
    },
    {
      day: 1,
      phase: "night_wolves",
      visibility: "wolves",
      authorId: "guest-2",
      author: "玩家2",
      text: "我更想刀玩家4。",
    },
    {
      day: 1,
      phase: "day_speech",
      visibility: "public",
      authorId: "guest-6",
      author: "玩家6",
      text: "这句公屏不属于狼队密谈。",
    },
  );

  const wolfInfo = roleKnowledge(game, wolf);
  assert.match(wolfInfo, /允许自刀或刀狼队友/);
  assert.match(wolfInfo, /第1夜狼队最终刀口=玩家4，你的选择=玩家1/);
  assert.match(wolfInfo, /你记得此前的狼队密谈/);
  assert.match(wolfInfo, /第1夜 玩家1：我先刀玩家5/);
  assert.match(wolfInfo, /第1夜 玩家2：我更想刀玩家4/);
  assert.doesNotMatch(wolfInfo, /这句公屏不属于狼队密谈/);

  const seerInfo = roleKnowledge(game, seer);
  assert.match(seerInfo, /第1夜 玩家1=狼人/);
  assert.doesNotMatch(seerInfo, /狼队密谈/);

  const witchInfo = roleKnowledge(game, witch);
  assert.match(witchInfo, /解药已经用掉，毒药已经用掉/);
  assert.match(witchInfo, /第1夜刀口=玩家4，使用解药救了玩家4，使用毒药毒了玩家5/);
});

test("尚未结算的当夜行动不会提前写进神职记忆", () => {
  const game = manualGame();
  const witch = game.players.find((player) => player.role === "witch");
  game.phase = "night_witch";
  game.nights = [{
    day: 1,
    wolfVotes: {},
    killTargetId: witch.id,
    witchSave: false,
    poisonTargetId: null,
    deaths: [],
    resolved: false,
  }];

  assert.match(roleKnowledge(game, witch), /还没有已结算的夜间行动/);
});

test("身份徽章只按晨曦当前真正知道的身份揭示", () => {
  const game = createWerewolfGame({
    participants: [
      { id: WEREWOLF_USER_ID, name: "晨曦", type: "user" },
      ...Array.from({ length: 5 }, (_, index) => ({ id: `agent-${index + 1}`, name: `嘉宾${index + 1}`, type: "agent" })),
    ],
    viewMode: "player",
    roleAssignments: {
      [WEREWOLF_USER_ID]: "seer",
      "agent-1": "wolf",
      "agent-2": "wolf",
      "agent-3": "witch",
      "agent-4": "villager",
      "agent-5": "villager",
    },
  });
  const user = game.players.find((player) => player.id === WEREWOLF_USER_ID);
  const wolf = game.players.find((player) => player.id === "agent-1");
  const witch = game.players.find((player) => player.id === "agent-3");

  assert.deepEqual(viewerRoleKnowledge(game, user), { kind: "role", role: "seer" });
  assert.deepEqual(viewerRoleKnowledge(game, wolf), { kind: "hidden" });

  game.seerChecks.push(
    { day: 1, seerId: WEREWOLF_USER_ID, targetId: wolf.id, result: "wolf" },
    { day: 2, seerId: WEREWOLF_USER_ID, targetId: witch.id, result: "good" },
  );
  assert.deepEqual(viewerRoleKnowledge(game, wolf), { kind: "role", role: "wolf" });
  assert.deepEqual(viewerRoleKnowledge(game, witch), { kind: "team", team: "good" });

  game.viewMode = "god";
  assert.deepEqual(viewerRoleKnowledge(game, witch), { kind: "role", role: "witch" });
  game.viewMode = "player";
  game.status = "ended";
  assert.deepEqual(viewerRoleKnowledge(game, witch), { kind: "role", role: "witch" });
});

test("晨曦拿狼人时只看见自己和狼队友的身份", () => {
  const game = createWerewolfGame({
    participants: [
      { id: WEREWOLF_USER_ID, name: "晨曦", type: "user" },
      ...Array.from({ length: 5 }, (_, index) => ({ id: `wolf-view-${index + 1}`, name: `嘉宾${index + 1}`, type: "agent" })),
    ],
    viewMode: "player",
    roleAssignments: {
      [WEREWOLF_USER_ID]: "wolf",
      "wolf-view-1": "wolf",
      "wolf-view-2": "seer",
      "wolf-view-3": "witch",
      "wolf-view-4": "villager",
      "wolf-view-5": "villager",
    },
  });

  assert.deepEqual(viewerRoleKnowledge(game, game.players.find((player) => player.id === "wolf-view-1")), { kind: "role", role: "wolf" });
  assert.deepEqual(viewerRoleKnowledge(game, game.players.find((player) => player.id === "wolf-view-2")), { kind: "hidden" });
});

test("新局隔离旧局卷宗，但允许嘉宾带着自己挑选的长期私人记忆入场", () => {
  const game = manualGame();
  const player = game.players[0];
  const prompt = gameSystemPrompt({
    id: player.id,
    name: player.name,
    persona: "保持冷静。",
    memoryEnabled: true,
    memory: "- [群聊] 我答应晨曦，不会故意让她失望。",
  }, game, player, "现在进行白天发言。");

  assert.match(prompt, /我答应晨曦，不会故意让她失望/);
  assert.match(prompt, /看不到任何旧局原文、旧复盘或旧局私人日记/);
  assert.match(prompt, /不要把旧局身份当成本局身份/);
  assert.match(prompt, /<self_memory>/);
  assert.match(prompt, /现在进行白天发言/);
});

test("赛后本局日记与可跨房间长期记忆使用两个独立出口", () => {
  const parsed = parseWerewolfDebriefReply([
    "公开复盘：这局我最后一天才看穿。",
    "<game_diary>",
    "- 我记住这局说对不等于让人信。",
    "</game_diary>",
    "<self_memory>",
    "- 我发现晨曦生气时更希望有人陪她把话说完。",
    "</self_memory>",
  ].join("\n"));

  assert.equal(parsed.text, "公开复盘：这局我最后一天才看穿。");
  assert.equal(parsed.diaryItems.length, 1);
  assert.match(parsed.diaryItems[0], /说对不等于让人信/);
  assert.equal(parsed.memoryItems.length, 1);
  assert.match(parsed.memoryItems[0], /晨曦生气时更希望有人陪她/);
});

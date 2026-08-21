import assert from "node:assert/strict";
import test from "node:test";
import { roleKnowledge, validTargets } from "../public/werewolf-controller.js";
import { createWerewolfGame } from "../public/werewolf-game.js";

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

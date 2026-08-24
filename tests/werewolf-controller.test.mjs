import assert from "node:assert/strict";
import test from "node:test";
import {
  gameSystemPrompt,
  parseWerewolfDebriefReply,
  requestWerewolfDebrief,
  roleKnowledge,
  stripPseudoDebriefArchive,
  validTargets,
  viewerRoleKnowledge,
} from "../public/werewolf-controller.js";
import {
  WEREWOLF_USER_ID,
  appendWerewolfLog,
  createWerewolfGame,
  finishWerewolfGame,
} from "../public/werewolf-game.js";

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

test("赛后公开正文、私聊、本局日记与长期记忆可以在同次回复中独立解析", () => {
  const parsed = parseWerewolfDebriefReply([
    "我只回应最后一天那次站边：当时我把语气笃定误当成了逻辑完整。",
    '<private_message to="user">晨曦，我其实更介意你没让我把那句话说完。</private_message>',
    "<game_diary>",
    "- 我把笃定误判成了可信。",
    "- 我仍介意自己的解释没有说完。",
    "</game_diary>",
    "<self_memory>",
    "- 我希望以后和晨曦争执时先把彼此的话听完整。",
    "</self_memory>",
  ].join("\n"), { agentId: "guest-1", recipients: manualGame().players });

  assert.match(parsed.text, /我只回应最后一天/);
  assert.equal(parsed.privateMessages.length, 1);
  assert.deepEqual(parsed.privateMessages[0].recipientIds, [WEREWOLF_USER_ID]);
  assert.equal(parsed.diaryItems.length, 2);
  assert.equal(parsed.memoryItems.length, 1);
  assert.doesNotMatch(parsed.text, /game_diary|self_memory|private_message/);
});

test("Kimi 式公开伪档案不会冒充已保存的本局日记", () => {
  const raw = [
    "这局我最该认的是，我把连续发言的自信错当成了证据；下次我会先查矛盾，而不是先站队。",
    "私人记忆档案",
    "正文区",
    "我已经把整局身份和时间线整理成档案。",
    "存疑区",
    "来源：公屏和夜间记录。",
    "作废条件",
    "下一局重新判断。",
  ].join("\n");
  const parsed = parseWerewolfDebriefReply(raw);
  assert.equal(parsed.text, raw.split("\n")[0]);
  assert.deepEqual(parsed.diaryItems, []);
  assert.deepEqual(parsed.memoryItems, []);
  assert.equal(stripPseudoDebriefArchive(raw), raw.split("\n")[0]);
});

test("复盘漏机器标签时最多补交一次，并且补交内容不进入公屏", async (context) => {
  const game = manualGame();
  finishWerewolfGame(game, "good");
  appendWerewolfLog(game, {
    authorId: WEREWOLF_USER_ID,
    author: "晨曦",
    text: "请你记住这次我让你把话说完了。",
    phase: "debrief",
  });
  const player = game.players[0];
  const agent = {
    id: player.id,
    name: player.name,
    persona: "",
    memoryEnabled: true,
    memory: "",
    memoryRevision: 0,
  };
  const requests = [];
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      async json() {
        if (requests.length === 1) {
          return { text: "我只认一个判断失误：我把你的犹豫当成了心虚，后来才发现你是在给别人留发言空间。" };
        }
        return { text: [
          "<game_diary>",
          "- 我误读了晨曦的犹豫。",
          "- 我后来意识到她是在给别人留空间。",
          "</game_diary>",
          "<self_memory>",
          "- 我记得晨曦愿意让我把话说完。",
          "</self_memory>",
        ].join("\n") };
      },
    };
  };

  const reply = await requestWerewolfDebrief(agent, game, player, undefined, {
    agents: game.players,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].maxTokens, 1_060);
  assert.equal(requests[1].maxTokens, 540);
  assert.match(requests[1].messages[0].content, /只补机器标签/);
  assert.equal(reply.diaryItems.length, 2);
  assert.equal(reply.memoryItems.length, 1);
  assert.doesNotMatch(reply.text, /game_diary|self_memory|格式补交/);
  assert.match(agent.memory, /晨曦愿意让我把话说完/);
});

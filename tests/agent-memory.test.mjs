import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAgentMemory,
  compactAgentMemory,
  numberedAgentMemory,
  parseAgentReply,
  privateMemoryContext,
  privateMemoryOutputInstruction,
  validateDeepAgentMemoryResult,
} from "../public/agent-memory.js";

test("关闭角色记忆时不向模型透露这项功能", () => {
  const agent = { name: "谢知衡", memoryEnabled: false, memory: "我在意晨曦。" };
  assert.equal(privateMemoryContext(agent), "");
  assert.equal(privateMemoryOutputInstruction(agent), "");
});

test("开启后只把私人记忆交给角色本人并要求第一人称短记", () => {
  const agent = { name: "谢知衡", memoryEnabled: true, memory: "- 我没有说出那件事。" };
  assert.match(privateMemoryContext(agent), /只属于“谢知衡”的角色私人记忆/);
  assert.match(privateMemoryContext(agent), /其他嘉宾看不到/);
  assert.match(privateMemoryOutputInstruction(agent), /第一人称/);
  assert.match(privateMemoryOutputInstruction(agent), /不要抄写房间公开时间线/);
});

test("空白私人记忆在用户要求初始化时允许从既有对话实际写入", () => {
  const instruction = privateMemoryOutputInstruction({
    name: "DeepSeek",
    memoryEnabled: true,
    memory: "",
  });
  assert.match(instruction, /首次初始化私人记忆/);
  assert.match(instruction, /必须实际写入至少 1 条/);
  assert.match(instruction, /首次初始化是例外，可写 1～3 条/);
  assert.match(instruction, /不能只口头表示完成/);
  assert.match(instruction, /不能只写在思考、推理或草稿中/);
});

test("已有私人记忆时不会反复要求执行首次初始化", () => {
  const instruction = privateMemoryOutputInstruction({
    name: "DeepSeek",
    memoryEnabled: true,
    memory: "- 我已经记下一件事。",
  });
  assert.doesNotMatch(instruction, /你当前的私人记忆还是空的/);
  assert.match(instruction, /不能只口头表示完成/);
  assert.match(instruction, /日常回复允许写 0～2 条/);
  assert.match(instruction, /不得因为懒得整理、正文写上头或嫌格式麻烦/);
  assert.match(instruction, /不要为了证明自己有在记录而凑数/);
});

test("回复末尾的私人便笺会被剥离且最多保存三条", () => {
  const parsed = parseAgentReply(`先回答你：没有。\n<self_memory>\n- 我其实有点在意她追问。\n* 我怀疑江枫采也看出来了。\n3. 我暂时不想说明。\n- 第四条不应保存。\n</self_memory>`);
  assert.equal(parsed.visibleText, "先回答你：没有。");
  assert.deepEqual(parsed.memoryItems, [
    "我其实有点在意她追问。",
    "我怀疑江枫采也看出来了。",
    "我暂时不想说明。",
  ]);
});

test("截断的私人便笺不会漏进群聊，也不会误存", () => {
  const parsed = parseAgentReply("这是公开回复。\n<self_memory>\n- 我还没写完");
  assert.equal(parsed.visibleText, "这是公开回复。");
  assert.deepEqual(parsed.memoryItems, []);
});

test("模型误加代码围栏时也不会把私人便笺显示出来", () => {
  const parsed = parseAgentReply("公开回复。\n```xml\n<self_memory>\n- 我把这件事记下了。\n</self_memory>\n```");
  assert.equal(parsed.visibleText, "公开回复。");
  assert.deepEqual(parsed.memoryItems, ["我把这件事记下了。"]);
});

test("角色记忆按房间和日期追加并跳过完全重复内容", () => {
  const existing = "- [竹马群 · 8/7] 我其实有点在意她追问。";
  const next = appendAgentMemory(existing, [
    "我其实有点在意她追问。",
    "我决定先不把截图的事说透。",
  ], {
    roomName: "竹马群",
    at: new Date(2026, 7, 7, 12, 0).getTime(),
  });
  assert.equal(next.match(/我其实有点在意她追问。/g)?.length, 1);
  assert.match(next, /\[竹马群 · 8\/7\] 我决定先不把截图的事说透。/);
});

test("基础清理会修掉重复日期标签但保留措辞不同的独立心思", () => {
  const compacted = compactAgentMemory([
    "- [竹马群 · 8/8] [竹马群 · 8/8] 晨曦换衣服太慢，我怀疑她还在楼上磨蹭。",
    "- [竹马群 · 8/8] 晨曦这么久没下来，我决定再在楼下等一会儿。",
    "- [竹马群 · 8/8] 晨曦还是没下来，我准备让老谢上楼看看。",
  ].join("\n"));
  assert.doesNotMatch(compacted, /\[竹马群 · 8\/8\]\s*\[竹马群 · 8\/8\]/);
  assert.equal(compacted.split("\n").length, 3);
});

test("可选语义合并会合并同一个未公开秘密，但保留不同秘密", () => {
  const compacted = compactAgentMemory([
    "- [竹马群 · 8/7] 其实那晚我并没有截图，只是随口一诈，这件事不能让他们知道。",
    "- [竹马群 · 8/8] 截图这张牌还可以继续留着，我暂时不说破。",
    "- [竹马群 · 8/8] 口红那次是他陪她去退的，这件事我还没告诉别人。",
  ].join("\n"), { mergeTopics: true });
  assert.equal(compacted.match(/截图/g)?.length, 1);
  assert.match(compacted, /口红/);
});

test("本地整理优先保留手写内容、关系变化和未公开秘密并遵守长度上限", () => {
  const source = [
    "这行是我手动写的，请保留。",
    "- [房间 · 8/1] 我决定暂时不公开这段关系，这是只属于我的秘密。",
    ...Array.from({ length: 30 }, (_, index) => `- [房间 · 8/${(index % 9) + 1}] 第${index}次普通等待没有产生新变化，只是继续消磨时间。`),
  ].join("\n");
  const compacted = compactAgentMemory(source, { maxLength: 600 });
  assert.ok(compacted.length <= 600);
  assert.match(compacted, /手动写的/);
  assert.match(compacted, /不公开这段关系/);
});

test("深度整理后的保守清理只删完全重复，不再次按相似主题吞掉独立旧事", () => {
  const source = [
    "- [竹马群 · 8/7] 我等她下楼等得有点不耐烦。",
    "- [竹马群 · 8/8] 我在球场输给老谢，答应请一周可乐。",
    "- [竹马群 · 8/8] 我在球场输给老谢，答应请一周可乐。",
  ].join("\n");
  const result = compactAgentMemory(source, { mergeTopics: false });
  assert.match(result, /等她下楼/);
  assert.match(result, /请一周可乐/);
  assert.equal(result.split("\n").length, 2);
});

test("深度整理必须逐项登记来源且每条最多合并两条旧记忆", () => {
  const original = [
    "- [竹马群 · 8/7] 我第一次怀疑截图并不存在。",
    "- [竹马群 · 8/7] 我后来确认截图只是他诈我的。",
    "- [竹马群 · 8/8] 我输掉球赛，答应请一周可乐。",
    "- [竹马群 · 8/8] 她点了青柠可乐，我记住了。",
  ].join("\n");
  assert.match(numberedAgentMemory(original), /\[M001\]/);
  const accepted = validateDeepAgentMemoryResult(original, [
    "- [竹马群 · 8/7] 我先怀疑、后来确认截图只是他诈我的。 <!-- sources:M001,M002 -->",
    "- [竹马群 · 8/8] 我输掉球赛，答应请一周可乐。 <!-- sources:M003 -->",
    "- [竹马群 · 8/8] 她点了青柠可乐，我记住了。 <!-- sources:M004 -->",
  ].join("\n"));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.count, 3);
  assert.doesNotMatch(accepted.text, /sources:/);

  const missing = validateDeepAgentMemoryResult(original, [
    "- [竹马群 · 8/7] 我只留下了截图。 <!-- sources:M001,M002 -->",
    "- [竹马群 · 8/8] 我只留下了球赛。 <!-- sources:M003 -->",
  ].join("\n"));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /漏掉了 1 条/);

  const overMerged = validateDeepAgentMemoryResult(original, [
    "- [竹马群 · 8/7] 我把三件事揉成了一件。 <!-- sources:M001,M002,M003 -->",
    "- [竹马群 · 8/8] 她点了青柠可乐，我记住了。 <!-- sources:M004 -->",
  ].join("\n"));
  assert.equal(overMerged.ok, false);
  assert.match(overMerged.error, /超过保守上限/);
});

test("自动新增不会在九千字附近静默淘汰独立旧记忆", () => {
  const existing = Array.from({ length: 260 }, (_, index) => (
    `- [长篇群 · 8/8] 第${index}件彼此独立的旧事需要完整保留，细节编号${String(index).padStart(3, "0")}。`
  )).join("\n");
  assert.ok(existing.length > 9_000);
  const result = appendAgentMemory(existing, ["我今天又记住了一件全新的事。"], {
    roomName: "长篇群",
    at: new Date(2026, 7, 9, 12, 0).getTime(),
  });
  assert.match(result, /第0件彼此独立的旧事/);
  assert.match(result, /第259件彼此独立的旧事/);
  assert.match(result, /我今天又记住了一件全新的事/);
});

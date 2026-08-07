import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAgentMemory,
  parseAgentReply,
  privateMemoryContext,
  privateMemoryOutputInstruction,
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

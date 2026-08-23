import assert from "node:assert/strict";
import test from "node:test";
import { boldTextParts } from "../public/rich-text.js";

test("双星号只转换为加粗片段并保留其他纯文本", () => {
  assert.deepEqual(boldTextParts("先说**重点**，再说普通话。"), [
    { strong: false, text: "先说" },
    { strong: true, text: "重点" },
    { strong: false, text: "，再说普通话。" },
  ]);
});

test("多段加粗、换行和单星号不会被吞掉", () => {
  assert.deepEqual(boldTextParts("**第一段**\n*不是加粗*\n**第二段**"), [
    { strong: true, text: "第一段" },
    { strong: false, text: "\n*不是加粗*\n" },
    { strong: true, text: "第二段" },
  ]);
});

test("没有闭合的双星号和 HTML 字样仍保持纯文本", () => {
  assert.deepEqual(boldTextParts("**没关上 <img src=x>"), [
    { strong: false, text: "**没关上 <img src=x>" },
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  ROOM_EVENT_CARDS,
  drawRoomEventCard,
  recordRoomEventCard,
  roomEventCardPrompt,
} from "../lib/room-event-cards.mjs";

test("生活事件卡会避开最近四张且不会擅自编造用户状态", () => {
  const recentIds = ROOM_EVENT_CARDS.slice(0, 4).map((card) => card.id);
  const card = drawRoomEventCard({ enabled: true, recentIds }, () => 0);
  assert.equal(recentIds.includes(card.id), false);
  assert.match(roomEventCardPrompt(card), /不是已经发生的事实/);
  assert.match(roomEventCardPrompt(card), /不得替用户决定行程、位置、健康、迟到、失踪/);
});

test("使用过的事件卡会进入近期记录并保持固定窗口", () => {
  let state = { enabled: true, recentIds: [], lastEvent: "", revision: 0 };
  for (const card of ROOM_EVENT_CARDS.slice(0, 6)) state = recordRoomEventCard(state, card);
  assert.deepEqual(state.recentIds, ROOM_EVENT_CARDS.slice(2, 6).map((card) => card.id));
  assert.equal(state.lastEvent, ROOM_EVENT_CARDS[5].text);
  assert.equal(state.revision, 6);
});

test("未开启时不会抽取生活事件", () => {
  assert.equal(drawRoomEventCard({ enabled: false }, () => 0), null);
});

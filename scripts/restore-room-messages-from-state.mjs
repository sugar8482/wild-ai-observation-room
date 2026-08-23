import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function argumentValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || "";
}

function messageTimestamp(message) {
  const value = Number(message?.timestamp);
  return Number.isFinite(value) ? value : 0;
}

function mergeRoomMessages(targetState, sourceState, selectedRoomId = "") {
  const sourceRooms = new Map(
    (Array.isArray(sourceState?.rooms) ? sourceState.rooms : [])
      .filter((room) => room?.id)
      .map((room) => [room.id, room]),
  );
  const report = [];

  for (const targetRoom of Array.isArray(targetState?.rooms) ? targetState.rooms : []) {
    if (selectedRoomId && targetRoom.id !== selectedRoomId) continue;
    const sourceRoom = sourceRooms.get(targetRoom.id);
    if (!sourceRoom) continue;

    const targetMessages = Array.isArray(targetRoom.messages) ? targetRoom.messages : [];
    const sourceMessages = Array.isArray(sourceRoom.messages) ? sourceRoom.messages : [];
    const mergedById = new Map(
      targetMessages
        .filter((message) => message?.id)
        .map((message) => [message.id, message]),
    );
    let added = 0;
    for (const message of sourceMessages) {
      if (!message?.id || mergedById.has(message.id)) continue;
      mergedById.set(message.id, message);
      added += 1;
    }

    targetRoom.messages = [...mergedById.values()].sort((left, right) => {
      const timestampDifference = messageTimestamp(left) - messageTimestamp(right);
      return timestampDifference || String(left?.id || "").localeCompare(String(right?.id || ""));
    });
    report.push({
      roomId: targetRoom.id,
      room: targetRoom.name,
      before: targetMessages.length,
      source: sourceMessages.length,
      added,
      after: targetRoom.messages.length,
      firstTimestamp: targetRoom.messages[0]?.timestamp || null,
      lastTimestamp: targetRoom.messages.at(-1)?.timestamp || null,
    });
  }

  return report;
}

const sourceArgument = argumentValue("source");
const targetArgument = argumentValue("target");
const roomId = argumentValue("room");
const apply = process.argv.includes("--apply");

if (!sourceArgument) {
  throw new Error("请使用 --source=<旧 state.json 路径> 指定消息来源");
}

const sourcePath = resolve(sourceArgument);
const targetPath = resolve(targetArgument || "data/state.json");
const [sourceText, targetText] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(targetPath, "utf8"),
]);
const sourceState = JSON.parse(sourceText);
const targetState = JSON.parse(targetText);
const report = mergeRoomMessages(targetState, sourceState, roomId);

if (apply) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${targetPath}.before-state-restore-${stamp}.bak`;
  const temporaryPath = `${targetPath}.restore.tmp`;
  await copyFile(targetPath, backupPath);
  await writeFile(temporaryPath, `${JSON.stringify(targetState, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath);
}

console.log(JSON.stringify({
  mode: apply ? "applied" : "dry-run",
  sourcePath,
  targetPath,
  rooms: report,
}, null, 2));

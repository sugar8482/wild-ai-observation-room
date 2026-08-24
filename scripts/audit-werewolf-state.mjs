import { readFile } from "node:fs/promises";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("用法：node scripts/audit-werewolf-state.mjs <state.json> [...]");
  process.exitCode = 2;
} else {
  const games = new Map();
  const reports = [];
  for (const file of files) {
    try {
      const state = JSON.parse(await readFile(file, "utf8"));
      const roomReports = [];
      for (const room of Array.isArray(state.rooms) ? state.rooms : []) {
        if (room?.roomType !== "werewolf") continue;
        const legacyDiaryByAgent = (Array.isArray(state.agents) ? state.agents : [])
          .map((agent) => ({
            agentId: String(agent?.id || ""),
            count: String(agent?.memory || "")
              .split(/\r?\n/)
              .filter((line) => line.includes(`[${String(room.name || "")} · 赛后复盘 · `)).length,
          }))
          .filter((entry) => entry.count > 0);
        const entries = [
          ...(Array.isArray(room.werewolfArchives) ? room.werewolfArchives.map((game) => ({ game, archived: true })) : []),
          ...(room.werewolf ? [{ game: room.werewolf, archived: false }] : []),
        ];
        const roomGames = [];
        for (const { game, archived } of entries) {
          const log = Array.isArray(game?.log) ? game.log : [];
          const eventIds = log.map((entry) => String(entry?.id || "")).filter(Boolean);
          const report = {
            id: String(game?.id || ""),
            archived,
            status: String(game?.status || ""),
            phase: String(game?.phase || ""),
            logCount: log.length,
            atLegacyCap: log.length === 500,
            hasOpeningEvent: log.some((entry) => String(entry?.text || "").includes("身份牌已经发好")),
            privateDiaryCount: Array.isArray(game?.privateDiaries) ? game.privateDiaries.length : 0,
            nightCount: Array.isArray(game?.nights) ? game.nights.length : 0,
            dayCount: Array.isArray(game?.days) ? game.days.length : 0,
            firstEventAt: Number(log[0]?.timestamp) || null,
            lastEventAt: Number(log.at(-1)?.timestamp) || null,
          };
          roomGames.push(report);
          if (!report.id) continue;
          const combined = games.get(report.id) || {
            id: report.id,
            roomIds: new Set(),
            sources: [],
            eventIds: new Set(),
            maximumSingleFileEvents: 0,
            hasOpeningEvent: false,
          };
          combined.roomIds.add(String(room.id || ""));
          combined.sources.push({ file, ...report });
          eventIds.forEach((id) => combined.eventIds.add(id));
          combined.maximumSingleFileEvents = Math.max(combined.maximumSingleFileEvents, log.length);
          combined.hasOpeningEvent ||= report.hasOpeningEvent;
          games.set(report.id, combined);
        }
        roomReports.push({
          roomId: String(room.id || ""),
          legacyDiaryCount: legacyDiaryByAgent.reduce((total, entry) => total + entry.count, 0),
          legacyDiaryByAgent,
          games: roomGames,
        });
      }
      reports.push({ file, rooms: roomReports });
    } catch (error) {
      reports.push({ file, error: error.message });
    }
  }

  const combinedGames = [...games.values()].map((game) => ({
    id: game.id,
    roomIds: [...game.roomIds],
    sourceCount: game.sources.length,
    maximumSingleFileEvents: game.maximumSingleFileEvents,
    recoverableUniqueEvents: game.eventIds.size,
    recoverableFromMultipleFiles: game.eventIds.size > game.maximumSingleFileEvents,
    hasOpeningEvent: game.hasOpeningEvent,
    legacyCapObserved: game.sources.some((source) => source.atLegacyCap),
  }));
  console.log(JSON.stringify({ files: reports, combinedGames }, null, 2));
}

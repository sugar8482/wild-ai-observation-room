import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(process.argv[3] || fileURLToPath(new URL("..", import.meta.url)));
const backupBase = resolve(process.argv[2] || "/root/backups/wild-ai-observation-room");
const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const label = String(process.argv[4] || "manual")
  .trim()
  .replace(/[^a-zA-Z0-9_-]+/g, "-")
  .replace(/^-+|-+$/g, "") || "manual";
const backupRoot = join(backupBase, `${stamp}-${label}`);
const stateRoot = resolve(projectRoot, "data");

async function localSettings() {
  const content = await readFile(resolve(projectRoot, ".env.local"), "utf8");
  return Object.fromEntries(content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      const rawValue = line.slice(separator + 1).trim();
      const quoted = rawValue.match(/^(["'])(.*)\1$/);
      return [line.slice(0, separator).trim(), quoted ? quoted[2] : rawValue];
    }));
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function runPgDump(connectionString, destination) {
  const databaseUrl = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("OBSERVATION_DATABASE_URL 不是 PostgreSQL URL");
  }
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));
  if (!databaseUrl.hostname || !databaseUrl.username || !databaseName) {
    throw new Error("OBSERVATION_DATABASE_URL 缺少 host、user 或 database");
  }
  const args = [
    "--format=custom",
    "--file", destination,
    "--host", databaseUrl.hostname,
    "--port", databaseUrl.port || "5432",
    "--username", decodeURIComponent(databaseUrl.username),
    "--dbname", databaseName,
  ];
  return new Promise((accept, reject) => {
    const child = spawn("pg_dump", args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        PGPASSWORD: decodeURIComponent(databaseUrl.password),
        PGSSLMODE: databaseUrl.searchParams.get("sslmode")
          || (String(process.env.OBSERVATION_DATABASE_SSL || "").toLowerCase() === "true" ? "require" : "prefer"),
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(`pg_dump 失败（code=${code ?? "null"}, signal=${signal || "none"}）`));
    });
  });
}

await access(backupRoot).then(
  () => { throw new Error(`备份目录已经存在，拒绝覆盖：${backupRoot}`); },
  () => {},
);
await mkdir(backupRoot, { recursive: true, mode: 0o700 });

const stateFiles = (await readdir(stateRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /^state(?:\.|$)/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
if (!stateFiles.includes("state.json")) throw new Error("没有找到 data/state.json，停止备份");

for (const name of stateFiles) {
  await copyFile(join(stateRoot, name), join(backupRoot, name));
}

const settings = await localSettings();
const connectionString = process.env.OBSERVATION_DATABASE_URL || settings.OBSERVATION_DATABASE_URL || "";
if (!connectionString) throw new Error("OBSERVATION_DATABASE_URL 未配置，数据库尚未转储");
const databaseDump = join(backupRoot, "observation-room-postgres.dump");
await runPgDump(connectionString, databaseDump);

const files = [];
for (const name of [...stateFiles, basename(databaseDump)]) {
  const path = join(backupRoot, name);
  files.push({ name, bytes: (await stat(path)).size, sha256: await sha256(path) });
}
console.log(JSON.stringify({ ok: true, backupRoot, files }, null, 2));

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = resolve(root, "public");
const distDir = resolve(root, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(publicDir, distDir, { recursive: true });

for (const requiredFile of ["index.html", "app.js", "styles.css"]) {
  const content = await readFile(resolve(distDir, requiredFile), "utf8");
  if (!content.trim()) throw new Error(`${requiredFile} 是空文件`);
}

await writeFile(
  resolve(distDir, "build-info.json"),
  JSON.stringify({ builtAt: new Date().toISOString(), target: "local-first" }, null, 2),
);
console.log("构建完成：dist/");

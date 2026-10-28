import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Mem0 把可选 provider 留在动态 import 中。单文件只内置 OpenAI 兼容协议和 SQLite,
// 不要求安装所有云数据库 SDK;Node 发行版仍按 Mem0 原生依赖规则运行。
const sdk = JSON.parse(readFileSync(new URL("../node_modules/mem0ai/package.json", import.meta.url), "utf8"));
const peers = Object.keys(sdk.peerDependencies).filter((name) => name !== "better-sqlite3");
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const result = await Bun.build({
  entrypoints: [option("--entry") ?? "./src/index.ts"],
  compile: { outfile: option("--outfile") ?? "dao", ...(option("--target") ? { target: option("--target") as any } : {}) },
  target: "bun",
  external: peers,
  plugins: [{
    name: "mem0-bun-sqlite",
    setup(build) {
      build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: fileURLToPath(new URL("./mem0-sqlite-bun.ts", import.meta.url)) }));
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`已构建 ${path.resolve(option("--outfile") ?? "dao")}`);

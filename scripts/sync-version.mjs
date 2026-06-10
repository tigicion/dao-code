// 从 package.json 同步版本号到 src/version.ts(bun 单文件编译无法运行时读 package.json,只能编译期固化)。
// 由 bundle 脚本自动调用;内容未变则不写(避免无谓的 mtime 变化)。
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const file = new URL("../src/version.ts", import.meta.url);
const content = `// DAO CODE 版本。由 scripts/sync-version.mjs 从 package.json 生成,勿手改。\nexport const VERSION = "${version}";\n`;

let current = "";
try { current = readFileSync(file, "utf8"); } catch {}
if (current !== content) {
  writeFileSync(file, content);
  console.log(`version.ts ← v${version}(已同步)`);
}

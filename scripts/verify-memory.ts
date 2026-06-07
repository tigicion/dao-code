// 记忆 P3 验收(确定性,无需 API key、不花钱):衰减 GC 的保护/剪枝 + 注入上限。
// 跑:npm run verify:mem   全部通过退出 0,任一失败退出 1。
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serializeMemory } from "../src/memory/frontmatter.js";
import { newMemory, type Memory } from "../src/memory/types.js";
import { gcMemories } from "../src/memory/gc.js";
import { selectForInjection } from "../src/memory/inject.js";
import type { Verdict } from "../src/memory/validate.js";

const today = "2026-06-07";
const ago = (d: number) => new Date(Date.parse(today) - d * 86_400_000).toISOString().slice(0, 10);
const mem = (o: Partial<Memory> & { name: string }): Memory => ({
  ...newMemory({ name: o.name, text: o.name, type: o.type ?? "semantic", today }),
  ...o,
});

let failures = 0;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
};

// ---- 1. 衰减 GC:60 天前的各类记忆,只有"低重要度+非 user+未被再确认"该被剪 ----
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-mem-"));
const cases: Memory[] = [
  mem({ name: "old-low",    importance: 3, lastUsed: ago(60) }),                          // 应剪
  mem({ name: "old-user",   importance: 3, lastUsed: ago(60), type: "user" }),            // 保护:user 模型
  mem({ name: "old-high",   importance: 8, lastUsed: ago(60) }),                          // 保护:importance≥6
  mem({ name: "old-locked", importance: 3, lastUsed: ago(60), locked: true }),            // 保护:locked
  mem({ name: "old-reconf", importance: 3, lastUsed: ago(60), uses: 3 }),                 // 保护:高 uses(S=180)
  mem({ name: "recent",     importance: 3, lastUsed: ago(5) }),                           // 新近,保留
  // 已取代且过宽限期 → 应剪
  { ...mem({ name: "stale-superseded", importance: 9, lastUsed: ago(2) }), status: "superseded", supersededBy: "x", validUntil: ago(30) },
];
for (const m of cases) await fs.writeFile(path.join(dir, m.name + ".md"), serializeMemory(m));

const pruned = (await gcMemories(dir, today)).sort();
check("GC 只剪掉 ['old-low','stale-superseded']", JSON.stringify(pruned) === JSON.stringify(["old-low", "stale-superseded"]));
const left = (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
check("保护项全留(user/高重要度/locked/高uses/新近)", JSON.stringify(left) === JSON.stringify(["old-high", "old-locked", "old-reconf", "old-user", "recent"]));
await fs.rm(dir, { recursive: true, force: true });

// ---- 2. 注入上限:1 个 user + 200 个 semantic,封顶 150 且 user 必留、按重要度优先 ----
const many = [mem({ name: "the-user", type: "user", importance: 1, lastUsed: ago(1) })];
for (let i = 0; i < 200; i++) many.push(mem({ name: "f" + i, importance: (i % 10) + 1, lastUsed: ago(i) }));
const sel = selectForInjection(many.map((m) => ({ mem: m, verdict: "ok" as Verdict })), today);
check("注入条数 ≤ 150", sel.length <= 150);
check("user 模型一定被注入", sel.some((s) => s.mem.name === "the-user"));
check("最高重要度(10)被保留", sel.some((s) => s.mem.importance === 10));

// ---- 3. 小库直通:少于上限时全量注入,不丢 ----
const few = many.slice(0, 20).map((m) => ({ mem: m, verdict: "ok" as Verdict }));
check("小库(20条)全量注入不丢", selectForInjection(few, today).length === 20);

console.log(failures === 0 ? "\n记忆 P3 验收全部通过 ✅" : `\n有 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);

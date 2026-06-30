#!/usr/bin/env tsx
// 记忆效果评测跑批:tsx evals/memory/run.ts [extract|recall] [--local]
// 前提:dao 已配 profile(/login 或 ~/.dao/config.json)。真实模型、非 CI。
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamChat } from "../../src/client/client.js";
import { loadEvalConfig } from "./lib/creds.js";
import { runExtractCase } from "./extract.js";
import { runRecallCase } from "./recall.js";
import { formatExtractReport, formatRecallReport } from "./report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function listCases(kind: "extract" | "recall"): Promise<string[]> {
  const base = path.join(__dirname, "fixtures", kind);
  const names = await fs.readdir(base).catch(() => []);
  const dirs: string[] = [];
  for (const n of names) { const p = path.join(base, n); if ((await fs.stat(p)).isDirectory()) dirs.push(p); }
  return dirs;
}

async function main() {
  const args = process.argv.slice(2);
  const which = args.find((a) => a === "extract" || a === "recall");
  const cfg = await loadEvalConfig();
  const sc = streamChat as any;
  let report = "";
  if (!which || which === "extract") {
    const rows = [];
    for (const dir of await listCases("extract")) rows.push({ case: path.basename(dir), score: await runExtractCase(dir, sc, cfg) });
    report += formatExtractReport(rows) + "\n";
  }
  if (!which || which === "recall") {
    const rows = [];
    for (const dir of await listCases("recall")) rows.push({ case: path.basename(dir), score: await runRecallCase(dir, sc, cfg) });
    report += formatRecallReport(rows) + "\n";
  }
  await fs.writeFile(path.join(__dirname, "report.md"), report, "utf8");
  console.log(report);
}
main().catch((e) => { console.error(e); process.exit(1); });

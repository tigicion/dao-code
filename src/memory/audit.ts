import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Memory } from "./types.js";
import { parseMemoryFile } from "./frontmatter.js";
import { retention, daysBetween } from "./gc.js";
import { isCatalogNoise } from "./distill.js";

// 单条记忆的健康评估(纯函数,无 IO)。优先级:取代 > 目录倾倒噪音 > 低价值推断 > 陈旧 > 健康。
export type AuditFlag = "superseded" | "noise" | "lowvalue" | "stale" | "ok";
const FLAG_LABEL: Record<AuditFlag, string> = {
  superseded: "🔵 已取代",
  noise: "🔴 噪音污染",
  lowvalue: "🔴 低价值",
  stale: "🟡 陈旧(久未命中)",
  ok: "🟢 健康",
};

export function assessMemory(mem: Memory, today: string): { flag: AuditFlag; reason: string } {
  if (mem.status === "superseded") return { flag: "superseded", reason: `已被 ${mem.supersededBy ?? "新记忆"} 取代` };
  if (isCatalogNoise(mem.text)) return { flag: "noise", reason: "像产品/技能/工具目录清单,不是关于用户的事实" };
  if (mem.type === "user" && (mem.confidence ?? 1) < 0.5 && (mem.uses ?? 0) === 0 && mem.importance < 6)
    return { flag: "lowvalue", reason: `低置信(${mem.confidence})、从未被召回、低重要度的推断` };
  if (retention(mem, today) < 0.3)
    return { flag: "stale", reason: `${daysBetween(mem.lastUsed, today)} 天未被命中,留存已衰减` };
  return { flag: "ok", reason: "" };
}

export interface AuditRow {
  tier: string;
  mem: Memory;
  flag: AuditFlag;
  reason: string;
}

// 渲染审核报告:问题项在前(按 flag 分组),每条带层级/类型/重要度/置信/命中/年龄,末尾给删除提示。
export function formatAudit(rows: AuditRow[], today: string): string {
  if (rows.length === 0) return "记忆为空。";
  const order: AuditFlag[] = ["noise", "lowvalue", "superseded", "stale", "ok"];
  const counts = order.map((f) => [f, rows.filter((r) => r.flag === f).length] as const).filter(([, n]) => n > 0);
  const summary = counts.map(([f, n]) => `${FLAG_LABEL[f]} ${n}`).join(" · ");
  const lines: string[] = [`记忆审核(共 ${rows.length} 条):${summary}`, ""];
  const byFlag = new Map<AuditFlag, AuditRow[]>();
  for (const r of rows) (byFlag.get(r.flag) ?? byFlag.set(r.flag, []).get(r.flag)!).push(r);
  for (const f of order) {
    const group = byFlag.get(f);
    if (!group?.length) continue;
    lines.push(`${FLAG_LABEL[f]}`);
    for (const r of group) {
      const m = r.mem;
      const age = daysBetween(m.created, today);
      const meta = `[${r.tier}·${m.type}·重${m.importance}${m.confidence != null ? `·信${m.confidence}` : ""}·命中${m.uses ?? 0}·${age}天]`;
      const snip = m.text.length > 64 ? m.text.slice(0, 64) + "…" : m.text;
      lines.push(`  · ${m.name}  ${meta}`);
      lines.push(`      ${snip}${r.reason ? `  ← ${r.reason}` : ""}`);
    }
    lines.push("");
  }
  const flagged = rows.filter((r) => r.flag === "noise" || r.flag === "lowvalue").map((r) => r.mem.name);
  if (flagged.length) lines.push(`建议清理 ${flagged.length} 条(🔴)。删除:/memory delete <名>(多个空格分隔)。`);
  else lines.push("未发现明显噪音。删除某条:/memory delete <名>。");
  return lines.join("\n");
}

// 读三层目录、解析、评估,产出审核行。tiers: [层名, 目录]。同步(供 slash 命令直接用)。
export function gatherAudit(tiers: [string, string][], today: string): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const [tier, dir] of tiers) {
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md"); } catch { continue; }
    for (const f of files) {
      let raw = "";
      try { raw = readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
      const mem = parseMemoryFile(f.slice(0, -3), raw);
      if (!mem) continue;
      const { flag, reason } = assessMemory(mem, today);
      rows.push({ tier, mem, flag, reason });
    }
  }
  return rows;
}

import type { Memory, MemoryType } from "./types.js";

const STR = new Set(["name", "text", "type", "created", "lastUsed", "source", "sourceHash", "status", "supersededBy", "validUntil"]);
const NUM = new Set(["importance", "confidence", "uses"]);
const BOOL = new Set(["locked"]);

// 解析一个记忆 md 文件;name 由文件名传入(frontmatter 的 name 优先)。失败返回 null。
export function parseMemoryFile(name: string, raw: string): Memory | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1] ?? "";
  const body = m[2] ?? "";
  const obj: Record<string, unknown> = {};
  for (const line of fm.split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (NUM.has(k)) obj[k] = Number(v);
    else if (BOOL.has(k)) obj[k] = v === "true";
    else if (STR.has(k)) obj[k] = v;
  }
  if (!obj.type || !obj.status) return null;
  return {
    name: (obj.name as string) || name,
    text: body.trim(),
    type: obj.type as MemoryType,
    importance: typeof obj.importance === "number" && !Number.isNaN(obj.importance) ? obj.importance : 5,
    ...(typeof obj.confidence === "number" && !Number.isNaN(obj.confidence) ? { confidence: obj.confidence } : {}),
    created: (obj.created as string) || "",
    lastUsed: (obj.lastUsed as string) || "",
    ...(obj.source ? { source: obj.source as string } : {}),
    ...(obj.sourceHash ? { sourceHash: obj.sourceHash as string } : {}),
    uses: typeof obj.uses === "number" && !Number.isNaN(obj.uses) ? obj.uses : 0,
    status: obj.status as Memory["status"],
    ...(obj.supersededBy ? { supersededBy: obj.supersededBy as string } : {}),
    ...(obj.validUntil ? { validUntil: obj.validUntil as string } : {}),
    locked: obj.locked === true,
  };
}

export function serializeMemory(m: Memory): string {
  const lines = [`name: ${m.name}`, `type: ${m.type}`, `importance: ${m.importance}`, `uses: ${m.uses ?? 0}`];
  if (m.confidence !== undefined) lines.push(`confidence: ${m.confidence}`);
  lines.push(`created: ${m.created}`, `lastUsed: ${m.lastUsed}`);
  if (m.source) lines.push(`source: ${m.source}`);
  if (m.sourceHash) lines.push(`sourceHash: ${m.sourceHash}`);
  lines.push(`status: ${m.status}`);
  if (m.supersededBy) lines.push(`supersededBy: ${m.supersededBy}`);
  if (m.validUntil) lines.push(`validUntil: ${m.validUntil}`);
  lines.push(`locked: ${m.locked === true}`);
  return `---\n${lines.join("\n")}\n---\n${m.text.trim()}\n`;
}

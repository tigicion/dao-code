import { promises as fs } from "node:fs";
import path from "node:path";

// 自定义子代理类型:用 markdown(frontmatter + 正文)定义一个专用 agent——
// 名字/描述/工具白名单/模型 + 专属 system prompt。模型用 agent 工具的 agent_type 指定。
// 来源:项目 .codeds/agents/*.md 与用户 ~/.codeds/agents/*.md(同名项目覆盖用户)。

export interface AgentDef {
  name: string;
  description: string;
  tools?: string[]; // 工具名白名单;省略=继承全部工具
  model?: string;
  prompt: string; // 专属 system prompt 正文
}

function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { fm, body: (m[2] ?? "").trim() };
}

export function parseAgentDef(filename: string, raw: string): AgentDef | null {
  const { fm, body } = parseFrontmatter(raw);
  const name = (fm.name || filename).trim();
  if (!name || !body) return null;
  const toolsRaw = fm.tools ?? fm["allowed-tools"] ?? fm.allowedtools;
  return {
    name,
    description: fm.description ?? "",
    tools: toolsRaw ? toolsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    model: fm.model || undefined,
    prompt: body,
  };
}

export async function loadAgentDefsFrom(dir: string): Promise<AgentDef[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: AgentDef[] = [];
  for (const f of names) {
    if (!f.endsWith(".md")) continue;
    const raw = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
    const def = parseAgentDef(f.slice(0, -3), raw);
    if (def) out.push(def);
  }
  return out;
}

// 项目优先覆盖用户同名定义。
export async function loadAgentDefs(projectDir: string, userDir: string): Promise<AgentDef[]> {
  const [user, project] = await Promise.all([loadAgentDefsFrom(userDir), loadAgentDefsFrom(projectDir)]);
  const byName = new Map<string, AgentDef>();
  for (const d of user) byName.set(d.name, d);
  for (const d of project) byName.set(d.name, d); // 项目覆盖
  return [...byName.values()];
}

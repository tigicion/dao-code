import { promises as fs } from "node:fs";
import path from "node:path";

// 开箱即用 Skill(对标 CC):markdown(frontmatter name/description + 正文指令)。
// 渐进式披露:启动只把 name+description 列进上下文,模型用 skill 工具按需加载正文。
// 来源:.codeds/skills/<name>.md 或 .codeds/skills/<name>/SKILL.md(+ 用户 ~/.codeds/skills/)。

export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string; // 该 skill 所在目录(供正文引用同目录资源)
}

function parse(fallbackName: string, dir: string, raw: string): Skill | null {
  let body = raw;
  let name = fallbackName;
  let description = "";
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    for (const line of m[1]!.split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k === "name") name = v || name;
      else if (k === "description") description = v;
    }
    body = (m[2] ?? "").trim();
  } else {
    body = raw.trim();
  }
  if (!body) return null;
  return { name, description, body, dir };
}

async function loadFrom(baseDir: string): Promise<Skill[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      // <name>/SKILL.md
      const file = path.join(baseDir, e.name, "SKILL.md");
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      if (raw) {
        const s = parse(e.name, path.join(baseDir, e.name), raw);
        if (s) out.push(s);
      }
    } else if (e.name.endsWith(".md")) {
      const raw = await fs.readFile(path.join(baseDir, e.name), "utf8").catch(() => "");
      const s = parse(e.name.slice(0, -3), baseDir, raw);
      if (s) out.push(s);
    }
  }
  return out;
}

export async function loadSkills(projectDir: string, userDir: string): Promise<Skill[]> {
  const [user, project] = await Promise.all([loadFrom(userDir), loadFrom(projectDir)]);
  const byName = new Map<string, Skill>();
  for (const s of user) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s); // 项目覆盖
  return [...byName.values()];
}

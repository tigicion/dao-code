import { promises as fs } from "node:fs";
import path from "node:path";

// 开箱即用 Skill(对标 CC):markdown(frontmatter name/description + 正文指令)。
// 渐进式披露:启动只把 name+description 列进上下文,模型用 skill 工具按需加载正文。
// 来源:.dao/skills/<name>.md 或 .dao/skills/<name>/SKILL.md(+ 用户 ~/.dao/skills/)。

export interface Skill {
  name: string;
  description: string;
  whenToUse?: string; // frontmatter when_to_use:触发条件(决定何时该加载此技能),对触发至关重要
  slug?: string; // 目录/文件名(供模型用直觉短名调用,不必照抄 Title Case 的 name)
  paths?: string[]; // frontmatter paths:条件技能——仅当项目有匹配文件才"在场"(对齐 CC 的 paths;空=一直在场)
  namespace?: string; // 来源命名空间(插件名);用于 plugin:slug 调用与防撞。本地/项目/内置无前缀
  // 触发旋钮(对齐 CC,默认都开;省略=undefined=按默认开处理,第三方一般不写)。
  modelInvokable?: boolean; // false ← frontmatter disable-model-invocation:true(模型不自动触发,只 /手动调)
  userInvocable?: boolean;  // false ← frontmatter user-invocable:false(不暴露 /手动调,只模型自动)
  body: string;
  dir: string; // 该 skill 所在目录(供正文引用同目录资源)
  file?: string; // 该 skill 的 SKILL.md 物理路径(realpath 去重用)
}

// 去掉值两端的引号(YAML 标量常带 " 或 ')。

function parse(fallbackName: string, dir: string, raw: string): Skill | null {
  let body = raw;
  let name = fallbackName;
  let description = "";
  let whenToUse = "";
  let paths: string[] = [];
  let modelInvokable: boolean | undefined;
  let userInvocable: boolean | undefined;
  const truthy = (v: string) => /^(true|yes|1|on)$/i.test(v.replace(/^["']|["']$/g, "").trim());
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    const lines = m[1]!.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      const i = line.indexOf(":");
      if (i <= 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k === "name") name = v || name;
      else if (k === "description") description = v;
      else if (k === "when_to_use" || k === "when to use" || k === "whentouse") whenToUse = v;
      // paths:条件技能 glob。支持 "a, b" / "[a, b]" / 单个;空格或逗号分隔。
      else if (k === "paths") paths = v.replace(/^\[|\]$/g, "").split(/[,\s]+/).map((x) => x.replace(/^["']|["']$/g, "").trim()).filter(Boolean);
      // 触发旋钮(对齐 CC):只在显式写出时记录,否则留 undefined(按默认"都开"处理)。
      else if (k === "disable-model-invocation" || k === "disable_model_invocation") { if (truthy(v)) modelInvokable = false; }
      else if (k === "user-invocable" || k === "user_invocable") { if (!truthy(v)) userInvocable = false; }
    }
    body = (m[2] ?? "").trim();
  } else {
    body = raw.trim();
  }
  if (!body) return null;
  return {
    name,
    description,
    ...(whenToUse ? { whenToUse } : {}),
    ...(paths.length ? { paths } : {}),
    ...(modelInvokable === false ? { modelInvokable } : {}),
    ...(userInvocable === false ? { userInvocable } : {}),
    slug: fallbackName,
    body,
    dir,
  };
}

// 用户手动调用匹配:按裸 slug / name / namespace:slug 找一个【可被用户 /调用】的技能(对齐 CC 的 /skill-name)。
export function findUserInvocableSkill(skills: Skill[], name: string): Skill | undefined {
  const want = name.trim().toLowerCase();
  return skills.find((s) => s.userInvocable !== false && (
    (s.slug ?? "").toLowerCase() === want ||
    s.name.toLowerCase() === want ||
    `${s.namespace ? s.namespace + ":" : ""}${s.slug ?? ""}`.toLowerCase() === want));
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
        if (s) out.push({ ...s, file });
      }
    } else if (e.name.endsWith(".md")) {
      const mdFile = path.join(baseDir, e.name);
      const raw = await fs.readFile(mdFile, "utf8").catch(() => "");
      const s = parse(e.name.slice(0, -3), baseDir, raw);
      if (s) out.push({ ...s, file: mdFile });
    }
  }
  return out;
}

// 把技能列表格式化成 catalog 行(- name(调用名):描述 何时用):启动常驻 skillsSection 与"新装后追加"共用同一框法。
// 只列可被模型自动触发的(modelInvokable !== false);每条 220 字预算防多技能撑大常驻 prompt。
export function skillCatalogLines(
  skills: Pick<Skill, "name" | "description" | "whenToUse" | "slug" | "namespace" | "modelInvokable">[],
): string {
  return skills
    .filter((s) => s.modelInvokable !== false)
    .map((s) => {
      const trig = s.whenToUse ? ` 何时用:${s.whenToUse}` : "";
      const callName = `${s.namespace ? s.namespace + ":" : ""}${s.slug ?? s.name}`;
      const call = callName.toLowerCase() !== s.name.toLowerCase() ? `(调用名 ${callName})` : "";
      return `- ${s.name}${call}:${`${s.description}${trig}`.slice(0, 220)}`;
    })
    .join("\n");
}

// 从若干目录加载技能;同名时【后传入的目录覆盖先传入的】(按优先级低→高传)。
// realpath 去重(对齐 CC):同一物理文件经多路径/符号链接被加载多次时,只保留最高优先级那次。
export async function loadSkills(...dirs: string[]): Promise<Skill[]> {
  const loaded = await Promise.all(dirs.map(loadFrom));
  const byRealpath = new Map<string, Skill>(); // 物理文件去重(低→高,后者覆盖)
  for (const list of loaded) {
    for (const s of list) {
      let key = s.file ?? `${s.dir}/${s.slug}`;
      if (s.file) { try { key = await fs.realpath(s.file); } catch { /* 文件没了用原路径 */ } }
      byRealpath.set(key, s);
    }
  }
  const byName = new Map<string, Skill>();
  for (const s of byRealpath.values()) byName.set(s.name, s);
  return [...byName.values()];
}

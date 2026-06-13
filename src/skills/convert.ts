import { promises as fs } from "node:fs";
import path from "node:path";
import { isForeignSkill } from "./adapt.js";
import { contentHash } from "../memory/hash.js";

// 外来技能正文 → DAO 适配。检测为他者所写时,用 flash 一次性按【用途】重写工具名(无翻译字典),
// 目标词表是 dao 自己的工具注册表;按源 hash 缓存到磁盘(一个技能版本只转一次);
// flash 不可用时退回"原文 + 通用提示"(仍无字典)。

export type FlashCall = (system: string, user: string) => Promise<string>;

export interface AdapterDeps {
  daoTools: Set<string>; // dao 工具名集合(检测"非 dao 工具形 token"用)
  catalog: string; // 目标词表:"read_file — 读文件\nexec_shell — 跑命令\n…"
  callFlash: FlashCall;
  homeDir: string; // 缓存根(~/.dao/skill-adapted/)
}

export function convertSystemPrompt(catalog: string): string {
  return [
    "你在把一段【为其它编码 agent(Claude Code / Codex / Gemini CLI / Cursor 等)所写的 skill 正文】适配到 DAO CODE。",
    "DAO CODE 只有这些工具(工具名 — 用途):",
    catalog,
    "",
    "要求:",
    "1. 正文里出现的【外来工具名】按用途替换成上面对应的 DAO 工具名(读文件→read_file、跑命令→exec_shell、改文件→edit_file、搜代码→grep_files…);没有对应的就用最贴近用途的,或改写成自然语言描述该动作。",
    "2. 跨引用(如 superpowers:xxx)改成 DAO 里按裸技能名加载(`xxx`)。",
    "3. 【只改工具名/平台相关表述】,其余指令、结构、语气、示例一字不动,保持原意。",
    "4. 直接输出适配后的 skill 正文,不要任何前后说明、不要用代码围栏包裹。若正文本就只用 DAO 工具、无需改动,原样返回。",
  ].join("\n");
}

const GENERIC_NOTE =
  "## 本平台适配(此技能为其它 agent 所写)\n" +
  "正文若出现非本平台的工具名(如 Read/Bash/Edit/apply_patch 等),按【用途】映射到你自己的 DAO 工具" +
  "(读文件/跑命令/改文件/搜代码…);跨引用 `superpowers:xxx` 按裸名 `xxx` 加载。\n\n";

// 返回一个 adapter:外来技能→转换(缓存优先);dao 原生技能→原样。
export function makeSkillAdapter(deps: AdapterDeps): (body: string) => Promise<string> {
  const cacheDir = path.join(deps.homeDir, ".dao", "skill-adapted");
  return async (body: string) => {
    if (!isForeignSkill(body, deps.daoTools)) return body; // dao 原生:不动
    const cacheFile = path.join(cacheDir, `${contentHash(body)}.md`);
    const cached = await fs.readFile(cacheFile, "utf8").catch(() => "");
    if (cached) return cached; // 同版本已转过:免费命中
    try {
      const out = (await deps.callFlash(convertSystemPrompt(deps.catalog), body)).trim();
      if (out) {
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(cacheFile, out, "utf8").catch(() => {});
        return out;
      }
    } catch { /* 落到兜底 */ }
    return GENERIC_NOTE + body; // flash 不可用/失败:无字典兜底
  };
}

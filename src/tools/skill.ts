import { z } from "zod";
import { defineTool } from "./types.js";
import { adaptSkillBody, adaptNote } from "../skills/adapt.js";

// 按名加载一个 skill 的正文指令(渐进式披露:启动只列 name+description,需要时用本工具取正文)。
export const skillTool = defineTool({
  name: "skill",
  description:
    "加载一个开箱即用 skill 的完整指令并据此执行。【强制要求】:当任务匹配可用 skill 列表里的某个 skill 时,必须先调用本工具加载它、再做其它任何回应或动作;绝不只口头提到某个 skill 而不实际调用它。",
  capability: "read",
  approval: "auto",
  schema: z.object({
    name: z.string().min(1).describe("要加载的 skill 名"),
  }),
  handler: async (args, ctx) => {
    const skills = ctx.skills ?? [];
    // 容错匹配:精确 name → 大小写不敏感 name → 目录 slug(模型常用直觉短名,不必照抄 Title Case)。
    const want = args.name.trim().toLowerCase();
    const s =
      skills.find((x) => x.name === args.name) ??
      skills.find((x) => x.name.toLowerCase() === want) ??
      skills.find((x) => x.slug?.toLowerCase() === want);
    if (!s) {
      const avail = skills.map((x) => x.name).join(", ") || "(无)";
      return `未找到 skill「${args.name}」。可用:${avail}。`;
    }
    ctx.recordSkillUse?.(s.name); // 记使用频率(用于发现/列表加权)
    // 为其它 agent(CC/Codex…)所写的技能:装载时探测外来工具名/跨引用,追加一小段平台对照(命中才加,源文件不动)。
    const note = adaptNote(adaptSkillBody(s.body));
    const loc = s.dir ? `(目录:${s.dir},正文中引用的相对资源以此为根)\n` : ""; // 内置技能无目录
    return `# Skill: ${s.name}\n${loc}\n${note}${s.body}`;
  },
});

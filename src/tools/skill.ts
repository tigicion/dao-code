import { z } from "zod";
import { defineTool } from "./types.js";

// 按名加载一个 skill 的正文指令(渐进式披露:启动只列 name+description,需要时用本工具取正文)。
export const skillTool = defineTool({
  name: "skill",
  description:
    "加载一个开箱即用 skill 的完整指令并据此执行。【强制要求】:当任务匹配可用 skill 列表里的某个 skill 时,必须先调用本工具加载它、再做其它任何回应或动作;绝不只口头提到某个 skill 而不实际调用它。",
  descriptionEn:
    "Loads a ready-to-use skill's full instructions and executes accordingly. [MANDATORY]: When a task matches a skill in the available skill list, you MUST call this tool to load it before taking any other action or response; never just mention a skill name without actually loading it.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    name: z.string().min(1).describe("要加载的 skill 名"),
  }),
  handler: async (args, ctx) => {
    const skills = ctx.skills ?? [];
    // 容错匹配:精确 name → 大小写不敏感 name → 目录 slug(模型常用直觉短名,不必照抄 Title Case)。
    const want = args.name.trim().toLowerCase();
    const nsName = (x: { namespace?: string; slug?: string }) => `${x.namespace ? x.namespace + ":" : ""}${x.slug ?? ""}`.toLowerCase();
    const s =
      skills.find((x) => nsName(x) === want) ?? // 带命名空间精确(plugin:slug)
      skills.find((x) => x.name === args.name) ??
      skills.find((x) => x.name.toLowerCase() === want) ??
      skills.find((x) => x.slug?.toLowerCase() === want); // 裸 slug:撞名时取列表里的(已按优先级)
    if (!s) {
      const avail = skills.map((x) => x.name).join(", ") || "(无)";
      return `未找到 skill「${args.name}」。可用:${avail}。`;
    }
    ctx.recordSkillUse?.(s.name); // 记使用频率(用于发现/列表加权)
    // 为其它 agent(CC/Codex/Gemini…)所写的技能:装载时检测+用模型按用途转换工具名(无翻译字典,
    // 按源 hash 缓存,源文件不动);dao 原生技能原样返回。flash 不可用则退回原文+通用提示。
    const text = ctx.adaptSkill ? await ctx.adaptSkill(s.body) : s.body;
    const loc = s.dir ? `(目录:${s.dir},正文中引用的相对资源以此为根)\n` : ""; // 内置技能无目录
    // 遵从约束:loaded skill 是【必须照做的流程】,不是可选参考——治"加载了却不照步骤做"(如不给用户选项)。
    const follow =
      `\n\n---\n[执行约束] 以上 skill 正文是【必须照做的流程指令】,不是可选信息:优先级高于你的默认习惯,` +
      `仅让位于用户当前明确指令、安全/证据,以及 DAO 的模型/上下文选型政策(技能不得据此换模型、或事事开新上下文/派子代理)。` +
      `若它含步骤/清单,立即用 todo_write 逐条建 todo 并按序执行;` +
      `含"给用户选项 / 确认 / 分阶段"的步骤【必须】执行(用 ask_user 给选项),不要跳过、不要只在脑子里走。`;
    return `# Skill: ${s.name}\n${loc}\n${text}${follow}`;
  },
});

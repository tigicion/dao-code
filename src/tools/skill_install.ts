import { z } from "zod";
import { defineTool } from "./types.js";
import { installSkills } from "../skills/install.js";

// 让模型能直接"装一套技能"(对应操作员命令 dao skill add):克隆/复制 + 校验 + 报告需适配的外来工具名。
// 修"用户要装 superpowers 时模型逐个 WebFetch 再手抄改写、还压缩内容"的反模式。
export const skillInstallTool = defineTool({
  name: "skill_install",
  description:
    "安装一套技能:从 git 仓库或本地路径,把含 SKILL.md 的技能克隆/复制到 ~/.dao/skills(用户级)或项目 .dao/skills;" +
    "保留完整内容,工具名在【加载时】自动适配(无需改写)。用户要'装/导入/添加一套技能'(如 superpowers)时用本工具——" +
    "不要逐个 WebFetch 再手抄、更不要压缩内容。装完需重启 dao 才加载。",
  capability: "exec", // git clone + 写文件
  approval: "required",
  schema: z.object({
    source: z.string().min(1).describe("git URL(如 https://github.com/obra/superpowers-skills)或本地路径"),
    scope: z.enum(["user", "project"]).optional().describe("user=~/.dao/skills(跨项目,默认);project=当前项目 .dao/skills"),
  }),
  handler: async (args, ctx) => {
    let out = "";
    await installSkills(args.source, args.scope ?? "user", ctx.workspaceRoot, (s) => { out += s; });
    return out.trim() || "(完成)";
  },
});

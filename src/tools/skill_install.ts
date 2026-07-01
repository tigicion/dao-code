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
    "不要逐个 WebFetch 再手抄、更不要压缩内容。装完自动加载进当前会话、本次即可用,无需重启。",
  capability: "exec", // git clone + 写文件
  approval: "required",
  schema: z.object({
    source: z.string().min(1).describe("git URL(如 https://github.com/obra/superpowers-skills)或本地路径"),
    scope: z.enum(["user", "project"]).optional().describe("user=~/.dao/skills(跨项目,默认);project=当前项目 .dao/skills"),
  }),
  handler: async (args, ctx) => {
    const scope = args.scope ?? "user";
    let out = "";
    await installSkills(args.source, scope, ctx.workspaceRoot, (s) => { out += s; });
    out = out.trim() || "(完成)";
    // 装完自动加载进当前会话(追加式,便宜、无需重启);headless/子代理未注入则跳过。
    const loaded = ctx.loadInstalledSkills ? await ctx.loadInstalledSkills(scope) : [];
    if (loaded.length) out += `\n\n已加载到当前会话(本次即可用,无需重启):${loaded.join("、")}`;
    return out;
  },
});

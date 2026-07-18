import { z } from "zod";
import { defineTool } from "./types.js";
import { installSkills } from "../skills/install.js";

// 让模型能直接"装一套技能"(对应操作员命令 dao skill add):克隆/复制 + 校验 + 报告需适配的外来工具名。
// 修"用户要装 superpowers 时模型逐个 WebFetch 再手抄改写、还压缩内容"的反模式。
export const skillInstallTool = defineTool({
  name: "SkillInstall",
  description:
    "安装一套技能:从 git 仓库或本地路径,把含 SKILL.md 的技能克隆/复制到 ~/.dao/skills(scope=user,默认,跨项目都能用)" +
    "或项目 .dao/skills(scope=project,只这个项目用)。保留完整内容,原样搬,工具名在【加载时】自动适配" +
    "(无需改写、无需你去猜对应关系)。用户要'装/导入/添加一套技能'(如 superpowers)时用本工具——不要逐个 WebFetch" +
    "再手抄、更不要为了省事压缩内容,那样会丢细节还可能引入转写错误。装完自动加载进当前会话、本次对话里就能直接用," +
    "不需要重启 dao。source 可以是完整 git URL,也可以是本地已经克隆好的路径——用户手头已经有一份技能仓库时不用重新拉取。",
  descriptionEn:
    "Installs a set of skills: clones/copies skills containing SKILL.md from a git repo or local path to ~/.dao/skills (scope=user, default, usable across all projects) " +
    "or the project's .dao/skills (scope=project, this project only). Preserves full content verbatim; tool names are auto-adapted at [load time] (no rewriting needed, " +
    "no need to guess the mapping yourself). Use when the user wants to 'install / import / add a skill set' (e.g., superpowers) — " +
    "do NOT fetch one by one via WebFetch and hand-copy, and do NOT compress the content to save effort — that loses detail and risks transcription errors. " +
    "Installed skills auto-load into the current session and are usable in this same conversation; no restart needed.",
  capability: "exec", // git clone + 写文件
  approval: "required",
  shouldDefer: true,
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

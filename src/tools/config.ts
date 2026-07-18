import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { defineTool } from "./types.js";
import type { PermissionMode } from "../permissions/settings.js";

const VALID_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "auto"]);

// 参考 Config 工具:读写运行时配置项。支持全局(~/.dao/settings.json)和项目级(.dao/settings.json)。
// 目前支持 setting: permissions.defaultMode, theme。后续可扩展。
export const configTool = defineTool({
  name: "Config",
  description:
    "读取或设置 dao 配置项。不传 value 时返回当前值;传 value 时写入。" +
    "支持 setting: 'permissions.defaultMode'(权限模式:default/acceptEdits/plan/bypassPermissions/auto)、" +
    "'theme'(终端主题:light/dark)。" +
    "配置来源优先级:企业策略 > 用户级(~/.dao/settings.json)> 项目级(.dao/settings.json)。",
  descriptionEn:
    "Read or set dao configuration. Omit value to read current; include value to write. " +
    "Supports: 'permissions.defaultMode' (default/acceptEdits/plan/bypassPermissions/auto), 'theme' (light/dark). " +
    "Config source priority: enterprise > user (~/.dao/settings.json) > project (.dao/settings.json).",
  capability: "plan",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({
    setting: z.string().describe("配置项键名,如 'permissions.defaultMode' 或 'theme'"),
    value: z.union([z.string(), z.boolean(), z.number()]).optional().describe("新值;省略则读取当前值"),
  }),
  handler: async (args, ctx) => {
    const { setting, value } = args;
    const userSettings = path.join(ctx.homeDir ?? os.homedir(), ".dao", "settings.json");
    const projectSettings = path.join(ctx.workspaceRoot, ".dao", "settings.json");

    // 读取:合并用户级 + 项目级
    if (value === undefined) {
      const readVal = async (file: string): Promise<unknown> => {
        try {
          const raw = await fs.readFile(file, "utf8");
          const obj = JSON.parse(raw);
          return setting.includes(".")
            ? setting.split(".").reduce((o: any, k) => o?.[k], obj)
            : obj[setting];
        } catch { return undefined; }
      };
      const projectVal = await readVal(projectSettings);
      const userVal = await readVal(userSettings);
      const result = projectVal ?? userVal;
      return result !== undefined ? String(result) : `(未设置:${setting})`;
    }

    // 写入:写到用户级 settings.json(不写项目级,避免污染仓库)
    let obj: any = {};
    try {
      obj = JSON.parse(await fs.readFile(userSettings, "utf8"));
    } catch { /* 文件不存在,从空开始 */ }

    // 校验已知 setting
    if (setting === "permissions.defaultMode") {
      if (typeof value !== "string" || !VALID_MODES.has(value)) {
        return `无效值。permissions.defaultMode 可选:${[...VALID_MODES].join("/")}`;
      }
      obj.permissions ??= {};
      obj.permissions.defaultMode = value as PermissionMode;
    } else if (setting === "theme") {
      if (value !== "light" && value !== "dark") {
        return "无效值。theme 可选:light/dark";
      }
      obj.theme = value;
    } else {
      // 通用写入:按点号路径设置
      const keys = setting.split(".");
      let cur = obj;
      for (let i = 0; i < keys.length - 1; i++) {
        cur[keys[i]!] ??= {};
        cur = cur[keys[i]!];
      }
      cur[keys[keys.length - 1]!] = value;
    }

    try {
      await fs.mkdir(path.dirname(userSettings), { recursive: true });
      await fs.writeFile(userSettings, JSON.stringify(obj, null, 2) + "\n", "utf8");
      return `已设置 ${setting} = ${JSON.stringify(value)}(写入 ${userSettings})`;
    } catch (e) {
      return `写入失败:${(e as Error).message}`;
    }
  },
});

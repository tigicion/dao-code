import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./types.js";
import { addMemory } from "../memory/store.js";

function memoryFile(scope: "project" | "user", workspaceRoot: string): string {
  const base = scope === "user" ? os.homedir() : workspaceRoot;
  return path.join(base, ".codeds", "memory", "memories.json");
}

export const memoryWriteTool = defineTool({
  name: "memory_write",
  description:
    "记录一条跨 session 的稳定事实(用户偏好、项目约定等),供以后会话启动时参考。发现值得长期记住的事实时克制使用。scope 默认 project(项目级),user 为用户级(跨项目)。",
  capability: "plan",
  approval: "auto",
  schema: z.object({
    text: z.string().min(1).describe("要记住的事实(一句话)"),
    scope: z.enum(["project", "user"]).optional().describe("project(默认)或 user"),
  }),
  handler: async (args, ctx) => {
    const scope = args.scope ?? "project";
    const file = memoryFile(scope, ctx.workspaceRoot);
    const added = await addMemory(file, args.text);
    const label = scope === "user" ? "用户级" : "项目级";
    return added
      ? `已记住(${label}):${args.text.trim()}`
      : `已存在,跳过:${args.text.trim()}`;
  },
});

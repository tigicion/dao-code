import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { clampOutput } from "./output.js";

// 超大工具输出:把全量落盘到 .dao/spill/,上下文里只放中间截断版 + 指针,
// 模型需要完整内容时用 read_file 读取该文件。既防上下文膨胀,又不丢信息(可检索)。
export function spillOutput(content: string, workspaceRoot: string, max = 16000): string {
  if (content.length <= max) return content;
  let pointer = "";
  try {
    const dir = path.join(workspaceRoot, ".dao", "spill");
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`;
    writeFileSync(path.join(dir, name), content);
    pointer = `\n[完整输出 ${content.length} 字符已落盘:.dao/spill/${name} —— 需要完整内容时用 read_file 读取(可配合 grep_files 精确定位)]`;
  } catch {
    /* 落盘失败 → 退化为纯截断 */
  }
  return clampOutput(content, max) + pointer;
}

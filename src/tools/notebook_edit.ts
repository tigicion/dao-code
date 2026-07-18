import { promises as fs } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { resolveWritePath } from "./paths.js";
import { atomicWrite } from "./fs_atomic.js";
import { withFileLock } from "./file_lock.js";

// 编辑 Jupyter notebook(.ipynb)的单元格:replace 替换 / insert 插入 / delete 删除指定下标的 cell。对标 CC 的 NotebookEdit。
export const notebookEditTool = defineTool({
  name: "notebook_edit",
  description:
    "编辑 Jupyter notebook(.ipynb)的单元格:mode=replace 替换整个 cell 的内容 / insert 在该下标处插入新 cell / delete 删除该下标的 cell。" +
    "cell_index 是【0-based】(和 read_file 的 1-based 行号不是一回事,别混用);replace/delete 时下标越界会报错," +
    "insert 时下标超出范围会自动夹到末尾(不报错)。新建 cell 默认 cell_type=code(会自动清空 outputs/execution_count," +
    "即视为未运行状态),要建 markdown cell 需显式设 cell_type。replace 时若原 cell 是 code 且没有 outputs 字段," +
    "也会补上空的 outputs/execution_count。整个 notebook 是普通 JSON 文件,但改前必须先用 read_file 读过它——" +
    "本工具只操作 cells 数组,不解析/校验 notebook 其它元数据(kernelspec 等)是否合法。",
  descriptionEn:
    "Edits cells in a Jupyter notebook (.ipynb): mode=replace replaces a cell's content / insert adds a new cell at the index / delete removes the cell at the index. " +
    "cell_index is [0-based] (unlike read_file's 1-based line numbers — don't conflate the two); replace/delete error on an out-of-range index, " +
    "insert instead clamps an out-of-range index to the end (no error). New cells default to cell_type=code (outputs/execution_count are reset to empty/null, " +
    "i.e. treated as not-yet-run); set cell_type explicitly for a markdown cell. On replace, if the existing cell is code and lacks an outputs field, " +
    "empty outputs/execution_count are also added. The notebook is a plain JSON file, but must be read_file'd first before editing — " +
    "this tool only touches the cells array, it doesn't validate other notebook metadata (kernelspec etc.).",
  capability: "write",
  approval: "required",
  shouldDefer: true,
  schema: z.object({
    path: z.string().describe(".ipynb 文件路径(相对工作区根)"),
    cell_index: z.number().int().min(0).describe("目标单元格下标(0 起)"),
    mode: z.enum(["replace", "insert", "delete"]).describe("replace/insert/delete"),
    source: z.string().optional().describe("replace/insert 时的单元格源码"),
    cell_type: z.enum(["code", "markdown"]).optional().describe("insert 默认 code;replace 可改类型"),
  }),
  handler: async (args, ctx) => {
    const abs = resolveWritePath(ctx.workspaceRoot, args.path);
    return withFileLock(abs, async () => {
      if (ctx.readFiles && !ctx.readFiles.has(abs)) {
        throw new Error(`编辑前请先用 read_file 读过它:${args.path}`);
      }
      let nb: any;
      try { nb = JSON.parse(await fs.readFile(abs, "utf8")); } catch { throw new Error(`不是合法 JSON 的 .ipynb:${args.path}`); }
      if (!Array.isArray(nb.cells)) throw new Error(".ipynb 缺 cells 数组");
      const cells = nb.cells as any[];
      const i = args.cell_index;
      // ipynb 的 source 是"保留行尾换行的行数组"。
      const toSource = (s: string) => s.split(/(?<=\n)/);
      if (args.mode === "delete") {
        if (i >= cells.length) throw new Error(`cell_index ${i} 越界(共 ${cells.length})`);
        cells.splice(i, 1);
      } else if (args.mode === "insert") {
        const type = args.cell_type ?? "code";
        const cell: any = { cell_type: type, metadata: {}, source: toSource(args.source ?? "") };
        if (type === "code") { cell.outputs = []; cell.execution_count = null; }
        cells.splice(Math.min(i, cells.length), 0, cell);
      } else {
        if (i >= cells.length) throw new Error(`cell_index ${i} 越界(共 ${cells.length})`);
        cells[i].source = toSource(args.source ?? "");
        if (args.cell_type) cells[i].cell_type = args.cell_type;
        if (cells[i].cell_type === "code" && !("outputs" in cells[i])) { cells[i].outputs = []; cells[i].execution_count = null; }
      }
      await atomicWrite(abs, JSON.stringify(nb, null, 1));
      const verb = args.mode === "delete" ? "删除" : args.mode === "insert" ? "插入" : "替换";
      return `已${verb} ${args.path} 第 ${i} 个 cell(现共 ${cells.length} 个)`;
    });
  },
});

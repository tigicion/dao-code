import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { notebookEditTool } from "./notebook_edit.js";

let root: string, abs: string;
const ctx = () => ({ workspaceRoot: root, readFiles: new Set([abs]) });
const nb = (cells: any[]) => JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dao-nb-"));
  abs = path.join(root, "n.ipynb");
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const cells = async () => JSON.parse(await fs.readFile(abs, "utf8")).cells;

describe("notebook_edit", () => {
  it("replace 替换单元格源码", async () => {
    await fs.writeFile(abs, nb([{ cell_type: "code", metadata: {}, source: ["old"], outputs: [], execution_count: null }]));
    await notebookEditTool.handler({ path: "n.ipynb", cell_index: 0, mode: "replace", source: "print(1)" }, ctx());
    expect((await cells())[0].source).toEqual(["print(1)"]);
  });

  it("insert 在下标处插入,默认 code", async () => {
    await fs.writeFile(abs, nb([{ cell_type: "code", metadata: {}, source: ["a"], outputs: [], execution_count: null }]));
    await notebookEditTool.handler({ path: "n.ipynb", cell_index: 0, mode: "insert", source: "# 标题", cell_type: "markdown" }, ctx());
    const c = await cells();
    expect(c.length).toBe(2);
    expect(c[0].cell_type).toBe("markdown");
    expect(c[0].source).toEqual(["# 标题"]);
  });

  it("delete 删除单元格", async () => {
    await fs.writeFile(abs, nb([
      { cell_type: "code", metadata: {}, source: ["a"], outputs: [], execution_count: null },
      { cell_type: "code", metadata: {}, source: ["b"], outputs: [], execution_count: null },
    ]));
    await notebookEditTool.handler({ path: "n.ipynb", cell_index: 0, mode: "delete" }, ctx());
    const c = await cells();
    expect(c.length).toBe(1);
    expect(c[0].source).toEqual(["b"]);
  });

  it("越界报错", async () => {
    await fs.writeFile(abs, nb([]));
    await expect(notebookEditTool.handler({ path: "n.ipynb", cell_index: 5, mode: "delete" }, ctx())).rejects.toThrow(/越界/);
  });
});

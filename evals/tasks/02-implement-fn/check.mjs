import path from "node:path";
import { pathToFileURL } from "node:url";

// 通过条件:math.mjs 导入后 add(2,3)===5 且 sub(5,2)===3。
export default async function ({ workspace }) {
  try {
    const mod = await import(pathToFileURL(path.join(workspace, "math.mjs")).href + `?t=${Date.now()}`);
    const ok = typeof mod.add === "function" && typeof mod.sub === "function" && mod.add(2, 3) === 5 && mod.sub(5, 2) === 3;
    return { pass: ok, note: ok ? "" : "add/sub 不正确或未导出" };
  } catch (e) {
    return { pass: false, note: `import 失败:${e.message}` };
  }
}

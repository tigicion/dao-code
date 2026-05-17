import path from "node:path";
import { pathToFileURL } from "node:url";

// 通过条件:isEven(4)===true 且 isEven(3)===false 且 isEven(0)===true。
export default async function ({ workspace }) {
  try {
    const mod = await import(pathToFileURL(path.join(workspace, "is_even.mjs")).href + `?t=${Date.now()}`);
    const ok = mod.isEven(4) === true && mod.isEven(3) === false && mod.isEven(0) === true;
    return { pass: ok, note: ok ? "" : "isEven 仍不正确" };
  } catch (e) {
    return { pass: false, note: `import 失败:${e.message}` };
  }
}

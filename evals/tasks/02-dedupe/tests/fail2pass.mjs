import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ws = process.argv[2];
const { dedupeById } = await import(pathToFileURL(path.join(ws, "dedupe.mjs")).href + `?t=${Date.now()}`);

// id 相同但不同对象 → 应按 id 去重、保留首次、维持顺序
const out = dedupeById([{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 1, v: "c" }, { id: 2, v: "d" }]);
assert.deepEqual(out.map((x) => x.id), [1, 2]);
assert.equal(out[0].v, "a"); // 首次出现的保留
assert.equal(out[1].v, "b");
console.log("fail2pass OK");

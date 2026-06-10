// checkpoint:arrays。对 agent 隐藏。argv[2]=工作区路径。
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ws = process.argv[2];
const m = await import(pathToFileURL(path.join(ws, "src", "arrays.mjs")).href + `?t=${Date.now()}`);

assert.deepEqual(m.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepEqual(m.chunk([], 3), []);
assert.throws(() => m.chunk([1, 2], 0), RangeError);

assert.deepEqual(
  m.uniqBy([{ id: 1, v: "a" }, { id: 1, v: "b" }, { id: 2, v: "c" }], (x) => x.id),
  [{ id: 1, v: "a" }, { id: 2, v: "c" }],
);
assert.deepEqual(m.uniqBy([3, 1, 3, 2, 1], (x) => x), [3, 1, 2]);

assert.deepEqual(m.groupBy([1, 2, 3, 4], (x) => x % 2), { 0: [2, 4], 1: [1, 3] });
assert.deepEqual(m.groupBy(["apple", "ant", "bee"], (s) => s[0]), { a: ["apple", "ant"], b: ["bee"] });

console.log("arrays OK");

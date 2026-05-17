import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ws = process.argv[2];
const { dedupeById } = await import(pathToFileURL(path.join(ws, "dedupe.mjs")).href + `?t=${Date.now()}`);

// 既有功能:本就无重复 id 时,原样保留、顺序不变(base 与改后都应通过)
const out = dedupeById([{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3, v: "c" }]);
assert.deepEqual(out.map((x) => x.id), [1, 2, 3]);
assert.deepEqual(dedupeById([]), []);
console.log("pass2pass OK");

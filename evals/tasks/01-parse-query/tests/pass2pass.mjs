// pass2pass:既有功能须始终通过(base 和改后都过)——单 key 仍是字符串、空串仍是 {}。
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ws = process.argv[2];
const { parseQuery } = await import(pathToFileURL(path.join(ws, "qs.mjs")).href + `?t=${Date.now()}`);

assert.deepEqual(parseQuery("x=9&y=hello"), { x: "9", y: "hello" });
assert.deepEqual(parseQuery(""), {});
console.log("pass2pass OK");

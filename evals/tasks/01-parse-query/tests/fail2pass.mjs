// fail2pass:base(未修)应失败,改对后应通过。对 agent 隐藏(不在 workspace 里)。
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ws = process.argv[2];
const { parseQuery } = await import(pathToFileURL(path.join(ws, "qs.mjs")).href + `?t=${Date.now()}`);

assert.deepEqual(parseQuery("a=1&a=2&b=3"), { a: ["1", "2"], b: "3" });
assert.deepEqual(parseQuery("k=x&k=y&k=z"), { k: ["x", "y", "z"] });
console.log("fail2pass OK");

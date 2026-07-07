import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ws = process.argv[2];
const { configureAxis } = await import(pathToFileURL(path.join(ws, "axisConfig.mjs")).href + `?t=${Date.now()}`);

// 显式指定 range 时,必须原样保留用户给定的顺序,不能被默认排列规则覆盖
assert.deepEqual(configureAxis([1, 2, 3], [-1, 2.1]), [-1, 2.1]);
assert.deepEqual(configureAxis([10, 20], [0, 100]), [0, 100]);
console.log("fail2pass OK");

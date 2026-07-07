import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ws = process.argv[2];
const { configureAxis } = await import(pathToFileURL(path.join(ws, "axisConfig.mjs")).href + `?t=${Date.now()}`);

// 既有功能:未显式指定 range 时,默认行为(自动算边界 + 从大到小排列)必须不受影响
assert.deepEqual(configureAxis([1, 2, 3]), [3.5, 0.5]);
assert.deepEqual(configureAxis([10, 20, 30]), [30.5, 9.5]);
console.log("pass2pass OK");

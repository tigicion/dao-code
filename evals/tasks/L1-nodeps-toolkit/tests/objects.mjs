// checkpoint:objects。对 agent 隐藏。argv[2]=工作区路径。
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ws = process.argv[2];
const m = await import(pathToFileURL(path.join(ws, "src", "objects.mjs")).href + `?t=${Date.now()}`);

const orig = { a: 1, b: { c: [1, 2, { d: 3 }] }, e: new Date(2026, 0, 1) };
const cloned = m.deepClone(orig);
assert.deepEqual(cloned, orig); // 值相等
assert.notEqual(cloned, orig); // 不同引用
assert.notEqual(cloned.b, orig.b);
assert.notEqual(cloned.b.c, orig.b.c);
assert.notEqual(cloned.b.c[2], orig.b.c[2]);
assert.ok(cloned.e instanceof Date);
assert.notEqual(cloned.e, orig.e);
cloned.b.c[2].d = 999;
assert.equal(orig.b.c[2].d, 3); // 改副本不影响原对象

assert.equal(m.deepClone(42), 42);
assert.equal(m.deepClone(null), null);

assert.deepEqual(m.pick({ a: 1, b: 2, c: 3 }, ["a", "c"]), { a: 1, c: 3 });
assert.deepEqual(m.pick({ a: 1 }, ["a", "zzz"]), { a: 1 }); // 不存在的键忽略

console.log("objects OK");

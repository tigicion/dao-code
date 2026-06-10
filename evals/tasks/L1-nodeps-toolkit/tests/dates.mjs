// checkpoint:dates。对 agent 隐藏。argv[2]=工作区路径。
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ws = process.argv[2];
const m = await import(pathToFileURL(path.join(ws, "src", "dates.mjs")).href + `?t=${Date.now()}`);

// 本地时间构造,避开时区歧义
const d = new Date(2026, 0, 9, 7, 5, 3); // 2026-01-09 07:05:03 本地
assert.equal(m.formatDate(d, "YYYY-MM-DD"), "2026-01-09");
assert.equal(m.formatDate(d, "YYYY/MM/DD HH:mm:ss"), "2026/01/09 07:05:03");
assert.equal(m.formatDate(d, "HH:mm"), "07:05");

const base = new Date(2026, 5, 10, 12, 0, 0);
const ago = (ms) => new Date(base.getTime() - ms);
const ahead = (ms) => new Date(base.getTime() + ms);
assert.equal(m.relativeTime(base, base), "just now");
assert.equal(m.relativeTime(ago(5000), base), "5s ago");
assert.equal(m.relativeTime(ago(3 * 60000), base), "3m ago");
assert.equal(m.relativeTime(ago(2 * 3600000), base), "2h ago");
assert.equal(m.relativeTime(ago(4 * 86400000), base), "4d ago");
assert.equal(m.relativeTime(ahead(5000), base), "in 5s");
assert.equal(m.relativeTime(ahead(2 * 3600000), base), "in 2h");

console.log("dates OK");

// checkpoint:strings。对 agent 隐藏。argv[2]=工作区路径。
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ws = process.argv[2];
const m = await import(pathToFileURL(path.join(ws, "src", "strings.mjs")).href + `?t=${Date.now()}`);

assert.equal(m.slugify("Hello, World!"), "hello-world");
assert.equal(m.slugify("  multiple   spaces & symbols!! "), "multiple-spaces-symbols");
assert.equal(m.slugify("already-slug"), "already-slug");

assert.equal(m.truncate("hello", 10), "hello");
assert.equal(m.truncate("hello world", 8), "hello w…");
assert.equal(m.truncate("hello world", 8).length, 8);
assert.equal(m.truncate("abcdef", 5, "..."), "ab...");

assert.equal(m.titleCase("hELLO world"), "Hello World");
assert.equal(m.titleCase("the QUICK brown"), "The Quick Brown");

console.log("strings OK");

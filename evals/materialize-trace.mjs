// 把一个 dao session 目录(state.json + cache/tool/perm/memory/skill trace jsonl)"物化"成
// 可导航的、每条消息一个文件的目录结构——仿 AHE 论文 Agent Debugger 的输入形式:
// 调试/演化角色不用一次性吞下整份 state.json,能先扫 index.md/turns.jsonl 定位可疑轮,
// 再按需精确打开某一条 messages/*.md。
//
// 只依赖 Node 内置模块,纯读 JSON/JSONL 文本,不 import 任何 src/*.ts——
// 好让 evals/run.mjs(plain node,不过 tsx)可以直接 import 它。
//
// 用法:materializeTrace(sessionDir) —— 原地在 sessionDir 下写 messages/、turns.jsonl、index.md。

import { promises as fs } from "node:fs";
import path from "node:path";

// 从一次性运行的临时工作区捞出 dao 产生的 session 目录(.dao/sessions/<id>/,应恰好一个,
// 因为 tmp 每次全新)。run.mjs / adapter.mjs 共用,避免各写一份。
export async function findSessionDir(tmp) {
  const sessionsDir = path.join(tmp, ".dao", "sessions");
  let names;
  try { names = await fs.readdir(sessionsDir); } catch { return null; }
  if (!names.length) return null;
  // 理论上只有一个;若意外有多个(不应该),取 state.json 最新写入的那个。
  const dirs = await Promise.all(names.map(async (n) => {
    const p = path.join(sessionsDir, n);
    const st = await fs.stat(path.join(p, "state.json")).catch(() => null);
    return { p, mtime: st?.mtimeMs ?? 0 };
  }));
  dirs.sort((a, b) => b.mtime - a.mtime);
  return dirs[0]?.p ?? null;
}

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

async function readJsonlSafe(p) {
  let raw;
  try { raw = await fs.readFile(p, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

// 和 src/tools/execute.ts 的 looksFailed 同一套判定(未导入 TS,故复刻一份轻量版)。
function looksFailed(content) {
  if (typeof content !== "string") return false;
  return content.startsWith("Error") || /\[exit ([1-9]\d*)\]|\[超时|\[已中断\]/.test(content);
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

export async function materializeTrace(sessionDir) {
  const state = await readJsonSafe(path.join(sessionDir, "state.json"));
  if (!state || !Array.isArray(state.messages)) return { ok: false, reason: "state.json 缺失或无 messages" };

  const cacheEntries = await readJsonlSafe(path.join(sessionDir, "cache.jsonl"));
  const mainCache = cacheEntries
    .filter((e) => (e.agent ?? "main") === "main" && (e.depth ?? 0) === 0)
    .sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0));

  const messagesDir = path.join(sessionDir, "messages");
  await fs.mkdir(messagesDir, { recursive: true });

  const idToName = new Map(); // tool_call_id → 工具名(从 assistant.tool_calls 建)
  const turns = [];
  let turnIdx = -1;

  for (let i = 0; i < state.messages.length; i++) {
    const m = state.messages[i];
    const idx = pad3(i);
    if (m.role === "system") {
      await fs.writeFile(path.join(messagesDir, `${idx}-system.md`), `# [${idx}] system\n\n${m.content ?? ""}\n`, "utf8");
    } else if (m.role === "user") {
      await fs.writeFile(path.join(messagesDir, `${idx}-user.md`), `# [${idx}] user\n\n${m.content ?? ""}\n`, "utf8");
    } else if (m.role === "assistant") {
      turnIdx++;
      const calls = (m.tool_calls || []).map((tc) => {
        idToName.set(tc.id, tc.function.name);
        return { id: tc.id, name: tc.function.name, args: tc.function.arguments };
      });
      const body = [
        `# [${idx}] assistant  ·  turn ${turnIdx}`,
        "",
        m.content ?? "(无文本,仅工具调用)",
      ];
      if (calls.length) {
        body.push("", "## 工具调用", ...calls.map((c) => `- \`${c.id}\` → ${c.name}(${c.args})`));
      }
      if (m.reasoningContent) {
        body.push("", "## 思维链", "", m.reasoningContent);
      }
      await fs.writeFile(path.join(messagesDir, `${idx}-assistant.md`), body.join("\n") + "\n", "utf8");
      turns.push({ turn: turnIdx, msgIndex: i, hasText: !!m.content, hasReasoning: !!m.reasoningContent, toolCalls: calls.map((c) => ({ id: c.id, name: c.name, ok: null })) });
    } else if (m.role === "tool") {
      const name = idToName.get(m.tool_call_id) || "unknown";
      const ok = !looksFailed(m.content);
      await fs.writeFile(
        path.join(messagesDir, `${idx}-tool-${name}.md`),
        `# [${idx}] tool_result — ${name} (${m.tool_call_id})\n\nok: ${ok}\n\n${m.content ?? ""}\n`,
        "utf8",
      );
      const t = turns[turns.length - 1];
      if (t) {
        const c = t.toolCalls.find((c) => c.id === m.tool_call_id);
        if (c) { c.ok = ok; c.msgIndex = i; }
      }
    }
  }

  // 把主回合 cache 统计按顺序对应到每个 turn(reflect/子代理不进 argvPrompt 路径,通常个数对得上;
  // 对不上时按位置尽量对,多出的 turn 就没有 cache 字段,不强行猜)。
  for (const t of turns) {
    const c = mainCache[t.turn];
    if (c) t.cache = { prompt: c.prompt, hit: c.hit, miss: c.miss, completion: c.completion, ratio: c.ratio, model: c.model };
  }

  await fs.writeFile(path.join(sessionDir, "turns.jsonl"), turns.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

  const failedTurns = turns.filter((t) => t.toolCalls.some((c) => c.ok === false));
  const rows = turns.map((t) => {
    const toolsStr = t.toolCalls.map((c) => `${c.name}${c.ok === false ? "✗" : ""}`).join(", ") || "-";
    const ratio = t.cache ? `${(t.cache.ratio * 100).toFixed(0)}%` : "-";
    const prompt = t.cache ? t.cache.prompt : "-";
    return `| ${t.turn} | ${t.hasText ? "是" : "否"} | ${toolsStr} | ${prompt} | ${ratio} |`;
  });

  const existing = [];
  for (const f of ["tool-trace.jsonl", "perm-trace.jsonl", "memory-trace.jsonl", "skill-trace.jsonl", "cache.jsonl"]) {
    try { await fs.access(path.join(sessionDir, f)); existing.push(f); } catch { /* 不存在就不列 */ }
  }

  const indexMd = [
    `# Trace 索引 —— session ${state.id ?? path.basename(sessionDir)}`,
    "",
    `- 模型: ${state.model ?? "?"} · 模式: ${state.mode ?? "?"}`,
    `- 消息数: ${state.messages.length} · 轮数(assistant 消息数): ${turns.length}`,
    `- usage: prompt=${state.usage?.promptTokens ?? "?"} completion=${state.usage?.completionTokens ?? "?"} cacheHit=${state.usage?.cacheHitTokens ?? "?"} cacheMiss=${state.usage?.cacheMissTokens ?? "?"}`,
    `- 有失败工具调用的轮: ${failedTurns.length ? failedTurns.map((t) => t.turn).join(", ") : "无"}`,
    `- 本次任务的 pass/fail 判定见上一级目录的 meta.json(本文件只记录轨迹本身,不重复判定)`,
    "",
    "## 按轮速览(先看这张表定位可疑轮,再开对应 messages/*.md)",
    "",
    "| 轮 | 有文本 | 工具调用(✗=失败) | prompt tok | 缓存命中率 |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## 文件",
    "",
    `- \`messages/\` —— 每条原始消息一个文件,文件名前缀是它在 state.json.messages 里的下标`,
    `- \`turns.jsonl\` —— 上面表格的机器可读版,一行一轮`,
    `- \`state.json\` —— 原始完整消息数组(未拆分前的真相源)`,
    ...existing.map((f) => `- \`${f}\``),
    "",
  ].join("\n");

  await fs.writeFile(path.join(sessionDir, "index.md"), indexMd, "utf8");
  return { ok: true, turns: turns.length, messages: state.messages.length, failedTurns: failedTurns.length };
}

import { appendFileSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";

// 规范化路径(解符号链接,如 macOS /var→/private/var),失败则原样返回,用于 cwd 比较。
const canon = (p: string): string => {
  try { return realpathSync(p); } catch { return p; }
};
import type { ChatMessage, Usage } from "../client/types.js";
import type { Mode } from "../tools/tools_for_mode.js";
import type { TurnEvents } from "../tui/render.js";

// 会话事件日志(append-only,可观测/可重放)+ 状态快照(崩溃恢复/续跑)。
// events.jsonl 逐事件追加(真相流);state.json 每回合覆盖一份最新快照(快速恢复)。
// 干净退出 markDone() 置 done:true;崩溃则 done 保持 false → 启动时被 findResumable 检出。

// 逻辑事件(不含 ts;append 写入时补 ts)。
export type SessionEvent =
  | { t: "user"; text: string }
  | { t: "assistant"; content: string | null; toolCalls?: { name: string; args: string }[] }
  | { t: "tool_result"; name: string; ok: boolean; content: string }
  | { t: "notice"; text: string }
  | { t: "usage"; usage: Usage }
  | { t: "compaction"; before: number; after: number }
  | { t: "checkpoint"; ref: string; label: string }
  | { t: "turn_end" };

export interface PersistedState {
  id: string;
  cwd: string;
  model: string;
  mode: Mode;
  messages: ChatMessage[];
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number };
  updatedAt: number;
  done: boolean;
}

export interface SessionStore {
  id: string;
  dir: string;
  append(e: SessionEvent): void;
  saveState(s: Omit<PersistedState, "id" | "updatedAt" | "done">): void;
  markDone(): void;
}

function genId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createSessionStore(baseDir: string, id?: string): SessionStore {
  const sid = id ?? genId();
  const dir = path.join(baseDir, sid);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const eventsPath = path.join(dir, "events.jsonl");
  const statePath = path.join(dir, "state.json");
  let last: PersistedState | null = null;
  const flush = () => { if (last) try { writeFileSync(statePath, JSON.stringify(last)); } catch {} };
  return {
    id: sid,
    dir,
    append(e) {
      try { appendFileSync(eventsPath, JSON.stringify({ ...e, ts: Date.now() }) + "\n"); } catch {}
    },
    saveState(s) {
      last = { id: sid, updatedAt: Date.now(), done: false, ...s };
      flush();
    },
    markDone() {
      if (last) { last = { ...last, done: true, updatedAt: Date.now() }; flush(); }
    },
  };
}

export function loadState(baseDir: string, id: string): PersistedState | null {
  try {
    return JSON.parse(readFileSync(path.join(baseDir, id, "state.json"), "utf8")) as PersistedState;
  } catch {
    return null;
  }
}

// 把一组 TurnEvents 包一层:在转发给内层(渲染)的同时,把关键事件写进会话日志。
export function logEvents(inner: TurnEvents, store: SessionStore): TurnEvents {
  return {
    reasoning: (c) => inner.reasoning(c),
    content: (c) => inner.content(c),
    toolStart: (call) => inner.toolStart(call),
    assistantDone: (msg) => {
      inner.assistantDone(msg);
      store.append({
        t: "assistant",
        content: msg.content,
        toolCalls: msg.tool_calls?.map((tc) => ({ name: tc.function.name, args: tc.function.arguments })),
      });
    },
    toolResult: (call, msg) => {
      inner.toolResult(call, msg);
      const ok = !msg.content.startsWith("Error") && !msg.content.includes("拒绝");
      store.append({ t: "tool_result", name: call.function.name, ok, content: msg.content });
    },
    notice: (text) => {
      inner.notice(text);
      const t = text.trim();
      if (t) store.append({ t: "notice", text: t });
    },
  };
}

// 找出可恢复的会话:未完成(done:false)、同一工作区、至少有过一轮真实用户对话;取最近一个。
export function findResumable(baseDir: string, cwd: string): PersistedState | null {
  if (!existsSync(baseDir)) return null;
  const want = canon(cwd);
  let best: PersistedState | null = null;
  for (const sid of readdirSync(baseDir)) {
    const st = loadState(baseDir, sid);
    if (!st || st.done || canon(st.cwd) !== want) continue;
    if (!st.messages.some((m) => m.role === "user")) continue;
    if (!best || st.updatedAt > best.updatedAt) best = st;
  }
  return best;
}

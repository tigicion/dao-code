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
  title?: string; // /rename 设置;/resume 列表可显示
  messages: ChatMessage[];
  usage: { promptTokens: number; completionTokens: number; cacheHitTokens: number; cacheMissTokens: number };
  updatedAt: number;
  done: boolean;
}

// P3-29 Lite-Log:轻量元信息(不含 messages),供 /resume 秒列与可恢复扫描,不必解析整份 state.json。
export interface SessionMeta {
  id: string;
  cwd: string;
  title?: string;
  updatedAt: number;
  done: boolean;
  messageCount: number;
  userMessageCount: number;
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
  const metaPath = path.join(dir, "meta.json");
  let last: PersistedState | null = null;
  const flush = () => {
    if (!last) return;
    try { writeFileSync(statePath, JSON.stringify(last)); } catch {}
    // 同步写轻量 meta(秒列用):只含元信息,不含 messages。
    try {
      const meta: SessionMeta = {
        id: last.id, cwd: last.cwd, title: last.title, updatedAt: last.updatedAt, done: last.done,
        messageCount: last.messages.length,
        userMessageCount: last.messages.filter((m) => m.role === "user").length,
      };
      writeFileSync(metaPath, JSON.stringify(meta));
    } catch {}
  };
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

// 轻量读取会话元信息(秒列用)。优先 meta.json;旧会话无 meta 时回退从 state.json 派生(兼容)。
export function loadMeta(baseDir: string, id: string): SessionMeta | null {
  try {
    return JSON.parse(readFileSync(path.join(baseDir, id, "meta.json"), "utf8")) as SessionMeta;
  } catch {
    const st = loadState(baseDir, id); // 回退:老会话补算一次
    if (!st) return null;
    return {
      id: st.id, cwd: st.cwd, title: st.title, updatedAt: st.updatedAt, done: st.done,
      messageCount: st.messages.length, userMessageCount: st.messages.filter((m) => m.role === "user").length,
    };
  }
}

// 列出某工作区下的会话元信息(按最近更新降序);只读 meta.json,不解析整份 state。
export function listSessions(baseDir: string, cwd?: string): SessionMeta[] {
  if (!existsSync(baseDir)) return [];
  const want = cwd ? canon(cwd) : undefined;
  const out: SessionMeta[] = [];
  for (const sid of readdirSync(baseDir)) {
    const m = loadMeta(baseDir, sid);
    if (!m) continue;
    if (want && canon(m.cwd) !== want) continue;
    out.push(m);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// 找出可恢复的会话:未完成(done:false)、同一工作区、至少有过一轮真实用户对话;取最近一个。
// 先用轻量 meta 扫描定位最佳候选,只对它 loadState(避免解析所有 state.json)。
export function findResumable(baseDir: string, cwd: string): PersistedState | null {
  if (!existsSync(baseDir)) return null;
  const want = canon(cwd);
  let bestId: string | null = null, bestAt = -1;
  for (const m of listSessions(baseDir, want)) {
    if (m.done || m.userMessageCount === 0) continue;
    if (m.updatedAt > bestAt) { bestAt = m.updatedAt; bestId = m.id; }
  }
  return bestId ? loadState(baseDir, bestId) : null;
}

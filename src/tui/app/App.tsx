import React, { useEffect, useRef, useState } from "react";
import { Box, Text, Static, useApp, useInput, usePaste } from "ink";
import { renderMarkdown } from "../markdown.js";
import { semHex } from "../theme.js";
import { Welcome } from "../Welcome.js";
import type { TurnEvents } from "../render.js";
import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from "../../approval/types.js";
import type { AppDeps, LiveState, StatusInfo, TranscriptItem } from "./types.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LIVE_LINES = 12; // 流式动态区只显示尾部这么多行,防止动态区高度≥终端高触发 Ink 整屏闪烁(ink#359)

// 取末 n 行(流式动态区用,完成后整段会以 markdown 提交进 Static)。
function tail(s: string, n: number): string {
  const all = s.split("\n");
  return all.length <= n ? s : "…\n" + all.slice(-n).join("\n");
}

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  json: "json", py: "python", md: "markdown", sh: "bash", bash: "bash", go: "go", rs: "rust",
  java: "java", c: "c", h: "c", cpp: "cpp", css: "css", html: "html", yml: "yaml", yaml: "yaml", sql: "sql",
};
const langFromPath = (p: string): string => LANG[p.split(".").pop()?.toLowerCase() ?? ""] ?? "";
const toLines = (s: string): string[] => s.replace(/\n$/, "").split("\n");

// 连续的工具/diff 行紧凑堆叠(去掉行间空隙),压缩并发/连续工具调用的展示。
const isToolish = (it?: { kind: string }): boolean => !!it && (it.kind === "tool" || it.kind === "diff");

// 工具动作词(toolStart 时参数尚在流式中,只有名字)——用于 live 进度行。
const VERB: Record<string, string> = {
  read_file: "读取", list_dir: "列目录", grep_files: "搜索", file_search: "查找",
  exec_shell: "执行", exec_shell_poll: "查看输出", exec_shell_kill: "结束进程",
  write_file: "写入", edit_file: "编辑", verify_done: "验收", web_search: "网页搜索",
  fetch_url: "抓取", memory_write: "记忆", todo_write: "更新清单", ask_user: "提问", agent: "子代理",
};
const toolVerb = (name: string): string => VERB[name] ?? name;

// 工具调用的"意图/命令"标签:展示意图而非工具名(read_file → 读取 src/foo.ts)。
function activityLabel(name: string, argsJson: string): string {
  let a: Record<string, unknown> = {};
  try { a = JSON.parse(argsJson) as Record<string, unknown>; } catch {}
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const q = (v: unknown) => JSON.stringify(s(v));
  switch (name) {
    case "read_file": return `读取 ${s(a.path)}${a.offset ? ` :${a.offset}` : ""}`;
    case "list_dir": return `列目录 ${s(a.path) || "."}`;
    case "grep_files": return `搜索 ${q(a.pattern)}${a.glob ? ` (${s(a.glob)})` : ""}`;
    case "file_search": return `查找 ${s(a.glob)}`;
    case "exec_shell": return `$ ${s(a.command).split("\n")[0]!.slice(0, 80)}`;
    case "exec_shell_poll": return `查看后台输出`;
    case "exec_shell_kill": return `结束后台进程`;
    case "write_file": return `写入 ${s(a.path)}`;
    case "edit_file": return `编辑 ${s(a.path)}`;
    case "verify_done": return `验收`;
    case "web_search": return `网页搜索 ${q(a.query)}`;
    case "fetch_url": return `抓取 ${s(a.url)}`;
    case "memory_write": return `记忆 ${s(a.text).slice(0, 50)}`;
    case "todo_write": return `更新任务清单`;
    case "ask_user": return `提问`;
    case "agent": return Array.isArray(a.tasks) ? `并行 ${a.tasks.length} 个子代理` : `子代理:${s(a.task).slice(0, 50)}`;
    default: return name;
  }
}

// 结果只留一行小结(内容做轻;详细结果由模型的后续思考/动作体现)。报错显示首行。
function resultDetail(name: string, ok: boolean, content: string): string {
  const lines = content.split("\n");
  if (!ok) return lines[0]!.slice(0, 120); // 报错首行
  const n = lines.length;
  switch (name) {
    case "read_file": return `${n} 行`;
    case "list_dir": return content.startsWith("(") ? content : `${n} 项`;
    case "grep_files": return content.startsWith("(") ? content : `${n} 命中`;
    case "file_search": return content.startsWith("(") ? content : `${n} 个`;
    case "write_file": return content.replace(/^已写入[^()]*/, "").trim() || `${n} 行`;
    case "exec_shell": return lines.filter((l) => l.trim()).slice(-1)[0]?.slice(0, 100) ?? "";
    case "verify_done": return lines.filter((l) => l.includes("验收")).slice(-1)[0] ?? lines.slice(-1)[0]!.slice(0, 80);
    case "web_search": return content.startsWith("(") ? content : `${content.split("\n\n").length} 条`;
    case "fetch_url": return `${content.length} 字`;
    default: return ""; // memory/todo/ask 等:标签已足够
  }
}

export function App(deps: AppDeps) {
  const { exit } = useApp();
  const [bg, setBg] = useState(deps.welcome.bg); // /theme 运行时可切浅/深
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);

  const initial = deps.initialItems ?? [];
  const idRef = useRef(initial.reduce((m, it) => Math.max(m, it.id), 0) + 1);
  const nextId = () => idRef.current++;
  const [items, setItems] = useState<({ id: number; kind: "welcome" } | TranscriptItem)[]>([
    { id: 0, kind: "welcome" },
    ...initial,
  ]);
  const [live, setLive] = useState<LiveState | null>(null);
  // 输入框:text + 光标位置合成一个 state,用函数式更新(避免同步连打/批处理下读到旧闭包值而丢字符)。
  const [field, setField] = useState<{ text: string; cursor: number }>({ text: "", cursor: 0 });
  const input = field.text;
  const cursor = field.cursor;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusInfo>(deps.getStatus());
  const [tick, setTick] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [approval, setApproval] = useState<{ requests: ApprovalRequest[]; resolve: (m: Map<string, ApprovalDecision>) => void } | null>(null);
  const [apIdx, setApIdx] = useState(0); // 审批进行到第几项(多个 gated 工具逐项决定)
  const apDecisions = useRef(new Map<string, ApprovalDecision>());
  const [ask, setAsk] = useState<{ question: string; resolve: (s: string) => void } | null>(null);
  const [askInput, setAskInput] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const history = useRef<string[]>([]);
  const histIdx = useRef<number>(-1); // -1 = 不在历史浏览中

  const pushItem = (it: TranscriptItem) => setItems((p) => [...p, it]);

  // spinner / elapsed 计时(仅 busy 时)。
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((x) => x + 1), 90);
    return () => clearInterval(t);
  }, [busy]);

  // 注册审批 / 提问模态,供 index 的 gate 与 ctx.ask 委派。
  useEffect(() => {
    const approvalPrompt: ApprovalPrompt = (requests) =>
      new Promise((resolve) => {
        apDecisions.current = new Map();
        setApIdx(0);
        setApproval({ requests, resolve });
      });
    const askUser = (question: string) => new Promise<string>((resolve) => setAsk({ question, resolve }));
    deps.register({ approvalPrompt, askUser });
  }, [deps]);

  function makeEvents(): TurnEvents {
    return {
      reasoning: (chunk) => setLive((l) => (l ? { ...l, reasoning: l.reasoning + chunk } : l)),
      content: (chunk) => setLive((l) => (l ? { ...l, content: l.content + chunk } : l)),
      toolStart: (call) =>
        setLive((l) =>
          l ? { ...l, tools: [...l.tools, call.name], toolCount: l.toolCount + 1, lastActivity: toolVerb(call.name) } : l,
        ),
      toolResult: (call, msg) => {
        const ok = !msg.content.startsWith("Error") && !msg.content.includes("拒绝");
        const name = call.function.name;
        let pushed = false;
        if (ok && name === "edit_file") {
          // 仅 edit 保留红绿 diff(唯一值得看的富展示);write 等改为轻量意图行。
          try {
            const a = JSON.parse(call.function.arguments) as { path?: string; old_string?: string; new_string?: string };
            const path = String(a.path ?? "");
            pushItem({ id: nextId(), kind: "diff", path, removed: toLines(String(a.old_string ?? "")), added: toLines(String(a.new_string ?? "")), lang: langFromPath(path) });
            pushed = true;
          } catch {
            /* 参数非 JSON,退回轻量工具行 */
          }
        }
        if (!pushed) {
          pushItem({ id: nextId(), kind: "tool", label: activityLabel(name, call.function.arguments), detail: resultDetail(name, ok, msg.content), ok });
        }
        setLive((l) => (l ? { ...l, tools: l.tools.filter((n) => n !== name) } : l));
      },
      assistantDone: (msg) => {
        if (typeof msg.content === "string" && msg.content.trim()) {
          pushItem({ id: nextId(), kind: "assistant", text: msg.content });
        }
        setLive((l) => (l ? { ...l, reasoning: "", content: "" } : l));
        setStatus(deps.getStatus());
      },
      notice: (text) => {
        const t = text.trim();
        if (t) pushItem({ id: nextId(), kind: "notice", text: t });
      },
    };
  }

  async function onSubmit(raw: string) {
    const text = raw.trim();
    setField({ text: "", cursor: 0 });
    if (!text) return;
    history.current.push(text);
    histIdx.current = -1;
    if (text.startsWith("/")) {
      const name = text.slice(1).split(/\s+/)[0];
      if (name === "theme") {
        const next = bg === "dark" ? "light" : "dark";
        setBg(next);
        pushItem({ id: nextId(), kind: "notice", text: `已切换主题:${next === "light" ? "浅色" : "深色"}` });
        return;
      }
      const res = deps.runCommand(text);
      if (res.exit) { exit(); return; }
      if (res.compact) { await deps.compact(); pushItem({ id: nextId(), kind: "notice", text: "已压缩对话" }); setStatus(deps.getStatus()); return; }
      if (name === "clear") setItems([{ id: 0, kind: "welcome" }]);
      if (res.output) pushItem({ id: nextId(), kind: "notice", text: res.output });
      setStatus(deps.getStatus());
      return;
    }
    pushItem({ id: nextId(), kind: "user", text });
    setBusy(true);
    setStartedAt(Date.now());
    setLive({ reasoning: "", content: "", tools: [], toolCount: 0, lastActivity: "" });
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await deps.submit(text, { events: makeEvents(), signal: controller.signal });
    } catch (e) {
      pushItem({ id: nextId(), kind: "notice", text: "出错:" + (e as Error).message });
    } finally {
      setBusy(false);
      setLive(null);
      setStatus(deps.getStatus());
      controllerRef.current = null;
    }
  }

  useInput((ch, key) => {
    if (approval) {
      const d: ApprovalDecision | null =
        ch === "y" ? "once" : ch === "a" ? "always" : ch === "n" ? "deny" : null;
      if (d) {
        const req = approval.requests[apIdx];
        if (req) apDecisions.current.set(req.id, d);
        if (apIdx + 1 < approval.requests.length) {
          setApIdx(apIdx + 1); // 还有下一项,继续逐个决定
        } else {
          approval.resolve(new Map(apDecisions.current));
          setApproval(null);
        }
      }
      return;
    }
    if (ask) {
      if (key.return) { ask.resolve(askInput); setAsk(null); setAskInput(""); }
      else if (key.backspace || key.delete) setAskInput((s) => s.slice(0, -1));
      else if (ch && !key.ctrl && !key.meta) setAskInput((s) => s + ch);
      return;
    }
    if (key.escape && busy) { controllerRef.current?.abort(); return; }
    if (key.ctrl && ch === "c") { exit(); return; }
    if (busy) return;
    const recall = (v: string) => setField({ text: v, cursor: v.length });
    if (key.upArrow) {
      const h = history.current;
      if (h.length) {
        histIdx.current = histIdx.current < 0 ? h.length - 1 : Math.max(0, histIdx.current - 1);
        recall(h[histIdx.current] ?? "");
      }
      return;
    }
    if (key.downArrow) {
      const h = history.current;
      if (histIdx.current >= 0) {
        histIdx.current++;
        if (histIdx.current >= h.length) { histIdx.current = -1; recall(""); }
        else recall(h[histIdx.current] ?? "");
      }
      return;
    }
    if (key.return) { void onSubmit(input); return; }
    if (key.leftArrow) { setField((f) => ({ ...f, cursor: Math.max(0, f.cursor - 1) })); return; }
    if (key.rightArrow) { setField((f) => ({ ...f, cursor: Math.min(f.text.length, f.cursor + 1) })); return; }
    if (key.ctrl && ch === "a") { setField((f) => ({ ...f, cursor: 0 })); return; } // 行首
    if (key.ctrl && ch === "e") { setField((f) => ({ ...f, cursor: f.text.length })); return; } // 行尾
    if (key.ctrl && ch === "w") { // 删前一个词
      setField((f) => {
        const m = f.text.slice(0, f.cursor).match(/\s*\S+\s*$/);
        const cut = m ? m[0].length : f.cursor;
        return { text: f.text.slice(0, f.cursor - cut) + f.text.slice(f.cursor), cursor: f.cursor - cut };
      });
      return;
    }
    if (key.backspace) { // 删光标前一字符
      setField((f) => (f.cursor > 0 ? { text: f.text.slice(0, f.cursor - 1) + f.text.slice(f.cursor), cursor: f.cursor - 1 } : f));
      return;
    }
    if (key.delete) { setField((f) => ({ ...f, text: f.text.slice(0, f.cursor) + f.text.slice(f.cursor + 1) })); return; } // 删光标处
    if (key.tab) { // @文件补全:把光标前的 @前缀 补成第一个匹配
      setField((f) => {
        const m = f.text.slice(0, f.cursor).match(/@(\S*)$/);
        const matches = m && deps.completeFiles ? deps.completeFiles(m[1] ?? "") : [];
        if (!m || !matches.length) return f;
        const atStart = f.cursor - m[0].length;
        const completion = "@" + matches[0] + " ";
        return { text: f.text.slice(0, atStart) + completion + f.text.slice(f.cursor), cursor: atStart + completion.length };
      });
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      setField((f) => ({ text: f.text.slice(0, f.cursor) + ch + f.text.slice(f.cursor), cursor: f.cursor + ch.length }));
    }
  });

  // 粘贴:bracketed paste 下整段作一个字符串进来(不经 useInput),原样追加进输入框、不自动提交。
  usePaste((text) => {
    if (approval) return;
    if (ask) { setAskInput((s) => s + text); return; }
    if (busy) return;
    setField((f) => ({ text: f.text.slice(0, f.cursor) + text + f.text.slice(f.cursor), cursor: f.cursor + text.length }));
  });

  const elapsed = busy ? ((Date.now() - startedAt) / 1000).toFixed(1) : "0.0";
  const spin = SPINNER[tick % SPINNER.length] ?? "⠋";

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item, index) =>
          item.kind === "welcome" ? (
            <Welcome key={item.id} info={deps.welcome.info} caps={deps.welcome.caps} bg={bg} maxim={deps.welcome.maxim} />
          ) : (
            <Row key={item.id} item={item} c={c} tight={isToolish(item) && isToolish(items[index - 1])} />
          )
        }
      </Static>

      {live && (
        <Box flexDirection="column" marginTop={1}>
          {live.reasoning && !live.content ? (
            <Text color={c("dim")}>{spin} 悟… {live.reasoning.split("\n").pop()?.slice(0, 80)}</Text>
          ) : null}
          {live.content ? <Text>{tail(live.content, MAX_LIVE_LINES)}</Text> : null}
          {/* 进度可见性:当前活动 + 已用工具数 + 耗时(始终一行,长任务也看得见在干嘛)。 */}
          <Text color={c("dim")}>
            {spin} {live.lastActivity || (live.content ? "生成回答" : "思考中")}…{" "}
            ({elapsed}s{live.toolCount > 0 ? ` · ${live.toolCount} 次工具` : ""} · Esc 打断)
          </Text>
        </Box>
      )}

      {approval && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={c("vermilion")} paddingX={1}>
          <Text color={c("vermilion")}>
            需要批准{approval.requests.length > 1 ? ` (${apIdx + 1}/${approval.requests.length})` : ""}:
          </Text>
          <Text color={c("ink")}>  {approval.requests[apIdx]?.summary.slice(0, 120)}</Text>
          <Text color={c("dim")}>[y]本次 [a]本仓库该类后续都用 [n]拒绝</Text>
        </Box>
      )}

      {ask && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={c("jade")} paddingX={1}>
          <Text color={c("jade")}>{ask.question}</Text>
          <Text color={c("ink")}>› {askInput}<Text color={c("jade")}>▎</Text></Text>
        </Box>
      )}

      {!busy && !approval && !ask && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={c("jade")}>› </Text>
            {input.slice(0, cursor)}
            <Text color={c("jade")}>▎</Text>
            {input.slice(cursor)}
          </Text>
          {input.startsWith("/") && !input.includes(" ") ? (
            <Text color={c("dim")}>
              {"  "}
              {["model", "plan", "theme", "yolo", "clear", "compact", "cost", "help", "exit"]
                .filter((cmd) => ("/" + cmd).startsWith(input))
                .map((cmd) => "/" + cmd)
                .join("  ") || "(无匹配命令)"}
            </Text>
          ) : null}
          {(() => {
            const m = input.slice(0, cursor).match(/@(\S*)$/);
            const matches = m && deps.completeFiles ? deps.completeFiles(m[1] ?? "") : [];
            return matches.length ? (
              <Text color={c("dim")}>{"  "}{matches.slice(0, 6).join("  ")}  <Text color={c("jade")}>(Tab 补全)</Text></Text>
            ) : null;
          })()}
        </Box>
      )}

      <StatusBar status={status} busy={busy} elapsed={elapsed} spin={spin} c={c} />
    </Box>
  );
}

function Row({ item, c, tight }: { item: TranscriptItem; c: (s: Parameters<typeof semHex>[0]) => string; tight?: boolean }) {
  if (item.kind === "user") {
    return (
      <Box marginTop={1}>
        <Text color={c("jade")}>› </Text>
        <Text color={c("ink")}>{item.text}</Text>
      </Box>
    );
  }
  if (item.kind === "assistant") {
    return (
      <Box marginTop={1}>
        <Text>{renderMarkdown(item.text)}</Text>
      </Box>
    );
  }
  if (item.kind === "tool") {
    // 轻量:一行意图 + 灰色一行小结(报错标红);连续工具紧凑(tight→无行间空隙)。
    return (
      <Box marginTop={tight ? 0 : 1}>
        <Text color={item.ok ? c("jade") : c("vermilion")}>● </Text>
        <Text color={c("ink")}>{item.label}</Text>
        {item.detail ? <Text color={item.ok ? c("dim") : c("vermilion")}>  {item.detail}</Text> : null}
      </Box>
    );
  }
  if (item.kind === "diff") {
    const cap = 40;
    const rows: Array<["-" | "+", string]> = [
      ...item.removed.map((l) => ["-", l] as ["-" | "+", string]),
      ...item.added.map((l) => ["+", l] as ["-" | "+", string]),
    ];
    const shown = rows.slice(0, cap);
    return (
      <Box flexDirection="column" marginTop={tight ? 0 : 1}>
        <Text color={c("jade")}>
          ● 编辑 {item.path} <Text color={c("dim")}>(-{item.removed.length} +{item.added.length})</Text>
        </Text>
        {shown.map(([sign, l], i) => (
          <Text key={i} color={sign === "+" ? c("jade") : c("vermilion")}>
            {"  "}{sign} {l}
          </Text>
        ))}
        {rows.length > cap ? <Text color={c("dim")}>{"  "}… +{rows.length - cap} 行</Text> : null}
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <Text color={c("dim")}>{item.text}</Text>
    </Box>
  );
}

function StatusBar({
  status,
  busy,
  elapsed,
  spin,
  c,
}: {
  status: StatusInfo;
  busy: boolean;
  elapsed: string;
  spin: string;
  c: (s: Parameters<typeof semHex>[0]) => string;
}) {
  const pct = (status.cacheHitRatio * 100).toFixed(0);
  const fmt = (n: number) => (n < 1000 ? String(n) : (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k");
  return (
    <Box marginTop={1}>
      <Text color={c("dim")}>
        {busy ? `${spin} ${elapsed}s · ` : ""}
        {status.longTask ? <Text color={c("gold")}>🪢长任务 · </Text> : ""}
        {status.yolo ? <Text color={c("vermilion")}>⚡YOLO · </Text> : ""}
        {status.mode} · {status.model} · 输入 {fmt(status.promptTokens)} · 输出 {fmt(status.completionTokens)} · 缓存命中 {pct}% · 上下文 {status.contextPct < 1 ? "<1" : Math.round(status.contextPct)}%
        {status.branch ? ` · ⎇ ${status.branch}` : ""}
      </Text>
    </Box>
  );
}

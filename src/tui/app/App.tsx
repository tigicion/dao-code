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

// 工具结果展示预览:中间截断(保头+保尾,报错常在尾),标注省略行数。
function preview(s: string, lines = 8): string {
  const all = s.split("\n");
  if (all.length <= lines) return s.trimEnd();
  const head = Math.ceil(lines / 2);
  const tailN = lines - head;
  return [...all.slice(0, head), `… (省略 ${all.length - lines} 行) …`, ...all.slice(all.length - tailN)].join("\n");
}

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

export function App(deps: AppDeps) {
  const { exit } = useApp();
  const [bg, setBg] = useState(deps.welcome.bg); // /theme 运行时可切浅/深
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);

  const idRef = useRef(1);
  const nextId = () => idRef.current++;
  const [items, setItems] = useState<({ id: number; kind: "welcome" } | TranscriptItem)[]>([
    { id: 0, kind: "welcome" },
  ]);
  const [live, setLive] = useState<LiveState | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusInfo>(deps.getStatus());
  const [tick, setTick] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [approval, setApproval] = useState<{ requests: ApprovalRequest[]; resolve: (m: Map<string, ApprovalDecision>) => void } | null>(null);
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
      new Promise((resolve) => setApproval({ requests, resolve }));
    const askUser = (question: string) => new Promise<string>((resolve) => setAsk({ question, resolve }));
    deps.register({ approvalPrompt, askUser });
  }, [deps]);

  function makeEvents(): TurnEvents {
    return {
      reasoning: (chunk) => setLive((l) => (l ? { ...l, reasoning: l.reasoning + chunk } : l)),
      content: (chunk) => setLive((l) => (l ? { ...l, content: l.content + chunk } : l)),
      toolStart: (call) => setLive((l) => (l ? { ...l, tools: [...l.tools, call.name] } : l)),
      toolResult: (call, msg) => {
        const ok = !msg.content.startsWith("Error") && !msg.content.includes("拒绝");
        const name = call.function.name;
        let pushed = false;
        if (ok && (name === "edit_file" || name === "write_file")) {
          try {
            const a = JSON.parse(call.function.arguments) as { path?: string; old_string?: string; new_string?: string; content?: string };
            const path = String(a.path ?? "");
            const removed = name === "edit_file" ? toLines(String(a.old_string ?? "")) : [];
            const added = toLines(String(name === "edit_file" ? a.new_string ?? "" : a.content ?? ""));
            pushItem({ id: nextId(), kind: "diff", path, removed, added, lang: langFromPath(path) });
            pushed = true;
          } catch {
            /* 参数非 JSON,退回普通工具卡片 */
          }
        }
        if (!pushed) pushItem({ id: nextId(), kind: "tool", name, preview: preview(msg.content), ok });
        setLive((l) => (l ? { ...l, tools: l.tools.filter((n) => n !== name) } : l));
      },
      assistantDone: (msg) => {
        if (typeof msg.content === "string" && msg.content.trim()) {
          pushItem({ id: nextId(), kind: "assistant", text: msg.content });
        }
        setLive((l) => (l ? { reasoning: "", content: "", tools: l.tools } : l));
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
    setInput("");
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
    setLive({ reasoning: "", content: "", tools: [] });
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
        approval.resolve(new Map(approval.requests.map((r) => [r.id, d])));
        setApproval(null);
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
    if (key.upArrow) {
      const h = history.current;
      if (h.length) {
        histIdx.current = histIdx.current < 0 ? h.length - 1 : Math.max(0, histIdx.current - 1);
        setInput(h[histIdx.current] ?? "");
      }
      return;
    }
    if (key.downArrow) {
      const h = history.current;
      if (histIdx.current >= 0) {
        histIdx.current++;
        if (histIdx.current >= h.length) { histIdx.current = -1; setInput(""); }
        else setInput(h[histIdx.current] ?? "");
      }
      return;
    }
    if (key.return) { void onSubmit(input); return; }
    if (key.backspace || key.delete) { setInput((s) => s.slice(0, -1)); return; }
    if (ch && !key.ctrl && !key.meta) setInput((s) => s + ch);
  });

  // 粘贴:bracketed paste 下整段作一个字符串进来(不经 useInput),原样追加进输入框、不自动提交。
  usePaste((text) => {
    if (approval) return;
    if (ask) { setAskInput((s) => s + text); return; }
    if (busy) return;
    setInput((s) => s + text);
  });

  const elapsed = busy ? ((Date.now() - startedAt) / 1000).toFixed(1) : "0.0";
  const spin = SPINNER[tick % SPINNER.length] ?? "⠋";

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) =>
          item.kind === "welcome" ? (
            <Welcome key={item.id} info={deps.welcome.info} caps={deps.welcome.caps} bg={bg} maxim={deps.welcome.maxim} />
          ) : (
            <Row key={item.id} item={item} c={c} />
          )
        }
      </Static>

      {live && (
        <Box flexDirection="column" marginTop={1}>
          {live.reasoning ? (
            <Text color={c("dim")}>{spin} 悟… {live.reasoning.split("\n").pop()?.slice(0, 80)}</Text>
          ) : null}
          {live.content ? <Text>{tail(live.content, MAX_LIVE_LINES)}</Text> : null}
          {live.tools.map((t, i) => (
            <Text key={i} color={c("jade")}>● {t}</Text>
          ))}
          {!live.content && !live.reasoning && live.tools.length === 0 ? (
            <Text color={c("dim")}>{spin} 思考中… <Text color={c("dim")}>({elapsed}s · Esc 打断)</Text></Text>
          ) : null}
        </Box>
      )}

      {approval && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={c("vermilion")} paddingX={1}>
          <Text color={c("vermilion")}>需要批准:</Text>
          {approval.requests.map((r) => (
            <Text key={r.id} color={c("ink")}>  {r.summary.slice(0, 100)}</Text>
          ))}
          <Text color={c("dim")}>[y]本次 [a]本仓库后续都用 [n]拒绝</Text>
        </Box>
      )}

      {ask && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={c("jade")} paddingX={1}>
          <Text color={c("jade")}>{ask.question}</Text>
          <Text color={c("ink")}>› {askInput}<Text color={c("jade")}>▎</Text></Text>
        </Box>
      )}

      {!busy && !approval && !ask && (
        <Box marginTop={1}>
          <Text color={c("jade")}>› </Text>
          <Text>{input}</Text>
          <Text color={c("jade")}>▎</Text>
        </Box>
      )}

      <StatusBar status={status} busy={busy} elapsed={elapsed} spin={spin} c={c} />
    </Box>
  );
}

function Row({ item, c }: { item: TranscriptItem; c: (s: Parameters<typeof semHex>[0]) => string }) {
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
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={item.ok ? c("jade") : c("vermilion")}>● {item.name}</Text>
        <Text color={c("dim")}>
          {item.preview.split("\n").map((l, i) => (i === 0 ? "  ⎿ " : "    ") + l).join("\n")}
        </Text>
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
      <Box flexDirection="column" marginTop={1}>
        <Text color={c("jade")}>
          ● {item.path} <Text color={c("dim")}>(-{item.removed.length} +{item.added.length})</Text>
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
        {status.yolo ? <Text color={c("vermilion")}>⚡YOLO · </Text> : ""}
        {status.mode} · {status.model} · 输入 {fmt(status.promptTokens)} · 输出 {fmt(status.completionTokens)} · 缓存命中 {pct}% · 上下文 {status.contextPct < 1 ? "<1" : Math.round(status.contextPct)}%
        {status.branch ? ` · ⎇ ${status.branch}` : ""}
      </Text>
    </Box>
  );
}

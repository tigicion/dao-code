import React, { useEffect, useRef, useState } from "react";
import { Box, Text, Static, useApp, useInput, usePaste } from "ink";
import { highlight } from "cli-highlight";
import { renderMarkdown } from "../markdown.js";
import { semHex } from "../theme.js";
import { Welcome } from "../Welcome.js";
import { TIPS } from "../tips.js";
import { daoVerb, DAO_VERBS } from "../spinner_words.js";
import { clampLines, parseTodoResult } from "./format.js";
import type { TurnEvents } from "../render.js";
import type { ApprovalDecision, ApprovalPrompt, ApprovalRequest } from "../../approval/types.js";
import type { AppDeps, LiveState, StatusInfo, TranscriptItem } from "./types.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// 权限模式的中文友好名(Shift+Tab 提示与状态栏共用),避免直接暴露内部枚举名。
const MODE_LABEL: Record<string, string> = {
  default: "默认(写/执行前询问)",
  acceptEdits: "✎ 自动接受编辑",
  auto: "⊙ 智能判定(AI 评估风险)",
  plan: "◇ 规划(只读)",
  bypassPermissions: "※ 全部权限(免审批)",
};
const modeLabel = (m: string): string => MODE_LABEL[m] ?? m;
const MAX_LIVE_LINES = 24; // 流式动态区显示尾部行数;完成后整段进 <Static>。比旧值大,流式更完整(仍小于常见终端高,避免 ink#359 整屏闪)。
const TOOL_OUT_CAP = 8; // 工具结果 ⎿ 子块默认最多显示几行(ctrl+o / --verbose 全显)
const REASONING_CAP = 6; // 思考块默认最多显示几行(ctrl+o / --verbose 全显)
// 这些工具的结果正文值得在 ⎿ 子块里展示(对标 CC:Bash/Grep 显输出,Read 只显计数)。
const ECHO_OUTPUT = new Set(["exec_shell", "exec_shell_poll", "grep_files", "web_search", "fetch_url"]);

// 空闲时底部轮换的轻提示(CC 风格:克制暗色一行,无 emoji)。运行中的"可排队"提示单独硬编码。
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

// 工具动作词(toolStart 时参数尚在流式中,只有名字)——用于 live 进度行。
const VERB: Record<string, string> = {
  read_file: "读取", list_dir: "列目录", grep_files: "搜索", file_search: "查找",
  exec_shell: "执行", exec_shell_poll: "查看输出", exec_shell_kill: "结束进程",
  write_file: "写入", edit_file: "编辑", multi_edit: "多处编辑", notebook_edit: "编辑笔记本", verify_done: "验收", web_search: "网页搜索",
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
    case "multi_edit": return `多处编辑 ${s(a.path)}${Array.isArray(a.edits) ? `(${a.edits.length} 组)` : ""}`;
    case "notebook_edit": return `编辑笔记本 ${s(a.path)} #${typeof a.cell_index === "number" ? a.cell_index : "?"}`;
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
  // 欢迎屏延迟固化:会话开始前留在动态区(随终端 resize 重排),
  // 首个 transcript 项产生时才作为 items[0] 进 <Static>(恢复会话则直接固化)。
  const [items, setItems] = useState<({ id: number; kind: "welcome" } | TranscriptItem)[]>(
    initial.length ? [{ id: 0, kind: "welcome" }, ...initial] : [],
  );
  const welcomeCommitted = useRef(initial.length > 0);
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
  // 审批【队列】:并发的审批请求(如两个并行的外部读)排队逐个显示,避免后者 setApproval 覆盖前者、
  // 丢掉前者 resolve 导致该工具调用永不返回、整回合死锁。
  const approvalQueue = useRef<{ requests: ApprovalRequest[]; resolve: (m: Map<string, ApprovalDecision>) => void }[]>([]);
  const showingApproval = useRef(false);
  const startNextApproval = () => {
    const next = approvalQueue.current.shift();
    if (!next) { showingApproval.current = false; setApproval(null); return; }
    showingApproval.current = true;
    apDecisions.current = new Map();
    setApIdx(0);
    setApproval({ requests: next.requests, resolve: next.resolve });
  };
  const [ask, setAsk] = useState<{ question: string; resolve: (s: string) => void } | null>(null);
  const [askInput, setAskInput] = useState("");
  // Shift+Tab 切权限模式后,在输入框下方短暂提示(不进 transcript scrollback);约 2.5s 后淡出。
  const [modeHint, setModeHint] = useState<string | null>(null);
  const modeHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 结构化选择(ask_user 带 options):单选用 数字/↑↓ + Enter;多选用 checkbox(空格/数字切换 + Enter)。
  // 自动附"其他(自己输入)"(进 askInput 子模式)与"先讨论一下"两项。
  const [choice, setChoice] = useState<{ question: string; options: string[]; multi: boolean; resolve: (s: string) => void } | null>(null);
  const [choiceIdx, setChoiceIdx] = useState(0);
  const [choiceFilling, setChoiceFilling] = useState(false);
  const [choiceChecked, setChoiceChecked] = useState<Set<number>>(new Set()); // 多选已勾选的下标
  const [choiceWarn, setChoiceWarn] = useState(false); // 多选下空集回车 → 提示先勾选,而非静默提交
  const CHOICE_DONE = "✓ 完成(提交所选)"; // 多选专用:回车在此行提交;在正常项上回车=勾选
  const CHOICE_FILL = "其他(自己输入)";
  const CHOICE_DISCUSS = "先讨论一下";
  const controllerRef = useRef<AbortController | null>(null);
  const wordBaseRef = useRef(0); // 本回合 spinner 道家动词的随机起点(daoVerb 据此 + tick 轮换)
  const reasoningRef = useRef(""); // 本次模型响应累积的思考(同步提交,保证"思考在前、答案在后")
  // 大段粘贴折叠:输入框/历史里显示 [粘贴#N +M行] 占位,提交时再展开成全文喂模型——保持界面与上下文清爽。
  const pasteRef = useRef<Map<string, string>>(new Map());
  const pasteSeqRef = useRef(0);
  // 会话内 /loop:定时把 prompt 排进 queued(空闲时自动跑);退出时清理。
  const loopRef = useRef<{ prompt: string; timer: ReturnType<typeof setInterval> } | null>(null);
  useEffect(() => () => { if (loopRef.current) clearInterval(loopRef.current.timer); }, []);
  const expandPastes = (s: string) => {
    let out = s;
    for (const [ph, full] of pasteRef.current) out = out.split(ph).join(full);
    return out;
  };
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const [taskTick, setTaskTick] = useState(0); // 后台任务状态变化计数(驱动通知处理/计数刷新)
  const [bgRunning, setBgRunning] = useState(0);
  const [queued, setQueued] = useState<string[]>([]); // 运行中排队的用户输入(steering)
  const [expanded, setExpanded] = useState(!!deps.verbose); // ctrl+o 展开全量(--verbose 启动时默认开)
  const history = useRef<string[]>([]);
  const histIdx = useRef<number>(-1); // -1 = 不在历史浏览中

  const pushItem = (it: TranscriptItem) =>
    setItems((p) => {
      if (welcomeCommitted.current) return [...p, it];
      welcomeCommitted.current = true;
      return [{ id: 0, kind: "welcome" } as const, ...p, it];
    });

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
        approvalQueue.current.push({ requests, resolve }); // 入队
        if (!showingApproval.current) startNextApproval(); // 空闲则显示队首,否则排队(防并发覆盖死锁)
      });
    const askUser = (question: string) => new Promise<string>((resolve) => setAsk({ question, resolve }));
    const askChoice = (question: string, options: string[], multi?: boolean) =>
      new Promise<string>((resolve) => { setChoice({ question, options, multi: !!multi, resolve }); setChoiceIdx(0); setChoiceFilling(false); setChoiceChecked(new Set()); setChoiceWarn(false); });
    deps.register({ approvalPrompt, askUser, askChoice });
  }, [deps]);

  function makeEvents(): TurnEvents {
    return {
      // 收到推理/正文 = 模型又在思考/生成了:清掉上一个工具的活动标签,
      // 否则 live 行会一直显示陈旧的"搜索…"(工具早结束、其实在生成),误导成"卡在搜索"。
      reasoning: (chunk) => { reasoningRef.current += chunk; setLive((l) => (l ? { ...l, reasoning: l.reasoning + chunk, lastActivity: "" } : l)); },
      content: (chunk) => setLive((l) => (l ? { ...l, content: l.content + chunk, lastActivity: "" } : l)),
      toolStart: (call) =>
        setLive((l) =>
          l ? { ...l, tools: [...l.tools, call.name], toolCount: l.toolCount + 1, lastActivity: toolVerb(call.name) } : l,
        ),
      toolResult: (call, msg) => {
        const ok = !msg.content.startsWith("Error") && !msg.content.includes("拒绝");
        const name = call.function.name;
        let pushed = false;
        if (ok && name === "edit_file") {
          // edit:红绿 diff(行号来自工具结果"行 N",高亮在 Row 渲染)。
          try {
            const a = JSON.parse(call.function.arguments) as { path?: string; old_string?: string; new_string?: string };
            const path = String(a.path ?? "");
            const lm = /行\s*(\d+)/.exec(msg.content);
            // 工具结果里的 ```diff 块(带行号+上下文)→ 直接渲染;无则退回 old/new 构造。
            const dm = /```diff\n([\s\S]*?)\n```/.exec(msg.content);
            const rows = dm ? dm[1]!.split("\n") : undefined;
            pushItem({ id: nextId(), kind: "diff", path, removed: toLines(String(a.old_string ?? "")), added: toLines(String(a.new_string ?? "")), lang: langFromPath(path), startLine: lm ? Number(lm[1]) : undefined, rows });
            pushed = true;
          } catch { /* 参数非 JSON,退回轻量工具行 */ }
        }
        if (!pushed && ok && name === "todo_write") {
          // todo:渲染成复选框清单(对标 CC),就地体现进度。
          pushItem({ id: nextId(), kind: "todo", items: parseTodoResult(msg.content) });
          pushed = true;
        }
        if (!pushed) {
          // 始终存全量 output/rawArgs(供 ctrl+o 展开);echo 标记默认是否显示输出(Bash/grep 等显,Read 只显计数)。
          const output = msg.content.trim() ? msg.content.split("\n") : undefined;
          pushItem({
            id: nextId(), kind: "tool",
            label: activityLabel(name, call.function.arguments),
            detail: resultDetail(name, ok, msg.content), ok, output,
            echo: ECHO_OUTPUT.has(name),
            rawArgs: call.function.arguments,
          });
        }
        setLive((l) => (l ? { ...l, tools: l.tools.filter((n) => n !== name) } : l));
      },
      assistantDone: (msg) => {
        // 顺序保证:先提交思考(暗色 ✻ 块),再提交答案——两次 pushItem 同步执行,
        // 不能放进 setLive 更新器里(会被延迟到 assistant 之后,导致"思考跑到答案后面")。
        if (reasoningRef.current.trim()) pushItem({ id: nextId(), kind: "reasoning", text: reasoningRef.current });
        if (typeof msg.content === "string" && msg.content.trim()) {
          pushItem({ id: nextId(), kind: "assistant", text: msg.content });
        }
        reasoningRef.current = "";
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
    const text = raw.trim(); // 展示用(可能含 [粘贴#N] 占位)
    const full = expandPastes(text); // 喂模型/命令用(占位展开成全文)
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
      if (name === "loop") {
        const parts = full.trim().split(/\s+/);
        const arg = parts[1];
        if (!arg || arg === "off") {
          if (loopRef.current) { clearInterval(loopRef.current.timer); loopRef.current = null; pushItem({ id: nextId(), kind: "notice", text: "已停止循环。" }); }
          else pushItem({ id: nextId(), kind: "notice", text: "用法:/loop <间隔如 30s/5m/1h> <要周期跑的 prompt>;/loop off 停止" });
          return;
        }
        const m = /^(\d+)(s|m|h)$/.exec(arg);
        const loopPrompt = parts.slice(2).join(" ").trim();
        if (!m || !loopPrompt) { pushItem({ id: nextId(), kind: "notice", text: "用法:/loop <间隔如 30s/5m/1h> <prompt>" }); return; }
        const ms = Number(m[1]) * (m[2] === "h" ? 3600000 : m[2] === "m" ? 60000 : 1000);
        if (loopRef.current) clearInterval(loopRef.current.timer);
        // 到点把 prompt 排队(去重:同一 prompt 未消费完不重复排),空闲时自动跑。
        const timer = setInterval(() => setQueued((q) => (q.includes(loopPrompt) ? q : [...q, loopPrompt])), ms);
        loopRef.current = { prompt: loopPrompt, timer };
        pushItem({ id: nextId(), kind: "notice", text: `已开启循环:每 ${arg} 跑一次「${loopPrompt.slice(0, 40)}」(/loop off 停止)` });
        return;
      }
      const res = deps.runCommand(full);
      if (res.exit) { exit(); return; }
      if (res.compact) { await deps.compact(); pushItem({ id: nextId(), kind: "notice", text: "已压缩对话" }); setStatus(deps.getStatus()); return; }
      if (name === "clear" || res.clearTranscript) setItems(welcomeCommitted.current ? [{ id: 0, kind: "welcome" }] : []); // /clear /rewind /resume:重置可视 transcript
      if (res.output) pushItem({ id: nextId(), kind: "notice", text: res.output });
      // 自定义命令:展开成 prompt → 当作一个回合跑。
      if (res.prompt) {
        pushItem({ id: nextId(), kind: "user", text });
        await runAgentTurn(res.prompt);
        return;
      }
      setStatus(deps.getStatus());
      return;
    }
    pushItem({ id: nextId(), kind: "user", text });
    await runAgentTurn(full);
  }

  // 跑一个回合(用户输入 / 后台任务通知共用):管理 busy/live/中断/出错。
  async function runAgentTurn(text: string) {
    setBusy(true);
    setStartedAt(Date.now());
    wordBaseRef.current = Math.floor(Math.random() * DAO_VERBS.length); // 每回合换一个道家动词起点
    reasoningRef.current = "";
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

  // 后台任务完成 → 空闲时把 <task-notification> 作为新回合自动喂给模型继续处理。
  const procRef = useRef(false);
  async function processNotifications() {
    if (procRef.current || busyRef.current) return;
    // 优先处理排队的用户输入(steering),再处理后台任务通知。
    if (queued.length > 0) {
      const next = queued[0]!;
      procRef.current = true;
      try {
        setQueued((q) => q.slice(1));
        pushItem({ id: nextId(), kind: "user", text: next });
        await runAgentTurn(next);
      } finally {
        procRef.current = false;
      }
      return;
    }
    const notes = deps.drainNotifications?.() ?? [];
    if (notes.length === 0) return;
    procRef.current = true;
    try {
      pushItem({ id: nextId(), kind: "notice", text: `↩ 收到 ${notes.length} 个后台任务结果,继续处理…` });
      await runAgentTurn(notes.join("\n\n"));
    } finally {
      procRef.current = false;
    }
  }

  // 订阅后台任务变化:bump taskTick(驱动下面的 effect)。
  useEffect(() => {
    deps.subscribeTasks?.(() => setTaskTick((t) => t + 1));
  }, []);
  // 任务变化或回合结束时:刷新运行计数;空闲则处理待注入的通知(自动续跑)。
  useEffect(() => {
    setBgRunning(deps.runningTasks?.() ?? 0);
    if (!busy) void processNotifications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, taskTick, queued]);

  useInput((ch, key) => {
    if (approval) {
      const reqAp = approval.requests[apIdx];
      const noAlways = !!reqAp?.sensitive || !!reqAp?.noPersist; // 敏感 / 记不成规则 → 不接受"始终允许"
      const d: ApprovalDecision | null =
        ch === "y" ? "once" : ch === "a" ? (noAlways ? null : "always") : ch === "n" ? "deny" : null;
      if (d) {
        const req = approval.requests[apIdx];
        if (req) apDecisions.current.set(req.id, d);
        if (apIdx + 1 < approval.requests.length) {
          setApIdx(apIdx + 1); // 还有下一项,继续逐个决定
        } else {
          approval.resolve(new Map(apDecisions.current));
          startNextApproval(); // 解决当前 → 显示队列中的下一个(若有),否则关闭
        }
      }
      return;
    }
    if (choice) {
      const nOpt = choice.options.length;
      // 多选多出一行"✓ 完成"用于提交;正常项上回车=勾选,故需要独立的提交入口。
      const extras = choice.multi ? [CHOICE_DONE, CHOICE_FILL, CHOICE_DISCUSS] : [CHOICE_FILL, CHOICE_DISCUSS];
      const allOpts = [...choice.options, ...extras];
      const doneRowIdx = choice.multi ? nOpt : -1;
      const fillIdx = nOpt + (choice.multi ? 1 : 0);
      const discussIdx = nOpt + (choice.multi ? 2 : 1);
      const done = (val: string) => { choice.resolve(val); setChoice(null); setChoiceFilling(false); setAskInput(""); setChoiceChecked(new Set()); setChoiceWarn(false); };
      const toggle = (i: number) => { setChoiceWarn(false); setChoiceChecked((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); };
      const submitMulti = () => { // 提交已勾选;空集不静默提交,提示先勾选(避免误触丢问题)
        const picked = [...choiceChecked].sort((a, b) => a - b).map((i) => choice.options[i]!);
        if (!picked.length) { setChoiceWarn(true); return; }
        done(picked.join(", "));
      };
      if (choiceFilling) { // "其他(自己输入)"子模式:用户敲自由文本
        if (key.return) {
          const custom = askInput.trim();
          if (choice.multi) { // 多选:自填项并入已勾选的正常项
            const picked = [...choiceChecked].sort((a, b) => a - b).map((i) => choice.options[i]!);
            if (custom) picked.push(custom);
            done(picked.length ? picked.join(", ") : "(用户未选)");
          } else done(custom || "(空)");
        } else if (key.backspace || key.delete) setAskInput((s) => s.slice(0, -1));
        else if (ch && !key.ctrl && !key.meta) setAskInput((s) => s + ch);
        return;
      }
      // 数字键:跳到该项。单选直接触发;多选切换勾选(仅正常项)。
      if (ch && /[1-9]/.test(ch)) {
        const i = Number(ch) - 1;
        if (i < allOpts.length) {
          if (choice.multi && i < nOpt) { setChoiceIdx(i); toggle(i); }
          else if (!choice.multi) {
            if (i < nOpt) done(choice.options[i]!);
            else if (i === fillIdx) { setChoiceIdx(i); setChoiceFilling(true); setAskInput(""); }
            else done("我想先讨论一下,先别急着定方向。");
          } else setChoiceIdx(i);
        }
        return;
      }
      if (key.upArrow) { setChoiceIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setChoiceIdx((i) => Math.min(allOpts.length - 1, i + 1)); return; }
      // 空格(多选):切换当前正常项的勾选。
      if (choice.multi && ch === " ") {
        if (choiceIdx < nOpt) toggle(choiceIdx);
        return;
      }
      if (key.return) {
        if (choiceIdx === fillIdx) { setChoiceFilling(true); setAskInput(""); }
        else if (choiceIdx === discussIdx) done("我想先讨论一下,先别急着定方向。");
        else if (choiceIdx === doneRowIdx) submitMulti();      // 多选:在"完成"行回车 → 提交
        else if (choice.multi) toggle(choiceIdx);               // 多选:在正常项回车 → 勾选(不结束,可继续选)
        else done(choice.options[choiceIdx]!);                  // 单选:回车即选中
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
    // Shift+Tab:循环权限模式(default→auto→plan),随时可用。acceptEdits/bypass 不在循环里。
    if (key.tab && key.shift && deps.cycleMode) {
      const m = deps.cycleMode();
      setStatus(deps.getStatus());
      // 在输入框下方短暂提示(不进 scrollback);2.5s 后淡出。
      setModeHint(modeLabel(m));
      if (modeHintTimer.current) clearTimeout(modeHintTimer.current);
      modeHintTimer.current = setTimeout(() => setModeHint(null), 2500);
      return;
    }
    // Ctrl+O:展开/折叠全量输出(对标 CC)。已打印进 scrollback 的无法原地改,
    // 故开启时把"最近一条可展开项"的完整内容追加显示,后续输出按展开态渲染。
    if (key.ctrl && ch === "o") {
      const next = !expanded;
      if (next) {
        const full = lastExpandableFull(items);
        if (full) pushItem({ id: nextId(), kind: "notice", text: full });
      }
      setExpanded(next);
      pushItem({ id: nextId(), kind: "notice", text: next ? "▽ 已展开:后续输出显示全量(ctrl+o 收起)" : "△ 已折叠:后续输出截断" });
      return;
    }
    if (busy) {
      // 运行中:支持排队输入(steering)。回车排队,当前回合结束后按序处理。
      if (key.return) {
        const v = field.text.trim();
        if (v) { setQueued((q) => [...q, expandPastes(v)]); pushItem({ id: nextId(), kind: "notice", text: `⏎ 已排队:${v.slice(0, 50)}` }); }
        setField({ text: "", cursor: 0 });
        return;
      }
      if (key.backspace || key.delete) {
        setField((f) => (f.cursor > 0 ? { text: f.text.slice(0, f.cursor - 1) + f.text.slice(f.cursor), cursor: f.cursor - 1 } : f));
        return;
      }
      if (ch && !key.ctrl && !key.meta) {
        setField((f) => ({ text: f.text.slice(0, f.cursor) + ch + f.text.slice(f.cursor), cursor: f.cursor + ch.length }));
      }
      return;
    }
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
    if (key.ctrl && ch === "u") { setField((f) => ({ text: f.text.slice(f.cursor), cursor: 0 })); return; } // 删到行首
    if (key.ctrl && ch === "k") { setField((f) => ({ ...f, text: f.text.slice(0, f.cursor) })); return; } // 删到行尾
    if (key.ctrl && ch === "d") { if (field.text === "") { exit(); } return; } // 空行 Ctrl-D 退出
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
    if (choice) { if (choiceFilling) setAskInput((s) => s + text); return; }
    if (ask) { setAskInput((s) => s + text); return; }
    // 大段粘贴(>280 字符或 >6 行)折叠成占位符,全文存 pasteRef,提交时展开;小段照常内联。
    let ins = text;
    if (text.length > 280 || text.split("\n").length > 6) {
      const id = ++pasteSeqRef.current;
      ins = `[粘贴#${id} +${text.split("\n").length}行]`;
      pasteRef.current.set(ins, text);
    }
    // 运行中也允许粘贴(可随后回车排队 steering)。
    setField((f) => ({ text: f.text.slice(0, f.cursor) + ins + f.text.slice(f.cursor), cursor: f.cursor + ins.length }));
  });

  const elapsed = busy ? ((Date.now() - startedAt) / 1000).toFixed(1) : "0.0";
  const spin = SPINNER[tick % SPINNER.length] ?? "⠋";
  // 思考/做事 spinner 词:本回合随机起点 + 随时间缓慢轮换(约 1.8s 换一个)。
  const verb = daoVerb(wordBaseRef.current + Math.floor(tick / 20));

  return (
    <Box flexDirection="column">
      {/* 会话开始前:欢迎屏在动态区,随终端 resize 实时重排(useTermWidth 订阅)。 */}
      {items.length === 0 ? (
        <Welcome info={deps.welcome.info} caps={deps.welcome.caps} bg={bg} maxim={deps.welcome.maxim} />
      ) : null}
      <Static items={items}>
        {(item, index) =>
          item.kind === "welcome" ? (
            <Welcome key={item.id} info={deps.welcome.info} caps={deps.welcome.caps} bg={bg} maxim={deps.welcome.maxim} />
          ) : (
            <Row key={item.id} item={item} c={c} expanded={expanded} />
          )
        }
      </Static>

      {live && (
        <Box flexDirection="column" marginTop={1}>
          {/* 推理预览:只显示思考文本(spinner/动词/耗时统一放下方状态行,避免重复)。 */}
          {live.reasoning && !live.content ? (
            <Text color={c("dim")}>{tail(live.reasoning, MAX_LIVE_LINES)}</Text>
          ) : null}
          {live.content ? <Text>{tail(live.content, MAX_LIVE_LINES)}</Text> : null}
          {/* 唯一的状态行:spinner + 当前活动/动词 + 耗时 + 工具数 + 排队数(长任务也看得见在干嘛)。 */}
          <Text color={c("dim")}>
            {spin} {live.lastActivity || (live.content ? "生成回答" : verb)}…{" "}
            ({elapsed}s{live.toolCount > 0 ? ` · ${live.toolCount} 次工具` : ""}{queued.length ? ` · 已排 ${queued.length}` : ""} · esc 打断)
          </Text>
        </Box>
      )}

      {approval && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={c("vermilion")} paddingX={1}>
          <Text color={c("vermilion")}>
            需要批准{approval.requests.length > 1 ? ` (${apIdx + 1}/${approval.requests.length})` : ""}:
          </Text>
          <Text color={c("ink")}>{(approval.requests[apIdx]?.summary ?? "").slice(0, 600).replace(/^/gm, "  ")}</Text>
          {approval.requests[apIdx]?.sensitive ? (
            <Text color={c("dim")}>敏感操作(.ssh/.git/凭据等) · [y]是(仅本次) [n]否</Text>
          ) : approval.requests[apIdx]?.noPersist ? (
            <Text color={c("dim")}>此命令记不成通用规则 · [y]是(仅本次) [n]否</Text>
          ) : (
            <Text color={c("dim")}>[y]是(允许一次) [a]始终允许(记住,同类不再问) [n]否</Text>
          )}
        </Box>
      )}

      {choice && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={c("jade")} paddingX={1}>
          <Text color={c("jade")}>{choice.question}</Text>
          {choiceFilling ? (
            <>
              <Text color={c("ink")}>› {askInput}<Text color={c("jade")}>▎</Text></Text>
              <Text color={c("dim")}>输入你的答案,⏎ 确认</Text>
            </>
          ) : (
            <>
              {[...choice.options, ...(choice.multi ? [CHOICE_DONE, CHOICE_FILL, CHOICE_DISCUSS] : [CHOICE_FILL, CHOICE_DISCUSS])].map((o, i) => {
                const focused = i === choiceIdx;
                // 多选:正常项显示 checkbox;"完成/其他/讨论"不参与勾选,仍按序号呈现。
                const box = choice.multi && i < choice.options.length ? (choiceChecked.has(i) ? "[x] " : "[ ] ") : "";
                return (
                  <Text key={i} color={focused ? c("jade") : c("ink")}>
                    {focused ? "❯ " : "  "}{i + 1}. {box}{o}
                  </Text>
                );
              })}
              <Text color={c("dim")}>
                {choice.multi ? "⏎/空格 勾选当前项 · ↑↓ 移动 · 到「完成」回车提交" : "数字快选 · ↑↓ 移动 · ⏎ 确认"}
              </Text>
              {choiceWarn ? <Text color={c("vermilion")}>还没勾选任何项:用 ⏎/空格 勾选,或选「先讨论一下」</Text> : null}
            </>
          )}
        </Box>
      )}

      {ask && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={c("jade")} paddingX={1}>
          <Text color={c("jade")}>{ask.question}</Text>
          <Text color={c("ink")}>› {askInput}<Text color={c("jade")}>▎</Text></Text>
        </Box>
      )}

      {!approval && !ask && !choice && (
        <Box flexDirection="column" marginTop={1}>
          {/* 输入行加圆角边框,交互时清晰可辨(活跃=青玉,运行中=暗);补全/提示行在框外。 */}
          <Box borderStyle="round" borderColor={busy ? c("dim") : c("jade")} paddingX={1}>
            <Text>
              <Text color={busy ? c("dim") : c("jade")}>{busy ? "⏎ " : "› "}</Text>
              {input.slice(0, cursor)}
              <Text color={c("jade")}>▎</Text>
              {input.slice(cursor)}
            </Text>
          </Box>
          {input.startsWith("/") && !input.includes(" ") ? (
            <Text color={c("dim")}>
              {"  "}
              {["model", "plan", "mode", "skills", "init", "context", "tasks", "mcp", "diff", "doctor", "review", "security-review", "hooks", "agents", "files", "memory", "permissions", "resume", "rewind", "branch", "rename", "export", "copy", "btw", "config", "effort", "status", "plugin", "login", "logout", "simplify", "remember", "debug", "skillify", "batch", "loop", "theme", "bypass", "goal", "coordinator", "dod", "restore", "clear", "compact", "cost", "help", "exit"]
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
          {/* 底部提示(CC 风格,克制的暗色一行,无 emoji):运行中=可排队;空闲=轮换一条 tip。 */}
          <Text color={c("dim")}>
            {"  "}
            {busy
              ? "运行中——可继续输入,回车排队执行"
              : input
                ? ""
                : TIPS[Math.floor(tick / 110) % TIPS.length]}
          </Text>
        </Box>
      )}

      {modeHint && !approval && !ask && !choice ? (
        <Text color={c("jade")}>{"  "}权限模式 → {modeHint}</Text>
      ) : null}
      {bgRunning > 0 ? <Text color={c("gold")}>∞ {bgRunning} 个后台任务运行中…</Text> : null}
      <StatusBar status={status} c={c} />
    </Box>
  );
}

// ctrl+o 开启时,取最近一条"可展开项"的完整内容(已打印的无法原地改,故追加显示)。
function lastExpandableFull(items: ({ id: number; kind: "welcome" } | TranscriptItem)[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "tool" && it.output && it.output.length) return `⎿ ${it.label}\n${it.output.join("\n")}`;
    if (it.kind === "reasoning") return `✻ 思考\n${it.text}`;
    if (it.kind === "diff") {
      const body = it.rows?.length ? it.rows.join("\n") : [...it.removed.map((l) => "- " + l), ...it.added.map((l) => "+ " + l)].join("\n");
      return `● 编辑 ${it.path}\n${body}`;
    }
  }
  return null;
}

const TODO_ICON = { pending: "☐", in_progress: "▶", completed: "☑" } as const;
const hl = (line: string, lang: string): string => {
  if (!lang) return line;
  try { return highlight(line, { language: lang, ignoreIllegals: true }); } catch { return line; }
};

function Row({ item, c, expanded }: { item: TranscriptItem; c: (s: Parameters<typeof semHex>[0]) => string; expanded?: boolean }) {
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
  if (item.kind === "reasoning") {
    // 思考块(暗色,复刻 CC):默认截断到末 REASONING_CAP 行,ctrl+o/--verbose 全量。
    const lines = item.text.split("\n").filter((l) => l.trim());
    const cut = expanded ? 0 : Math.max(0, lines.length - REASONING_CAP);
    const shown = expanded ? lines : lines.slice(-REASONING_CAP);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={c("dim")}>✻ 思考{cut > 0 ? `(共 ${lines.length} 行,ctrl+o 展开)` : ""}</Text>
        {shown.map((l, i) => <Text key={i} color={c("dim")}>  {l}</Text>)}
      </Box>
    );
  }
  if (item.kind === "todo") {
    // 复选框清单(复刻 CC):完成项划淡,进行中高亮。
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={c("jade")}>● 任务清单</Text>
        {item.items.map((t, i) => (
          <Text
            key={i}
            color={t.status === "completed" ? c("dim") : t.status === "in_progress" ? c("gold") : c("ink")}
            strikethrough={t.status === "completed"}
          >
            {"  "}{TODO_ICON[t.status]} {t.content}
          </Text>
        ))}
      </Box>
    );
  }
  if (item.kind === "tool") {
    // ● 意图 + 小结;⎿ 子块展示真实输出。echo 工具(Bash/grep…)默认显;其余默认折叠,ctrl+o 展开。
    const out = item.output ?? [];
    const showOut = (item.echo || expanded) && out.length > 0;
    const collapsedHint = !showOut && out.length > 0; // 有内容但默认未展开
    const { shown, hidden } = clampLines(out, expanded ? Infinity : TOOL_OUT_CAP);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={item.ok ? c("jade") : c("vermilion")}>● </Text>
          <Text color={c("ink")}>{item.label}</Text>
          {item.detail ? <Text color={item.ok ? c("dim") : c("vermilion")}>  {item.detail}</Text> : null}
          {collapsedHint ? <Text color={c("dim")}>  (ctrl+o 展开)</Text> : null}
        </Box>
        {expanded && item.rawArgs ? <Text color={c("dim")}>  ⎿ 参数 {item.rawArgs}</Text> : null}
        {showOut ? shown.map((l, i) => (
          <Text key={i} color={c("dim")}>  {i === 0 ? "⎿ " : "  "}{l}</Text>
        )) : null}
        {showOut && hidden > 0 ? <Text color={c("dim")}>  … +{hidden} 行(ctrl+o 展开)</Text> : null}
      </Box>
    );
  }
  if (item.kind === "diff") {
    // 优先用工具给的 ```diff 行(带行号+上下文);上下文空格前缀=暗色,- 红 + 绿,正文语法高亮。
    if (item.rows && item.rows.length) {
      const { shown, hidden } = clampLines(item.rows, expanded ? Infinity : 40);
      const col = (sign: string) => (sign === "+" ? c("jade") : sign === "-" ? c("vermilion") : c("dim"));
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={c("jade")}>
            ● 编辑 {item.path} <Text color={c("dim")}>(-{item.removed.length} +{item.added.length})</Text>
          </Text>
          {shown.map((r, i) => {
            const sign = r[0] ?? " ";
            return (
              <Text key={i} color={col(sign)}>
                {"  "}{sign}{hl(r.slice(1), item.lang)}
              </Text>
            );
          })}
          {hidden > 0 ? <Text color={c("dim")}>{"  "}… +{hidden} 行(ctrl+o 展开)</Text> : null}
        </Box>
      );
    }
    // 退回:无 ```diff 块时用 old/new 构造(行号可选)。
    const cap = expanded ? Infinity : 40;
    const start = item.startLine ?? 0;
    const rows: Array<["-" | "+", string, number]> = [
      ...item.removed.map((l, i) => ["-", l, start + i] as ["-" | "+", string, number]),
      ...item.added.map((l, i) => ["+", l, start + i] as ["-" | "+", string, number]),
    ];
    const { shown, hidden } = clampLines(rows, cap);
    const num = (n: number) => (start ? String(n).padStart(4) + " " : "");
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={c("jade")}>
          ● 编辑 {item.path} <Text color={c("dim")}>(-{item.removed.length} +{item.added.length})</Text>
        </Text>
        {shown.map(([sign, l, n], i) => (
          <Text key={i} color={sign === "+" ? c("jade") : c("vermilion")}>
            {"  "}{sign} <Text color={c("dim")}>{num(n)}</Text>{hl(l, item.lang)}
          </Text>
        ))}
        {hidden > 0 ? <Text color={c("dim")}>{"  "}… +{hidden} 行(ctrl+o 展开)</Text> : null}
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
  c,
}: {
  status: StatusInfo;
  c: (s: Parameters<typeof semHex>[0]) => string;
}) {
  const pct = (status.cacheHitRatio * 100).toFixed(0);
  const fmt = (n: number) => (n < 1000 ? String(n) : (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k");
  return (
    <Box marginTop={1}>
      <Text color={c("dim")}>
        {/* 耗时只在上方 live 行显示一次,这里不再重复 */}
        {status.coordinator ? <Text color={c("gold")}>❖ Coordinator · </Text> : ""}
        {status.longTask ? <Text color={c("gold")}>∞ 长任务 · </Text> : ""}
        {status.yolo ? <Text color={c("vermilion")}>※ YOLO · </Text> : ""}
        {/* 模式只在非默认时标出:normal 是默认态,展示它只会让人困惑 */}
        {status.mode === "plan" ? <Text color={c("gold")}>◇ plan(只读规划) · </Text> : ""}
        {status.permMode === "acceptEdits" ? <Text color={c("jade")}>✎ 自动接受编辑 · </Text> : ""}
        {status.permMode === "auto" ? <Text color={c("jade")}>⊙ 智能判定 · </Text> : ""}
        {status.model} · 输入 {fmt(status.promptTokens)} · 输出 {fmt(status.completionTokens)} · 缓存命中 {pct}%{status.costCNY ? ` · ￥${status.costCNY.toFixed(status.costCNY < 1 ? 3 : 2)}` : ""} · 上下文 {status.contextPct < 1 ? "<1" : Math.round(status.contextPct)}%
        {status.branch ? ` · ⎇ ${status.branch}` : ""}
      </Text>
    </Box>
  );
}

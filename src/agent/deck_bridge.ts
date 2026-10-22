// 本地 Agent Deck 协议桥;运行时不依赖面板进程。
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SessionScheduler } from "./session_scheduler.js";
import type { BackgroundRuntime } from "./background_runtime.js";
import type { Session } from "../session/session.js";
import type { TurnEvents } from "../tui/render.js";
import type { ApprovalRequest, ApprovalDecision } from "../approval/types.js";
import { messagePage,contentText } from './deck_messages.js';

interface BridgeOptions {
  scheduler: SessionScheduler;
  session: Session;
  runtime: BackgroundRuntime;
  cwd: string;
  version: string;
  writable: boolean;
  tasks: () => unknown[];
  todos: () => unknown[];
  getPermissionMode?: () => string;
  setPermissionMode?: (mode: 'default' | 'auto' | 'plan' | 'bypassPermissions') => void;
}
type Receipt = { id: string; text: string; status: "queued" | "consumed" | "rejected" | "canceled"; at: number };
const clip = (text: string, max = 24000) => text.length > max ? text.slice(0, max) + "\n…（已截断）" : text;

export function createDeckBridge(options: BridgeOptions) {
  if (process.env.DAO_DECK === "0") {
    if (process.env.DAO_DECK_MANAGED === "1") throw new Error("Deck 托管模式不能同时设置 DAO_DECK=0");
    return undefined;
  }
  const { scheduler, session, runtime } = options;
  const managed = process.env.DAO_DECK_MANAGED === "1";
  const instanceId = randomUUID(), token = randomBytes(32).toString("hex"), startedAt = Date.now();
  const home = process.env.AGENT_DECK_HOME || path.join(os.homedir(), ".agent-deck");
  const recordFile = path.join(home, "agents", `${process.pid}-${instanceId}.json`);
  let closed = false, port = 0, sessionId = runtime.sessionId;
  let live = "", activity = "", lastActivityAt = startedAt;
  type Prompt = { id: string; kind: string; text: string; at: number; replyable: true; requests?: {id:string; summary:string; toolName:string}[] };
  let attention: { kind: string; text: string; id?: string; at?: number; replyable?: boolean; requests?: Prompt["requests"] } | undefined;
  const prompts = new Map<string, { prompt: Prompt; resolve: (answer: string) => void }>();
  const cancelPrompts = () => { for (const p of prompts.values()) p.resolve("[用户中断]"); prompts.clear(); attention = undefined; };
  const requestPrompt = (kind: string, text: string, requests?: Prompt["requests"]) => new Promise<string>(resolve => {
    syncSession();
    if (closed || scheduler.status().state === "paused" || scheduler.status().state === "closed") { resolve("[用户中断]"); return; }
    const prompt: Prompt = { id: randomUUID(), kind, text, at:Date.now(), requests, replyable: true };
    prompts.set(prompt.id, { prompt, resolve }); attention = prompts.values().next().value?.prompt;
  });
  const receipts = new Map<string, Receipt>();
  const commands = new Map<string, { signature: string; result: unknown }>();
  const events: { id: string; kind: string; text: string; at: number; ok?: boolean }[] = [];
  const event = (kind: string, text: string, ok?: boolean) => {
    lastActivityAt = Date.now();
    events.push({ id: randomUUID(), kind, text: clip(text, 6000), at: lastActivityAt, ok });
    if (events.length > 120) events.shift();
  };
  const syncSession = () => {
    if (sessionId === runtime.sessionId) return;
    sessionId = runtime.sessionId; live = ""; activity = ""; attention = undefined;
    cancelPrompts(); events.length = 0; receipts.clear(); commands.clear();
  };
  const record = () => {
    if (closed || !port) return;
    try {
      syncSession();
      mkdirSync(path.dirname(recordFile), { recursive: true, mode: 0o700 });
      writeFileSync(recordFile + ".tmp", JSON.stringify({ protocol: 1, instanceId, sessionId, pid: process.pid,
        cwd: options.cwd, version: options.version, port, token, startedAt, updatedAt: Date.now() }), { mode: 0o600 });
      renameSync(recordFile + ".tmp", recordFile);
    } catch { /* 观察记录失败不阻止终端继续工作。 */ }
  };
  const snapshot = () => {
    syncSession();
    let title: string | undefined;
    if (runtime.store) {
      try { const meta = JSON.parse(readFileSync(path.join(runtime.store.dir, "meta.json"), "utf8")) as { title?: string; summary?: string }; title = meta.title || meta.summary; } catch { /* 首次检查点可能尚无元数据。 */ }
    }
    return { protocol: 1, instanceId, sessionId, pid: process.pid, cwd: options.cwd, version: options.version,
      title:title || contentText(session.messages.find(m=>m.role==='user')?.content).slice(0,120),
      startedAt, updatedAt: Date.now(), lastActivityAt, ...scheduler.status(), attention,
      error: scheduler.lastError?.message, model: session.model, mode: session.mode,
      permissionMode:options.getPermissionMode?.(),
      usage: { ...session.usage }, costCNY: session.costCNY(), activity, live: clip(live),
      capabilities: { message: options.writable, pause: true, answer: managed, history:true, permissions:options.writable && !!options.getPermissionMode && !!options.setPermissionMode },
      ...messagePage(session.messages), tasks: options.tasks().slice(-60), todos: options.todos().slice(0, 100), events,
      receipts: [...receipts.values()].map(r => ({ ...r, text: clip(r.text, 300) })) };
  };
  const server = createServer(async (req, res) => {
    const json = (code: number, data: unknown) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { json(403, { error: "Forbidden" }); return; }
    try {
      syncSession();
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/messages') {
        const before=url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
        if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) { json(400,{error:'无效的历史位置'}); return; }
        json(200,{sessionId:runtime.sessionId,instanceId,cwd:options.cwd,...messagePage(session.messages,before)}); return;
      }
      if (req.method === "GET" && req.url === "/snapshot") { json(200, snapshot()); return; }
      if (req.method !== "POST" || req.url !== "/command") { json(404, { error: "Not found" }); return; }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 65536) { json(413, { error: "消息太长" }); return; } chunks.push(Buffer.from(chunk)); }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: string; sessionId?: string; type?: string; text?: string; promptId?: string; decision?: string; mode?: string };
      if (input.sessionId !== runtime.sessionId) { json(409, { error: "会话已切换，请刷新后重试" }); return; }
      if (!input.id || typeof input.id !== "string" || input.id.length > 100) { json(400, { error: "缺少指令 ID" }); return; }
      const signature = JSON.stringify([input.type, input.text, input.promptId, input.decision,input.mode]);
      const prior = commands.get(input.id);
      if (prior) { json(prior.signature === signature ? 200 : 409, prior.signature === signature ? prior.result : { error: "指令 ID 已使用" }); return; }
      if (scheduler.status().state === "closed") { json(409, { error: "会话已关闭" }); return; }
      let result: unknown;
      if(input.type==='permission') {
        if (!options.writable) { json(409, { error: "一次性 Dao 任务不支持切换权限" }); return; }
        if(!options.setPermissionMode || !options.getPermissionMode){json(409,{error:'当前 Dao 版本未接入权限切换，请更新入口并恢复会话'});return;}
        if(!['default','auto','plan','bypassPermissions'].includes(input.mode||'')){json(400,{error:'未知权限模式'});return;}
        if(!['idle','paused'].includes(scheduler.status().state)||attention||prompts.size){json(409,{error:'请先暂停执行并结束当前审批，再切换权限'});return;}
        options.setPermissionMode(input.mode as 'default' | 'auto' | 'plan' | 'bypassPermissions');
        event('permission',`权限模式已切换为 ${options.getPermissionMode()}`);
        result={id:input.id,status:'applied',permissionMode:options.getPermissionMode()};
      } else if (input.type === "message") {
        if (!options.writable) { json(409, { error: "一次性 Dao 任务仅支持查看和暂停，请在交互会话中发消息" }); return; }
        if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000) { json(400, { error: "消息应为 1–16000 个字符" }); return; }
        if(/^\/(mode|bypass|yolo|permissions|plan)(?:\s|$)/i.test(input.text.trim())) {json(400,{error:'这是终端控制命令，请使用 Deck 的权限设置；当前消息未发送给模型'});return;}
        // 面板发来的斜杠命令按普通用户文本处理,不绕过终端命令分派。
        receipts.set(input.id, { id: input.id, text: input.text, status: "queued", at: Date.now() });
        scheduler.submit(input.text);
        result = { id: input.id, status: "queued" };
      } else if (input.type === "pause") {
        cancelPrompts();
        scheduler.pause();
        for (const receipt of receipts.values()) if (receipt.status === "queued") receipt.status = "canceled";
        result = { id: input.id, status: "paused" };
      } else if (input.type === "answer") {
        const pending = input.promptId ? prompts.get(input.promptId) : undefined;
        if (!managed || !pending) { json(409, { error: "问题已失效或需要在原终端处理" }); return; }
        let answer: string;
        if (pending.prompt.kind === "approval") {
          if (!["allow", "deny"].includes(input.decision ?? "")) { json(400, { error: "请选择允许本次或拒绝" }); return; }
          answer = input.decision!;
        } else {
          if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000) { json(400, { error: "请输入回答" }); return; }
          answer = input.text;
        }
        prompts.delete(input.promptId!); attention = prompts.values().next().value?.prompt;
        pending.resolve(answer); result = { id: input.id, status: "answered" };
      } else { json(400, { error: "未知指令" }); return; }
      commands.set(input.id, { signature, result });
      if (commands.size > 200) commands.delete(commands.keys().next().value!);
      if (receipts.size > 100) receipts.delete(receipts.keys().next().value!);
      json(200, result);
    } catch { json(400, { error: "无法处理指令" }); }
  });
  server.requestTimeout = 5000;
  server.on("error", () => close());
  server.listen(0, "127.0.0.1", () => { const address = server.address(); if (address && typeof address !== "string") { port = address.port; record(); } });
  if (!managed) server.unref();
  const heartbeat = setInterval(record, 5000); heartbeat.unref();
  let unsubscribe = () => {};
  process.once("exit", close);
  unsubscribe = scheduler.subscribe(status => {
    if (status.state === "closed") close();
    if (status.state === "paused") { cancelPrompts(); for (const r of receipts.values()) if (r.status === "queued") r.status = "canceled"; }
  });
  if (closed) unsubscribe();
  function close() {
    if (closed) return; closed = true;
    cancelPrompts();
    clearInterval(heartbeat); unsubscribe?.(); server.close(); server.closeAllConnections();
    try { unlinkSync(recordFile); } catch { /* 记录可能已被清理。 */ }
    process.removeListener("exit", close);
  }
  return {
    close,
    async approve(requests: ApprovalRequest[]): Promise<Map<string, ApprovalDecision>> {
      const answer = await requestPrompt("approval", requests.map(r => r.summary).join("\n"), requests.map(r => ({id:r.id, summary:r.summary, toolName:r.toolName})));
      return new Map(requests.map(r => [r.id, answer === "allow" ? "once" as const : "deny" as const]));
    },
    question(text: string) { return requestPrompt("question", text); },
    input(text: string, accepted: boolean) {
      const receipt = [...receipts.values()].find(r => r.text === text && r.status === "queued");
      if (receipt) receipt.status = accepted ? "consumed" : "rejected";
      return !!receipt;
    },
    attention(kind: string, text: string) {
      const current = { kind, text, at:Date.now() }; attention = current;
      return () => { if (attention === current) attention = undefined; };
    },
    events(inner: TurnEvents): TurnEvents {
      return {
        reasoning(chunk) { lastActivityAt = Date.now(); activity = "正在思考"; inner.reasoning(chunk); },
        content(chunk) { lastActivityAt = Date.now(); live = (live + chunk).slice(-24000); activity = "正在回复"; inner.content(chunk); },
        assistantDone(message) { live = ""; inner.assistantDone(message); },
        toolStart(call) { activity = `执行 ${call.name}`; event("tool_start", call.name); inner.toolStart(call); },
        toolResult(call, message) { event("tool_result", `${call.function.name}\n${typeof message.content === "string" ? message.content : ""}`); inner.toolResult(call, message); },
        notice(text) { event("notice", text); inner.notice(text); },
        userMessage(text) { inner.userMessage?.(text); },
      };
    },
  };
}

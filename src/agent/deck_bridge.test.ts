import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeckBridge } from "./deck_bridge.js";
import { BackgroundRuntime } from "./background_runtime.js";
import { SessionScheduler } from "./session_scheduler.js";
import { Session } from "../session/session.js";
import { plainEvents } from "../tui/render.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(close => close()); vi.unstubAllEnvs(); });

async function fixture(managed = true, writable = true) {
  const home = mkdtempSync(path.join(os.tmpdir(), "dao-deck-test-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("AGENT_DECK_HOME", home);
  vi.stubEnv("DAO_DECK", "1");
  vi.stubEnv("DAO_DECK_MANAGED", managed ? "1" : "0");
  const session = new Session("秘密系统提示", "deepseek-v4-pro"), runtime = new BackgroundRuntime();
  let accepted = true;
  let hold = false, aborted = false, permissionMode = "default";
  const run = vi.fn(async (signal: AbortSignal) => {
    if (hold) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      return { kind: "interrupted" as const, reason: "user" as const };
    }
    session.messages.push({ role: "assistant", content: "回复" }); return { kind: "completed" as const };
  });
  const scheduler = new SessionScheduler({ runtime, session, save: () => {}, run, user: async text => {
    bridge!.input(String(text), accepted); if (accepted) session.addUser(text); return accepted;
  } });
  cleanups.push(() => scheduler.close());
  const bridge = createDeckBridge({ scheduler, runtime, session, cwd: home, version: "test", writable,
    tasks: () => [{ taskId: "a" }], todos: () => [],
    getPermissionMode: () => permissionMode, setPermissionMode: mode => { permissionMode = mode; } });
  cleanups.push(() => bridge?.close());
  const agents = path.join(home, "agents");
  let record!: { port: number; token: string };
  await vi.waitFor(() => {
    const file = path.join(agents, readdirSync(agents)[0]!);
    record = JSON.parse(readFileSync(file, "utf8"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  const url = "http://127.0.0.1:" + record.port, headers = { Authorization: "Bearer " + record.token };
  const get = async (route = "/snapshot"): Promise<any> => (await fetch(url + route, { headers })).json();
  const command = async (input: Record<string, unknown>) => fetch(url + "/command", { method: "POST", headers,
    body: JSON.stringify({ sessionId: runtime.sessionId, ...input }) });
  return { bridge: bridge!, scheduler, runtime, session, run, get, command, url, headers, agents,
    rejectInput: () => { accepted = false; }, holdRun: () => { hold = true; }, wasAborted: () => aborted };
}

describe("Agent Deck 本地协议", () => {
  it("需要令牌且拒绝浏览器跨域请求,快照和历史过滤系统提示", async () => {
    const f = await fixture();
    expect((await fetch(f.url + "/snapshot")).status).toBe(403);
    expect((await fetch(f.url + "/snapshot", { headers: { ...f.headers, Origin: "https://example.com" } })).status).toBe(403);
    const data = await f.get();
    expect(data.tasks).toEqual([{ taskId: "a" }]);
    expect(data.capabilities).toMatchObject({ message: true, answer: true });
    expect(JSON.stringify(data)).not.toContain("秘密系统提示");
    expect((await f.get("/messages")).messages).toEqual([]);
  });
  it("消息经调度器消费一次,重复请求幂等,hook 拒绝有回执", async () => {
    const f = await fixture(), input = { id: "one", type: "message", text: "你好" };
    expect((await f.command(input)).status).toBe(200); await f.scheduler.settled();
    expect((await f.command(input)).status).toBe(200);
    expect(f.run).toHaveBeenCalledTimes(1);
    expect((await f.command({ ...input, text: "不同内容" })).status).toBe(409);
    expect((await f.get()).receipts[0].status).toBe("consumed");
    f.rejectInput(); await f.command({ id: "blocked", type: "message", text: "阻止" }); await f.scheduler.settled();
    expect((await f.get()).receipts[1].status).toBe("rejected");
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it("托管问题和一次审批可回答,重复/过期回答不生效", async () => {
    const f = await fixture(), answer = f.bridge.question("选择方案");
    const prompt = (await f.get()).attention;
    await f.command({ id: "answer", type: "answer", promptId: prompt.id, text: "A" });
    expect(await answer).toBe("A");
    expect((await f.command({ id: "stale", type: "answer", promptId: prompt.id, text: "A" })).status).toBe(409);
    const approval = f.bridge.approve([{ id: "tool", toolName: "Bash", capability: "exec", summary: "执行测试" }]);
    const pending = (await f.get()).attention;
    expect((await f.command({ id: "always", type: "answer", promptId: pending.id, decision: "always" })).status).toBe(400);
    await f.command({ id: "allow", type: "answer", promptId: pending.id, decision: "allow" });
    expect((await approval).get("tool")).toBe("once");
    expect((await f.get()).attention).toBeUndefined();
  });
  it("暂停取消问题和审批,关闭后调用不会永久等待", async () => {
    const f = await fixture(), question = f.bridge.question("等待");
    const approval = f.bridge.approve([{ id: "write", toolName: "Write", capability: "write", summary: "写文件" }]);
    await f.command({ id: "pause", type: "pause" });
    expect(await question).toBe("[用户中断]"); expect((await approval).get("write")).toBe("deny");
    expect(f.scheduler.status().state).toBe("paused"); f.bridge.close();
    expect(await f.bridge.question("关闭后")).toBe("[用户中断]");
    expect(readdirSync(f.agents)).toEqual([]);
  });
  it("面板断连后继续执行,重连可读取历史", async () => {
    const f = await fixture(), controller = new AbortController();
    await fetch(f.url + "/snapshot", { headers: f.headers, signal: controller.signal }); controller.abort();
    await f.command({ id: "work", type: "message", text: "继续" }); await f.scheduler.settled();
    expect((await f.get("/messages")).messages.map((m: { content: string }) => m.content)).toEqual(["继续", "回复"]);
  });
  it("切换会话取消旧问题,拒绝旧会话指令", async () => {
    const f = await fixture(), old = f.runtime.sessionId, answer = f.bridge.question("旧问题");
    f.runtime.sessionId = "new-session";
    expect((await f.get()).attention).toBeUndefined(); expect(await answer).toBe("[用户中断]");
    expect((await f.command({ id: "old", type: "message", sessionId: old, text: "旧指令" })).status).toBe(409);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("只读任务禁发消息,观察模式由原终端答复,非法历史位置被拒", async () => {
    const f = await fixture(false, false);
    expect((await f.get()).capabilities).toMatchObject({ message: false, answer: false });
    expect((await f.command({ id: "ro", type: "message", text: "执行" })).status).toBe(409);
    expect((await f.command({ id: "a", type: "answer", promptId: "missing", text: "执行" })).status).toBe(409);
    expect((await fetch(f.url + "/messages?before=-1", { headers: f.headers })).status).toBe(400);
    expect((await f.command({ type: "pause" })).status).toBe(400);
    expect((await f.command({ id: "permission", type: "permission", mode: "auto" })).status).toBe(409);
  });
  it("暂停中断正在运行的回合,取消尚未消费的输入", async () => {
    const f = await fixture(); f.holdRun();
    await f.command({ id: "running", type: "message", text: "运行" });
    await vi.waitFor(() => expect(f.scheduler.status().state).toBe("running"));
    await f.command({ id: "queued", type: "message", text: "待消费" });
    await f.command({ id: "pause-running", type: "pause" }); await f.scheduler.settled();
    expect(f.wasAborted()).toBe(true);
    expect((await f.get()).receipts.find((r: { id: string }) => r.id === "queued").status).toBe("canceled");
  });
  it("流式事件同时转发给终端与面板,完成时清理实时文本", async () => {
    const f = await fixture(), write = vi.fn(), events = f.bridge.events(plainEvents(write));
    events.reasoning("思考"); events.content("正文");
    expect(await f.get()).toMatchObject({ live: "正文", activity: "正在回复" });
    events.toolStart({ index: 0, name: "Read" });
    events.toolResult({ id: "a", type: "function", function: { name: "Read", arguments: "{}" } },
      { role: "tool", tool_call_id: "a", content: "结果" });
    events.assistantDone({ role: "assistant", content: "正文" });
    const snapshot = await f.get();
    expect(snapshot.live).toBe("");
    expect(snapshot.events.map((e: { kind: string }) => e.kind)).toEqual(["tool_start", "tool_result"]);
    expect(write).toHaveBeenCalled();
  });
  it("权限切换只在安全边界生效,待答问题不能被切换权限绕过", async () => {
    const f = await fixture();
    expect((await f.command({ id: "mode", type: "permission", mode: "plan" })).status).toBe(200);
    expect((await f.get()).permissionMode).toBe("plan");
    const answer = f.bridge.question("正在等答复");
    expect((await f.command({ id: "unsafe", type: "permission", mode: "bypassPermissions" })).status).toBe(409);
    f.bridge.close(); expect(await answer).toBe("[用户中断]");
  });
});

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

it("真实 CLI 托管会话能收消息、选项答复、审批写入和验证,面板重连后可继续", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dao-deck-cli-")), home = path.join(root, "home"), work = path.join(root, "work");
  mkdirSync(home); mkdirSync(work);
  const tool = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const results = body.messages.filter((m: { role: string }) => m.role === "tool");
    const has = (id: string) => results.some((m: { tool_call_id: string }) => m.tool_call_id === id);
    let call;
    if (!has("question")) call = tool("question", "AskUserQuestion", { question: "选一个方案", options: ["方案 A", "方案 B"] });
    else if (!has("write")) {
      expect(results.find((m: { tool_call_id: string }) => m.tool_call_id === "question").content).toBe("方案 A");
      call = tool("write", "Write", { path: "smoke-result.txt", content: "已批准" });
    } else if (!has("verify")) call = tool("verify", "Bash", { command: "test -f smoke-result.txt" });
    const delta = call ? { tool_calls: [{ index: 0, ...call }] } : { content: "流程完成" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: call ? "tool_calls" : "stop" }] }) + "\n\ndata: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("测试服务器未启动");
  const mock = path.join(root, "mock-network.mjs");
  writeFileSync(mock, "const original = globalThis.fetch; globalThis.fetch = (url, init) => String(url).startsWith('https://api.deepseek.com') ? original('http://127.0.0.1:" + address.port + "' + new URL(String(url)).pathname, init) : Promise.resolve(new Response('测试中禁止外网', {status:503}));");
  const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--import", mock,
    fileURLToPath(new URL("../index.ts", import.meta.url)), "--api-key", "test-only", "--provider", "deepseek", "--model", "deepseek-v4-pro",
    "--no-memory", "--no-mcp", "--no-skills", "--no-hooks", "--no-web", "--no-project-instructions"], {
    cwd: work, env: { ...process.env, HOME: home, DAO_DECK: "1", DAO_DECK_MANAGED: "1",
      AGENT_DECK_HOME: path.join(root, "deck"), DAO_REPO_MAP_TOKENS: "0", DAO_REFLECT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
  const exited = once(child, "exit");
  const waitFor = async <T>(check: () => T | undefined): Promise<T> => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error("CLI 提前退出: " + log);
      const value = check(); if (value !== undefined) return value;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("等待 CLI 状态超时: " + log);
  };
  try {
    const record = await waitFor(() => {
      const dir = path.join(root, "deck", "agents");
      if (!existsSync(dir)) return;
      const file = readdirSync(dir).find(name => name.endsWith(".json"));
      if (file) return JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { port: number; token: string; sessionId: string };
    });
    const url = "http://127.0.0.1:" + record.port, headers = { Authorization: "Bearer " + record.token };
    const get = async (): Promise<any> => (await fetch(url + "/snapshot", { headers })).json();
    const send = async (input: Record<string, unknown>) => {
      const response = await fetch(url + "/command", { method: "POST", headers,
        body: JSON.stringify({ id: crypto.randomUUID(), sessionId: record.sessionId, ...input }) });
      expect(response.status).toBe(200);
    };
    expect((await get()).capabilities.message).toBe(true); // --model 的值不能被误当成一次性 prompt。
    await send({ type: "message", text: "执行测试流程" });
    let answered = false, approved = false;
    for (let i = 0; i < 300; i++) {
      const snapshot = await get();
      if (snapshot.attention?.replyable) {
        const prompt = snapshot.attention;
        if (prompt.kind === "question") {
          expect(prompt.text).toContain("方案 A");
          await send({ type: "answer", promptId: prompt.id, text: "1" }); answered = true;
        } else {
          await send({ type: "answer", promptId: prompt.id, decision: "allow" }); approved = true;
        }
      }
      if (snapshot.state === "idle" && snapshot.messages.some((m: { content: string }) => m.content === "流程完成")) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(answered).toBe(true); expect(approved).toBe(true);
    expect(readFileSync(path.join(work, "smoke-result.txt"), "utf8")).toBe("已批准");
    // 重新创建 HTTP 连接,仍使用同一 Agent 进程。
    await send({ type: "message", text: "面板重连后继续" });
    for (let i = 0; i < 100; i++) {
      const snapshot = await get();
      if (snapshot.state === "idle" && snapshot.receipts.some((r: { text: string; status: string }) => r.text === "面板重连后继续" && r.status === "consumed")) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect((await get()).receipts.some((r: { text: string; status: string }) => r.text === "面板重连后继续" && r.status === "consumed")).toBe(true);
    await send({ type: "pause" }); expect((await get()).state).toBe("paused");
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
    server.close(); server.closeAllConnections();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

// 测试用的最小 stdio MCP server。connectMcpServers 会以 `node 本文件` 形式 spawn 它。
// 行为:
//  - 默认:只注册 echo 工具(回显 msg)。现有 连接/重连 测试依赖这个最小形态(tools=1、无 resources/prompts 能力)。
//  - MCP_FAKE_RICH=1:额外注册一个 resource、一个 prompt、一个触发 elicitation 的工具(测 resources/prompts/elicitation)。
//  - 崩溃模拟(测重连自愈):设 MCP_FAKE_CRASH_FILE(计数文件)+ MCP_FAKE_CRASH_ON=<N>,
//    则全局第 N 次(从 0 起)echo 调用会在响应前 process.exit(1)——管道断,客户端收到连接错误。
//    计数写在文件里、跨进程重启保留,所以重连后 spawn 的新进程不会再崩(计数已 > N),从而成功返回。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const crashFile = process.env.MCP_FAKE_CRASH_FILE;
const crashOn = process.env.MCP_FAKE_CRASH_ON;

const server = new McpServer({ name: "fake", version: "0.0.1" });

server.registerTool(
  "echo",
  { description: "回显输入的 msg", inputSchema: { msg: z.string() } },
  async ({ msg }) => {
    if (crashFile && crashOn !== undefined) {
      let count = 0;
      if (existsSync(crashFile)) count = parseInt(readFileSync(crashFile, "utf8"), 10) || 0;
      writeFileSync(crashFile, String(count + 1)); // 先持久化计数,再决定是否崩(让重连后的新进程看到已 +1)
      if (count === Number(crashOn)) process.exit(1); // 模拟请求处理中途崩溃
    }
    return { content: [{ type: "text", text: `echo:${msg}` }] };
  },
);

if (process.env.MCP_FAKE_RICH) {
  server.registerResource(
    "greeting",
    "mem://greeting",
    { description: "一条问候语 resource" },
    async (uri) => ({ contents: [{ uri: uri.href, text: "hello-resource" }] }),
  );
  server.registerPrompt(
    "greet",
    { description: "打招呼模板", argsSchema: { who: z.string() } },
    async ({ who }) => ({ messages: [{ role: "user", content: { type: "text", text: `say hi to ${who}` } }] }),
  );
  server.registerTool(
    "ask_name",
    { description: "演示 elicitation:向用户要名字", inputSchema: {} },
    async () => {
      const r = await server.server.elicitInput({
        message: "你叫什么名字?",
        requestedSchema: { type: "object", properties: { name: { type: "string", title: "Name" } }, required: ["name"] },
      });
      if (r.action !== "accept") return { content: [{ type: "text", text: `elicit:${r.action}` }] };
      return { content: [{ type: "text", text: `hi ${r.content?.name}` }] };
    },
  );
}

await server.connect(new StdioServerTransport());

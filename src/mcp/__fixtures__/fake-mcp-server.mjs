// 测试用的最小 stdio MCP server。connectMcpServers 会以 `node 本文件` 形式 spawn 它。
// 行为:
//  - 注册一个 echo 工具(回显 msg)。
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

await server.connect(new StdioServerTransport());

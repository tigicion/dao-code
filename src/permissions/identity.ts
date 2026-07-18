import type { CallIdentity } from "./rules.js";
import { stripSafeWrappers } from "./bash_preprocess.js";

// DAO 工具名 → CC 工具名 + 取哪个参数作匹配值。让 CC settings.json 的规则原样适用于 DAO 工具。
// 返回 null = 该工具无 CC 对应(memory/todo/agent 等),退回 DAO 能力默认放行逻辑。
const MAP: Record<string, { ccTool: string; arg: string }> = {
  Bash: { ccTool: "Bash", arg: "command" },
  Read: { ccTool: "Read", arg: "path" },
  Edit: { ccTool: "Edit", arg: "path" },
  MultiEdit: { ccTool: "Edit", arg: "path" }, // 归到 Edit:Edit 规则 + acceptEdits 自动覆盖
  NotebookEdit: { ccTool: "Edit", arg: "path" },
  Write: { ccTool: "Write", arg: "path" },
  ListDir: { ccTool: "LS", arg: "path" },
  Grep: { ccTool: "Grep", arg: "path" },
  Glob: { ccTool: "Glob", arg: "glob" },
  WebFetch: { ccTool: "WebFetch", arg: "url" },
  WebSearch: { ccTool: "WebSearch", arg: "query" },
};

export function toCcIdentity(toolName: string, argsJson: string): CallIdentity | null {
  // MCP 工具:规则直接写工具名(mcp__server__tool),无 specifier。
  if (toolName.startsWith("mcp__")) return { ccTool: toolName, value: "" };
  const spec = MAP[toolName];
  if (!spec) return null;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    /* 参数尚未成形/损坏:value 留空,仍可被裸工具名规则匹配 */
  }
  const raw = args[spec.arg];
  return { ccTool: spec.ccTool, value: typeof raw === "string" ? raw : "" };
}

// 交互"允许并记住"时,根据本次调用生成一条 allow 规则(写进 settings)。
// Bash=精确命令、WebFetch=domain、路径类=精确路径、无值=裸工具名;无 CC 对应→null。
export function rememberRule(toolName: string, argsJson: string): string | null {
  const id = toCcIdentity(toolName, argsJson);
  if (!id) return null;
  if (!id.value) return id.ccTool;
  if (id.ccTool === "WebFetch") {
    try {
      return `WebFetch(domain:${new URL(id.value).hostname})`;
    } catch {
      return `WebFetch(domain:${id.value})`;
    }
  }
  // WebSearch:任何查询都放行,记裸工具名——不持久化具体 query(否则换个搜索词就再问)。
  if (id.ccTool === "WebSearch") return "WebSearch";
  // Bash:能提炼出安全前缀就记 `Bash(prog sub:*)`(同类免再问);复合/超长/含 heredoc 的命令
  // 提炼不出通配前缀时,不能直接丢弃(返回 null)——那样用户选"总是允许"/"仅本次会话"会静默什么都
  // 不保存,同一条命令下次还会重新问一遍(体感就是"反复问")。退化成精确匹配当前命令原文:字节相同的
  // 重复调用直接放行,内容一变(哪怕只变一点)就不再匹配、重新走判断——不会把这条命令错误泛化成危险的
  // 通配规则,只是不再对"完全同一条命令"重复发问。
  if (id.ccTool === "Bash") { const p = bashPrefix(id.value); return `Bash(${p ? p : id.value})`; }
  return `${id.ccTool}(${id.value})`;
}

// 提炼放宽前缀(参考 getSimpleCommandPrefix + stripSafeWrappers):
// 先剥离安全包装器(timeout/time/nice/nohup)和安全环境变量,再取 "程序 + 首个非 flag 子命令"。
// 复合(管道/重定向/链接/替换)、含换行(heredoc)、或超长(>200)→ 返回 null(不持久化);
// 否则 程序 + 首个非 flag 子命令 + ":*"。
function bashPrefix(command: string): string | null {
  const stripped = stripSafeWrappers(command);
  if (!stripped || stripped.length > 200 || /[|&;<>`\n]|\$\(/.test(stripped)) return null;
  const toks = stripped.split(/\s+/);
  const prog = toks[0] ?? "";
  if (!prog) return null;
  const sub = toks[1] && !toks[1].startsWith("-") ? ` ${toks[1]}` : "";
  return `${prog}${sub}:*`;
}

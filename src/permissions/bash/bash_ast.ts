// bash_ast.ts — 桥接模块:将 AST 安全 walker 对接到 DAO 权限管线。
// 参考 bashPermissions.ts 中 AST 解析路径(步骤 0)。
//
// 在规则匹配前,先用 AST 解析命令:
//   - 简单命令(parseForSecurity 返回 'simple'):用 AST 提取的子命令替换 splitBashCommands,
//     更精确(引号已解析、变量已追踪、重定向已分离)。
//   - too-complex(含 $()、反引号、子 shell、控制流):fail-closed,转人工审批。
//   - parse-unavailable(parser 不可用):回退到 splitBashCommands(legacy 正则拆分)。

import { parseForSecurityFromAst, checkSemantics, type SimpleCommand, type ParseForSecurityResult } from "./ast.js";
import { parseCommandRaw, PARSE_ABORTED } from "./parser.js";
import { splitBashCommands } from "../rules.js";

export type { SimpleCommand } from "./ast.js";

export type BashParseResult =
  | { kind: "simple"; subcommands: string[] }
  | { kind: "too-complex"; reason: string }
  | { kind: "fallback" }; // AST 不可用,回退到 legacy 正则拆分

// 解析 bash 命令,返回安全 walker 结果。
// 参考 bashToolHasPermission 步骤 0(parseForSecurityFromAst)。
export async function parseBashForSecurity(command: string): Promise<BashParseResult> {
  if (!command || command.trim() === "") {
    return { kind: "simple", subcommands: [] };
  }

  const root = await parseCommandRaw(command);

  // parser 不可用(空/超长)→ 回退到 legacy
  if (root === null) {
    return { kind: "fallback" };
  }

  // 解析超时/节点超限(对抗性输入)→ fail-closed
  if (root === PARSE_ABORTED) {
    return {
      kind: "too-complex",
      reason: "Parser aborted (timeout or resource limit) — possible adversarial input",
    };
  }

  const astResult: ParseForSecurityResult = parseForSecurityFromAst(command, root);

  if (astResult.kind === "too-complex") {
    return { kind: "too-complex", reason: astResult.reason };
  }

  if (astResult.kind === "parse-unavailable") {
    return { kind: "fallback" };
  }

  // simple — 检查语义(zsh 内建命令、eval 类、jq system() 等)
  const sem = checkSemantics(astResult.commands);
  if (!sem.ok) {
    return { kind: "too-complex", reason: sem.reason };
  }

  // 提取子命令文本(用于规则匹配)
  const subcommands = astResult.commands.map((c) => c.text);
  return { kind: "simple", subcommands };
}

// 同步版本:用于无法 await 的场景(如 ruleMatches 直接调用)。
// 内部用 parseForSecurityFromAst(需要先 parseCommandRaw,是 async 的)。
// 这里提供一个纯 legacy 回退:调用方应优先用 async 版本。
export function parseBashSubcommandsSync(command: string): string[] {
  return splitBashCommands(command);
}

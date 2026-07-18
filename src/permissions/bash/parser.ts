// parser.ts — 薄封装:调用 bash_parser.ts 的纯 TS bash 解析器,产出 AST 根节点。
// 参考 parser.ts,去掉 feature flag / 遥测 / WASM init(纯 TS 始终可用)。

import {
  ensureParserInitialized,
  getParserModule,
  type TsNode,
} from "./bash_parser.js";

export type Node = TsNode;

export interface ParsedCommandData {
  rootNode: Node;
  envVars: string[];
  commandNode: Node | null;
  originalCommand: string;
}

const MAX_COMMAND_LENGTH = 10000;
const DECLARATION_COMMANDS = new Set([
  "export", "declare", "typeset", "readonly", "local", "unset", "unsetenv",
]);
const ARGUMENT_TYPES = new Set(["word", "string", "raw_string", "number"]);
const SUBSTITUTION_TYPES = new Set(["command_substitution", "process_substitution"]);
const COMMAND_TYPES = new Set(["command", "declaration_command"]);

// 纯 TS parser 无需 async init,但保留 API 兼容。
export async function ensureInitialized(): Promise<void> {
  await ensureParserInitialized();
}

export async function parseCommand(
  command: string,
): Promise<ParsedCommandData | null> {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null;
  await ensureParserInitialized();
  const mod = getParserModule();
  if (!mod) return null;
  try {
    const rootNode = mod.parse(command);
    if (!rootNode) return null;
    const commandNode = findCommandNode(rootNode, null);
    const envVars = extractEnvVars(commandNode);
    return { rootNode, envVars, commandNode, originalCommand: command };
  } catch {
    return null;
  }
}

// SECURITY: parser 超时/节点超限时返回此符号,调用方必须按 too-complex 处理(fail-closed)。
export const PARSE_ABORTED = Symbol("parse-aborted");

// 原始解析:跳过 findCommandNode/extractEnvVars(ast.ts 的安全 walker 不需要它们)。
// 返回 Node=成功,null=空/超长,PARSE_ABORTED=解析超时/节点超限(对抗性输入)。
export async function parseCommandRaw(
  command: string,
): Promise<Node | null | typeof PARSE_ABORTED> {
  if (!command || command.length > MAX_COMMAND_LENGTH) return null;
  await ensureParserInitialized();
  const mod = getParserModule();
  if (!mod) return null;
  try {
    const result = mod.parse(command);
    if (result === null) return PARSE_ABORTED;
    return result;
  } catch {
    return PARSE_ABORTED;
  }
}

function findCommandNode(node: Node, parent: Node | null): Node | null {
  const { type, children } = node;
  if (COMMAND_TYPES.has(type)) return node;
  if (type === "variable_assignment" && parent) {
    return (
      parent.children.find(
        (c) => COMMAND_TYPES.has(c.type) && c.startIndex > node.startIndex,
      ) ?? null
    );
  }
  if (type === "pipeline") {
    for (const child of children) {
      const result = findCommandNode(child, node);
      if (result) return result;
    }
    return null;
  }
  if (type === "redirected_statement") {
    return children.find((c) => COMMAND_TYPES.has(c.type)) ?? null;
  }
  for (const child of children) {
    const result = findCommandNode(child, node);
    if (result) return result;
  }
  return null;
}

function extractEnvVars(commandNode: Node | null): string[] {
  if (!commandNode || commandNode.type !== "command") return [];
  const envVars: string[] = [];
  for (const child of commandNode.children) {
    if (child.type === "variable_assignment") {
      envVars.push(child.text);
    } else if (child.type === "command_name" || child.type === "word") {
      break;
    }
  }
  return envVars;
}

export function extractCommandArguments(commandNode: Node): string[] {
  if (commandNode.type === "declaration_command") {
    const firstChild = commandNode.children[0];
    return firstChild && DECLARATION_COMMANDS.has(firstChild.text)
      ? [firstChild.text]
      : [];
  }
  const args: string[] = [];
  let foundCommandName = false;
  for (const child of commandNode.children) {
    if (child.type === "variable_assignment") continue;
    if (child.type === "command_name" || (!foundCommandName && child.type === "word")) {
      foundCommandName = true;
      args.push(child.text);
      continue;
    }
    if (ARGUMENT_TYPES.has(child.type)) {
      args.push(stripQuotes(child.text));
    } else if (SUBSTITUTION_TYPES.has(child.type)) {
      break;
    }
  }
  return args;
}

function stripQuotes(text: string): string {
  return text.length >= 2 &&
    ((text[0] === '"' && text.at(-1) === '"') ||
      (text[0] === "'" && text.at(-1) === "'"))
    ? text.slice(1, -1)
    : text;
}

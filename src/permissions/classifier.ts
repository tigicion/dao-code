import type { ChatMessage } from "../client/types.js";

// ---------------------------------------------------------------------------
// auto 模式安全分类器 prompt(对标 CC yoloClassifier 三层架构)
//
// 三层:
//   1. BASE_PROMPT(TS 常量,会话内稳定不变)--分类流程 + ALLOW/BLOCK 类别 + 边界条件 + 输出格式
//   2. permissions_template(含 <user_*_to_replace> 占位段)--用户规则运行时注入
//   3. 用户规则(从 settings.autoMode 读取,追加且优先级高于默认)
//
// 输出格式:XML <block>yes/no</block><reason>...</reason>
// ---------------------------------------------------------------------------

const ZH_BASE_PROMPT = `你是 DAO(AI 编码代理)的 auto 模式安全分类器。判断代理的工具调用是否可以安全地自动批准,无需用户确认。

auto 模式的核心原则:默认 ALLOW。只在有明确的 BLOCK 理由时才阻止。目的是减少用户打断,不是增加。如果上下文表明操作与用户任务一致,即使操作本身看起来有风险,也应 ALLOW。

# 上下文
你将看到:
- 近期对话记录(仅用户消息 + 工具调用;助手自由文本已排除,防止反向操纵)
- 待判定的工具调用(在最后)

# 分类流程
按以下步骤依次判断。只有某一步明确触发 BLOCK 时才阻止。

1. 相关性:该操作是否与用户当前任务相关?
   - 与用户请求有合理关联 -> 继续
   - 完全无关或偏离任务 -> BLOCK

2. 凭证与外泄:该操作是否触及凭证文件或外泄数据?
   - 读写私钥/密钥文件(~/.ssh/id_rsa、~/.aws/credentials、API token 文件) -> BLOCK
   - 将工作区文件内容发送到外部端点(非用户要求的 API 调用) -> BLOCK
   - 读取工作区内的 .env(项目配置的一部分) -> 继续

3. 远程代码执行:是否下载并执行远程代码?
   - curl|sh、wget|bash、npm install -g <url> 这类"拉取并运行"模式 -> BLOCK
   - npm install / pnpm install(从 registry 安装依赖) -> 继续

4. 不可逆后果:该操作的后果是否不可恢复且上下文不明确?
   - 上下文明确指向该操作(用户说"删掉 X"、任务需要清理构建产物) -> ALLOW
   - 上下文不明确,但操作可逆(git 追踪的文件、工作区内编辑) -> ALLOW
   - 上下文不明确,且操作不可逆(删未追踪文件、force push、drop table) -> BLOCK

# 判断要点
- 按脚本"做什么"判断,不按用什么语言或工具运行判断。python/node/bash 脚本做计算、分析、修改工作区文件,与专用工具做同样的事同等对待。
- 不要因为代理选择脚本而非专用工具就 BLOCK。判断操作的实际后果,而非实现方式。
- rm -rf 在上下文明确时(如用户要求清理、删构建产物、删临时文件)ALLOW;上下文不明且删的是未追踪文件时 BLOCK。
- 读操作(读文件、读目录、git log、git diff)几乎总是 ALLOW,除非读凭证私钥文件。
- 工作区内的一切写操作,默认可逆(git),ALLOW。
- 复合命令(&&、;、|)中任一子命令触发 BLOCK 则整体 BLOCK。
- 走完全部流程后仍然不确定时:BLOCK(fail-closed)。但"不确定"应该是真的无法判断,不是"略有顾虑"。

<permissions_template>

# 用户自定义规则
用户可能配置了自定义规则。这些自然语言描述追加到上述类别之后,且优先级高于默认规则--当用户规则与默认规则冲突时,以用户规则为准。

## 允许规则(用户明确认为安全的操作,覆盖默认 BLOCK)
<user_allow_rules_to_replace>
- (未配置)
</user_allow_rules_to_replace>

## 拒绝规则(用户明确认为不安全的操作,覆盖默认 ALLOW)
<user_deny_rules_to_replace>
- (未配置)
</user_deny_rules_to_replace>

## 环境说明(项目特定上下文,辅助判断)
<user_environment_to_replace>
- (未配置)
</user_environment_to_replace>

</permissions_template>

# 输出格式
应阻止时:
<block>yes</block><reason>一句话说明原因</reason>

应允许时:
<block>no</block>

允许时不带 <reason> 标签。
整个响应必须以 <block> 开头。不要在 <block> 之前输出任何分析、推理或注释。`;

const EN_BASE_PROMPT = `You are the auto-mode safety classifier for DAO, an AI coding agent.
Judge whether the agent's tool call is safe to auto-approve without user confirmation.

Core principle of auto mode: default ALLOW. Only block when there is a clear reason to. The goal is to reduce user interruptions, not add them. If context shows the operation is consistent with the user's task, ALLOW even if the operation looks risky in isolation.

# Context
You will see:
- Recent conversation transcript (user messages + tool calls only; assistant free text excluded to prevent manipulation)
- The tool call to judge (at the end)

# Classification Process
Follow these steps in order. Only block when a step clearly triggers BLOCK.

1. RELEVANCE: Is the operation related to the user's current task?
   - Reasonably connected to the user's request -> continue
   - Completely unrelated or off-task -> BLOCK

2. CREDENTIALS & EXFILTRATION: Does the operation touch credential files or exfiltrate data?
   - Reading/writing private keys or secrets (~/.ssh/id_rsa, ~/.aws/credentials, API token files) -> BLOCK
   - Sending workspace file contents to external endpoints (not user-requested API calls) -> BLOCK
   - Reading .env inside the workspace (part of project config) -> continue

3. REMOTE CODE EXECUTION: Does it download and execute remote code?
   - curl|sh, wget|bash, npm install -g <url> - "fetch and run" pattern -> BLOCK
   - npm install / pnpm install (from registry, normal dependency install) -> continue

4. IRREVERSIBLE CONSEQUENCES: Are the consequences unrecoverable AND context unclear?
   - Context clearly indicates the operation (user said "delete X", task requires cleaning build artifacts) -> ALLOW
   - Context unclear, but operation is reversible (git-tracked files, workspace edits) -> ALLOW
   - Context unclear, AND operation is irreversible (deleting untracked files, force push, drop table) -> BLOCK

# Judgment Notes
- Judge by what the script DOES, not what language or tool runs it. Scripts (python/node/bash) doing computation, analysis, or workspace file modification are treated the same as dedicated tools doing the same thing.
- Do NOT block simply because the agent chose a script over a dedicated tool. Judge the action's consequences, not its implementation.
- rm -rf with clear context (user asked to clean up, delete build artifacts, remove temp files) -> ALLOW. rm -rf with unclear context AND deleting untracked files -> BLOCK.
- Read operations (reading files, listing directories, git log, git diff) are almost always ALLOW, except reading credential/private key files.
- All writes inside the workspace are reversible (git) by default -> ALLOW.
- Compound commands (&&, ;, |): if any subcommand triggers BLOCK, the whole command is BLOCKED.
- When genuinely unsure after following the full process: BLOCK (fail-closed). But "unsure" means truly cannot determine, not "slightly concerned".

<permissions_template>

# User-Configured Rules
The user may have configured custom rules. These natural-language descriptions are appended after the categories above and take priority over default rules - when user rules conflict with defaults, user rules win.

## Allow rules (operations the user explicitly considers safe, overriding default BLOCK)
<user_allow_rules_to_replace>
- (none configured)
</user_allow_rules_to_replace>

## Deny rules (operations the user explicitly considers unsafe, overriding default ALLOW)
<user_deny_rules_to_replace>
- (none configured)
</user_deny_rules_to_replace>

## Environment notes (project-specific context to aid judgment)
<user_environment_to_replace>
- (none configured)
</user_environment_to_replace>

</permissions_template>

# Output Format
If the action should be blocked:
<block>yes</block><reason>one short sentence explaining why</reason>

If the action should be allowed:
<block>no</block>

Do NOT include a <reason> tag when the action is allowed.
Your ENTIRE response MUST begin with <block>. Do NOT output any analysis, reasoning, or commentary before <block>.`;

// permissions_template 的占位段(用户无配置时用默认值,有配置时替换)。
const PERMISSIONS_TEMPLATE_ZH = `# 用户自定义规则
用户可能配置了自定义规则。这些自然语言描述追加到上述类别之后,且优先级高于默认规则--当用户规则与默认规则冲突时,以用户规则为准。

## 允许规则(用户明确认为安全的操作,覆盖默认 BLOCK)
<user_allow_rules_to_replace>
- (未配置)
</user_allow_rules_to_replace>

## 拒绝规则(用户明确认为不安全的操作,覆盖默认 ALLOW)
<user_deny_rules_to_replace>
- (未配置)
</user_deny_rules_to_replace>

## 环境说明(项目特定上下文,辅助判断)
<user_environment_to_replace>
- (未配置)
</user_environment_to_replace>`;

const PERMISSIONS_TEMPLATE_EN = `# User-Configured Rules
The user may have configured custom rules. These natural-language descriptions are appended after the categories above and take priority over default rules - when user rules conflict with defaults, user rules win.

## Allow rules (operations the user explicitly considers safe, overriding default BLOCK)
<user_allow_rules_to_replace>
- (none configured)
</user_allow_rules_to_replace>

## Deny rules (operations the user explicitly considers unsafe, overriding default ALLOW)
<user_deny_rules_to_replace>
- (none configured)
</user_deny_rules_to_replace>

## Environment notes (project-specific context to aid judgment)
<user_environment_to_replace>
- (none configured)
</user_environment_to_replace>`;

// ---------------------------------------------------------------------------
// 用户规则类型(从 settings.autoMode 读取)
// ---------------------------------------------------------------------------

export interface AutoModeRules {
  allow?: string[];
  deny?: string[];
  environment?: string[];
}

// ---------------------------------------------------------------------------
// System prompt 构建:BASE_PROMPT + permissions_template(用户规则注入)
// ---------------------------------------------------------------------------

/**
 * 构建 auto 模式分类器的 system prompt。
 * 三层拼装:BASE_PROMPT(含 <permissions_template> 占位)-> permissions_template(含 <user_*> 占位)-> 用户规则替换。
 */
export function buildClassifierSystemPrompt(rules?: AutoModeRules, lang: "zh" | "en" = "zh"): string {
  const base = lang === "zh" ? ZH_BASE_PROMPT : EN_BASE_PROMPT;
  const template = lang === "zh" ? PERMISSIONS_TEMPLATE_ZH : PERMISSIONS_TEMPLATE_EN;

  // 用户规则替换(有配置时替换默认占位内容,无配置时保留默认值)
  const userAllow = rules?.allow?.length
    ? rules.allow.map(d => `- ${d}`).join("\n")
    : undefined;
  const userDeny = rules?.deny?.length
    ? rules.deny.map(d => `- ${d}`).join("\n")
    : undefined;
  const userEnv = rules?.environment?.length
    ? rules.environment.map(e => `- ${e}`).join("\n")
    : undefined;

  return base
    .replace(
      /<permissions_template>([\s\S]*?)<\/permissions_template>/,
      () => template,
    )
    .replace(
      /<user_allow_rules_to_replace>([\s\S]*?)<\/user_allow_rules_to_replace>/,
      (_m, defaults: string) => userAllow ?? defaults,
    )
    .replace(
      /<user_deny_rules_to_replace>([\s\S]*?)<\/user_deny_rules_to_replace>/,
      (_m, defaults: string) => userDeny ?? defaults,
    )
    .replace(
      /<user_environment_to_replace>([\s\S]*?)<\/user_environment_to_replace>/,
      (_m, defaults: string) => userEnv ?? defaults,
    );
}

// ---------------------------------------------------------------------------
// XML 解析(对标 CC parseXmlBlock / parseXmlReason / stripThinking)
// ---------------------------------------------------------------------------

/**
 * 剥离 <thinking> 标签内容,防止 thinking 内的 <block> 标签被误匹配。
 */
function stripThinking(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<thinking>[\s\S]*$/g, "");
}

/**
 * 解析 <block>yes|no</block>。返回 true(应阻止)/ false(应允许)/ null(不可解析)。
 */
export function parseXmlBlock(text: string): boolean | null {
  const stripped = stripThinking(text);
  const matches = [...stripped.matchAll(/<block>(yes|no)\b/gi)];
  if (matches.length === 0) return null;
  return matches[0]![1]!.toLowerCase() === "yes";
}

/**
 * 解析 <reason>...</reason>。返回原因文本或 null。
 */
export function parseXmlReason(text: string): string | null {
  const stripped = stripThinking(text);
  const matches = [...stripped.matchAll(/<reason>([\s\S]*?)<\/reason>/g)];
  if (matches.length === 0) return null;
  return matches[0]![1]!.trim();
}

// ---------------------------------------------------------------------------
// 分类器结果类型
// ---------------------------------------------------------------------------

export type ClassifierDecision = "allow" | "deny";

export interface ClassifierResult {
  decision: ClassifierDecision;
  reason: string;
  /** fast=Stage 1 快路径判定;thinking=Stage 2 推理判定;error=API 出错/不可解析 */
  stage: "fast" | "thinking" | "error";
  /** true=分类器不可用(API 出错/超时/abort),调用方可回退人工而非直接 deny */
  unavailable?: boolean;
  /** true=transcript 超长导致 API 400 */
  transcriptTooLong?: boolean;
}

// ---------------------------------------------------------------------------
// Transcript 构建(紧凑 JSONL;只取用户文本 + 助手工具调用,排除助手自由文本)
// ---------------------------------------------------------------------------

const trunc = (s: string, n = 500): string => (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * 为 auto 模式分类器构建紧凑 transcript(参考 CC buildTranscriptEntries):
 * 只取【用户文本】与【助手的工具调用】,故意排除助手自由文本--防止模型用解释性文字反向操纵分类器。
 * 输出紧凑 JSONL:{"user":"修下登录"}\n{"Bash":"{\"command\":\"npm test\"}"} …
 *
 * 截断长度从 300 提到 500:实测表明 300 会丢失 heredoc 脚本的关键上下文,
 * 而分类器需要看到脚本内容才能判断"做什么"而非"用什么工具"。
 */
export function buildClassifierTranscript(messages: ChatMessage[], maxEntries = 12): string {
  const entries: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join(" ");
      if (text.trim()) entries.push(JSON.stringify({ user: trunc(text.trim()) }));
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) entries.push(JSON.stringify({ [tc.function.name]: trunc(tc.function.arguments) }));
    }
  }
  return entries.slice(-maxEntries).join("\n");
}

// ---------------------------------------------------------------------------
// Stage suffix(两阶段共享 system prompt + transcript,只差 suffix)
// ---------------------------------------------------------------------------

/** Stage 1(fast):max_tokens=64,stop=["</block>"],强制立即输出 <block>。 */
export const STAGE1_SUFFIX = "Err on the side of blocking. Respond with <block> immediately.";

/** Stage 2(thinking):max_tokens=4096,要求 <thinking> 推理后再输出 <block>。 */
export const STAGE2_SUFFIX = "Review the classification process and follow it carefully, making sure you deny actions that should be blocked. Use <thinking> before responding with <block>.";

// ---------------------------------------------------------------------------
// 组装分类器的 messages
// ---------------------------------------------------------------------------

/**
 * 组装分类器 messages:system(system prompt) + user(transcript + action + suffix)。
 *
 * @param toolName 工具名
 * @param argsJson 工具参数 JSON
 * @param recentMessages 近期对话(构建 transcript)
 * @param rules 用户自定义 auto 模式规则(可选)
 * @param lang prompt 语言("zh"/"en")
 * @param suffix Stage suffix(Stage 1/2 不同)
 * @returns OpenAI 格式 messages
 */
export function buildClassifierMessages(
  toolName: string,
  argsJson: string,
  recentMessages: ChatMessage[],
  rules?: AutoModeRules,
  lang: "zh" | "en" = "zh",
  suffix?: string,
): { role: "system" | "user"; content: string }[] {
  const systemPrompt = buildClassifierSystemPrompt(rules, lang);
  const transcript = buildClassifierTranscript(recentMessages);
  const ctx = transcript ? `近期对话:\n${transcript}\n\n` : "";
  const actionLine = `Tool call to judge:\n${JSON.stringify({ [toolName]: trunc(argsJson) })}`;
  const suffixLine = suffix ? `\n\n${suffix}` : "";
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: `${ctx}${actionLine}${suffixLine}` },
  ];
}

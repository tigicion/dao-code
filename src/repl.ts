import { dispatchCommand } from "./commands/commands.js";
import type { Session } from "./session/session.js";

export interface ReplDeps {
  session: Session;
  // 读一行用户输入;EOF 返回 null。
  readLine: () => Promise<string | null>;
  // 在 session 上跑一个回合(由 index 绑定真实依赖)。
  runTurn: () => Promise<void>;
  // 执行一次压缩(由 index 绑定:压缩 session.messages 并打印结果)。
  compact: () => Promise<void>;
  write: (s: string) => void;
  // UserPromptSubmit 钩子裁决(由 index 绑定;省略=不裁决):
  // blocked 则跳过本回合;additionalContext 作上下文注入。在每个真实提示入回合前调用。
  gateUserPrompt?: (text: string) => Promise<{ blocked: boolean; reason?: string; additionalContext?: string }>;
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  for (;;) {
    const line = await deps.readLine();
    if (line === null) return; // EOF
    const cmd = dispatchCommand(line, deps.session);
    if (cmd.handled) {
      if (cmd.compact) {
        await deps.compact();
        continue;
      }
      if (cmd.output) deps.write(cmd.output + "\n");
      if (cmd.exit) return;
      continue;
    }
    if (!line.trim()) continue;
    if (deps.gateUserPrompt) {
      const up = await deps.gateUserPrompt(line);
      if (up.blocked) { deps.write(`[提交被 hook 阻止] ${up.reason || ""}\n`); continue; }
      deps.session.addUser(line);
      if (up.additionalContext) deps.session.messages.push({ role: "system", content: `[hook 注入的上下文]\n${up.additionalContext}` });
    } else {
      deps.session.addUser(line);
    }
    await deps.runTurn();
  }
}

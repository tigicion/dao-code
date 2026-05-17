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
    deps.session.addUser(line);
    await deps.runTurn();
  }
}

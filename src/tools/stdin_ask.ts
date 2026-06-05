import { createInterface } from "node:readline/promises";

// 命令行版 ask:打印问题,读一行回答。供 index 注入到 ctx.ask。
export async function stdinAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n${question}\n> `);
    return await rl.question("");
  } finally {
    rl.close();
  }
}

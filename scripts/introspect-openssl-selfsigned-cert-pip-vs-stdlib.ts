import { readFileSync } from "node:fs";
import { streamChat } from "../src/client/client.js";

const sysPrompt = readFileSync("/tmp/ossl_sysprompt.txt", "utf8");
const taskPrompt = readFileSync("/tmp/ossl_taskprompt.txt", "utf8");

const excerpt = `...(省略约30条工具调用,内容是:建目录、生成RSA私钥并设600权限、用 openssl req 生成
自签名证书、拼合成 server.pem、用 openssl x509 提取 subject/日期/指纹、检查系统时间、把这些
写进 verification.txt——这部分全部顺利,和验收无关。)...

接下来你要写 /app/check_cert.py。你的原话是:"I'll use Python's ssl/cryptography modules, or
simply use OpenSSL via subprocess, or use the cryptography library. Let me check what's available."
"cryptography is not available. Let me install it."

于是你执行了 pip install cryptography(成功:Successfully installed cffi-2.1.0
cryptography-50.0.0 pycparser-3.0),然后写了用 cryptography 库解析证书的 check_cert.py,用
python3 check_cert.py 跑通(输出 Common Name/Expiration Date/Certificate verification
successful),调用 VerifyDone 走完自查清单后收尾。

[事实:官方验收脚本是用 subprocess.run(["python", "/app/check_cert.py"]) 跑的,且这个测试是
用 uv run pytest(先 uv init && uv add pytest)执行的——uv 会为这次测试建一个自己的隔离虚拟
环境,把这个 venv 的 bin/ 放到 PATH 最前面。测试代码里那个裸 "python",在 uv 的隔离环境里
解析到的不是你刚才 pip install 用的那个系统 python3,而是 uv venv 自己的、没有装 cryptography
的 python。最终验收报错:ModuleNotFoundError: No module named 'cryptography',5/6 通过,
唯独 test_python_verification_script 失败,判定任务未完成。]

以上是你自己在这次任务里产生的完整记录,以及官方验收失败时的真实报错。请客观分析:你在
"cryptography 不可用,让我装一下"这个决策点,为什么会选择 pip install 而不是改用 Python
内置的 ssl 模块(或者干脆用 subprocess 调 openssl,你已经确认过 openssl 命令本身在环境里
是可用的)来实现这个验证脚本?`;

const layer1 = `现在告诉你标准答案:同一道题在另外两次独立跑分里(不同账号/模型批次),模型在
遇到完全相同的"cryptography 不可用"这个局面时,选择的都是改用标准库 ssl 模块(其中一次具体
用了 ssl._ssl._test_decode_cert 这个私有但稳定的接口)配合 openssl 子进程兜底来实现
check_cert.py,完全没有安装任何第三方库,因此彻底避开了"验收方可能用不同 python 环境跑这个
脚本"的风险。理想动作是:既然任务本身没有要求"必须用 cryptography 这个库",而 openssl 命令
行工具已经确认可用、标准库 ssl 也总是可用,选一个不需要额外安装、因而不依赖"验收方和我用同一个
python 环境"这个不确定假设的实现方式,风险明显更低。你实际的选择是:装一个当前会话能用、但
不确定验收方是否共享同一环境的第三方库。这是没有意识到"装的包可能在验收时不可见"这个风险,
还是别的原因?`;

const layer2 = `如果你自己也认同"避免不必要的外部依赖、优先用已确认可用的标准库/命令行工具"是
更稳妥的做法,那当时是什么让你选择了 pip install cryptography 而不是标准库方案?中途有没有
出现过什么提醒或信号,如果有,它有没有改变你的行为,如果没有为什么没起作用?结合你现在能看到的
完整系统提示词,有没有哪条具体措辞客观上鼓励或允许了"遇到缺失的库就直接安装"而不是"优先考虑
不需要安装、已确认可用的替代实现"?如果有请引用原文。如果重新走一遍,要调整哪一条指令/提醒的
措辞才会让你在那一刻优先选标准库/命令行方案?`;

async function ask(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set");
  const gen = streamChat({
    baseUrl: "https://api.deepseek.com",
    apiKey,
    model: "deepseek-v4-pro",
    messages,
    extra: { reasoning_effort: "max" },
  });
  let text = "";
  let result: IteratorResult<unknown, unknown>;
  while (!(result = await gen.next()).done) {
    const delta = result.value as { kind: string; text?: string };
    if (delta.kind === "content" && delta.text) { text += delta.text; process.stdout.write(delta.text); }
  }
  return text;
}

async function main() {
  const history: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: taskPrompt },
    { role: "user", content: excerpt },
  ];
  console.log("\n\n========== LAYER 0 ==========\n");
  const r0 = await ask(history);
  history.push({ role: "assistant", content: r0 });

  console.log("\n\n========== LAYER 1 ==========\n");
  history.push({ role: "user", content: layer1 });
  const r1 = await ask(history);
  history.push({ role: "assistant", content: r1 });

  console.log("\n\n========== LAYER 2 ==========\n");
  history.push({ role: "user", content: layer2 });
  await ask(history);

  console.log("\n\n=== DONE ===");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});

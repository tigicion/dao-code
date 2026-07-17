import { exec } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.js";
import { spillOutput } from "./spill.js";
import { msg } from "./lang.js";

// 验证驱动的"完成定义"(DoD):
// - 若配置了可执行验收命令(ctx.verifyCommand,经 /dod 或 DAO_VERIFY_CMD 设置)→ 跑它,exit 0 = 通过。
// - 未配置 → 返回提示,要求模型据实际证据自行判断完成。
// 声称任务完成前应先调用本工具(见系统 prompt 的验证纪律)。
export const verifyDoneTool = defineTool({
  name: "verify_done",
  description:
    "判断任务是否真正完成。配置了验收命令(/dod 或 DAO_VERIFY_CMD 设置)时真的跑它(300 秒超时,输出会截断)," +
    "exit 0=通过、非 0=未完成继续修;没配置时不会帮你瞎判断,而是提醒你必须拿【实际证据】自己判——读代码≠验证," +
    "真把它跑起来、读回改动、看输出,不能用'看起来对/应该没问题/我的测试过了'代替独立验证。每次声称任务完成前都调用它," +
    "不是只在一长串工作的最后调一次——中途每完成一个可验证的子目标就调一次,别攒到最后才发现前面某步其实没做对。" +
    "举例:改完一个函数就该跑一下它的单测,而不是等改完十个文件、准备收尾时才第一次验证,那样出问题定位成本高得多。" +
    "这里的通过只代表配置的命令退出码是 0,不代表功能真的做对了——如果命令本身太浅(比如只跑了类型检查),通过了也不等于验证完整。" +
    "尤其注意:如果你自己动手做过检查(跑过测试、探测过连接、diff 过关键约束)、结果是失败/超时/不匹配,这个负面结果" +
    "本身就是明确的信号——不能因为'已经很晚了/已经改了很多次/其它部分都对了'就把它当没看见、照样收尾。" +
    "拿到负面结果意味着还没做完,该做的是继续修或如实说明卡在哪,不是重新描述一遍意图就当验证过了。" +
    "如果发现跑验证需要的解释器/工具压根没装(比如没有 python3、没有某个库),先试着装上再验证" +
    "(apt-get/pip/npm 等),不要因为环境暂时缺东西就退回'只读代码走查、不实际执行'——静态走查发现不了" +
    "运行时才会暴露的问题,'装不上'和'没试着装'是两回事,后者不该被当成前者的理由跳过真实执行。" +
    "验证不光要方法对(真跑、别只读代码),范围也要对:先把用户任务原文里的每一条具体要求逐条过一遍," +
    "对每一条说出你验证过的具体证据,不要凭记忆挑几条你觉得重要的就当验证完整了。最容易漏的是那些" +
    "不影响'能不能跑通/测试过不过'、但任务原文明确提到的结构性/格式性要求(比如某个目录或文件是否" +
    "按要求保留、某种来源/格式是否满足)——这类要求不会被'跑测试'自然覆盖,必须专门回去对照原文检查," +
    "不能因为你确信自己做对了就跳过这个物证核对的动作。",
  descriptionEn:
    "Determines whether a task is truly complete. If an acceptance command is configured (via /dod or DAO_VERIFY_CMD), actually runs it (300s timeout, output truncated), " +
    "exit 0=pass, non-zero=not done yet, keep fixing; if none is configured, it won't quietly let you self-approve — instead it reminds you to judge based on [actual evidence]: " +
    "reading code ≠ verifying it, actually run it / read back the change / check the output — don't substitute 'looks right' / 'should be fine' / 'my tests passed' for " +
    "independent verification. Call this before every claim of completion, not just once at the end of a long task — call it after each verifiable sub-goal along the way, " +
    "rather than discovering at the very end that an earlier step wasn't actually right. Example: run a function's unit tests right after changing it, rather than " +
    "waiting until ten files later when you're wrapping up to verify for the first time — much more expensive to pinpoint the problem that way. A pass here means the " +
    "configured command exited 0, nothing more — it doesn't certify the feature is actually correct if the command itself is too shallow (e.g. only a type check). " +
    "In particular: if you already ran a real check yourself (a test, a connectivity probe, a diff against a ground-truth constraint) and it came back failed/timed-out/" +
    "mismatched, that negative result IS the signal — don't wave it away just because it's late, you've iterated many times already, or everything else checks out. " +
    "A negative result means the task isn't done; the move is to keep fixing it or honestly report what's blocking, not restate your intent and call it verified. " +
    "If the interpreter/tool you need to actually run the verification isn't installed (no python3, missing a library), try installing it first (apt-get/pip/npm/etc.) " +
    "before falling back to \"just read the code, don't actually execute it\" — static review can't catch bugs that only surface at runtime, and \"couldn't install it\" " +
    "is a different claim from \"didn't try\"; the latter isn't a valid reason to skip real execution. Getting the method right (actually run it) isn't enough — the " +
    "scope has to be right too: go back through every specific requirement in the user's original task text one by one, and state what evidence you have for each — " +
    "don't just pick the few you remember as important. The ones most often missed are structural/format requirements the task explicitly stated but that don't affect " +
    "whether it \"runs\"/\"tests pass\" (e.g. whether a specific directory/file was kept as required, whether a source/format requirement is satisfied) — running tests " +
    "won't naturally cover these, you have to go back and check them against the original text specifically; being confident you did it right isn't a substitute for " +
    "that check.",
  capability: "read",
  approval: "auto",
  schema: z.object({}),
  handler: async (_args, ctx) => {
    const cmd = ctx.verifyCommand?.trim();
    if (!cmd) {
      return msg(
        "(未配置可执行验收命令)据【实际证据】自判,别自我合理化:读≠验证——真把它跑起来 / 读回改动 / 看输出。别用\"代码看起来对、大概没问题、我的测试过了\"代替验证;独立验一遍,再说明完成依据。" +
          "方法对了还不够,范围也要对:现在回去把用户任务原文的每一条具体要求过一遍,对每一条说出你的证据——" +
          "尤其是那些不影响\"跑不跑得通\"、但原文明确提到的结构性/格式性要求,这类要求不会被你已经做过的测试自然覆盖。",
        "(No executable acceptance command configured) Self-judge based on [actual evidence]; don't self-rationalize: reading ≠ verification — actually run it / read back changes / check output. Don't substitute \"code looks right\", \"should be fine\", or \"my tests passed\" for verification; independently verify, then state the basis for completion. " +
          "Getting the method right isn't enough — the scope has to be right too: go back through every specific requirement in the user's original task text and state your evidence for each — " +
          "especially structural/format requirements the task explicitly stated that don't affect whether it \"runs\", which won't be naturally covered by tests you've already run.",
      );
    }
    return await new Promise<string>((resolve) => {
      const child = exec(
        cmd,
        { cwd: ctx.workspaceRoot, timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          const body = [stdout, stderr].filter((s) => s && s.trim()).join("\n").trimEnd();
          resolve(`$ ${cmd}\n${spillOutput(body, ctx.workspaceRoot)}\n${msg(`[验收${code === 0 ? "通过" : "失败"} exit ${code}]`, `[Verification ${code === 0 ? "PASSED" : "FAILED"} exit ${code}]`)}`);
        },
      );
      ctx.signal?.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch {} }, { once: true });
    });
  },
});

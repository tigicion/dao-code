import { z } from "zod";
import { defineTool } from "./types.js";
import { msg } from "./lang.js";

// 完成前的验证检查点。
//
// 历史:这个工具在 a75c435(2026-07-18)被移除,理由是"CC 没有 verify_done,完成确认靠
// verification 子代理 + prompt 纪律",DAO 对齐该机制。2026-07-27 用真实 trace 复盘发现这次
// 对齐把一个真实被使用的动作换成了一个几乎不被使用的动作:
//   · 移除前 240 个 trial 里,130 个(54.2%)真的调用过它;
//   · 移除后 107 个 trial 里,只有 1 个(0.9%)派过验证子代理。
// 提示词里明明还写着"请派 verify 子代理验证后收尾",模型被告知了却不做——这是 affordance
// 失败,不是纪律失败:一个一等公民工具能拿到 54% 采纳率,"去派一个叫 verify 的子代理"只有
// 0.9%。因此恢复这个一等公民入口,verify 子代理保持不变,两者并存不冲突。
//
// 与被移除的版本的区别:当时支持 ctx.verifyCommand(经 /dod 或 DAO_VERIFY_CMD 配置一条可执行
// 验收命令)。那条链路连同字段已在同一次提交里整体移除,这里不重新引入——真实使用中占绝对多数
// 的本来就是"没有配置验收命令"这一支,它的价值在于强制模型在声称完成前过一遍证据清单。
export const verifyDoneTool = defineTool({
  name: "VerifyDone",
  description:
    "声称任务完成前的验证检查点。它不会替你判断做没做对,而是要求你拿【实际证据】自己判——读代码≠验证," +
    "真把它跑起来、读回改动、看输出,不能用\"看起来对/应该没问题/我的测试过了\"代替独立验证。" +
    "每次声称完成前都调用它,不是只在一长串工作的最后调一次——中途每完成一个可验证的子目标就调一次," +
    "别攒到最后才发现前面某步其实没做对。举例:改完一个函数就该跑一下它的单测,而不是等改完十个文件、" +
    "准备收尾时才第一次验证,那样出问题定位成本高得多。" +
    "尤其注意:如果你自己动手做过检查(跑过测试、探测过连接、diff 过关键约束)、结果是失败/超时/不匹配," +
    "这个负面结果本身就是明确的信号——不能因为\"已经很晚了/已经改了很多次/其它部分都对了\"就把它当没看见、" +
    "照样收尾。拿到负面结果意味着还没做完,该做的是继续修或如实说明卡在哪,不是重新描述一遍意图就当验证过了。" +
    "如果发现跑验证需要的解释器/工具压根没装(比如没有 python3、没有某个库),先试着装上再验证" +
    "(apt-get/pip/npm 等),不要因为环境暂时缺东西就退回\"只读代码走查、不实际执行\"——静态走查发现不了" +
    "运行时才会暴露的问题,\"装不上\"和\"没试着装\"是两回事,后者不该被当成前者的理由跳过真实执行。" +
    "验证不光要方法对(真跑、别只读代码),范围也要对:先把用户任务原文里的每一条具体要求逐条过一遍," +
    "对每一条说出你验证过的具体证据,不要凭记忆挑几条你觉得重要的就当验证完整了。最容易漏的是那些" +
    "不影响\"能不能跑通/测试过不过\"、但任务原文明确提到的结构性/格式性要求(比如某个目录或文件是否" +
    "按要求保留、某种来源/格式是否满足)——这类要求不会被\"跑测试\"自然覆盖,必须专门回去对照原文检查," +
    "不能因为你确信自己做对了就跳过这个物证核对的动作。还有一种更隐蔽的情况:调查途中自己" +
    "已经发现了某条具体的、指向\"可能没做对\"的线索(比如读到一份配置文件暗示某个目录结构跟" +
    "你实际做的不一样),但当下觉得\"这个大概不重要/不是我们要测的东西\",于是没有查到底就转头" +
    "写一份自己重新定义的总结清单收尾——这不是意外遗漏,是明知有疑点却没有查完就合理化掉了。" +
    "发现这类具体疑点时,不能凭感觉判断\"重不重要\",要把它查到有确定结论为止;查完之后,收尾前" +
    "必须再调用一次本工具重新核实,不能让\"自己写的总结表格\"代替最后一次真实调用。",
  descriptionEn:
    "A verification checkpoint to call before claiming a task is complete. It won't judge correctness for you — it requires you to judge from [actual evidence]: " +
    "reading code ≠ verifying it; actually run it, read back the change, check the output. Don't substitute 'looks right' / 'should be fine' / 'my tests passed' for " +
    "independent verification. Call this before every claim of completion, not just once at the end of a long task — call it after each verifiable sub-goal along the way, " +
    "rather than discovering at the very end that an earlier step wasn't actually right. Example: run a function's unit tests right after changing it, rather than " +
    "waiting until ten files later when you're wrapping up to verify for the first time — much more expensive to pinpoint the problem that way. " +
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
    "that check. There's also a subtler case: mid-investigation you already noticed a specific clue pointing at " +
    "\"this might not be right\" (e.g. a config file implying a directory layout different from what you actually did), but at the " +
    "time thought \"that's probably not important / not what we're being tested on\" and moved on to write your own redefined summary " +
    "checklist instead of chasing it to a conclusion — that's not an oversight, it's rationalizing away a doubt you already had. " +
    "When you notice a concrete clue like that, don't judge its importance by feel — chase it to a definite conclusion; then, before " +
    "wrapping up, call this tool again to re-verify — don't let a self-written summary table stand in for that final real call.",
  capability: "read",
  approval: "auto",
  schema: z.object({}),
  handler: async () =>
    msg(
      "据【实际证据】自判,别自我合理化:读≠验证——真把它跑起来 / 读回改动 / 看输出。别用\"代码看起来对、大概没问题、我的测试过了\"代替验证;独立验一遍,再说明完成依据。" +
        "方法对了还不够,范围也要对:现在回去把用户任务原文的每一条具体要求过一遍,对每一条说出你的证据——" +
        "尤其是那些不影响\"跑不跑得通\"、但原文明确提到的结构性/格式性要求,这类要求不会被你已经做过的测试自然覆盖。" +
        "如果调查途中已经注意到某条具体线索指向'可能没做对',不要凭感觉觉得'大概不重要'就跳过——查到有确定" +
        "结论为止,查完后再调用一次本工具重新核实,不能用自己写的总结表格代替这最后一次真实调用。",
      "Self-judge based on [actual evidence]; don't self-rationalize: reading ≠ verification — actually run it / read back changes / check output. Don't substitute \"code looks right\", \"should be fine\", or \"my tests passed\" for verification; independently verify, then state the basis for completion. " +
        "Getting the method right isn't enough — the scope has to be right too: go back through every specific requirement in the user's original task text and state your evidence for each — " +
        "especially structural/format requirements the task explicitly stated that don't affect whether it \"runs\", which won't be naturally covered by tests you've already run. " +
        "If you already noticed a concrete clue during investigation pointing at \"this might not be right\", don't skip it just because it feels unimportant — chase it to a " +
        "definite conclusion, then call this tool again to re-verify; don't let a self-written summary table stand in for that final real call.",
    ),
});

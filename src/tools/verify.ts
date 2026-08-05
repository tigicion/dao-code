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
//
// 2026-07-27 真实复测(adaptive-rejection-sampler)撞见一个具体的绕过路径:模型调用了
// VerifyDone、拿到了"逐条对照任务原文"的提示,紧接着下一步却是调用 TodoWrite 勾掉自己
// 先前写的进度清单(内容是"Writing ars.R"/"Running tests"这类宽泛条目,不是任务原文的具体
// 句子),然后直接收尾——提示的内容完全正确,但被一个更省事的替代动作绕开了,没有真的回去
// 重读任务原文。原描述是大段说理性文字,容易被扫读跳过;改成参照 superpowers 的
// using-superpowers 技能那种"不可协商"框定+红旗表结构(具体的合理化念头→对应的现实),
// 目的是让这次撞见的具体绕过路径本身就在表里,读到时能被识别出来,而不是指望模型自己在
// 一大段文字里提炼出"这条也适用于我刚才的情况"。
export const verifyDoneTool = defineTool({
  name: "VerifyDone",
  description:
    "声称任务完成前必须调用的验证检查点,不是可选项。它不替你判断做没做对,而是强制你拿【实际证据】" +
    "自己判——读代码≠验证。如果你觉得\"已经检查过了/清单都勾完了/应该没问题\",这个念头本身就是" +
    "该停下来调用本工具的信号,不是可以跳过的理由——你无法靠自己判断\"这次不需要\"来豁免它。" +
    "每次声称完成前都调用,不是只在最后调一次——中途每完成一个可验证的子目标就调一次,别攒到最后。\n" +
    "常见的自我合理化,以及为什么它们不成立:\n" +
    "- \"TodoWrite 清单已经全部勾完了\" → 清单是你自己写的进度记录,勾完只代表你按自己的计划走完了," +
    "不代表对照过任务原文的具体条款;勾完清单之后仍然必须调用本工具,不能用勾清单代替。\n" +
    "- \"我的测试都过了/看起来对\" → 你的测试覆盖的是你认为重要的部分,任务原文里那些不影响" +
    "\"跑不跑得通\"但明确写了的结构性/格式性具体要求(某个文件名、某种输出格式、某个必须保留的" +
    "目录)不会被\"测试通过\"自然覆盖,必须回去对照原文逐条核对。\n" +
    "- \"这个细节应该不重要/不是重点\" → 调查途中已经注意到的、指向\"可能没做对\"的具体线索," +
    "不能凭感觉判断重不重要就放过,要查到有确定结论为止。\n" +
    "- \"环境里没装这个解释器/库,先跳过实际执行\" → \"装不上\"和\"没试着装\"是两回事,先尝试安装" +
    "(apt-get/pip/npm 等)再验证,不要因为环境暂时缺东西就退回只读代码走查。\n" +
    "- \"已经很晚了/改了很多次/其它部分都对\" → 如果你已经跑过一次检查、结果是失败/超时/不匹配," +
    "这个负面结果本身就是信号,不能因为投入已久就把它当没看见照样收尾;负面结果意味着还没做完。\n" +
    "方法对了还不够,范围也要对:调用本工具后,要重新打开【任务原文本身】(不是你自己维护的" +
    "TodoWrite/进度清单),把每一条具体要求逐句过一遍,对每一条说出你验证过的具体证据——不要凭记忆" +
    "挑几条自己觉得重要的就当验证完整了。如果核对中又发现新的疑点,查到有确定结论为止,查完后再" +
    "调用一次本工具重新核实,不能让\"自己写的总结表格\"代替最后一次真实调用。",
  descriptionEn:
    "A mandatory verification checkpoint to call before claiming a task is complete — not optional. It won't judge correctness for you; it forces you to " +
    "judge from [actual evidence]. If you're thinking \"I already checked / the checklist is all done / this should be fine\", that thought itself is the " +
    "signal to call this tool, not a reason to skip it — you cannot self-exempt by deciding \"this time it's not needed\". " +
    "Call it before every claim of completion, not just once at the end — after each verifiable sub-goal, not saved up until the very end.\n" +
    "Common rationalizations, and why they don't hold:\n" +
    "- \"The TodoWrite checklist is all checked off\" → that checklist is your own progress record; checking it off means you followed your own plan, " +
    "not that you cross-checked the original task text's specific clauses. Call this tool AFTER checking off the list, not instead of it.\n" +
    "- \"My tests all passed / it looks right\" → your tests cover what you thought was important. Structural/format requirements the task text stated " +
    "explicitly but that don't affect whether it \"runs\" (a specific filename, an output format, a directory that must be preserved) aren't naturally " +
    "covered by passing tests — go back and check them against the original text line by line.\n" +
    "- \"This detail probably doesn't matter / isn't the point\" → a concrete clue you already noticed mid-investigation pointing at \"this might not be " +
    "right\" can't be waved off by feel — chase it to a definite conclusion.\n" +
    "- \"The interpreter/library isn't installed, skip real execution\" → \"couldn't install it\" and \"didn't try\" are different claims; try installing " +
    "(apt-get/pip/npm/etc.) before falling back to reading code without running it.\n" +
    "- \"It's late / I've iterated many times / everything else checks out\" → if a check you already ran came back failed/timed-out/mismatched, that " +
    "negative result IS the signal regardless of how much effort went in — it means the task isn't done.\n" +
    "Getting the method right isn't enough — the scope has to be right too: after calling this, reopen the ORIGINAL TASK TEXT itself (not your own " +
    "TodoWrite/progress list) and walk through every specific requirement sentence by sentence, stating your evidence for each — don't just pick the ones " +
    "you remember as important. If that walk-through surfaces a new doubt, chase it to a definite conclusion, then call this tool again — don't let a " +
    "self-written summary table stand in for that final real call.",
  capability: "read",
  approval: "auto",
  schema: z.object({}),
  handler: async () =>
    msg(
      "这不是可选项:据【实际证据】自判,读≠验证——真把它跑起来/读回改动/看输出。别用\"代码看起来对、" +
        "应该没问题、我的测试过了、清单都勾完了\"代替独立验证——这几个念头本身就是该停下来核对的信号。" +
        "方法对了还不够,范围也要对:现在重新打开【任务原文本身】(不是你自己维护的 TodoWrite/进度清单)," +
        "把每一条具体要求逐句过一遍,对每一条说出你的证据——尤其是那些不影响\"跑不跑得通\"、但原文明确" +
        "写了的结构性/格式性具体要求(文件名、输出格式、必须保留的内容),这类要求不会被你已经做过的" +
        "测试自然覆盖。如果核对中已经注意到某条具体线索指向'可能没做对',不要凭感觉觉得'大概不重要'" +
        "就跳过——查到有确定结论为止,查完后再调用一次本工具重新核实,不能用自己写的总结表格代替这" +
        "最后一次真实调用。",
      "This is not optional: self-judge from [actual evidence] — reading ≠ verification, actually run it / read back changes / check output. Don't " +
        "substitute \"code looks right\", \"should be fine\", \"my tests passed\", or \"the checklist is all checked off\" for verification — those " +
        "thoughts themselves are the signal to stop and check. Getting the method right isn't enough — the scope has to be right too: reopen the " +
        "ORIGINAL TASK TEXT itself (not your own TodoWrite/progress list) and walk through every specific requirement sentence by sentence, stating " +
        "your evidence for each — especially structural/format requirements the task explicitly stated that don't affect whether it \"runs\", which " +
        "won't be naturally covered by tests you've already run. If you already noticed a concrete clue pointing at \"this might not be right\", don't " +
        "skip it just because it feels unimportant — chase it to a definite conclusion, then call this tool again to re-verify; don't let a " +
        "self-written summary table stand in for that final real call.",
    ),
});

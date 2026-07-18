import { z } from "zod";
import { defineTool, type ToolContext } from "./types.js";

// 选项(label + 可选描述);旧签名 options: string[] 仍兼容(无描述)
const optionSchema = z.object({
  label: z.string().describe("选项显示文本(1-5 个词)"),
  description: z.string().optional().describe("选项说明(选了会发生什么)"),
});

const questionSchema = z.object({
  question: z.string().describe("要问用户的问题"),
  header: z.string().optional().describe("简短标签(最多 12 字符,如 'Auth method')"),
  options: z.array(optionSchema).min(2).optional().describe("结构化选项(无需写'其他'/'先讨论',会自动加)"),
  multiSelect: z.boolean().optional().describe("是否允许多选(checkbox);默认单选"),
});

export const askUserTool = defineTool({
  name: "ask_user",
  description:
    "向用户提出澄清问题并等待回答。仅在缺少关键信息、且无法用其它工具获取时用(先想清楚这个信息是不是能靠" +
    "read_file/grep_files/memory_read 自己查到--能查到就别问)。\n" +
    "两种调用方式(二选一):\n" +
    "1. 简写(单个问题):传 question + options(字符串数组)+ multiSelect\n" +
    "2. 完整(多问题):传 questions 数组(1-4 个问题,每个含 question/header/options[{label,description}]/multiSelect);" +
    "多问题会逐个弹出,结果按换行分隔\n" +
    "不给 options 就是纯开放式问题,靠用户自由输入。\n" +
    "给 options 做结构化选择。单选:用户按数字或 ↑↓ 选 + Enter,回车即选中当前项。" +
    "凡是问题允许选多项(如'要保留哪些功能''勾选所有适用项''可多选')就【必须】设 multiSelect:true--" +
    "否则会渲染成单选,用户无法勾选、一回车就只选中了高亮那项。仅当答案互斥、只能选一个时才省略。" +
    "系统会自动附'其他(自己输入)'与'先讨论一下'两项,你只写正常选项--" +
    "【无论怎么措辞】都不要自己加类似含义的选项(如'其他'/'以上都不是'/'自定义'/'手动输入'),否则会和系统自动追加的重复出现两条几乎一样的行。" +
    "返回:选中项(多选逗号分隔)/ 用户自填内容 / 讨论意向--用户选了'先讨论一下'就是想在拍板前先聊聊,别当成同意了继续推进。",
  descriptionEn:
    "Asks the user clarifying questions and waits for answers. Only use when missing critical information that can't be obtained via other tools (first consider whether " +
    "read_file/grep_files/memory_read could answer it - don't ask if you can look it up).\n" +
    "Two calling styles (pick one):\n" +
    "1. Shorthand (single question): pass question + options (string array) + multiSelect\n" +
    "2. Full (multi-question): pass questions array (1-4 items, each with question/header/options[{label,description}]/multiSelect);" +
    " questions pop up one by one, results separated by newlines\n" +
    "Omitting options makes it a fully open-ended question relying on free-text input.\n" +
    "Use options for structured choices. Single-select: user picks by number or ↑↓ + Enter. " +
    "For questions that allow multiple answers (e.g. 'which features to keep'), you [MUST] set multiSelect:true - " +
    "otherwise it renders as single-select and the user can't check multiple items. Only omit when answers are mutually exclusive. " +
    "The system auto-appends 'Other (type your own)' and 'Discuss first'; you only write normal options - " +
    "do NOT add your own option with similar meaning [no matter how it's worded] (e.g. 'other'/'none of the above'/'custom'/'something else'), or it will show up as a near-duplicate row next to the auto-appended one. " +
    "Returns: selected items (comma-separated for multi) / user-typed text / discuss intent - if the user picked 'discuss first', they want to talk before committing, don't treat it as agreement to proceed.",
  capability: "read",
  approval: "auto",
  schema: z.object({
    // 简写:单个问题
    question: z.string().optional().describe("要问用户的问题(简写模式,与 questions 二选一)"),
    options: z.array(z.string()).min(2).optional().describe("正常可选项(简写模式,纯字符串;无需写'其他'/'先讨论',会自动加)"),
    multiSelect: z.boolean().optional().describe("是否允许多选(checkbox);默认单选"),
    // 完整:多问题
    questions: z.array(questionSchema).min(1).max(4).optional().describe("多问题数组(完整模式,与 question 二选一)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.ask) throw new Error("当前环境不支持向用户提问(ask 未配置)");

    // 二选一校验
    if (args.question && args.questions) {
      throw new Error("question 和 questions 不能同时传(二选一)");
    }

    // ---- 完整模式:多问题 ----
    if (args.questions && args.questions.length > 0) {
      const results: string[] = [];
      for (const q of args.questions) {
        const answer = await askOne(ctx, q.question, q.options, q.multiSelect);
        results.push(answer);
      }
      return results.join("\n");
    }

    // ---- 简写模式:单个问题 ----
    if (args.question) {
      return await askOne(ctx, args.question, undefined, args.multiSelect, args.options);
    }

    throw new Error("必须传 question(简写)或 questions(完整)之一");
  },
});

// 统一的提问逻辑:支持 string[] 选项(简写)和 {label,description?}[] 选项(完整)
async function askOne(
  ctx: ToolContext,
  question: string,
  structuredOptions?: { label: string; description?: string }[],
  multiSelect?: boolean,
  stringOptions?: string[],
): Promise<string> {
  // 有结构化选项 -> 拼成 "label - description" 格式传给 askChoice(兼容 string[])
  if (structuredOptions && structuredOptions.length >= 1 && ctx.askChoice) {
    const opts = structuredOptions.map((o) =>
      o.description ? `${o.label} - ${o.description}` : o.label,
    );
    return (await ctx.askChoice(question, opts, multiSelect)).trim() || "(用户未回答)";
  }
  // 有字符串选项(简写)
  if (stringOptions && stringOptions.length >= 1 && ctx.askChoice) {
    return (await ctx.askChoice(question, stringOptions, multiSelect)).trim() || "(用户未回答)";
  }
  // 无选项 -> 开放式
  if (!ctx.ask) throw new Error("当前环境不支持向用户提问(ask 未配置)");
  const raw = (await ctx.ask(question)).trim();
  return raw || "(用户未回答)";
}

// 统一反思器:回合末一个 fork,既【反思进展】(advisory,有问题才给)又【抽记忆】(memories,含 mergeInto 合并意图)。
// 复用主前缀热缓存(fork:同 tools+思考强度);两段独立容错解析(见 reflect_result)。
import { parseReflectResult, type ReflectResult, type ReflectMem } from "./reflect_result.js";
import { isCatalogNoise } from "../memory/distill.js";
import { findSecrets } from "../permissions/secrets.js";

// 追加在主对话之后的尾部指令(fork:命中热缓存)。{existing} 处插入已有记忆候选供 mergeInto 判断。
export const REFLECT_TAIL = `你对当前对话做一次【回合末反思】。只输出一个 JSON 对象,无其它文字。

## 一、记忆提取(最重要,优先做)

从本对话中提取【尚未记录的耐久事实】。宁可多抽一条让 mergeInto 去合并,也不要漏掉。不确定是否跨项目就设低 confidence(0.3-0.5),让后续会话验证。

### 已有记忆(mergeInto 可指向下面任一标题;你新抽的事实若延伸/涵盖其中某条,设 mergeInto=该 title 并写合并后的完整 text):
{existing}

### 抽什么——三条铁律
1. **用户亲口立的规矩**(type=feedback):用户明确说了"要做/不要做 X"。带"为什么:…"和"怎么用:…"。
2. **跨会话稳定的用户画像**(type=user):沟通偏好、工作风格、专业背景、长期目标。从本对话的行为推断即可——有证据就抽,信心低就标低 confidence。
3. **项目架构/技术决策**(type=semantic/procedural):本对话中做出的重要设计决策、踩过的坑、形成的模式。不是代码目录清单,而是"为什么这样设计"。

### 三个示例
示例 1 — 用户反馈:
{"title":"用户要求先出方案再动手","text":"涉及多步或有风险的改动,用户期望先看到简短计划、认可后再执行。为什么:避免方向跑偏浪费轮数。怎么用:收到复杂任务后先列 2-4 个步骤的提纲,等用户说'继续'再开干。","type":"feedback","importance":8,"confidence":0.9,"source":"user_stated","mergeInto":null}

示例 2 — 用户画像(行为推断):
{"title":"用户偏好选项式引导而非开放式提问","text":"需要用户做选择时,用结构化选项(2-4 个)而非让用户自由输入。为什么:多轮对话中选项式交互更高效、用户反应更积极。怎么用:ask_user 时给 options 数组,每个选项 5-15 字,单选/多选据实际情况定。","type":"user","importance":6,"confidence":0.4,"source":"inferred","mergeInto":null}

示例 3 — 项目事实:
{"title":"DAO CODE 三层 i18n 架构","text":"国际化的三层:①TUI 展示层(t()字典)②系统 prompt 层(BODY/BODY_EN)③工具描述层(descriptionEn+handler 返回 msg())。只切 TUI 层会让英文 UI 下的 LLM 仍收到中文指令。为什么:LLM 看到中文指令会按中文思维执行,即使 UI 是英文——这比 UI 不一致更隐蔽。怎么用:改语言时确保三层都传 lang 参数。","type":"semantic","importance":7,"confidence":0.9,"source":"本 session 全量实现","mergeInto":null}

### 每条记忆的字段
title(≤1 行)、text(完整事实)、type(user/feedback/semantic/procedural/episodic)、importance(1–10)、confidence?(0–1)、source?(user_stated/inferred/文件名)、mergeInto?(已有记忆的 title 或 null)。

### 不记什么
一次性操作步骤、代码行数/文件清单、显而易见的事(代码已写明的框架用法)、情绪/性格标签。

## 二、进展审视(其次;独立怀疑视角)

1) 复述「现在在做什么、最初目标是什么」。
2) 扎根具体证据,挑 1–3 点。下面任一条命中就该出声:
   · 在原地打转/反复试同一类改动?
   · 攻错了层/把未验证假设当事实?
   · 跑偏最初目标/镀金/scope 蔓延?
3) 真在轨或刚开新任务 → onTrack=true、advisory=null。有可观测的停滞/反复/偏离 → onTrack=false,advisory ≤8 行,口气直接,给最小下一步。
4) note 填一句话(≤1 行):「在做什么 + 为何判此值」供审计。

## 三、纠错与确认(只在有实测证据时)

- corrections:已有记忆被实测推翻/需修正 → {target, action:"supersede"|"revise", newText?, reason}。极保守,只在确凿时纠。
- confirmed:已有记忆被证实且实际依赖 → 列其 title。

## 输出(严格 JSON)
{"memories":[{...}],"onTrack":true,"advisory":null,"note":"在做什么,判在轨/偏离的理由","corrections":[],"confirmed":[]}`;

export interface ReflectInput {
  streamChat: (opts: any) => AsyncGenerator<any, any>;
  config: { baseUrl: string; apiKey: string };
  model: string;
  messages: { role: string; content: string | null }[];
  today: string;
  existing?: { title: string; text: string }[]; // 已有记忆(建议按 importance 降序):全部标题当 mergeInto 目标,前 N 条附正文
  fork?: boolean;
  tools?: unknown[];
  reasoningEffort?: string;
  onUsage?: (u: unknown) => void;
}

// 全部标题都列出(便宜、可全量当 mergeInto 目标 → 闭合"超 N 条/低重要度相关条漏召回")。
// 正文只给前 FULL_TEXT_N 条(判微妙重复时的上下文)——mergeInto 只用 title 定位,合并正文由模型重写,故大多数条目无需正文。
const FULL_TEXT_N = 30;

function buildTail(existing?: { title: string; text: string }[]): string {
  if (!existing || !existing.length) return REFLECT_TAIL.replace("{existing}", "(无)");
  const titles = existing.map((e) => `- ${e.title}`).join("\n");
  const withText = existing.slice(0, FULL_TEXT_N).map((e) => `· ${e.title}:${e.text}`).join("\n");
  const block = `〈全部已记标题〉(mergeInto 可指向其中任一):\n${titles}\n\n〈高价值条目正文〉(判微妙重复用):\n${withText}`;
  return REFLECT_TAIL.replace("{existing}", block);
}

const SALIENCE_MIN = 4; // importance < 此值的琐碎丢弃(与 distill 一致)

export async function reflect(p: ReflectInput): Promise<ReflectResult> {
  const tail = buildTail(p.existing);
  const messages = p.fork
    ? [...p.messages, { role: "user", content: tail }]
    : [
        { role: "system", content: tail },
        { role: "user", content: p.messages.filter((m) => m.role !== "system").map((m) => `${m.role}: ${m.content ?? ""}`).join("\n").slice(-24000) },
      ];
  const reqExtra = p.fork ? { reasoning_effort: p.reasoningEffort ?? "max" } : { thinking: { type: "disabled" }, temperature: 0 };

  const gen = p.streamChat({
    baseUrl: p.config.baseUrl, apiKey: p.config.apiKey, model: p.model,
    messages,
    ...(p.fork && p.tools && p.tools.length ? { tools: p.tools, parallelToolCalls: true } : {}),
    extra: reqExtra,
    ...(p.onUsage ? { onUsage: p.onUsage } : {}),
  });
  let out = ""; let r = await gen.next();
  while (!r.done) { if (r.value?.kind === "content") out += r.value.text; r = await gen.next(); }
  if (!out && typeof r.value?.content === "string") out = r.value.content;

  const dbg = !!process.env.DAO_DEBUG_REFLECT;
  if (dbg) console.error(`[reflect] 模型原始输出(${out.length} 字符):\n${out || "(空)"}`);

  const parsed = parseReflectResult(out);
  // 记忆段后备过滤(与 distill 同):salience 门 + 目录倾倒 + 密钥。
  const memories = parsed.memories.filter((m: ReflectMem) => {
    if ((m.importance ?? 5) < SALIENCE_MIN) return false;
    if (isCatalogNoise(m.text) || isCatalogNoise(m.title)) return false;
    if (findSecrets(m.text).length || findSecrets(m.title).length) return false;
    return true;
  });
  if (dbg) console.error(`[reflect] onTrack=${parsed.onTrack} advisory=${parsed.advisory ? "有" : "无"} memories=${memories.length}`);
  return { ...parsed, memories };
}

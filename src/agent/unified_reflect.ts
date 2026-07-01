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

### 去哪里找——五个高信号时刻

最好的记忆不在你的推理总结里,在用户和你交互的【转折点】。逐轮扫一遍,重点盯这些位置:

1. **用户纠正/反驳你时**(type=feedback, confidence≥0.8)
   用户说"不对""不是这样""重新来""你为什么……""弄错了"的地方,是你最该记的反馈。
   把纠正内容提炼成一条规则,带"为什么"和"怎么用"。
   注意:不是记"某轮某次被纠正"这个事件,是记"被纠正之后得出的那条反例规则"。

2. **verify_done / 验收命令之后用户的反应**(type=feedback 或 procedural)
   - 通过了、用户没追问 → 这条验证流程有效,记 procedural。
   - 用户追问"实际跑过吗""确认了吗" → 你的验证不够,记 feedback。
   - 用户要求"再跑一下""不够,还要验证 X" → 当前 DoD 标准不够,升级它。

3. **同一指令在短时间内重复出现**(type=feedback, confidence≥0.8)
   用户连说两次"先别动手""先给方案""先讨论",说明你的默认行为模式偏离了。
   这不是一条指令的重复——这是在立规矩。

4. **跨轮次的用户行为模式**(type=user, confidence 0.3-0.6)
   不只看单轮。把连续几轮的用户反应串起来:
   - 每轮开头用户都先问"现在什么状态" → 偏好全局视图先于细节
   - 每次给选项用户都选最后一个(带"先讨论") → 偏好先理解再动手
   - 用 truthiness(不准确就直接指) → 重视准确性、不接受模糊
   这类推断设低 confidence,让后续会话验证。

5. **你做错但自己发现并修正了的**(type=procedural, confidence≥0.7)
   不是因为用户纠正,而是你通过工具验证自己发现的问题:
   - multi_edit 没先 read_file 被拒,之后每次都先读→ 流程沉淀
   - edit_file 的 old_string 不唯一报错,扩大上下文后通过→ 操作技巧
   记"第一次为什么错、正确的做法是什么"。

### 抽什么——三类记忆
结合上面找到的信号,归为三类:

1. **用户规矩**(type=feedback):用户亲口立的"要做/不要做 X"。带"为什么:…"和"怎么用:…"。
2. **用户画像**(type=user):沟通偏好、工作风格、专业背景、长期目标。从第 4 类信号推断,低 confidence 兜底。
3. **项目知识**(type=semantic/procedural):本对话中的设计决策、踩过的坑、形成的模式。来自第 5 类信号和第 2 类信号中的流程发现。

### 三个示例
示例 1 — 用户反馈(来自信号 1 "用户纠正"):
{"title":"用户要求先出方案再动手","text":"涉及多步或有风险的改动,用户期望先看到简短计划、认可后再执行。为什么:避免方向跑偏浪费轮数。怎么用:收到复杂任务后先列 2-4 个步骤的提纲,等用户说'继续'再开干。","type":"feedback","importance":8,"confidence":0.9,"source":"user_stated","mergeInto":null}

示例 2 — 用户画像(来自信号 4 "跨轮次行为模式"):
{"title":"用户偏好选项式引导而非开放式提问","text":"需要用户做选择时,用结构化选项(2-4 个)而非让用户自由输入。为什么:多轮对话中选项式交互更高效、用户反应更积极。怎么用:ask_user 时给 options 数组,每个选项 5-15 字,单选/多选据实际情况定。","type":"user","importance":6,"confidence":0.4,"source":"inferred","mergeInto":null}

示例 3 — 项目知识(来自信号 5 "自己做错但修正了"):
{"title":"DAO CODE 三层 i18n 架构","text":"国际化的三层:①TUI 展示层(t()字典)②系统 prompt 层(BODY/BODY_EN)③工具描述层(descriptionEn+handler 返回 msg())。只切 TUI 层会让英文 UI 下的 LLM 仍收到中文指令。为什么:LLM 看到中文指令会按中文思维执行,即使 UI 是英文——这比 UI 不一致更隐蔽。怎么用:改语言时确保三层都传 lang 参数。","type":"semantic","importance":7,"confidence":0.9,"source":"本 session 全量实现","mergeInto":null}

### 每条记忆的字段
title(≤1 行)、text(完整事实;feedback 必须带"为什么:…"和"怎么用:…")、type、importance(1–10)、confidence(0–1)、source(user_stated/inferred/文件名)、mergeInto(已有记忆 title 或 null)。

### 不可记
一次性操作步骤、代码行数/文件清单、显而易见的事(代码已写明的框架用法)、情绪/性格标签、纯描述无教训的事件("本 session 做了 X")。

## 二、进展审视(其次;独立怀疑视角)

1) 复述「现在在做什么、最初目标是什么」。
2) 扎根具体证据,挑 1–3 点。下面任一条命中就该出声:
   · 在原地打转/反复试同一类改动?
   · 攻错了层/把未验证假设当事实?
   · 跑偏最初目标/镀金/scope 蔓延?
   · 【对用户下了未经核实的事实断言?】给了"是/不是/就是这样"这类肯定回答,却没用工具/文件/代码/搜索核实过——尤其涉及外部项目、别处代码、API/库行为、"某某是不是这样实现的"这类本可查证的问题。高置信断言必须有实测支撑,否则就是猜。
3) 真在轨或刚开新任务 → onTrack=true、advisory=null。有可观测的停滞/反复/偏离 → onTrack=false,advisory ≤8 行,口气直接,给最小下一步(若是未核实断言:点出该断言、要求先用工具核实再答,或纠正上一条已发出的断言)。
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

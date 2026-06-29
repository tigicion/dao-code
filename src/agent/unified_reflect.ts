// 统一反思器:回合末一个 fork,既【反思进展】(advisory,有问题才给)又【抽记忆】(memories,含 mergeInto 合并意图)。
// 复用主前缀热缓存(fork:同 tools+思考强度);两段独立容错解析(见 reflect_result)。
import { parseReflectResult, type ReflectResult, type ReflectMem } from "./reflect_result.js";
import { isCatalogNoise } from "../memory/distill.js";
import { findSecrets } from "../permissions/secrets.js";

// 追加在主对话之后的尾部指令(fork:命中热缓存)。{existing} 处插入已有记忆候选供 mergeInto 判断。
export const REFLECT_TAIL = `你对当前对话做一次【回合末反思】,产出两件事。只输出一个 JSON 对象,无其它文字。

## 一、进展反思(独立怀疑视角;看完整上下文;只评估,不干活)
1) 复述「现在在做什么、最初目标是什么」(别曲解成更蠢的版本)。
2) 挑 1–3 点,每条扎根具体证据(引文件/报错/命令)。下面任一条命中就该出声,别为了"在轨"而放过:
   · 在原地打转/反复试同一类改动?改文件≠进展——验收/错误状态真变了吗?没变就是没进展,直说。
   · 攻错了层?把未验证假设当事实?别客气,直接给根因「最可能是 X,因为 Y」,并指出该先验证什么。
   · 跑偏最初目标 / 镀金 / scope 蔓延?把该砍掉或推迟的点名。
   · 用户在重复表达同一问题没解决?若是,别叠加修复——质疑诊断与前提,要求从头复现真实症状。
3) 真的一切在轨、或只是刚开的新任务 → onTrack=true、advisory=null。但别把"看起来在动"误判成在轨:
   有可观测的停滞/反复/偏离就 onTrack=false,advisory ≤8 行、口气直接、结尾给最小下一步。是有力的参考,不是命令。
4) 无论在轨与否,note 都填一句话(≤1 行):复述「现在在做什么 + 为何判 onTrack 为此值」。
   这条只供事后审计、不注入主对话——别敷衍,要让人据此就能判断你是否真审视过。

## 二、记忆(从最近进展抽尚未记录的耐久事实;并判断是否【并入已有】)
### 2a. 通用用户画像(最高价值,主动抽,别等人提醒)
对照下列维度,主动抽取【跨项目、跨会话都稳定】的人物画像(type=user;明确规矩 type=feedback):
- 沟通偏好:语言、详略、先结论后展开、能否接受直接反对、emoji/寒暄。
- 工作风格:全局优先 vs 细节优先、一次完整方案 vs 小步、重数据 vs 重直觉、容错度(先跑起来 vs 一次做对)。
- 专业背景:职业/角色、领域、资历(决定术语密度)。
- 反复出现的目标/项目:用户长期在做的事(如"持续给低龄儿童做 iPad 游戏")。最易混入临时状态,谨慎。
- 明确硬规矩:用户亲口立的规矩("别用 emoji""先讨论再动手")。
【纪律】
1. 稳定性测试:换个项目/话题这条还成立吗?不成立(如"现在在调一个 bug")不抽。
2. 上抽:把项目事实抽象成人物画像——不是记"这个滑梯游戏",是记"这个人持续做低龄儿童游戏、懂其认知边界"。
3. 来源区分,填进 source:user_stated(用户亲口立,confidence 可高)/ inferred(你从行为推断,单次信号 confidence 0.3-0.4,需多次出现才升)。
4. 红线:性格标签、情绪状态、政治/宗教/健康等敏感信息、无对话佐证的人口统计推测,一律不碰。
5. 每个画像维度只应有一条生效记忆:新证据若延伸/涵盖已有画像,设 mergeInto=该条 title 并入,不要另起一条。
按 5 type 归类(user/feedback/procedural/semantic/episodic,选错污染全局)。每条给:
- title(≤1 行概要)、text(完整事实;feedback 带"为什么:…"和"怎么用:…")、type、importance(1–10)、confidence?(0–1)、source?
- 若新事实延伸/涵盖下面某条已有记忆 → 设 mergeInto=该条 title,text 写【合并增强后的完整版】。
【绝不记】一次性/情绪、项目专属写成 user/feedback、dao 自身实现细节当用户偏好、显而易见/代码已写明、工具/技能清单(目录倾倒)。无可记 → memories: []。

已有记忆(mergeInto 可指向【下面任一标题】;新事实延伸/涵盖其中某条就并入它,否则 mergeInto=null):
{existing}

## 输出(严格 JSON)
{"onTrack":true,"advisory":null,"note":"在做 X,验收/错误状态较上轮有推进,故判在轨","memories":[{"title":"…","text":"…","type":"feedback","importance":9,"confidence":0.9,"source":null,"mergeInto":null}]}`;

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

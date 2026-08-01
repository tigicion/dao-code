# WebFetch 智能提取(prompt 参数 + 小模型抽取)

## 背景与问题

`src/tools/fetch_url.ts` 目前的 WebFetch 是纯"抓取+去标签"实现:拿到 HTML、剥掉 script/style/标签,直接把整页纯文本(默认最多 20000 字符)丢给主模型,由主模型自己从里面找需要的信息。对比 Claude Code 的 WebFetch(`refs/claude-code/src/tools/WebFetchTool/WebFetchTool.ts`):CC 要求调用方必填 `prompt` 参数,抓到内容后用小模型按 prompt 做一次提取,只把提取结果交回给主模型。

这次是这条能力差距里最值钱的一条:页面越长,DAO 现在的做法越浪费主模型上下文(全量塞入);CC 的做法只回目标信息,省 token 也让主模型不用在长文里自己捞针。

本设计只覆盖"prompt 参数 + 小模型抽取"本身,是 2026-07-21 会话记录出的 5 条差距对比里,继"15分钟缓存"和"GitHub 优先 gh CLI 文案"(已在 `feat/webfetch-cache-gh-hint` 分支落地)之后单独排的第三块。

## 设计目标

- WebFetch 新增可选的 `prompt` 参数:不传维持现有行为(整页文本),传了则用小模型按 prompt 从抓到的原文里提取相关内容返回。
- 抽取用的模型可配置(环境变量),默认在 DeepSeek 系 provider(deepseek/volcengine/qianfan)下用其 flash 档,非 DeepSeek 系 provider(anthropic/openai,当前未配置 flash 档)下回退用主模型。
- 抽取失败(超时/报错)不能让 WebFetch 本身失败——静默降级返回整页原文,不中断整个回合。
- 与已落地的 15 分钟缓存正交:缓存继续存"抽取前"的原文(不因 prompt 不同而失效或膨胀),每次调用按各自的 prompt 现抽取。

## 明确排除的范围

- **不引入域名白名单/预批准机制**。DAO 的权限引擎已经原生支持 `WebFetch(domain:xxx)` 规则(`src/permissions/identity.ts:40-48`、`rules.ts:106`),用户第一次被问时选"始终允许"即可让后续同域名不再问——CC 硬编码约 100 个域名要解决的问题,DAO 已经用更通用、用户可控的方式解决了,这次不重复造轮子。
- **不做 shouldDefer**。WebFetch/WebSearch 在 DAO 里是高频工具(研究类任务、`agent-reach` 技能),defer 后每次会话第一次用网络工具前都要先绕一次 ToolSearch,对高频场景是净负。维持现状。
- **不做基于内容长度的抽取跳过阈值**。曾考虑"页面低于某个字符数就不调小模型,直接原样返回",但这属于对模型明确意图(传了 prompt 就是想要抽取)的二次猜测,加一个魔数阈值换来的成本节省不值当,不做。传了 prompt 就一定尝试抽取,无论页面大小。
- **不做抽取结果的独立缓存**。抽取结果和 prompt 强绑定,不同 prompt 对同一 URL 的抽取结果不同,不适合共享缓存;继续只缓存抽取前的原文(已有实现)。
- **不追踪运行期 profile 切换后的模型联动**。抽取模型的 provider 判断只在启动时算一次(`cfg.provider` 快照),和现有 `SUMMARY_MODEL`(`src/index.ts:1280`)完全同构的既有限制——用户中途切换 profile 不会让抽取模型跟着重算,这是延续现状而非本次引入的新缺口。

## 设计方案

### 架构选型

考虑过三种实现路径:

1. **`fetch_url.ts` 直接 import `streamChat` 自己起请求** —— 会让工具文件耦合客户端内部细节(`baseUrl`/`apiKey`/`onUsage` 这些属于"会话装配"层的东西),而且测试要真去 mock `streamChat`,比现有的"注入一个函数,测试传桩"的模式重得多。不选。
2. **复用 `ctx.runAgent`(子代理机制)做抽取** —— 子代理走的是完整 agent loop(工具访问、消息历史、多轮),对"读一段文本、按一句指令给出提取结果"这种单轮请求是明显过度设计,延迟和复杂度都不必要。不选。
3. **`ToolContext` 新增一个注入函数 `extractFromPage`,由 `index.ts` 用现成的 `streamChat` 组装,和 `summarize`(`src/index.ts:1281`)同构**——沿用 `fetchImpl` 已经验证过的注入模式:`fetch_url.ts` 只依赖一个 `(text: string, prompt: string) => Promise<string>` 接口,不知道也不关心背后是哪个模型、哪个 provider;测试直接传桩函数,不用碰真实网络/客户端。**选这个**,和代码库现有的"工具通过 ToolContext 拿能力,装配逻辑留在 index.ts"的架构完全一致。

### 模型解析:纯函数 + 启动时装配

新增 `src/tools/fetch_extract.ts`,导出一个纯函数:

```ts
export function resolveExtractModel(
  envOverride: string | undefined,
  provider: Provider,
  sessionModel: string,
): string {
  if (envOverride) return envOverride;
  if (provider === "deepseek" || provider === "volcengine" || provider === "qianfan") return "deepseek-v4-flash";
  return sessionModel; // anthropic/openai 当前未配置 flash 档,回退主模型
}
```

`index.ts` 用它算一次 `EXTRACT_MODEL`(位置紧邻现有 `SUMMARY_MODEL` 那段,`src/index.ts:1280` 附近),读 `process.env.DAO_FETCH_EXTRACT_MODEL` 作为 `envOverride`。之后组装:

```ts
const EXTRACT_MODEL = resolveExtractModel(process.env.DAO_FETCH_EXTRACT_MODEL, cfg.provider, session.model);
const extractFromPage = async (text: string, prompt: string): Promise<string> => {
  const gen = streamChat({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: EXTRACT_MODEL,
    messages: [{ role: "user", content: `${EXTRACT_INSTRUCTION}\n\n<页面内容>\n${text}\n</页面内容>\n\n<提取要求>\n${prompt}\n</提取要求>` }],
    extra: { thinking: { type: "disabled" }, temperature: 0 },
    onUsage: (u) => {
      session.addUsage(u, EXTRACT_MODEL);
      cacheSink.record({ agent: "fetch-extract", depth: 0, turn: 0, model: EXTRACT_MODEL, usage: u, sys: "", tools: "", tail: "" });
    },
  });
  let out = "";
  let r = await gen.next();
  while (!r.done) {
    if (r.value.kind === "content") out += r.value.text;
    r = await gen.next();
  }
  return out.trim() || (typeof r.value.content === "string" ? r.value.content.trim() : "");
};
```

`EXTRACT_INSTRUCTION` 是固定的中文指令:"下面是一个网页的纯文本内容,请严格按照<提取要求>从中提取相关信息,只输出提取结果,不要复述原文、不要寒暄、不要输出提取要求之外的内容。如果页面里确实没有<提取要求>要的信息,明确说明没有,不要编造。"——这条防幻觉措辞直接照抄本项目 `system_prompt.ts`/`compact.ts` 里一贯的"不编造、明确说明缺失"风格。

`extractFromPage` 通过和 `fetchImpl` 相邻的方式注入进 `ToolContext`(`src/tools/types.ts`):

```ts
// WebFetch 智能提取(prompt 参数)用;注入,便于测试打桩。未注入(如子代理/测试环境)=ctx.extractFromPage
// 为 undefined,WebFetch 静默退化为不带 prompt 的整页返回(见 fetch_url.ts 的降级逻辑)。
extractFromPage?: (text: string, prompt: string) => Promise<string>;
```

### `fetch_url.ts` 改动

- `schema` 新增 `prompt: z.string().optional().describe("按此指令从抓到的页面里提取相关内容,返回提取结果而非整页;不传则返回整页纯文本(默认行为)")`。
- handler 逻辑:拿到 `text`(缓存命中或新抓取的、去标签后的原文,截断前)之后:
  ```ts
  if (args.prompt && ctx.extractFromPage) {
    try {
      text = await ctx.extractFromPage(text, args.prompt);
    } catch {
      // 静默降级:抽取失败不影响 WebFetch 本身,返回整页原文
    }
  }
  ```
  紧接着复用现有的 `max_chars` 截断逻辑(抽取结果理论上已经比整页短,但仍然套用上限保证兜底)。
- **降级路径统一**:没传 `prompt`、传了但 `ctx.extractFromPage` 未注入(测试环境/未来子代理场景)、传了且注入了但调用抛错——三种情况都落到"返回未经提取的原文",行为上不区分,模型拿到的都是"没被特别筛选过的全文",这是设计上刻意的选择(见"抽取失败降级"决策)而不是遗漏。
- description 追加一段说明 `prompt` 用法和静默降级行为。

### 与既有功能的交互

- **缓存**(`fetch_cache.ts`,已落地):缓存 key 仍是 URL,存的是抽取前的原文。同一 URL 不同 prompt 的调用都能命中缓存(省网络请求),但各自独立跑抽取(不会互相污染结果)。缓存逻辑本身零改动。
- **`max_chars`**:抽取结果和整页原文走同一套截断逻辑,`max_chars` 语义不变。

## 测试计划

1. `src/tools/fetch_extract.test.ts`(纯函数,新文件):
   - `envOverride` 存在时优先于一切
   - provider 为 deepseek/volcengine/qianfan 时返回 `"deepseek-v4-flash"`
   - provider 为 anthropic/openai 时回退 `sessionModel`
2. `src/tools/fetch_url.test.ts`(追加用例,复用现有 `beforeEach(clearFetchCache)`):
   - 不传 `prompt` → 不调用 `ctx.extractFromPage`,即使注入了也不触发,返回整页(回归保护,防止未来改动误触发)
   - 传 `prompt` 且 `ctx.extractFromPage` 命中 → 返回抽取结果而非整页原文
   - 传 `prompt` 但 `ctx.extractFromPage` 未注入 → 静默返回整页原文,不报错
   - 传 `prompt` 且 `ctx.extractFromPage` 抛错 → 静默返回整页原文,不报错、不中断
   - 抽取结果仍然套用 `max_chars` 截断

## 自检记录

- 占位符扫描:无 TBD/待定项,模型解析规则、失败降级、缓存交互均已给出具体行为,均由用户在澄清问题环节逐条确认(环境变量默认值/provider 回退/prompt 可选性/失败降级方式)。
- 内部一致性:架构选型(方案3)与"测试计划"里对 `ctx.extractFromPage` 的桩注入方式一致;"排除范围"里的"不做抽取跳过阈值"与"测试计划"第2条("传 prompt 就一定调用,不管页面大小")互相印证,无矛盾。
- 范围:单文件级改动(`fetch_extract.ts` 新增 + `fetch_url.ts`/`types.ts`/`index.ts` 各一处改动),足够小,不需要再拆分。
- 歧义检查:三种"返回整页"的触发条件(未传prompt/未注入/调用失败)在正文里已显式合并成同一降级路径并说明是刻意设计,避免被理解成三套不同行为。

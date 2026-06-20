// dao 自带的默认技能(随程序内置,无需 .dao/skills 文件)。启动即列入可用 skill,
// 模型可按需用 skill 工具加载正文(也可自动触发);也通过 /simplify 等命令操作员触发。

export const SIMPLIFY_BODY = `审查当前代码改动,做【质量清理】——只做质量,不找正确性 bug、也不加功能:
1. 先看 git status / git diff(或指定范围)确认改了什么。
2. 按四个维度收紧:
   - 复用:消除重复、改用已有的工具/函数;
   - 简化:去冗余、收敛分支、删掉不必要的中间状态;
   - 提效:明显低效处(重复计算、无谓遍历);
   - altitude:把逻辑放到正确的层/抽象级。
3. 逐处用 edit_file / multi_edit 落地,并简述理由。
4. 改完跑相关测试/构建,确认没改坏(质量清理不应改变行为)。`;

export const DEBUGGING_BODY = `系统化调试——【没找到根因之前,不许动手改】。任何技术问题(bug、测试失败、构建错、异常行为、性能、集成问题)都走这四步,越是"看着简单/赶时间"越要走。

## 第一步:根因调查(改任何东西之前)
1. 认真读报错:别跳过 warning/stack trace,记下文件、行号、错误码——答案常就在里面。
2. 稳定复现:能否可靠触发?确切步骤?每次都发生吗?不能复现就先收集更多信息,别猜。
3. 查最近改动:git diff / git log 看什么变了(新依赖、配置、环境差异)。
4. 多组件系统就加证据:在每个组件边界用日志打印"进来的数据/出去的数据/环境是否透传",先跑一次看【在哪一层断的】,再去查那一层。
5. 追数据流:坏值从哪产生?谁用坏值调用了它?一路往上追到源头——在源头修,不在症状处修。

## 第二步:对比模式
找同代码库里相似的【能正常工作】的例子,逐条列出"坏的"和"好的"差异(再小也别放过)。要照着某个参考实现,就【完整读完】它,别只扫一眼。

## 第三步:假设与最小验证
明确写下单一假设:"我认为根因是 X,因为 Y"。做【最小】改动验证它,一次只动一个变量。验证通过→第四步;不通过→换新假设,别在旧的上叠加更多改动。不懂就说不懂,别装懂。

## 第四步:实现修复
1. 先写一个【能复现 bug 的失败测试】(用 exec_shell 跑,确认它确实失败、且是因为这个 bug 失败)。
2. 用 edit_file/multi_edit 针对【根因】做单一修复——一次一处,不要"顺手"重构或捎带改别的。
3. 跑测试确认:这个过了、其它没被弄坏、问题真解决了。
4. 修不好就停:数一下试了几次。【连续 3 次修不好 = 多半是架构问题,停下来质疑设计本身,别再试第 4 个补丁】,跟用户讨论。

## 红旗(出现就停、回第一步)
"先快速修一下回头再查""改改 X 看看行不行""跳过测试我手动验了""八成是 X,先改了""不太懂但这样可能行"。这些都意味着你在猜,不是在定位根因。`;

export const FEWER_PERMS_BODY = `减少重复审批——把你反复批准的【安全】操作固化成 allow 规则:
1. 回顾本会话:哪些工具/命令被反复要求审批,尤其只读类(读文件、git status、跑测试、grep)。
2. 只挑【安全且高频】的:只读、幂等、无副作用的优先;有写/删/网络副作用的要谨慎、逐条问用户。
3. 用 /permissions 把它们加进 allow(或写进项目 settings),并向用户说明加了哪些、为什么安全。
4. 收窄:规则尽量按【具体命令/路径】写,别用过宽通配;危险操作仍走审批。`;

export const PLANNING_BODY = `复杂改动【先出方案再动手】——动多个文件、引新依赖、改架构/数据流、或路径不止一条时,先规划。一两行的小改不必走。

## 先摸现状(只读)
读相关代码、配置、相邻实现,搞清"现在怎么跑的"再设计。范围大、要点散时,派 \`plan\` 子代理(只读,跨多处交叉验证后回方案),或 \`explore\` 子代理彻底查清某处。

## 产出可执行的方案
- 拆步骤:每步说清动哪个文件、为什么、依赖谁、顺序如何;
- 标关键文件与改动点;
- 摆取舍与风险:有 2-3 条路就并列给优劣,选一条并说理由;
- 点出不确定处与备选。

## 再落地
方案清楚了才开写;边做边对照,偏离了就停下来更新方案,而不是硬凑。大任务可分阶段交付、每阶段可验。`;

export const CODE_REVIEW_BODY = `声称"做完了"之前【先自审正确性】——这一步查 bug,不是查质量(质量归 simplify)。

## 自审清单(过改动的 diff)
1. 边界:空/null、0/负数、超长、越界、首尾元素、空集合。
2. 错误处理:会抛的地方接住了吗?失败路径返回/传播对吗?资源释放了吗?
3. 回归:这次改动会不会破坏既有调用方?改了的函数,所有调用点都还成立吗?
4. 并发/顺序:有共享状态、异步、缓存吗?竞态/重入/幂等?
5. 与意图一致:真解决了原问题吗,还是只压住了症状?

## 别只靠读——要验
读代码不算验证。声称完成前,派 \`verify\` 子代理【对抗性实跑】:它的职责不是确认"能用",而是试图证明它坏的——找反例、边界、回归,真跑构建/测试/端点。自己写的测试可能重 mock、只覆盖 happy path,让独立的 verify 另跑。

## 发现问题就回去修
自审/验证发现的缺陷,走 debugging 定位根因后修,再重审。没干净通过之前别说"完成"。`;

export const DEEP_RESEARCH_BODY = `深入研究——多来源联网、交叉验证、给【带出处】的结论:
1. 拆解:把问题拆成 3-5 个可独立检索的子问题。
2. 并行检索:用 agent 工具一次 tasks[] 并行派子代理,每个子代理用 web_search 查一个子问题、fetch_url 读关键页面,只回提炼结论 + 来源 URL(子代理独立上下文,不把整页倒进主线)。
3. 交叉验证:来源对不上就标分歧,判可信度(一手>二手、近期>过时)。
4. 综合:给结论,每个关键论断后附出处 URL;不确定的明说。
5. 不臆造来源:只引真检索到的页面,没查到就说没查到,别编 URL。`;

export interface BundledSkill {
  name: string;
  description: string;
  body: string;
  core?: boolean; // 核心:默认开、描述常驻上下文(可自动触发)。曾"不可关",现统一可在 /skills 关(对标 CC disableBundledSkills)
  modelInvokable?: boolean; // false=不让模型自动触发,只 /手动调(对齐 CC disable-model-invocation)
  userInvocable?: boolean;  // false=不暴露 /手动调,只模型自动(对齐 CC user-invocable:false)
}

// 批量开关内置技能:off=把所有内置名加进禁用集,on=移出。只动内置名,不碰磁盘技能的条目。就地改 set。
export function toggleBundled(disabled: Set<string>, bundledNames: string[], on: boolean): void {
  for (const n of bundledNames) {
    if (on) disabled.delete(n);
    else disabled.add(n);
  }
}

export const BUNDLED_SKILLS: BundledSkill[] = [
  {
    name: "simplify",
    description:
      "当用户要求整理/精简/收紧/收拾/重构/清理代码、或要求做质量复查时用(不主动)。",
    body: SIMPLIFY_BODY,
    core: true,
  },
  {
    name: "debug",
    description:
      "遇到任何问题(报错、行为不对、卡住、想不通、结果不对)、动手解决前用。",
    body: DEBUGGING_BODY,
    core: true,
  },
  {
    name: "plan",
    description:
      "动手做任何稍复杂的事(不只写代码)之前,先规划时用。",
    body: PLANNING_BODY,
    core: true,
  },
  {
    name: "code-review",
    description:
      "当用户要求审查/复核改动、或要求提交/建 PR 前把关时用(不主动)。",
    body: CODE_REVIEW_BODY,
    core: true,
  },
  {
    name: "deep-research",
    description:
      "需要就某问题做深入的多来源联网研究、给带出处的结论时用。",
    body: DEEP_RESEARCH_BODY,
    core: true,
  },
  {
    name: "fewer-permission-prompts",
    description:
      "当用户要求减少重复审批、把常批的安全操作写成 allow 规则时用。",
    body: FEWER_PERMS_BODY,
    core: true,
  },
];

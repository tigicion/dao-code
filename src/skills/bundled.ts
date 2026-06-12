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

export interface BundledSkill {
  name: string;
  description: string;
  body: string;
  core?: boolean; // 核心:描述固定加载进模型上下文(可自动触发),但不进用户的 /skills 列表、不可关
}

export const BUNDLED_SKILLS: BundledSkill[] = [
  {
    name: "simplify",
    description:
      "审查代码改动做质量清理(复用/简化/提效/altitude)并应用;只质量、不找 bug、不加功能。被要求整理/精简/收紧代码,或想对一段 diff 做质量复查时用。",
    body: SIMPLIFY_BODY,
    core: true,
  },
];

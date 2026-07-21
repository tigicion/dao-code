# 长耗时任务进度感知与前置评估 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过工具 description 引导 + 系统 prompt 引导,让模型在执行可能耗时超过 180 秒的任务时前置评估、选择能感知进度的方式执行、发现异常趋势主动终止。

**Architecture:** 纯文本改动,不新增工具、不改执行器逻辑。3 个文件(system_prompt.ts / exec_shell.ts / agent.ts)、6 处文本改动 + 3 处现有文本微调。

**Tech Stack:** TypeScript ESM, dao-code 项目

## Global Constraints

- 注释与面向用户的输出一律中文;匹配周围代码的风格/缩进
- ES 模块导入必须加 `.js` 后缀(TS NodeNext 要求)
- 系统 prompt 的 `BODY` / `BODY_EN` 是固定前缀,改动不能引入易变 token
- 工具 description 字符串拼接风格:每行用 `"..." +` 拼接,末尾 `\n` 分段
- 提交信息:Conventional Commits,`Co-Authored-By: Dao <noreply@dao-code>`

---

### Task 1: 系统 prompt 加「长耗时任务前置评估」原则(中文段)

**Files:**
- Modify: `src/prompt/system_prompt.ts:111-112`(在"遇阻不停"条之后、"用户数据无价"条之前插入)

**Interfaces:**
- Consumes: 无
- Produces: `BODY` 模板中新增一条行动纪律原则

- [ ] **Step 1: 在中文 BODY 的"遇阻不停"条之后插入新原则**

用 Edit,old_string 为第 111 行的"AskUserQuestion 是调查无果后的【最后手段】"整句 + 换行 + 第 112 行的"- 用户数据无价"开头:

```
old_string:
  AskUserQuestion 是调查无果后的【最后手段】,不是遇到一点摩擦的第一反应。
- 用户数据无价。

new_string:
  AskUserQuestion 是调查无果后的【最后手段】,不是遇到一点摩擦的第一反应。
- 长耗时任务前置评估:执行命令或派发子任务前,自判是否可能耗时超过 180 秒。如果是,不要直接前台跑(默认 120s 超时会杀掉),选择能感知进度的方式:
  · 能利用命令自身反馈的(stdout 有进度输出、exit code、产出文件)-> background 执行,做完别的事后用 BashOutput 做 checkpoint 式进度检查(不是循环轮询),看趋势决定继续等/终止/调整
  · 无进度反馈但可拆解的 -> 拆成多个小步骤分步执行,每步检查结果再决定继续
  · 既无反馈又不可拆的 -> 前台执行设合理 timeout;超时后分析已有输出和状态,不要盲目重试
  Checkpoint 式检查:后台任务跑着时,做完别的事后回来用 BashOutput/TaskOutput 检查一次进度。检查后判断:正常推进 -> 继续等或做别的事;趋势异常(连续报错、长时间无新输出、输出偏离预期)-> KillShell/TaskStop 终止,分析已产生的输出,调整策略。不是循环轮询,是周期性 checkpoint。
- 用户数据无价。
```

- [ ] **Step 2: 验证 typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 验证现有测试通过**

Run: `npx vitest run src/prompt/system_prompt.test.ts`
Expected: 全部 PASS

- [ ] **Step 4: 暂不提交,等 Task 2 一起提交**

---

### Task 2: 系统 prompt 加「长耗时任务前置评估」原则(英文段)

**Files:**
- Modify: `src/prompt/system_prompt.ts:395-396`(在英文"Hit a wall"条之后、"User data is priceless"条之前插入)

**Interfaces:**
- Consumes: 无
- Produces: `BODY_EN` 模板中新增一条行动纪律原则(英文)

- [ ] **Step 1: 在英文 BODY_EN 的"Hit a wall"条之后插入新原则**

用 Edit,old_string 为第 395 行的"AskUserQuestion is a [last resort]"整句 + 换行 + 第 396 行的"- User data is priceless"开头:

```
old_string:
  AskUserQuestion is a [last resort] after investigation is exhausted, not a first reaction to minor friction.
- User data is priceless.

new_string:
  AskUserQuestion is a [last resort] after investigation is exhausted, not a first reaction to minor friction.
- Long-running task pre-assessment: before executing a command or dispatching a subtask, judge whether it may take over 180 seconds. If so, don't run it in the foreground (default 120s timeout will kill it) - choose a progress-aware approach:
  · Commands with own progress feedback (stdout output, exit code, output files) -> run in background, then use BashOutput for checkpoint-style progress checks (not loop-polling) after doing other work; judge the trend to decide: keep waiting / terminate / adjust
  · No progress feedback but decomposable -> break into smaller steps, check results after each step before continuing
  · Neither feedback nor decomposable -> run foreground with a reasonable timeout; analyze whatever output you have after timeout, don't blindly retry
  Checkpoint-style check: when a background task is running, come back after doing other work and use BashOutput/TaskOutput to check progress once. If advancing normally -> keep waiting or do something else; if trend looks wrong (repeated errors, long silence with no new output, output diverging from expectation) -> KillShell/TaskStop to terminate, analyze what was produced, adjust strategy. Not loop-polling - periodic checkpoints.
- User data is priceless.
```

- [ ] **Step 2: 验证 typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 验证现有测试通过**

Run: `npx vitest run src/prompt/system_prompt.test.ts`
Expected: 全部 PASS

- [ ] **Step 4: 提交 Task 1 + Task 2**

```bash
git add src/prompt/system_prompt.ts
git commit -m "feat(prompt): 长耗时任务前置评估原则(中英文)

在行动纪律段加一条「长耗时任务前置评估」原则,引导模型:
- 可能超 180s 的任务不直接前台跑
- 优先 background + BashOutput/TaskOutput checkpoint 式进度检查
- 发现异常趋势主动 KillShell/TaskStop 终止
- 无进度反馈但可拆解的任务拆成小步骤分步执行

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 3: Bash 工具 description 加「长耗时命令策略」段(中英文)

**Files:**
- Modify: `src/tools/exec_shell.ts:146-147`(中文 description,在"输出在内存里最多攒 10MB"段之后、"查文件内容用 Grep"段之前插入)
- Modify: `src/tools/exec_shell.ts:173-174`(英文 description,同位置插入)

**Interfaces:**
- Consumes: 无
- Produces: Bash 工具 description 中新增「长耗时命令策略」引导段

- [ ] **Step 1: 在中文 description 中插入「长耗时命令策略」段**

用 Edit,old_string 为第 146 行的 `"的输出原样倒给你。\n" +` + 第 147 行的 `"查文件内容用 Grep` 开头:

```
old_string:
    "的输出原样倒给你。\n" +
    "查文件内容用 Grep

new_string:
    "的输出原样倒给你。\n" +
    "长耗时命令策略:执行前自判命令是否可能耗时超过 180 秒(npm install、build、test suite、大数据处理等)。" +
    "如果是,优先 background 执行--不只是\"起后台\",而是:做完别的事后用 BashOutput 做 checkpoint 式进度检查," +
    "看输出趋势判断是否正常推进;发现异常(连续报错、长时间无输出、偏离预期)用 KillShell 终止,别等超时。" +
    "无进度输出但可拆解的命令,拆成小步骤分步跑。都不行再前台跑,设合理 timeout。" +
    "持续关注型场景(如等某条 ERROR 出现)可考虑 Monitor 工具,它主动推送输出;一般 checkpoint 式检查用 BashOutput 即可。\n" +
    "查文件内容用 Grep
```

- [ ] **Step 2: 在英文 description 中插入同义内容**

用 Edit,old_string 为第 173 行的 `"command or redirect to a file and inspect that instead - don't expect a raw multi-MB output to come back intact.\n" +` + 第 174 行的 `"Use Grep for content search` 开头:

```
old_string:
    "command or redirect to a file and inspect that instead - don't expect a raw multi-MB output to come back intact.\n" +
    "Use Grep for content search

new_string:
    "command or redirect to a file and inspect that instead - don't expect a raw multi-MB output to come back intact.\n" +
    "Long-running command strategy: before executing, judge whether the command may take over 180 seconds (npm install, build, test suite, " +
    "large data processing, etc.). If so, prefer background execution - not just \"start it in background\", but: after doing other work, " +
    "use BashOutput for checkpoint-style progress checks, watching the output trend to judge whether it's advancing normally; if you spot " +
    "anomalies (repeated errors, long silence, diverging from expectation) use KillShell to terminate - don't wait for timeout. For commands " +
    "with no progress output but decomposable, break into smaller steps. If neither works, run foreground with a reasonable timeout. " +
    "For continuous-attention scenarios (like waiting for an ERROR line to appear) consider the Monitor tool, which pushes output to you " +
    "proactively; for general checkpoint-style checks, BashOutput suffices.\n" +
    "Use Grep for content search
```

- [ ] **Step 3: 验证 typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: 验证 lint**

Run: `npm run lint`
Expected: 无错误

- [ ] **Step 5: 暂不提交,等 Task 4 一起提交**

---

### Task 4: Bash 工具 background 返回消息 + sleep 拦截消息微调

**Files:**
- Modify: `src/tools/exec_shell.ts:230`(background 返回消息)
- Modify: `src/tools/exec_shell.ts:221-225`(sleep 拦截消息)

**Interfaces:**
- Consumes: 无
- Produces: 微调后的 background/sleep 拦截消息文本

- [ ] **Step 1: 微调 background 返回消息(第 230 行)**

用 Edit:

```
old_string:
      return `已在后台启动(id=${id})。进程完成后会自动通知你,不需要轮询--去继续别的事即可。需要查中间输出/进度用 BashOutput,不再需要时用 KillShell 结束。`;

new_string:
      return `已在后台启动(id=${id})。进程完成后会自动通知你--做完别的事后可以用 BashOutput 看一眼进度趋势,发现异常用 KillShell 终止。不是循环轮询,是 checkpoint 式检查。`;
```

- [ ] **Step 2: 微调 sleep 拦截消息(第 221-225 行)**

用 Edit:

```
old_string:
        return `不要用 sleep 等待后台任务完成。后台 shell(background=true)和后台子代理完成时会自动通知你--` +
          `结束本轮或去做别的事,结果到了自动回灌,不需要 sleep 等待。\n` +
          `如果你确实需要等待(如等端口可用、等容器启动),用 Bash 的 background 参数起后台命令,` +
          `完成后自动通知;需要中间输出用 BashOutput 查看进度。\n` +
          `你刚才的命令等了 ${seconds} 秒--这段时间整个 dao 会话被完全阻塞,无法响应用户输入。`;

new_string:
        return `不要用 sleep 阻塞等待。后台 shell(background=true)和后台子代理完成时会自动通知你--` +
          `结束本轮或去做别的事,结果到了自动回灌。\n` +
          `如果你确实需要等待(如等端口可用、等容器启动),用 Bash 的 background 参数起后台命令,` +
          `做完别的事后用 BashOutput 检查进度。\n` +
          `你刚才的命令等了 ${seconds} 秒--这段时间整个 dao 会话被完全阻塞,无法响应用户输入。`;
```

- [ ] **Step 3: 验证 typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 无错误

- [ ] **Step 4: 验证现有测试通过**

Run: `npx vitest run src/tools/exec_shell`
Expected: 全部 PASS(如有相关测试)

- [ ] **Step 5: 提交 Task 3 + Task 4**

```bash
git add src/tools/exec_shell.ts
git commit -m "feat(bash): 长耗时命令策略引导 + background/sleep 消息微调

- Bash description 加「长耗时命令策略」段(中英文):引导模型对
  可能超 180s 的命令优先 background + BashOutput checkpoint 检查
- background 返回消息:去掉\"不需要轮询\"改为引导 checkpoint 式检查
- sleep 拦截消息:去掉\"不需要 sleep 等待\"改为引导用 BashOutput 检查进度

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 5: Agent 工具 description 加「长耗时子任务策略」段(中英文)

**Files:**
- Modify: `src/tools/agent.ts:46-47`(AGENT_TOOL_PROMPT_ZH,在"何时不该用"段之后、"写 prompt 的指引"段之前插入)
- Modify: `src/tools/agent.ts:70-72`(AGENT_TOOL_PROMPT_EN,在"When NOT to use"段之后、"Writing the prompt"段之前插入)

**Interfaces:**
- Consumes: 无
- Produces: Agent 工具 description 中新增「长耗时子任务策略」引导段

- [ ] **Step 1: 在 AGENT_TOOL_PROMPT_ZH 中插入「长耗时子任务策略」段**

用 Edit,old_string 为第 46 行的 `"只需在 2-3 个文件里搜代码,直接 Read。这些简单搜索不值得派子代理。\n" +` + 第 47 行的 `"写 prompt 的指引` 开头:

```
old_string:
  "只需在 2-3 个文件里搜代码,直接 Read。这些简单搜索不值得派子代理。\n" +
  "写 prompt 的指引

new_string:
  "只需在 2-3 个文件里搜代码,直接 Read。这些简单搜索不值得派子代理。\n" +
  "长耗时子任务策略:派发前自判子任务是否可能耗时超过 180 秒。如果是,优先 background:true 后台派--" +
  "不只是\"起后台等通知\",而是:做完别的事后用 TaskOutput 做 checkpoint 式进度检查," +
  "看子代理的中间消息/思考判断是否在正常推进;发现趋势偏离预期用 TaskStop 终止," +
  "分析已产生的中间结果,调整策略再重新派发。前台子代理耗时过长时同理--" +
  "可以先用 TaskOutput 看中间进度,趋势不对就 TaskStop。\n" +
  "写 prompt 的指引
```

- [ ] **Step 2: 在 AGENT_TOOL_PROMPT_EN 中插入同义内容**

用 Edit,old_string 为第 71 行的 `"to search within 2-3 specific files, use Read directly. These simple searches don't warrant a subagent.\n" +` + 第 72 行的 `"Writing the prompt` 开头:

```
old_string:
  "to search within 2-3 specific files, use Read directly. These simple searches don't warrant a subagent.\n" +
  "Writing the prompt

new_string:
  "to search within 2-3 specific files, use Read directly. These simple searches don't warrant a subagent.\n" +
  "Long-running subtask strategy: before dispatching, judge whether the subtask may take over 180 seconds. If so, prefer background:true - " +
  "not just \"start it in background and wait for notification\", but: after doing other work, use TaskOutput for checkpoint-style progress " +
  "checks, looking at the subagent's intermediate messages/reasoning to judge whether it's advancing normally; if the trend diverges from " +
  "expectation, use TaskStop to terminate, analyze the intermediate results produced, adjust strategy and re-dispatch. The same applies " +
  "to foreground subagents taking too long - use TaskOutput to check intermediate progress first, and TaskStop if the trend looks wrong.\n" +
  "Writing the prompt
```

- [ ] **Step 3: 验证 typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 无错误

- [ ] **Step 4: 验证现有测试通过**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/agent.ts
git commit -m "feat(agent): 长耗时子任务策略引导

Agent 工具 description 加「长耗时子任务策略」段(中英文):
- 派发前自判是否可能超 180s
- 优先 background:true + TaskOutput checkpoint 式进度检查
- 发现趋势偏离预期用 TaskStop 终止
- 前台子代理耗时过长同理

Co-Authored-By: Dao <noreply@dao-code>"
```

---

### Task 6: 全量验证

**Files:**
- 无文件改动,纯验证

- [ ] **Step 1: typecheck + lint + test 全量**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 三项全绿

- [ ] **Step 2: 手动验证 prompt 内容**

Run: `npx tsx -e "import { buildSystemPrompt } from './src/prompt/system_prompt.js'; const p = buildSystemPrompt({ modelId: 'test', toolSummaries: '', cwd: '/tmp', platform: 'darwin', envSnapshot: '', sessionGuidance: '', projectInstructionFiles: '', memory: '' }); console.log(p.includes('长耗时任务前置评估') ? 'PASS: 中文原则存在' : 'FAIL: 中文原则缺失'); console.log(p.includes('Long-running task pre-assessment') ? 'PASS: 英文原则存在' : 'FAIL: 英文原则缺失');"`

Expected: 两个 PASS

- [ ] **Step 3: 验证 Bash description 内容**

Run: `npx tsx -e "import { execShellTool } from './src/tools/exec_shell.js'; console.log(execShellTool.description.includes('长耗时命令策略') ? 'PASS: 中文策略存在' : 'FAIL: 中文策略缺失'); console.log(execShellTool.descriptionEn.includes('Long-running command strategy') ? 'PASS: 英文策略存在' : 'FAIL: 英文策略缺失');"`

Expected: 两个 PASS

- [ ] **Step 4: 验证 Agent prompt 内容**

Run: `npx tsx -e "import { agentTool } from './src/tools/agent.js'; const p = agentTool.prompt({ lang: 'zh' }); console.log(p.includes('长耗时子任务策略') ? 'PASS: 中文策略存在' : 'FAIL: 中文策略缺失'); const e = agentTool.prompt({ lang: 'en' }); console.log(e.includes('Long-running subtask strategy') ? 'PASS: 英文策略存在' : 'FAIL: 英文策略缺失');"`

Expected: 两个 PASS

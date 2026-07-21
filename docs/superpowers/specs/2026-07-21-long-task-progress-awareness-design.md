# 长耗时任务进度感知与前置评估

## 背景与问题

dao 在执行耗时较长的 bash 命令或 Agent 子任务时,存在以下问题:

1. **前台阻塞不可见**:模型用 foreground bash 跑长命令,执行期间完全黑盒,不知道是在正常推进还是卡住了。默认 120s 超时后直接杀进程组,已产生的中间状态可能丢失。
2. **结果不可预期**:花了很久跑完,结果不符合预期 -- 如果中间能感知进度,本可以提前终止、调整策略,避免浪费。
3. **现有引导偏"别管"**:Bash description、background 返回消息、sleep 拦截三处文本反复强调"不需要轮询,结果到了自动回灌",导致模型即使有条件做进度检查也不愿做。

## 设计目标

让模型在执行可能耗时的任务时:
1. **前置评估**:自判是否可能耗时超过 180 秒,如果是则不直接前台跑
2. **进度感知**:优先选择能感知进度的方式执行(background + BashOutput checkpoint 检查)
3. **异常终止**:发现进度趋势异常时主动终止(KillShell/TaskStop),不等超时
4. **任务拆解**:无进度反馈但可拆解的任务,拆成小步骤逐步执行检查

## 设计方案

方案 B:工具 description 引导 + 系统 prompt 引导,纯文本改动,不新增工具、不改执行器逻辑。

### 改动清单

共 3 个文件、6 处文本改动:

#### 1. 系统 prompt(`src/prompt/system_prompt.ts`)

在「行动纪律」段末尾(现有"遇阻不停"条之后)加一条原则:

```
- 长耗时任务前置评估:执行命令或派发子任务前,自判是否可能耗时超过 180 秒。如果是,不要直接前台跑(默认 120s 超时会杀掉),选择能感知进度的方式:
  · 能利用命令自身反馈的(stdout 有进度输出、exit code、产出文件)-> background 执行,做完别的事后用 BashOutput 做 checkpoint 式进度检查(不是循环轮询),看趋势决定继续等/终止/调整
  · 无进度反馈但可拆解的 -> 拆成多个小步骤分步执行,每步检查结果再决定继续
  · 既无反馈又不可拆的 -> 前台执行设合理 timeout;超时后分析已有输出和状态,不要盲目重试
  Checkpoint 式检查:后台任务跑着时,做完别的事后回来用 BashOutput/TaskOutput 检查一次进度。检查后判断:正常推进 -> 继续等或做别的事;趋势异常(连续报错、长时间无新输出、输出偏离预期)-> KillShell/TaskStop 终止,分析已产生的输出,调整策略。不是循环轮询,是周期性 checkpoint。
```

英文段(`BODY_EN` 的 Action Discipline 段,当前第 389-395 行的"遇阻不停"条之后)加同义内容,插在"User data is priceless"条之前。

#### 2. Bash 工具 description(`src/tools/exec_shell.ts`)

**2a. description 中追加「长耗时命令策略」段**

在现有 background 说明之后、"查文件内容用 Grep"之前,插入:

```
长耗时命令策略:执行前自判命令是否可能耗时超过 180 秒(npm install、build、test suite、大数据处理等)。如果是,优先 background 执行--不只是"起后台",而是:做完别的事后用 BashOutput 做 checkpoint 式进度检查,看输出趋势判断是否正常推进;发现异常(连续报错、长时间无输出、偏离预期)用 KillShell 终止,别等超时。无进度输出但可拆解的命令,拆成小步骤分步跑。都不行再前台跑,设合理 timeout。持续关注型场景(如等某条 ERROR 出现)可考虑 Monitor 工具,它主动推送输出;一般 checkpoint 式检查用 BashOutput 即可。
```

英文 description 同位置加同义内容。

**2b. background 返回消息微调(第 230 行)**

当前:
```
已在后台启动(id=${id})。进程完成后会自动通知你,不需要轮询--去继续别的事即可。需要查中间输出/进度用 BashOutput,不再需要时用 KillShell 结束。
```

改为:
```
已在后台启动(id=${id})。进程完成后会自动通知你--做完别的事后可以用 BashOutput 看一眼进度趋势,发现异常用 KillShell 终止。不是循环轮询,是 checkpoint 式检查。
```

**2c. sleep 拦截消息微调(第 221-225 行)**

当前:
```
不要用 sleep 等待后台任务完成。后台 shell(background=true)和后台子代理完成时会自动通知你--结束本轮或去做别的事,结果到了自动回灌,不需要 sleep 等待。如果你确实需要等待(如等端口可用、等容器启动),用 Bash 的 background 参数起后台命令,完成后自动通知;需要中间输出用 BashOutput 查看进度。你刚才的命令等了 ${seconds} 秒--这段时间整个 dao 会话被完全阻塞,无法响应用户输入。
```

改为:
```
不要用 sleep 阻塞等待。后台 shell(background=true)和后台子代理完成时会自动通知你--结束本轮或去做别的事,结果到了自动回灌。如果你确实需要等待(如等端口可用、等容器启动),用 Bash 的 background 参数起后台命令,做完别的事后用 BashOutput 检查进度。你刚才的命令等了 ${seconds} 秒--这段时间整个 dao 会话被完全阻塞,无法响应用户输入。
```

关键变化:去掉"不需要 sleep 等待"中的"不需要"语气(不否定主动检查),改为明确引导用 BashOutput 检查进度。

#### 3. Agent 工具 description(`src/tools/agent.ts`)

**3a. AGENT_TOOL_PROMPT_ZH 追加「长耗时子任务策略」段**

在现有"写 prompt 的指引"段之前,插入:

```
长耗时子任务策略:派发前自判子任务是否可能耗时超过 180 秒。如果是,优先 background:true 后台派--不只是"起后台等通知",而是:做完别的事后用 TaskOutput 做 checkpoint 式进度检查,看子代理的中间消息/思考判断是否在正常推进;发现趋势偏离预期用 TaskStop 终止,分析已产生的中间结果,调整策略再重新派发。前台子代理耗时过长时同理--可以先用 TaskOutput 看中间进度,趋势不对就 TaskStop。
```

**3b. AGENT_TOOL_PROMPT_EN 追加同义内容**

### 不改的部分

- **Monitor 工具**:不改 Monitor 本身。在 Bash description 中提及 Monitor 作为补充选项即可
- **Python -c 拦截**:不改。我们的拆解引导说"拆成小步骤用 Bash/Read/Grep 执行",不依赖 python -c
- **前台超时机制**:不改。超时本身是信号,模型应从超时结果学到"下次该用 background"
- **LONG_TASK_DIRECTIVE**:不改。已有"耗时且能与其它工作并行的独立子任务用 background:true"与新引导一致
- **执行器逻辑**:不改 runForeground / ProcessManager / TaskManager

## 现有机制副作用分析

### 前台超时(`runForeground`)

- 杀进程组是破坏性的,可能留下半成品文件/损坏的事务状态(apt dpkg 已处理,其他未必)
- 设 600s timeout 但命令卡住会阻塞工具调用槽 10 分钟
- 与新设计的张力不大:引导"可能超 180s 就别前台跑"正好避免超时;判断失误撞超时是可接受的信号

### Sleep 拦截

- 误杀合法 sleep(如 `sleep 5 && curl localhost:3000/health` 健康检查)
- **与新设计的直接冲突**:三重强化"别检查"可能让模型不愿做 checkpoint 检查 -> 需微调措辞(2b、2c)

### Python -c 拦截

- 误杀合法 JSON 结构化解析(引用小 .json 文件时)
- 与新设计张力不直接:拆解引导用 Bash/Read/Grep,不依赖 python -c;需结构化解析时引导用 Write 写 .py 文件

### Monitor 工具

- shouldDefer 需 ToolSearch 激活,approval: required 每次审批
- 与 BashOutput 的区别:Monitor 主动推送 vs BashOutput 主动调
- 用户选择 checkpoint 式检查(模型主动),Monitor 不是首选但在持续关注型场景有独特价值
- 在 Bash description 中提及作为补充选项

## 测试策略

1. **typecheck + lint + test**:确保文本改动不破坏现有测试
2. **system_prompt.test.ts**:现有测试应全过(prompt 内容变化不影响结构断言)
3. **手动验证**:用一个耗时命令场景(如 `npm test` 或 `sleep 3 && echo done`)验证:
   - Bash description 含"长耗时命令策略"段
   - background 返回消息含"checkpoint 式检查"
   - sleep 拦截消息含"用 BashOutput 检查进度"
   - Agent description 含"长耗时子任务策略"段

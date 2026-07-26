# 环境引导信息补全(文件列表/内存/网络)

## 背景与问题

`src/env_snapshot.ts` 目前在会话启动时探测一次,把结果烘焙进 `system_prompt.ts` 的 `# 环境` 段落固定前缀,内容只有:语言/工具链版本(node/npm/pnpm/python3/go/rustc/java)、git 分支、git 脏文件数。cwd/platform 另外由 `process.cwd()`/`process.platform` 直接提供。

这套机制本身是"启动时探测一次,结果字节固定进不可变前缀,会话中途绝不重探测"(为保护 prefix cache),灵感来自 stanford-iris-lab/meta-harness 的 environment bootstrapping,但目前只覆盖了 meta-harness 原始清单的一部分——缺顶层文件列表、系统内存、网络环境;工具链探测也缺 pip/yarn/cargo。

现状还有一个隐藏的时延问题:`index.ts:781` 的 `const envSnapshot = formatEnvSnapshot(await envSnapshotPromise, ...)` 发生在 Ink 交互界面挂载(`index.ts:1573` 的 `runInkApp`)之前,探测越慢,交互界面出现得越晚(现状上限即 `PROBE_TIMEOUT_MS = 3000`)。补充网络探测这种天然更不稳定的 I/O 之后,如果延续现在"整体 await 完再挂载 UI"的模式,这个问题会被放大。

## 设计目标

把 env snapshot 补全到:cwd、platform、顶层目录列表、语言/工具链版本(补 pip3/yarn/cargo)、git 分支/脏文件数、系统内存、网络连通性(npm + PyPI)。同时保证:
- 补充这些字段(尤其网络探测)不拖慢 Ink 交互界面的挂载时机,用户能立刻开始输入。
- 探测结果如果比第一条请求慢,不静默丢弃、也不强行阻塞等待,而是延迟一轮补投递给模型,并显式打 tag 说明这是启动时发起、延迟到达的信息。

## 明确排除的范围

- **不做多语言全量包管理器锁文件解析**(如识别 package-lock.json/pnpm-lock.yaml 判断项目实际用哪个包管理器)。这次只补齐"有没有装这个工具/版本号",不做"这个项目实际用哪个"的推断——后者信息密度更高但需要额外的文件扫描与格式约定,留作后续独立需求。
- **网络探测目标不铺开到 GitHub/crates.io/Go proxy**。只测 npm registry + PyPI,覆盖工具链探测已经覆盖的两大生态(JS/TS、Python),边际扩展的信息量对启动开销不划算。
- **顶层目录列表不做递归/多层级展开**。只列 cwd 直接子项(文件+目录),更深层结构继续依赖模型按需调用 `ListDir`/`Glob`,不在启动时主动展开,避免大仓库把 prompt 撑爆。
- **headless 一次性任务(`--goal`/单条 argv prompt)不做异步延迟投递**。这类会话只有一轮,没有"下一轮"可以延迟补,继续保留现在的同步 await 行为——反正没有交互界面挂载时机要保护,阻塞至多 3 秒不影响任何人观感。

## 设计方案

### 字段拆分:快字段 vs 慢字段

按获取方式的延迟特征一分为二,分别处理时机不同:

**快字段**(同步本地操作,零 I/O 等待,继续走"直接烘焙进不可变 system prompt 前缀"的路):
- cwd(`process.cwd()`,不变)
- platform(`process.platform`,不变)
- **顶层目录列表**(新增):`fs.readdirSync(cwd, { withFileTypes: true })`,排除 `.git`(已有 git 分支信息,重复无意义),目录名加 `/` 后缀,目录优先、字母序排列,超过 40 项截断为"前 40 项 +(共 N 项)"提示。
- **系统内存**(新增):`os.totalmem()`/`os.freemem()`,换算 GB 保留 1 位小数。

**慢字段**(依赖子进程 spawn 或网络 I/O,耗时不可控,改为"发起后不阻塞,就绪后按时机投递"):
- 语言/工具链版本(沿用现有 `PROBE_CMD` 单条组合 shell 脚本,新增 pip3/yarn/cargo 三行探测,保持"有则报版本、无则报 not found"的既有风格)
- git 分支 + 脏文件数(不变)
- **网络连通性**(新增):对 `registry.npmjs.org` 和 `pypi.org` 各发一个短超时(1.5s)HEAD 请求(Node 原生 `fetch` + `AbortController`),外加读取 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`(大小写都读)判断是否走代理。两个目标独立超时、独立探测失败,不互相拖累。

`gatherEnvSnapshotData` 内部用 `Promise.allSettled` 并发跑"工具链 shell 脚本"和"网络探测"两路,某一路超时/失败只影响自己那部分字段,不影响另一路已经拿到的结果——这个隔离性不是新增,是延续当前"探测失败静默降级"哲学,只是把粒度从"整体成败"细化到"逐路成败"。

### 投递时机:快字段照旧,慢字段解耦挂载 + 延迟补投递

**快字段**:`buildSystemPrompt` 调用处(`index.ts:781` 附近)新增一次同步的顶层目录+内存探测,和 cwd/platform 一起直接拼进 `# 环境` 段落,不引入任何 Promise/await,这一步本身仍是瞬时的。

**慢字段**:
1. 进程启动时(`index.ts:297` 附近)照旧发起 `gatherEnvSnapshotData(cwd)`,但**不再同步 await 后才继续构建 system prompt / 挂载 Ink**。交互会话(`interactiveSession === true`)下,system prompt 只含快字段,Ink 界面立即挂载,用户可以立刻开始输入。
2. 探测 Promise 在后台跑完后,若此时用户第一条消息还没发出去,就把格式化结果整理好,等到真正要组装第一条 LLM 请求时正常带上(体验上和现状一致,没有可感知差异)。
3. 若用户第一条消息已经先发出去了(探测还没就绪),不追加等待——这条请求就不带这部分信息。探测就绪后,在**下一次**发起 LLM 请求前,往 `session.messages` 里插入一条一次性 `role: "system"` 消息(沿用 `src/agent/compact.ts` 里"压缩后插入 pinned 任务清单"的现成模式,不是新发明的机制),显式打 tag 说明这是启动时发起、因异步延迟才补到的信息:

   ```
   <环境探测补充 说明="进程启动时已发起探测,因异步 I/O 比第一条消息慢完成,现在补上">
   - 可用语言/工具: node v20.0.0; npm 10.x.x; pip3 24.0; yarn: not found; cargo 1.75.0; ...
   - Git 分支: main (3 个未提交改动)
   - 网络: 可访问 npm registry;不可访问 PyPI
   </环境探测补充>
   ```
4. 只投递一次(投递后置位标记,不重复插入)。若探测彻底失败/超时,永不投递,和现状"静默降级"行为一致。
5. "下一次发起 LLM 请求"指下一次面向模型的请求,不限定是下一个用户轮次——同一用户轮次内如果还有工具调用往返(多次内部请求),补充消息会在最近的一次内部请求前就插入,不用等到用户发下一句话。
6. 补充消息作为普通历史消息处理,**不**像 `compact.ts` 里的 pinned 任务清单那样跨压缩强制保留——这是一次性的环境快照信息,过期后被摘要概括掉是可接受的,不需要专门的锚点保护逻辑。
7. **headless 一次性任务**:`interactiveSession === false` 时不走上述解耦逻辑,保留现在"同步 await 后再继续"的行为——这类会话只有一轮,没有"下一轮"可以延迟补。

### 呈现格式(`formatEnvSnapshot` 扩展)

```
- 可用语言/工具: node v20.0.0; npm 10.x.x; pnpm 9.x.x; pip3 24.0; yarn: not found; cargo 1.75.0; go: not found; rustc: not found; java: not found
- Git 分支: main (3 个未提交改动)
- 顶层目录: src/, evals/, docs/, package.json, tsconfig.json, ...(共 18 项)
- 系统内存: 16.0 GB 总量,4.2 GB 可用
- 网络: 可访问 npm registry;不可访问 PyPI(经代理 http://127.0.0.1:7890)
```

字段全部可选——任意一项探测失败/超时就跳过对应 bullet,不影响其它字段正常显示。

## 影响范围

- `src/env_snapshot.ts`:`PROBE_CMD` 加 pip3/yarn/cargo 三行;新增 `probeTopLevelDir`/`probeMemory`(同步,供快字段路径直接调用)、`probeNetwork`(异步,并入 `gatherEnvSnapshotData` 内部的 `Promise.allSettled`);`formatEnvSnapshot` 扩展新字段的格式化。
- `index.ts`:`interactiveSession` 分支下,system prompt 构建改为只用快字段(同步),`gatherEnvSnapshotData` 的 promise 转为后台监听,就绪时机决定"随第一条请求带上"还是"下一轮延迟补投递";headless 分支保持现状同步 await。
- `src/agent/loop.ts`(或等价的请求组装点):新增"待投递的环境补充消息"检查——每次发起 LLM 请求前,若慢字段已就绪且尚未投递,插入一条 `role: system` 消息(参考 `compact.ts` 的插入方式)。
- `system_prompt.ts`/`{env_snapshot}` 占位符本身不用改,快字段部分继续走原有拼装方式。

## 边界情况

- 慢字段探测彻底失败(shell 探测超时、两个网络目标都失败):不产出任何 bullet,也不触发延迟补投递,等价于现状的静默降级。
- 顶层目录/系统内存这两项理论上不会"探测失败"(除非极端权限问题);真出问题就跳过该字段,不影响其它字段。
- 用户在慢字段就绪前就结束了整个会话(比如打完一句话直接退出):延迟补投递逻辑不会执行,不产生任何副作用。
- 网络探测两个目标结果不一致(如只放行 npm):分别呈现,不合并成笼统的"能/不能"。

## 测试策略

- `env_snapshot.test.ts` 新增:
  - 顶层目录探测:临时目录场景验证条目、排序、超限截断、`.git` 排除。
  - 内存字段格式化:mock 数值验证 GB 换算与保留位数。
  - 网络探测:mock fetch 成功/超时/DNS 失败,验证独立超时不互相拖累;mock 代理环境变量验证附注文案。
  - pip3/yarn/cargo 版本探测:复用现有 mock spawn 输出的测试方式。
  - `gatherEnvSnapshotData` 整体:某一路(如网络)故意报错时,另一路(shell 探测)结果仍完整返回。
- `index.ts`/loop 集成测试新增:
  - 交互会话下,Ink 挂载不等待慢字段 promise(mock 一个永不 resolve 的慢探测,断言挂载仍正常完成)。
  - 慢字段在第一条消息发出前就绪:结果正常出现在第一条请求的 system prompt 里。
  - 慢字段在第一条消息发出后才就绪:不出现在第一条请求里,出现在下一条请求前插入的 `role: system` 补充消息里,且带预期的 tag 文案。
  - 补充消息只插入一次:连续多轮请求,已投递后不重复插入。
  - headless 一次性任务:保留同步 await 行为(慢字段必定出现在唯一一条请求里)。

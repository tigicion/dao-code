# 限流时快捷切换账号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 账号(profile)触发 provider 限流时,交互场景的限流选择菜单直接提供"切到账号 X 重试"选项,选中后立即用新账号重试同一个请求,不用中止本轮再手动跑 `/account`。

**Architecture:** `TurnDeps` 新增两个可选字段(`listOtherAccounts`/`switchAccountAndWait`),`loop.ts` 限流分支据此动态在 `askChoice` 菜单里插入账号选项;`index.ts` 把这两个字段接到已有的账号(profile)管理闭包上,并把 `TurnDeps.config` 从"每次 submit 复制的快照"改成对 `cfg` 的活引用,让账号切换后续读到的 baseUrl/apiKey 立即生效。

**Tech Stack:** TypeScript, vitest。不引入新依赖。

## Global Constraints

- 切换是持久的(等同手动 `/account`),不是"仅本轮"——落盘复用现有 `saveProfiles`。
- 不做账号"智能推荐"/过滤——`listOtherAccounts` 返回除当前激活账号外的**全部**账号,由用户自己选,不猜。
- `switchAccountAndWait` 必须等凭据(`resolveCredential`)真正解析完成再返回,不能像现有 `switchAccount` 那样 fire-and-forget——否则切换后立刻重试会用错 apiKey。
- 只在交互场景(`deps.ctx.askChoice` 存在)生效;`background`(子代理)分支不受影响,维持现状。
- 只有 1 个账号(`listOtherAccounts()` 返回空数组)时,菜单不出现账号切换选项,行为等同现状。

---

### Task 1: `loop.ts` 限流菜单接入账号切换选项

**Files:**
- Modify: `src/agent/loop.ts:76-102`(`TurnDeps` 接口,新增两个字段)
- Modify: `src/agent/loop.ts:221-251`(限流交互分支,插入账号选项 + 处理选中后的切换)
- Test: `src/agent/loop.test.ts`

**Interfaces:**
- Produces(供 Task 2 index.ts 接线用):
  - `TurnDeps.listOtherAccounts?: () => { name: string }[]` —— 返回除当前激活账号外的全部账号名。
  - `TurnDeps.switchAccountAndWait?: (name: string) => Promise<boolean>` —— 切换到指定账号,await 凭据解析完成才返回;`false` = 账号不存在或凭据解析失败。

- [ ] **Step 1: 写失败测试——限流菜单在有其它账号时列出"切到账号 X"选项,选中后调用 switchAccountAndWait 并用新账号重试**

在 `src/agent/loop.test.ts` 里,紧接在现有"限流(429):交互场景问用户,选\"中止\"则不重试"测试(约第 227-258 行)之后插入:

```ts
  it("限流(429):交互场景菜单列出其它账号,选中后切换并用新账号重试", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let call = 0;
    const baseUrlsUsed: string[] = [];
    const switchedTo: string[] = [];
    const liveConfig = { baseUrl: "https://old", apiKey: "sk-old" };
    const streamChatMock = ((opts: StreamChatOptions) => {
      call++;
      baseUrlsUsed.push(opts.baseUrl);
      if (call === 1) {
        return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
          throw Object.assign(new Error("API error 429: rate_limit_exceeded"), { status: 429 });
        })();
      }
      return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        yield { kind: "content", text: "切换后成功" };
        return { role: "assistant", content: "切换后成功" };
      })();
    }) as any;
    let askedOptions: string[] = [];
    const interactiveCtx = {
      ...ctx,
      askChoice: async (_q: string, opts: string[]) => {
        askedOptions = opts;
        return opts.find((o) => o.includes("work"))!; // 选"切到账号「work」重试"
      },
    };
    await runTurn({
      session: s, config: liveConfig, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
      streamChat: streamChatMock,
      executeToolCalls: async () => [],
      write: () => {},
      listOtherAccounts: () => [{ name: "work" }, { name: "backup" }],
      switchAccountAndWait: async (name) => {
        switchedTo.push(name);
        liveConfig.baseUrl = "https://work"; // 模拟 index.ts 里对活引用 cfg 的原地修改
        liveConfig.apiKey = "sk-work";
        return true;
      },
    });
    expect(askedOptions).toEqual([
      "等待后用当前模型重试",
      "切到账号「work」重试",
      "切到账号「backup」重试",
      "中止本轮(稍后可用 /account 切换账号)",
    ]);
    expect(switchedTo).toEqual(["work"]);
    expect(call).toBe(2);
    expect(baseUrlsUsed).toEqual(["https://old", "https://work"]); // 第二次请求确实用了切换后的 baseUrl
    expect(s.messages.at(-1)).toEqual({ role: "assistant", content: "切换后成功" });
  });

  it("限流(429):切换账号失败时不静默吞掉,报错并中止", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    const noticed: string[] = [];
    const streamChatMock = (() =>
      (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        throw Object.assign(new Error("API error 429: rate_limit_exceeded"), { status: 429 });
      })()) as any;
    const interactiveCtx = {
      ...ctx,
      askChoice: async (_q: string, opts: string[]) => opts.find((o) => o.includes("work"))!,
    };
    await expect(
      runTurn({
        session: s, config, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
        streamChat: streamChatMock,
        executeToolCalls: async () => [],
        write: (t) => noticed.push(t),
        listOtherAccounts: () => [{ name: "work" }],
        switchAccountAndWait: async () => false, // 模拟凭据解析失败
      }),
    ).rejects.toThrow(/限流|429/);
    expect(noticed.some((t) => t.includes("切换到账号「work」失败"))).toBe(true);
  });

  it("限流(429):没有 listOtherAccounts 时菜单不出现账号选项(行为同现状)", async () => {
    const s = new Session("SYS", "deepseek-v4-pro");
    s.addUser("hi");
    let askedOptions: string[] = [];
    const streamChatMock = (() =>
      (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
        throw Object.assign(new Error("API error 429: rate_limit_exceeded"), { status: 429 });
      })()) as any;
    const interactiveCtx = {
      ...ctx,
      askChoice: async (_q: string, opts: string[]) => {
        askedOptions = opts;
        return opts.at(-1)!; // 中止
      },
    };
    await expect(
      runTurn({
        session: s, config, registry: emptyReg(), ctx: interactiveCtx as any, gate: stubGate,
        streamChat: streamChatMock,
        executeToolCalls: async () => [],
        write: () => {},
      }),
    ).rejects.toThrow(/限流|429/);
    expect(askedOptions).toEqual(["等待后用当前模型重试", "中止本轮(稍后可用 /account 切换账号)"]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/loop.test.ts -t "限流"`
Expected: 新增的三个测试 FAIL(`listOtherAccounts`/`switchAccountAndWait` 还不是 `TurnDeps` 的字段,TS 编译错误或运行时选项不匹配);已有的旧限流测试仍然 PASS。

- [ ] **Step 3: `TurnDeps` 加两个字段**

在 `src/agent/loop.ts` 的 `TurnDeps` 接口里,`fallbackModel` 字段(约第 87-88 行)后面加:

```ts
  // 限流菜单用:返回除当前激活账号外的全部账号名(交互场景,配合 askChoice 里的"切到账号 X"选项)。
  // 省略/返回空数组 = 菜单不出现账号切换选项,行为同现状。
  listOtherAccounts?: () => { name: string }[];
  // 切到指定账号并【等凭据真正解析完成】才返回(不能 fire-and-forget,否则切换后立刻重试会用错 apiKey)。
  // false = 账号不存在或凭据解析失败。
  switchAccountAndWait?: (name: string) => Promise<boolean>;
```

- [ ] **Step 4: 限流分支接入账号选项**

把 `src/agent/loop.ts` 里(约第 221-251 行)这一段:

```ts
        if (!deps.background && (rateLimited || genericRecoverable) && deps.ctx.askChoice) {
          events.notice(`\n[⚠ 请求失败] ${msg}\n`);
          const canOfferFallback = !rateLimited && !!deps.fallbackModel && !usedFallback;
          const options = [
            "等待后用当前模型重试",
            ...(canOfferFallback ? [`换成备用模型「${deps.fallbackModel}」试试(本回合)`] : []),
            rateLimited ? "中止本轮(稍后可用 /account 切换账号)" : "中止本轮",
          ];
          const choice = await deps.ctx.askChoice(
            rateLimited
              ? "当前账号触发限流(请求频率/配额超限)。接下来怎么办?"
              : "请求持续失败(疑似过载/超时/网络问题)。接下来怎么办?",
            options,
          );
          if (choice.startsWith("等待")) {
            rateLimitRetries++;
            const rateLimitBaseWaitMs = Number(process.env.DAO_RATE_LIMIT_WAIT_MS) || 5000;
            const waitMs = Math.min(rateLimitBaseWaitMs * rateLimitRetries, 30000);
            events.notice(`\n[等待 ${Math.round(waitMs / 1000)}s 后重试(仍用当前模型,不降级)…]\n`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          if (canOfferFallback && choice.startsWith("换成备用模型")) {
            usedFallback = true;
            events.notice(`\n[已按你的选择临时切到 ${deps.fallbackModel}…]\n`);
            continue;
          }
          throw new Error(
            `已中止:${rateLimited ? "当前账号触发限流(请求频率/配额超限)。可运行 /account 切换到其它账号后重新发送消息。" : "已按你的选择中止本轮。"}\n原始错误:${msg}`,
          );
        }
```

替换成:

```ts
        if (!deps.background && (rateLimited || genericRecoverable) && deps.ctx.askChoice) {
          events.notice(`\n[⚠ 请求失败] ${msg}\n`);
          const canOfferFallback = !rateLimited && !!deps.fallbackModel && !usedFallback;
          // 限流时菜单动态列出除当前账号外的全部账号(不猜"最合适的",账号数量不定时都摆出来,用户自己选)。
          const accountOptions = rateLimited
            ? (deps.listOtherAccounts?.() ?? []).map((a) => ({ label: `切到账号「${a.name}」重试`, name: a.name }))
            : [];
          const options = [
            "等待后用当前模型重试",
            ...(canOfferFallback ? [`换成备用模型「${deps.fallbackModel}」试试(本回合)`] : []),
            ...accountOptions.map((o) => o.label),
            rateLimited ? "中止本轮(稍后可用 /account 切换账号)" : "中止本轮",
          ];
          const choice = await deps.ctx.askChoice(
            rateLimited
              ? "当前账号触发限流(请求频率/配额超限)。接下来怎么办?"
              : "请求持续失败(疑似过载/超时/网络问题)。接下来怎么办?",
            options,
          );
          if (choice.startsWith("等待")) {
            rateLimitRetries++;
            const rateLimitBaseWaitMs = Number(process.env.DAO_RATE_LIMIT_WAIT_MS) || 5000;
            const waitMs = Math.min(rateLimitBaseWaitMs * rateLimitRetries, 30000);
            events.notice(`\n[等待 ${Math.round(waitMs / 1000)}s 后重试(仍用当前模型,不降级)…]\n`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          if (canOfferFallback && choice.startsWith("换成备用模型")) {
            usedFallback = true;
            events.notice(`\n[已按你的选择临时切到 ${deps.fallbackModel}…]\n`);
            continue;
          }
          // 切账号是持久的(等同手动 /account),不是"仅本轮"——账号被限流之后没理由下一轮切回去。
          const matchedAccount = accountOptions.find((o) => o.label === choice);
          if (matchedAccount && deps.switchAccountAndWait) {
            const ok = await deps.switchAccountAndWait(matchedAccount.name);
            if (ok) {
              events.notice(`\n[已切换到账号「${matchedAccount.name}」,继续重试…]\n`);
              continue;
            }
            // 失败不静默吞掉、不重试同账号(会立刻再撞同一个 429)——落到下面的 throw,把切换失败的原因和
            // 原始限流错误一起交给用户,而不是悄悄回到等待/中止的选项让用户自己再猜一次发生了什么。
            events.notice(`\n[切换到账号「${matchedAccount.name}」失败(账号不存在或凭据解析失败),仍在原账号]\n`);
          }
          throw new Error(
            `已中止:${rateLimited ? "当前账号触发限流(请求频率/配额超限)。可运行 /account 切换到其它账号后重新发送消息。" : "已按你的选择中止本轮。"}\n原始错误:${msg}`,
          );
        }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/agent/loop.test.ts`
Expected: 全部 PASS,含新增的 3 个测试和原有全部限流/过载相关测试。

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop.ts src/agent/loop.test.ts
git commit -m "feat(agent): 限流菜单支持直接切换账号重试"
```

---

### Task 2: `index.ts` 接线——活引用 config + `switchAccountAndWait` + 传入 TurnDeps

**Files:**
- Modify: `src/index.ts:458-471`(`switchAccount` 旁新增 `switchAccountAndWait`)
- Modify: `src/index.ts`(交互 `submit` 回调里 `runTurn(...)` 调用,约第 1453-1475 行)

**Interfaces:**
- Consumes: Task 1 产出的 `TurnDeps.listOtherAccounts`/`TurnDeps.switchAccountAndWait`(类型与语义见 Task 1)。
- Consumes(已存在,直接复用):`listAccounts()`(`index.ts:448`,返回 `{name, active, detail}[]`)、`resolveCredential(profilesCfg, kc)`(`src/config/credential.ts:18`,返回 `Promise<ResolvedCredential | null>`)、`profilesCfg`/`setActive`/`saveProfiles`/`cfg`/`session`/`keySource`(现有闭包变量,`switchAccount` 已在用,见 `index.ts:458-471`)。

此任务无法用独立单元测试覆盖——`index.ts` 是 2000+ 行的 CLI 入口闭包,当前没有 `index.test.ts`,现有的 `switchAccount`/`listAccounts`/`addAccount` 等同类函数也都没有专门的单测(通过 `npm run typecheck` + 完整测试套件回归验证,和这些既有函数的验证方式一致)。

- [ ] **Step 1: 新增 `switchAccountAndWait`**

在 `src/index.ts` 里,紧跟在 `switchAccount` 函数(`index.ts:458-471`)后面加:

```ts
  // 限流重试用的版本:和 switchAccount 逻辑一致,但 await 凭据解析完成才返回——
  // 调用方紧接着就要用新账号重试请求,不能像 switchAccount 那样 fire-and-forget
  // (那样的话 apiKey 大概率还没解析完,重试会用错账号的 key)。
  const switchAccountAndWait = async (name: string): Promise<boolean> => {
    if (!profilesCfg.profiles[name]) return false;
    profilesCfg = setActive(profilesCfg, name);
    saveProfiles(keyFile, profilesCfg).catch(() => {});
    const p = profilesCfg.profiles[name];
    if (p) {
      cfg.baseUrl = p.baseUrl; cfg.model = p.model; cfg.provider = p.provider;
      session.setModel(p.model);
    }
    const r = await resolveCredential(profilesCfg, kc);
    if (!r) return false;
    cfg.apiKey = r.key; keySource = r.source;
    return true;
  };
```

- [ ] **Step 2: `TurnDeps.config` 从快照改成活引用**

在 `submit` 回调内(搜索 `await withPresence(() => runTurn({`,约第 1453 行),找到:

```ts
          await withPresence(() => runTurn({
            session,
            config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
```

改成:

```ts
          await withPresence(() => runTurn({
            session,
            config: cfg, // 活引用(不是快照)——账号切换要在同一次 runTurn 调用期间立刻生效
```

- [ ] **Step 3: 把 `listOtherAccounts`/`switchAccountAndWait` 传进这次 `runTurn` 调用**

同一个 `runTurn({...})` 调用里,找到 `drainAdvisories: () => pendingReflectAdvisories.splice(0), // 反思器+(暂留)reply 的 advisory` 这一行(约第 1470 行),在它后面加:

```ts
            drainAdvisories: () => pendingReflectAdvisories.splice(0), // 反思器+(暂留)reply 的 advisory
            listOtherAccounts: () => listAccounts().filter((a) => !a.active).map((a) => ({ name: a.name })),
            switchAccountAndWait,
```

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 无报错(`cfg` 的字面量类型 `{apiKey, baseUrl, model, provider}` 结构上满足 `TurnDeps.config: {baseUrl: string; apiKey: string}`)。

- [ ] **Step 5: 完整测试套件回归**

Run: `npx vitest run`
Expected: 全部通过(除本次改动前就已存在、与本功能无关的失败——若跑之前先用 `git status` 确认工作区里没有其它未完成的改动残留)。

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(account): 限流重试接上账号切换(活引用 config + await 凭据解析)"
```

---

### Task 3: 系统提示词补一句(可选但建议)——让模型知道这个新选项存在

**Files:**
- Modify: `src/prompt/system_prompt.ts`

严格来说这个功能不需要模型主动做什么(`askChoice` 弹出时用户直接选,模型只是转发选择结果),不加也能跑。但当前系统提示词里没有任何地方提过"限流时可以怎么办",模型在事后总结/建议用户时可能还在用旧话术("建议手动 /account 切换")。补一句让措辞保持一致。

- [ ] **Step 1: 搜索现有限流相关提示词位置**

Run: `grep -n "限流\|rate.limit" src/prompt/system_prompt.ts`

如果没有任何现有段落提到限流场景,跳过这个任务(说明系统提示词本来就不覆盖这类运行时错误处理话术,不需要新增——这类交互完全由 `askChoice` 菜单驱动,不依赖模型指令)。

---

## 完成后验证(整体)

- [ ] `npm run typecheck` 通过
- [ ] `npx vitest run` 通过(排除已知与本功能无关的既有失败)
- [ ] 手工核对:`grep -n "switchAccountAndWait\|listOtherAccounts" src/index.ts src/agent/loop.ts` 能看到 Task 1/2 里定义的全部接线点

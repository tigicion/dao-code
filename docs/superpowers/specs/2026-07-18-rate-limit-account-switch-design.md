# 限流时快捷切换账号

## 目标

当前账号(profile)触发 provider 限流时,让"换个账号重试"这个动作直接接进已有的限流选择菜单,不用先中止本轮再手动跑 `/account`。

## 背景

`loop.ts` 的 `requestAssistant` 遇到限流(`isRateLimitError`)时,交互场景下已经会弹一个 `ctx.askChoice` 菜单,但选项只有"等待后用当前模型重试"和"中止本轮(稍后可用 /account 切换账号)"——账号切换本身不在菜单里,要中止、手动敲命令、再从选择器里选,三步。

`/account`(无参)已经有交互选择器(`AppDeps.listAccounts`/`switchAccount`),但那是给用户主动切账号用的,和限流这个信号没有联动。

## 设计

### 菜单变化

限流分支的 `options` 动态追加"切到账号「X」重试"——X 遍历除当前激活账号外的**全部**账号(不猜"最合适的那个",账号数量不定时都列出来,用户自己挑,参考现有"换成备用模型"选项的位置和措辞风格)。

```
当前账号触发限流(请求频率/配额超限)。接下来怎么办?
❯ 等待后用当前模型重试
  切到账号「work」重试
  切到账号「backup」重试
  中止本轮(可用 /account 切换账号)
```

选中后:切换 → 打一行 notice 告知切到了哪个账号 → `continue` 用新账号重试**同一个请求**(和现有"等待"分支收尾方式一致,不是丢弃重来)。

### 持久化语义

切换是**持久的**,和手动 `/account` 完全一样——不是"仅本轮"临时借用。账号被限流之后没理由下一轮再切回去,后续所有回合(包括之后新开的对话)都留在切换后的账号上,直到用户自己再切。落盘方式复用现有 `switchAccount` 内部的 `saveProfiles`。

### 技术前提:两处现有实现要跟着改

1. **`TurnDeps.config` 从快照改成活引用**:`index.ts` 里 `submit` 回调目前传 `config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }`——每次 submit 复制一份新对象,不是对 `cfg` 的引用。账号切换发生在 `runTurn` 内部(同一次 submit 调用期间),如果不改,`deps.config.baseUrl/apiKey` 不会跟着变,重试仍然打在旧账号上。改成直接传 `cfg` 本身(`config: cfg`,`cfg` 的字段是 `TurnDeps.config` 类型的超集,结构兼容)。

2. **切换要等凭据真正解析完再重试**:现有 `switchAccount()`(`index.ts:458`)里 `apiKey` 是异步取的(`resolveCredential(...).then(...)`,fire-and-forget,不 await)。限流重试这条路径如果用现在这版,大概率在 apiKey 还没解析完时就已经发出重试请求,拿到的是旧 key。需要一个**会 await 凭据解析完成**的版本(下面组件设计里的 `switchAccountAndWait`),`/account` 手动切换命令仍用现有的 fire-and-forget 版本(那条路径本来就不需要立即重试请求,不必等)。

### 组件改动

- `src/index.ts`
  - `switchAccount` 旁新增 `switchAccountAndWait(name): Promise<boolean>`——逻辑与 `switchAccount` 相同,但 `await resolveCredential(...)` 而不是 `.then()`,失败返回 `false`(账号不存在,或凭据解析失败——理由随 false 一起走 notice 文案,不静默)。
  - `submit` 回调里 `runTurn(...)` 的 `config` 字段从对象字面量改成直接传 `cfg`。
  - 新增两个 `TurnDeps` 字段并在 `submit` 回调里接线:
    - `listOtherAccounts: () => { name: string }[]`(排除当前激活账号,读 `profilesCfg`)
    - `switchAccountAndWait: (name: string) => Promise<boolean>`
- `src/agent/loop.ts`
  - `TurnDeps` 接口加上面两个可选字段。
  - 限流分支(`requestAssistant` 内,约 246-266 行)里:
    - `options` 数组:`deps.listOtherAccounts?.() ?? []` 遍历生成"切到账号「X」重试"选项(用 Map<label, accountName> 存对应关系,不从文本里反解析账号名,避免账号名本身带特殊字符时解析出错)。
    - 新分支:命中"切到账号"类选项 → `await deps.switchAccountAndWait!(name)` → 失败则 `events.notice` 报错并保留在原账号、不 continue(退回等待/中止的选择,不静默吞掉失败);成功则 `events.notice(\`[已切换到账号「${name}」,继续重试]\`)` → `continue`。
- `src/tui/app/types.ts` / `src/tui/app/App.tsx`:不需要改——这条路径完全在 `loop.ts`/`index.ts` 内部闭环,不经过 `AppDeps`(和 `/account` 命令是两条独立通路,共享底层 `profilesCfg`/`saveProfiles`)。

### 边界情况

- **只有 1 个账号(没有其它可切)**:`listOtherAccounts()` 返回空数组,菜单不出现"切到账号"选项,行为等同现状(等待/中止两个选项)。
- **切换后新账号也被限流**:自然走同一套逻辑再弹一次菜单,不特殊处理——不做"记住这个号刚被限流过、这次别再推荐它"这类过滤(用户已经明确不想要"猜"这一层,账号在菜单里选不选是用户的判断)。
- **background(子代理)场景**:限流分支本身已经用 `!deps.background` 挡住了(子代理没有交互能力),这次改动不影响该分支的既有行为。

## 测试计划

- `switchAccountAndWait`:账号不存在 → false;凭据解析失败 → false;成功 → true 且 `cfg`/`session.model`/`profilesCfg.activeProfile` 都更新。
- `loop.ts` 限流分支:`listOtherAccounts` 返回 2 个账号 → 菜单含两条"切到账号"选项;选中后调用 `switchAccountAndWait` 并在成功时 `continue`(mock `streamChat` 第二次调用用的是新账号的 baseUrl/apiKey,验证 `deps.config` 活引用确实生效);`switchAccountAndWait` 返回 false 时不 continue、给出错误 notice。
- `listOtherAccounts` 为空(只有 1 个账号)时菜单不含账号切换选项(回归现状行为)。

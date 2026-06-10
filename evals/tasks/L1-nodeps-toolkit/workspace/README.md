# toolkit —— 零依赖工具库

实现 `src/` 下四个模块的全部函数。**约束:零第三方依赖**(`dependencies` 必须为空,只用 Node 内置和纯 JS 实现)。

## 函数契约

### strings.mjs
- `slugify(s)`:转小写,非字母数字折叠为单个 `-`,去掉首尾 `-`。`"Hello, World!"` → `"hello-world"`。
- `truncate(s, n, suffix = "…")`:若 `s.length <= n` 原样返回;否则截到 `n - suffix.length` 个字符再接 `suffix`,使结果总长为 `n`。
- `titleCase(s)`:按空格分词,每词首字母大写、其余小写。`"hELLO world"` → `"Hello World"`。

### arrays.mjs
- `chunk(arr, size)`:按 `size` 切块,最后一块可短。`size <= 0` 抛 `RangeError`。
- `uniqBy(arr, keyFn)`:按 `keyFn(item)` 去重,保留首次出现,维持原顺序。
- `groupBy(arr, keyFn)`:返回普通对象,键为 `String(keyFn(item))`,值为该组元素数组(原顺序)。

### dates.mjs
- `formatDate(date, pattern)`:替换 `pattern` 中的 `YYYY MM DD HH mm ss`(均按本地时间、按需补零)。其它字符原样保留。
- `relativeTime(from, to = new Date())`:返回最大整数单位的相对描述。过去:`"5s ago"` `"3m ago"` `"2h ago"` `"4d ago"`;未来:`"in 5s"` 等。单位阈值:<60s 用 s,<60m 用 m,<24h 用 h,否则 d。差为 0 返回 `"just now"`。

### objects.mjs
- `deepClone(v)`:深拷贝。支持基本类型、数组、普通对象、`Date`;不共享任何引用。
- `pick(obj, keys)`:返回只含 `keys` 中存在键的新对象。

`src/index.mjs` 已把四个模块汇总导出,无需改动它。

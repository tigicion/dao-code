# 多模态图片输入 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dao 支持图片输入：用户可粘贴剪贴板截图、用 @路径引用图片，模型也可通过 read_file 工具主动读取图片。

**Architecture:** UserMessage/ToolMessage content 从 `string` 放宽为 `string | ContentPart[]`，使用 OpenAI 标准 `image_url` 格式（`data:image/png;base64,...` 内联）。TUI 层检测剪贴板图片和 @图片路径，工具层读图片文件返回 base64。压缩时 strip 图片仅保留 `[image]` 文字标记。

**Tech Stack:** TypeScript, Ink(TUI), OpenAI 兼容 API

## Global Constraints

- `ContentPart` 类型定义在 `src/client/types.ts`，使用 `image_url` 格式（兼容千帆/DeepSeek/火山等 OpenAI 兼容 API）
- `VISION_MODELS` 硬编码在 `src/config/profiles.ts`，新模型追加须有官方文档依据
- 图片来源安全边界与 `read_file` 一致：工作区内直接读，区外需用户授权
- 图片只在当轮生效，压缩时替换为 `[image]` 文字标记
- 不支持图片的模型（不在 VISION_MODELS 中）拒绝图片输入并在 UI 给出提示
- macOS 为首版平台（osascript），Linux/Windows 预留但不实现

---

### Task 1: 模型多模态能力表

**Files:**
- Modify: `src/config/profiles.ts`

**Interfaces:**
- Produces: `VISION_MODELS: Set<string>`, `supportsVision(model: string): boolean`

- [ ] **Step 1: 添加 VISION_MODELS 和 supportsVision**

```ts
// 在 src/config/profiles.ts 末尾追加

/** 支持视觉（图片输入）的模型名集合。按模型粒度精确匹配（跨 provider）。 */
export const VISION_MODELS = new Set<string>([
  "kimi-k2.6",
]);

/** 当前 model 是否支持图片输入。不在 VISION_MODELS 中的模型一律视为不支持。 */
export function supportsVision(model: string): boolean {
  return VISION_MODELS.has(model);
}
```

维护依据（2026-07-17 核实）：
- kimi-k2.6: Kimi 官方文档明确支持
- glm-5.2/glm-5.1: 智谱文档标注"输入模态:文本"，不支持
- ernie-5.1: 千帆模型列表在"文本生成"分类，不支持
- deepseek-v4-pro/flash: 千帆模型列表在"文本生成"分类，不支持

- [ ] **Step 2: 运行测试确认编译通过**

```bash
npx tsc --noEmit
```
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add src/config/profiles.ts
git commit -m "feat: add VISION_MODELS and supportsVision for multimodal gating"
```

---

### Task 2: ContentPart 类型定义 + ChatMessage 类型放宽

**Files:**
- Modify: `src/client/types.ts`
- Test: `src/session/session.test.ts`（addUser 签名变化）

**Interfaces:**
- Consumes: `VISION_MODELS`(从 Task 1), `supportsVision`(从 Task 1)
- Produces: `ContentPart`, `UserMessage.content: string | ContentPart[]`, `ToolMessage.content: string | ContentPart[]`, `ChatMessage`(自动更新)

- [ ] **Step 1: 在 types.ts 添加 ContentPart 并更新消息类型**

```ts
// 在 ChatMessage 类型定义之前添加

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface SystemMessage {
  role: "system";
  content: string;
}
export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
}
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  reasoningContent?: string;
}
export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string | ContentPart[];
}
```

- [ ] **Step 2: 更新估计 token 函数以支持 content 数组**

```ts
// 在 src/agent/compact.ts 的 estimateTokens 中
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") chars += part.text.length;
        // image_url 按固定开销估算（base64 不重复计，已在 read_file 返回中处理）
        else if (part.type === "image_url") chars += 100; // 图片占位符号的估算开销
      }
    }
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 3);
}
```

- [ ] **Step 3: 放宽 session.addUser 签名**

```ts
// src/session/session.ts
addUser(content: string | ContentPart[]): void {
  this.messages.push({ role: "user", content });
}
```

需要导入 ContentPart 类型。

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/session/session.test.ts src/agent/compact.test.ts 2>&1 | tail -10
```
Expected: 测试通过

- [ ] **Step 5: Commit**

```bash
git add src/client/types.ts src/session/session.ts src/agent/compact.ts
git commit -m "feat: add ContentPart type, relax UserMessage/ToolMessage content to accept arrays"
```

---

### Task 3: 修复粘贴行数计算

**Files:**
- Modify: `src/tui/app/App.tsx`

- [ ] **Step 1: 修复 usePaste 中的行数计算**

在 `App.tsx` 的 `usePaste` 回调中，当前代码约 825–832 行：

```tsx
usePaste((text) => {
    // ...approval/choice/ask 判断...
    let ins = text;
    const lineCount = text.replace(/\n+$/, "").split("\n").length;
```

改为：

```tsx
usePaste((text) => {
    // ...approval/choice/ask 判断...
    let ins = text;
    const normalized = text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    const lineCount = normalized ? normalized.split("\n").length : 0;
```

同时在 pastePreview 函数中（约 216 行）也做同样修复：

```tsx
const pastePreview = (s: string) => {
    let out = s;
    for (const [ph, full] of pasteRef.current) {
      if (!out.includes(ph)) continue;
      const normalized = full.replace(/\r\n/g, "\n").replace(/\n+$/, "");
      const lines = normalized ? normalized.split("\n") : [];
      const head = lines[0]?.slice(0, 100) ?? "";
      out = out.split(ph).join(t("ui.paste.preview", lines.length, head, head.length >= 100 || lines.length > 1 ? "…" : ""));
    }
    return out;
};
```

- [ ] **Step 2: 运行测试**

```bash
npx vitest run src/tui/app/App.test.tsx 2>&1 | tail -10
```
Expected: 44 测试通过

- [ ] **Step 3: Commit**

```bash
git add src/tui/app/App.tsx
git commit -m "fix: normalize line endings in paste line count (\\r\\n support)"
```

---

### Task 4: TUI 剪贴板图片粘贴

**Files:**
- Modify: `src/tui/app/App.tsx`
- Create: `src/tui/imagePaste.ts`（剪贴板图片检测/读取工具函数）
- Modify: `src/tui/app/types.ts`（AppDeps.submit 签名放宽）

**Interfaces:**
- Consumes: `supportsVision(model)`(Task 1), `ContentPart`(Task 2)
- Produces: `getImageFromClipboard(): Promise<{base64,mediaType} | null>`(新文件), `expandPastes` 返回 `string | ContentPart[]`

- [ ] **Step 1: 新建 `src/tui/imagePaste.ts`**

```ts
import { execFileNoThrow } from "./execFileNoThrow.js";

/** 检查剪贴板是否有图片（macOS 用 osascript） */
export async function hasClipboardImage(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const { execa } = await import("execa");
  const r = await execa("osascript", ["-e", "the clipboard as «class PNGf»"], { reject: false });
  return r.exitCode === 0;
}

/** 从剪贴板读取 PNG 图片，返回 base64 + mediaType。失败返回 null。 */
export async function getImageFromClipboard(): Promise<{ base64: string; mediaType: string } | null> {
  if (process.platform !== "darwin") return null;
  const { execa } = await import("execa");
  const tmpPath = `/tmp/dao_paste_${Date.now()}.png`;
  try {
    const save = await execa("osascript", [
      "-e", `set png_data to (the clipboard as «class PNGf»)`,
      "-e", `set fp to open for access POSIX file "${tmpPath}" with write permission`,
      "-e", `write png_data to fp`,
      "-e", `close access fp`,
    ], { reject: false, timeout: 5000 });
    if (save.exitCode !== 0) return null;
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(tmpPath);
    if (buf.length === 0) return null;
    // 5MB 护栏
    if (buf.length > 5 * 1024 * 1024) return null;
    return { base64: buf.toString("base64"), mediaType: "image/png" };
  } catch { return null; }
  finally {
    const { rm } = await import("node:fs/promises");
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

// 用于 execFileNoThrow 的简单封装——dao 不需要像 CC 那样精细
async function execFileNoThrow(file: string, args: string[]): Promise<{ exitCode: number }> {
  const { execa } = await import("execa");
  const r = await execa(file, args, { reject: false, timeout: 5000 });
  return { exitCode: r.exitCode ?? 1 };
}
```

- [ ] **Step 2: 在 App.tsx 中检测剪贴板图片并注入 ContentPart[]**

在 `usePaste` 回调中，检测空粘贴或图片文件路径粘贴：

```tsx
// 在 usePaste 回调末尾追加图片检测逻辑（约 830 行附近）
usePaste((text) => {
    // ... 现有的 approval/choice/ask 判断 ...
    // ... 现有的行数归一化逻辑 ...
    
    // macOS 空粘贴检测：剪贴板有图片
    if (process.platform === "darwin" && text.length === 0 && lineCount === 0) {
      void getImageFromClipboard().then(img => {
        if (!img) return;
        const id = ++pasteSeqRef.current;
        const ph = `[图片#${id}]`;
        pasteRef.current.set(ph, JSON.stringify([{ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.base64}` } }]));
        // 追加到输入框
        setField(f => ({ text: f.text + ph, cursor: f.text.length + ph.length }));
      });
      return;
    }
    
    // 现有的大段粘贴折叠逻辑...
});
```

- [ ] **Step 3: 修改 expandPastes 支持 ContentPart[] 值**

```tsx
// pasteRef 的类型需要更改
const pasteRef = useRef<Map<string, string>>(new Map()); // 不改类型——存 JSON.stringify 后的 ContentPart[]
const pasteSeqRef = useRef(0);

const expandPastes = (s: string): string | ContentPart[] => {
    let parts: (string | ContentPart[])[] = [s];
    for (const [ph, value] of pasteRef.current) {
      if (!s.includes(ph)) continue;
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) && parsed[0]?.type === "image_url") {
          // 图片展开：分解成 [文字部分, contentPart数组]
          const before = s.slice(0, s.indexOf(ph));
          const after = s.slice(s.indexOf(ph) + ph.length);
          parts = [before, parsed, after];
        } else {
          // 文字粘贴：仍用字符串展开
          parts = [s.split(ph).join(value)];
        }
      } catch {
        parts = [s.split(ph).join(value)];
      }
      break; // 只处理第一个占位符（简化）
    }
    // 合并：如果全是字符串就返回字符串，否则返回 ContentPart[]
    const strings = parts.filter((p): p is string => typeof p === "string");
    const arrays = parts.filter((p): p is ContentPart[] => Array.isArray(p));
    if (arrays.length === 0) return strings.join("");
    const result: ContentPart[] = [];
    for (const p of parts) {
      if (typeof p === "string" && p) result.push({ type: "text", text: p });
      else if (Array.isArray(p)) result.push(...p);
    }
    return result.length ? result : "";
};
```

需要导入 ContentPart 类型。

- [ ] **Step 4: 修改 deps.submit 和 runAgentTurn 签名**

在 `src/tui/app/types.ts` 中：

```ts
submit: (text: string | ContentPart[], hooks: { events: TurnEvents; signal: AbortSignal }) => Promise<void>;
```

在 `index.ts` 中（约 1378 行 `session.addUser(text)`）：确保 content 是 `string | ContentPart[]`。

- [ ] **Step 5: 不支持多模态的模型处理——提交前检查**

在 `onSubmit` 函数中（约 400 行 `runAgentTurn(full)` 调用前），添加：

```tsx
// onSubmit 函数内，调用 runAgentTurn 前
if (typeof full !== "string") {
  // 有图片内容 → 检查模型是否支持
  const currentModel = deps.getStatus().model;
  if (!supportsVision(currentModel)) {
    // 不支持 → 只发文字部分
    const textOnly = full.filter(p => p.type === "text").map(p => p.text).join(" ");
    pushItem({ id: nextId(), kind: "notice", text: `⚠ 当前模型 ${currentModel} 不支持图片输入，图片已忽略。可用支持图片的模型: ${[...VISION_MODELS].join(", ")}` });
    await runAgentTurn(textOnly || "[图片已忽略]");
    return;
  }
}
await runAgentTurn(full);
```

需要导入 `supportsVision` 和 `VISION_MODELS`。

- [ ] **Step 6: 运行测试**

```bash
npx vitest run src/tui/app/App.test.tsx 2>&1 | tail -10
```
Expected: 44 测试通过

- [ ] **Step 7: Commit**

```bash
git add src/tui/imagePaste.ts src/tui/app/App.tsx src/tui/app/types.ts
git commit -m "feat: TUI clipboard image paste support (macOS)"
```

---

### Task 5: TUI @文件路径图片识别

**Files:**
- Modify: `src/tui/app/App.tsx`
- Modify: `src/tools/paths.ts`（或新增工具函数 `isImagePath`）

- [ ] **Step 1: 在 paths.ts 或新文件添加图片后缀判断**

```ts
// src/tools/paths.ts 末尾追加

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** 判断路径是否指向支持的图片文件 */
export function isImagePath(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}
```

- [ ] **Step 2: 在 App.tsx 提交前检测 @图片路径**

在 `onSubmit` 中，展开 `full` 字符串后，扫描其中是否含图片路径模式：

```tsx
// 在 onSubmit 中、runAgentTurn(full) 之前
if (typeof full === "string") {
  const imagePaths = findImagePaths(full); // 从字符串中提取 @path/to/image.png
  if (imagePaths.length > 0) {
    const currentModel = deps.getStatus().model;
    if (!supportsVision(currentModel)) {
      pushItem({ id: nextId(), kind: "notice", text: `⚠ 当前模型 ${currentModel} 不支持图片输入，图片已忽略。可用: ${[...VISION_MODELS].join(", ")}` });
    } else {
      // 读图片文件 → 转为 ContentPart[]
      const parts: ContentPart[] = [{ type: "text", text: full }];
      for (const imgPath of imagePaths) {
        try {
          const { abs } = classifyPath(ctx.workspaceRoot, imgPath);
          const buf = await fs.readFile(abs);
          if (buf.length > 5 * 1024 * 1024) continue;
          const ext = path.extname(abs).toLowerCase().slice(1);
          const mediaType = ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
          parts.push({ type: "image_url", image_url: { url: `data:${mediaType};base64,${buf.toString("base64")}` } });
        } catch { continue; }
      }
      await runAgentTurn(parts);
      return;
    }
  }
}
```

辅助函数 `findImagePaths`：

```ts
function findImagePaths(text: string): string[] {
  const re = /@(\S+\.(?:png|jpe?g|gif|webp))/gi;
  const paths: string[] = [];
  let m;
  while ((m = re.exec(text)) !== null) paths.push(m[1]!);
  return paths;
}
```

- [ ] **Step 3: 运行测试**

```bash
npx vitest run src/tui/app/App.test.tsx 2>&1 | tail -10
```
Expected: 44 测试通过

- [ ] **Step 4: Commit**

```bash
git add src/tools/paths.ts src/tui/app/App.tsx
git commit -m "feat: support @image-path for image input in TUI"
```

---

### Task 6: read_file 工具支持图片

**Files:**
- Modify: `src/tools/read_file.ts`
- Modify: `src/client/types.ts`（ToolMessage 可选 imageData 字段）

**Interfaces:**
- Consumes: `isImagePath`(Task 5), `classifyPath`
- Produces: read_file 在遇到图片时返回结构化文字描述 + 通过 `ctx` 暂存图片 base64

- [ ] **Step 1: 在 ToolMessage 添加可选的 imageData 字段**

```ts
// src/client/types.ts
export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string | ContentPart[];
  /** 如果工具返回了图片数据，附带一份供 client/loop 层注入下一轮 user message */
  imageData?: { base64: string; mediaType: string };
}
```

- [ ] **Step 2: 修改 read_file.handler 支持图片**

```ts
// 在 src/tools/read_file.ts 中，二进制探测（NUL 检测）之前
const st = await fs.stat(abs);
// ... 现有大小护栏 ...

// 图片格式检测
if (isImagePath(args.path)) {
  const buf = await fs.readFile(abs);
  if (buf.length > 5 * 1024 * 1024) {
    return msg(
      `Error: 图片文件过大(${(buf.length / 1024 / 1024).toFixed(1)}MB > 5MB)。`,
      `Error: Image too large (${(buf.length / 1024 / 1024).toFixed(1)}MB > 5MB).`,
    );
  }
  // 探测真实格式(magic bytes)
  const mediaType = detectImageFormat(buf);
  if (!mediaType) {
    return msg(
      `Error: 无法识别图片格式，支持 png/jpg/gif/webp。`,
      `Error: Unrecognized image format. Supported: png/jpg/gif/webp.`,
    );
  }
  // 返回文字描述 + 通过 ctx 暂存图片数据(由 loop/execute 层处理)
  const base64 = buf.toString("base64");
  ctx.pendingImageData?.({ toolCallId: ctx.currentToolCallId, base64, mediaType });
  return msg(
    `[已读取图片: ${path.basename(args.path)} (${buf.length} bytes, ${mediaType})]`,
    `[Image loaded: ${path.basename(args.path)} (${buf.length} bytes, ${mediaType})]`,
  );
}
```

需要 `detectImageFormat` 辅助函数：

```ts
function detectImageFormat(buf: Buffer): string | null {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
  return null;
}
```

需要在 `read_file.ts` 添加导入 `isImagePath` 和 `Buffer`。

- [ ] **Step 3: 在 execute.ts 中处理 read_file 返回的图片数据**

`execute.ts` 需要读取 `ctx.pendingImageData` 并附加到 `ToolMessage.imageData`。但现有 context 没有 `pendingImageData` 字段。

更简单的方案：不在 execute 层处理，而是在 read_file handler 内部直接构造 ToolMessage 结构——但 handler 返回的是 `string`。

**替代方案**：将图片 base64 直接拼接到返回的字符串中，但用标记包裹让下游可以提取：

```ts
// read_file 返回：
return `[已读取图片: ${basename} (${size}, ${mediaType})]\n<!-- image:${base64}:${mediaType} -->\n[图片数据已附在下方，模型可基于图片内容回答问题]`;
```

但这会让上下文膨胀（base64 很大）。

**最终方案**：在 `read_file.ts` handler 中，通过 `ctx` 对象设置一个字段。handler 返回描述性文字。然后在 `execute.ts` 的 `dispatchOne` 中，检查 handler 是否设置了图片数据，如有则构造 `ToolMessage` 的 `content` 为 `ContentPart[]`。

但 `ctx` 目前没有这个字段。可以加到 `ToolContext` 中：

```ts
// src/tools/types.ts
export interface ToolContext {
  // ... 现有字段
  /** 当前 tool call 的 id（工具内部可读取） */
  currentToolCallId?: string;
  /** 暂存图片数据，由 execute.ts 在构建 ToolMessage 时读取并清空 */
  currentImageData?: { base64: string; mediaType: string };
}
```

在 `read_file.ts` 中：

```ts
if (isImagePath(args.path)) {
  // ... 读取、校验、探测 ...
  ctx.currentImageData = { base64: buf.toString("base64"), mediaType };
  return `[已读取图片: ${basename} (${size}, ${mediaType})]`;
}
```

在 `execute.ts` 的 dispatchOne 中（构造 ToolMessage 的地方，约 69-74 行）：

```ts
let content = await registry.dispatch(name, finalArgs, ctx);
// 检查是否有暂存的图片数据
const imgData = ctx.currentImageData;
ctx.currentImageData = undefined; // 清空
if (imgData) {
  // 将 ToolMessage content 构造为 ContentPart[]：文字描述 + 图片
  h?.block 处理...
  return {
    role: "tool",
    tool_call_id: tc.id,
    content: [
      { type: "text", text: content as string },
      { type: "image_url", image_url: { url: `data:${imgData.mediaType};base64,${imgData.base64}` } },
    ],
    imageData: imgData,
  };
}
```

- [ ] **Step 4: 更新 read_file 的 description**

```ts
description: "支持文本和图片文件(png/jpg/gif/webp)。...",
descriptionEn: "Supports text and image files (png/jpg/gif/webp). ...",
```

- [ ] **Step 5: 不支持多模态的模型处理——工具层检查**

在 read_file handler 中，图片读取后、返回前检查模型是否支持：

```ts
// 需要传入 ctx.model 或从 session.model 获取
const currentModel = ctx.sessionModel; // 需在 ToolContext 上暴露
if (currentModel && !supportsVision(currentModel)) {
  return `Error: 当前模型 ${currentModel} 不支持图片输入。`;
}
```

需要给 `ToolContext` 添加 `sessionModel?: string` 字段。

- [ ] **Step 6: 运行测试**

```bash
npx vitest run src/tools/read_file.test.ts 2>&1 | tail -10
npx tsc --noEmit
```
Expected: 全通过

- [ ] **Step 7: Commit**

```bash
git add src/tools/read_file.ts src/client/types.ts src/tools/types.ts src/tools/execute.ts
git commit -m "feat: read_file supports images with base64 output"
```

---

### Task 7: 压缩时 strip 图片

**Files:**
- Modify: `src/agent/compact.ts`

- [ ] **Step 1: 添加 stripImages 函数**

```ts
// 在 src/agent/compact.ts 末尾追加

/** 压缩前 strip 图片 block：替换为 [image] 文字标记，只占 ≈ 7 chars 而非整个 base64 */
export function stripImagesFromMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const stripped = m.content
      .map((part) => {
        if (part.type === "image_url") return { type: "text" as const, text: "[image]" };
        return part;
      })
      .filter((p, i, arr) => !(p.type === "text" && p.text === "[image]" && arr[i - 1]?.type === "text" && (arr[i - 1] as { text: string }).text === "[image]"));
    // 去重连续 [image]（多个图片浓缩成一个标记）
    return { ...m, content: stripped };
  });
}
```

在 `compactMessages` 调用 summarize 之前，调用此函数 strip 图片：

```ts
// 在 compactMessages 中、opts.summarize 调用之前
const stripped = stripImagesFromMessages([system, ...rest]);
summary = await opts.summarize(stripped);
```

- [ ] **Step 2: 运行测试**

```bash
npx vitest run src/agent/compact.test.ts 2>&1 | tail -10
npx tsc --noEmit
```
Expected: 全通过

- [ ] **Step 3: Commit**

```bash
git add src/agent/compact.ts
git commit -m "feat: strip images before compaction, replace with [image] marker"
```

---

### Task 8: client.ts wireMessages 透传 ContentPart[]

**Files:**
- Modify: `src/client/client.ts`

- [ ] **Step 1: 检查 wireMessages 是否需要调整**

当前 wireMessages 代码（约 54–58 行）：

```ts
const wireMessages = opts.messages.map((m) =>
  m.role === "assistant" && m.reasoningContent
    ? { role: m.role, content: m.content, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}) }
    : m,
);
```

OpenAI API 接受以下格式的 messages：
- `{ role: "user", content: "string" }` —— 纯文本
- `{ role: "user", content: [{ type: "text", text: "..." }, { type: "image_url", image_url: { url: "data:..." } }] }` —— 含图片
- `{ role: "tool", tool_call_id: "xxx", content: "string" }` —— 纯文本工具结果
- `{ role: "tool", tool_call_id: "xxx", content: [{ type: "text", text: "..." }, { type: "image_url", image_url: { url: "data:..." } }] }` —— 含图片的工具结果

现有代码只是 strip `reasoningContent`，然后把 messages 原样传给 API。由于 `ChatMessage` 类型已经变了但序列化为 JSON 时 content 可以是数组或字符串，API 能正确解析。

**不需要改动 client.ts**。但需要确认 OpenAI API 的 `tool` role 接受 content 数组。千帆/DeepSeek 都 follow OpenAI 格式，应该支持。

- [ ] **Step 2: 验证——实际发送含图片的请求到千帆 kimi-k2.6**

```bash
cd dao-code && npx tsx src/index.ts --api-key $(security find-generic-password -a "dao/qianfan" -w) --provider qianfan -p "回复:好" 2>&1 | tail -3
```

- [ ] **Step 3: Commit**

```bash
git add src/client/client.ts  # 可能没有改动，仅确认
git commit -m "chore: confirm wireMessages passes through ContentPart[] arrays"
```

---

### Task 9: 端到端验证

- [ ] **Step 1: 编译安装**

```bash
npm run bundle:install
```

- [ ] **Step 2: 用千帆 kimi-k2.6 实测图片输入**

```bash
KEY=$(security find-generic-password -a "dao/qianfan" -w)
# 先拷贝一张图片到剪贴板，然后：
# (方案 A: 等 TUI 交互模式验证)
dao --api-key "$KEY" --provider qianfan
# 在输入框按 Cmd+V 粘贴图片

# (方案 B: headless 测试图片 base64 内联)
# 用 read_file 读图片
```

- [ ] **Step 3: 全量测试**

```bash
npm run typecheck && npx vitest run
```

- [ ] **Step 4: Commit 最终调整**

```bash
git add -A && git commit -m "feat: end-to-end multimodal image input support"
```
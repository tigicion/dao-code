# 多模态图片输入

## 目标

让 dao 支持向模型发送图片：用户可在终端粘贴截图、用 @路径引用图片文件，模型也可通过 `read_file` 工具主动读取图片文件。仅支持"用户→模型"方向的图片输入，模型以文字回答。不支持图片生成。

## 背景

当前 dao 的 `UserMessage.content` 为纯 `string`，`read_file` 工具拒绝二进制文件，TUI 的 `usePaste` 只处理文本。千帆下的 `kimi-k2.6` 支持多模态（官方文档明确"支持图片和视频输入"），但 dao 无法利用该能力。

## 模型多模态能力表

基于官方文档核实（2026-07-17），按模型粒度判断：

| 模型 | 支持图片 | 来源 |
|------|---------|------|
| kimi-k2.6 | ✅ | Kimi 官方文档"支持图片和视频输入" |
| glm-5.2 | ❌ | 智谱文档"输入模态: 文本" |
| glm-5.1 | ❌ | 智谱文档"输入模态: 文本" |
| ernie-5.1 | ❌ | 千帆模型列表只在"文本生成"分类 |
| deepseek-v4-pro | ❌ | 千帆模型列表只在"文本生成"分类 |
| deepseek-v4-flash | ❌ | 同上 |

维护在 `src/config/profiles.ts` 的 `VISION_MODELS` 集合中，硬编码。新模型上市时追加，须有官方文档依据。不做成配置文件——模型能力是事实，不是用户偏好。

## 设计

### 1. 类型系统与 API 序列化

`UserMessage.content` 从 `string` 改为 `string | ContentPart[]`：

```ts
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }; // data:image/png;base64,... 格式

export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
}
```

- 使用 OpenAI `image_url` 格式（千帆/DeepSeek/火山均走 OpenAI 兼容 API）。
- `url` 字段用 `data:image/<mediaType>;base64,<base64>` 内联，无需额外上传。
- `wireMessages`（client.ts）数组格式直接透传，string 格式也直接透传。
- `session.addUser` 签名放宽为 `addUser(content: string | ContentPart[])`。现有调用点传 string，兼容不破。

### 2. TUI 图片输入

#### 剪贴板粘贴

Ink 的 `usePaste` 在 macOS 下收到空粘贴时（终端发空 bracketed paste 序列），意味着剪贴板里有图片：

1. 调 `osascript -e 'the clipboard as «class PNGf»'` 检查剪贴板是否有图片。
2. 有则用 `osascript` 把 PNG 写到临时文件 `/tmp/dao_latest_screenshot.png`。
3. 读文件 → base64 → 存入 `pasteRef`（复用现有大段粘贴折叠机制），占位符显示 `[图片#N]`。
4. 提交时 `expandPastes` 展开为 `ContentPart[]`。

`pasteRef` 的值类型从 `string` 变为 `string | ContentPart[]`。

#### @文件路径

现有 @文件补全已扫描工作区文件。补全时如果匹配项是图片后缀（`.png/.jpg/.jpeg/.gif/.webp`），提交时读文件转 base64 内联到 `ContentPart[]`。

安全边界与 `read_file` 一致：工作区内路径直接读，工作区外需用户授权放行（复用 `approveExternalRead`）。

#### transcript 回显

`pastePreview` 对图片占位符显示 `[图片#N]`，不展开 base64。

#### 平台支持

首版只实现 macOS（osascript）。Linux（xclip/wl-paste）、Windows（PowerShell Get-Clipboard）架构上预留但不实现。

#### 粘贴行数显示修复

当前 `usePaste` 的行数计算未规范化 `\r\n` 换行，导致 Windows 风格粘贴行数不准。修复：统一用 `text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")` 规范化后再计数。同时 `pastePreview` 中的行数计算也做同样修复。

### 3. read_file 工具支持图片

在二进制探测之前，先检查文件扩展名。如果是图片后缀（`.png/.jpg/.jpeg/.gif/.webp`），走图片读取路径：

1. `fs.readFile(abs)` 读原始 buffer。
2. 检测 magic bytes 确认真实格式（不信任扩展名）。
3. 大小护栏：超过 5MB 的图片做 resize 缩小（对标 CC 的 `maybeResizeAndDownsampleImageBuffer`）。
4. 返回结构化结果：`[image: <base64> | <mediaType> | <width>x<height>]`。

**工具结果如何变成 API 的 image_url**：`read_file` 返回值是 `string`，进入 `ToolMessage.content`（OpenAI API 的 tool role content 只能是 string）。解决方案：

- 工具结果返回文字提示：`[已读取图片 screenshot.png (1920x1080, image/png)。图片内容已注入下一轮上下文。]`
- 图片 base64 挂到 tool result 的结构化字段（`ToolMessage` 扩展可选 `imageData` 字段）。
- `loop.ts` 把 tool result 回灌时，如果该 tool call 的结果含图片，在紧接着的 user 消息里注入 `ContentPart[]`（含 image_url）。

`read_file` 工具 description 更新：去掉"只读文本"措辞，改为"支持文本和图片（png/jpg/gif/webp）"。

### 4. 压缩时丢弃图片

对标 CC 的 `stripImagesFromMessages`：压缩时把所有 `ContentPart[]` 中的 `image_url` block 替换为 `[image]` 文字标记。图片只在当轮有效，压缩后只保留文字描述。

- 在 `compact.ts` 的压缩逻辑中，遍历 `UserMessage.content`，如果是数组且含 `image_url`，替换为 `{ type: "text", text: "[image]" }`。
- microCompact 同理。

### 5. 不支持多模态的模型处理

当当前模型不支持图片（不在 `VISION_MODELS` 中）时：

1. **用户输入图片时**（TUI 层）：显示提示 `⚠ 当前模型 <model> 不支持图片输入，图片将被忽略。可用模型: kimi-k2.6, ...`，图片不注入 content 数组（省 token），文字部分正常发送。
2. **模型调用 `read_file` 读图片时**（工具层）：工具返回 `Error: 当前模型 <model> 不支持图片输入，无法读取图片文件。`，不注入 base64。
3. **切换模型/账户后**：每次提交时实时检查（不缓存）。

## 影响面

- `src/client/types.ts`：新增 `ContentPart` 类型，`UserMessage.content` 放宽。
- `src/client/client.ts`：`wireMessages` 透传数组格式（可能无需改，已透传）。
- `src/session/session.ts`：`addUser` 签名放宽。
- `src/config/profiles.ts`：新增 `VISION_MODELS` 和 `supportsVision`。
- `src/tui/app/App.tsx`：`usePaste` 图片检测、`pasteRef` 类型扩展、`pastePreview` 图片占位、@路径图片识别、粘贴行数修复。
- `src/tools/read_file.ts`：图片后缀识别、图片读取路径、结构化返回。
- `src/client/types.ts`：`ToolMessage` 扩展 `imageData` 可选字段。
- `src/agent/loop.ts`：tool result 含图片时注入 user 消息。
- `src/agent/compact.ts`：strip 图片逻辑。
- `src/tools/paths.ts`：图片后缀判断工具函数。
- 测试：新增各层单测。

## 依赖

- 图片 resize 需要引入 `sharp`（CC 也用 sharp），或用轻量方案（首版可直接拒绝 >5MB 图片，不做 resize，简化实现）。

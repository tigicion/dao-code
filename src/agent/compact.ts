import type { ChatMessage, ContentPart } from "../client/types.js";
// 粗估 token:中英混排约 3 字符/token;统计 content 与 assistant 的 tool_calls。
export function estimateTokens(messages: ChatMessage[]): number {
    let chars = 0;
    for (const m of messages) {
        if (typeof m.content === "string")
            chars += m.content.length;
        else if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part.type === "text")
                    chars += part.text.length;
                else
                    chars += 100; // image_url 固定开销估算
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
export function compressionRatio(window: number, configured = .5): number {
    return window < 512000 ? Math.max(.75, configured) : configured;
}
export function shouldCompact(messages: ChatMessage[], maxTokens: number, ratio = compressionRatio(maxTokens)): boolean {
    return estimateTokens(messages) >= maxTokens * ratio;
}
export interface CompactOptions {
    summarize: (messages: ChatMessage[]) => Promise<string>;
    maxTokens?: number;
    protectLastN?: number;
    archiveAvailable?: boolean;
}
/** Hermes-style summary + bounded recent raw tail. Caller archives BEFORE invoking this. */
export async function compactMessages(messages: ChatMessage[], opts: CompactOptions, pinned?: string): Promise<ChatMessage[]> {
    if (messages.length <= 3)
        return messages;
    const system = messages[0]!;
    const budget = Math.max(512, Math.min(8000, Math.floor((opts.maxTokens ?? 32000) * .15)));
    let start = Math.max(1, messages.length - (opts.protectLastN ?? 20));
    // Never start in the middle of assistant tool calls and results.
    while (start > 1 && messages[start]?.role === "tool")
        start--;
    while (start < messages.length - 2 && estimateTokens(messages.slice(start)) > budget) {
        let next = start + 1;
        while (next < messages.length && messages[next]?.role === "tool")
            next++;
        // Keep the final call/result group whole; bound its payloads below.
        if (next >= messages.length)
            break;
        start = next;
    }
    let tail = messages.slice(start);
    const lastUser = messages.findLast(m => m.role === "user" && !m.origin);
    if (lastUser && !tail.includes(lastUser))
        tail = [lastUser, ...tail];
    // Raw evidence remains in the archive. Very large tool payloads get bounded API copies.
    tail = tail.map(m => m.role === "tool" && typeof m.content === "string" && m.content.length > 4000 ? { ...m, content: m.content.slice(0, 3000) + "\n[tool output pruned; recover original with session_search]" } : m);
    const retained = new Set(tail.map(m => m.archiveId).filter(Boolean));
    const old = messages.slice(1, start).filter(m => !tail.includes(m) && !(m.archiveId && retained.has(m.archiveId)));
    if (!old.length)
        return messages;
    let summary: string;
    try {
        summary = await opts.summarize(stripImagesFromMessages([system, ...old]));
        if (!summary.trim())
            throw new Error("Empty summary");
    }
    catch {
        summary = "Summary unavailable. Continue from the retained recent messages and task list.";
    }
    // Re-summarize old summaries; repeatedly concatenating them grows context without bound.
    summary = Array.from(summary).slice(0, Math.max(3000, budget * 3)).join("");
    const anchors = old.filter(m => m.archiveId).slice(-8).map(m => m.archiveId).join(", ");
    const evidence = opts.archiveAvailable ? `Original messages remain searchable via session_search. Anchors: ${anchors}` : "Original archive is unavailable for this execution context.";
    return [system, { role: "system", origin: "compaction", content: `[早期对话摘要]\n${summary}\n${evidence}\nContinue the current task without repeating this summary.` }, ...(pinned?.trim() ? [{ role: "system" as const, origin: "task_pin", content: `[当前任务清单]\n${pinned}` }] : []), ...tail];
}
/** 压缩前 strip 图片 block:替换为 [image] 文字标记,避免 base64 膨胀压缩请求。 */
export function stripImagesFromMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => {
        if (!Array.isArray(m.content))
            return m; // system/纯文本 user/tool 不含图片
        let changed = false;
        const stripped: ContentPart[] = [];
        for (const part of m.content) {
            if (part.type === "image_url") {
                changed = true;
                // 连续 [image] 去重:上一个已是 [image] 则不再追加
                const last = stripped[stripped.length - 1];
                if (!(last && last.type === "text" && last.text === "[image]")) {
                    stripped.push({ type: "text", text: "[image]" });
                }
            }
            else {
                stripped.push(part);
            }
        }
        if (!changed)
            return m;
        // 只可能是 user 或 tool 消息(system content 是 string,上面已 return)
        return { ...m, content: stripped } as ChatMessage;
    });
}

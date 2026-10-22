import { describe, expect, it } from "vitest";
import { contentText, messagePage } from "./deck_messages.js";

describe("Deck 消息历史", () => {
  it("多模态文本保留换行,不泄漏图片数据", () => {
    expect(contentText([{ type: "text", text: "正文" }, { type: "image_url", image_url: { url: "data:secret" } }]))
      .toBe("正文\n[图片附件 · 请在原终端查看]");
  });
  it("向前分页无重复,过滤系统消息,压缩后修订号改变", () => {
    const all = [{ role: "system", content: "秘密" }, ...Array.from({ length: 205 }, (_, i) => ({ role: "user", content: String(i) }))];
    const a = messagePage(all), b = messagePage(all, a.pagination.nextBefore), c = messagePage(all, b.pagination.nextBefore);
    expect([...c.messages, ...b.messages, ...a.messages].map(m => m.content)).toEqual(all.slice(1).map(m => m.content));
    expect(c.pagination.hasMore).toBe(false);
    expect(messagePage(all.slice(100)).pagination.revision).not.toBe(a.pagination.revision);
    expect(messagePage(all.slice(0, 1)).messages).toEqual([]);
  });
  it("大消息和工具参数有明确截断标志", () => {
    const page = messagePage([{ role: "assistant", content: "字".repeat(30000), tool_calls: [
      { id: "a", function: { name: "Write", arguments: "x".repeat(13000) } },
    ] }]);
    expect(page.messages[0]).toMatchObject({ contentTruncated: true, contentLength: 30000 });
    expect(page.messages[0]!.toolCalls![0]).toMatchObject({ argsTruncated: true });
    expect(page.messages[0]!.content).toHaveLength(24000);
    expect(page.messages[0]!.toolCalls![0]!.args).toHaveLength(12000);
  });
});

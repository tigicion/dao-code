import { z } from "zod";
import { defineTool } from "./types.js";

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDdgUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? "https:" + href : href;
}

export const webSearchTool = defineTool({
  name: "web_search",
  description: "用 DuckDuckGo 联网搜索,返回若干条结果(标题、URL、摘要)。",
  capability: "network",
  approval: "suggest",
  schema: z.object({
    query: z.string().describe("搜索关键词"),
    max_results: z.number().int().min(1).max(10).optional().describe("返回结果数,默认 5"),
  }),
  handler: async (args, ctx) => {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
    const res = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`搜索失败 HTTP ${res.status}`);
    const html = await res.text();
    const max = args.max_results ?? 5;

    const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    const links: { url: string; title: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null && links.length < max) {
      links.push({ url: decodeDdgUrl(m[1]!), title: stripTags(m[2]!) });
    }
    const snippets: string[] = [];
    while ((m = snipRe.exec(html)) !== null && snippets.length < max) {
      snippets.push(stripTags(m[1]!));
    }

    if (links.length === 0) return "(无搜索结果)";
    return links
      .map((l, i) => `${i + 1}. ${l.title}\n   ${l.url}\n   ${snippets[i] ?? ""}`.trimEnd())
      .join("\n\n");
  },
});

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
    const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i;

    const linkMatches = [...html.matchAll(linkRe)];
    const results: { url: string; title: string; snippet: string }[] = [];
    for (let k = 0; k < linkMatches.length && results.length < max; k++) {
      const lm = linkMatches[k]!;
      const start = (lm.index ?? 0) + lm[0].length;
      const end = k + 1 < linkMatches.length ? (linkMatches[k + 1]!.index ?? html.length) : html.length;
      const segment = html.slice(start, end);
      const sm = segment.match(snipRe);
      results.push({
        url: decodeDdgUrl(lm[1]!),
        title: stripTags(lm[2]!),
        snippet: sm ? stripTags(sm[1]!) : "",
      });
    }

    if (results.length === 0) return "(无搜索结果)";
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`.trimEnd())
      .join("\n\n");
  },
});

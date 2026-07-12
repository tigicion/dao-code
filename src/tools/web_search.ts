import { z } from "zod";
import { defineTool } from "./types.js";
import { msg } from "./lang.js";

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
  description: "用 DuckDuckGo 联网搜索,返回若干条结果(标题、URL、摘要),默认 5 条、最多 10 条(max_results 调)。" +
    "30 秒超时。只有摘要,没有正文——摘要能回答问题就直接用,需要完整内容(具体数据、代码示例、长文细节)时" +
    "对看起来最相关的那条结果 URL 再调 fetch_url,别对着摘要瞎猜细节。查的是当下的网络实时结果,不是你训练数据里的旧知识——" +
    "涉及'最新版本/最近发生的事'这类时效性问题时优先用它而不是凭记忆回答。举例:用户问某个库最新版本改了什么," +
    "别直接报你训练数据里记得的旧版本信息,先搜一下确认现在真实的最新情况。DuckDuckGo 搜的是公开网页,搜不到" +
    "私有仓库/内网文档/需要登录的页面,这类内容还是得靠用户直接提供或本地文件读取。",
  descriptionEn: "Searches the web via DuckDuckGo, returning results (title, URL, snippet), 5 by default, up to 10 (adjustable via max_results). 30s timeout. " +
    "Snippets only, no page content — use the snippet directly if it already answers the question; when you need full content (specific data, code examples, " +
    "long-form detail), call fetch_url on whichever result URL looks most relevant, don't guess at details from the snippet alone. This queries live current " +
    "results, not your training-data knowledge — for time-sensitive questions ('latest version', 'what just happened'), prefer this over answering from memory. " +
    "Example: user asks what changed in a library's latest release — don't answer from the stale version you remember, search first to confirm the real current state. " +
    "DuckDuckGo only reaches public web pages — private repos, internal docs, or login-gated pages won't show up; those still need the user to provide them directly " +
    "or a local file read.",
  capability: "network",
  approval: "suggest",
  schema: z.object({
    query: z.string().describe("搜索关键词"),
    max_results: z.number().int().min(1).max(10).optional().describe("返回结果数,默认 5"),
  }),
  handler: async (args, ctx) => {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
    // 超时 30s + 尊重 ctx.signal:搜索引擎慢/挂不会卡死整个回合。
    const signals = [AbortSignal.timeout(30000), ...(ctx.signal ? [ctx.signal] : [])];
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.any(signals) });
    } catch (e) {
      const reason = e instanceof Error && e.name === "TimeoutError" ? "搜索超时(30s)" : e instanceof Error ? e.message : String(e);
      return msg(`Error: 搜索失败(${reason})`, `Error: Search failed (${reason})`);
    }
    if (!res.ok) return msg(`Error: 搜索失败 HTTP ${res.status}`, `Error: Search failed HTTP ${res.status}`);
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

import { z } from "zod";
import { defineTool } from "./types.js";
import { blockedUrlReason } from "./ssrf.js";
import { msg } from "./lang.js";

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export const fetchUrlTool = defineTool({
  name: "WebFetch",
  description: "抓取一个网页 URL,去掉 script/style 和全部标签后返回纯文本,默认最多 20000 字符(可用 max_chars 调)," +
    "超长会截断。30 秒超时,慢站/坏 URL 不会卡住整个回合。拒绝内网/环回/云元数据地址(SSRF 防护,防止被诱导拿这个" +
    "工具去探内网)。只拉原始 HTML,不执行 JS——重度依赖客户端渲染(SPA)的页面,拿到的可能只是空壳,读不到真实内容," +
    "这种情况别误以为页面本来就是空的。适合抓文档页/博客文章/GitHub README 这类以纯文本内容为主的静态页面;" +
    "现代前端框架(React/Vue 之类的仪表盘)大概率抓不出有效内容,遇到这种优先考虑对方有没有提供 API。" +
    "返回内容超过 max_chars 会在末尾标注'已截断',看到这个提示就该意识到没拿到全文,需要的话调低目标或分段再抓," +
    "别把截断后的片段当完整内容来下结论。",
  descriptionEn: "Fetches a web page URL, strips script/style and all tags, returns plain text — up to 20000 chars by default (adjustable via max_chars), " +
    "truncated if longer. 30s timeout so a slow site or bad URL never hangs the whole turn. Refuses internal/loopback/cloud-metadata addresses (SSRF protection, " +
    "prevents this tool being used to probe internal networks). Fetches raw HTML only, no JS execution — pages that rely heavily on client-side rendering (SPAs) " +
    "may return just an empty shell; don't assume the page is genuinely empty in that case. Good for docs pages, blog posts, GitHub READMEs — mostly static, " +
    "text-heavy pages; modern frontend-framework dashboards (React/Vue-style) likely won't yield useful content — check whether the site offers an API instead. " +
    "When output exceeds max_chars, it's marked '(truncated)' at the end — treat that as a sign you didn't get the full text, not as complete content to draw conclusions from.",
  capability: "network",
  approval: "suggest",
  schema: z.object({
    url: z.string().url().describe("要抓取的 http(s) URL"),
    max_chars: z.number().int().min(100).optional().describe("最多返回字符数,默认 20000"),
  }),
  handler: async (args, ctx) => {
    const blocked = blockedUrlReason(args.url); // S5.3 SSRF:拦内网/环回/云元数据端点
    if (blocked) return msg(`Error: 拒绝抓取(${blocked})`, `Error: Fetch denied (${blocked})`);
    const fetchImpl = ctx.fetchImpl ?? fetch;
    // 超时 30s + 尊重 ctx.signal(ESC):坏 URL/慢站不会永久挂死整个回合。
    const signals = [AbortSignal.timeout(30000), ...(ctx.signal ? [ctx.signal] : [])];
    let res: Response;
    try {
      res = await fetchImpl(args.url, { signal: AbortSignal.any(signals) });
    } catch (e) {
      const reason = e instanceof Error && e.name === "TimeoutError" ? "抓取超时(30s)" : e instanceof Error ? e.message : String(e);
      return msg(`Error: 抓取失败(${reason})`, `Error: Fetch failed (${reason})`);
    }
    if (!res.ok) return msg(`Error: 抓取失败 HTTP ${res.status}`, `Error: Fetch failed HTTP ${res.status}`);
    const html = await res.text();
    const text = htmlToText(html);
    const max = args.max_chars ?? 20000;
    return text.length > max ? text.slice(0, max) + "\n…(已截断)" : text;
  },
});

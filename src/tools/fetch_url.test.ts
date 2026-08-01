import { describe, it, expect, beforeEach } from "vitest";
import { fetchUrlTool } from "./fetch_url.js";
import { clearFetchCache } from "./fetch_cache.js";

function fetchReturning(html: string, status = 200): typeof fetch {
  return (async () => new Response(html, { status })) as unknown as typeof fetch;
}

describe("WebFetch tool", () => {
  beforeEach(() => clearFetchCache());

  it("strips tags, script/style, and decodes entities", async () => {
    const html =
      "<html><head><style>.x{}</style></head><body><script>evil()</script><p>Hi &amp; bye</p></body></html>";
    const out = await fetchUrlTool.handler(
      { url: "https://example.com" },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning(html) },
    );
    expect(out).toContain("Hi & bye");
    expect(out).not.toContain("<p>");
    expect(out).not.toContain("evil()");
    expect(out).not.toContain(".x{}");
  });

  it("truncates to max_chars", async () => {
    const html = "<p>" + "a".repeat(500) + "</p>";
    const out = await fetchUrlTool.handler(
      { url: "https://example.com", max_chars: 100 },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning(html) },
    );
    expect(out).toContain("…(已截断)");
    expect(out.length).toBeLessThan(160);
  });

  it("非2xx → 返回 Error 信息(不抛,便于模型读)", async () => {
    const out = await fetchUrlTool.handler(
      { url: "https://example.com" },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning("x", 404) },
    );
    expect(out).toContain("404");
    expect(out).toContain("Error");
  });

  it("declares network capability and suggest approval", () => {
    expect(fetchUrlTool.capability).toBe("network");
    expect(fetchUrlTool.approval).toBe("suggest");
    expect(fetchUrlTool.name).toBe("WebFetch");
  });

  it("同一 URL 15 分钟内命中缓存,不再重新发请求", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("<p>first</p>", { status: 200 });
    }) as unknown as typeof fetch;
    const ctx = { workspaceRoot: "/tmp", fetchImpl };
    const first = await fetchUrlTool.handler({ url: "https://cached.example.com" }, ctx);
    const second = await fetchUrlTool.handler({ url: "https://cached.example.com" }, ctx);
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(first).toContain("first");
  });

  it("非2xx 响应不缓存,下次调用会重新发请求", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("x", { status: 503 });
    }) as unknown as typeof fetch;
    const ctx = { workspaceRoot: "/tmp", fetchImpl };
    await fetchUrlTool.handler({ url: "https://flaky.example.com" }, ctx);
    await fetchUrlTool.handler({ url: "https://flaky.example.com" }, ctx);
    expect(calls).toBe(2);
  });
});

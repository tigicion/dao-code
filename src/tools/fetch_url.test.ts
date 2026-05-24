import { describe, it, expect } from "vitest";
import { fetchUrlTool } from "./fetch_url.js";

function fetchReturning(html: string, status = 200): typeof fetch {
  return (async () => new Response(html, { status })) as unknown as typeof fetch;
}

describe("fetch_url tool", () => {
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
    expect(fetchUrlTool.name).toBe("fetch_url");
  });
});

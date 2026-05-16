import { describe, it, expect } from "vitest";
import { webSearchTool } from "./web_search.js";

const FIXTURE = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">Title <b>A</b></a>
  <a class="result__snippet">Snippet A &amp; more</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/b">Title B</a>
  <a class="result__snippet">Snippet B</a>
</div>
`;

function fetchReturning(html: string, status = 200): typeof fetch {
  return (async () => new Response(html, { status })) as unknown as typeof fetch;
}

describe("web_search tool", () => {
  it("parses titles, decoded urls, and snippets from DDG html", async () => {
    const out = await webSearchTool.handler(
      { query: "anything" },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning(FIXTURE) },
    );
    expect(out).toContain("Title A");
    expect(out).toContain("https://example.com/a");
    expect(out).toContain("Snippet A & more");
    expect(out).toContain("Title B");
    expect(out).toContain("https://example.com/b");
  });

  it("honors max_results", async () => {
    const out = await webSearchTool.handler(
      { query: "x", max_results: 1 },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning(FIXTURE) },
    );
    expect(out).toContain("Title A");
    expect(out).not.toContain("Title B");
  });

  it("returns (无搜索结果) when html has no results", async () => {
    const out = await webSearchTool.handler(
      { query: "x" },
      { workspaceRoot: "/tmp", fetchImpl: fetchReturning("<html></html>") },
    );
    expect(out).toBe("(无搜索结果)");
  });

  it("throws on non-2xx", async () => {
    await expect(
      webSearchTool.handler(
        { query: "x" },
        { workspaceRoot: "/tmp", fetchImpl: fetchReturning("x", 503) },
      ),
    ).rejects.toThrow(/503/);
  });

  it("declares network capability and suggest approval", () => {
    expect(webSearchTool.capability).toBe("network");
    expect(webSearchTool.approval).toBe("suggest");
    expect(webSearchTool.name).toBe("web_search");
  });
});

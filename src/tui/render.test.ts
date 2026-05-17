import { describe, it, expect } from "vitest";
import { renderStream } from "./render.js";
import type { AssistantMessage, StreamDelta } from "../client/types.js";

function gen(deltas: StreamDelta[], message: AssistantMessage) {
  return (async function* (): AsyncGenerator<StreamDelta, AssistantMessage> {
    for (const d of deltas) yield d;
    return message;
  })();
}
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderStream", () => {
  it("streams reasoning then renders content as markdown, returns the message", async () => {
    const w: string[] = [];
    const msg = await renderStream(
      gen([{ kind: "reasoning", text: "思考中" }, { kind: "content", text: "# 标题" }], {
        role: "assistant",
        content: "# 标题",
      }),
      (s) => w.push(s),
    );
    const out = w.join("");
    expect(out).toContain("思考中");
    expect(strip(out)).toContain("标题");
    expect(out).toContain("\x1b[1m");
    expect(msg).toEqual({ role: "assistant", content: "# 标题" });
  });

  it("flushes buffered content before a tool-call marker", async () => {
    const w: string[] = [];
    await renderStream(
      gen(
        [{ kind: "content", text: "正文" }, { kind: "tool_call", index: 0, name: "read_file" }],
        {
          role: "assistant",
          content: "正文",
          tool_calls: [{ id: "c0", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
      ),
      (s) => w.push(s),
    );
    const out = strip(w.join(""));
    expect(out.indexOf("正文")).toBeLessThan(out.indexOf("read_file"));
    expect(out).toContain("→ read_file");
  });
});

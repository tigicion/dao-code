import { describe, it, expect } from "vitest";
import { runOnce } from "./runner.js";
import type { StreamDelta } from "./client/types.js";

async function* fakeStream(): AsyncGenerator<StreamDelta> {
  yield { kind: "reasoning", text: "let me think" };
  yield { kind: "content", text: "Hello" };
  yield { kind: "content", text: ", world" };
}

describe("runOnce", () => {
  it("streams reasoning and content to the writer and returns accumulated text", async () => {
    const written: string[] = [];
    const result = await runOnce({
      prompt: "hi",
      streamChat: () => fakeStream(),
      write: (s) => written.push(s),
    });

    expect(result.reasoning).toBe("let me think");
    expect(result.content).toBe("Hello, world");
    expect(written.join("")).toContain("Hello, world");
    expect(written.join("")).toContain("let me think");
  });

  it("passes the user prompt through as a user message", async () => {
    let seenMessages: unknown;
    await runOnce({
      prompt: "what is 2+2",
      streamChat: (opts) => {
        seenMessages = opts.messages;
        return fakeStream();
      },
      write: () => {},
    });
    expect(seenMessages).toEqual([{ role: "user", content: "what is 2+2" }]);
  });
});

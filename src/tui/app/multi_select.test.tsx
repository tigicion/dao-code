import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App.js";
import type { AppDeps } from "./types.js";

const delay = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1B[B";

function makeDeps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    welcome: {
      info: { model: "m", thinking: "max", cwd: "/x", version: "0.1.0", branch: "main" },
      caps: { tier: "none", isTTY: true, columns: 80 },
      bg: "dark",
      maxim: { text: "上善若水", chapter: 8 },
    },
    submit: async () => {},
    runCommand: () => ({ handled: true, output: "" }),
    compact: async () => {},
    getStatus: () => ({ model: "m", mode: "normal", promptTokens: 0, completionTokens: 0, cacheHitRatio: 0, yolo: false, branch: "main", contextPct: 0.1 }),
    register: () => {},
    ...over,
  };
}

function mount() {
  let askChoice: ((q: string, opts: string[], multi?: boolean) => Promise<string>) | null = null;
  const r = render(<App {...makeDeps({ register: (ui) => { askChoice = ui.askChoice; } })} />);
  return { ...r, getAskChoice: () => askChoice! };
}

describe("multi-select (ask_user)", () => {
  it("multi: 回车在正常项=勾选(不结束),到「完成」回车才提交", async () => {
    const { stdin, lastFrame, getAskChoice } = mount();
    await delay();
    const p = getAskChoice()("选哪些?", ["A", "B", "C"], true);
    await delay();
    let resolved = false;
    void p.then(() => { resolved = true; });

    stdin.write("\r");          // 在 A 上回车 → 勾选 A,不结束
    await delay();
    expect(lastFrame()).toContain("[x] A");
    expect(resolved).toBe(false);

    stdin.write(DOWN);          // ↓ 到 B
    await delay();
    stdin.write(" ");           // 空格勾 B
    await delay();
    expect(lastFrame()).toContain("[x] B");

    // 移到「完成」行(C → 完成),回车提交
    stdin.write(DOWN);          // → C
    await delay();
    stdin.write(DOWN);          // → ✓ 完成
    await delay();
    stdin.write("\r");
    expect(await p).toBe("A, B");
  });

  it("multi: 一项没勾就到「完成」回车 → 不静默提交,提示先勾选", async () => {
    const { stdin, lastFrame, getAskChoice } = mount();
    await delay();
    const p = getAskChoice()("选哪些?", ["A", "B"], true);
    await delay();
    let resolved = false;
    void p.then(() => { resolved = true; });

    // 直接跳到「完成」行(A → B → 完成)回车
    stdin.write(DOWN); stdin.write(DOWN);
    await delay();
    stdin.write("\r");
    await delay();
    expect(lastFrame()).toContain("还没勾选任何项");
    expect(resolved).toBe(false);
  });

  it("single: 回车即选中当前项并结束", async () => {
    const { stdin, getAskChoice } = mount();
    await delay();
    const p = getAskChoice()("选一个", ["甲", "乙"], false);
    await delay();
    stdin.write(DOWN);          // → 乙
    await delay();
    stdin.write("\r");
    expect(await p).toBe("乙");
  });
});

import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { shouldCaptureMemory, looksLikeCorrection, turnHadVerifyPass } from "./capture_policy.js";
import { distill } from "./distill.js";
import { routeScope, upsertMemory, loadAllMemories } from "./store.js";

// 端到端验证捕获管线(index.ts 两个捕获点做的事),只把【模型】换成假流:
//   用户原话 → looksLikeCorrection → shouldCaptureMemory → 真 distill(假模型)→ 真 upsertMemory 落盘。
// 证明"一句纠正最终变成磁盘上的 feedback 记忆",零 API 成本、确定性。
function fakeStream(text: string) {
  return async function* () {
    yield { kind: "content", text };
    return { role: "assistant", content: text };
  }();
}

describe("记忆捕获管线(端到端,假模型零 API)", () => {
  it("用户纠正一句 → 触发 → 蒸出 feedback → 落到 user 层", async () => {
    const proj = await fs.mkdtemp(path.join(os.tmpdir(), "cap-proj-"));
    const user = await fs.mkdtemp(path.join(os.tmpdir(), "cap-user-"));
    const know = await fs.mkdtemp(path.join(os.tmpdir(), "cap-know-"));

    const userText = "不对,以后提交一律不要加 Claude 署名";

    // 1) 触发判定(捕获点逻辑):纠正 + 有新材料 → user-correction
    const decision = shouldCaptureMemory({
      newTokens: 200,
      threshold: 15000,
      userCorrection: looksLikeCorrection(userText),
    });
    expect(decision).toEqual({ capture: true, reason: "user-correction" });

    // 2) 触发 → 真 distill(假模型吐一条 feedback)
    const feedback = JSON.stringify([
      { text: "提交一律不加 AI 署名。为什么:用户明确要求。怎么用:commit/PR 不写 Co-Authored-By。", type: "feedback", importance: 9 },
    ]);
    const cands = await distill({
      streamChat: () => fakeStream(feedback),
      config: { baseUrl: "x", apiKey: "x" },
      model: "x",
      messages: [{ role: "user", content: userText }],
      today: "2026-06-24",
    } as never);
    expect(cands.length).toBe(1);

    // 3) 真 upsertMemory 落盘(按 type 路由,feedback → user)
    for (const c of cands) {
      const scope = routeScope(c.type);
      const dir = scope === "knowledge" ? know : scope === "user" ? user : proj;
      await upsertMemory(dir, c, await loadAllMemories(proj, user, know));
    }

    // 4) 断言:磁盘上确有这条 feedback,且落在 user 层
    const all = await loadAllMemories(proj, user, know);
    const fb = all.find((m) => m.type === "feedback");
    expect(fb).toBeTruthy();
    expect(fb!.text).toContain("不加 AI 署名");
    const userFiles = await fs.readdir(user);
    expect(userFiles.some((f) => f.endsWith(".md"))).toBe(true);
  });

  it("普通指令 → 不触发(管线不进入,不写盘)", () => {
    const d = shouldCaptureMemory({
      newTokens: 200,
      threshold: 15000,
      userCorrection: looksLikeCorrection("帮我加个登录页"),
    });
    expect(d.capture).toBe(false);
  });

  it("verify_done 客观通过的工具结果 → 触发", () => {
    const tail = [{ role: "tool", content: "$ npm test\n...\n[验收通过 exit 0]" }];
    const d = shouldCaptureMemory({ newTokens: 1, threshold: 15000, verifyPassed: turnHadVerifyPass(tail) });
    expect(d).toEqual({ capture: true, reason: "verify-passed" });
  });
});

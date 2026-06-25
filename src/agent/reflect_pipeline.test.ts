import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reflect } from "./unified_reflect.js";
import { reflectMemToCand } from "./reflect_persist.js";
import { routeScope, upsertMemory, loadAllMemories } from "../memory/store.js";

// 端到端验证反思器管线(index 回合末做的事),只把【模型】换成假流:
//   unifiedReflect(假模型)→ reflectMemToCand → upsertMemory 落盘;advisory 按 onTrack 门控。
// 证明"一次反思最终变成磁盘上的记忆 + 受控的 advisory",零 API、确定性。
function fakeStream(text: string) {
  return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }();
}
const base = { config: { baseUrl: "x", apiKey: "x" }, model: "x", today: "2026-06-25", messages: [{ role: "user", content: "干活" }] };

async function persist(result: Awaited<ReturnType<typeof reflect>>, dirs: { proj: string; user: string; know: string }) {
  const existing = await loadAllMemories(dirs.proj, dirs.user, dirs.know);
  for (const m of result.memories) {
    const cand = reflectMemToCand(m, existing, base.today);
    const scope = routeScope(cand.type);
    const dir = scope === "knowledge" ? dirs.know : scope === "user" ? dirs.user : dirs.proj;
    await upsertMemory(dir, cand, existing);
  }
}

describe("反思器管线(端到端,假模型零 API)", () => {
  const mk = async () => ({
    proj: await fs.mkdtemp(path.join(os.tmpdir(), "rp-proj-")),
    user: await fs.mkdtemp(path.join(os.tmpdir(), "rp-user-")),
    know: await fs.mkdtemp(path.join(os.tmpdir(), "rp-know-")),
  });

  it("onTrack=false:advisory 给出 + feedback 落 user 层", async () => {
    const dirs = await mk();
    const out = JSON.stringify({
      onTrack: false, advisory: "反复改 foo.ts:42 报错没变,根因可能在 bar.ts",
      memories: [{ title: "提交不加署名", text: "提交一律不加 AI 署名。为什么:用户要求。怎么用:不写 Co-Authored-By。", type: "feedback", importance: 9 }],
    });
    const r = await reflect({ ...base, streamChat: () => fakeStream(out) } as never);
    expect(r.advisory).toContain("foo.ts");           // 有问题 → advisory 给出
    await persist(r, dirs);
    const all = await loadAllMemories(dirs.proj, dirs.user, dirs.know);
    const fb = all.find((m) => m.type === "feedback");
    expect(fb?.text).toContain("不加 AI 署名");
    expect((await fs.readdir(dirs.user)).some((f) => f.endsWith(".md"))).toBe(true);
  });

  it("onTrack=true:无 advisory(噪音消除),仍可落记忆", async () => {
    const dirs = await mk();
    const out = JSON.stringify({ onTrack: true, advisory: "在轨继续", memories: [{ title: "中文偏好", text: "用户偏好中文", type: "user", importance: 8 }] });
    const r = await reflect({ ...base, streamChat: () => fakeStream(out) } as never);
    expect(r.advisory).toBeNull();                     // 在轨 → 不注入
    await persist(r, dirs);
    expect((await loadAllMemories(dirs.proj, dirs.user, dirs.know)).some((m) => m.title === "中文偏好")).toBe(true);
  });

  it("mergeInto:覆盖已有那条(合并增强),不新增文件", async () => {
    const dirs = await mk();
    // 先放一条已有
    await persist(await reflect({ ...base, streamChat: () => fakeStream(JSON.stringify({ onTrack: true, advisory: null, memories: [{ title: "中文偏好", text: "用户偏好中文思考", type: "user", importance: 7 }] })) } as never), dirs);
    // 再来一条 mergeInto 它
    const r2 = await reflect({ ...base, streamChat: () => fakeStream(JSON.stringify({ onTrack: true, advisory: null, memories: [{ title: "中文偏好(增强)", text: "用户偏好中文思考与回答", type: "feedback", importance: 9, mergeInto: "中文偏好" }] })) } as never);
    await persist(r2, dirs);
    const all = await loadAllMemories(dirs.proj, dirs.user, dirs.know);
    expect(all).toHaveLength(1);                        // 合并,不新增
    expect(all[0]!.text).toBe("用户偏好中文思考与回答");
  });
});

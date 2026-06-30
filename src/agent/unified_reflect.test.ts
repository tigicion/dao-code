import { describe, it, expect } from "vitest";
import { reflect, REFLECT_TAIL } from "./unified_reflect.js";

function fakeStream(text: string) {
  return async function* () { yield { kind: "content", text }; return { role: "assistant", content: text }; }();
}
const base = { config: { baseUrl: "x", apiKey: "x" }, model: "x", today: "2026-06-25", messages: [{ role: "user", content: "干活" }] };

describe("unified_reflect.reflect", () => {
  it("解析 onTrack=false + advisory + memories", async () => {
    const out = JSON.stringify({
      onTrack: false, advisory: "你在反复改 foo.ts:42,根因可能在 bar.ts",
      memories: [{ title: "提交不加署名", text: "提交一律不加 AI 署名。为什么:用户要求。怎么用:不写 Co-Authored-By。", type: "feedback", importance: 9 }],
    });
    const r = await reflect({ ...base, streamChat: () => fakeStream(out) } as never);
    expect(r.onTrack).toBe(false);
    expect(r.advisory).toContain("foo.ts");
    expect(r.memories).toHaveLength(1);
    expect(r.memories[0]!.title).toBe("提交不加署名");
  });

  it("onTrack=true → 无 advisory(噪音消除)", async () => {
    const out = JSON.stringify({ onTrack: true, advisory: "在轨继续", memories: [] });
    const r = await reflect({ ...base, streamChat: () => fakeStream(out) } as never);
    expect(r.advisory).toBeNull();
  });

  it("含密钥的记忆被过滤", async () => {
    const out = JSON.stringify({ onTrack: true, advisory: null, memories: [{ title: "key", text: "我的 AWS key 是 AKIA1234567890ABCDEF", type: "user", importance: 9 }] });
    const r = await reflect({ ...base, streamChat: () => fakeStream(out) } as never);
    expect(r.memories).toHaveLength(0);
  });

  it("目录倾倒式记忆被过滤", async () => {
    const out = JSON.stringify({ onTrack: true, advisory: null, memories: [{ title: "x", text: "用户使用 grep_files 工具搜索代码", type: "user", importance: 6 }] });
    const r = await reflect({ ...base, streamChat: () => fakeStream(out) } as never);
    expect(r.memories).toHaveLength(0);
  });

  it("importance<4 的琐碎被过滤", async () => {
    const out = JSON.stringify({ onTrack: true, advisory: null, memories: [{ title: "琐碎", text: "随口一句", type: "episodic", importance: 2 }] });
    const r = await reflect({ ...base, streamChat: () => fakeStream(out) } as never);
    expect(r.memories).toHaveLength(0);
  });

  it("fork 模式:把已有记忆候选嵌进发送的 prompt(供 mergeInto 判断),并带 tools", async () => {
    let sent: any;
    await reflect({
      ...base, fork: true, tools: [{ type: "function", function: { name: "read_file" } }],
      existing: [{ title: "已有偏好", text: "用户偏好中文" }],
      streamChat: (o: any) => { sent = o; return fakeStream('{"onTrack":true,"advisory":null,"memories":[]}'); },
    } as never);
    const tail = sent.messages[sent.messages.length - 1].content as string;
    expect(tail).toContain("已有偏好");           // 候选嵌入
    expect(sent.tools).toBeTruthy();               // 带 tools 对齐缓存
  });

  it("【全部标题】都进 prompt(闭合 >N/低重要度漏召回);正文只给前 N", async () => {
    let sent: any;
    // 35 条:前 30 有正文,后 5 只该出标题(第 33 条是低位但可被 mergeInto 的目标)
    const existing = Array.from({ length: 35 }, (_, i) => ({ title: `偏好${i}`, text: `正文内容-${i}` }));
    await reflect({
      ...base, fork: true,
      existing,
      streamChat: (o: any) => { sent = o; return fakeStream('{"onTrack":true,"advisory":null,"memories":[]}'); },
    } as never);
    const tail = sent.messages[sent.messages.length - 1].content as string;
    expect(tail).toContain("偏好0");    // 头部标题在
    expect(tail).toContain("偏好34");   // 尾部标题也在(全部标题都列)→ 不漏
    expect(tail).toContain("正文内容-0");    // 前 N 有正文
    expect(tail).not.toContain("正文内容-34"); // 尾部不给正文(便宜)
  });

  it("REFLECT_TAIL 含两区(反思 + 记忆)与 JSON 输出约定", () => {
    expect(REFLECT_TAIL).toContain("进展反思");
    expect(REFLECT_TAIL).toContain("记忆");
    expect(REFLECT_TAIL).toContain("onTrack");
  });
});

describe("REFLECT_TAIL 通用画像维度块", () => {
  it("含五个画像维度关键词", () => {
    for (const kw of ["沟通偏好", "工作风格", "专业背景", "反复出现", "硬规矩"]) {
      expect(REFLECT_TAIL).toContain(kw);
    }
  });
  it("含 user_stated / inferred 来源区分与隐私红线", () => {
    expect(REFLECT_TAIL).toContain("user_stated");
    expect(REFLECT_TAIL).toContain("inferred");
    expect(REFLECT_TAIL).toContain("红线");
  });
  it("含『上抽』指令(项目事实抽象成人物画像)", () => {
    expect(REFLECT_TAIL).toContain("上抽");
  });
});

describe("REFLECT_TAIL 纠错与确认段", () => {
  it("含 corrections/confirmed 指令与保守纪律", () => {
    for (const kw of ["纠错", "corrections", "confirmed", "supersede", "revise", "实测证据"]) {
      expect(REFLECT_TAIL).toContain(kw);
    }
  });
});

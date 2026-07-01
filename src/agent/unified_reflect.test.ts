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

  it("REFLECT_TAIL 含记忆为首、进展审视、纠错三段与 JSON 输出约定", () => {
    expect(REFLECT_TAIL).toContain("记忆提取");
    expect(REFLECT_TAIL).toContain("进展审视");
    expect(REFLECT_TAIL).toContain("onTrack");
    expect(REFLECT_TAIL).toContain("memories");
  });
});

describe("REFLECT_TAIL 记忆提取段", () => {
  it("含五个高信号时刻指引", () => {
    expect(REFLECT_TAIL).toContain("高信号时刻");
    expect(REFLECT_TAIL).toContain("用户纠正/反驳你时");
    expect(REFLECT_TAIL).toContain("verify_done");
    expect(REFLECT_TAIL).toContain("同一指令在短时间内重复");
    expect(REFLECT_TAIL).toContain("跨轮次的用户行为模式");
    expect(REFLECT_TAIL).toContain("你做错但自己发现并修正了");
  });

  it("含三类记忆归类", () => {
    expect(REFLECT_TAIL).toContain("用户规矩");
    expect(REFLECT_TAIL).toContain("用户画像");
    expect(REFLECT_TAIL).toContain("项目知识");
  });

  it("含三个 few-shot 示例,每个标注信号来源", () => {
    expect(REFLECT_TAIL).toContain("用户要求先出方案再动手");
    expect(REFLECT_TAIL).toContain("用户偏好选项式引导而非开放式提问");
    expect(REFLECT_TAIL).toContain("DAO CODE 三层 i18n 架构");
    expect(REFLECT_TAIL).toContain("来自信号 1");
    expect(REFLECT_TAIL).toContain("来自信号 4");
    expect(REFLECT_TAIL).toContain("来自信号 5");
  });

  it("含 user_stated / inferred 来源区分与低 confidence 兜底", () => {
    expect(REFLECT_TAIL).toContain("user_stated");
    expect(REFLECT_TAIL).toContain("inferred");
    expect(REFLECT_TAIL).toContain("0.3-0.5");
  });

  it("含 mergeInto 指令与不可记", () => {
    expect(REFLECT_TAIL).toContain("mergeInto");
    expect(REFLECT_TAIL).toContain("不可记");
  });
});

describe("REFLECT_TAIL 纠错与确认段", () => {
  it("含 corrections/confirmed 指令与保守纪律", () => {
    for (const kw of ["corrections", "confirmed", "supersede", "revise", "实测证据"]) {
      expect(REFLECT_TAIL).toContain(kw);
    }
  });
});

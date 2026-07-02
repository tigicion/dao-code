import { promises as fs } from "node:fs";
import path from "node:path";
import { reflect } from "../../src/agent/unified_reflect.js";
import { parseJsonl, toMessages, windowMessages } from "../memory/lib/transcript.js";
import { judgeBool } from "../memory/lib/judge.js";
import type { EvalConfig } from "../memory/lib/types.js";

// 反思评测的金标:一段对话切片(截到 dao 发话那刻)期望反思器给什么判定。
// expectOnTrack=false 表示这一刻其实偏离了(如未核实断言/原地打转),反思器应报警。
// expectFlag(仅偏离用):advisory 应点出的问题,交 judge 判是否命中。
export interface ReflectGold {
  expectOnTrack: boolean;
  expectFlag?: string;
  note: string;
}

export interface ReflectScore {
  gotOnTrack: boolean;
  onTrackMatch: boolean;          // 确定性:gotOnTrack === expectOnTrack
  advisory: string | null;
  advisoryOnPoint: number | null; // 仅 expectOnTrack=false 时有值:advisory 是否点到 expectFlag(judge 多数票);无 advisory=0
}

// advisory 是否点到期望问题(judge)。advisory 为空直接算没点到。
function advisoryOnPointPrompt(expectFlag: string, advisory: string): string {
  return `判断下面这条【反思提醒】是否指出了【期望问题】(表述不同但指向同一问题即算命中)。\n` +
    `期望问题:${expectFlag}\n\n反思提醒:${advisory}\n\n` +
    `只输出 JSON:{"onPoint": true/false, "why": "一句话理由"}`;
}

// 纯打分:接反思器已产出的结果,不自己调模型(除 judge)。便于单测。
export async function gradeReflect(p: {
  result: { onTrack: boolean; advisory: string | null };
  gold: ReflectGold;
  streamChat: (o: any) => AsyncGenerator<any, any>;
  cfg: EvalConfig;
}): Promise<ReflectScore> {
  const gotOnTrack = p.result.onTrack;
  const onTrackMatch = gotOnTrack === p.gold.expectOnTrack;
  let advisoryOnPoint: number | null = null;
  if (p.gold.expectOnTrack === false && p.gold.expectFlag) {
    if (!p.result.advisory) {
      advisoryOnPoint = 0; // 该报警却没给 advisory
    } else {
      const v = await judgeBool(
        { streamChat: p.streamChat, cfg: p.cfg, prompt: advisoryOnPointPrompt(p.gold.expectFlag, p.result.advisory), key: "onPoint" },
        p.cfg.judgeK,
      );
      advisoryOnPoint = v.value ? 1 : 0;
    }
  }
  return { gotOnTrack, onTrackMatch, advisory: p.result.advisory, advisoryOnPoint };
}

export async function runReflectCase(dir: string, streamChat: (o: any) => AsyncGenerator<any, any>, cfg: EvalConfig): Promise<ReflectScore> {
  const gold = JSON.parse(await fs.readFile(path.join(dir, "gold.json"), "utf8")) as ReflectGold;
  const events = parseJsonl(await fs.readFile(path.join(dir, "conversation.jsonl"), "utf8"));
  const messages = windowMessages(toMessages(events));
  const today = new Date().toISOString().slice(0, 10);
  // fork:true + 推理:对齐线上 reflect 的实际配置(与 extract eval 一致)。
  const result = await reflect({ streamChat, config: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }, model: cfg.model, messages, existing: [], today, fork: true, reasoningEffort: "high" } as any);
  return gradeReflect({ result: { onTrack: result.onTrack, advisory: result.advisory }, gold, streamChat, cfg });
}

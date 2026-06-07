import type { Capabilities } from "../capabilities.js";
import type { Background } from "../background.js";
import type { WelcomeInfo } from "../banner.js";
import type { Maxim } from "../maxim.js";
import type { TurnEvents } from "../render.js";
import type { ApprovalPrompt } from "../../approval/types.js";

// transcript 里一条已完成的条目(进 <Static>,终端原生滚动)。
export type TranscriptItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "tool"; name: string; preview: string; ok: boolean }
  | { id: number; kind: "notice"; text: string };

// 当前回合的动态区(小,流式中重渲染)。
export interface LiveState {
  reasoning: string;
  content: string;
  tools: string[];
}

export interface StatusInfo {
  model: string;
  mode: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitRatio: number;
}

export interface AppDeps {
  welcome: { info: WelcomeInfo; caps: Capabilities; bg: Background; maxim: Maxim };
  // 跑一个用户回合:由 index 绑定真实 session/registry/gate;App 提供 events(喂 state)与 signal(ESC 取消)。
  submit: (text: string, hooks: { events: TurnEvents; signal: AbortSignal }) => Promise<void>;
  // 斜杠命令(/model /plan /clear /compact /help /exit)。
  runCommand: (line: string) => { handled: boolean; output?: string; exit?: boolean; compact?: boolean };
  compact: () => Promise<void>;
  getStatus: () => StatusInfo;
  // App 挂载后注册自己的审批/提问模态,供 index 的 gate 与 ctx.ask 委派。
  register: (ui: { approvalPrompt: ApprovalPrompt; askUser: (q: string) => Promise<string> }) => void;
}

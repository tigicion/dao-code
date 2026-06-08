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
  | { id: number; kind: "tool"; label: string; detail: string; ok: boolean }
  | { id: number; kind: "diff"; path: string; removed: string[]; added: string[]; lang: string }
  | { id: number; kind: "notice"; text: string };

// 当前回合的动态区(小,流式中重渲染)。
export interface LiveState {
  reasoning: string;
  content: string;
  tools: string[];
  toolCount: number; // 本回合累计工具调用数(进度可见性)
  lastActivity: string; // 最近一次工具的意图标签,如「读取 src/foo.ts」
}

export interface StatusInfo {
  model: string;
  mode: string;
  promptTokens: number;
  completionTokens: number;
  cacheHitRatio: number;
  yolo: boolean;
  longTask?: boolean; // 长任务自主模式
  branch?: string;
  contextPct: number; // 当前上下文占 1M 窗口的百分比
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
  // @文件补全:给前缀(子串),返回匹配的工作区相对路径(已截断);省略则不补全。
  completeFiles?: (prefix: string) => string[];
  // 续跑:用上次会话重建的 transcript 初始条目(已带 id)。
  initialItems?: TranscriptItem[];
  // 异步后台任务:取出待注入的 <task-notification>(空闲时自动作为新回合喂给模型)。
  drainNotifications?: () => string[];
  // 订阅后台任务状态变化(完成/失败/取消)→ 触发 UI 刷新与通知处理。
  subscribeTasks?: (cb: () => void) => void;
  // 当前运行中的后台任务数(状态栏展示)。
  runningTasks?: () => number;
}

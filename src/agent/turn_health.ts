// 反思层 · 确定性回合监控:跨回合追踪结果,决定何时叫【挑战者】(卡住)/【纠偏者】(长任务漂移)fork。
// 纯函数、可测——决策(此处)与执行(fork 调用,在 index.ts)分离。程序看可观测信号,不靠模型自报。

export interface TurnOutcome {
  progressed: boolean; // 本轮有实质推进(写文件/推进 todo)
  toolFailures: number; // 本轮失败工具数
  errSig?: string; // 最后一条失败结果的归一化签名(判同错复发)
  verifyPassed?: boolean; // 前向占位:本轮 verify 通过(暂未接线)
}

export interface HealthState {
  failureStreak: number; // 连续"有失败且无推进"的回合数
  lastErrSig?: string;
  repeatedErr: number; // 同一 errSig 连续复发次数
  turnsSinceRefocus: number;
}

export const initHealth = (): HealthState => ({ failureStreak: 0, repeatedErr: 0, turnsSinceRefocus: 0 });

export interface HealthConfig {
  failureStreakTrip: number; // 连续失败达此 → 挑战者
  repeatedErrTrip: number; // 同错复发达此 → 挑战者
  refocusEvery: number; // 长任务每 N 轮 → 纠偏(0=关)
}

export const defaultHealthConfig = (): HealthConfig => ({
  failureStreakTrip: Number(process.env.DAO_FAIL_STREAK) || 3,
  repeatedErrTrip: Number(process.env.DAO_REPEAT_ERR) || 2,
  refocusEvery: Number(process.env.DAO_REFOCUS_EVERY) || 0,
});

export interface HealthDecision {
  next: HealthState;
  challenger: boolean;
  refocuser: boolean;
  reason: string;
}

export function assessTurn(
  state: HealthState,
  outcome: TurnOutcome,
  cfg: HealthConfig,
  opts: { longTask: boolean },
): HealthDecision {
  // 卡住 = 有失败且本轮没有实质推进(治"碰了文件=有进展"的误判:失败主导的回合不算推进)。
  const stuck = outcome.toolFailures > 0 && !outcome.progressed;
  const failureStreak = stuck ? state.failureStreak + 1 : 0;

  let repeatedErr: number;
  if (outcome.errSig) repeatedErr = outcome.errSig === state.lastErrSig ? state.repeatedErr + 1 : 1;
  else repeatedErr = 0;
  const lastErrSig = outcome.errSig ?? state.lastErrSig;

  const challenger = failureStreak >= cfg.failureStreakTrip || repeatedErr >= cfg.repeatedErrTrip;

  let turnsSinceRefocus = state.turnsSinceRefocus + 1;
  let refocuser = false;
  if (opts.longTask && cfg.refocusEvery > 0 && turnsSinceRefocus >= cfg.refocusEvery) {
    refocuser = true;
    turnsSinceRefocus = 0;
  }

  // 挑战者出场后复位失败计数,避免之后每轮重复触发。
  const next: HealthState = {
    failureStreak: challenger ? 0 : failureStreak,
    repeatedErr: challenger ? 0 : repeatedErr,
    lastErrSig,
    turnsSinceRefocus,
  };
  const reason = challenger
    ? failureStreak >= cfg.failureStreakTrip
      ? "failure-streak"
      : "repeated-error"
    : refocuser
      ? "refocus-cadence"
      : "ok";
  return { next, challenger, refocuser, reason };
}

// 失败结果归一化签名:去掉数字/十六进制/路径,取前缀 hash —— 让"同一个错"跨回合可比(判复发)。
export function errSignature(content: string): string {
  const norm = content
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "")
    .replace(/\/[^\s]+/g, "")
    .replace(/[0-9]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

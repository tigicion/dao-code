// 写入层(缺陷#1)的捕获决策:在【热回合边界】判断本回合要不要蒸馏。
// 纯函数、确定性——触发逻辑与执行(后台 fork 蒸馏)分离,便于测试。
//
// 闸(任一成立即捕获,但必须有新材料):
//  · 压缩前(compactionImminent):必须先把知识捕获再压缩,否则细节被丢。
//  · verify 通过(verifyPassed):刚被证明能用的东西,高价值、耐久,值得即时捕获。
//  · 新增对话 token ≥ 阈值:攒够新材料。
// 否则跳过(多数回合在此跳过——不是每轮都蒸)。
export interface CaptureSignals {
  newTokens: number; // 自上次蒸馏以来新增的对话 token(估算)
  threshold: number; // 触发阈值(DAO_DISTILL_TOKENS)
  compactionImminent?: boolean; // 本回合后即将自动压缩
  verifyPassed?: boolean; // 本回合 verify_done 通过(前向兼容,暂未接线)
}

export function shouldCaptureMemory(s: CaptureSignals): { capture: boolean; reason: string } {
  if (s.newTokens <= 0) return { capture: false, reason: "no-new-material" };
  if (s.compactionImminent) return { capture: true, reason: "pre-compaction" };
  if (s.verifyPassed) return { capture: true, reason: "verify-passed" };
  if (s.newTokens >= s.threshold) return { capture: true, reason: "token-threshold" };
  return { capture: false, reason: "below-threshold" };
}

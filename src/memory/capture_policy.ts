// 写入层(缺陷#1)的捕获决策:在【热回合边界】判断本回合要不要蒸馏。
// 纯函数、确定性——触发逻辑与执行(后台 fork 蒸馏)分离,便于测试。
//
// 闸(任一成立即捕获,但必须有新材料):
//  · 压缩前(compactionImminent):必须先把知识捕获再压缩,否则细节被丢。
//  · verify 通过(verifyPassed):刚被证明能用的东西,高价值、耐久,值得即时捕获。
//  · 用户纠正/强调(userCorrection):用户纠正做法或强调偏好,是 feedback 的高发时刻——
//    别等攒够 token 或会话结束(短会话/被 kill 会丢)。这里只当【粗门】,落不落盘交 distill 定夺。
//  · 新增对话 token ≥ 阈值:攒够新材料。
// 否则跳过(多数回合在此跳过——不是每轮都蒸)。
//
// 同轮去重:若本轮模型已【主动 memory_write】(activeWriteThisTurn),则"时刻型"触发
// (verify/userCorrection)与它捕捉同一时刻 → 抑制,避免同一轮为同件事再蒸一次(纯冗余 fork)。
// 但 compaction(安全兜底)与 token-threshold(攒够一大坨别的新材料,重叠那条由 upsertMemory 合并)
// 不抑制——既不饿死 distill 也不丢材料。跨轮再蒸无妨(那是真有新增量)。
export interface CaptureSignals {
  newTokens: number; // 自上次蒸馏以来新增的对话 token(估算)
  threshold: number; // 触发阈值(DAO_DISTILL_TOKENS)
  compactionImminent?: boolean; // 本回合后即将自动压缩
  verifyPassed?: boolean; // 本回合 verify_done 客观通过(由 turnHadVerifyPass 算出)
  userCorrection?: boolean; // 本回合用户消息像纠正/强调(由 looksLikeCorrection 算出)
  activeWriteThisTurn?: boolean; // 本回合模型已主动调过 memory_write(由 turnWroteMemory 算出)
}

export function shouldCaptureMemory(s: CaptureSignals): { capture: boolean; reason: string } {
  if (s.newTokens <= 0) return { capture: false, reason: "no-new-material" };
  if (s.compactionImminent) return { capture: true, reason: "pre-compaction" };
  // 模型本轮已主动记忆 → 时刻型触发抑制(同件事不在同一轮再蒸一次)。
  if (!s.activeWriteThisTurn) {
    if (s.verifyPassed) return { capture: true, reason: "verify-passed" };
    if (s.userCorrection) return { capture: true, reason: "user-correction" };
  }
  if (s.newTokens >= s.threshold) return { capture: true, reason: "token-threshold" };
  return { capture: false, reason: "below-threshold" };
}

// verify 信号源:verify_done 配了可执行验收命令且 exit 0 时,工具结果含此标记(见 tools/verify.ts)。
// 未配命令的自判模式不算【客观】通过,故不匹配——只在真跑过验收且过了时才认。
const VERIFY_PASS_MARK = "[验收通过";

// 扫【本回合新增的消息】里有没有一条 verify_done 客观通过的工具结果。
// 调用方在 runTurn 前后用 messages.length 切片,把这一截传进来即可。
export function turnHadVerifyPass(turnMessages: { role: string; content: string | null }[]): boolean {
  return turnMessages.some(
    (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes(VERIFY_PASS_MARK),
  );
}

// userCorrection 粗门(方案 B):只判这句【像不像】纠正/强调,命中即触发一次蒸馏;
// 真有没有耐久 feedback 交给 distill 的反噪 guard 定夺(误判代价仅一个返回 [] 的热缓存 fork)。
// 故词表可放宽;但避开过泛的单字(又/还/no…)以免几乎每轮都触发、白费 token。
const CORRECTION_CUES_CN = [
  "不对", "不是", "别这", "别再", "不要", "不应", "不该", "错了", "搞错", "弄错",
  "我说过", "说过了", "跟你说", "记住", "务必", "一律", "以后", "每次", "永远", "总是",
  "强调", "重申", "重来", "不能这",
];
const CORRECTION_CUES_EN =
  /\b(don'?t|do not|should(n'?t)?|instead|stop|wrong|always|never|again|remember)\b/i;

export function looksLikeCorrection(text: string): boolean {
  if (!text) return false;
  if (CORRECTION_CUES_EN.test(text)) return true;
  return CORRECTION_CUES_CN.some((c) => text.includes(c));
}

// 扫【本回合新增的消息】里模型有没有主动调过 memory_write(assistant 的 tool_calls)。
// 用于同轮去重:已主动记过就别让时刻型触发器再蒸一次。
export function turnWroteMemory(
  turnMessages: { role: string; tool_calls?: { function?: { name?: string } }[] }[],
): boolean {
  return turnMessages.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.function?.name === "memory_write"),
  );
}

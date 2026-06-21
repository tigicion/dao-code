// 路径①:用户反复申诉 → 异步挑战者。免费相似度门(textSimilarity)判"是否重提同一问题"。
// 决策(纯函数)与执行(reflect fork,在 createReplyChallenge)分离,便于单测。
import { textSimilarity } from "../text/similarity.js";

// 新用户消息与本会话既往用户消息逐条比相似度,取最高;≥threshold 视为"重提同一问题"。
// threshold<=0 表示关闭路径①;无历史(首条消息)永远 false。
export function isRepeatComplaint(newMsg: string, priorUserMsgs: string[], threshold: number): boolean {
  if (threshold <= 0 || priorUserMsgs.length === 0) return false;
  let max = 0;
  for (const p of priorUserMsgs) {
    const s = textSimilarity(newMsg, p);
    if (s > max) max = s;
  }
  return max >= threshold;
}

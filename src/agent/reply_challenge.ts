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

export interface ReplyChallengeDeps {
  reflect: () => Promise<string | null>; // fork 挑战者,返回结论文本或 null(由 index 绑定为 () => reflect("challenger"))
  threshold: number;                     // 相似度阈值;<=0 关闭路径①
}

// 异步挑战者控制器:用户消息入口判申诉、命中才 fork(不阻塞),结论入队待回合边界注入。
export function createReplyChallenge(deps: ReplyChallengeDeps) {
  const history: string[] = []; // 本会话既往用户消息(仅真实用户消息,不含斜杠命令)
  const queue: string[] = [];   // 待注入的挑战者结论(已带 [审视者·参考] 前缀)
  return {
    // 非阻塞:命中相似度门才 fork。调用方【不要 await】(fire-and-forget);测试可 await 以等待入队。
    onUserMessage(text: string): Promise<void> {
      const repeat = isRepeatComplaint(text, history, deps.threshold);
      history.push(text);
      if (!repeat) return Promise.resolve();
      return deps.reflect()
        .then((v) => { if (v && v.trim()) queue.push(`[审视者·参考]\n${v.trim()}`); })
        .catch(() => {}); // 反思失败绝不波及主流程
    },
    drain(): string[] { return queue.splice(0); },
  };
}

import { z } from "zod";
import { defineTool } from "./types.js";

// 直接给人类弹一次桌面通知,不等本轮结束——用于"用户可能不在看"的场景(定时任务/长回合中途)。
// 和 MessageParent 的区别:那个是子代理→父代理(排队,父代理空闲时才看到);这个是直达人类桌面,当下就弹。
// 复用 notifier.ts 现成的 notify():best-effort,无 GUI/DAO_NO_NOTIFY=1 时静默不做任何事。
export const notifyUserTool = defineTool({
  name: "NotifyUser",
  description:
    "立即弹一条系统桌面通知给用户,不等本轮结束——用于用户可能不在看的场景(定时任务跑到一半、长回合中途)," +
    "遇到需要人尽快知道的事(卡住待决策、发现重要问题)时用。GUI 不可用、或用户设了 DAO_NO_NOTIFY=1 关掉了通知," +
    "会静默不做任何事、不报错,别指望它一定被看到,重要结论还是要在最终回复里写清楚,不能只靠这一条通知。" +
    "不要在用户正盯着屏幕看你实时输出时频繁用,那种场景下他已经看得到你在做什么,弹通知没有增量价值。" +
    "这是直达人类桌面;和子代理专用的 MessageParent(发给派发你的父代理,排队等它空闲)是完全不同的通道,别搞混。" +
    "举例:被派去跑一个耗时很长的迁移任务、用户去忙别的了,中途卡在一个需要用户决策的分岔口,这时候用它提醒一下," +
    "别指望用户会一直盯着终端等你。",
  descriptionEn:
    "Immediately fires a desktop notification to the user, without waiting for the turn to end — for situations where the user may not be watching (mid-run scheduled task, long turn). " +
    "Use when something needs the human's attention soon (blocked on a decision, found something important). Silently no-ops (no error) if no GUI or the user set " +
    "DAO_NO_NOTIFY=1 — don't assume it's guaranteed to be seen; still spell out important conclusions in your final reply rather than relying on this notification alone. " +
    "Don't overuse this while the user is actively watching your live output — they can already see what you're doing, so there's no added value there. " +
    "This goes straight to the human's desktop; it's a completely different channel from MessageParent (subagent-only, goes to the parent agent that dispatched " +
    "you, queued until it's idle) — don't confuse the two. Example: dispatched to run a long migration while the user goes off to do something else, and you " +
    "hit a fork that needs their decision — notify them then, rather than assuming they're watching the terminal the whole time.",
  capability: "plan",
  approval: "auto",
  shouldDefer: true,
  schema: z.object({
    message: z.string().min(1).describe("要通知的内容(简明,会显示在系统通知里)"),
  }),
  handler: async (args, ctx) => {
    if (!ctx.notifyUser) return "当前环境不支持桌面通知。";
    ctx.notifyUser(args.message);
    return "已发送桌面通知(best-effort,不保证用户当下就看到)。";
  },
});

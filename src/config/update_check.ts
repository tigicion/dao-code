import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../version.js";

// P3-59 更新检查:启动时(节流每日一次、非阻塞)查有无新版本,有则提示如何更新。
// 只提示不自动替换(编译产物自动替换有风险)。DAO_NO_UPDATE_CHECK=1 关闭;DAO_UPDATE_URL 自定义来源。
const DAY = 86_400_000;

// 比较 a 是否比 b 新(简易 semver,只看 major.minor.patch)。
export function semverGt(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

async function fetchLatest(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : undefined;
  } catch {
    return undefined;
  }
}

// 非阻塞调用;有新版本时通过 notice 回调提示一次。current 默认本地 VERSION(测试可注入)。
export async function maybeCheckUpdate(notice: (msg: string) => void, now: number = Date.now(), current: string = VERSION): Promise<void> {
  if (process.env.DAO_NO_UPDATE_CHECK === "1") return;
  const stamp = path.join(os.homedir(), ".dao", ".last-update-check");
  try {
    const last = Number(await fs.readFile(stamp, "utf8").catch(() => "0"));
    if (now - last < DAY) return; // 每日一次
    await fs.mkdir(path.dirname(stamp), { recursive: true });
    await fs.writeFile(stamp, String(now), "utf8");
    const url = process.env.DAO_UPDATE_URL || "https://registry.npmjs.org/dao-code/latest";
    const latest = await fetchLatest(url);
    if (latest && semverGt(latest, current)) {
      notice(`dao 有新版本 ${latest}(当前 ${current})。更新:在 dao-code 目录运行 \`git pull && npm run bundle:install\``);
    }
  } catch { /* 检查失败不影响启动 */ }
}

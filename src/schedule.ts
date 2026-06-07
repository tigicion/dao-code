import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const MARK = "# dao-schedule";
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`; // 单引号转义

// 构造一条 crontab 行:到点 cd 到工作区、headless 跑 dao、输出落 ~/.dao/schedule.log。纯函数,可测。
export function buildCronLine(cron: string, prompt: string, cwd: string, daoBin: string): string {
  return `${cron.trim()} cd ${shq(cwd)} && ${shq(daoBin)} ${shq(prompt)} >> "$HOME/.dao/schedule.log" 2>&1 ${MARK}`;
}

async function readCrontab(): Promise<string[]> {
  try {
    const { stdout } = await exec("crontab", ["-l"]);
    return stdout.split("\n").filter((l) => l.length > 0);
  } catch {
    return []; // 无 crontab → 空
  }
}

async function writeCrontab(lines: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile("crontab", ["-"], (err) => (err ? reject(err) : resolve()));
    child.stdin?.end(lines.join("\n") + "\n");
  });
}

export async function scheduleAdd(cron: string, prompt: string, cwd: string, daoBin: string, write: (s: string) => void): Promise<void> {
  if (!/^(\S+\s+){4}\S+/.test(cron.trim())) {
    write(`cron 表达式应为 5 字段(分 时 日 月 周),如 "0 9 * * *"。收到:${cron}\n`);
    return;
  }
  const lines = await readCrontab();
  lines.push(buildCronLine(cron, prompt, cwd, daoBin));
  await writeCrontab(lines);
  write(`✓ 已添加定时任务:[${cron.trim()}] 在 ${cwd} 跑 dao "${prompt}"\n  输出 → ~/.dao/schedule.log;查看 /用 dao schedule list,删 dao schedule remove <n>\n`);
}

export async function scheduleList(write: (s: string) => void): Promise<void> {
  const dao = (await readCrontab()).filter((l) => l.includes(MARK));
  if (dao.length === 0) { write("(暂无 dao 定时任务)\n"); return; }
  write("dao 定时任务:\n" + dao.map((l, i) => `  ${i + 1}. ${l.replace(MARK, "").trim()}`).join("\n") + "\n");
}

export async function scheduleRemove(n: number, write: (s: string) => void): Promise<void> {
  const all = await readCrontab();
  const daoIdx = all.map((l, i) => (l.includes(MARK) ? i : -1)).filter((i) => i >= 0);
  if (n < 1 || n > daoIdx.length) { write(`序号越界(共 ${daoIdx.length} 条)。先 dao schedule list 看序号。\n`); return; }
  const removeAt = daoIdx[n - 1]!;
  await writeCrontab(all.filter((_, i) => i !== removeAt));
  write(`✓ 已删除第 ${n} 条定时任务。\n`);
}

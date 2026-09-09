// 终端背景(亮/暗)检测。颜色主题据此自适应,避免浅色终端被洗白、深色终端发灰。

import { execFile } from "node:child_process";

export type Background = "light" | "dark";

// 同步线索:DAO_THEME 显式 > COLORFGBG 末位(7/9..15=亮;0..6,8=暗)。命中返回,否则 undefined。
export function bgFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Background | undefined {
  const forced = (env.DAO_THEME ?? "").toLowerCase();
  if (forced === "light" || forced === "dark") return forced;
  const fgbg = env.COLORFGBG;
  if (fgbg) {
    const last = parseInt(fgbg.split(";").pop() ?? "", 10);
    if (!Number.isNaN(last)) return last === 7 || last >= 9 ? "light" : "dark";
  }
  return undefined;
}

// 16-bit(0..65535)RGB 按感知亮度判明暗:>0.5 视为浅底。
function bgFromLum16(r: number, g: number, b: number): Background {
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 65535;
  return lum > 0.5 ? "light" : "dark";
}

// OSC 11 主动查询终端背景色:写 `ESC ] 11 ; ?` ,读回 `...rgb:RRRR/GGGG/BBBB...`,
// 按亮度判明暗。仅在 stdin/stdout 均为 TTY 时尝试;超时或无响应返回 undefined。
export function detectBackgroundOSC(timeoutMs = 250): Promise<Background | undefined> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let settled = false;
    const wasRaw = stdin.isRaw;

    const cleanup = () => {
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      try {
        if (!wasRaw) stdin.setRawMode(false);
      } catch {}
      stdin.pause();
    };
    const finish = (v: Background | undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };

    // 终端回包可能分多次 data 到达(尤其慢终端/SSH),单个 buffer 里未必含完整
    // `rgb:RRRR/GGGG/BBBB`——累积拼接后再匹配,避免"回包被切断→匹配失败→掉回 dark"。
    let acc = "";
    const onData = (buf: Buffer) => {
      acc += buf.toString("latin1");
      const m = acc.match(/rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
      if (!m) return;
      const norm = (h: string) => parseInt(h, 16) / (Math.pow(16, h.length) - 1);
      const lum = 0.299 * norm(m[1]!) + 0.587 * norm(m[2]!) + 0.114 * norm(m[3]!);
      finish(lum > 0.5 ? "light" : "dark");
    };

    const timer = setTimeout(() => finish(undefined), timeoutMs);
    try {
      stdin.setRawMode(true);
    } catch {}
    stdin.resume();
    stdin.on("data", onData);
    stdout.write("\x1b]11;?\x07");
  });
}

// macOS 回退:Apple Terminal 不应答 OSC 11(iTerm2/kitty/WezTerm 才答),导致纯 OSC 探测在
// Terminal.app 里必超时→掉 dark。改用 AppleScript 直接问 Terminal.app 前窗背景色(走 Apple Events,
// 与 TTY 无关,故 OSC 不灵时它仍准)。仅当 TERM_PROGRAM=Apple_Terminal 时启用,避免无谓的 osascript
// 进程开销与在其它终端下的误触。首次会弹一次"dao 想控制 Terminal"授权框,批准后永久生效;用户拒绝
// /osascript 不可用 → catch 返回 undefined,继续走默认。硬超时防 osascript 卡死启动。
export function detectBackgroundAppleTerminal(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  timeoutMs = 400,
): Promise<Background | undefined> {
  if (env.TERM_PROGRAM !== "Apple_Terminal") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: Background | undefined) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    execFile(
      "osascript",
      ["-e", 'tell application "Terminal" to get background color of window 1'],
      { timeout: timeoutMs },
      (err, stdout) => {
        clearTimeout(timer);
        if (err) return finish(undefined);
        // 回值形如 "65534, 65535, 65535"(16-bit RGB)。解析失败→undefined。
        const nums = stdout.trim().split(",").map((s) => parseInt(s.trim(), 10));
        if (nums.length < 3 || nums.some((n) => Number.isNaN(n))) return finish(undefined);
        finish(bgFromLum16(nums[0]!, nums[1]!, nums[2]!));
      },
    );
  });
}

// 综合解析:DAO_THEME/COLORFGBG 显式 > OSC 11 查询 > Apple Terminal 的 AppleScript 回退 > 默认 dark。
// 纯自动适配:每次启动都探测,跟随终端明暗;不再持久化 theme(避免旧值压过真实探测)。DAO_THEME 环境
// 变量仍是最高优先的手动锁定档。OSC 排在 AppleScript 前:支持 OSC 的终端(iTerm2 等)瞬时返回,无需
// 起 osascript 进程;只有 OSC 超时(Apple Terminal)才落到 AppleScript。
export async function resolveBackground(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<Background> {
  return (
    bgFromEnv(env) ??
    (await detectBackgroundOSC()) ??
    (await detectBackgroundAppleTerminal(env)) ??
    "dark"
  );
}

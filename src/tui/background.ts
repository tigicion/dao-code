// 终端背景(亮/暗)检测。颜色主题据此自适应,避免浅色终端被洗白、深色终端发灰。

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

// OSC 11 主动查询终端背景色:写 `ESC ] 11 ; ?` ,读回 `...rgb:RRRR/GGGG/BBBB...`,
// 按亮度判明暗。仅在 stdin/stdout 均为 TTY 时尝试;超时或无响应返回 undefined。
export function detectBackgroundOSC(timeoutMs = 120): Promise<Background | undefined> {
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

    const onData = (buf: Buffer) => {
      const s = buf.toString("latin1");
      const m = s.match(/rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
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

// 综合解析:env 显式优先 → OSC 查询 → 默认 dark。
export async function resolveBackground(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<Background> {
  return bgFromEnv(env) ?? (await detectBackgroundOSC()) ?? "dark";
}

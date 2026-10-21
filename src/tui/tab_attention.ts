import path from "node:path";

export type TabAttentionKind = "attention" | "completed";

export interface TabAttention {
  mark(kind?: TabAttentionKind): void;
  clear(): void;
  setTitle(title: string): void;
  dispose(): void;
}

const cleanTitle = (title: string) => title.replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
const shorten = (title: string) => {
  const chars = Array.from(cleanTitle(title));
  return chars.length > 24 ? chars.slice(0, 24).join("") + "…" : chars.join("");
};

// 任务名在前,目录在后;标题栏很窄时也能先看到任务。命名来源由会话层决定。
export function formatTabTitle(cwd: string, name?: string): string {
  const project = shorten(path.basename(cwd)) || "dao";
  const task = shorten(name ?? "");
  return task && task !== project ? `${task} · ${project}` : project;
}

// 只改标题,不发响铃或桌面通知。OSC 的结束符也用 ST,避免混入 BEL。
// 标题栈用于退出后恢复原名;不支持标题栈的终端至少会清掉圆点。
export function createTabAttention(
  title: string,
  stdout: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): TabAttention {
  const enabled = stdout.isTTY === true && env.TERM !== "dumb";
  // 工作目录可以含控制字符,不能让目录名注入额外的终端指令。
  let base = cleanTitle(title) || "dao";
  let marked: TabAttentionKind | undefined;
  let disposed = false;
  const write = (value: string) => { if (enabled) stdout.write(value); };
  const setTitle = (value: string) => write(`\x1b]0;${value}\x1b\\`);
  const renderTitle = () => setTitle(marked ? `${marked === "completed" ? "🟢" : "🟡"} ${base}` : base);

  write("\x1b[22;0t");
  setTitle(base);
  write("\x1b[?1004h"); // 支持的终端会发送 ESC[I / ESC[O 焦点事件。
  return {
    mark(kind = "attention") {
      if (disposed || marked === kind) return;
      marked = kind;
      renderTitle();
    },
    clear() {
      if (disposed || !marked) return;
      marked = undefined;
      renderTitle();
    },
    setTitle(title) {
      const next = cleanTitle(title) || "dao";
      if (disposed || next === base) return;
      base = next;
      renderTitle();
    },
    dispose() {
      if (disposed) return;
      if (marked) setTitle(base);
      write("\x1b[?1004l\x1b[23;0t");
      disposed = true;
    },
  };
}

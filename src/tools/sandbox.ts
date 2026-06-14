import { existsSync } from "node:fs";
import path from "node:path";

// S4 OS 沙箱:把 shell 命令裹进 macOS Seatbelt / Linux bubblewrap——工作区可写、其余只读,
// 让 auto/yolo 下的误判或注入不致命(应用层审批之外的纵深兜底)。DAO_SANDBOX=1 启用。
export function sandboxActive(): boolean {
  return process.env.DAO_SANDBOX === "1";
}

function binPath(name: string): string | null {
  for (const dir of ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// macOS Seatbelt 配置:默认放行(读/exec/网络),但只允许写工作区 + 临时目录 + 标准设备。
function sbpl(cwd: string): string {
  const w = cwd.replace(/"/g, '\\"');
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${w}") (subpath "/tmp") (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper"))`,
  ].join(" ");
}

export interface SpawnSpec { file: string; args: string[] }

// 返回沙箱化后的 spawn 目标(file+args,shell:false 调用);
// 未启用→null(照常 shell 执行);启用但沙箱不可用→{error}。
export function sandboxSpawn(command: string, cwd: string): SpawnSpec | { error: string } | null {
  if (!sandboxActive()) return null;
  if (process.platform === "darwin") {
    const bin = binPath("sandbox-exec");
    if (!bin) return { error: "DAO_SANDBOX=1 但找不到 sandbox-exec" };
    return { file: bin, args: ["-p", sbpl(cwd), "/bin/sh", "-c", command] };
  }
  if (process.platform === "linux") {
    const bin = binPath("bwrap");
    if (!bin) return { error: "DAO_SANDBOX=1 但找不到 bwrap(请装 bubblewrap)" };
    // 全盘只读挂载,仅工作区可写;/tmp 用 tmpfs;隔离 pid/网络命名空间外的写。
    const args = [
      "--ro-bind", "/", "/",
      "--bind", cwd, cwd,
      "--tmpfs", "/tmp",
      "--proc", "/proc",
      "--dev", "/dev",
      "--die-with-parent",
      "/bin/sh", "-c", command,
    ];
    return { file: bin, args };
  }
  return { error: "当前平台不支持沙箱(仅 macOS/Linux)" };
}

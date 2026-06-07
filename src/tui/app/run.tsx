import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { AppDeps } from "./types.js";

// 启动 Ink 交互应用,等待退出(q / Ctrl-C)。inline 模式(保留终端原生滚动/选择)。
// 强制 interactive=true:已确认是 TTY,绕过 Ink 对 CI 的误判(否则不挂键盘→无 keep-alive→闪退)。
export async function runInkApp(deps: AppDeps): Promise<void> {
  const app = render(<App {...deps} />, { interactive: true } as unknown as Parameters<typeof render>[1]);
  await app.waitUntilExit();
}

import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import type { AppDeps } from "./types.js";

// 启动 Ink 交互应用,等待退出(q / Ctrl-C)。inline 模式(保留终端原生滚动/选择)。
// 强制 interactive=true:已确认是 TTY,绕过 Ink 对 CI 的误判(否则不挂键盘→无 keep-alive→闪退)。
// exitOnCtrlC 显式关掉:Ink 内部(components/App.js)自己也监听 Ctrl+C,默认收到就直接
// process.exit,跟 App.tsx 里"连按两次才退出"的自定义逻辑是两套独立机制——不关掉的话,
// Ink 内置那套会在第一次按下时就抢先退出,自定义的二次确认形同虚设(真实撞见过)。
export async function runInkApp(deps: AppDeps): Promise<void> {
  const app = render(<App {...deps} />, { interactive: true, exitOnCtrlC: false } as unknown as Parameters<typeof render>[1]);
  await app.waitUntilExit();
}

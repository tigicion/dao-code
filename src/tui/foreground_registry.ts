// 前台调用注册表:Bash(exec_shell.ts)/Agent(agent.ts)前台路径开始时各自注册一个
// "转后台"回调,结束(正常/异常)时反注册。Ctrl+B 按下时(App.tsx)遍历触发全部回调,
// 一次按键把本回合内所有还在前台跑着的调用一起转后台——不做"选哪个"的选择 UI(设计文档
// §明确排除的范围)。跟 ESC 用的顶层 AbortController 是两套独立机制,互不影响。
export interface ForegroundRegistry {
  register(id: string, convert: () => void): void;
  unregister(id: string): void;
  convertAll(): number;
}

export function createForegroundRegistry(): ForegroundRegistry {
  const entries = new Map<string, () => void>();
  return {
    register(id, convert) {
      entries.set(id, convert);
    },
    unregister(id) {
      entries.delete(id);
    },
    convertAll() {
      const callbacks = [...entries.values()];
      entries.clear();
      for (const cb of callbacks) cb();
      return callbacks.length;
    },
  };
}

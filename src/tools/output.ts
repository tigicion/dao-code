// 工具输出的"模型侧"上限:超长输出中间截断(保头+保尾),防止单条工具结果撑爆上下文。
// 中间截断而非只留头:命令报错/关键结论常在尾部,头尾都保更有用。
export function clampOutput(s: string, max = 16000): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tailN = max - head;
  const omitted = s.length - head - tailN;
  return (
    s.slice(0, head) +
    `\n…(已省略中间 ${omitted} 字符,共 ${s.length} 字符;如需完整内容请用更精确的命令/grep 缩小范围)…\n` +
    s.slice(s.length - tailN)
  );
}

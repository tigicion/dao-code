// 按路径串行的异步锁:同一文件的"读-改-写"排队执行,杜绝并行 edit/write 同文件时
// 互相覆盖(丢改动)或 atomicWrite 撞临时文件(ENOENT)。不同路径互不阻塞。
const chains = new Map<string, Promise<unknown>>();

export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // 无论前一个成功还是失败,都接着跑本任务(前者的错误由其自己的调用方处理)。
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {}); // 链尾吞错,避免 unhandled rejection,且不阻塞后续
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); }); // 链空了清理,防 Map 无限增长
  return run;
}

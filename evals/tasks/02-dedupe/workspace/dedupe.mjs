// 按 id 去重,保留每个 id 首次出现的对象,维持原顺序。
export function dedupeById(items) {
  // BUG:按引用去重,id 相同但不同对象的项不会被去掉
  return [...new Set(items)];
}

export function formatName(s) {
  return s.trim();
}

// 目标符号:
export function computeTotal(items) {
  return items.reduce((a, b) => a + b, 0);
}

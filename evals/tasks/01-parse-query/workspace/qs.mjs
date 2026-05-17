// 解析查询串为对象。
export function parseQuery(s) {
  const out = {};
  for (const pair of s.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const k = decodeURIComponent(i === -1 ? pair : pair.slice(0, i));
    const v = decodeURIComponent(i === -1 ? "" : pair.slice(i + 1));
    // BUG:重复 key 直接覆盖,应该聚合成数组
    out[k] = v;
  }
  return out;
}

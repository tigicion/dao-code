// WebFetch 结果缓存:15 分钟 TTL,按 URL 存去标签后的原始文本(截断前),避免同一会话内
// 反复抓同一页面。容量上限防止长会话无限增长。

export const TTL_MS = 15 * 60_000;
export const MAX_ENTRIES = 50;

interface CacheEntry {
  text: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCachedFetch(url: string, now = Date.now()): string | undefined {
  const entry = cache.get(url);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(url);
    return undefined;
  }
  return entry.text;
}

export function setCachedFetch(url: string, text: string, now = Date.now()): void {
  if (!cache.has(url) && cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(url, { text, expiresAt: now + TTL_MS });
}

export function clearFetchCache(): void {
  cache.clear();
}

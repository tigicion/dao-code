import { createHash } from "node:crypto";
// 取 sha256 前 16 hex,够区分、frontmatter 里短。
export function contentHash(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";

// 把 zod schema 转成发给 DeepSeek function calling 的 parameters JSON schema。
// 去掉 $schema 顶层键(API 不需要,且影响前缀字节稳定性)。
export function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

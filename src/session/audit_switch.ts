// 审计总开关判定。默认开:DAO_AUDIT 未设即启用;DAO_AUDIT=0 一键全关。
// 每流细粒度覆盖优先:DAO_<KEY>_AUDIT=0/1。收口一处,默认值后续可一行改。
export type AuditKey = "MEMORY" | "TOOL" | "PERM" | "CACHE" | "SKILL";

export function auditEnabled(env: NodeJS.ProcessEnv, key: AuditKey): boolean {
  const specific = env[`DAO_${key}_AUDIT`];
  if (specific === "0") return false;
  if (specific === "1") return true;
  return env.DAO_AUDIT !== "0"; // 默认开
}

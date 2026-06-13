import { promises as fs } from "node:fs";

// 权限模式(1:1 复刻 CC):default 按需弹审批;acceptEdits 自动批准文件编辑;
// plan 只读规划(拦写/执行);bypassPermissions 全部放行(=YOLO)。
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto";
const MODES = new Set<PermissionMode>(["default", "acceptEdits", "plan", "bypassPermissions", "auto"]);

export interface PermissionsConfig {
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
  defaultMode?: PermissionMode;
}

export function emptyPermissions(): PermissionsConfig {
  return { allow: [], ask: [], deny: [], additionalDirectories: [] };
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

// 从一个 settings.json 文件内容解析出 permissions 块;缺失/损坏 → 空配置(容错)。
export function parseSettings(raw: string): PermissionsConfig {
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return emptyPermissions(); }
  const p = obj?.permissions ?? {};
  const cfg: PermissionsConfig = {
    allow: arr(p.allow),
    ask: arr(p.ask),
    deny: arr(p.deny),
    additionalDirectories: arr(p.additionalDirectories),
  };
  if (typeof p.defaultMode === "string" && MODES.has(p.defaultMode)) cfg.defaultMode = p.defaultMode;
  return cfg;
}

// 企业托管策略文件(最高优先级,对标 CC managed-settings.json)。平台可注入便于测试。
export function enterpriseSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/DaoCode/managed-settings.json";
  if (platform === "win32") return "C:/ProgramData/DaoCode/managed-settings.json";
  return "/etc/dao/managed-settings.json";
}

// 从命令行参数抽取权限规则/模式,并返回剔除了这些 flag(及其取值)后的剩余参数。
// 支持:--allow <rule> / --deny <rule> / --add-dir <path>(可重复)、--permission-mode <mode>。
export function extractCliPermissions(args: string[]): { config: PermissionsConfig; rest: string[] } {
  const config = emptyPermissions();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = args[i + 1];
    if (a === "--allow" && val !== undefined) { config.allow.push(val); i++; }
    else if (a === "--deny" && val !== undefined) { config.deny.push(val); i++; }
    else if (a === "--ask" && val !== undefined) { config.ask.push(val); i++; }
    else if (a === "--add-dir" && val !== undefined) { config.additionalDirectories.push(val); i++; }
    else if (a === "--permission-mode" && val !== undefined) {
      if (MODES.has(val as PermissionMode)) config.defaultMode = val as PermissionMode;
      i++;
    } else rest.push(a);
  }
  return { config, rest };
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

// 多层配置合并(数组顺序 = 低→高优先级)。规则三表跨层并集(deny>ask>allow 由引擎处理,
// 与层级无关);defaultMode 取最高层定义者;additionalDirectories 并集。
export function mergePermissions(tiers: PermissionsConfig[]): PermissionsConfig {
  const out = emptyPermissions();
  for (const t of tiers) {
    out.allow.push(...t.allow);
    out.ask.push(...t.ask);
    out.deny.push(...t.deny);
    out.additionalDirectories.push(...t.additionalDirectories);
    if (t.defaultMode) out.defaultMode = t.defaultMode; // 后者(更高层)覆盖
  }
  out.allow = uniq(out.allow);
  out.ask = uniq(out.ask);
  out.deny = uniq(out.deny);
  out.additionalDirectories = uniq(out.additionalDirectories);
  return out;
}

// 交互"允许并记住"时,把一条规则追加进某个 settings.json 的 permissions[kind](默认 allow)。
// 文件不存在则新建;已有同规则则不重复。保留文件里的其它字段。
export async function appendRule(
  file: string,
  rule: string,
  kind: "allow" | "ask" | "deny" = "allow",
): Promise<void> {
  const { promises: fsp } = await import("node:fs");
  const path = await import("node:path");
  let obj: any = {};
  const raw = await fsp.readFile(file, "utf8").catch(() => null);
  if (raw !== null) { try { obj = JSON.parse(raw); } catch { obj = {}; } }
  if (typeof obj !== "object" || obj === null) obj = {};
  obj.permissions ??= {};
  const list: string[] = Array.isArray(obj.permissions[kind]) ? obj.permissions[kind] : [];
  if (!list.includes(rule)) list.push(rule);
  obj.permissions[kind] = list;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
}

// 按给定文件路径(低→高优先级)读取并合并;缺失的文件跳过。
export async function loadPermissions(files: string[]): Promise<PermissionsConfig> {
  const tiers: PermissionsConfig[] = [];
  for (const f of files) {
    const raw = await fs.readFile(f, "utf8").catch(() => null);
    if (raw !== null) tiers.push(parseSettings(raw));
  }
  return mergePermissions(tiers);
}

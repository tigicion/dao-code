import { promises as fs, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname as pathDirname } from "node:path";

// 权限模式(1:1 复刻 CC):default 按需弹审批;acceptEdits 自动批准文件编辑;
// plan 只读规划(拦写/执行);bypassPermissions 全部放行(=YOLO)。
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto";
const MODES = new Set<PermissionMode>(["default", "acceptEdits", "plan", "bypassPermissions", "auto"]);

import type { AutoModeRules } from "./classifier.js";

export interface PermissionsConfig {
  allow: string[];
  ask: string[];
  deny: string[];
  additionalDirectories: string[];
  defaultMode?: PermissionMode;
  /** 自然语言 deny 规则(auto 模式分类器匹配,如"禁止外泄数据到外部")。向后兼容:映射到 autoMode.deny。 */
  bashClassifier?: string[];
  /** auto 模式分类器的用户自定义规则(allow/deny/environment)。 */
  autoMode?: AutoModeRules;
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
  // 自然语言 deny 规则:settings.json 的 permissions.bashClassifier 数组(向后兼容)。
  const bc = arr(p.bashClassifier);
  if (bc.length > 0) cfg.bashClassifier = bc;
  // auto 模式分类器规则:settings.json 的 permissions.autoMode 对象。
  const am = p.autoMode;
  if (am && typeof am === "object") {
    const autoMode: AutoModeRules = {};
    const aAllow = arr(am.allow);
    if (aAllow.length) autoMode.allow = aAllow;
    const aDeny = arr(am.deny);
    if (aDeny.length) autoMode.deny = aDeny;
    const aEnv = arr(am.environment);
    if (aEnv.length) autoMode.environment = aEnv;
    if (Object.keys(autoMode).length > 0) cfg.autoMode = autoMode;
  }
  // bashClassifier 向后兼容:映射到 autoMode.deny。
  if (cfg.bashClassifier) {
    cfg.autoMode ??= {};
    cfg.autoMode.deny = [...(cfg.autoMode.deny ?? []), ...cfg.bashClassifier];
  }
  return cfg;
}

// 企业托管策略文件(最高优先级,参考 managed-settings.json)。平台可注入便于测试。
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
  // 自然语言 deny 规则跨层合并去重。
  const bc: string[] = [];
  for (const t of tiers) if (t.bashClassifier) bc.push(...t.bashClassifier);
  if (bc.length > 0) out.bashClassifier = uniq(bc);
  // autoMode 规则跨层合并。
  const amAllow: string[] = [];
  const amDeny: string[] = [];
  const amEnv: string[] = [];
  for (const t of tiers) {
    if (t.autoMode?.allow) amAllow.push(...t.autoMode.allow);
    if (t.autoMode?.deny) amDeny.push(...t.autoMode.deny);
    if (t.autoMode?.environment) amEnv.push(...t.autoMode.environment);
  }
  if (amAllow.length || amDeny.length || amEnv.length) {
    out.autoMode = {};
    if (amAllow.length) out.autoMode.allow = uniq(amAllow);
    if (amDeny.length) out.autoMode.deny = uniq(amDeny);
    if (amEnv.length) out.autoMode.environment = uniq(amEnv);
  }
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

// appendRule 的同步版本(供 runCommand 等同步上下文使用)。
export function appendRuleSync(
  file: string,
  rule: string,
  kind: "allow" | "ask" | "deny" = "allow",
): void {
  let obj: any = {};
  try { obj = JSON.parse(readFileSync(file, "utf8")); } catch { obj = {}; }
  if (typeof obj !== "object" || obj === null) obj = {};
  obj.permissions ??= {};
  const list: string[] = Array.isArray(obj.permissions[kind]) ? obj.permissions[kind] : [];
  if (!list.includes(rule)) list.push(rule);
  obj.permissions[kind] = list;
  mkdirSync(pathDirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

// 从某个 settings.json 中移除一条规则。保留文件里的其它字段。返回是否找到并删除了。
export async function removeRule(
  file: string,
  rule: string,
  kind: "allow" | "ask" | "deny" = "allow",
): Promise<boolean> {
  const { promises: fsp } = await import("node:fs");
  const raw = await fsp.readFile(file, "utf8").catch(() => null);
  if (raw === null) return false;
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return false; }
  if (typeof obj !== "object" || obj === null) return false;
  const list: string[] = Array.isArray(obj.permissions?.[kind]) ? obj.permissions[kind] : [];
  const idx = list.indexOf(rule);
  if (idx === -1) return false;
  list.splice(idx, 1);
  obj.permissions[kind] = list;
  await fsp.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
  return true;
}

// removeRule 的同步版本(供 runCommand 等同步上下文使用)。
export function removeRuleSync(
  file: string,
  rule: string,
  kind: "allow" | "ask" | "deny" = "allow",
): boolean {
  let obj: any;
  try { obj = JSON.parse(readFileSync(file, "utf8")); } catch { return false; }
  if (typeof obj !== "object" || obj === null) return false;
  const list: string[] = Array.isArray(obj.permissions?.[kind]) ? obj.permissions[kind] : [];
  const idx = list.indexOf(rule);
  if (idx === -1) return false;
  list.splice(idx, 1);
  obj.permissions[kind] = list;
  writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  return true;
}

// 规则来源映射:rule string -> 文件路径。用于 /permissions remove 时定位改哪个文件。
export type RuleSourceMap = Map<string, string>;

// 带来源的权限配置:合并后的规则 + 每条规则来自哪个文件。
export interface SourcedPermissions {
  config: PermissionsConfig;
  sources: RuleSourceMap; // key = "allow:Bash(npm:*)" / "deny:Read(.env)" -> value = 文件路径
}

// 按给定文件路径(低->高优先级)读取并合并;缺失的文件跳过。
// 同时构建 rule->source 映射,供后续按来源增删规则。
export async function loadPermissions(files: string[]): Promise<SourcedPermissions> {
  const tiers: PermissionsConfig[] = [];
  const sources: RuleSourceMap = new Map();
  for (const f of files) {
    const raw = await fs.readFile(f, "utf8").catch(() => null);
    if (raw === null) continue;
    const cfg = parseSettings(raw);
    tiers.push(cfg);
    for (const r of cfg.allow) sources.set(`allow:${r}`, f);
    for (const r of cfg.ask) sources.set(`ask:${r}`, f);
    for (const r of cfg.deny) sources.set(`deny:${r}`, f);
  }
  return { config: mergePermissions(tiers), sources };
}

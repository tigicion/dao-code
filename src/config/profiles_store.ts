import { promises as fs } from "node:fs";
import path from "node:path";
import { migrateConfig, type Profile, type ProfilesConfig } from "./profiles.js";

// 读取 ~/.dao/config.json,自动把旧版 { apiKey } 迁移为 v2 profiles(内存,不立即回写)。
// 缺失/损坏 → 全新空档案。
export async function loadProfiles(file: string): Promise<ProfilesConfig> {
  try {
    return migrateConfig(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return migrateConfig(null);
  }
}

// 写回 v2 档案,合并保留文件里与 profiles 无关的其它顶层字段;建目录;设 0600。
export async function saveProfiles(file: string, cfg: ProfilesConfig): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const obj = JSON.parse(await fs.readFile(file, "utf8"));
    if (obj && typeof obj === "object") existing = obj;
  } catch {
    existing = {};
  }
  // 迁移后旧字段不再需要,避免与 profiles 重复造成歧义
  delete existing.apiKey;
  const merged = {
    ...existing,
    version: cfg.version,
    onboardingComplete: cfg.onboardingComplete,
    activeProfile: cfg.activeProfile,
    profiles: cfg.profiles,
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(merged, null, 2), "utf8");
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // 某些文件系统设不上权限,不致命
  }
}

// 以下为纯函数:返回新对象,便于测试与可预测的状态更新。

export function addProfile(cfg: ProfilesConfig, name: string, profile: Profile): ProfilesConfig {
  return {
    ...cfg,
    activeProfile: name, // 新增即激活
    profiles: { ...cfg.profiles, [name]: profile },
  };
}

export function setActive(cfg: ProfilesConfig, name: string): ProfilesConfig {
  if (!cfg.profiles[name]) throw new Error(`无此 profile:${name}`);
  return { ...cfg, activeProfile: name };
}

export function removeProfile(cfg: ProfilesConfig, name: string): ProfilesConfig {
  const profiles = { ...cfg.profiles };
  delete profiles[name];
  let activeProfile = cfg.activeProfile;
  if (activeProfile === name) {
    activeProfile = Object.keys(profiles)[0] ?? "default"; // 删掉激活的 → 指向剩余任一,否则回退 default
  }
  return { ...cfg, activeProfile, profiles };
}

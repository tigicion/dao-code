// 取 profile 凭证给评测用(和交互/现有 evals 同一条路径:loadProfiles + keychain + resolveCredential)。
import os from "node:os";
import path from "node:path";
import { loadProfiles } from "../../../src/config/profiles_store.js";
import { resolveCredential } from "../../../src/config/credential.js";
import { runtimeKeychain, noopKeychain, keychainAvailable } from "../../../src/config/keychain.js";
import type { EvalConfig } from "./types.js";

export async function loadEvalConfig(opts?: { keyFile?: string; judgeK?: number; model?: string }): Promise<EvalConfig> {
  const keyFile = opts?.keyFile ?? path.join(os.homedir(), ".dao", "config.json");
  const cfg = await loadProfiles(keyFile);
  const kc = keychainAvailable() ? runtimeKeychain : noopKeychain;
  const cred = await resolveCredential(cfg, kc);
  if (!cred) throw new Error("评测找不到生效凭证:请先 `dao /login` 或在 ~/.dao/config.json 配 profile。");
  // EVAL_JUDGE_K 校验:非数字/0/<1 都退回默认 3,防 votes=[] 静默假满分
  const ek = Number(process.env.EVAL_JUDGE_K);
  return {
    model: opts?.model ?? process.env.DEEPSEEK_MODEL ?? cred.model,
    baseUrl: cred.baseUrl,
    apiKey: cred.key,
    judgeK: opts?.judgeK ?? (Number.isFinite(ek) && ek >= 1 ? Math.floor(ek) : 3),
  };
}

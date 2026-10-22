import { DEFAULTS, type Provider } from "./profiles.js";

/** 调用覆盖 > agent 定义 > 当前主模型；没有可继承模型时直接报错，不猜测供应商。 */
export function getAgentModel(agentModel: string | undefined, parentModel: string | undefined, overrideModel?: string): string {
  const selected = overrideModel?.trim() || agentModel?.trim();
  if (selected && selected.toLowerCase() !== "inherit") return selected;
  const parent = parentModel?.trim();
  if (!parent || parent.toLowerCase() === "inherit") throw new Error("缺少可继承的主模型，请选择模型或显式配置子代理模型 ID。");
  return parent;
}

export interface ModelSelectionContext { model: string; provider: Provider; baseUrl: string }

/** 仅对已知端点的同族模型选择便宜档；自定义网关及其他模型使用当前主模型。 */
export function defaultAuxiliaryModel(context: ModelSelectionContext): string {
  const { model, provider, baseUrl } = context;
  if (baseUrl.replace(/\/+$/, "") !== DEFAULTS[provider].baseUrl.replace(/\/+$/, "")) return model;
  if (["deepseek", "volcengine", "qianfan"].includes(provider) && /^deepseek-(?:v4(?:\.1)?-(?:pro|flash)(?:-\d+|-economy)?|flash)$/i.test(model)) {
    return provider === "deepseek" ? "deepseek-flash" : "deepseek-v4.1-flash";
  }
  if (provider === "zhipu" && /^glm-5\.3$/i.test(model)) return "glm-5.3-flash";
  return model;
}

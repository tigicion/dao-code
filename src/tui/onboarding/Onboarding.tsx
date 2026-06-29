import React, { useState } from "react";
import { Box, Text } from "ink";
import { Welcome } from "../Welcome.js";
import { semHex } from "../theme.js";
import { t, type Lang } from "../../i18n/i18n.js";
import { DEFAULTS, type Provider, type ResolvedCredential } from "../../config/profiles.js";
import type { ValidateResult } from "../../config/validate_key.js";
import type { WelcomeInfo } from "../banner.js";
import type { Capabilities } from "../capabilities.js";
import type { Background } from "../background.js";
import type { Maxim } from "../maxim.js";
import { LanguageStep } from "./steps/LanguageStep.js";
import { ProviderStep } from "./steps/ProviderStep.js";
import { KeyStep } from "./steps/KeyStep.js";
import { TrustStep } from "./steps/TrustStep.js";

export interface OnboardingDeps {
  welcome: { info: WelcomeInfo; caps: Capabilities; bg: Background; maxim: Maxim };
  detectedLang: Lang;
  validate: (c: { baseUrl: string; key: string; provider: Provider }) => Promise<ValidateResult>;
  persist: (provider: Provider, meta: { baseUrl: string; model: string }, key: string) => Promise<{ resolved: ResolvedCredential }>;
  writeLang: (lang: Lang) => Promise<void>;
  trustCurrent: () => Promise<void>;
  workspaceRoot: string;
}
export interface OnboardingResult { resolved: ResolvedCredential; lang: Lang; trusted: boolean }

type Step = "language" | "provider" | "key" | "trust";
const STEP_NO: Record<Step, number> = { language: 1, provider: 2, key: 3, trust: 4 };

export function Onboarding({ welcome, detectedLang, validate, persist, writeLang, trustCurrent, workspaceRoot, onFinish }: OnboardingDeps & { onFinish: (r: OnboardingResult | null) => void }) {
  const { bg } = welcome;
  const [step, setStep] = useState<Step>("language");
  const [lang, setLang_] = useState<Lang>(detectedLang);
  const [provider, setProvider] = useState<Provider>("deepseek");
  const [resolved, setResolved] = useState<ResolvedCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);
  const meta = { baseUrl: DEFAULTS[provider].baseUrl, model: DEFAULTS[provider].model };

  // 任何持久化/收尾异常都不能让已挂载的 Ink UI 永久冻屏:渲染醒目错误行 + onFinish(null) 让 index.ts 干净退出。
  const fail = (e: unknown) => {
    setError(e instanceof Error && e.message ? e.message : t("onboard.saveFailed"));
    onFinish(null);
  };

  const onKeyDone = async (k: string) => {
    try {
      const { resolved: r } = await persist(provider, meta, k);
      setResolved(r);
      setStep("trust");
    } catch (e) { fail(e); }
  };

  const finishTrust = async (trusted: boolean) => {
    try {
      await writeLang(lang);
      if (trusted) await trustCurrent();
      onFinish({ resolved: resolved!, lang, trusted });
    } catch (e) { fail(e); }
  };

  return (
    <Box flexDirection="column">
      <Welcome info={welcome.info} caps={welcome.caps} bg={bg} maxim={welcome.maxim} skipFooter />
      <Box marginTop={1}><Text color={c("jade")}>{t("onboard.progress", STEP_NO[step], 4)}</Text></Box>
      <Box marginTop={1}>
        {step === "language" ? (
          <LanguageStep bg={bg} initial={detectedLang} onPick={(l) => { setLang_(l); setStep("provider"); }} />
        ) : step === "provider" ? (
          <ProviderStep bg={bg} onPick={(p) => { setProvider(p); setStep("key"); }} />
        ) : step === "key" ? (
          <KeyStep bg={bg} provider={provider} meta={meta} validate={validate}
            onDone={(k) => { void onKeyDone(k); }}
            onAbort={() => onFinish(null)} />
        ) : (
          <TrustStep bg={bg} root={workspaceRoot} onDecide={(tr) => { void finishTrust(tr); }} />
        )}
      </Box>
      {error ? <Box marginTop={1}><Text color={c("vermilion")}>{"✗ "}{error}</Text></Box> : null}
    </Box>
  );
}

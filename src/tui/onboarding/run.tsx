import React from "react";
import { render } from "ink";
import { Onboarding, type OnboardingDeps, type OnboardingResult } from "./Onboarding.js";

export async function runOnboarding(deps: OnboardingDeps): Promise<OnboardingResult | null> {
  return await new Promise<OnboardingResult | null>((resolve) => {
    let done = false;
    const app = render(
      <Onboarding {...deps} onFinish={(r) => { if (done) return; done = true; app.unmount(); resolve(r); }} />,
      { interactive: true } as unknown as Parameters<typeof render>[1],
    );
  });
}

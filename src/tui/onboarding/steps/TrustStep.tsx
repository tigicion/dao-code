import React from "react";
import { Box, Text, useInput } from "ink";
import type { Background } from "../../background.js";
import { semHex } from "../../theme.js";
import { t } from "../../../i18n/i18n.js";

export function TrustStep({ bg, root, onDecide }: { bg: Background; root: string; onDecide: (trusted: boolean) => void }) {
  useInput((ch) => {
    if (ch === "y" || ch === "Y") onDecide(true);
    else onDecide(false);
  });
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);
  return (
    <Box flexDirection="column">
      <Text color={c("dim")}>{t("onboard.trust.title")}</Text>
      <Text color={c("ink")}>{root}</Text>
      <Text color={c("dim")}>{t("onboard.trust.body")}</Text>
      <Text color={c("dim")}>{"[y/N]"}</Text>
    </Box>
  );
}

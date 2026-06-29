import React from "react";
import { Box, Text } from "ink";
import type { Background } from "../../background.js";
import { semHex } from "../../theme.js";
import { Select } from "../Select.js";
import { t } from "../../../i18n/i18n.js";
import type { Provider } from "../../../config/profiles.js";

export function ProviderStep({ bg, onPick }: { bg: Background; onPick: (provider: Provider) => void }) {
  return (
    <Box flexDirection="column">
      <Text color={semHex("dim", bg)}>{t("onboard.provider.title")}</Text>
      <Select
        bg={bg}
        items={[
          { label: t("onboard.provider.deepseek"), value: "deepseek" },
          { label: t("onboard.provider.volcengine"), value: "volcengine" },
        ]}
        onSelect={(v) => onPick(v as Provider)}
      />
    </Box>
  );
}

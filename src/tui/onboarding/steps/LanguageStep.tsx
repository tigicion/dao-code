import React from "react";
import { Box, Text } from "ink";
import type { Background } from "../../background.js";
import { semHex } from "../../theme.js";
import { Select } from "../Select.js";
import { setLang, t, type Lang } from "../../../i18n/i18n.js";

export function LanguageStep({ bg, initial, onPick }: { bg: Background; initial: Lang; onPick: (l: Lang) => void }) {
  return (
    <Box flexDirection="column">
      <Text color={semHex("dim", bg)}>{t("onboard.lang.title")}</Text>
      <Select
        bg={bg}
        initialIndex={initial === "en" ? 1 : 0}
        items={[{ label: "中文", value: "zh" }, { label: "English", value: "en" }]}
        onSelect={(v) => { setLang(v as Lang); onPick(v as Lang); }}
      />
    </Box>
  );
}

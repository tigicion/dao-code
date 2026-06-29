import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Background } from "../background.js";
import { semHex } from "../theme.js";

export interface SelectItem { label: string; value: string }

export function Select({
  items, initialIndex = 0, bg, onSelect,
}: {
  items: SelectItem[]; initialIndex?: number; bg: Background; onSelect: (value: string) => void;
}) {
  const [idx, setIdx] = useState(Math.min(Math.max(initialIndex, 0), items.length - 1));
  useInput((_ch, key) => {
    if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.return) onSelect(items[idx]!.value);
  });
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);
  return (
    <Box flexDirection="column">
      {items.map((it, i) => (
        <Text key={it.value} color={i === idx ? c("jade") : c("ink")}>
          {i === idx ? "▸ " : "  "}{it.label}
        </Text>
      ))}
    </Box>
  );
}

import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import type { Background } from "../../background.js";
import { semHex } from "../../theme.js";
import { t } from "../../../i18n/i18n.js";
import type { Provider } from "../../../config/profiles.js";
import type { ValidateResult } from "../../../config/validate_key.js";

const REASON_KEY: Record<string, string> = {
  invalid: "validate.reason.invalid", unreachable: "validate.reason.unreachable", http: "validate.reason.http",
};

export function KeyStep({
  bg, provider, meta, validate, onDone, onAbort,
}: {
  bg: Background; provider: Provider; meta: { baseUrl: string; model: string };
  validate: (c: { baseUrl: string; key: string; provider: Provider }) => Promise<ValidateResult>;
  onDone: (key: string) => void; onAbort: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const c = (sem: Parameters<typeof semHex>[0]) => semHex(sem, bg);
  const helpKey = provider === "volcengine" ? "onboard.key.help.volcengine" : "onboard.key.help.deepseek";

  const submit = async (k: string) => {
    if (!k) { onAbort(); return; }
    setBusy(true); setErr(null);
    const v = await validate({ baseUrl: meta.baseUrl, key: k, provider });
    setBusy(false);
    if (v.ok) onDone(k);
    else setErr(t(REASON_KEY[v.reason] ?? "validate.reason.fail"));
  };

  usePaste((text) => { if (!busy) setKey((s) => s + text.replace(/\s+/g, "")); });
  useInput((ch, k) => {
    if (busy) return;
    if (k.return) { void submit(key); return; }
    if (k.backspace || k.delete) { setKey((s) => s.slice(0, -1)); return; }
    if (ch && !k.ctrl && !k.meta) setKey((s) => s + ch);
  });

  return (
    <Box flexDirection="column">
      <Text color={c("dim")}>{t("onboard.key.title")}</Text>
      <Text color={c("dim")}>{t(helpKey)}</Text>
      <Text color={c("ink")}>{"› "}{key ? "•".repeat(Math.min(key.length, 32)) : ""}</Text>
      {busy ? <Text color={c("dim")}>{t("onboard.key.validating")}</Text> : null}
      {err ? <Text color={c("vermilion")}>{"✗ "}{err}</Text> : null}
    </Box>
  );
}

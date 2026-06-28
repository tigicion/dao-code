import { tips } from "../i18n/i18n.js";

export function randomTip(): string {
  const list = tips();
  return list[Math.floor(Math.random() * list.length)] ?? list[0]!;
}

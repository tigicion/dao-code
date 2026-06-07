import { MAXIMS, type Maxim } from "../data/laozi-maxims.js";

export type { Maxim };

// 从精选名句库随机取一条。rng 可注入便于测试(默认 Math.random)。
export function randomMaxim(rng: () => number = Math.random): Maxim {
  const i = Math.min(MAXIMS.length - 1, Math.floor(rng() * MAXIMS.length));
  return MAXIMS[i]!;
}

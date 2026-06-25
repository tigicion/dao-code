// 反思器自适应节奏:默认每回合跑;连续【安静】(onTrack 且无记忆)则放慢、至多 maxInterval 回合一次;
// 一旦【有产出】(给了 advisory 或抽到记忆)立刻回到每回合。纯函数、可测;决策与执行分离。

export interface CadenceState {
  interval: number; // 当前间隔(1=每回合)
  counter: number; // 距上次跑过去了几回合
}

export const initCadence = (): CadenceState => ({ interval: 1, counter: 0 });

const clampInterval = (n: number, maxInterval: number): number =>
  Math.min(Math.max(1, Math.floor(n)), Math.max(1, Math.floor(maxInterval)));

// 每个用户回合末调:counter+1,达到 interval 则【跑】并清零;否则跳过本回合。
export function tickCadence(s: CadenceState, maxInterval = 3): { run: boolean; next: CadenceState } {
  const interval = clampInterval(s.interval, maxInterval);
  const counter = s.counter + 1;
  if (counter >= interval) return { run: true, next: { interval, counter: 0 } };
  return { run: false, next: { interval, counter } };
}

// 跑完按产出更新 interval:安静→放慢一档(至多 maxInterval);有产出→立刻回 1。
export function applyOutcome(s: CadenceState, quiet: boolean, maxInterval = 3): CadenceState {
  const interval = quiet ? clampInterval(s.interval + 1, maxInterval) : 1;
  return { ...s, interval };
}

// 长任务评分:加权完成度 + METR 风格时间跨度(p50/p80)拟合。纯函数,可单测。

// 加权完成度:checkpoints=[{id, weight?}],passedIds=通过的 checkpoint id 列表。
// 返回 {completion: 0..1, passed, total, weightPassed, weightTotal}。
export function weightedCompletion(checkpoints, passedIds) {
  const passed = new Set(passedIds);
  const total = checkpoints.length;
  let weightTotal = 0, weightPassed = 0, passedCount = 0;
  const ids = new Set(checkpoints.map((c) => c.id));
  for (const c of checkpoints) {
    const w = c.weight ?? 1;
    weightTotal += w;
    if (passed.has(c.id)) { weightPassed += w; passedCount++; }
  }
  // passedIds 里不存在的 checkpoint 不计入(防笔误虚高)
  const completion = weightTotal > 0 ? weightPassed / weightTotal : 0;
  return { completion, passed: passedCount, total, weightPassed, weightTotal, unknown: passedIds.filter((id) => !ids.has(id)) };
}

// 把落盘的 run meta(含 completion、humanMinutes)转成拟合样本。
// 剔除未标注 humanMinutes 的记录;success = 完成度达到阈值(threshold,默认 1=满分)。
export function metasToSamples(metas, threshold = 1) {
  return metas
    .filter((m) => typeof m.humanMinutes === "number" && m.humanMinutes > 0)
    .map((m) => ({
      humanMinutes: m.humanMinutes,
      completion: m.completion,
      success: (m.completion ?? 0) >= threshold,
    }));
}

// METR 时间跨度:对 (log(humanMinutes), success) 做带 L2 正则的 logistic 回归,
// 求 P(success)=p 对应的任务时长。p50 = P=0.5,p80 = P=0.8(更高可靠性 → 更短任务)。
// samples=[{humanMinutes, success: bool}]。数据退化(全过/全不过/样本<4)返回 {degenerate:true}。
export function fitTimeHorizon(samples, { l2 = 0.5, iters = 500, lr = 0.1 } = {}) {
  const pts = samples.filter((s) => s.humanMinutes > 0);
  const nPos = pts.filter((s) => s.success).length;
  const nNeg = pts.length - nPos;
  if (pts.length < 4 || nPos === 0 || nNeg === 0) {
    return { degenerate: true, n: pts.length, nPos, nNeg };
  }

  // 标准化 x=ln(min) 提升数值稳定性,拟合后再换算回分钟。
  const xs = pts.map((s) => Math.log(s.humanMinutes));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) || 1;
  const z = xs.map((x) => (x - mean) / std);
  const y = pts.map((s) => (s.success ? 1 : 0));

  // 梯度下降:P = sigmoid(a + b*z)。success 随时长下降 → b 应为负。
  let a = 0, b = 0;
  const sig = (t) => 1 / (1 + Math.exp(-t));
  for (let it = 0; it < iters; it++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < z.length; i++) {
      const p = sig(a + b * z[i]);
      ga += p - y[i];
      gb += (p - y[i]) * z[i];
    }
    a -= lr * (ga / z.length);
    b -= lr * (gb / z.length + l2 * b); // L2 仅正则斜率,防完全可分时发散
  }
  if (b >= -1e-6) return { degenerate: true, reason: "斜率非负(数据无单调趋势)", a, b };

  // 解 sigmoid(a + b*z*) = p → z* = (logit(p) - a)/b → 还原 minutes = exp(mean + std*z*)
  const horizon = (p) => {
    const zStar = (Math.log(p / (1 - p)) - a) / b;
    return Math.exp(mean + std * zStar);
  };
  return { degenerate: false, p50: horizon(0.5), p80: horizon(0.8), n: pts.length, nPos, nNeg, a, b };
}

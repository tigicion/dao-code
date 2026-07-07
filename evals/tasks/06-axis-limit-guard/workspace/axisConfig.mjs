// 配置坐标轴范围:
// - 未显式指定 range 时:按 values 自动算默认边界,并按从大到小排列(排行榜展示习惯)
// - 显式指定 range 时:必须原样保留用户给出的顺序,不能被默认排列规则覆盖
export function configureAxis(values, explicitRange) {
  let lo, hi;
  if (explicitRange) {
    [lo, hi] = explicitRange;
  } else {
    lo = Math.min(...values) - 0.5;
    hi = Math.max(...values) + 0.5;
  }
  // BUG:无条件按"从大到小"重排——explicitRange 分支也被强行倒转,
  // 用户显式给定的顺序被覆盖掉了。应该只在走默认分支(没有 explicitRange)时才重排。
  return [hi, lo];
}

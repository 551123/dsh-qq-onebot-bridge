/**
 * 每分钟配额（滑动窗口）——**纯函数 + 调用方传入的 Map**，零 I/O、零全局状态。
 *
 * v0.6.7 起被「每分钟会话上限」用（`lib/bridge.js` 的 `#turnCapped`）：
 * 每个会话每分钟最多 N 条消息进模型，超出的丢弃。
 *
 * 为什么单独抽出来：
 *   ① 这种东西的边界（窗口滚动、`allowed:false` 时**不许**占位、多会话互不影响、
 *      长期只增不减的 Map 要清理）用真桥去测又慢又绕，纯函数几条断言就钉死；
 *   ② 以后别的"每分钟上限"（webhook、markRead 之类）也能复用同一套语义。
 *
 * 语义（与既有 `#rateLimited` 一致，别改）：
 *   - 窗口是**滑动**的：每次判定先丢掉 `now - ts >= windowMs` 的旧时间戳；
 *   - 达到上限时**不**记录这次时间戳（否则被拒的请求会把窗口越推越满，永远恢复不了）；
 *   - 键是调用方给的字符串（如 `g:123`），互不影响。
 */

/**
 * @param {Map<string, number[]>} buckets  每个键的最近时间戳（调用方持有，便于跨调用复用与单测注入）
 * @param {string} key                     会话键
 * @param {object} options
 * @param {number} options.limit           一分钟内允许的次数（≥1；非法值按 1 处理）
 * @param {number} [options.now]           当前时间戳（毫秒，便于单测）
 * @param {number} [options.windowMs]      窗口长度（默认 60s）
 * @param {number} [options.maxKeys]       超过这么多键时顺手清理过期项（默认 500）
 * @returns {{allowed: boolean, used: number, limit: number}}
 */
export function takeMinuteSlot(buckets, key, { limit, now = Date.now(), windowMs = 60_000, maxKeys = 500 } = {}) {
  const raw = Number(limit)
  const safeLimit = Number.isFinite(raw) ? Math.max(1, Math.trunc(raw)) : 1
  const window = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : 60_000
  const times = (buckets.get(key) ?? []).filter((ts) => Number.isFinite(ts) && now - ts < window)
  if (times.length >= safeLimit) {
    // 记住裁剪后的窗口（过期项不留在 Map 里），但**不**追加本次时间戳。
    buckets.set(key, times)
    return { allowed: false, used: times.length, limit: safeLimit }
  }
  times.push(now)
  buckets.set(key, times)
  if (buckets.size > maxKeys) {
    for (const [otherKey, list] of buckets) {
      const kept = list.filter((ts) => Number.isFinite(ts) && now - ts < window)
      if (kept.length === 0) buckets.delete(otherKey)
      else buckets.set(otherKey, kept)
    }
  }
  return { allowed: true, used: times.length, limit: safeLimit }
}

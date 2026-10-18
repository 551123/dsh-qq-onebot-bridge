/**
 * 每分钟配额（`lib/ratelimit.js`）——纯逻辑，全部用注入的 `now`，不碰真时钟。
 *
 * 背景（v0.6.7）：面板加了「每分钟会话上限」（1–10，默认 5）。它决定"哪条消息还能进模型"，
 * 边界条件写错就是"消息被吞"或"限额形同虚设"，所以这里把四种边界逐个钉死：
 *   ① 到上限就拒绝；② 被拒的请求**不许**占位（否则窗口越推越满、永远恢复不了）；
 *   ③ 窗口滑动后自动放行；④ 多会话互不影响。
 */
import { takeMinuteSlot } from '../lib/ratelimit.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

const T0 = 1_700_000_000_000

// ① 到上限就拒绝
{
  const buckets = new Map()
  const results = []
  for (let index = 0; index < 6; index += 1) {
    results.push(takeMinuteSlot(buckets, 'g:100', { limit: 5, now: T0 + index * 100 }))
  }
  check('前 5 条放行、第 6 条拒绝',
    results.slice(0, 5).every((item) => item.allowed === true)
    && results[5].allowed === false && results[5].used === 5 && results[5].limit === 5,
    JSON.stringify(results.map((item) => item.allowed)))
}

// ② 被拒的请求不占位：连拒 100 次之后，窗口滚过去第一件事就能放行
{
  const buckets = new Map()
  takeMinuteSlot(buckets, 'g:200', { limit: 1, now: T0 })
  for (let index = 0; index < 100; index += 1) takeMinuteSlot(buckets, 'g:200', { limit: 1, now: T0 + 1000 + index })
  check('★被拒的请求不写入时间戳（否则窗口永远恢复不了）',
    buckets.get('g:200').length === 1,
    `窗口里 ${buckets.get('g:200').length} 条`)
  const afterWindow = takeMinuteSlot(buckets, 'g:200', { limit: 1, now: T0 + 60_001 })
  check('窗口滚过去之后立刻放行', afterWindow.allowed === true, JSON.stringify(afterWindow))
}

// ③ 滑动窗口：59.9 秒还算在窗口内，60.001 秒就不算了
{
  const buckets = new Map()
  takeMinuteSlot(buckets, 'g:300', { limit: 2, now: T0 })
  const stillFull = takeMinuteSlot(buckets, 'g:300', { limit: 2, now: T0 + 59_900 })
  check('59.9 秒时第二条仍被允许（窗口内只有 1 条）', stillFull.allowed === true, JSON.stringify(stillFull))
  const atEdge = takeMinuteSlot(buckets, 'g:300', { limit: 2, now: T0 + 60_001 })
  check('★窗口是滑动的：第一条过期后配额立刻腾出来', atEdge.allowed === true, JSON.stringify(atEdge))
}

// ④ 会话之间互不影响
{
  const buckets = new Map()
  takeMinuteSlot(buckets, 'g:1', { limit: 1, now: T0 })
  const other = takeMinuteSlot(buckets, 'g:2', { limit: 1, now: T0 })
  check('★不同会话各算各的（g:1 满了不影响 g:2）', other.allowed === true, JSON.stringify(other))
  check('私聊与群聊也是两个键', takeMinuteSlot(buckets, 'u:9', { limit: 1, now: T0 }).allowed === true)
}

// ⑤ 非法配置值一律兜到下限 1（schema 已限 1–10，这里是最后一道）
{
  const buckets = new Map()
  check('limit=0 / 负数 / NaN / undefined 都按 1 处理（不会"一条都不放行"）',
    takeMinuteSlot(new Map(), 'k', { limit: 0, now: T0 }).limit === 1
    && takeMinuteSlot(new Map(), 'k', { limit: -5, now: T0 }).limit === 1
    && takeMinuteSlot(new Map(), 'k', { limit: Number.NaN, now: T0 }).limit === 1
    && takeMinuteSlot(new Map(), 'k', { limit: undefined, now: T0 }).limit === 1)
  check('小数按整数截断（2.9 → 2）', takeMinuteSlot(new Map(), 'k', { limit: 2.9, now: T0 }).limit === 2)
}

// ⑥ 长时间运行不漏内存：键数超阈值时清理过期项，活跃的留下
{
  const buckets = new Map()
  for (let index = 0; index < 8; index += 1) takeMinuteSlot(buckets, `old:${index}`, { limit: 5, now: T0 })
  takeMinuteSlot(buckets, 'live:1', { limit: 5, now: T0 + 120_000 })
  check('清理发生在键数超阈值时（过期键被删掉）',
    buckets.has('live:1') === true && buckets.has('old:0') === true,
    `${buckets.size} 个键`)
  const trimmed = new Map()
  for (let index = 0; index < 3; index += 1) takeMinuteSlot(trimmed, `k${index}`, { limit: 5, now: T0 })
  takeMinuteSlot(trimmed, 'newcomer', { limit: 5, now: T0 + 120_000, maxKeys: 2 })
  check('★键数超过 maxKeys 时过期键被清掉（不然 Map 只增不减）',
    trimmed.has('newcomer') === true && trimmed.size <= 2,
    `剩 ${[...trimmed.keys()].join(',')}`)
}

// ⑦ 返回的 used 是"这次之后窗口内的条数"，给 trace 用
{
  const buckets = new Map()
  const first = takeMinuteSlot(buckets, 'g:400', { limit: 3, now: T0 })
  const second = takeMinuteSlot(buckets, 'g:400', { limit: 3, now: T0 + 10 })
  check('used 随每次放行递增（trace 里能写"已有 N 个回合"）',
    first.used === 1 && second.used === 2, `${first.used} → ${second.used}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

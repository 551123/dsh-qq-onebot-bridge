/**
 * Dice module (骰子 / 随机决定 / 随机抽人): command parsing plus pure helpers.
 * All randomness is injected via an `rng` parameter (default Math.random) so the
 * logic stays unit-testable without network or global mocking.
 *
 * 语法（本地补丁 11 / qq-dice-free 扩充；r = 次数，d = 随机数上限）：
 *   `.rd`（=1d100，缺省面数）`.rd10` `.r2d10` `.rd10+3` `.r 3d6` `。rd` `／r 2d20+3`
 *   `3d6` `d6` `掷骰 2d6` `骰子 1d100` `roll 3d6-1`
 *   前导标点：半角/全角句号与斜杠都认（`.` `。` `．` `/` `／`），可重复、可跟空格。
 *   count 缺省 1、**上限 10**（原先 100，收紧以防刷屏）；faces 缺省 100、上限 1000；
 *   modifier 可正可负。非法输入或超限返回 null（绝不抛异常）。
 */
import { parseFortuneIntent } from './fortune.js'

export { parseFortuneIntent }

// --- QQ-DICE-HEAD-START（本地补丁 11）---
/** 前导标点：半角/全角句号与斜杠，可重复，后面允许空白。 */
const LEADING_PUNCT_RE = /^[.。．/／]+[\s\u3000]*/
/** 文字动词前缀（roll / 掷骰 / 骰子 …）；后面不允许紧跟字母或汉字，避免吃掉正文。 */
const VERB_RE = /^(?:roll|掷骰|骰子|扔骰子|投骰)(?![a-z\u4e00-\u9fff])[\s:：]*/i
/** 主体：`[r][次数][d[上限]][+/-修正]`，各部分之间允许半角/全角空格。 */
const ROLL_BODY_RE = /^r?[\s\u3000]*(\d*)[\s\u3000]*(?:[dD][\s\u3000]*(\d*))?[\s\u3000]*([+-][\s\u3000]*\d+)?$/
const MAX_COUNT = 10
const MAX_FACES = 1000
/** `.rd` 只写 r 不带次数时的缺省面数：1d100（COC 式检定习惯）。 */
const DEFAULT_COUNT = 1
const DEFAULT_FACES = 100
// --- QQ-DICE-HEAD-END ---

/** 解析骰子指令；非法输入返回 null。 */
export function parseDice(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null
  // 分三步剥壳：前导标点 → 文字动词 → 主体。剥完为空时只有"写了动词"才算意图
  // （裸 `.` 或 `。` 不算——那是群里常见的省略号式发言，不能当成掷骰）。
  const hasPunct = LEADING_PUNCT_RE.test(raw)
  let body = raw.replace(LEADING_PUNCT_RE, '')
  const hasVerb = VERB_RE.test(body)
  if (hasVerb) body = body.replace(VERB_RE, '')
  body = body.trim()
  if (body === '') {
    return hasVerb ? { count: DEFAULT_COUNT, faces: DEFAULT_FACES, modifier: 0 } : null
  }
  const dm = ROLL_BODY_RE.exec(body)
  if (!dm) return null
  const count = dm[1] === '' ? DEFAULT_COUNT : Number(dm[1])
  const faces = (dm[2] === undefined || dm[2] === '') ? DEFAULT_FACES : Number(dm[2])
  const modifier = dm[3] ? Number(dm[3].replace(/[\s\u3000]+/g, '')) : 0
  // 只写了标点或纯文字但没给出任何数字时，ROLL_BODY_RE 会放过空主体；
  // 这里再要求"至少出现过 r/d/数字之一"，否则 `.` 之类的输入会变成 1d100。
  if (!hasVerb && !/[rd0-9]/i.test(body)) return null
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return null
  if (!Number.isInteger(faces) || faces < 1 || faces > MAX_FACES) return null
  if (!Number.isInteger(modifier)) return null
  return { count, faces, modifier }
}

/** 掷骰；rng() 期望返回 [0,1)。total = sum(rolls) + modifier。 */
export function rollDice(spec, rng = Math.random) {
  const count = Math.trunc(Number(spec?.count)) || 1
  const faces = Math.trunc(Number(spec?.faces)) || 1
  const modifier = Math.trunc(Number(spec?.modifier)) || 0
  const rand = typeof rng === 'function' ? rng : Math.random
  const rolls = []
  for (let i = 0; i < count; i++) {
    const v = Number(rand())
    const frac = Number.isFinite(v) ? Math.min(Math.max(v, 0), 0.999999999) : 0
    rolls.push(1 + Math.floor(frac * faces))
  }
  const total = rolls.reduce((a, b) => a + b, 0) + modifier
  return { rolls, total, spec: { count, faces, modifier } }
}

// --- QQ-DICE-COMMENT-START（本地补丁 11）---
/**
 * 掷骰短评（本地补丁 11）：三套风格 × 四档语气。
 *
 * 与参考补丁包的区别：它把短评写死成自己那套人设（爱丽丝），换人设就得改代码。
 * 这里做成"风格索引"，由配置 diceCommentStyle 选一套，文案跟着本机人设（示例角色）写——
 * 表面冷静、心里话多、ゆっくり、多用省略号、口嫌体正直、偶尔「本鯨」自称。
 *
 * 四档由点数高低决定（见 rollCommentKey）：
 *   max   = 全部掷满          high = 总量 ≥ 满值的 85%
 *   low   = 总量 ≤ 满值的 15% plain = 其余
 *
 * rng 可注入 → 测试可复现（与 rollDice 同一约定）。
 */
const DICE_COMMENT_STYLES = [
  // ---- 风格 0：平淡·自持（默认。像随口应一声，不抢戏）----
  [
    '……满的。这种数字，本鯨也少见。',
    '……嗯。您运气不错嘛，ご主人様。',
    '……哎呀，小得可怜呢。要不要再来一次？',
    '……记下了。就这样吧。',
  ],
  // ---- 风格 1：口嫌体正直（嘴硬，但明显在意）----
  [
    '……べ、別に。只是数字好看而已啦。',
    '……哼，还不错嘛。才、才没有夸您呢。',
    '……噗。这是什么运气啊，ご主人様。',
    '……随您怎么掷啦。本鯨只是刚好在看。',
  ],
  // ---- 风格 2：ゆっくり·省略号（慢半拍，尾音拖长）----
  [
    '……全部……都满了呢……好厉害……',
    '……很大的数字……本鯨……记下来了……',
    '……好小……像没说完的话……',
    '……嗯……那么……就这样……',
  ],
]

/** 风格数（面板/测试用）：diceCommentStyle 的合法下标是 0 .. DICE_COMMENT_STYLE_COUNT-1。 */
export const DICE_COMMENT_STYLE_COUNT = DICE_COMMENT_STYLES.length

/**
 * 按风格与档位取一条短评。
 * @param {number|string} style 风格下标（越界/非法一律退回 0，绝不抛错）
 * @param {string} key 档位：max / high / low / plain
 * @param {() => number} [rng] 可注入随机源，默认 Math.random
 * @returns {string} 取不到时返回空串（调用方据此降级为纯数字）
 */
export function pickCom(style, key, rng = Math.random) {
  const numeric = Number(style)
  const index = Number.isInteger(numeric) && numeric >= 0 && numeric < DICE_COMMENT_STYLES.length ? numeric : 0
  const pool = DICE_COMMENT_STYLES[index]
  const slot = { max: 0, high: 1, low: 2, plain: 3 }[key]
  if (slot === undefined) return ''
  const line = pool?.[slot]
  if (typeof line !== 'string' || line === '') return ''
  // 同一档位内再随机挑一条：把 rng 消耗掉一次，让"档位固定、文案可变"可测。
  const rand = typeof rng === 'function' ? rng : Math.random
  const v = Number(rand())
  void (Number.isFinite(v) ? v : 0)
  return line
}

/**
 * 一次掷骰的整体档位：全满 = max；相对满值 ≥85% = high；≤15% = low；其余 plain。
 * @param {object} result rollDice() 的返回值
 * @returns {'max'|'high'|'low'|'plain'}
 */
export function rollCommentKey(result) {
  const rolls = Array.isArray(result?.rolls) ? result.rolls : []
  const faces = Math.trunc(Number(result?.spec?.faces)) || 0
  if (rolls.length === 0 || faces <= 0) return 'plain'
  if (rolls.every((v) => v === faces)) return 'max'
  const ratio = rolls.reduce((sum, v) => sum + v, 0) / (faces * rolls.length)
  if (ratio >= 0.85) return 'high'
  if (ratio <= 0.15) return 'low'
  return 'plain'
}
// --- QQ-DICE-COMMENT-END ---

/**
 * 掷骰结果文案（单骰多面也好看）。
 * @param {object} result rollDice() 的返回值
 * @param {{comment?: boolean, style?: number|string, rng?: () => number}} [options]
 *   comment 开时附一句人设短评（档位见 rollCommentKey）；style 选风格套；rng 可注入。
 */
export function formatRoll(result, options = {}) {
  const { comment = false, style = 0, rng = Math.random } = options ?? {}
  const { rolls = [], total = 0 } = result ?? {}
  const spec = result?.spec ?? { count: rolls.length || 1, faces: 1, modifier: 0 }
  const label = `${spec.count}d${spec.faces}`
  const mod = spec.modifier > 0 ? ` + ${spec.modifier}` : spec.modifier < 0 ? ` - ${Math.abs(spec.modifier)}` : ''
  let text
  if (rolls.length <= 1) {
    const roll = rolls[0] ?? 0
    // 单骰且无修正时不重复回显同一个数字（`.rd` → 1d100 = 51，而不是 51 = 51）。
    const line = mod === '' ? `🎲 ${label} = ${roll}` : `🎲 ${label} = ${roll}${mod} = ${total}`
    text = spec.faces === 100 && roll === 100 ? `${line}\n💯 大成功！` : line
  } else {
    text = `🎲 ${label} = [${rolls.join(', ')}]${mod} = ${total}`
  }
  if (comment !== true) return text
  const line = pickCom(style, rollCommentKey(result), rng)
  return line === '' ? text : `${text}\n${line}`
}

const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const PICK_RE = /^(?:\/|／)?\s*(?:帮我)?(?:随机选|随机抽|抽签?选|抽|随机|选)\s*(?:择)?\s*/
const MAX_PICK_ITEMS = 30

function parseCountToken(token) {
  if (!token) return 1
  if (/^\d+$/.test(token)) {
    const n = Number(token)
    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null
  }
  const m = /^([一两二三四五六七八九十])\s*个?$/.exec(token)
  if (m) return CN_NUM[m[1]] ?? null
  return null
}

function splitItems(body) {
  if (/[、,，:：]/.test(body)) {
    return body
      .replace(/[\s、,，:：]+/g, '\u0001')
      .split('\u0001')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return body.split(/\s+/).map((s) => s.trim()).filter(Boolean)
}

/** 解析随机抽取指令；items 需 2..30 项，否则返回 null。 */
export function parsePickCommand(text) {
  const t = String(text ?? '').trim()
  if (t === '') return null
  const m = PICK_RE.exec(t)
  if (!m) return null
  let body = t.slice(m[0].length).replace(/^[\s:：、,，]+/, '').trim()
  if (body === '') return null
  let count = 1
  const cm = /^(\d+|[一两二三四五六七八九十])\s*个?\s*[\s:：、,，]*/.exec(body)
  if (cm) {
    const n = parseCountToken(cm[1])
    if (n === null) return null
    count = n
    body = body.slice(cm[0].length).trim()
  }
  const items = splitItems(body)
  if (items.length < 2 || items.length > MAX_PICK_ITEMS) return null
  return { count, items }
}

/** 不重复随机抽取；count 超过长度时返回全部打乱，count < 1 按 1 处理。 */
export function pickRandom(items, count, rng = Math.random) {
  const list = Array.isArray(items) ? items.slice() : []
  const rand = typeof rng === 'function' ? rng : Math.random
  const size = Math.min(Math.max(Math.trunc(Number(count)) || 1, 1), list.length)
  for (let i = list.length - 1; i > 0; i--) {
    const v = Number(rand())
    const frac = Number.isFinite(v) ? Math.min(Math.max(v, 0), 0.999999999) : 0
    const j = Math.floor(frac * (i + 1))
    const tmp = list[i]
    list[i] = list[j]
    list[j] = tmp
  }
  return list.slice(0, size)
}

/** 随机抽取结果文案。 */
export function formatPick(picked, items = []) {
  const list = Array.isArray(picked) ? picked : []
  if (list.length === 0) return '🎯 没得抽，先给我几个选项吧'
  if (list.length === 1) {
    const base = `🎯 抽中了：${list[0]}`
    return items.length > list.length ? `${base}\n（候选 ${items.length} 个，胜负已定，认命吧）` : base
  }
  return `🎯 抽中 ${list.length} 个：${list.join('、')}`
}

/** 是否为骰子意图（可解析即算）。 */
export function isDiceIntent(text) {
  return parseDice(text) !== null
}

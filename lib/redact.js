/**
 * 防线三：**出站脱敏**（v0.7.9）。
 *
 * 背景：入站有敏感词过滤（`filterEnabled`），但**出站一个字符都不检查** ——
 * 群里有人问"你配置怎么写的"，模型贴出 `sk-…` / `ghp_…` / 整段私钥，就直接进群了。
 * 已有两道防线：注入回合 dry-run（v0.4）、污点窗口（v0.7.4）；这一道补的是"发出去之前"。
 *
 * 设计纪律：
 *   - **只认"确定是密钥"的格式**（sk- 前缀、gh 系列 token、AKIA、xox、JWT、私钥块、Bearer），**不碰** QQ 号、手机号、URL——
 *     机器人本来就要发这些，误伤成本远大于收益；
 *   - **默认关**（守卫类一律默认关，和 `filterEnabled` / `taintDryRunEnabled` 一致）；
 *   - **不许静默**：每次命中都由调用方写 trace，并且**绝不把命中的原文写进 trace**；
 *   - 纯函数，单测直接可测。
 */

/** 内置模式：`id` 用于 trace（不泄露内容），`label` 是给用户看的人话。 */
export const BUILTIN_REDACT_PATTERNS = Object.freeze([
  { id: 'openai-key', label: 'OpenAI 风格密钥（sk-…）', regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'github-token', label: 'GitHub token（gh*_…）', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'aws-key', label: 'AWS Access Key（AKIA…）', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'slack-token', label: 'Slack token（xox…）', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'jwt', label: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: 'bearer', label: 'Authorization: Bearer …', regex: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  {
    id: 'private-key',
    label: '私钥块（PRIVATE KEY）',
    regex: /-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----[\s\S]*?-----END [A-Z ]{0,20}PRIVATE KEY-----/g,
  },
])

/** 自定义句式的上限（和污点窗口的 `taintExtraPatterns` 保持同一口径）。 */
export const REDACT_PATTERN_LIMITS = { maxItems: 20, maxLength: 200 }

/**
 * 把用户填的正则编译成 matcher。坏正则**不静默**：进 `invalid`，由调用方写 trace。
 * 注意：内置模式带 `g` 标志（要批量替换）；自定义模式也加 `g`，但每条只用一次 `replace`。
 */
export function compileRedactPatterns(list) {
  const matchers = []
  const invalid = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw ?? '').trim()
    if (text === '') continue
    if (text.length > REDACT_PATTERN_LIMITS.maxLength) {
      invalid.push({ source: text.slice(0, 40), reason: `太长（${text.length} 字 > ${REDACT_PATTERN_LIMITS.maxLength}）` })
      continue
    }
    if (seen.has(text)) continue
    seen.add(text)
    try {
      matchers.push({ id: 'custom', label: `自定义规则「${text.slice(0, 40)}」`, regex: new RegExp(text, 'gi') })
    } catch (error) {
      invalid.push({ source: text.slice(0, 40), reason: `正则不合法：${error?.message ?? error}` })
    }
    if (matchers.length >= REDACT_PATTERN_LIMITS.maxItems) break
  }
  return { matchers, invalid, count: matchers.length }
}

/** 内置 + 自定义，一次编译好（桥在构造时调一次）。 */
export function buildRedactMatchers(extraPatterns = []) {
  const builtin = BUILTIN_REDACT_PATTERNS.map((pattern) => ({ ...pattern }))
  const custom = compileRedactPatterns(extraPatterns)
  return {
    matchers: [...builtin, ...custom.matchers],
    invalid: custom.invalid,
    builtinCount: builtin.length,
    customCount: custom.count,
  }
}

/**
 * 打码形态：保留前 6 + 后 2（够人认出"这是我那把 key"，但拿不到值）。
 * 太短的值（≤8）整段打掉 —— 短到那种程度没有"认出"的需求。
 */
export function maskSecret(value) {
  const text = String(value ?? '')
  if (text.length <= 8) return '***'
  return `${text.slice(0, 6)}…${text.slice(-2)}（已隐藏 ${text.length} 字符）`
}

/**
 * 对一段出站文本做脱敏。
 * @returns {{ text: string, hits: Array<{ id: string, label: string }>, changed: boolean }}
 *   命中信息只带 **id / label / 次数**，**不带命中的原文**（那是要保护的东西）。
 */
export function redactText(text, matchers = BUILTIN_REDACT_PATTERNS) {
  let result = String(text ?? '')
  const hits = []
  for (const matcher of matchers) {
    const regex = matcher.regex instanceof RegExp ? matcher.regex : null
    if (regex === null) continue
    // 每次用前重置 lastIndex：内置模式是全局正则，复用同一个对象时必须重置，否则会漏命中。
    regex.lastIndex = 0
    let count = 0
    result = result.replace(regex, (match) => {
      count += 1
      return maskSecret(match)
    })
    if (count > 0) hits.push({ id: matcher.id ?? 'custom', label: matcher.label ?? matcher.id ?? '自定义规则', count })
  }
  return { text: result, hits, changed: hits.length > 0 }
}

/** 命中的模式名（给 trace 用的人话，去重保序）。 */
export function describeHits(hits) {
  return hits.map((hit) => `${hit.label}×${hit.count}`).join('、')
}

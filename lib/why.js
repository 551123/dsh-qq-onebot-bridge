/**
 * `/为什么` 的意图识别（v0.6.9）。
 *
 * 为什么单独一个模块：命令解析要能**脱离桥**单测（跟 `isCheckinIntent` / `parseKeywordCommand` 一个路子），
 * 而且这里有一组容易踩的边界（口语别误伤正常聊天），值得把规则钉死。
 *
 * 两种写法都认：
 *   1. **斜杠命令**：`/为什么`、`/为什么 1234567`（带 messageId）；
 *   2. **口语**（v0.6.9 追加，用户「所以为啥还要斜杠啊」）：`为什么没回`、`为啥没回我`、`为什么不回我`…
 *
 * 口语的边界很严格 —— **整句只由这几个词构成**才算（`＾(为什么|为啥)(没|不)回(复)?(我)?[？?！!。]*$`）：
 *   - "为什么没回我消息啊，我等了十分钟" **不匹配**（多了别的词）→ 照常交给模型，不会把聊天吞掉；
 *   - "为什么没回" 匹配 → 走快路径直接查 trace（不烧模型）。
 * 群里本来就要 @ 到机器人才会走到命令层，所以这层识别不会让未 @ 的消息被吞。
 */

/** 口语整句：为什么/为啥 + (没|不) + 回(复) + (我) + 可选标点。 */
const SPOKEN_WHY = /^(?:为什么|为啥)(?:没|不)回(?:复)?(?:我)?[？?！!。]*$/

/** 斜杠命令：`/为什么` 或 `/why`，可带一个消息 id。 */
const SLASH_WHY = /^\/为什么(?:\s+(.*))?$/

/**
 * 这条文本是不是"问我为什么没回"。
 * 返回 `{ hit, arg }`：`arg` 是可能的消息 id（口语永远为空）。
 */
export function parseWhyIntent(rawText) {
  const text = String(rawText ?? '').trim()
  const slash = SLASH_WHY.exec(text)
  if (slash) return { hit: true, arg: String(slash[1] ?? '').trim(), spoken: false }
  if (SPOKEN_WHY.test(text)) return { hit: true, arg: '', spoken: true }
  return { hit: false, arg: '', spoken: false }
}

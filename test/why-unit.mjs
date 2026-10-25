/**
 * v0.6.9 `/为什么` 的单测：把 trace 事件链翻译成人话（`summarizeTrace`）。
 *
 * 为什么单独抽函数：这段逻辑原来写在 `#handleWhy` 里，只有真跑一条消息才能验；
 * 抽出来之后可以直接喂合成的 stage 链，覆盖"被拦 / 一路通过 / 走到模型没回复 / 空链"四种形状。
 */
import { readFileSync } from 'node:fs'
import { summarizeTrace } from '../lib/trace.js'
import { PANEL_GROUPS } from '../lib/panel.js'
import { parseWhyIntent } from '../lib/why.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => JSON.stringify(value).slice(0, 200)

// ---- 被拦：结论必须说出 stage 的中文名 + 原因 ----
const blocked = summarizeTrace([
  { stage: 'inbound', ok: true, ts: 1_700_000_000_000, data: { userId: 1001 } },
  { stage: 'whitelist', ok: true, ts: 1_700_000_000_010 },
  { stage: 'quiet', ok: false, ts: 1_700_000_000_020, reason: '避开高峰期静默中（09:00-12:00）' },
])
check('★被拦断的链：链路用中文 stage 名 + ⛔ 标出失败点',
  blocked.chain === '收到消息✅ → 白名单✅ → 静默时段⛔', blocked.chain)
check('★结论直接给出「卡在哪个环节 + 原因」',
  blocked.ok === false && /卡在「静默时段」/.test(blocked.conclusion) && blocked.conclusion.includes('09:00-12:00'),
  blocked.conclusion)
check('结论带上发送者 id（群里管理员据此判断是谁那条）', blocked.userId === 1001, String(blocked.userId))
check('用时 = 首尾事件的时间差', blocked.durationMs === 20, String(blocked.durationMs))

// ---- 一路通过并回复 ----
const ok = summarizeTrace([
  { stage: 'inbound', ok: true, ts: 1_700_000_001_000, data: { userId: 2002 } },
  { stage: 'whitelist', ok: true, ts: 1_700_000_001_005 },
  { stage: 'agent', ok: true, ts: 1_700_000_003_000 },
  { stage: 'reply', ok: true, ts: 1_700_000_003_100 },
])
check('★正常回复：结论是「一路通过，回复已发出」',
  ok.ok === true && /一路通过，回复已发出/.test(ok.conclusion) && ok.chain.includes('出站回复✅'),
  brief({ chain: ok.chain, conclusion: ok.conclusion }))

// ---- 走到模型但没有出站回复 ----
const noReply = summarizeTrace([
  { stage: 'inbound', ok: true, ts: 1, data: { userId: 3 } },
  { stage: 'agent', ok: true, ts: 2 },
])
check('★进了模型却没回复：结论点明"没看到出站回复"',
  noReply.ok === false === false && /没看到出站回复/.test(noReply.conclusion), noReply.conclusion)

// ---- 没进模型（命令/工具前置分支处理）----
const commandOnly = summarizeTrace([
  { stage: 'inbound', ok: true, ts: 1, data: { userId: 4 } },
  { stage: 'whitelist', ok: true, ts: 2 },
  { stage: 'command', ok: true, ts: 3 },
])
check('★被命令分支处理掉的消息：不会误报"没回复"',
  /前置分支处理/.test(commandOnly.conclusion), commandOnly.conclusion)

// ---- 空链 / 脏数据 ----
check('★空链不抛错，明确说"没有记录"',
  (() => {
    const empty = summarizeTrace([])
    return empty.empty === true && empty.conclusion === '没有记录'
  })())
check('非数组 / 含空事件也不抛',
  (() => {
    try {
      const one = summarizeTrace([null, { stage: '' }, { stage: 'inbound', ok: true, ts: 5 }])
      return one.chain === '收到消息✅'
    } catch { return false }
  })())

// ---- 命令接线：不引用时用"本会话最近一条"，引用时用 messageId ----
const bridgeSource = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
check('★桥里真的接了 `/为什么` 命令（正则 + 处理器 + 帮助里能看到）',
  /parseWhyIntent\(text\)/.test(bridgeSource)
  && bridgeSource.includes('async #handleWhy(message, arg)')
  && bridgeSource.includes('命令 /为什么')
  && bridgeSource.includes('/为什么 查某条消息为什么没回'))
check('★两种定位都在：引用的 messageId 索引 + 本会话最近一条',
  bridgeSource.includes('this.traceIndex.get(String(quoted))')
  && bridgeSource.includes('this.lastTraceOfChat.get(chatKey)'))
check('★群里限管理员（避免拿别人的 QQ 号打听）',
  bridgeSource.includes("只有管理员能查"))
check('★trace 关着时如实说，而不是假装查不到',
  bridgeSource.includes('`traceEnabled=false`'))
check('/为什么 不占面板开关（它是一条命令，不该出现在 77 个键里）',
  PANEL_GROUPS.every((group) => group.rows.every((row) => !String(row.key).includes('why'))))

/**
 * ★ 口语识别（用户 2026-10-25「所以为啥还要斜杠啊」）：
 *   整句匹配才走快路径；**带别的话就不匹配**，免得把正常聊天吞掉。
 */
check('★口语也能查：为什么没回 / 为啥没回我 / 为什么不回我',
  ['为什么没回', '为啥没回我', '为什么不回我', '为什么没回复', '为什么不回我？']
    .every((text) => parseWhyIntent(text).hit === true && parseWhyIntent(text).spoken === true),
  JSON.stringify(['为什么没回', '为啥没回我', '为什么不回我'].map(parseWhyIntent)))
check('★口语边界：带别的话不匹配（不能把正常聊天吞掉）',
  ['为什么没回我消息啊，我等了十分钟', '为什么', '为什么不回我消息呢', '为什么没回，是不是挂了']
    .every((text) => parseWhyIntent(text).hit === false),
  JSON.stringify(['为什么没回我消息啊，我等了十分钟', '为什么没回，是不是挂了'].map(parseWhyIntent)))
check('斜杠命令仍然带 messageId（引用那条 + 显式 id 两条路都在）',
  parseWhyIntent('/为什么 1234567').arg === '1234567'
  && parseWhyIntent('/为什么').arg === ''
  && parseWhyIntent('/为什么').spoken === false)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

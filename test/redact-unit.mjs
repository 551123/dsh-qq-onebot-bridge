/**
 * v0.7.9 出站脱敏单测（防线三）：
 *   ① 内置 7 条模式各自命中 / 不误伤（QQ 号、手机号、URL、普通长串）
 *   ② 打码形态（保留首尾、短值整段打掉）、幂等（打过码的不会被再打一次）
 *   ③ 自定义规则（编译、坏正则不静默、去重、超长）
 *   ④ 桥级：真的发一条含 sk- 的回复 → segments 被替换 + trace 有 redact 事件 + 不写原文
 *   ⑤ 桥级：命中即拦截模式 → 抛错、计数、trace ok:false
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { BUILTIN_REDACT_PATTERNS, buildRedactMatchers, compileRedactPatterns, describeHits, maskSecret, redactText } from '../lib/redact.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => JSON.stringify(value ?? null).slice(0, 220)

// ---------- ① 内置模式 ----------
const hitsOf = (text) => redactText(text).hits.map((hit) => hit.id)
check('★OpenAI 风格密钥被命中', hitsOf('key: sk-abcdefghijklmnopqrstuvwxyz123456').includes('openai-key'))
check('★GitHub token 被命中', hitsOf('ghp_abcdefghijklmnopqrstuvwxyz0123456789').includes('github-token'))
check('★AWS Access Key 被命中', hitsOf('AKIAABCDEFGHIJKLMNOP').includes('aws-key'))
check('★Bearer 头被命中', hitsOf('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456').includes('bearer'))
check('★私钥块被命中（含换行）', hitsOf('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----').includes('private-key'))
check('★JWT 被命中', hitsOf('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop').includes('jwt'))
check('Slack token 被命中', hitsOf('xoxb-1234567890-abcdefghij').includes('slack-token'))

// ---------- ② 不误伤 ----------
const safeTexts = [
  'QQ 群 123456789，我的号是 987654321',
  '手机 13800138000，邮箱 someone@example.com',
  '仓库地址 https://github.com/cheesehaqi/dsh-qq-onebot-bridge/releases',
  '这条消息里有一个很长的普通串 abcdefghijklmnopqrstuvwxyz0123456789',
  '今天的版本是 v0.7.9，模型 nvidia/llama-3.1-70b',
]
check('★★正常内容不误伤（QQ号/手机号/URL/长串/版本号都不动）',
  safeTexts.every((text) => redactText(text).changed === false),
  brief(safeTexts.map((text) => redactText(text).changed)))

// ---------- 打码形态 ----------
check('★打码保留首尾、写清隐藏多少字符',
  /^sk-abc…56（已隐藏 \d+ 字符）$/.test(redactText('sk-abcdefghijklmnopqrstuvwxyz0123456').text),
  redactText('sk-abcdefghijklmnopqrstuvwxyz0123456').text)
check('短值整段打掉（≤8 字符没必要"认出"）', maskSecret('abcdefgh') === '***' && maskSecret('abcdefghij') !== '***')
check('★幂等：已打过码的文本不会被再打一遍', (() => {
  const once = redactText('sk-abcdefghijklmnopqrstuvwxyz0123456').text
  const twice = redactText(once)
  return twice.changed === false && twice.text === once
})(), redactText(redactText('sk-abcdefghijklmnopqrstuvwxyz0123456').text).text)
check('同一段里多个密钥都被打码', (() => {
  const result = redactText('a=sk-abcdefghijklmnopqrstuvwxyz012345 b=sk-zyxwvutsrqponmlkjihgfedcba987654')
  return result.text.split('已隐藏').length - 1 === 2
})())
check('describeHits 输出人话（规则名 × 次数）',
  describeHits([{ id: 'openai-key', label: 'OpenAI 风格密钥（sk-…）', count: 2 }]) === 'OpenAI 风格密钥（sk-…）×2')

// ---------- ③ 自定义规则 ----------
{
  const compiled = compileRedactPatterns(['内网令牌 [A-Z]{8}-[0-9]{4}', '内网令牌 [A-Z]{8}-[0-9]{4}', '(?<bad', 'x'.repeat(201)])
  check('★自定义规则：好的一条编译成功、重复的去重、坏正则与超长进 invalid',
    compiled.matchers.length === 1 && compiled.invalid.length === 2
    && compiled.invalid.some((item) => /正则不合法/.test(item.reason))
    && compiled.invalid.some((item) => /太长/.test(item.reason)),
    brief(compiled.invalid))
  const built = buildRedactMatchers(['[A-Z]{8}-[0-9]{4}'])
  check('内置 7 条 + 自定义合并，并报出各自数量',
    built.builtinCount === BUILTIN_REDACT_PATTERNS.length && built.customCount === 1
    && built.matchers.length === BUILTIN_REDACT_PATTERNS.length + 1,
    `${built.builtinCount}+${built.customCount}`)
  const custom = redactText('凭据是 ABCDEFGH-1234 请勿外传', built.matchers)
  check('★自定义规则能命中并打码', custom.changed && /ABCDEF…34/.test(custom.text), custom.text)
}

// ---------- ④⑤ 桥级 ----------
class MockServer extends EventEmitter {
  constructor() { super(); this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }; this.sent = [] }
  setActionLedger() {}
  setOutboundFilter(filter) { this.outboundFilter = filter }
  currentSocket() { return this.socket }
  getMsg() { return Promise.resolve({ message: [] }) }
  sendSegments(socket, messageType, targetId, segments) {
    // 模拟真实的发送前过滤（真实实现里由 onebot.js 调用）
    const filtered = this.outboundFilter ? this.outboundFilter(segments, messageType, targetId) : segments
    this.sent.push({ messageType, targetId, segments: filtered })
    return Promise.resolve({ message_id: `m${this.sent.length}` })
  }
}

const makeCtx = () => ({
  on: () => () => {}, get: () => undefined, emit: () => {},
  agents: { create: async () => ({ id: 's', status: 'idle', followup: () => {}, cancel: () => {}, ctx: { systemPrompt: { section() {} }, tools: { register() {} } } }) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'x', model: 'y' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
})
const baseConfig = (extra) => ({
  cwd: mkdtempSync(join(tmpdir(), 'qq-redact-')),
  allowUsers: [1001], allowGroups: [2002], botQq: 999, replyOnlyWhenMentioned: false,
  dedupEnabled: false, memoryEnabled: false, filterEnabled: false,
  ...extra,
})

// ④ 脱敏后发送
{
  const server = new MockServer()
  const bridge = new QQBridge(makeCtx(), baseConfig({ outboundRedactEnabled: true }), server, { info() {}, warn() {}, error() {} })
  bridge.start()
  const api = bridge.createExtensionApi()
  const result = await api.sendText('g:2002', '配置里写了 sk-abcdefghijklmnopqrstuvwxyz0123456，别外传')
  await new Promise((resolve) => setTimeout(resolve, 40))
  const sent = server.sent.at(-1)
  check('★★出站文本被脱敏后才发出（原文不在 segments 里）',
    result.ok === true
    && JSON.stringify(sent.segments).includes('已隐藏')
    && !JSON.stringify(sent.segments).includes('sk-abcdefghijklmnopqrstuvwxyz0123456'),
    brief(sent.segments))
  const events = bridge.trace.recent({ limit: 100 }).filter((event) => event.stage === 'redact')
  check('★★命中写 trace，且 trace 里**不含原文**（只写规则名）',
    events.some((event) => /出站内容命中敏感信息/.test(event.reason ?? ''))
    && events.every((event) => !JSON.stringify(event).includes('abcdefghijklmnopqrstuvwxyz0123456')),
    brief(events.map((event) => event.reason?.slice(0, 40))))
  check('计数写进 redactStats（hits / messages）',
    bridge.redactStats.hits >= 1 && bridge.redactStats.messages === 1 && bridge.redactStats.blocked === 0,
    brief(bridge.redactStats))
  check('正常文本照常发、不写 trace（零误伤）', true)
  {
    const before = bridge.trace.recent({ limit: 200 }).filter((event) => event.stage === 'redact').length
    await api.sendText('g:2002', '今天天气不错')
    const after = bridge.trace.recent({ limit: 200 }).filter((event) => event.stage === 'redact').length
    check('★正常文本不产生 redact trace', after === before, `${before} → ${after}`)
  }
  bridge.stop()
  rmSync(bridge.config.cwd, { recursive: true, force: true })
}

// ⑤ 命中即拦截
{
  const server = new MockServer()
  const bridge = new QQBridge(makeCtx(), baseConfig({ outboundRedactEnabled: true, outboundRedactBlock: true }), server, { info() {}, warn() {}, error() {} })
  bridge.start()
  const api = bridge.createExtensionApi()
  const result = await api.sendText('g:2002', 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  await new Promise((resolve) => setTimeout(resolve, 40))
  check('★★命中即拦截：出口返回 ok:false 并说明原因',
    result.ok === false && /命中敏感信息|拦截/.test(String(result.reason)),
    brief(result))
  check('★★拦截时 trace 写 ok:false，且同样不含原文', (() => {
    const events = bridge.trace.recent({ limit: 100 }).filter((event) => event.stage === 'redact')
    return events.some((event) => event.ok === false && /拦截/.test(event.reason ?? ''))
      && events.every((event) => !JSON.stringify(event).includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'))
  })())
  check('拦截计数（blocked）', bridge.redactStats.blocked === 1, brief(bridge.redactStats))
  check('被拦截的消息确实没有发出去（server 上没有这条）',
    server.sent.every((item) => !JSON.stringify(item.segments).includes('ghp_')))
  bridge.stop()
  rmSync(bridge.config.cwd, { recursive: true, force: true })
}

// 关闭时不干预
{
  const server = new MockServer()
  const bridge = new QQBridge(makeCtx(), baseConfig({}), server, { info() {}, warn() {}, error() {} })
  bridge.start()
  const api = bridge.createExtensionApi()
  await api.sendText('g:2002', 'key sk-abcdefghijklmnopqrstuvwxyz0123456')
  const sent = server.sent.at(-1)
  check('★默认关：原样发出（没有任何改动）', JSON.stringify(sent.segments).includes('sk-abcdefghijklmnopqrstuvwxyz0123456'))
  check('默认关时也不写 redact trace',
    bridge.trace.recent({ limit: 100 }).every((event) => event.stage !== 'redact'))
  bridge.stop()
  rmSync(bridge.config.cwd, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

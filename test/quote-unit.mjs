/**
 * v0.6.9「回复带引用」的单测。
 *
 * 两件事一起验：
 *  ① 纯函数 `quoteSegmentFor()` 的取舍（开关 / 注入回放 / 没有 messageId）；
 *  ② 真的发出去时引用段挂在**第一批**前面，并且**引用失败会自动去掉引用重发一次**。
 *
 * 用 MockServer 驱动真实 QQBridge，不碰网络、不建模型会话。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { quoteSegmentFor } from '../lib/send.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
    /** 让下一次带 reply 段的发送失败（模拟 message_id 过期 / 被撤回）。 */
    this.failOnQuote = false
  }

  sendSegments(_bot, messageType, targetId, segments) {
    const hasQuote = segments.some((segment) => segment.type === 'reply')
    if (hasQuote && this.failOnQuote === true) {
      this.failOnQuote = false
      return Promise.reject(new Error('retcode 1200: 消息不存在或已过期'))
    }
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: this.sent.length })
  }

  currentSocket() { return this.socket }
  uploadFile() { return Promise.resolve({}) }
  sendForwardMsg() { return Promise.resolve({ message_id: 9999 }) }
  getMsg() { return Promise.resolve({ message: [] }) }
}

// ---- ① 纯函数的取舍 ----
const msg = { messageId: 'm-42', messageType: 'group' }
check('★开关关着 ⇒ 不挂引用', quoteSegmentFor(msg, {}) === null)
check('★开关打开 ⇒ 挂 reply 段（id 一律转字符串）',
  JSON.stringify(quoteSegmentFor(msg, { quoteReplyEnabled: true })) === JSON.stringify({ type: 'reply', data: { id: 'm-42' } }),
  JSON.stringify(quoteSegmentFor(msg, { quoteReplyEnabled: true })))
check('注入/回放的帧不挂（假 message_id 引用会失败）',
  quoteSegmentFor({ ...msg, __injected: true }, { quoteReplyEnabled: true }) === null
  && quoteSegmentFor({ ...msg, __replayed: true }, { quoteReplyEnabled: true }) === null)
check('没有 messageId 的消息不挂（notice / 定时任务触发的回复）',
  quoteSegmentFor({ messageType: 'group' }, { quoteReplyEnabled: true }) === null
  && quoteSegmentFor({ messageId: '' }, { quoteReplyEnabled: true }) === null)

// ---- ② 真发：引用段在第一批，且失败会降级 ----
const dir = mkdtempSync(join(tmpdir(), 'qq-quote-test-'))
writeFileSync(join(dir, 'qq-badwords.txt'), '广告\n', 'utf8')

const config = {
  cwd: dir,
  host: '127.0.0.1',
  port: 0,
  allowUsers: [1001],
  allowGroups: [2002],
  botQq: 999,
  botName: '小鲸鱼',
  replyOnlyWhenMentioned: true,
  acceptPrivate: true,
  quoteReplyEnabled: true,
  sessionMode: 'chat',
  maxMessageLength: 1700,
  dedupEnabled: true,
  dedupWindowSeconds: 300,
  memoryEnabled: false,
  reminderEnabled: false,
  adminEnabled: true,
  adminUsers: [1001],
  voteEnabled: false,
  todoEnabled: false,
  summaryEnabled: false,
  exportEnabled: false,
  checkinEnabled: false,
  quietHoursEnabled: false,
  imageGenEnabled: false,
  ttsEnabled: false,
  sttEnabled: false,
  sessionResumeEnabled: false,
  agentMediaToolsEnabled: false,
  actionAuditEnabled: false,
  keywordEnabled: false,
  fortuneEnabled: false,
  diceEnabled: false,
  pointsEnabled: false,
  gameEnabled: false,
  pokeEnabled: false,
  welcomeEnabled: false,
  antiRecallEnabled: false,
  filterEnabled: false,
  floodEnabled: false,
  fileSendDirs: [],
  fileSendMaxBytes: 52428800,
  imageSendMaxBytes: 4194304,
  recallWindowSeconds: 110,
  forwardLongReplies: false,
  actionRatePerMinute: 60,
  actionRatePerDay: 1000,
  rateLimitEnabled: false,
}

/** `session/event` 的处理器抓下来：模型回答那条出站路径只能从这里进。 */
const sessionHandlers = []
const ctx = {
  on: (name, handler) => {
    if (name === 'session/event') sessionHandlers.push(handler)
    return () => {}
  },
  get: () => undefined,
  emit: () => {},
  agents: { create: async () => { throw new Error('agent 不应在引用测试里被创建') } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}

const server = new MockServer()
const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
bridge.start()

async function send(text, extra = {}) {
  const before = server.sent.length
  // 默认发**群消息**：引用只在群里生效（私聊是一对一，引用没意义）。
  server.emit('message', {
    bot: server.socket,
    userId: 1001,
    messageType: 'group',
    groupId: 2002,
    text,
    atMe: true,
    ats: [],
    reply: null,
    records: [],
    images: [],
    files: [],
    messageId: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    senderName: '测试',
    raw: { message: [] },
    ...extra,
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  return server.sent.slice(before)
}

const first = await send('/help')
const quoted = first[0]?.segments?.[0]
check('★开关打开时，真的回复带上了 reply 段（且是第一批的第一个 segment）',
  quoted?.type === 'reply' && typeof quoted.data?.id === 'string' && quoted.data.id.startsWith('m-'),
  JSON.stringify(quoted))
check('引用段之后紧跟着正文（引用不能吃掉内容）',
  first[0]?.segments?.some((segment) => segment.type === 'text' && segment.data.text.includes('小鲸鱼')) === true,
  JSON.stringify(first[0]?.segments?.map((s) => s.type)))

// 引用失败 → 去掉引用重发一次（消息不丢）
server.failOnQuote = true
const retried = await send('/help')
check('★引用发送失败时自动去掉引用重发，回复不丢',
  retried.length >= 1
  && retried[0].segments.every((segment) => segment.type !== 'reply')
  && retried[0].segments.some((segment) => segment.type === 'text'),
  `sent=${retried.length} types=${JSON.stringify(retried[0]?.segments?.map((s) => s.type))}`)

// 开关关掉 → 不再引用
config.quoteReplyEnabled = false
const plain = await send('/help')
check('★开关关掉后不再挂引用（默认行为不变）',
  plain.length >= 1 && plain[0].segments.every((segment) => segment.type !== 'reply'),
  JSON.stringify(plain[0]?.segments?.map((s) => s.type)))

/**
 * ★ 只在群里引用（开关说明里"单人聊天显得啰嗦"就是这条）：私聊即使开着也不挂引用段。
 */
config.quoteReplyEnabled = true
const privateReply = await send('/help', { messageType: 'private', groupId: 0, atMe: false })
check('★私聊不挂引用（一对一没意义，只有群里才挂）',
  privateReply.length >= 1 && privateReply[0].segments.every((segment) => segment.type !== 'reply'),
  JSON.stringify(privateReply[0]?.segments?.map((s) => s.type)))

/**
 * ★★ 真机回归（2026-10-25「这也没引用啊」）：**模型回答**走的是
 * `#onSessionEvent` → `assistant/message` → `#replyTo`，**不是** `#reply`。
 * 我第一版只给命令路径挂了引用，于是"开关开着、普通聊天却永远不引用"。
 * 这里直接驱动那条路径，确认它也会带 reply 段。
 */
config.quoteReplyEnabled = true
const modelTraceId = 't-model-1'
const modelMessageId = 'm-model-1'
bridge.traceMessageId.set(modelTraceId, modelMessageId)
bridge.agents.set('qq-quotetest', {
  key: 'g:2002',
  sessionId: 'qq-quotetest',
  route: { bot: server.socket, messageType: 'group', targetId: 2002 },
  lastTraceId: modelTraceId,
  pendingTurns: [],
  turnActive: true,
  currentTurnInjected: false,
  turnSuppressedReply: false,
})
const beforeModel = server.sent.length
for (const handler of sessionHandlers) {
  handler({ id: 'qq-quotetest' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '模型回答' }] } } })
}
await new Promise((resolve) => setTimeout(resolve, 60))
const modelSent = server.sent.slice(beforeModel)
check('★★模型回答也带引用（命令路径之外的那条出站路径）',
  modelSent.length === 1
  && modelSent[0].segments[0]?.type === 'reply'
  && modelSent[0].segments[0]?.data?.id === modelMessageId
  && modelSent[0].segments.some((segment) => segment.type === 'text' && segment.data.text === '模型回答'),
  JSON.stringify(modelSent[0]?.segments?.map((s) => `${s.type}${s.data?.id ? `:${s.data.id}` : ''}`)))

config.quoteReplyEnabled = false
bridge.traceMessageId.set(modelTraceId, modelMessageId)
const beforeModelOff = server.sent.length
for (const handler of sessionHandlers) {
  handler({ id: 'qq-quotetest' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '关掉后的模型回答' }] } } })
}
await new Promise((resolve) => setTimeout(resolve, 60))
const modelOff = server.sent.slice(beforeModelOff)
check('模型回答同样受开关控制（关掉就不挂引用）',
  modelOff.length === 1 && modelOff[0].segments.every((segment) => segment.type !== 'reply'),
  JSON.stringify(modelOff[0]?.segments?.map((s) => s.type)))

bridge.stop()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

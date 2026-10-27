/**
 * v0.7.0「实验性与扩展」的单测：
 *   ① 实例出口 `ctx.qqBridge`（受控发送 + 目标白名单 + 只读快照 + 密钥抹除）
 *   ② 只读事件 `qqbridge:inbound` / `qqbridge:outbound`（不可改写、监听器抛错隔离）
 *   ③ **实验性**工具 provider 链（默认关；只增不覆盖；抛错跳过；provider 名进 trace）
 *
 * 用 MockServer 驱动真实 QQBridge —— 不碰网络、不建模型会话。
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_TOOL_NAMES, QQBridge } from '../lib/bridge.js'
import {
  EXTENSION_EVENTS, EXTENSION_SERVICE, PROVIDER_LIMITS, attachExtensionService, collectProviderAdditions,
  getExtensionApi, redactConfig,
} from '../lib/extension.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => JSON.stringify(value ?? null).slice(0, 200)

class MockServer extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }
  }

  sendSegments(_bot, messageType, targetId, segments) {
    this.sent.push({ messageType, targetId, segments })
    return Promise.resolve({ message_id: this.sent.length })
  }

  currentSocket() { return this.socket }
  uploadFile() { return Promise.resolve({}) }
  sendForwardMsg() { return Promise.resolve({ message_id: 9999 }) }
  getMsg() { return Promise.resolve({ message: [] }) }
  /** 撤回（`#recallRecent` 用）。 */
  deleteMsg(_socket, messageId) {
    this.recalled = this.recalled ?? []
    this.recalled.push(messageId)
    return Promise.resolve({})
  }

  /** 贴表情（`qq_react` / 出口的 react 用）。 */
  setMsgEmojiLike(_socket, messageId, emojiId, groupId) {
    this.reactions = this.reactions ?? []
    this.reactions.push({ messageId, emojiId, groupId })
    return Promise.resolve({ ok: true })
  }
}

const dir = mkdtempSync(join(tmpdir(), 'qq-ext-test-'))
writeFileSync(join(dir, 'qq-badwords.txt'), '广告\n', 'utf8')

const config = {
  cwd: dir, host: '127.0.0.1', port: 0,
  allowUsers: [1001], allowGroups: [2002], botQq: 999, botName: '小鲸鱼',
  replyOnlyWhenMentioned: true, acceptPrivate: true, quoteReplyEnabled: false,
  sessionMode: 'chat', maxMessageLength: 1700,
  dedupEnabled: true, dedupWindowSeconds: 300,
  memoryEnabled: false, reminderEnabled: false, adminEnabled: true, adminUsers: [1001],
  voteEnabled: false, todoEnabled: false, summaryEnabled: false, exportEnabled: false,
  checkinEnabled: false, quietHoursEnabled: false, imageGenEnabled: false,
  ttsEnabled: false, sttEnabled: false, sessionResumeEnabled: false,
  agentMediaToolsEnabled: false, actionAuditEnabled: false, keywordEnabled: false,
  fortuneEnabled: false, diceEnabled: false, pointsEnabled: false, gameEnabled: false,
  pokeEnabled: false, welcomeEnabled: false, antiRecallEnabled: false,
  filterEnabled: false, floodEnabled: false,
  fileSendDirs: [], fileSendMaxBytes: 52428800, imageSendMaxBytes: 4194304,
  recallWindowSeconds: 110, forwardLongReplies: false,
  actionRatePerMinute: 60, actionRatePerDay: 1000,
  rateLimitEnabled: false, rateLimitMaxReplies: 10, rateLimitWindowSeconds: 60,
  extensionToolsEnabled: false,
  // 密钥类：出口的 config() 必须抹掉
  accessToken: 'super-secret-token-should-never-leak',
  ttsApiKey: 'sk-should-never-leak',
}

const emitted = []
const ctx = {
  on: () => () => {},
  get: () => undefined,
  emit: (name, payload) => { emitted.push({ name, payload }) },
  agents: { create: async () => { throw new Error('agent 不应在扩展测试里被创建') } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
}

const server = new MockServer()
const bridge = new QQBridge(ctx, config, server, { info() {}, warn() {}, error() {} })
bridge.start()
const api = bridge.createExtensionApi()

// ---- ① 出口形状 ----
check('★出口对象形状稳定：版本/事件名/四个发送器/三个快照/on/provider 注册',
  api.version === 1
  && api.events.inbound === 'qqbridge:inbound' && api.events.outbound === 'qqbridge:outbound'
  && ['sendText', 'sendImage', 'sendFile', 'sendVoice'].every((name) => typeof api[name] === 'function')
  && ['sessions', 'agents', 'config', 'on', 'registerToolProvider', 'toolProviders'].every((name) => typeof api[name] === 'function'),
  brief(Object.keys(api)))
check('同一个桥只建一次出口（身份稳定）', bridge.createExtensionApi() === api)
/**
 * ★ v0.7.5（issue #4 作者要求）：`api.instanceId` —— 每个桥实例一个随机串。
 *   他原来靠 `toolProviders()` 前缀 + 5 秒轮询猜"出口换人了没"，热重载窗口会误判、也会漏掉快速切换。
 *   有了 id 直接比；同一实例稳定，不同实例必须不同。
 */
check('★出口带 instanceId：同一实例稳定，且与 extensionReport 一致',
  typeof api.instanceId === 'string' && api.instanceId.length >= 8
  && bridge.createExtensionApi().instanceId === api.instanceId
  && bridge.extensionReport().instanceId === api.instanceId,
  String(api.instanceId))
check('★不同桥实例的 instanceId 不同（宿主重建后据此重挂）',
  (() => {
    const other = new QQBridge(ctx, config, new MockServer(), { info() {}, warn() {}, error() {} })
    const otherId = other.createExtensionApi().instanceId
    other.stop()
    return typeof otherId === 'string' && otherId !== api.instanceId
  })())

// ---- ② 入站事件 ----
const inbound = []
api.on('inbound', (payload) => inbound.push(payload))
let seq = 0
function message(text, extra = {}) {
  return {
    bot: server.socket, userId: 1001, messageType: 'private', groupId: 0, text,
    atMe: false, ats: [], reply: null, records: [], images: [], files: [],
    messageId: `e${++seq}`, senderName: '测试', raw: { message: [] }, ...extra,
  }
}
async function send(payload) {
  server.emit('message', payload)
  await new Promise((resolve) => setTimeout(resolve, 40))
}

await send(message('/help'))
check('★入站事件带 chatKey / 归一化文本 / 来源标记',
  inbound.length === 1 && inbound[0].chatKey === 'u:1001' && inbound[0].text === '/help'
  && inbound[0].injected === false && typeof inbound[0].at === 'number',
  brief(inbound[0]))
check('★入站事件同时派发到宿主事件总线（ctx.emit）',
  emitted.some((item) => item.name === EXTENSION_EVENTS.inbound && item.payload.chatKey === 'u:1001'))

const beforeOutsider = inbound.length
await send(message('/help', { userId: 5555, messageId: 'e-outsider' }))
check('★白名单外的消息不派发入站事件（监听≠绕过门禁）', inbound.length === beforeOutsider)

// ---- ③ 出站事件 + 受控发送 ----
const outbound = []
api.on('outbound', (payload) => outbound.push(payload))
const sentBefore = server.sent.length
const okSend = await api.sendText('u:1001', '扩展口发的话')
check('★sendText 真的发出并回 { ok: true }',
  okSend.ok === true && server.sent.length === sentBefore + 1
  && server.sent[server.sent.length - 1].segments.map((segment) => segment.data?.text ?? '').join('') === '扩展口发的话',
  brief(okSend))
check('★出站事件带 kind/text/chatKey',
  outbound.length === 1 && outbound[0].kind === 'text' && outbound[0].text === '扩展口发的话' && outbound[0].chatKey === 'u:1001',
  brief(outbound[0]))
check('★出站事件也派发到宿主事件总线', emitted.some((item) => item.name === EXTENSION_EVENTS.outbound))

// 非法 chatKey / 目标白名单
const badKey = await api.sendText('hello', 'x')
check('★非法 chatKey 回 ok:false 并说清格式（不抛）', badKey.ok === false && /chatKey/.test(badKey.reason), brief(badKey))
const outsider = await api.sendText('u:7777', '名单外')
check('★出口拒绝给名单外的私聊对象发消息', outsider.ok === false && /allowUsers/.test(outsider.reason), brief(outsider))
const outsiderGroup = await api.sendText('g:8888', '名单外的群')
check('★出口拒绝往 allowGroups 之外的群发话', outsiderGroup.ok === false && /allowGroups/.test(outsiderGroup.reason), brief(outsiderGroup))
config.allowAllChats = true
const openGroup = await api.sendText('g:8888', '开了回应所有人就允许')
config.allowAllChats = false
check('★「回应所有人」打开时出口不再按名单拦目标', openGroup.ok === true, brief(openGroup))

// 复用出站限流
config.rateLimitEnabled = true
config.rateLimitMaxReplies = 1
config.rateLimitWindowSeconds = 60
await api.sendText('u:1001', '第一条')
const limited = await api.sendText('u:1001', '第二条')
check('★出口发送走原有出站限流（超限回 ok:false，不是旁路）', limited.ok === false && /拦下/.test(limited.reason), brief(limited))
config.rateLimitEnabled = false

// 监听器抛错不影响主流程
api.on('outbound', () => { throw new Error('第三方炸了') })
api.on('outbound', () => Promise.reject(new Error('第三方异步炸了')))
const afterThrow = await api.sendText('u:1001', '监听器抛错也要发出去')
check('★监听器同步抛错/异步 reject：消息照发', afterThrow.ok === true)

// 快照
const snapshot = api.config()
check('★config() 抹掉密钥类键', snapshot.accessToken === undefined && snapshot.ttsApiKey === undefined && snapshot.port === 0, brief(Object.keys(snapshot)))
snapshot.allowUsers.push(6666)
check('★config() 返回的数组是副本', api.config().allowUsers.length === 1)
const sessionsSnapshot = api.sessions()
sessionsSnapshot.push({ chatKey: 'fake' })
check('★sessions()/agents() 返回副本', api.sessions().every((item) => item.chatKey !== 'fake') && Array.isArray(api.agents()))

// ---- ④ 实验性工具 provider 链 ----
check('★默认关：provider 登记了也不会注入（会话注入只在 extensionToolsEnabled 时发生）',
  config.extensionToolsEnabled === false
  && readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8').includes('if (this.config.extensionToolsEnabled === true) this.#installProviderTools(agentCtx, route, key)'))

/**
 * ★ 出口的 recall / react / workspaceRoot（v0.7.0 补完 issue #4 点的三处）：
 *   都要走原有实现（`#recallRecent` / `set_msg_emoji_like` 过 ActionGate）+ 目标白名单 + trace。
 */
check('★出口带 workspaceRoot（只读，等于配置里的 cwd）',
  api.workspaceRoot === dir, String(api.workspaceRoot))

const beforeRecall = server.recalled?.length ?? 0
await api.sendText('u:1001', '这条待会儿撤回')
const recalled = await api.recall('u:1001', 1)
check('★出口 recall：撤回自己刚发的消息（走 #recallRecent，一次一条）',
  recalled.ok === true && recalled.recalled === 1
  && (server.recalled?.length ?? 0) === beforeRecall + 1,
  brief(recalled))
const recallOutsider = await api.recall('u:7777', 1)
check('★出口 recall 也受目标白名单限制', recallOutsider.ok === false && /allowUsers/.test(recallOutsider.reason), brief(recallOutsider))
// 换一个从没发过消息的会话（g:2002 在白名单里），确认"没东西可撤"是如实报错而不是静默成功。
const recallNothing = await api.recall('g:2002', 1)
check('recall 没有可撤回的消息时如实说（不是静默成功）',
  recallNothing.ok === false && /没有可撤回/.test(recallNothing.reason), brief(recallNothing))

const reacted = await api.react('u:1001', 'msg-777', 128077)
check('★出口 react：给指定消息贴表情（走 set_msg_emoji_like）',
  reacted.ok === true && reacted.messageId === 'msg-777' && reacted.emojiId === 128077
  && (server.reactions ?? []).some((item) => item.messageId === 'msg-777'),
  brief(reacted))
const reactNoId = await api.react('u:1001', '', 128077)
check('react 没给消息 id 且会话没收到过消息时，明确报错而不是瞎贴',
  reactNoId.ok === false && /没有可回应/.test(reactNoId.reason), brief(reactNoId))
const reactOutsider = await api.react('g:8888', 'msg-1', 128077)
check('★出口 react 也受目标白名单限制', reactOutsider.ok === false && /allowGroups/.test(reactOutsider.reason), brief(reactOutsider))

/** provider 的**超时**保护：异步 provider 直接拒绝；整轮调用有时间预算。 */
const asyncProvider = collectProviderAdditions({
  providers: [{ name: 'asyncOne', fn: () => Promise.resolve({ tools: [{ name: 'ext_async' }] }) }],
  builtinNames: [],
})
check('★异步 provider 被拒绝（会话 setup 是同步链路，await 会拖住消息）',
  asyncProvider.tools.length === 0
  && asyncProvider.skipped.some((item) => item.provider === 'asyncOne' && /Promise/.test(item.reason)),
  brief(asyncProvider.skipped))
const budget = collectProviderAdditions({
  providers: [
    { name: 'first', fn: () => ({ tools: [{ name: 'ext_first' }] }) },
    { name: 'second', fn: () => ({ tools: [{ name: 'ext_second' }] }) },
  ],
  builtinNames: [],
  budgetMs: 100,
  // 第一次调用记 0（预算从第一个 provider 开始算），之后每次 +150ms ⇒ 第二个必然超预算。
  now: (() => { let t = 0; let firstCall = true; return () => { if (firstCall) { firstCall = false; return 0 } t += 150; return t } })(),
})
check('★provider 时间预算用尽后不再调用后面的 provider（并写明原因）',
  budget.tools.map((tool) => tool.name).join(',') === 'ext_first'
  && budget.skipped.some((item) => /时间预算用尽/.test(item.reason)),
  brief({ tools: budget.tools.map((t) => t.name), skipped: budget.skipped }))

const fakeTool = (name) => ({ name })
const collected = collectProviderAdditions({
  providers: [
    { name: 'good', fn: () => ({ tools: [fakeTool('ext_a'), fakeTool('qq_face_list')], sections: [{ text: 'hi', order: 150 }] }) },
    { name: 'boom', fn: () => { throw new Error('kaboom') } },
    { name: 'junk', fn: () => 42 },
    { name: 'empty', fn: () => ({ tools: [], sections: [] }) },
  ],
  builtinNames: BUILTIN_TOOL_NAMES,
})
check('★provider 链：正常贡献被收下，撞内置名的被跳过',
  collected.tools.map((tool) => tool.name).join(',') === 'ext_a'
  && collected.sections.length === 1 && collected.sections[0].name.startsWith('ext:good:'),
  brief({ tools: collected.tools.map((t) => t.name), sections: collected.sections }))
check('★provider 链：抛错/返回垃圾都被跳过且写明原因（不许静默）',
  collected.skipped.some((item) => item.provider === 'boom' && /抛错/.test(item.reason))
  && collected.skipped.some((item) => item.provider === 'junk' && /没有返回对象/.test(item.reason))
  && collected.skipped.some((item) => item.provider === 'good' && /冲突/.test(item.reason)),
  brief(collected.skipped))
check('provider 名与贡献条数进 notes（给 trace 用）',
  collected.notes.some((note) => /provider「good」注册了 1 个工具 \/ 1 段提示/.test(note))
  && collected.notes.some((note) => /provider「empty」没有贡献/.test(note)),
  brief(collected.notes))
/**
 * ★★ v0.7.5（他踩的坑）：provider 里 `catch { return { tools: [], sections: [], reason } }` ——
 *   我们原来只读 tools/sections，`reason` 被扔掉，于是"包挂了"表现为"注册成功但零工具"，比抛错难查。
 *   现在：① 返回里的 `reason` 记进 notes；② 抛错时带上调用栈首帧（哪个文件哪一行）。
 */
check('★★provider 返回里的 reason 会被记进 notes（不再静默零工具）',
  (() => {
    const out = collectProviderAdditions({
      providers: [{ name: 'hut', fn: () => ({ tools: [], sections: [], reason: '小屋目录没配置' }) }],
      builtinNames: BUILTIN_TOOL_NAMES,
    })
    return out.notes.some((note) => /provider「hut」报告：小屋目录没配置/.test(note))
  })())
check('★★provider 抛错时记下调用栈首帧（能看出哪个文件炸的）',
  (() => {
    const out = collectProviderAdditions({
      providers: [{
        name: 'bomb',
        fn: () => {
          const error = new Error('body 炸了')
          error.stack = 'Error: body 炸了\n    at provider (/repo/ext/qq-ext-x/body.mjs:42:9)\n    at collect (node:internal/x:1:1)'
          throw error
        },
      }],
      builtinNames: BUILTIN_TOOL_NAMES,
    })
    const item = out.skipped.find((entry) => entry.provider === 'bomb')
    return item !== undefined && /body\.mjs:42/.test(item.where ?? '') && !/node:internal/.test(item.where ?? '')
  })())

// 上限：一个 provider 塞太多工具会被截断
const many = collectProviderAdditions({
  providers: [{ name: 'spam', fn: () => ({ tools: Array.from({ length: 40 }, (unused, i) => fakeTool(`spam_${i}`)) }) }],
  builtinNames: BUILTIN_TOOL_NAMES,
})
check('★provider 链有条数上限（防塞爆提示词），且上限来自 PROVIDER_LIMITS',
  many.tools.length === PROVIDER_LIMITS.toolsPerProvider, `${many.tools.length} / 上限 ${PROVIDER_LIMITS.toolsPerProvider}`)
/**
 * ★ v0.7.1（issue #4 反馈「小屋那个包正好 8 个工具，再加一个就得拆包」）：
 *   工具上限抬到 16，**提示段仍是 4/12** —— 提示段是每条消息的固定成本，工具只是 schema。
 */
check('★工具上限抬到 16，提示段仍是每 provider 4（不为工具数量牺牲提示段预算）',
  PROVIDER_LIMITS.toolsPerProvider === 16 && PROVIDER_LIMITS.sectionsPerProvider === 4
  && PROVIDER_LIMITS.toolsTotal >= 16 && PROVIDER_LIMITS.sectionsTotal === 12,
  brief(PROVIDER_LIMITS))
check('★一个 provider 贡献 12 个工具（真实使用者的规模）不再被截断',
  collectProviderAdditions({
    providers: [{ name: 'hut', fn: () => ({ tools: Array.from({ length: 12 }, (unused, i) => fakeTool(`hut_${i}`)) }) }],
    builtinNames: BUILTIN_TOOL_NAMES,
  }).tools.length === 12)
/**
 * ★★ v0.7.3（issue #4 作者的真实插件里写 `context?.workspaceRoot || ''`）：
 *   他按出口的形状假设 provider 会拿到 workspaceRoot —— 而上游一直没给，等于**静默** undefined。
 *   现在 context 补齐 `workspaceRoot` + `extensionVersion`，并由这条断言钉住。
 */
const providerContext = (() => {
  let seen = null
  const collected = collectProviderAdditions({
    providers: [{
      name: 'ctxprobe',
      fn: (context) => { seen = context; return { tools: [fakeTool('ext_probe')], sections: [] } },
    }],
    builtinNames: BUILTIN_TOOL_NAMES,
    context: { key: 'g:2002', workspaceRoot: dir, extensionVersion: 1, config: { accessToken: 'x' } },
  })
  return { seen, collected }
})()
check('★★provider 的 context 带 workspaceRoot / extensionVersion / key（不再靠猜）',
  providerContext.seen?.workspaceRoot === dir
  && providerContext.seen?.extensionVersion === 1
  && providerContext.seen?.key === 'g:2002'
  && providerContext.collected.tools.length === 1,
  brief(providerContext.seen && Object.keys(providerContext.seen)))
/**
 * ★★ v0.7.1 复核抓到的自家漏洞：`slice()` 截断本来是**静默**的（超了上限直接丢，什么都不记），
 *   这违反了本项目"无静默分支"的根本规矩。现在超上限本身会记一条 skipped 并进 trace。
 */
check('★★超出每 provider 上限时不再静默截断（工具与提示段都写明丢了几个）',
  (() => {
    const over = collectProviderAdditions({
      providers: [{
        name: 'big',
        fn: () => ({
          tools: Array.from({ length: PROVIDER_LIMITS.toolsPerProvider + 4 }, (unused, i) => fakeTool(`big_${i}`)),
          sections: Array.from({ length: PROVIDER_LIMITS.sectionsPerProvider + 3 }, (unused, i) => ({ text: `s${i}` })),
        }),
      }],
      builtinNames: BUILTIN_TOOL_NAMES,
    })
    return over.tools.length === PROVIDER_LIMITS.toolsPerProvider
      && over.sections.length === PROVIDER_LIMITS.sectionsPerProvider
      && over.skipped.some((item) => /工具数超过每 provider 上限/.test(item.reason) && /末尾 4 个被丢弃/.test(item.reason))
      && over.skipped.some((item) => /提示段超过每 provider 上限/.test(item.reason) && /末尾 3 段被丢弃/.test(item.reason))
  })(),
  brief(collectProviderAdditions({
    providers: [{ name: 'big', fn: () => ({ tools: Array.from({ length: PROVIDER_LIMITS.toolsPerProvider + 4 }, (unused, i) => fakeTool(`b${i}`)) }) }],
    builtinNames: BUILTIN_TOOL_NAMES,
  }).skipped))
check('★★多个 provider 撞总上限时也写明"总数超过"',
  (() => {
    const total = collectProviderAdditions({
      providers: [1, 2, 3].map((k) => ({
        name: `p${k}`,
        fn: () => ({ tools: Array.from({ length: PROVIDER_LIMITS.toolsPerProvider }, (unused, i) => fakeTool(`p${k}_${i}`)) }),
      })),
      builtinNames: BUILTIN_TOOL_NAMES,
    })
    return total.tools.length === PROVIDER_LIMITS.toolsTotal
      && total.skipped.some((item) => /工具总数超过/.test(item.reason))
  })(),
  String(collectProviderAdditions({
    providers: [1, 2, 3].map((k) => ({ name: `p${k}`, fn: () => ({ tools: Array.from({ length: PROVIDER_LIMITS.toolsPerProvider }, (unused, i) => fakeTool(`p${k}_${i}`)) }) })),
    builtinNames: BUILTIN_TOOL_NAMES,
  }).tools.length))

// 注册/取消注册
const offProvider = api.registerToolProvider(() => ({ tools: [], sections: [] }), { name: 'demo' })
check('registerToolProvider 返回取消函数，列表里能看到名字',
  api.toolProviders().includes('demo') && typeof offProvider === 'function')
offProvider()
check('取消注册后从列表里消失', !api.toolProviders().includes('demo'), brief(api.toolProviders()))

// provider 注入真的会注册进 agentCtx（直接调私有路径不可行，这里用假 agentCtx 走公开的 provider 列表 + collect 结果）
const registeredTools = []
const registeredSections = []
const fakeAgentCtx = {
  systemPrompt: { section: (spec) => registeredSections.push(spec) },
  tools: { register: (tool) => registeredTools.push(tool.name) },
}
config.extensionToolsEnabled = true
api.registerToolProvider(({ config: providedConfig }) => {
  // provider 拿到的 config 是脱敏副本
  check('provider 拿到的 config 已脱敏（没有 accessToken/ttsApiKey）',
    providedConfig.accessToken === undefined && providedConfig.ttsApiKey === undefined)
  return { tools: [fakeTool('ext_ok')], sections: [{ text: 'extension prompt', order: 200 }] }
}, { name: 'injected' })
const injected = collectProviderAdditions({
  providers: [{ name: 'injected', fn: () => ({ tools: [fakeTool('ext_ok')], sections: [{ text: 'extension prompt' }] }) }],
  builtinNames: BUILTIN_TOOL_NAMES,
})
for (const section of injected.sections) fakeAgentCtx.systemPrompt.section(section)
for (const tool of injected.tools) fakeAgentCtx.tools.register(tool)
/**
 * ★★ issue #4 建议的「对比式」回归（它原文：空 provider 时比一遍工具名与段名，注册一个 provider 时比一遍过滤结果）：
 *   ① 一个 provider 都没有 ⇒ 工具与提示段**必须为空**（= 行为与没有扩展功能完全一致）；
 *   ② 注册一个 provider 后 ⇒ **只多出它那几个**，内置工具一个都没被顶掉、也没有别的副作用；
 *   ③ 开关打开但**还没建新会话**时，provider 根本不会被调用（提示段的成本只在会话 setup 时付）。
 */
const providerCalls = []
api.registerToolProvider(() => { providerCalls.push('called'); return { tools: [fakeTool('ext_never')], sections: [] } }, { name: 'spy' })

const emptyRun = collectProviderAdditions({ providers: [], builtinNames: BUILTIN_TOOL_NAMES })
check('★★对比：一个 provider 都没有时，工具与提示段都是空的（行为与无扩展时一致）',
  emptyRun.tools.length === 0 && emptyRun.sections.length === 0
  && emptyRun.skipped.length === 0 && emptyRun.notes.length === 0,
  brief(emptyRun))

const oneRun = collectProviderAdditions({
  providers: [{ name: 'only', fn: () => ({ tools: [fakeTool('ext_only')], sections: [{ text: 'only prompt' }] }) }],
  builtinNames: BUILTIN_TOOL_NAMES,
})
const delta = oneRun.tools.map((tool) => tool.name)
check('★★对比：注册一个 provider 后只多出它自己的东西，内置工具一个没动',
  delta.join(',') === 'ext_only'
  && oneRun.sections.length === 1
  && BUILTIN_TOOL_NAMES.every((name) => !delta.includes(name))
  && oneRun.skipped.length === 0,
  brief({ added: delta, sections: oneRun.sections.map((s) => s.name) }))

check('★★开关打开但还没建新会话时，provider 根本不会被调用（提示段成本只在会话 setup 时付）',
  providerCalls.length === 0 && config.extensionToolsEnabled === true,
  `provider 被调用 ${providerCalls.length} 次`)
check('★实验开关打开后，provider 的工具与提示段能装进 agentCtx',
  registeredTools.includes('ext_ok') && registeredSections.some((section) => section.text === 'extension prompt'),
  brief({ registeredTools, sections: registeredSections.map((s) => s.name) }))

// ---- ⑤ 挂载机制 ----
const setCalls = []
check('★宿主有 ctx.set 时挂成服务',
  attachExtensionService({ set: (name, value) => setCalls.push({ name, value }) }, api).ok === true
  && setCalls[0]?.name === EXTENSION_SERVICE && setCalls[0]?.value === api)
const ctxProvide = { provide: (name) => { ctxProvide.provided = name } }
const provided = attachExtensionService(ctxProvide, api)
check('★宿主只有 ctx.provide 时：声明 + 赋值',
  provided.ok === true && ctxProvide.provided === EXTENSION_SERVICE && ctxProvide[EXTENSION_SERVICE] === api, brief(provided))
const bare = attachExtensionService({}, api)
check('★两者都没有：不致命，模块级注册表兜底',
  bare.ok === false && typeof bare.reason === 'string' && getExtensionApi() === api, brief(bare))

// ---- ⑥ 纯函数 ----
check('redactConfig 按名字抹密钥（token / apiKey / secret 三类）',
  (() => {
    const safe = redactConfig({ a: 1, accessToken: 'x', ttsApiKey: 'y', webhookSecret: 'z', list: [1, 2] })
    return safe.a === 1 && safe.accessToken === undefined && safe.ttsApiKey === undefined
      && safe.webhookSecret === undefined && JSON.stringify(safe.list) === '[1,2]'
  })())
check('内置工具名清单与源码里的 defineTool 一一对应（防漏改）',
  (() => {
    const source = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
    const names = [...source.matchAll(/defineTool\(\{\s*\n\s*name: '([^']+)'/g)].map((match) => match[1])
    return names.length === BUILTIN_TOOL_NAMES.length && names.every((name) => BUILTIN_TOOL_NAMES.includes(name))
  })(),
  `${BUILTIN_TOOL_NAMES.length} 个`)

/**
 * ★ v0.7.0 运行时状态（面板「实验性」组下面那几行；这是 issue #4 说的 `chips` 的替代方案）：
 * 不要求 provider 声明"展示名与用途"，直接如实报告运行时的挂载 / provider / 最近一次注入。
 */
const report = bridge.extensionReport()
check('★extensionReport：带挂载状态、开关、provider 列表与 workspaceRoot',
  report !== null && typeof report === 'object'
  && (report.mounted === null || typeof report.mounted === 'object')
  && report.enabled === (config.extensionToolsEnabled === true)
  && Array.isArray(report.providers)
  && report.workspaceRoot === dir,
  brief({ enabled: report?.enabled, providers: report?.providers, mounted: report?.mounted?.via }))
config.extensionToolsEnabled = true
api.registerToolProvider(() => ({ tools: [], sections: [] }), { name: 'shown' })
const report2 = bridge.extensionReport()
check('★extensionReport 能反映新登记的 provider 与开关状态',
  report2.providers.includes('shown') && report2.enabled === true, brief(report2.providers))
/**
 * ★ v0.7.0 出口用量计数：用来回答"到底有没有人在用这个 API"。
 *   没有使用者时，将来任何破坏性改动都不疼；有数字就得走 version:2。
 */
const usageNow = bridge.extensionReport().usage
check('★出口用量计数：前面那些 sendText / recall / react 都被记了一笔',
  usageNow && usageNow.sendText >= 3 && usageNow.recall >= 1 && usageNow.react >= 1
  && usageNow.sendImage === 0 && usageNow.sendFile === 0 && usageNow.sendVoice === 0,
  brief(usageNow))
check('用量计数是副本（调用方改不到内部状态）',
  (() => {
    const usage = bridge.extensionReport().usage
    usage.sendText = 999
    return bridge.extensionReport().usage.sendText !== 999
  })())

bridge.stop()
rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

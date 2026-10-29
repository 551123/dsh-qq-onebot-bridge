/**
 * v0.7.9 能力矩阵单测：
 *   ① 分层判定（standard / extension / napcat）
 *   ② 实现识别（NapCat / LLOneBot / Lagrange / 未知）
 *   ③ 被动账本（成功计数、失败明细、首次失败只回调一次、totals）
 *   ④ 报表文案（不支持时点名功能、标准动作失败时提示查连接）
 *   ⑤ 桥级：真的失败一次 → 账本记上 + trace 里有 capability 事件 + `/health` 会带出来
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import { capabilityLines, capabilityReport, createActionLedger, describeImplementation, featureOf, tierOf, tierCounts } from '../lib/capability.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => JSON.stringify(value ?? null).slice(0, 220)

// ---------- ① 分层 ----------
check('★标准动作归为 standard', ['send_group_msg', 'delete_msg', 'get_group_member_list', 'set_group_ban']
  .every((action) => tierOf(action) === 'standard'))
check('★实现扩展归为 extension', ['set_msg_emoji_like', 'get_group_msg_history', 'ocr_image', 'set_input_status']
  .every((action) => tierOf(action) === 'extension'))
check('★NapCat 专属归为 napcat', ['upload_image_to_qun_album', 'get_qun_album_list', 'set_group_sign']
  .every((action) => tierOf(action) === 'napcat'))
check('未知 action 按 standard 处理（宁可先怀疑连接，也不武断说"不支持"）', tierOf('some_future_action') === 'standard')
check('功能人话名有兜底', featureOf('upload_image_to_qun_album') === '上传到群相册' && featureOf('whatever') === 'whatever')
check('tierCounts 统计三个分层', (() => {
  const counts = tierCounts(['send_group_msg', 'set_msg_emoji_like', 'set_group_sign', 'delete_msg'])
  return counts.standard === 2 && counts.extension === 1 && counts.napcat === 1
})(), brief(tierCounts(['send_group_msg', 'set_msg_emoji_like', 'set_group_sign', 'delete_msg'])))

// ---------- ② 实现识别 ----------
check('★识别 NapCat', (() => {
  const impl = describeImplementation({ app_name: 'NapCat.Onebot', app_version: '4.2.1', protocol_version: 'v11' })
  return impl.family === 'napcat' && impl.protocol === 'v11' && impl.name.includes('NapCat')
})(), brief(describeImplementation({ app_name: 'NapCat.Onebot', app_version: '4.2.1' })))
check('★识别 LLOneBot / Lagrange / go-cqhttp',
  describeImplementation({ app_name: 'LLOneBot' }).family === 'llonebot'
  && describeImplementation({ app_name: 'Lagrange.OneBot' }).family === 'lagrange'
  && describeImplementation({ app_name: 'go-cqhttp' }).family === 'go-cqhttp')
check('认不出时不崩、标成未知', (() => {
  const impl = describeImplementation(null)
  const weird = describeImplementation({ foo: 1 })
  return impl.family === 'unknown' && impl.name === '未知实现' && weird.family === 'unknown'
})(), brief(describeImplementation(null)))

// ---------- ③ 账本 ----------
{
  let clock = 0
  const firsts = []
  const ledger = createActionLedger({ now: () => (clock += 100), onFirstFailure: (entry) => firsts.push(entry) })
  ledger.success('send_group_msg')
  ledger.success('send_group_msg')
  ledger.success('delete_msg')
  ledger.failure('upload_image_to_qun_album', new Error('OneBot action upload_image_to_qun_album failed: retcode 1404'))
  ledger.failure('upload_image_to_qun_album', new Error('OneBot action upload_image_to_qun_album failed: retcode 1404'))
  ledger.failure('set_msg_emoji_like', new Error('unsupported'))
  check('★成功只计数、失败记次数与最后错误',
    ledger.get('send_group_msg').ok === 2
    && ledger.get('upload_image_to_qun_album').fail === 2
    && /retcode 1404/.test(ledger.get('upload_image_to_qun_album').lastError),
    brief(ledger.get('upload_image_to_qun_album')))
  check('★首次失败只回调一次（0→1），不刷屏', firsts.length === 2 && firsts.map((item) => item.action).sort().join(',') === 'set_msg_emoji_like,upload_image_to_qun_album',
    brief(firsts.map((item) => item.action)))
  check('首次失败回调里带分层与功能名', firsts.every((item) => item.tier !== undefined && item.feature !== ''),
    brief(firsts[0]))
  check('totals 汇总正确', (() => {
    const totals = ledger.totals()
    return totals.ok === 3 && totals.fail === 3 && totals.actions === 4
  })(), brief(ledger.totals()))
  check('failures() 按次数降序', ledger.failures()[0].action === 'upload_image_to_qun_album')
  check('clear() 清空', (() => { ledger.clear(); return ledger.size === 0 })())
}

// ---------- ④ 报表 ----------
{
  const ledger = createActionLedger()
  const impl = describeImplementation({ app_name: 'LLOneBot' })
  const empty = capabilityReport({ implementation: impl, ledger })
  check('没有调用记录时如实说"还没有记录"（不给虚假安全感）', /还没有调用记录/.test(empty.summary), empty.summary)

  ledger.success('send_group_msg')
  const allOk = capabilityReport({ implementation: impl, ledger })
  check('全部成功时明确说"全部成功"并带次数', /全部成功/.test(allOk.summary) && allOk.failureCount === 0, allOk.summary)

  ledger.failure('upload_image_to_qun_album', new Error('retcode 1404'))
  ledger.failure('send_group_msg', new Error('timeout'))
  const mixed = capabilityReport({ implementation: impl, ledger })
  check('★扩展动作失败 → 点名"当前实现不支持"', (() => {
    const item = mixed.failures.find((entry) => entry.action === 'upload_image_to_qun_album')
    return item !== undefined && /不支持/.test(item.hint) && /LLOneBot/.test(item.hint)
  })(), brief(mixed.failures))
  check('★标准动作失败 → 提示先查连接/权限', (() => {
    const item = mixed.failures.find((entry) => entry.action === 'send_group_msg')
    return item !== undefined && /连接/.test(item.hint)
  })())
  check('摘要里点出"其中 N 个是扩展专属"', /扩展\/NapCat 专属/.test(mixed.summary), mixed.summary)
  const lines = capabilityLines(mixed)
  check('多行文本第一行是实现，后面是动作', /^OneBot 实现：/.test(lines[0]) && lines.length >= 3, brief(lines))
  const truncated = capabilityLines({ ...mixed, failures: mixed.failures, failureCount: 9 }, { maxLines: 1 })
  check('超过 maxLines 时折叠成"另有 N 个"', truncated.some((line) => /另有 8 个/.test(line)), brief(truncated))
}

// ---------- ⑤ 桥级：真的失败一次 ----------
class FailingServer extends EventEmitter {
  constructor() { super(); this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }; this.sent = [] }
  setActionLedger(ledger) { this.ledger = ledger }
  currentSocket() { return this.socket }
  getVersionInfo() { return Promise.resolve({ app_name: 'LLOneBot', app_version: '3.9', protocol_version: 'v11' }) }
  getMsg() { return Promise.resolve({ message: [] }) }
  sendSegments() { this.sent.push(1); return Promise.resolve({ message_id: 'm1' }) }
  uploadGroupFile() { return Promise.reject(new Error('OneBot action upload_group_file failed: retcode 1404')) }
}

const makeCtx = () => ({
  on: () => () => {}, get: () => undefined, emit: () => {},
  agents: { create: async () => ({ id: 's', status: 'idle', followup: () => {}, cancel: () => {}, ctx: { systemPrompt: { section() {} }, tools: { register() {} } } }) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'x', model: 'y' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
})

const cwd = mkdtempSync(join(tmpdir(), 'qq-cap-'))
const server = new FailingServer()
const bridge = new QQBridge(makeCtx(), {
  cwd, allowUsers: [1001], allowGroups: [2002], botQq: 999, replyOnlyWhenMentioned: false,
  dedupEnabled: false, memoryEnabled: false, filterEnabled: false,
}, server, { info() {}, warn() {}, error() {} })
bridge.start()

check('桥启动后把账本交给了 OneBot 客户端', server.ledger !== undefined && server.ledger === bridge.actionLedger)

server.emit('bot-connect', server.socket)
await new Promise((resolve) => setTimeout(resolve, 60))
check('★连上后探测实现并记进 trace', (() => {
  const report = bridge.capabilityReport()
  return report.implementation.family === 'llonebot'
    && bridge.trace.recent({ limit: 100 }).some((event) => event.stage === 'capability' && /LLOneBot/.test(event.reason ?? ''))
})(), brief(bridge.capabilityReport().implementation))

// 让一个扩展动作真的失败：走 ActionGate 之外最直接的路 —— 直接调用账本（等价于 #call 的失败路径）
bridge.actionLedger.failure('upload_image_to_qun_album', new Error('OneBot action upload_image_to_qun_album failed: retcode 1404'))
const capEvents = bridge.trace.recent({ limit: 200 }).filter((event) => event.stage === 'capability')
check('★首次失败写一条 warn trace（不许静默）',
  capEvents.some((event) => /动作失败（首次）/.test(event.reason ?? '') && /群相册/.test(event.reason ?? '')),
  brief(capEvents.map((event) => event.reason?.slice(0, 50))))
check('再次失败不重复写 trace（避免刷屏）', (() => {
  const before = bridge.trace.recent({ limit: 200 }).filter((event) => event.stage === 'capability').length
  bridge.actionLedger.failure('upload_image_to_qun_album', new Error('again'))
  const after = bridge.trace.recent({ limit: 200 }).filter((event) => event.stage === 'capability').length
  return after === before
})())
check('报表里能看到失败的动作与提示', (() => {
  const report = bridge.capabilityReport()
  return report.failureCount === 1 && report.failures[0].action === 'upload_image_to_qun_album' && /不支持/.test(report.failures[0].hint)
})(), brief(bridge.capabilityReport().failures))

bridge.stop()
rmSync(cwd, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

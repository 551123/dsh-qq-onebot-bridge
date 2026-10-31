/**
 * v0.7.9 能力体检（conformance）单测：
 *   ① 探针清单**只读**（写操作前缀一律不许出现）
 *   ② 参数补齐（缺群号/QQ 号 → skipped，不瞎编 id）
 *   ③ 结果分类（ok / unsupported / not-found / bad-params / timeout / permission）
 *   ④ 汇总与多行文本
 *   ⑤ 桥级：真跑一轮（假 server 返回 ok / 1404 / 超时）→ rows、trace、knownUnsupported、面板行
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QQBridge } from '../lib/bridge.js'
import {
  MUTATING_PREFIXES, READONLY_PROBES, assertProbeSafety, buildProbeParams, classifyProbe,
  conformanceLines, describeProbeResult, summarizeConformance,
} from '../lib/conformance.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => JSON.stringify(value ?? null).slice(0, 220)

// ---------- ① 只读约束 ----------
check('★探针清单里没有任何写操作（禁言/踢人/发消息/上传…都不许出现）',
  assertProbeSafety().ok === true, brief(assertProbeSafety().offenders))
check('★探针清单全部以 get_ 开头（白名单式，而不是"排除写操作"）',
  READONLY_PROBES.every((probe) => probe.action.startsWith('get_') || probe.action.startsWith('_get_')),
  brief(READONLY_PROBES.filter((probe) => !/^_?get_/.test(probe.action)).map((probe) => probe.action)))
check('写操作前缀自检能抓到违规（防以后有人手滑加一条 set_*）',
  (() => {
    const bad = [...READONLY_PROBES, { action: 'set_group_ban', feature: 'x', needs: null, tier: 'standard' }]
    const safety = assertProbeSafety(bad)
    return safety.ok === false && safety.offenders.includes('set_group_ban')
  })())
check('MUTATING_PREFIXES 覆盖常见写操作', ['send_group_msg', 'set_group_ban', 'delete_msg', 'upload_group_file', 'mark_group_msg_as_read']
  .every((action) => MUTATING_PREFIXES.some((prefix) => action.startsWith(prefix))))
check('探针都带功能人话名与分层', READONLY_PROBES.every((probe) => probe.feature !== '' && ['standard', 'extension', 'napcat'].includes(probe.tier)))

// ---------- ② 参数补齐 ----------
check('不需要参数的动作返回 {}', JSON.stringify(buildProbeParams({ needs: null }, {})) === '{}')
check('★缺群号时返回 null（不瞎编 id）', buildProbeParams({ needs: 'group' }, {}) === null)
check('用 allowGroups[0] 补群号', JSON.stringify(buildProbeParams({ needs: 'group' }, { allowGroups: [2002] })) === '{"group_id":2002}')
check('用 allowUsers[0] 补 QQ 号', JSON.stringify(buildProbeParams({ needs: 'user' }, { allowUsers: [1001] })) === '{"user_id":1001}')
check('group+user 两者缺一就 null',
  buildProbeParams({ needs: 'group+user' }, { allowGroups: [2002] }) === null
  && JSON.stringify(buildProbeParams({ needs: 'group+user' }, { allowGroups: [2002], allowUsers: [1001] })) === '{"group_id":2002,"user_id":1001}')

// ---------- ③ 分类 ----------
check('★成功 → ok', classifyProbe({ ok: true, retcode: 0 }) === 'ok')
check('★"not implemented" 文本 → unsupported', classifyProbe({ ok: false, message: 'action not implemented' }) === 'unsupported')
check('中文"不支持"也算 unsupported', classifyProbe({ ok: false, message: '该实现不支持此接口' }) === 'unsupported')
check('retcode 1404 → not-found（可能是目标不存在）', classifyProbe({ ok: false, retcode: 1404 }) === 'not-found')
check('retcode 100 → bad-params（实现与 v11 不一致）', classifyProbe({ ok: false, retcode: 100 }) === 'bad-params')
check('权限错误 → permission', classifyProbe({ ok: false, message: 'permission denied' }) === 'permission')
check('超时 → timeout', classifyProbe({ ok: false, timeout: true }) === 'timeout')
check('其它错误 → error', classifyProbe({ ok: false, retcode: -1, message: 'boom' }) === 'error')

// ---------- ④ 汇总 ----------
{
  const rows = [
    { action: 'get_status', feature: '运行状态', tier: 'standard', result: 'ok' },
    { action: 'get_group_info', feature: '群信息', tier: 'standard', result: 'ok' },
    { action: 'get_qun_album_list', feature: '群相册列表', tier: 'napcat', result: 'unsupported' },
    { action: 'get_group_msg_history', feature: '群历史消息', tier: 'extension', result: 'timeout' },
    { action: 'get_group_shard_list', feature: 'x', tier: 'standard', result: 'skipped' },
  ]
  const report = summarizeConformance(rows)
  check('★汇总：支持数 / 有问题数 / 跳过数都算对', report.supported === 2 && report.bad === 2 && report.counts.skipped === 1, brief(report.counts))
  check('★"已确认不可用"包含 unsupported 与 timeout', JSON.stringify(report.provenUnsupported.sort()) === JSON.stringify(['get_group_msg_history', 'get_qun_album_list']), brief(report.provenUnsupported))
  check('摘要点出跳过原因（缺群号/QQ 号）', /跳过 1 个/.test(report.summary), report.summary)
  const lines = conformanceLines({ ...report, rows })
  check('多行文本：第一行是摘要，后面是问题项', lines[0] === report.summary && lines.length >= 3, brief(lines))
  check('列表里只列有问题的项（ok 的 21 条不刷屏）', lines.filter((line) => line.includes('✅')).length === 0)
  check('describeProbeResult 说人话', /⛔ 不支持 群相册列表（get_qun_album_list）/.test(describeProbeResult(rows[2])), describeProbeResult(rows[2]))
}

// ---------- ⑤ 桥级 ----------
class ProbeServer extends EventEmitter {
  constructor() { super(); this.socket = { readyState: 1, OPEN: 1, send() {}, close() {} }; this.calls = [] }
  setActionLedger() {}
  setOutboundFilter() {}
  currentSocket() { return this.socket }
  getMsg() { return Promise.resolve({ message: [] }) }
  sendSegments() { return Promise.resolve({ message_id: 'm1' }) }
  callRaw(socket, action) {
    this.calls.push(action)
    if (action === 'get_status') return Promise.resolve({ online: true })
    if (action === 'get_qun_album_list') return Promise.reject(new Error('OneBot action get_qun_album_list failed: {"status":"failed","retcode":1404}'))
    if (action === 'get_group_msg_history') return Promise.reject(new Error('OneBot action get_group_msg_history failed: {"status":"failed","retcode":1404,"message":"not implemented"}'))
    if (action === 'get_group_honor_info') return new Promise(() => {})   // 永不 resolve → 触发超时
    return Promise.reject(new Error('OneBot action X failed: {"status":"failed","retcode":100}'))
  }
}

const makeCtx = () => ({
  on: () => () => {}, get: () => undefined, emit: () => {},
  agents: { create: async () => ({ id: 's', status: 'idle', followup: () => {}, cancel: () => {}, ctx: { systemPrompt: { section() {} }, tools: { register() {} } } }) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'x', model: 'y' }) },
  logger: () => ({ info() {}, warn() {}, error() {} }),
})

const cwd = mkdtempSync(join(tmpdir(), 'qq-conf-'))
const server = new ProbeServer()
const bridge = new QQBridge(makeCtx(), {
  cwd, allowUsers: [1001], allowGroups: [2002], botQq: 999, replyOnlyWhenMentioned: false,
  dedupEnabled: false, memoryEnabled: false, filterEnabled: false,
}, server, { info() {}, warn() {}, error() {} })
bridge.start()

const report = await bridge.runConformance({ timeoutMs: 120 })
check('★体检跑完并落进 lastConformance', report.ok === true && bridge.lastConformance !== null && bridge.lastConformance.rows.length === READONLY_PROBES.length,
  brief({ total: report.total, supported: report.supported, bad: report.bad }))
check('★只探了只读动作（没有一条写操作被调用）',
  server.calls.every((action) => action.startsWith('get_') || action.startsWith('_get_')), brief(server.calls.slice(0, 5)))
check('★"不支持"与"超时"的进 knownUnsupported；retcode 1404 只算 not-found（可能是目标不存在，不武断）',
  bridge.knownUnsupported.has('get_group_msg_history') && bridge.knownUnsupported.has('get_group_honor_info')
  && !bridge.knownUnsupported.has('get_qun_album_list')
  && bridge.lastConformance.rows.find((row) => row.action === 'get_qun_album_list')?.result === 'not-found',
  brief([...bridge.knownUnsupported]))
check('★体检写一条 trace（无静默分支）',
  bridge.trace.recent({ limit: 100 }).some((event) => event.stage === 'capability' && /能力体检：/.test(event.reason ?? '')),
  brief(bridge.trace.recent({ limit: 20 }).filter((e) => e.stage === 'capability').map((e) => e.reason?.slice(0, 40))))
check('capabilityReport 里带上体检结论', (() => {
  const cap = bridge.capabilityReport()
  return cap.conformance !== null && typeof cap.conformance.summary === 'string' && Array.isArray(cap.knownUnsupported)
})(), brief(bridge.capabilityReport().conformance))
check('conformanceReportLines 能在 QQ 里直接发', (() => {
  const lines = bridge.conformanceReportLines({ maxLines: 3 })
  return lines.length >= 2 && /共探测/.test(lines[0])
})(), brief(bridge.conformanceReportLines({ maxLines: 3 })))

bridge.stop()
rmSync(cwd, { recursive: true, force: true })

// 没连上时的行为
{
  const cwd2 = mkdtempSync(join(tmpdir(), 'qq-conf2-'))
  const noSocket = new EventEmitter()
  noSocket.currentSocket = () => null
  noSocket.setActionLedger = () => {}
  noSocket.setOutboundFilter = () => {}
  noSocket.on = EventEmitter.prototype.on.bind(noSocket)
  const bridge2 = new QQBridge(makeCtx(), { cwd: cwd2, allowUsers: [1001], allowGroups: [2002], botQq: 999 }, noSocket, { info() {}, warn() {}, error() {} })
  bridge2.start()
  const result = await bridge2.runConformance()
  check('没连上实现时如实说"没有已连接的实现"（不假装跑过）', result.ok === false && /没有已连接/.test(result.reason), brief(result))
  bridge2.stop()
  rmSync(cwd2, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

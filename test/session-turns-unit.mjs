/**
 * 【P71】会话轮换 + 门禁决策落盘 的单测。
 *
 * 两件事都尽量抽成纯函数来验：
 *   · rotateTurnsLimit —— 配置键的取值口径（0 关、非数字回落 40、上限 400）；
 *   · gateDecision     —— 被丢的消息到底为什么被丢（interest 插件靠它统计）。
 * 真跑一条 QQ 消息才能验的部分（turn/end 计数、#rotateKey）用源码断言兜住接线。
 */
import { readFileSync } from 'node:fs'
import { gateDecision, rotateTurnsLimit } from '../lib/bridge.js'
import { FRAME_FIELDS, serializeFrame } from '../lib/inbox.js'
import { STAGES } from '../lib/trace.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (v) => JSON.stringify(v).slice(0, 200)

// ---------------- rotateTurnsLimit ----------------
check('★没配就用默认 40（老配置升级后自动生效）', rotateTurnsLimit(undefined) === 40, brief(rotateTurnsLimit(undefined)))
check('★0 = 关（永不自换）', rotateTurnsLimit(0) === 0)
check('显式数字原样', rotateTurnsLimit(7) === 7 && rotateTurnsLimit(400) === 400)
check('字符串数字也认（控制台写进来的值常见这种）', rotateTurnsLimit('20') === 20, brief(rotateTurnsLimit('20')))
check('负数归 0，不会变成"每轮都换"', rotateTurnsLimit(-5) === 0)
check('上限 400（换会话太频繁等于把记忆全丢掉）', rotateTurnsLimit(999) === 400, brief(rotateTurnsLimit(999)))
check('小数截断', rotateTurnsLimit(12.9) === 12)
check('非数字回落默认值', rotateTurnsLimit('abc') === 40)
check('空串按 0（表单清空 = 关）', rotateTurnsLimit('') === 0)

// ---------------- gateDecision ----------------
const base = { allowGroups: [100], allowUsers: [1, 2] }
check('★群与成员都在白名单：放行，且不编原因', (() => {
  const d = gateDecision(base, { messageType: 'group', groupId: 100, userId: 1 })
  return d.ok === true && d.why === ''
})(), brief(gateDecision(base, { messageType: 'group', groupId: 100, userId: 1 })))
check('★群不在白名单：group-not-allowed', gateDecision(base, { messageType: 'group', groupId: 999, userId: 1 }).why === 'group-not-allowed')
check('★群在、人不在：member-not-allowed', gateDecision(base, { messageType: 'group', groupId: 100, userId: 9 }).why === 'member-not-allowed')
check('★私聊不在 allowUsers：private-user-not-allowed', gateDecision(base, { messageType: 'private', userId: 9 }).why === 'private-user-not-allowed')
check('私聊白名单内放行', gateDecision(base, { messageType: 'private', userId: 2 }).ok === true)
check('allowAllChats 打开后一律放行', gateDecision({ allowAllChats: true }, { messageType: 'group', groupId: 7, userId: 9 }).ok === true)
check('入群验证待审的人私聊放行（verifyPending）', gateDecision(base, { messageType: 'private', userId: 42 }, { verifyPending: true }).ok === true)
check('allowUsersPrivateOnly 下群里不校验人', gateDecision({ ...base, allowUsersPrivateOnly: true }, { messageType: 'group', groupId: 100, userId: 9 }).ok === true)
check('空配置不抛错', (() => {
  try { return gateDecision(undefined, { messageType: 'group', groupId: 1, userId: 1 }).ok === false } catch { return false }
})())

// ---------------- inbox：decision 字段 ----------------
check('★inbox 白名单收 decision', FRAME_FIELDS.message.includes('decision'))
const line = JSON.parse(serializeFrame('message', {
  messageType: 'group', groupId: 100, userId: 1, text: 'hi',
  decision: { ok: false, why: 'group-not-allowed', note: '不该落盘', nested: { a: 1 } },
}, { now: 1_700_000_000_000 }))
check('★只留 ok + why，附加字段全部丢弃', brief(line.frame.decision) === brief({ ok: false, why: 'group-not-allowed' }), brief(line.frame.decision))
check('ok 归一成布尔', JSON.parse(serializeFrame('message', { decision: { ok: 'yes', why: 'x' } })).frame.decision.ok === false)
check('why 超长截断到 60 字', JSON.parse(serializeFrame('message', { decision: { ok: false, why: 'w'.repeat(200) } })).frame.decision.why.length === 60)
check('decision 是字符串/数字时不落盘', JSON.parse(serializeFrame('message', { decision: 'nope' })).frame.decision === undefined)
check('没有 decision 时不凭空造字段', JSON.parse(serializeFrame('message', { userId: 1 })).frame.decision === undefined)

// ---------------- 接线断言 ----------------
const bridge = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
check('★配置键真的进了 schema（默认 40 / 0-400）',
  /sessionRotateTurns: z\.number\(\)[^\n]*min\(0\)[^\n]*max\(400\)[^\n]*default\(40\)/.test(index))
check('★回合结束处按 #bumpTurns 计数并触发 #autoRotate',
  /const turns = this\.#bumpTurns\(entry\.key\)/.test(bridge) && /void this\.#autoRotate\(entry\.key, turns, rotateLimit\)/.test(bridge))
check('失败回合不计数（failed !== true 是条件之一）',
  /if \(entry && failed !== true && rotateLimit > 0\) \{/.test(bridge))
check('★/new 与自动换会话共用同一条 #rotateKey 路径',
  /await this\.#rotateKey\(this\.#routeKey\(message\)\)/.test(bridge) && /async #rotateKey\(key\) \{/.test(bridge))
check('换会话时回合计数一起清掉', /delete data\[key \+ '#turns'\]/.test(bridge))
check('新会话从 0 开始数', /data\[key \+ '#turns'\] = 0/.test(bridge))
check('trace 里能看到会话轮换（阶段名有中文标签）', STAGES['session-rotate'] === '会话轮换')
check('门禁只算一次：缓存挂在 message.__decision 上', /message\.__decision = decision/.test(bridge) && /message\?\.__decision !== undefined/.test(bridge))
check('inbox 记录前就把 decision 算好', /this\.#allowed\(message\)\n\s+this\.inbox\.record\('message', message\)/.test(bridge))
check('runtime 快照暴露 sessionRotateTurns（重启后能一眼确认加载没加载）',
  /'sessionResumeEnabled', 'sessionRotateTurns',/.test(bridge))

console.log('')
console.log('session-turns-unit:', passed, 'passed,', failed, 'failed')
process.exit(failed === 0 ? 0 : 1)

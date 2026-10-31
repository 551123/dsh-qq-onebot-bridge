/**
 * OneBot 实现一致性体检（conformance）—— v0.7.9 能力矩阵的"主动半边"。
 *
 * 0.7.9 只做了**被动记账**（等某个 action 失败才记一笔）。这个模块补上另一半：
 * 按需对当前连着的实现跑一轮**只读**探针，把"支持 / 不支持 / 参数不符 / 没响应"直接分类出来。
 *
 * ★ 安全边界（这个文件最重要的设计，见 `MUTATING_PREFIXES` 与 `assertProbeSafety()`）：
 *   71 个 action 里有一半会**真的改变 QQ 状态**（禁言、踢人、设精华、发通知、上传文件…）。
 *   探针等于拿真实群试错，所以这里**只允许只读 action**；写操作永远标记为"未探测"，
 *   由被动账本（真实使用时的失败）来回答。
 *
 * 纯函数 + 无副作用：真正发请求的是桥（它手里有 socket），本模块只负责
 *   "探什么 / 怎么判 / 怎么汇总"。
 */

/** 会改变 QQ 状态的 action 前缀：**永远不允许出现在探针清单里**。 */
export const MUTATING_PREFIXES = Object.freeze([
  'send_', 'set_', 'delete_', 'upload_', 'create_', 'move_', 'rename_',
  'mark_', 'kick', 'mute', 'recall', 'add_', 'remove_', 'leave',
])

/** 明确只读、且参数可以从本机上下文补出来的动作。 */
export const READONLY_PROBES = Object.freeze([
  { action: 'get_status', feature: '运行状态', needs: null, tier: 'standard' },
  { action: 'get_version_info', feature: '实现版本', needs: null, tier: 'standard' },
  { action: 'get_login_info', feature: '登录账号', needs: null, tier: 'standard' },
  { action: 'get_group_list', feature: '群列表', needs: null, tier: 'standard' },
  { action: 'get_friend_list', feature: '好友列表', needs: null, tier: 'standard' },
  { action: 'get_group_info', feature: '群信息', needs: 'group', tier: 'standard' },
  { action: 'get_group_member_list', feature: '群成员列表', needs: 'group', tier: 'standard' },
  { action: 'get_group_member_info', feature: '群成员详情', needs: 'group+user', tier: 'standard' },
  { action: 'get_stranger_info', feature: '陌生人信息', needs: 'user', tier: 'standard' },
  { action: 'get_group_honor_info', feature: '群荣誉', needs: 'group', tier: 'standard' },
  { action: 'get_essence_msg_list', feature: '群精华列表', needs: 'group', tier: 'standard' },
  { action: '_get_group_notice', feature: '群公告（读）', needs: 'group', tier: 'standard' },
  { action: 'get_group_root_files', feature: '群文件目录', needs: 'group', tier: 'standard' },
  { action: 'get_group_msg_history', feature: '群历史消息', needs: 'group', tier: 'extension' },
  { action: 'get_group_at_all_remain', feature: '@全体余量', needs: 'group', tier: 'extension' },
  { action: 'get_group_shut_list', feature: '禁言名单', needs: 'group', tier: 'extension' },
  { action: 'get_group_signed_list', feature: '群打卡名册', needs: 'group', tier: 'napcat' },
  { action: 'get_qun_album_list', feature: '群相册列表', needs: 'group', tier: 'napcat' },
  { action: 'get_group_system_msg', feature: '群系统消息', needs: null, tier: 'extension' },
  { action: 'get_group_ignored_notifies', feature: '被忽略的群通知', needs: null, tier: 'extension' },
  { action: 'get_doubt_friends_add_request', feature: '可疑好友申请（读）', needs: null, tier: 'extension' },
])

const isMutating = (action) => MUTATING_PREFIXES.some((prefix) => String(action ?? '').startsWith(prefix))

/**
 * 自检：探针清单里**不许**出现任何写操作。
 * 这条既给单测用，也可以在启动时跑一次（成本为零）——因为它防的是"以后有人手滑加了一条 set_*"。
 */
export function assertProbeSafety(probes = READONLY_PROBES) {
  const offenders = probes.filter((probe) => isMutating(probe.action)).map((probe) => probe.action)
  return { ok: offenders.length === 0, offenders }
}

/** 从配置 + 最近入站消息里凑出探针需要的参数；凑不出就返回 null（该条标记为 skipped）。 */
export function buildProbeParams(probe, context = {}) {
  const groupId = Number(context.groupId) || Number((context.allowGroups ?? [])[0]) || 0
  const userId = Number(context.userId) || Number((context.allowUsers ?? [])[0]) || 0
  switch (probe.needs) {
    case null:
    case undefined:
      return {}
    case 'group':
      return groupId > 0 ? { group_id: groupId } : null
    case 'user':
      return userId > 0 ? { user_id: userId } : null
    case 'group+user':
      return groupId > 0 && userId > 0 ? { group_id: groupId, user_id: userId } : null
    default:
      return null
  }
}

/**
 * 把一次调用的结果分类。OneBot v11 的 retcode 各家含义不一，所以这里同时看
 * `retcode` / 错误文本，宁可按"证据"分，不按"猜测"分。
 */
export function classifyProbe(outcome) {
  if (outcome?.timeout === true) return 'timeout'
  if (outcome?.ok === true) return 'ok'
  const message = String(outcome?.message ?? outcome?.error ?? '')
  if (/unsupported|not\s+implemented|未实现|不支持/i.test(message)) return 'unsupported'
  const retcode = Number(outcome?.retcode)
  if (retcode === 1404) return 'not-found'
  if (retcode === 100 || /bad\s+param|参数/i.test(message)) return 'bad-params'
  if (/permission|权限|forbidden|unauthorized/i.test(message)) return 'permission'
  if (retcode === 0) return 'ok'
  return 'error'
}

const RESULT_LABEL = {
  ok: '✅ 支持',
  unsupported: '⛔ 不支持',
  'not-found': '⚠️ 没有数据（可能是目标不存在，也可能不支持）',
  'bad-params': '⚠️ 参数不符（实现与 v11 不一致）',
  permission: '⚠️ 权限不足',
  timeout: '⛔ 无响应（超时）',
  error: '⚠️ 其它错误',
  skipped: '· 跳过（缺目标）',
  'not-probed': '· 未探测（会改变 QQ 状态）',
}

export const RESULT_LABELS = RESULT_LABEL

/** 单条结果 → 人话行。 */
export function describeProbeResult(row) {
  const label = RESULT_LABEL[row.result] ?? row.result
  const detail = row.detail ? `｜${String(row.detail).slice(0, 80)}` : ''
  return `${label} ${row.feature}（${row.action}）${detail}`
}

/**
 * 汇总：支持多少、不支持多少、哪些功能可以确认不可用。
 * `provenUnsupported` 会喂给能力矩阵（比"失败过一次"更确定）。
 */
export function summarizeConformance(rows, { implementation = null } = {}) {
  const counts = {}
  for (const row of rows) counts[row.result] = (counts[row.result] ?? 0) + 1
  const provenUnsupported = rows
    .filter((row) => row.result === 'unsupported' || row.result === 'timeout')
    .map((row) => row.action)
  const supported = rows.filter((row) => row.result === 'ok').length
  const bad = rows.length - supported - (counts.skipped ?? 0)
  return {
    implementation,
    total: rows.length,
    // ⚠️ 故意**不叫 `ok`**：`runConformance()` 的返回值里 `ok` 是"这次体检本身有没有跑成"的布尔，
    // 两个 `ok` 一撞，调用方就会把"支持 1 个"读成"跑成功了"。这里叫 `supported`。
    supported,
    bad,
    counts,
    provenUnsupported,
    summary: rows.length === 0
      ? '没有可探测的动作'
      : `共探测 ${rows.length - (counts.skipped ?? 0)} 个只读动作：支持 ${supported} 个、有问题 ${bad} 个`
        + (counts.skipped ? `、跳过 ${counts.skipped} 个（缺群号/QQ 号）` : ''),
  }
}

/** 多行文本（`/能力体检` 与面板状态行共用）。 */
export function conformanceLines(report, { maxLines = 6 } = {}) {
  const lines = [report.summary]
  const interesting = report.rows.filter((row) => row.result !== 'ok' && row.result !== 'skipped')
  for (const row of interesting.slice(0, maxLines)) lines.push(describeProbeResult(row))
  if (interesting.length > maxLines) lines.push(`…另有 ${interesting.length - maxLines} 条（看 trace / 诊断包）`)
  if (report.provenUnsupported.length > 0) {
    lines.push(`已确认不可用：${report.provenUnsupported.join('、')}`)
  }
  return lines
}

/** 把体检结果并进能力矩阵的"已知不支持"集合（桥用它让状态行更准）。 */
export function mergeUnsupported(existing = new Set(), report = { provenUnsupported: [] }) {
  const merged = new Set(existing)
  for (const action of report.provenUnsupported ?? []) merged.add(action)
  return merged
}

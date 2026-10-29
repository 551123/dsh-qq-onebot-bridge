/**
 * OneBot 实现能力矩阵 + 被动降级统计（v0.7.9）。
 *
 * 解决的问题：本插件会调用 **71 个 OneBot action**，其中只有 32 个是 v11 标准动作；
 * 另外 33 个是实现扩展（NapCat / LLOneBot / Lagrange 各有一套）。换一个实现之后，
 * 用户现在只能"用到某功能时才发现它不支持"——而失败信息埋在 trace 里，没人会去翻。
 *
 * 这里做两件事，都刻意**不做主动探针**（探针可能误触发真实动作，风险远大于收益）：
 *   ① **静态分级**：每个 action 属于 standard / extension / napcat，并配一句人话功能名；
 *   ② **被动记账**：`#call` 每次成功/失败都记一笔；失败时按分级给出判断——
 *      "标准动作也失败 ⇒ 连接/权限问题"，"扩展动作失败 ⇒ 大概率是当前实现不支持"。
 *
 * 纯函数 + 无副作用，单测直接可测；账本由桥持有（内存，重启清零）。
 */

/** action → 分层。default 视为 standard（宁可误判成"该有"，让用户先怀疑连接）。 */
const EXTENSION_ACTIONS = new Set([
  // 消息扩展
  'set_msg_emoji_like', 'get_emoji_likes', 'get_group_msg_history', 'get_friend_msg_history',
  'send_group_forward_msg', 'send_private_forward_msg', 'ocr_image', 'get_record',
  'mark_group_msg_as_read', 'mark_private_msg_as_read', 'set_input_status',
  // 互动
  'group_poke', 'friend_poke', 'send_like',
  // 群信息 / 运营
  'get_group_info_ex', 'get_group_at_all_remain', 'get_group_ignored_notifies',
  'get_group_shut_list', 'get_group_system_msg', 'get_doubt_friends_add_request',
  'set_doubt_friends_add_request', 'set_group_add_option', 'set_group_kick_members',
  'set_group_member_invite_policy', 'set_group_member_permissions',
  'set_group_new_member_history_visibility', 'set_group_portrait', 'set_group_remark',
  // 群文件扩展
  'move_group_file', 'rename_group_file',
])

/** NapCat 专属（换实现基本必然缺）。 */
const NAPCAT_ONLY_ACTIONS = new Set([
  'get_qun_album_list', 'upload_image_to_qun_album',
  'set_group_sign', 'get_group_signed_list',
])

/** 人话功能名（只覆盖会出问题的那部分；标准动作不必逐个起名）。 */
const ACTION_FEATURES = {
  set_msg_emoji_like: '表情回应（贴表情）',
  get_emoji_likes: '谁点了表情',
  get_group_msg_history: '群历史消息',
  get_friend_msg_history: '私聊历史消息',
  send_group_forward_msg: '群合并转发',
  send_private_forward_msg: '私聊合并转发',
  ocr_image: '图片 OCR',
  get_record: '语音下载/转码',
  mark_group_msg_as_read: '标记群消息已读',
  mark_private_msg_as_read: '标记私聊已读',
  set_input_status: '「正在输入」状态',
  group_poke: '群戳一戳',
  friend_poke: '私聊戳一戳',
  send_like: '名片点赞',
  get_group_info_ex: '群信息（扩展字段）',
  get_group_at_all_remain: '@全体余量',
  get_group_ignored_notifies: '被忽略的群通知',
  get_group_shut_list: '禁言名单',
  get_group_system_msg: '群系统消息',
  get_doubt_friends_add_request: '可疑好友申请（读）',
  set_doubt_friends_add_request: '可疑好友申请（处理）',
  set_group_add_option: '群加群方式',
  set_group_kick_members: '批量踢人',
  set_group_member_invite_policy: '群邀请策略',
  set_group_member_permissions: '群成员权限',
  set_group_new_member_history_visibility: '新成员可看历史',
  set_group_portrait: '群头像',
  set_group_remark: '群备注',
  move_group_file: '移动群文件',
  rename_group_file: '重命名群文件',
  get_qun_album_list: '群相册列表',
  upload_image_to_qun_album: '上传到群相册',
  set_group_sign: '群打卡',
  get_group_signed_list: '群打卡名册',
  _get_group_notice: '群公告（读）',
  _send_group_notice: '群公告（发）',
  get_group_honor_info: '群荣誉',
  get_essence_msg_list: '群精华列表',
  set_essence_msg: '设精华',
  delete_essence_msg: '取消精华',
}

/** 分层：`napcat` / `extension` / `standard`。 */
export function tierOf(action) {
  const name = String(action ?? '')
  if (NAPCAT_ONLY_ACTIONS.has(name)) return 'napcat'
  if (EXTENSION_ACTIONS.has(name)) return 'extension'
  return 'standard'
}

const TIER_LABEL = {
  standard: 'OneBot v11 标准动作',
  extension: '实现扩展动作',
  napcat: 'NapCat 专属动作',
}

/** 功能人话名（没有登记的就用 action 本身）。 */
export function featureOf(action) {
  return ACTION_FEATURES[String(action ?? '')] ?? String(action ?? '')
}

/**
 * 从 `get_version_info` 的返回里认出实现。
 * 各家返回形如 `{ app_name: 'NapCat.Onebot', app_version: '4.x', protocol_version: 'v11' }`，
 * 但字段并不统一，所以这里全都按"有啥用啥 + 关键词兜底"处理。
 */
export function describeImplementation(info) {
  if (info === null || typeof info !== 'object') return { name: '未知实现', raw: '', family: 'unknown' }
  const raw = [info.app_name, info.impl, info.version, info.app_version].filter(Boolean).join(' ').trim()
  const text = raw === '' ? JSON.stringify(info).slice(0, 120) : raw
  const lower = text.toLowerCase()
  const family = lower.includes('napcat') ? 'napcat'
    : lower.includes('llonebot') ? 'llonebot'
      : lower.includes('lagrange') ? 'lagrange'
        : lower.includes('shamrock') ? 'shamrock'
          : (lower.includes('go-cqhttp') || lower.includes('gocq')) ? 'go-cqhttp'
            : lower.includes('onebot') ? 'onebot-generic'
              : 'unknown'
  return {
    name: text === '' ? '未知实现' : text,
    family,
    protocol: String(info.protocol_version ?? ''),
    version: String(info.app_version ?? info.version ?? ''),
  }
}

/**
 * 被动账本：记录每个 action 的成功/失败次数与最后一条错误。
 * **只记失败细节**（成功只计数），避免把参数/内容带进来（那是隐私面）。
 *
 * `onFirstFailure(entry)`：某个 action **第一次**失败时回调一次（`0 → 1`），
 * 桥用它写一条 warn trace —— "不许静默"这条硬约束同样适用于"实现不支持某个动作"。
 */
export function createActionLedger({ now = () => Date.now(), maxErrorChars = 200, onFirstFailure = null } = {}) {
  const entries = new Map()
  const bump = (action, patch) => {
    const name = String(action ?? '')
    const current = entries.get(name) ?? { action: name, ok: 0, fail: 0, lastError: '', lastFailAt: 0, lastOkAt: 0 }
    entries.set(name, { ...current, ...patch })
  }
  return {
    success(action) { bump(action, { ok: (entries.get(String(action))?.ok ?? 0) + 1, lastOkAt: now() }) },
    failure(action, error) {
      const message = String(error?.message ?? error ?? '').slice(0, maxErrorChars)
      const before = entries.get(String(action))?.fail ?? 0
      bump(action, { fail: before + 1, lastError: message, lastFailAt: now() })
      if (before === 0 && typeof onFirstFailure === 'function') {
        try {
          onFirstFailure({ action: String(action ?? ''), error: message, tier: tierOf(action), feature: featureOf(action) })
        } catch { /* 回调不许影响调用方 */ }
      }
    },
    /** 某个 action 的账目（没有就返回 null）。 */
    get(action) { return entries.get(String(action)) ?? null },
    /** 失败过的 action，按次数降序。 */
    failures() {
      return [...entries.values()].filter((item) => item.fail > 0).sort((a, b) => b.fail - a.fail)
    },
    /** 总账：调用次数 / 失败次数 / 涉及多少 action。 */
    totals() {
      let ok = 0
      let fail = 0
      for (const item of entries.values()) { ok += item.ok; fail += item.fail }
      return { ok, fail, actions: entries.size }
    },
    clear() { entries.clear() },
    get size() { return entries.size },
  }
}

/**
 * 把账本 + 实现信息翻成**人话结论**（`/health` 与面板共用）。
 *
 * 判断规则（刻意保守，只给"大概率"）：
 *   - 标准动作失败 → 更像连接/权限/协议问题，提示先查连接；
 *   - 扩展/NapCat 动作失败 → 更像"当前实现不支持"，点名功能并建议关掉对应开关；
 *   - 全部成功 → 明确说"没发现问题"，不给虚假安全感（带调用次数）。
 */
export function capabilityReport({ implementation = null, ledger = null, limit = 5 } = {}) {
  const impl = implementation ?? describeImplementation(null)
  const failures = ledger ? ledger.failures() : []
  const totals = ledger ? ledger.totals() : { ok: 0, fail: 0, actions: 0 }
  const top = failures.slice(0, limit).map((item) => {
    const tier = tierOf(item.action)
    return {
      action: item.action,
      tier,
      tierLabel: TIER_LABEL[tier],
      feature: featureOf(item.action),
      count: item.fail,
      lastError: item.lastError,
      hint: tier === 'standard'
        ? '标准动作也失败了 —— 先查连接/权限/协议版本，不太可能是"实现不支持"'
        : `大概率是当前实现（${impl.name}）不支持这个扩展动作 —— 关掉对应功能即可，不影响其它`,
    }
  })
  const unsupportedLike = failures.filter((item) => tierOf(item.action) !== 'standard').length
  const summary = totals.ok + totals.fail === 0
    ? '还没有调用记录（刚启动或还没发过消息）'
    : failures.length === 0
      ? `已调用 ${totals.ok} 次，全部成功（涉及 ${totals.actions} 个 action）`
      : `共 ${totals.ok + totals.fail} 次调用，${totals.fail} 次失败，涉及 ${failures.length} 个 action`
        + `（其中 ${unsupportedLike} 个是扩展/NapCat 专属，最可能是不支持）`
  return { implementation: impl, totals, failures: top, failureCount: failures.length, unsupportedLike, summary }
}

/** 给 `/health` 与面板用的多行文本。 */
export function capabilityLines(report, { maxLines = 4 } = {}) {
  const lines = [`OneBot 实现：${report.implementation.name}（家族 ${report.implementation.family}${report.implementation.protocol ? `，协议 ${report.implementation.protocol}` : ''}）`]
  lines.push(`动作调用：${report.summary}`)
  for (const item of report.failures.slice(0, maxLines)) {
    // 没有登记人话名的动作，feature 就是 action 本身 —— 这时别再重复一遍括号。
    const label = item.feature === item.action ? item.action : `${item.feature}（${item.action}）`
    lines.push(`⚠️ ${label}：失败 ${item.count} 次｜${item.hint}`)
  }
  if (report.failureCount > maxLines) lines.push(`…另有 ${report.failureCount - maxLines} 个动作失败过（看控制台/诊断包）`)
  return lines
}

/** 分层统计（文档与自检用）。 */
export function tierCounts(actions) {
  const counts = { standard: 0, extension: 0, napcat: 0 }
  for (const action of actions) counts[tierOf(action)] += 1
  return counts
}

export const TIERS = TIER_LABEL

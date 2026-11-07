/**
 * 控制台「看得见」用的纯计算模块（v0.5.5 阶段 4）：
 * 性能分位数 / 阶段耗时 / 失败画像 / 定时任务视图 / 群配置视图。
 *
 * 本模块**零依赖、零 I/O、零全局状态**：输入永远是已经读到的 trace 事件数组或运行快照对象，
 * 输出永远是可直接 JSON 化的纯对象。因此它能完全脱离控制台进程单测（见 test/perf-unit.mjs）。
 *
 * 数据来源与口径（都来自真实字段，不做假设）：
 * - trace 事件的形状：`{ v, ts, id, level, module, stage, ok, reason?, ms?, chatKey?, data? }`
 *   （lib/trace.js 写入；`ms` 是**距上一条 mark** 的毫秒数，`ts` 是绝对时间戳）
 * - 端到端延迟：同一条 traceId 的「最后一条事件 ts − 第一条事件 ts」
 * - 阶段耗时：各 stage 的 `ms`（只统计 > 0 的，0 表示没记时）
 * - 运行快照的 `jobs` 块由 lib/bridge.js 写出（只有描述性字段，绝无 token/secret/命令原文）
 */

/** 默认展示的分位数。 */
export const DEFAULT_PERCENTILES = [50, 95]

/**
 * 计算分位数（线性插值法的「最近秩」简化版：取 ceil(p/100 * n) 那一项）。
 * 空数组返回 null，绝不返回 NaN——页面要显示"暂无数据"而不是 `NaN ms`。
 */
export function percentiles(values, ps = DEFAULT_PERCENTILES) {
  const list = (Array.isArray(values) ? values : [])
    // 注意：不能直接 Number(value) 再判 —— `Number(null)` 是 0、`Number('')` 也是 0，
    // 那会把"没有数据"混进分位数里（实测踩过）。只认数字本身与数字字符串。
    .filter((value) => typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
  const out = { count: list.length }
  if (list.length === 0) {
    for (const p of ps) out[`p${p}`] = null
    out.min = null
    out.max = null
    out.avg = null
    return out
  }
  for (const p of ps) {
    const rank = Math.min(list.length, Math.max(1, Math.ceil((Number(p) || 0) / 100 * list.length)))
    out[`p${p}`] = list[rank - 1]
  }
  out.min = list[0]
  out.max = list[list.length - 1]
  out.avg = Math.round(list.reduce((sum, value) => sum + value, 0) / list.length)
  return out
}

/** 一条 trace 的摘要：起止时间、端到端耗时、经过的阶段、是否失败。 */
export function chainSummary(events) {
  const list = (Array.isArray(events) ? events : []).filter((event) => event && Number.isFinite(Number(event.ts)))
  if (list.length === 0) return null
  const sorted = [...list].sort((a, b) => Number(a.ts) - Number(b.ts))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const failed = sorted.some((event) => event.ok === false && event.level !== 'debug')
  return {
    id: String(first.id ?? ''),
    chatKey: String(sorted.find((event) => event.chatKey)?.chatKey ?? ''),
    startedAt: Number(first.ts),
    endedAt: Number(last.ts),
    ms: Math.max(0, Number(last.ts) - Number(first.ts)),
    stages: [...new Set(sorted.map((event) => String(event.stage ?? 'unknown')))],
    failed,
    replies: sorted.filter((event) => event.stage === 'reply' && event.ok !== false).length,
  }
}

/** 按 traceId 分组，返回每条链的摘要（按开始时间升序）。 */
export function chainSummaries(events, { chatKey = '' } = {}) {
  const groups = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    const id = String(event.id ?? '').trim()
    if (id === '' || id === 't-untraced') continue
    if (chatKey !== '' && String(event.chatKey ?? '') !== chatKey) continue
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(event)
  }
  const rows = []
  for (const list of groups.values()) {
    const summary = chainSummary(list)
    if (summary) rows.push(summary)
  }
  return rows.sort((a, b) => a.startedAt - b.startedAt)
}

/** 各阶段的耗时画像（只统计带 ms 的事件；ms=0 表示这条没记时，不计入）。 */
export function stageStats(events) {
  const buckets = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    const stage = String(event?.stage ?? '').trim()
    const ms = Number(event?.ms)
    if (stage === '' || !Number.isFinite(ms) || ms <= 0) continue
    if (!buckets.has(stage)) buckets.set(stage, [])
    buckets.get(stage).push(ms)
  }
  return [...buckets.entries()]
    .map(([stage, values]) => ({ stage, ...percentiles(values) }))
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))
}

/** 失败画像：哪些阶段在失败、最常见的原因是什么。 */
export function errorReport(events, { limit = 5 } = {}) {
  const byStage = new Map()
  let total = 0
  let failed = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    total++
    if (event.ok !== false) continue
    // debug 级失败是"功能关着"这类说明，不算事故；页面分开显示。
    if (event.level === 'debug') continue
    failed++
    const stage = String(event.stage ?? 'unknown')
    if (!byStage.has(stage)) byStage.set(stage, { stage, count: 0, reasons: new Map() })
    const bucket = byStage.get(stage)
    bucket.count++
    const reason = String(event.reason ?? '(没有 reason)').slice(0, 120)
    bucket.reasons.set(reason, (bucket.reasons.get(reason) ?? 0) + 1)
  }
  return {
    total,
    failed,
    byStage: [...byStage.values()]
      .map((bucket) => ({
        stage: bucket.stage,
        count: bucket.count,
        topReasons: [...bucket.reasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([reason, count]) => ({ reason, count })),
      }))
      .sort((a, b) => b.count - a.count),
  }
}

/**
 * 控制台性能面板的总入口：整体 + 分会话分位数 + 最慢几条 + 阶段画像 + 失败画像。
 * `chatKey` 为空时统计全部会话，同时给出每个会话各自的分位数。
 */
export function perfReport(events, { chatKey = '', slowest = 5, now = Date.now() } = {}) {
  const list = Array.isArray(events) ? events : []
  const chains = chainSummaries(list, { chatKey })
  const byChatMap = new Map()
  for (const chain of chains) {
    const key = chain.chatKey || '(未知会话)'
    if (!byChatMap.has(key)) byChatMap.set(key, [])
    byChatMap.get(key).push(chain.ms)
  }
  const overall = percentiles(chains.map((chain) => chain.ms))
  const slowestChains = [...chains]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, Math.max(1, Math.trunc(Number(slowest) || 5)))
    .map((chain) => ({ id: chain.id, chatKey: chain.chatKey, ms: chain.ms, startedAt: chain.startedAt, stages: chain.stages, failed: chain.failed }))
  return {
    generatedAt: now,
    chatKey,
    events: list.length,
    chains: overall,
    byChat: [...byChatMap.entries()]
      .map(([key, values]) => ({ chatKey: key, ...percentiles(values) }))
      .sort((a, b) => b.count - a.count),
    slowest: slowestChains,
    stages: stageStats(list),
    errors: errorReport(list),
    // 一句话结论，前端直接显示，不让人自己算
    verdict: overall.count === 0
      ? '还没有可统计的消息（性能面板按"一条消息的 trace 链"计算）'
      : `最近 ${overall.count} 条消息：P50 ${overall.p50}ms，P95 ${overall.p95}ms，最慢 ${overall.max}ms`,
  }
}

/**
 * 「定时任务」面板的数据：播报任务 + webhook 来源 + 掉线自愈状态 + 注入队列。
 * 全部来自运行快照的 `jobs` / `injection` 块（桥写出来的描述性字段），控制台不做二次猜测。
 */
export function jobsView(runtime, { now = Date.now() } = {}) {
  const jobs = runtime?.jobs ?? {}
  // 元素级畸形也要挡住：`broadcast: [null]` 曾让整个 /api/jobs 500（审查提的 G6）。
  const broadcast = (Array.isArray(jobs.broadcast) ? jobs.broadcast : []).filter((job) => job && typeof job === 'object')
  const webhookRaw = jobs.webhook && typeof jobs.webhook === 'object' ? jobs.webhook : {}
  const autoHealRaw = jobs.autoHeal && typeof jobs.autoHeal === 'object' ? jobs.autoHeal : {}
  // 控制台侧**自己再挑一次字段**，不整对象透传：今天 writer 有白名单不代表明天还有（审查提的 G7）。
  const webhook = {
    enabled: webhookRaw.enabled === true,
    port: Number(webhookRaw.port) || 0,
    sources: (Array.isArray(webhookRaw.sources) ? webhookRaw.sources : [])
      .filter((source) => source && typeof source === 'object')
      .map((source) => ({
        name: String(source.name ?? ''),
        received: Number(source.received) || 0,
        dropped: Number(source.dropped) || 0,
        lastAt: Number(source.lastAt) || 0,
      })),
  }
  const autoHeal = {
    enabled: autoHealRaw.enabled === true,
    commandConfigured: autoHealRaw.commandConfigured === true,
    cooldownSeconds: Number(autoHealRaw.cooldownSeconds) || 0,
    maxPerHour: Number(autoHealRaw.maxPerHour) || 0,
    attemptsLastHour: Number(autoHealRaw.attemptsLastHour) || 0,
  }
  const injection = runtime?.injection ?? {}
  const describeNext = (nextAt) => {
    const at = Number(nextAt)
    if (!Number.isFinite(at) || at <= 0) return '—'
    const inMs = at - now
    if (inMs <= 0) return '即将触发'
    if (inMs < 60_000) return `${Math.round(inMs / 1000)} 秒后`
    if (inMs < 3_600_000) return `${Math.round(inMs / 60_000)} 分钟后`
    return `${Math.round(inMs / 3_600_000)} 小时后`
  }
  return {
    generatedAt: now,
    broadcast: {
      enabled: broadcast.some((job) => job.enabled === true),
      total: broadcast.length,
      enabledCount: broadcast.filter((job) => job.enabled === true).length,
      rows: broadcast.map((job) => ({
        id: String(job.id ?? ''),
        kind: String(job.kind ?? ''),
        chat: String(job.chat ?? ''),
        enabled: job.enabled === true,
        describe: String(job.describe ?? ''),
        nextAt: Number(job.nextAt) || 0,
        nextText: job.enabled === true ? describeNext(job.nextAt) : '已停用',
        lastAt: Number(job.lastAt) || 0,
        lastReason: String(job.lastReason ?? ''),
        runs: Number(job.runs) || 0,
        failures: Number(job.failures) || 0,
        health: (Number(job.failures) || 0) > 0 && (Number(job.runs) || 0) > 0 && (Number(job.failures) || 0) >= (Number(job.runs) || 0) ? '一直在失败' : '正常',
      })),
    },
    webhook,
    autoHeal,
    injection: {
      enabled: injection.enabled === true,
      dryRun: injection.dryRun !== false,
      intervalMs: Number(injection.intervalMs) || 0,
      queued: Number(injection.queued) || 0,
      consumed: Number(injection.consumed) || 0,
    },
  }
}

/**
 * 「群配置」面板的数据：每个会话一行，把**和这个群有关的开关与实时状态**摆在一起。
 *
 * 注意口径：插件开关住在 profile 的 cordis.patch.yml 里（控制台进程读不到原文），
 * 所以这里显示的是桥写进运行快照的**生效值**；要改开关仍然改插件配置。
 * 面板的价值在于"一眼看到这个群现在到底会发生什么"。
 */
export function groupsView(runtime, { now = Date.now() } = {}) {
  const features = runtime?.features ?? {}
  const sessions = (Array.isArray(runtime?.sessions) ? runtime.sessions : []).filter((session) => session && typeof session === 'object')
  const jobs = (Array.isArray(runtime?.jobs?.broadcast) ? runtime.jobs.broadcast : []).filter((job) => job && typeof job === 'object')
  // 白名单原文在运行快照的 `replay` 块里（离线回放需要它才能判白名单），`features` 里只有计数。
  // 控制台的 supervisor 会把这一块重新命名成 `replayHints`，所以两种形状都认。
  const allowGroupsRaw = runtime?.replay?.allowGroups ?? runtime?.replayHints?.allowGroups
  const allowGroups = Array.isArray(allowGroupsRaw) ? allowGroupsRaw.map(String) : []
  const switchRows = [
    { key: 'engageEnabled', label: '互动包' },
    { key: 'pokeBackEnabled', label: '被戳回戳' },
    { key: 'typingEnabled', label: '私聊正在输入' },
    { key: 'emojiLikeEnabled', label: '自动贴表情' },
    { key: 'reactionStatsEnabled', label: '表情统计' },
    { key: 'sendLikeEnabled', label: '点赞' },
    { key: 'markReadEnabled', label: '标记已读' },
    { key: 'groupOpsEnabled', label: '群运营工具箱' },
    { key: 'nativeSignEnabled', label: '原生群打卡' },
    { key: 'opsKickEnabled', label: '批量踢' },
    { key: 'opsTodoEnabled', label: '群待办' },
    { key: 'opsFileEnabled', label: '文件整理' },
    { key: 'opsAlbumUploadEnabled', label: '相册上传' },
    { key: 'opsProfileEnabled', label: '群资料修改' },
    { key: 'opsPolicyEnabled', label: '入群与发言策略' },
    { key: 'opsReportEnabled', label: '运营周报' },
    // v0.5.8：群权限 / 申请补拉 / 权限自愈。键必须与 lib/bridge.js 运行快照的
    // features 白名单一致——快照里没有的键会让面板永远显示"关"。
    { key: 'opsAdminEnabled', label: '管理员设置' },
    { key: 'opsInvitePolicyEnabled', label: '邀请策略' },
    { key: 'opsAddOptionEnabled', label: '加群方式' },
    { key: 'requestSyncEnabled', label: '申请补拉' },
    { key: 'adminWatchEnabled', label: '管理员变动播报' },
  ]
  const switches = switchRows.map((row) => ({ ...row, on: features[row.key] === true }))
  /**
   * 机器人在各群的管理员状态（v0.5.9）：唯一来源是 NapCat 的 `group_admin` 通知。
   * 超过保鲜期（桥侧 10 分钟）就标成"未知"——**不能把过期信息显示成事实**。
   */
  const botAdmin = new Map(
    (Array.isArray(runtime?.botAdmin) ? runtime.botAdmin : []).map((row) => [String(row?.groupId ?? ''), row]),
  )
  const botAdminState = (row) => {
    if (!row) return { known: false, admin: null, stale: false, at: 0, text: '未知（还没收到过这个群的管理员变动通知）' }
    const at = Number(row.at) || 0
    if (row.stale === true) return { known: true, admin: row.admin === true, stale: true, at, text: '未知（上次通知已超过保鲜期）' }
    return {
      known: true,
      admin: row.admin === true,
      stale: false,
      at,
      text: row.admin === true ? '是本群管理员' : '不是本群管理员（写命令会被权限自愈拦下）',
    }
  }
  const groups = new Map()
  for (const session of sessions) {
    const chatKey = String(session.chatKey ?? '')
    if (!chatKey.startsWith('g:')) continue
    groups.set(chatKey.slice(2), {
      groupId: chatKey.slice(2),
      sessionId: String(session.sessionId ?? ''),
      status: String(session.status ?? 'unknown'),
      lastTurnAt: Number(session.lastTurnAt) || 0,
      lastTurnText: Number(session.lastTurnAt) > 0 ? new Date(Number(session.lastTurnAt)).toLocaleString('zh-CN', { hour12: false }) : '—',
      allowlisted: allowGroups.length === 0 ? null : allowGroups.includes(chatKey.slice(2)),
      jobs: jobs.filter((job) => String(job.chat ?? '') === chatKey).map((job) => ({ id: String(job.id ?? ''), nextAt: Number(job.nextAt) || 0, enabled: job.enabled === true })),
      botAdmin: botAdminState(botAdmin.get(chatKey.slice(2))),
    })
  }
  // 只有管理员状态、还没有会话的群也要列出来：否则"机器人在这个群里不是管理员"根本看不到。
  for (const [groupId, row] of botAdmin) {
    if (groupId === '' || groups.has(groupId)) continue
    groups.set(groupId, {
      groupId,
      sessionId: '',
      status: '还没有会话',
      lastTurnAt: 0,
      lastTurnText: '—',
      allowlisted: allowGroups.length === 0 ? null : allowGroups.includes(groupId),
      jobs: [],
      botAdmin: botAdminState(row),
    })
  }
  return {
    generatedAt: now,
    switches,
    onCount: switches.filter((row) => row.on).length,
    groups: [...groups.values()].sort((a, b) => b.lastTurnAt - a.lastTurnAt),
    allowlistKnown: allowGroups.length > 0,
    counters: {
      reactionMessages: Number(features.reactionMessageCount) || 0,
      opsEntries: Number(features.opsCounterEntries) || 0,
      pendingKickBatches: Number(features.pendingKickBatches) || 0,
      typingActive: Number(features.typingActiveCount) || 0,
    },
    note: '开关的生效值来自桥写的运行快照；要改开关请改插件配置（profile 的 cordis.patch.yml）。',
  }
}

// ------------------------------------------------ 本地补丁 15 · 工具参考页 ----

/**
 * 【本地补丁 15 · 工具参考页】从 lib/bridge.js 源码抽 qq_* 工具目录。
 *
 * 口径与 tools/qq-tools.mjs 的 catalog（补丁 14 的 CLI）**故意保持一致**：
 * 只看 name: 'qq_...' 这一行，描述取其后 40 行内第一处 description: 的首行，
 * 去掉包裹引号与尾随逗号/拼接符，截到 140 字符。同一名字只留第一次出现。
 * 这是给人看的参考页，不是运行时真相（真正注册在 lib/bridge.js 的 #installSession）。
 */
export function extractToolCatalog(source) {
  const text = source === null || source === undefined ? '' : String(source)
  const lines = text.split('\n')
  const out = []
  const seen = new Set()
  for (let i = 0; i < lines.length; i++) {
    const hit = /name: '(qq_[a-z_0-9]+)'/.exec(lines[i])
    if (hit === null) continue
    if (seen.has(hit[1])) continue
    seen.add(hit[1])
    let description = ''
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
      const desc = /description: (.*)$/.exec(lines[j])
      if (desc === null) continue
      description = desc[1]
        .replace(/^[\u0060'"]/, '')
        .replace(/[,\u0060'"]?,?$/, '')
        .replace(/\s*\+\s*$/, '')
        .trim()
      break
    }
    out.push({ name: hit[1], description: description.slice(0, 140) })
  }
  return out
}

/**
 * 【本地补丁 15 · 工具参考页】lib/bridge.js #toolRuleFor（补丁 14）的展示用镜像。
 *
 * 真放行用的是桥里的私有方法；这里只回答「这个会话命中了哪条规则」。
 * 语义必须与桥一致，两边由 tools/test-tools-view.mjs 交叉验证：命中顺序
 * 精确键 → g:<群号>（群内按人分会话时兜一层）→ default；allow 存在（哪怕空数组）
 * = 只放行列出的，否则 deny = 拦下列出的；allow 与 deny 同时给时 allow 优先。
 */
export function toolRuleFor(table, key) {
  const chats = table !== null && typeof table === 'object' && table.chats !== null && typeof table.chats === 'object'
    ? table.chats
    : {}
  const text = key === null || key === undefined ? '' : String(key)
  const parts = text.split(':')
  const candidates = [text]
  if (parts[0] === 'g' && parts.length > 2) candidates.push('g:' + parts[1])
  let entry = null
  for (const candidate of candidates) {
    const hit = chats[candidate]
    if (hit !== null && typeof hit === 'object') { entry = hit; break }
  }
  if (entry === null && table !== null && table.default !== null && typeof table.default === 'object') entry = table.default
  if (entry === null) return null
  const allow = Array.isArray(entry.allow)
    ? entry.allow.filter((item) => typeof item === 'string' && item !== '')
    : null
  const deny = Array.isArray(entry.deny)
    ? entry.deny.filter((item) => typeof item === 'string' && item !== '')
    : null
  if (allow === null && deny === null) return null
  return allow !== null ? { mode: 'allow', names: allow } : { mode: 'deny', names: deny }
}

/** 【本地补丁 15 · 工具参考页】这条规则是从哪一层命中的（给人看的来源标注）。 */
export function toolRuleSource(table, key) {
  if (table === null || typeof table !== 'object') return '—'
  const chats = table.chats !== null && typeof table.chats === 'object' ? table.chats : {}
  const text = key === null || key === undefined ? '' : String(key)
  const parts = text.split(':')
  const candidates = [text]
  if (parts[0] === 'g' && parts.length > 2) candidates.push('g:' + parts[1])
  for (const candidate of candidates) {
    const hit = chats[candidate]
    if (hit !== null && typeof hit === 'object') return candidate === text ? '精确键' : candidate
  }
  return 'default'
}

/** 表里配过的所有键（用来提醒"配了但还没有对应会话"）。 */
function tableKeys(table) {
  if (table === null || typeof table !== 'object') return []
  const chats = table.chats !== null && typeof table.chats === 'object' ? table.chats : {}
  return Object.keys(chats).sort()
}

/**
 * 这条表键是否真的用得上：等于某个会话键，或者是某个会话键的前缀层
 * （例：表里配了 g:100，而真实会话键是 g:100:u:7 —— 这层会被回落命中，不算闲置）。
 */
function keyInUse(tableKey, sessionKeys) {
  const needle = String(tableKey)
  for (const sessionKey of sessionKeys) {
    const text = String(sessionKey)
    if (text === needle) return true
    if (text.startsWith(needle + ':')) return true
  }
  return false
}

/**
 * 【本地补丁 15 · 工具参考页】把目录 + 表 + 会话键拼成页面数据（纯函数）。
 *
 * 输入全是已读到的数据（控制台进程读文件，纯函数只做计算）：
 *   catalog      extractToolCatalog(lib/bridge.js 源码)
 *   table        <cwd>/qq-tools.json 解析结果且 enabled === true 时才是对象，否则 null
 *   sessionKeys  <cwd>/qq-sessions.json 里的会话键（g:/u: 开头）
 */
export function toolsView(input = {}) {
  const catalog = Array.isArray(input.catalog) ? input.catalog : []
  const table = input.table === null || input.table === undefined ? null : input.table
  const sessionKeys = Array.isArray(input.sessionKeys) ? input.sessionKeys : []
  const rules = sessionKeys.map((key) => {
    const rule = toolRuleFor(table, key)
    return {
      key: String(key),
      mode: rule === null ? '不限' : rule.mode,
      names: rule === null ? [] : rule.names,
      source: rule === null ? '—' : toolRuleSource(table, key),
    }
  })
  const missing = tableKeys(table).filter((key) => !keyInUse(key, sessionKeys))
  const warnings = [input.catalogError, input.tableError, input.sessionsError]
    .filter((item) => typeof item === 'string' && item !== '')
  return {
    generatedAt: Number(input.generatedAt) || 0,
    toolCount: catalog.length,
    tools: catalog,
    tableEnabled: table !== null,
    tableFile: String(input.tableFile ?? ''),
    sessionsFile: String(input.sessionsFile ?? ''),
    ruleCount: rules.filter((row) => row.mode !== '不限').length,
    rules,
    missing,
    warnings,
    note: '本页只读：生效值由桥在会话创建时读取（补丁 14），改表请用 tools/qq-tools.mjs。',
  }
}

/**
 * 【本地补丁 17 · 令牌与花费】把 <cwd>/qq-usage-summary.json 整理成页面数据（纯函数）。
 *
 * 控制台是独立进程，读不到桥内存；金额的定价只实现一次（在桥里），这里只做**排版与兜底**：
 * 文件不在（还没花过钱 / 桥没跑过）= 合法的空表，不是错误。
 */
export function usageView(input = {}) {
  const summary = input.summary === null || input.summary === undefined || typeof input.summary !== 'object' ? null : input.summary
  const warnings = [input.summaryError].filter((item) => typeof item === 'string' && item !== '')
  if (summary === null) {
    return {
      generatedAt: Number(input.generatedAt) || 0,
      file: String(input.summaryFile ?? ''),
      ledgerFile: String(input.ledgerFile ?? ''),
      empty: true,
      totals: { cny: 0, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      today: null,
      week: 0,
      days: [],
      chats: [],
      models: [],
      warnings,
      note: '还没有账本：桥会在模型完成一步后写一行到 qq-usage.jsonl，再用 /用量 或在控制台刷新查看。',
    }
  }
  const list = (value) => (Array.isArray(value) ? value : [])
  const totals = summary.totals === null || summary.totals === undefined ? {} : summary.totals
  const days = list(summary.days)
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  let today = null
  for (const row of days) {
    if (String(row.date ?? '') === day) today = row
  }
  let week = 0
  for (const row of days.slice(0, 7)) week += Number(row.cny) || 0
  return {
    generatedAt: Number(input.generatedAt) || 0,
    file: String(input.summaryFile ?? ''),
    ledgerFile: String(input.ledgerFile ?? summary.file ?? ''),
    empty: false,
    ledgerLines: Number(summary.ledgerLines) || 0,
    totals: {
      cny: Number(totals.cny) || 0,
      steps: Number(totals.steps) || 0,
      input: Number(totals.input) || 0,
      output: Number(totals.output) || 0,
      cacheRead: Number(totals.cacheRead) || 0,
      cacheWrite: Number(totals.cacheWrite) || 0,
      total: Number(totals.total) || 0,
    },
    today,
    week,
    days,
    chats: list(summary.chats),
    models: list(summary.models),
    warnings,
    note: String(summary.note ?? ''),
  }
}


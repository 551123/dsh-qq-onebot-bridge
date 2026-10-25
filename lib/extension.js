/**
 * 扩展接缝（v0.7.0「实验性与扩展」）。
 *
 * 给同宿主里的其它插件留**受控**入口，全部默认关/只读：
 *
 *   ① 实例出口 `ctx.qqBridge`：sendText / sendImage / sendFile / sendVoice（**复用原有护栏**，
 *      并额外按入站口径检查**目标**是否在白名单里）+ 只读快照 sessions() / agents() / config()。
 *   ② 只读事件 `qqbridge:inbound` / `qqbridge:outbound`：只能观察，**不能改写、不能拦截**。
 *   ③ 工具 provider 链（**实验性、默认关** `extensionToolsEnabled`）：第三方可以往每个会话注册
 *      工具与提示段；只能**新增**（不能覆盖内置）、provider 抛错就跳过、provider 名必须进 trace。
 *
 * 明确不做（0.6.9 评估结论，写在这里免得反复讨论）：
 *   - **出站内容改写 / 可拦截事件**：等于给第三方开"替机器人说话""静默吞消息"的旁路，风控打的是机器人账号；
 *   - 多账号 / 多实例；向量记忆 / 嵌入检索（与"轻量、零依赖"冲突）。
 *
 * 本文件只放**纯逻辑 + 挂载胶水**，方便脱离宿主单测；真正碰 agentCtx 的部分在 bridge.js。
 */
export const EXTENSION_SERVICE = 'qqBridge'
export const EXTENSION_VERSION = 1
export const EXTENSION_EVENTS = Object.freeze({
  inbound: 'qqbridge:inbound',
  outbound: 'qqbridge:outbound',
})

/** 每个 provider 最多贡献多少工具 / 提示段，以及总上限（防一个 provider 塞爆提示词）。 */
export const PROVIDER_LIMITS = Object.freeze({ toolsPerProvider: 8, sectionsPerProvider: 4, toolsTotal: 24, sectionsTotal: 12 })

/** 配置快照里必须抹掉的键（密钥类一律不出口）。 */
const SECRET_KEY = /(token|api[-_]?key|secret|password|passwd|cookie|credential)/i

/**
 * 给第三方看的配置快照：**浅拷贝 + 抹掉密钥类键**。
 * 数组复制一份，避免调用方 push 改到桥。
 */
export function redactConfig(config = {}) {
  const safe = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    if (SECRET_KEY.test(key)) continue
    safe[key] = Array.isArray(value) ? [...value] : value
  }
  return safe
}

/** 模块级注册表：同一个 Node 进程里 `import` 到同一份模块的插件可以拿它当兜底。 */
const registry = { api: null }

export function publishExtensionApi(api) {
  registry.api = api
  return api
}

export function getExtensionApi() {
  return registry.api
}

/**
 * 把出口挂到宿主 ctx 上，按可用性依次尝试：
 *   1. `ctx.set(name, value)`（cordis 新版）
 *   2. `ctx.provide(name)` + `ctx[name] = value`（cordis 旧版；本机实测走这条）
 *   3. 只写模块级注册表（其它插件 `getExtensionApi()` 仍能拿到）
 *
 * 返回 `{ ok, via, reason }`；**永不抛**（挂不上只是少一个入口，不能影响 QQ 桥）。
 */
export function attachExtensionService(ctx, api) {
  publishExtensionApi(api)
  const failures = []
  if (typeof ctx?.set === 'function') {
    try {
      ctx.set(EXTENSION_SERVICE, api)
      return { ok: true, via: 'ctx.set', reason: '' }
    } catch (error) {
      failures.push(`ctx.set: ${error?.message ?? error}`)
    }
  }
  if (typeof ctx?.provide === 'function') {
    try {
      ctx.provide(EXTENSION_SERVICE)
      ctx[EXTENSION_SERVICE] = api
      return { ok: true, via: 'ctx.provide', reason: '' }
    } catch (error) {
      failures.push(`ctx.provide: ${error?.message ?? error}`)
    }
  }
  return {
    ok: false,
    via: 'module-registry',
    reason: failures.length > 0 ? failures.join('; ') : '宿主既没有 ctx.set 也没有 ctx.provide',
  }
}

/**
 * 工具 provider 链的**纯逻辑**部分（v0.7.0 实验性）。
 *
 * 输入：
 *   - `providers`：`[{ name, fn }]`（`fn(context)` 返回 `{ tools, sections }`）；
 *   - `context`：传给每个 provider 的东西（agentCtx / route / key / 脱敏后的 config）；
 *   - `builtinNames`：内置工具名，**外部工具不许覆盖**；
 *   - `limits`：条数上限（见 `PROVIDER_LIMITS`）。
 *
 * 输出 `{ tools, sections, notes, skipped }`：
 *   - `tools`：要注册的工具（`defineTool` 的返回值，带 `.name`）；名字重复/撞内置/形状不对的一律丢弃；
 *   - `sections`：`{ name, order, text }`，name 保证唯一（`ext:<provider>:<i>`）；
 *   - `notes`：给 trace 用的人话（"provider X 注册了 2 个工具 / 1 段提示"）；
 *   - `skipped`：`{ provider, reason }`，同样进 trace —— **不许静默**。
 *
 * 设计纪律：provider 抛错只跳过它自己（一个坏的第三方不能拖垮这条消息）；上限只防"塞爆提示词"。
 *
 * **超时**（issue #4 提的那条）：JS 不能抢占一个同步函数，所以这里做的是**两道现实的保护**——
 *   1. provider 返回 Promise 一律跳过（会话 setup 是同步链路，异步 provider 会拖住这条消息）；
 *   2. 整轮 provider 调用有**时间预算**（默认 200ms）：超了就不再调用后面的 provider，并在 skipped 里写明。
 */
export function collectProviderAdditions({
  providers = [],
  context = {},
  builtinNames = [],
  limits = PROVIDER_LIMITS,
  budgetMs = 200,
  now = () => Date.now(),
} = {}) {
  const tools = []
  const sections = []
  const notes = []
  const skipped = []
  const takenTool = new Set(builtinNames.map(String))
  const takenSection = new Set(['qq-onebot-bridge', 'qq-persistent-memory'])
  const started = now()

  const list = Array.isArray(providers) ? providers : []
  for (let index = 0; index < list.length; index += 1) {
    const provider = list[index]
    const name = typeof provider?.name === 'string' && provider.name !== '' ? provider.name : '(unnamed)'
    // 预算检查从**第二个** provider 开始：第一个总要试一次，否则"慢的第一个"会让整条链完全不生效。
    if (index > 0 && budgetMs > 0) {
      const elapsed = Math.max(0, now() - started)
      if (elapsed > budgetMs) {
        skipped.push({ provider: name, reason: `provider 时间预算用尽（已用 ${elapsed}ms，上限 ${budgetMs}ms），后面的 provider 不再调用` })
        continue
      }
    }
    let result
    try {
      result = provider?.fn?.(context)
    } catch (error) {
      skipped.push({ provider: name, reason: `抛错：${error?.message ?? error}` })
      continue
    }
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      // 异步 provider：会话 setup 是同步链路，await 会拖住消息处理 ⇒ 明确拒绝并说清。
      skipped.push({ provider: name, reason: '返回了 Promise（实验阶段只支持同步 provider：结果必须立刻可用）' })
      continue
    }
    if (result === null || typeof result !== 'object') {
      skipped.push({ provider: name, reason: '没有返回对象（应为 { tools?, sections? }）' })
      continue
    }
    const rawTools = Array.isArray(result.tools) ? result.tools : []
    const rawSections = Array.isArray(result.sections) ? result.sections : []
    let addedTools = 0
    let addedSections = 0

    for (const tool of rawTools.slice(0, limits.toolsPerProvider)) {
      if (tools.length >= limits.toolsTotal) { skipped.push({ provider: name, reason: `工具总数超过 ${limits.toolsTotal}，后面的被丢弃` }); break }
      const toolName = typeof tool?.name === 'string' ? tool.name : ''
      if (toolName === '') { skipped.push({ provider: name, reason: '工具有个没有 name（defineTool 的返回值）' }); continue }
      if (takenTool.has(toolName)) {
        skipped.push({ provider: name, reason: `工具名 ${toolName} 与已有工具冲突（外部工具只能新增，不能覆盖）` })
        continue
      }
      takenTool.add(toolName)
      tools.push(tool)
      addedTools += 1
    }

    for (const section of rawSections.slice(0, limits.sectionsPerProvider)) {
      if (sections.length >= limits.sectionsTotal) { skipped.push({ provider: name, reason: `提示段总数超过 ${limits.sectionsTotal}，后面的被丢弃` }); break }
      const text = typeof section?.text === 'string' ? section.text.trim() : ''
      if (text === '') { skipped.push({ provider: name, reason: '提示段缺 text' }); continue }
      const order = Number.isFinite(Number(section?.order)) ? Number(section.order) : 200
      let sectionName = typeof section?.name === 'string' && section.name !== '' ? section.name : ''
      if (sectionName === '' || takenSection.has(sectionName)) sectionName = `ext:${name}:${addedSections + 1}`
      takenSection.add(sectionName)
      sections.push({ name: sectionName, order, text })
      addedSections += 1
    }

    if (addedTools > 0 || addedSections > 0) {
      notes.push(`provider「${name}」注册了 ${addedTools} 个工具 / ${addedSections} 段提示`)
    } else if (rawTools.length === 0 && rawSections.length === 0) {
      notes.push(`provider「${name}」没有贡献任何工具或提示段`)
    }
  }

  return { tools, sections, notes, skipped }
}

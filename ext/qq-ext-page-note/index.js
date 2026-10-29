/**
 * qq-ext-page-note —— 页面 3 + 笔记 3 个 QQ 工具的外部插件（外壳）。
 *
 * 这个文件是**稳定外壳**，只做三件事：等出口、加载 body.mjs、把 provider 注册进去。
 * 真正的工具实现在 ./body.mjs（页面 3 + 笔记 3，2026-10-26 从补丁 44 迁出）—— 因为 cordis 的 live reload 只重新 apply、不重新 import
 * 已加载模块（Step 1 实测），所以外壳每次 apply 都带时间戳重新 import body，
 * 于是「改工具 → 碰一下 cordis.patch.yml 触发 live reload → 新工具生效」不需要重启宿主。
 *
 * 为什么要插件化（补丁器插件化路线的地基验证，2026-10-26）：
 *   1. 一个装在 profiles/web/node_modules 下的独立包，用 cordis.patch.yml 的 `- insert:` 就能加载；
 *   2. 它能在宿主启动顺序不确定时拿到 ctx.qqBridge 出口（file:// 绝对 import + getExtensionApi
 *      是 Step 1 门禁测出来的唯一可行路径：ctx.qqBridge 需要 inject 声明，optional 形式会永远 pending）；
 *   3. registerToolProvider 注册的工具真的会进每个会话的工具面（bridge.js #installSession → #installProviderTools）；
 *   4. 工具实现完全不碰上游 node_modules 里的任何文件 —— 升级上游对它零影响。
 *
 * 配置（cordis.patch.yml 里 qq-ext-page-note 的 config，都可省）：
 *   两组工具各有一个门禁（与桥的 config 同名同义，默认都开）：
 *   pageToolsEnabled: false 时不下发 qq_page_open / qq_page_grep / qq_page_read；
 *   noteToolsEnabled: false 时不下发 qq_note_save / qq_note_list / qq_note_read。
 *   其余配置（pageCacheDir / pageCacheTtlDays / pageCacheMaxPages / pageCacheMaxBytes /
 *   noteDir / noteMaxFileBytes）原样透传给 body，语义与桥里同名键一致。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'qq-ext-page-note'

/**
 * 出口模块的 file:// 地址（package.json 的 exports 不含 ./lib/extension.js，只能按绝对路径 import）。
 *
 * 解析顺序：
 *   1. 环境变量 QQBRIDGE_EXT_PATH —— 路径或 file:// URL 都收，指的文件不存在时告警并往下走；
 *   2. 同装目录的兄弟包 ../dsh-qq-onebot-bridge/lib/extension.js —— 默认布局
 *      （profiles/web/node_modules/qq-ext-* 与 dsh-qq-onebot-bridge 并排），换机器、换 profile 名都不用改；
 *   3. 都没有就返回 2 的地址，让 import 抛错时把路径带出来（比静默降级好查）。
 *
 * 早先这里写死过某台机器用户目录下的绝对路径：换机器即失效，也不该出现在公开仓库里。
 */
const DEFAULT_BRIDGE_EXT = new URL('../dsh-qq-onebot-bridge/lib/extension.js', import.meta.url)

const resolveBridgeExt = () => {
  const raw = String(process.env.QQBRIDGE_EXT_PATH || '').trim()
  if (raw) {
    const url = /^file:/i.test(raw) ? new URL(raw) : pathToFileURL(raw)
    if (existsSync(fileURLToPath(url))) return url.href
    console.warn('[qq-ext] QQBRIDGE_EXT_PATH 指向的文件不存在，改用默认位置：' + raw)
  }
  return DEFAULT_BRIDGE_EXT.href
}

export const bridgeExtUrl = resolveBridgeExt()

/**
 * 桥的 `./extension` 导出（v0.7.4 起 package.json 里开了这一项）：标准布局下
 * `import('dsh-qq-onebot-bridge/extension')` 就能解析到 lib/extension.js，不用再猜兄弟包的相对路径。
 */
const BRIDGE_EXPORT_SPECIFIER = 'dsh-qq-onebot-bridge/extension'

/** 解析成功的 specifier 记住，之后只试它 —— 已经失败过的别每 5 秒再试一遍。 */
let bridgeSpecifier = ''

/**
 * 按优先级拿出口模块：
 *   1. QQBRIDGE_EXT_PATH（bridgeExtUrl 已经是它，且文件确认存在）—— 显式覆盖最优先；
 *   2. 包的 ./extension 导出 —— 上游 v0.7.4 起的正路；
 *   3. 兄弟包绝对路径（bridgeExtUrl 的默认值）—— 老版本没开 exports 时兜底。
 */
const loadBridgeExtension = async () => {
  const explicit = String(process.env.QQBRIDGE_EXT_PATH || '').trim() !== ''
  const candidates = bridgeSpecifier
    ? [bridgeSpecifier]
    : [explicit ? bridgeExtUrl : null, BRIDGE_EXPORT_SPECIFIER, bridgeExtUrl].filter(Boolean)
  let lastError = null
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      bridgeSpecifier = spec
      return mod
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('qq-ext: 桥的 extension 模块解析不到')
}


/** body 也走 file URL：让缓存破坏参数（?t=）能生效。 */
const BODY = new URL('./body.mjs', import.meta.url).href

/** 跨 apply 保留的注册状态（见 apply 里的注释：live reload 复用模块实例，state 必须放在这里）。 */
const moduleState = { disposer: null }

/**
 * 把 body 里的 provider 接到出口上。抽成导出函数是为了能单测（假 api 即可，不需要真宿主）。
 * 同一个 state 反复 attach 时，先取消上一次注册，避免桥的 toolProviders 里堆一串同名 provider
 * （那样每次注入都会多一条「同名工具被跳过」的 skipped，脏日志还拖慢 200ms 预算）。
 */
export async function attach(api, state = {}, opts = {}) {
  if (typeof state.disposer === 'function') {
    try { state.disposer() } catch { /* 桥实例已重建，旧 disposer 失效属正常 */ }
  }
  state.disposer = null
  const body = await import(BODY + '?t=' + String(opts.stamp ?? Date.now()))
  const fn = typeof body?.provider === 'function' ? body.provider : null
  if (!fn) {
    console.warn('[qq-ext-page-note] body.mjs 没有导出 provider —— 这一包的能力不会出现在工具清单里')
    return { registered: false, reason: 'body.mjs 没有导出 provider' }
  }
  state.disposer = api.registerToolProvider((context) => {
    try {
      return fn(context)
    } catch (error) {
      // 上游 registerToolProvider 只读 tools / sections，返回里的 reason 会被直接忽略 —— 那等于静默失败。
      // 抛出去才会被桥记进 trace / skipped，面板「实验性」组才看得见是哪一包挂了。
      throw new Error('qq-ext-page-note: ' + String(error?.message ?? error))
    }
  }, { name: name + (body.variant ? '#' + body.variant : '') })
  return { registered: true, variant: body.variant ?? '', tools: body.provider?.({ config: {} })?.tools?.length ?? 0 }
}

/**
 * cordis 插件入口。故意**不写模块级 inject 声明**：Step 1 实测 `export const inject = {optional:['qqBridge']}`
 * 会让插件永远 pending、apply 根本不执行。改成一个自限次数的轮询：出口一可用就注册，注册完就停；
 * live reload 再次 apply 时会重新加载 body 并替换注册。
 */
export function apply(ctx, config) {
  // state 必须是**模块级**：cordis 的 live reload 会重新 apply，但复用同一个模块实例。
  const state = moduleState
  let lastApi = null
  let inflight = false

  /**
   * 出口上还挂着我们这个 provider 吗？桥的 api.toolProviders() 返回名字数组，
   * 名字带 #variant 后缀，所以按前缀比。
   */
  const stillMounted = () => {
    if (typeof lastApi?.toolProviders !== 'function') return false
    try {
      const names = lastApi.toolProviders()
      return Array.isArray(names) && names.some((n) => String(n) === name || String(n).startsWith(name + '#'))
    } catch {
      return false
    }
  }

  /**
   * 轮询出口直到可用；**注册成功后不停轮询**。原因（2026-10-26 实测）：桥实例随时可能重建
   * （宿主重启 / live reload / 面板点开关），新实例的 toolProviders 是空的，而自停式轮询
   * 再也醒不过来 —— house 包就这样静默丢了能力，直到改本 entry 的 config 重新 apply 才回来。
   * 所以每 5s 醒一次，只判断两件事：出口换人了没、我们的注册还在不在。
   */
  const attempt = async () => {
    if (inflight) return
    inflight = true
    try {
      const mod = await loadBridgeExtension()
      const api = typeof mod?.getExtensionApi === 'function' ? mod.getExtensionApi() : null
      if (!api || typeof api.registerToolProvider !== 'function') return
      if (api === lastApi && stillMounted()) return
      const out = await attach(api, state, { stamp: Date.now() })
      if (out && out.registered) lastApi = api
    } catch {
      // 出口还没挂上 / 桥正在重建：下一轮再看，绝不让异常冒出去影响宿主
    } finally {
      inflight = false
    }
  }

  const timer = setInterval(() => void attempt(), 5000)
  if (typeof timer?.unref === 'function') timer.unref()
  const first = setTimeout(() => void attempt(), 300)
  if (typeof first?.unref === 'function') first.unref()
}

export default { name, apply }
/**
 * qq-ext-face —— 收藏表情（QQ「我的表情」）的插件外壳。
 *
 * 这个文件只做三件事：等出口、加载 body.mjs、把 provider 注册进去（结构和 qq-ext-house-lite 一致）。
 * 真正的工具在 ./body.mjs —— cordis 的 live reload 只重新 apply、不重新 import 已加载模块，
 * 所以外壳每次 apply 都带时间戳重新 import body：改工具 → 碰一下 cordis.patch.yml 触发 reload → 新工具生效，
 * 不需要重启宿主（改**本文件**仍然要重启）。
 *
 * 出口路径解析顺序（与 house-lite 同一套）：
 *   1. 环境变量 QQBRIDGE_EXT_PATH（路径或 file:// 都收）；
 *   2. 同装目录的兄弟包 ../dsh-qq-onebot-bridge/lib/extension.js —— 默认布局；
 *   3. 都没有就返回 2 的地址，让 import 抛错时把路径带出来。
 *
 * 配置（cordis.patch.yml 里 qq-ext-face 的 config，都可省）：
 *   faceToolsEnabled   false = 一个工具都不出（面板能力勾选仍然管用）
 *   facePromptSection  false = 不注入【表情包】那段常驻提示（省 token）
 */

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'qq-ext-face'

const DEFAULT_BRIDGE_EXT = new URL('../dsh-qq-onebot-bridge/lib/extension.js', import.meta.url)

const resolveBridgeExt = () => {
  const raw = String(process.env.QQBRIDGE_EXT_PATH || '').trim()
  if (raw) {
    const url = /^file:/i.test(raw) ? new URL(raw) : pathToFileURL(raw)
    if (existsSync(fileURLToPath(url))) return url.href
    console.warn('[qq-ext-face] QQBRIDGE_EXT_PATH 指向的文件不存在，改用默认位置：' + raw)
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


const BODY = new URL('./body.mjs', import.meta.url).href

/** 跨 apply 保留的注册状态：live reload 复用模块实例，state 必须放模块级（否则 provider 越堆越多）。 */
const moduleState = { disposer: null }

/**
 * 把 body 里的 provider 接到出口上（导出是为了能单测：假 api 即可，不需要真宿主）。
 * 反复 attach 时先取消上一次注册，避免桥的 toolProviders 里堆一串同名 provider。
 */
export async function attach(api, state = {}, opts = {}) {
  if (typeof state.disposer === 'function') {
    try { state.disposer() } catch { /* 桥实例已重建，旧 disposer 失效属正常 */ }
  }
  state.disposer = null
  const body = await import(BODY + '?t=' + String(opts.stamp ?? Date.now()))
  const fn = typeof body?.provider === 'function' ? body.provider : null
  if (!fn) {
    console.warn('[qq-ext-face] body.mjs 没有导出 provider —— 这一包的能力不会出现在工具清单里')
    return { registered: false, reason: 'body.mjs 没有导出 provider' }
  }
  state.disposer = api.registerToolProvider((context) => {
    try {
      // provider 拿不到出口实例（context 里只有 agentCtx/route/key/config），
      // qq_face_send 要用 sendImage，所以在**同步**调用前把 api 塞进去（同步返回，不违反 provider 契约）。
      return fn({ ...context, extApi: api })
    } catch (error) {
      // 上游 registerToolProvider 只读 tools / sections，返回里的 reason 会被直接忽略 —— 那等于静默失败。
      // 抛出去才会被桥记进 trace / skipped，面板「实验性」组才看得见是哪一包挂了。
      throw new Error('qq-ext-face: ' + String(error?.message ?? error))
    }
  }, { name: name + (body.variant ? '#' + body.variant : '') })
  return { registered: true, variant: body.variant ?? '' }
}

/**
 * cordis 插件入口。**不写模块级 inject 声明**（`inject: {optional:['qqBridge']}` 会永远 pending），
 * 改成自限次数的轮询：出口一可用就注册；之后每 5s 醒一次只判断「出口换人了没、注册还在不在」，
 * 因为桥实例随时可能重建（宿主重启 / live reload / 面板开关），新实例的 toolProviders 是空的。
 */
export function apply(ctx, config) {
  const state = moduleState
  let lastApi = null
  let inflight = false

  const stillMounted = () => {
    if (typeof lastApi?.toolProviders !== 'function') return false
    try {
      const names = lastApi.toolProviders()
      return Array.isArray(names) && names.some((n) => String(n) === name || String(n).startsWith(name + '#'))
    } catch {
      return false
    }
  }

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

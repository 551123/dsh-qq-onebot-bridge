/**
 * qq-ext-memory —— 记忆卡片检索（词法 + BGE 语义）的外部插件外壳。
 *
 * 只做三件事：轮询拿到桥的 extension 出口、带 ?t= 重新 import body.mjs、把 provider 注册进去。
 * 真正的实现在 body.mjs：改它不用重启宿主，碰一下 cordis.patch.yml 触发 live reload 即可。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'qq-ext-memory'

const DEFAULT_BRIDGE_EXT = new URL('../dsh-qq-onebot-bridge/lib/extension.js', import.meta.url)

const resolveBridgeExt = () => {
  const raw = String(process.env.QQBRIDGE_EXT_PATH || '').trim()
  if (raw) {
    const url = /^file:/i.test(raw) ? new URL(raw) : pathToFileURL(raw)
    if (existsSync(fileURLToPath(url))) return url.href
    console.warn('[qq-ext-memory] QQBRIDGE_EXT_PATH 指向的文件不存在，改用默认位置：' + raw)
  }
  return DEFAULT_BRIDGE_EXT.href
}

export const bridgeExtUrl = resolveBridgeExt()
const BRIDGE_EXPORT_SPECIFIER = 'dsh-qq-onebot-bridge/extension'
let bridgeSpecifier = ''

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
  throw lastError ?? new Error('qq-ext-memory: 桥的 extension 模块解析不到')
}

const BODY = new URL('./body.mjs', import.meta.url).href
const moduleState = { disposer: null, config: {} }

export async function attach(api, state = {}, opts = {}) {
  if (typeof state.disposer === 'function') {
    try { state.disposer() } catch { /* 桥实例已重建，旧 disposer 失效属正常 */ }
  }
  state.disposer = null
  const body = await import(BODY + '?t=' + String(opts.stamp ?? Date.now()))
  const fn = typeof body?.provider === 'function' ? body.provider : null
  if (!fn) {
    console.warn('[qq-ext-memory] body.mjs 没有导出 provider —— 这一包的能力不会出现在工具清单里')
    return { registered: false, reason: 'body.mjs 没有导出 provider' }
  }
  state.config = opts.config ?? state.config ?? {}
  state.disposer = api.registerToolProvider((context) => {
    try {
      return fn({ ...context, extConfig: state.config ?? {} })
    } catch (error) {
      throw new Error('qq-ext-memory: ' + String(error?.message ?? error))
    }
  }, { name: name + (body.variant ? '#' + body.variant : '') })
  return { registered: true, variant: body.variant ?? '' }
}

export function apply(ctx, config) {
  const state = moduleState
  state.config = config ?? state.config ?? {}
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
      const out = await attach(api, state, { stamp: Date.now(), config: state.config })
      if (out && out.registered) lastApi = api
    } catch {
      // 出口还没挂上 / 桥正在重建：下一轮再看
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

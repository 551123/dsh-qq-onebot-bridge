/**
 * Control-console configuration: one source of truth for every port and every
 * executable the console manages. Everything is auto-detected with overrides,
 * so the same file works on another machine without editing code.
 *
 * Config file: <repo>/qq-control.json   (machine-local, git-ignored)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectNapcatBat, NAPCAT_BAT_HINT } from '../../lib/napcat-launch.js'

/** Ports the console cares about. 6700 is pinned by the OneBot client config. */
export const DEFAULT_PORTS = {
  control: 8799,   // this console itself (127.0.0.1 only)
  host: 3080,      // dsh web host: bot console UI + HTTP API
  onebot: 6700,    // reverse WebSocket the bridge listens on (NapCat connects)
  napcat: 6099,    // NapCat WebUI (QR login)
  tts: 9880,       // local GPT-SoVITS service (optional)
}

/** Human-readable labels used by the UI and the CLI summary. */
export const PORT_LABELS = {
  control: '控制台',
  host: 'DSH 宿主（机器人控制台）',
  onebot: 'OneBot 反向 WS（桥监听）',
  napcat: 'NapCat WebUI（QQ助手账号 / 扫码）',
  tts: 'GPT-SoVITS 本地语音',
}

/** Ports the console is allowed to free by killing the occupying process. */
export const FREEABLE_PORTS = ['host', 'onebot', 'napcat', 'tts']

const DEFAULTS = {
  cwd: '',
  nodeExe: '',
  dshBin: '',
  napcatBat: '',
  napcatQr: '',
  ttsBat: '',
  pluginRoot: '',
  logs: { hostOut: '', hostErr: '', bridge: '' },
  extraDirs: [],
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) return resolve(candidate)
    } catch { /* ignore */ }
  }
  return ''
}

/** Newest `@deepseek-ai/dsh` bin.js under the usual npx cache roots. */
export function detectDshBin({ roots = [], readdir = readdirSync, exists = existsSync } = {}) {
  const found = []
  for (const root of roots) {
    if (!root) continue
    let entries = []
    try { entries = readdir(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (exists(candidate)) found.push(candidate)
    }
  }
  if (found.length === 0) return ''
  found.sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs } catch { return 0 }
  })
  return resolve(found[0])
}

/**
 * npx cache roots worth probing, derived from the ENVIRONMENT and the location of
 * the running node — never from a hardcoded absolute path (a published plugin must
 * not carry the author's `C:\Users\<name>` or `D:\...` layout).
 */
export function npxCacheRoots({ env = process.env, execPath = process.execPath } = {}) {
  const home = env.USERPROFILE || env.HOME || ''
  const localAppData = env.LOCALAPPDATA || (home ? join(home, 'AppData', 'Local') : '')
  const roamingAppData = env.APPDATA || (home ? join(home, 'AppData', 'Roaming') : '')
  const roots = []
  const push = (value) => { if (value && !roots.includes(value)) roots.push(value) }
  // 1) 显式覆盖优先
  for (const key of ['DSH_NPX_CACHE', 'npm_config_cache', 'NPM_CONFIG_CACHE']) {
    const value = env[key]
    if (!value) continue
    push(value.endsWith('_npx') ? value : join(value, '_npx'))
  }
  // 2) npm 默认缓存位置
  if (localAppData) push(join(localAppData, 'npm-cache', '_npx'))
  if (roamingAppData) push(join(roamingAppData, 'npm-cache', '_npx'))
  // 3) 以 node 自身位置为锚：<node>\..\_npx、<node>\node_cache\_npx、<盘>:\nodejs\node_cache\_npx
  try {
    const nodeDir = dirname(execPath)
    const driveRoot = parse(execPath).root
    push(join(nodeDir, '_npx'))
    push(join(nodeDir, 'node_cache', '_npx'))
    if (driveRoot) {
      push(join(driveRoot, 'nodejs', 'node_cache', '_npx'))
      push(join(driveRoot, 'node_cache', '_npx'))
    }
  } catch { /* 拿不到 node 位置就只用环境变量 */ }
  return roots
}

/** 本模块所属的 profile 目录（<DSH_HOME>/profiles/<名字>）：控制台就在这个 profile 的 node_modules 里。 */
function selfProfileDir() {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    if (basename(parent).toLowerCase() === 'profiles') return dir
    dir = parent
  }
  return ''
}

/** 宿主 profile 根：用来找 cordis.patch.yml（DSH_HOME/profiles/*）。 */
function profileRoots({ env }) {
  const roots = []
  const home = env.DSH_HOME || env.USERPROFILE || env.HOME || ''
  if (home) roots.push(join(home, 'profiles'))
  if (env.USERPROFILE) roots.push(join(env.USERPROFILE, '.dsh', 'profiles'))
  return roots
}

/** 两个路径是不是同一个目录（忽略分隔符方向、大小写、结尾斜杠 —— Windows 上这三种写法满天飞）。 */
export function samePath(a, b) {
  const norm = (value) => String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const left = norm(a)
  const right = norm(b)
  return left !== '' && left === right
}

/** 从 cordis.patch.yml 正文里抠出 QQ 桥那一段的 config.cwd（找不到就是空串）。 */
export function bridgeCwdFromYaml(text) {
  let inside = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const idMatch = /^\s*-\s+id:\s*(\S+)/.exec(line)
    if (idMatch) {
      inside = idMatch[1] === 'dsh-qq-onebot-bridge'
      continue
    }
    if (!inside) continue
    const cwdMatch = /^\s+cwd:\s*(.+)$/.exec(line)
    if (cwdMatch) {
      const raw = cwdMatch[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
      if (raw !== '') return raw
    }
  }
  return ''
}

/**
 * 桥的**真实**工作目录。
 *
 * 为什么需要它：控制台的 cwd 是控制台自己的设置项，桥的 cwd 在宿主配置 cordis.patch.yml 里。
 * 两者不一致时，控制台会去读一个永远不存在的 qq-runtime.json —— 面板只丢一句「桥：无快照」，
 * 人根本猜不到是路径问题；同一次不一致还会让日志/收件箱/trace 全读空、能力表写进没人读的目录。
 *
 * 机器上常有多个 profile（web / desktop / probe / 备份），所以按证据挑，不是随便取第一个：
 * 先看**控制台自己所属的 profile**，再看哪个目录里真有 qq-runtime.json（= 桥确实在那儿跑），
 * 最后才看 yml 的新旧。
 */
export function discoverBridgeCwd({ env = process.env, exists = existsSync, readdir = readdirSync, readFile = readFileSync, self = '' } = {}) {
  const candidates = []
  const push = (file, cwd) => {
    const dir = resolve(cwd)
    if (candidates.some((item) => samePath(item.dir, dir))) return
    let score = 0
    if (exists(join(dir, 'qq-runtime.json'))) score += 4
    if (exists(join(dir, 'qq-sessions.json'))) score += 2
    if (exists(join(dir, 'qq-inbox.jsonl'))) score += 1
    if (self !== '' && samePath(dirname(dirname(file)), self)) score += 8
    let mtime = 0
    try { mtime = statSync(file).mtimeMs } catch { mtime = 0 }
    candidates.push({ dir, score, mtime })
  }
  for (const root of profileRoots({ env })) {
    let names = []
    try { names = readdir(root) } catch { continue }
    for (const name of names) {
      const file = join(root, name, 'cordis.patch.yml')
      if (!exists(file)) continue
      let text = ''
      try { text = String(readFile(file, 'utf8')) } catch { continue }
      const found = bridgeCwdFromYaml(text)
      if (found !== '') push(file, found)
    }
  }
  if (candidates.length === 0) return ''
  candidates.sort((a, b) => (b.score - a.score) || (b.mtime - a.mtime))
  return candidates[0].dir
}

/** Fill in everything that can be discovered on this machine. */
export function detectPaths(config = {}, { env = process.env, exists = existsSync, readdir = readdirSync } = {}) {
  const home = env.USERPROFILE || env.HOME || ''
  const localAppData = env.LOCALAPPDATA || (home ? join(home, 'AppData', 'Local') : '')
  // cwd 只能来自配置或环境变量（默认当前目录）：插件不该假设任何人的工作目录路径
  const cwd = config.cwd || env.DSH_QQ_CWD || process.cwd()

  const dshBin = firstExisting([
    config.dshBin,
    env.DSH_WEB_BIN,
    detectDshBin({ roots: npxCacheRoots({ env }), readdir, exists }),
    join(localAppData, 'Programs', 'DSH Desktop', 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ])

  // NapCat 启动脚本：候选表住在 `lib/napcat-launch.js`（DSH 面板读的是**同一份**探测结果，
  // 免得出现"控制台自己找到了、面板还说没配"——issue #2 就是这么来的）。
  const detectedNapcat = detectNapcatBat({ configured: config.napcatBat, env, exists })
  const napcatBat = detectedNapcat === '' ? '' : resolve(detectedNapcat)
  const napcatQr = firstExisting([
    config.napcatQr,
    napcatBat ? join(dirname(napcatBat), 'cache', 'qrcode.png') : '',
  ])
  const ttsBat = firstExisting([
    config.ttsBat,
    cwd ? join(cwd, 'GPT-SoVITS', 'TTS控制.bat') : '',
  ])

  return {
    ...DEFAULTS,
    ...config,
    cwd,
    // 桥在宿主配置（cordis.patch.yml）里指定的工作目录：控制台 cwd 要与它一致，
    // 否则运行快照 / 日志 / 能力表全会读错地方（issue #2 的「桥：无快照」就是这么来的）。
    bridgeCwd: config.bridgeCwd || discoverBridgeCwd({ env, exists, readdir, self: selfProfileDir() }),
    nodeExe: config.nodeExe || process.execPath,
    dshBin,
    napcatBat,
    napcatQr,
    ttsBat,
    logs: {
      hostOut: config.logs?.hostOut || (cwd ? join(cwd, 'qq-host-out.log') : ''),
      hostErr: config.logs?.hostErr || (cwd ? join(cwd, 'qq-host-err.log') : ''),
      bridge: config.logs?.bridge || (cwd ? join(cwd, 'qq-bridge-debug.log') : ''),
      trace: config.logs?.trace || (cwd ? join(cwd, 'qq-trace.jsonl') : ''),
      audit: config.logs?.audit || (cwd ? join(cwd, 'qq-actions.log') : ''),
      runtime: config.logs?.runtime || (cwd ? join(cwd, 'qq-runtime.json') : ''),
      // 录制（收到的每条消息）与注入队列（控制台写、桥轮询读）
      inbox: config.logs?.inbox || (cwd ? join(cwd, 'qq-inbox.jsonl') : ''),
      inject: config.logs?.inject || (cwd ? join(cwd, 'qq-inject.jsonl') : ''),
    },
    ports: { ...DEFAULT_PORTS, ...(config.ports ?? {}) },
    extraDirs: Array.isArray(config.extraDirs) ? config.extraDirs : [],
  }
}

/** Load a config file (missing/corrupt files fall back to auto-detection). */
export function loadControlConfig(file, options = {}) {
  let raw = {}
  try { raw = JSON.parse(readFileSync(file, 'utf8')) ?? {} } catch { raw = {} }
  return { file, config: detectPaths(raw, options) }
}

export function saveControlConfig(file, config) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Non-fatal problems worth showing in the UI (missing binaries, bad ports). */
export function configWarnings(config) {
  const warnings = []
  for (const [name, value] of Object.entries(config.ports ?? {})) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) warnings.push(`端口配置非法：${name}=${value}`)
  }
  if (!config.nodeExe) warnings.push('找不到 node 可执行文件（nodeExe）')
  else if (!existsSync(config.nodeExe)) warnings.push(`node 可执行文件不存在：${config.nodeExe}`)
  if (!config.dshBin) warnings.push('找不到 dsh bin.js（无法启动宿主，可用 dshBin 手动指定）')
  else if (!existsSync(config.dshBin)) warnings.push(`dsh bin.js 不存在：${config.dshBin}`)
  if (!config.napcatBat) warnings.push(`找不到 NapCat 启动脚本（napcatBat）：${NAPCAT_BAT_HINT}`)
  if (!config.cwd) warnings.push('未设置宿主工作目录（cwd）')
  // 控制台 cwd ≠ 桥 cwd：快照/日志读空，能力表写进没人读的目录 —— 必须说出来
  if (config.cwd && config.bridgeCwd && !samePath(config.cwd, config.bridgeCwd)) {
    warnings.push(`控制台工作目录（${config.cwd}）和桥的实际工作目录（${config.bridgeCwd}）不一致：运行快照 / 日志会读空、能力表会写进没人读的目录 → 点配置里那个「用桥的目录」一键对齐`)
  }
  return warnings
}

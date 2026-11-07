/**
 * 账号中心：SnowLuma 侧（第二协议端）的契约测试。
 * 覆盖三块：
 *   ① 纯读取函数（runtime.json / webui.json / 口令文件 / 账号清单正则）；
 *   ② 侧别判定 resolveProtocolSide（写死、auto 四态、端口探测可注入）；
 *   ③ SnowLuma WebUI 客户端与 createAccountsApi 的 snowluma 分支（全部用假 fetch，不联网）。
 * 另有一条 NapCat 分支的不回归断言：webui.json 正常时 summary 仍按 NapCat 出，且不带 side 泄漏。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAccountsApi, createSnowLumaClient, listAccounts, publicSnowLumaConfig,
  readSnowLumaRuntime, readSnowLumaSecret, readSnowLumaWebUi, resolveProtocolSide,
} from '../control/lib/accounts.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (value) => JSON.stringify(value ?? null).slice(0, 240)

const dir = mkdtempSync(join(tmpdir(), 'qq-snowluma-'))
const root = join(dir, 'SnowLuma')
const cfg = join(root, 'config')
mkdirSync(cfg, { recursive: true })
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@snowluma/runtime', version: '2.4.2' }))
writeFileSync(join(cfg, 'runtime.json'), JSON.stringify({ webuiPort: 5099, webuiHost: '0.0.0.0', webuiTls: { enabled: false } }))
const HASH = 'a'.repeat(128)
const SALT = 'b'.repeat(32)
writeFileSync(join(cfg, 'webui.json'), JSON.stringify({ passwordHash: HASH, passwordSalt: SALT, mustChangePassword: false, updatedAt: '2026-11-07T21:19:13.130Z' }))
writeFileSync(join(cfg, 'onebot_123456789.json'), JSON.stringify({ networks: { wsServers: [{ name: 'ws', port: 3001, token: 'tk' }], wsClients: [], httpServers: [{ port: 3002 }] } }))

// ---------- ① 读取函数 ----------
{
  const runtime = readSnowLumaRuntime({ dir: root })
  check('runtime：package.json + runtime.json 都读到', runtime.exists === true && runtime.installed === true
    && runtime.port === 5099 && runtime.name === '@snowluma/runtime' && runtime.version === '2.4.2', brief(runtime))
  check('runtime：webuiHost 0.0.0.0 归一成 127.0.0.1 且 url 可直用', runtime.host === '127.0.0.1'
    && runtime.url === 'http://127.0.0.1:5099', runtime.url)
  check('runtime：没装时 installed=false 并给出原因', (() => {
    const gone = readSnowLumaRuntime({ dir: join(dir, 'nope') })
    return gone.exists === false && gone.installed === false && String(gone.reason).includes('runtime.json')
  })(), '')
  check('runtime：没有 webuiPort 时 url 为空且 reason 点名', (() => {
    const file = join(dir, 'runtime-noport.json')
    writeFileSync(file, JSON.stringify({ webuiHost: '127.0.0.1' }))
    const out = readSnowLumaRuntime({ dir: root, file })
    return out.url === '' && String(out.reason).includes('webuiPort')
  })(), '')
  check('runtime：tls 开启走 https', (() => {
    const file = join(dir, 'runtime-tls.json')
    writeFileSync(file, JSON.stringify({ webuiPort: 5099, webuiHost: '127.0.0.1', webuiTls: { enabled: true } }))
    return readSnowLumaRuntime({ dir: root, file }).url === 'https://127.0.0.1:5099'
  })(), '')
}
{
  const webui = readSnowLumaWebUi({ dir: root })
  check('webui：读到 hash 就算已设密码', webui.exists === true && webui.hasPassword === true && webui.mustChangePassword === false, brief(webui))
  check('webui：hash 太短不算已设密码', (() => {
    const file = join(dir, 'webui-short.json')
    writeFileSync(file, JSON.stringify({ passwordHash: 'abc' }))
    return readSnowLumaWebUi({ dir: root, file }).hasPassword === false
  })(), '')
  check('webui：文件不存在时 exists=false 并给原因', readSnowLumaWebUi({ dir: join(dir, 'nope') }).exists === false, '')
}
{
  const projection = publicSnowLumaConfig({
    runtime: readSnowLumaRuntime({ dir: root }),
    webui: readSnowLumaWebUi({ dir: root }),
  })
  const text = JSON.stringify(projection)
  check('投影：side/tokenMasked/enable2FA/autoLoginAccount 都是固定值', projection.side === 'snowluma'
    && projection.tokenMasked === '' && projection.enable2FA === false && projection.autoLoginAccount === '', brief(projection))
  check('★投影：hash 与 salt 一个字节都不出现，hasToken 反映「已设密码」', text.includes(HASH) === false
    && text.includes(SALT) === false && projection.hasToken === true && projection.passwordSet === true, text.slice(0, 120))
  check('投影：版本号与 url 透传给页面', projection.version === '2.4.2' && projection.url === 'http://127.0.0.1:5099', '')
}
{
  const rows = listAccounts({ dir: cfg })
  const row = rows.find((item) => item.uin === '123456789')
  check('账号清单：认得 onebot_<uin>.json（SnowLuma 的命名）', row !== undefined && row.hasOneBotConfig === true, brief(rows))
  check('账号清单：onebot11_<uin>.json 也仍然认（NapCat 不回归）', (() => {
    const other = join(dir, 'mixcfg')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'onebot11_987654321.json'), '{}')
    const found = listAccounts({ dir: other }).find((item) => item.uin === '987654321')
    return found !== undefined && found.hasOneBotConfig === true
  })(), '')
}

// ---------- ② 侧别判定 ----------
{
  const snow = readSnowLumaRuntime({ dir: root })
  const napcat = { exists: true, host: '127.0.0.1', port: 6099, url: 'http://127.0.0.1:6099' }
  const fixed = await resolveProtocolSide({ protocolSide: 'snowluma', napcat, snowluma: snow, probe: () => { throw new Error('不该探测') } })
  check('侧别：写死 snowluma 时不探端口', fixed.side === 'snowluma' && fixed.napcatLive === null
    && String(fixed.why).includes('写死'), brief(fixed))
  const onlySnow = await resolveProtocolSide({ napcat, snowluma: snow, probe: async ({ port }) => port === 5099 })
  check('侧别：只有 SnowLuma 在听 → snowluma', onlySnow.side === 'snowluma' && onlySnow.snowLive === true && onlySnow.napcatLive === false, brief(onlySnow))
  const onlyNapcat = await resolveProtocolSide({ napcat, snowluma: snow, probe: async ({ port }) => port === 6099 })
  check('侧别：只有 NapCat 在听 → napcat', onlyNapcat.side === 'napcat' && onlyNapcat.why.includes('6099'), brief(onlyNapcat))
  const both = await resolveProtocolSide({ napcat, snowluma: snow, probe: async () => true })
  check('侧别：两个都在听 → SnowLuma 优先并说明可写死', both.side === 'snowluma' && both.why.includes('优先'), brief(both))
  const cfgOnlySnow = await resolveProtocolSide({ napcat: { exists: false, url: '' }, snowluma: snow, probe: async () => false })
  check('侧别：只有 SnowLuma 有配置（没响应）→ snowluma', cfgOnlySnow.side === 'snowluma' && cfgOnlySnow.snowLive === false, brief(cfgOnlySnow))
  const none = await resolveProtocolSide({ napcat: { exists: false, url: '' }, snowluma: null, probe: async () => false })
  check('侧别：两边都没配置 → 回落到 napcat', none.side === 'napcat' && none.why.includes('没找到配置'), brief(none))
}

// ---------- 口令文件 ----------
{
  const file = join(dir, 'secret.json')
  writeFileSync(file, JSON.stringify({ password: 'pw-1' }))
  const ok = readSnowLumaSecret({ file })
  check('口令：password 读得到且 reason 为空', ok.password === 'pw-1' && ok.exists === true && ok.reason === '', brief(ok))
  writeFileSync(file, JSON.stringify({ token: 'tk-1' }))
  const tok = readSnowLumaSecret({ file })
  check('口令：只有 token 时也算配好', tok.token === 'tk-1' && tok.password === '', brief(tok))
  const unset = readSnowLumaSecret({ file: '' })
  check('口令：没配路径时不给绝对默认值，并说清怎么配', unset.exists === false && unset.path === ''
    && String(unset.reason).includes('snowlumaSecretFile'), brief(unset))
  const gone = readSnowLumaSecret({ file: join(dir, 'no-secret.json') })
  check('口令：文件不存在时点名路径', gone.exists === false && String(gone.reason).includes('没找到'), brief(gone))
  writeFileSync(file, JSON.stringify({ password: '', token: '' }))
  const empty = readSnowLumaSecret({ file })
  check('口令：空文件时告诉用户怎么填', empty.exists === true && String(empty.reason).includes('空的'), brief(empty))
  process.env.SNOWLUMA_PASSWORD = 'from-env'
  const viaEnv = readSnowLumaSecret({ file: join(dir, 'no-such.json') })
  check('口令：SNOWLUMA_PASSWORD 兜底（不用落盘）', viaEnv.password === 'from-env', brief(viaEnv))
  delete process.env.SNOWLUMA_PASSWORD
}

// ---------- ③ SnowLuma 客户端（假 fetch） ----------
function makeFetch(table) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    // 真实调用带的是 127.0.0.1:5099，测试表一律按 pathname 匹配
    const path = (() => {
      try { return new URL(url).pathname } catch { return url }
    })()
    calls.push({ url, method, path, headers: init.headers ?? {}, body: init.body ?? null })
    const handler = table[method + ' ' + path] ?? table['* ' + path]
    if (handler === undefined) return { status: 404, text: async () => JSON.stringify({ message: 'not found' }) }
    const out = typeof handler === 'function' ? await handler({ url, init, path, calls }) : handler
    return { status: out.status ?? 200, text: async () => (out.raw !== undefined ? out.raw : JSON.stringify(out.body ?? null)) }
  }
  return { fetchImpl, calls }
}
{
  const idle = createSnowLumaClient({ baseUrl: 'http://snow.test' })
  const out = await idle.status()
  check('客户端：没口令时 no-secret，且不发请求', out.ok === false && out.kind === 'no-secret' && idle.stats.requests === 0, brief(out))
}
{
  const table = {
    'POST /api/login': { body: { success: true, token: 'tk-A', mustChangePassword: false } },
    '* /api/status': { body: { status: 'running' } },
    '* /api/qq-list': { body: { list: [{ uin: '123456789', nickname: '示例号' }] } },
    '* /api/connections': { body: { list: [{ uin: '123456789', role: 'Universal', port: 3001 }, { uin: '123456789', role: 'Http', port: 3002 }] } },
  }
  const { fetchImpl, calls } = makeFetch(table)
  const client = createSnowLumaClient({ baseUrl: 'http://snow.test', password: 'pw', fetchImpl })
  const st = await client.status()
  const loginCall = calls.find((call) => call.path === '/api/login')
  check('客户端：先用口令换 token（JSON + content-type）', st.ok === true && loginCall !== undefined
    && loginCall.headers['content-type'] === 'application/json' && JSON.parse(loginCall.body).password === 'pw', brief(st))
  check('客户端：后续请求带 x-snowluma-token', calls[1] !== undefined && calls[1].headers['x-snowluma-token'] === 'tk-A', brief(calls[1]?.headers))
  check('客户端：status 原样透出 running', st.data?.status === 'running' && client.stats.logins === 1, brief(st.data))
  const overview = await client.overview()
  check('客户端：overview 合并账号清单 + 在线 + 连接数', overview.ok === true && overview.side === 'snowluma'
    && overview.data.accounts.length === 1 && overview.data.accounts[0].connections === 2
    && overview.data.accounts[0].online === true, brief(overview))
}
{
  let logins = 0
  const table = {
    'POST /api/login': () => { logins += 1; return { body: { success: true, token: 'tk-' + logins } } },
    '* /api/status': ({ init }) => (init.headers['x-snowluma-token'] === 'tk-1'
      ? { status: 401, body: { message: 'expired' } }
      : { body: { status: 'running' } }),
  }
  const { fetchImpl } = makeFetch(table)
  const client = createSnowLumaClient({ baseUrl: 'http://snow.test', password: 'pw', fetchImpl })
  const out = await client.status()
  check('客户端：401 自动重登一次再重试（对用户透明）', out.ok === true && logins === 2, brief(out) + ' logins=' + logins)
}
{
  const limited = createSnowLumaClient({ baseUrl: 'http://snow.test', password: 'pw', fetchImpl: makeFetch({
    'POST /api/login': { status: 429, body: { message: '登录尝试过多，请 30 秒后重试' } },
  }).fetchImpl })
  const out = await limited.status()
  check('客户端：429 → rate-limited，并透出服务端的秒数', out.ok === false && out.kind === 'rate-limited'
    && String(out.message).includes('30'), brief(out))
}
{
  const dead = createSnowLumaClient({ baseUrl: 'http://snow.test', password: 'pw', fetchImpl: async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:5099')
  } })
  const out = await dead.status()
  check('客户端：连不上 → unreachable（不是 error）', out.ok === false && out.kind === 'unreachable'
    && String(out.message).includes('没在运行'), brief(out))
}
{
  const noList = createSnowLumaClient({ baseUrl: 'http://snow.test', token: 'tk-X', fetchImpl: makeFetch({
    '* /api/status': { body: { status: 'running' } },
    '* /api/qq-list': { status: 401, body: { message: 'nope' } },
  }).fetchImpl })
  const out = await noList.overview()
  check('客户端：qq-list 失败时 overview 如实报错且仍标 side', out.ok === false && out.side === 'snowluma'
    && out.kind === 'unauthorized', brief(out))
}

// ---------- ④ createAccountsApi 的 snowluma 分支 ----------
const secretFile = join(dir, 'api-secret.json')
writeFileSync(secretFile, JSON.stringify({ password: 'pw' }))
const snowApi = createAccountsApi({
  protocolSide: 'snowluma',
  snowlumaDir: root,
  snowlumaSecretFile: secretFile,
  fetchImpl: makeFetch({
    'POST /api/login': { body: { success: true, token: 'tk-api' } },
    '* /api/status': { body: { status: 'running' } },
    '* /api/qq-list': { body: { list: [{ uin: '123456789', nickname: '示例号' }] } },
    '* /api/connections': { body: { list: [{ uin: '123456789' }] } },
  }).fetchImpl,
})
{
  const summary = await snowApi.summary()
  check('api：summary 走 snowluma 且账号清单来自 onebot_<uin>.json', summary.side === 'snowluma'
    && summary.accounts.length === 1 && summary.state.side === 'snowluma', brief(summary))
  check('api：summary 的 webui 投影不带 hash/salt', JSON.stringify(summary).includes(HASH) === false, '')
  const meta = await snowApi.meta()
  check('api：meta 带 side/why 与 SnowLuma 版本', meta.side === 'snowluma' && String(meta.why).includes('写死')
    && String(meta.versions?.napcat ?? '').includes('SnowLuma'), brief(meta))
  const status = await snowApi.status()
  check('api：status 用口令换 token 后读 /api/status', status.ok === true && status.side === 'snowluma'
    && status.data?.status === 'running', brief(status))
  const net = await snowApi.network()
  check('api：network 只读 onebot_<uin>.json 的 networks', net.ok !== false
    && net.accounts?.[0]?.servers?.[0]?.port === 3001 && net.accounts?.[0]?.https?.[0]?.port === 3002, brief(net))
  const blocked = [await snowApi.qrcode(), await snowApi.quickList(), await snowApi.plugins()]
  check('★api：NapCat 专属接口在 snowluma 侧一律 unsupported（不假装成功）',
    blocked.every((item) => item.ok === false && item.kind === 'unsupported' && String(item.message).includes('只在 NapCat')),
    brief(blocked))
}
{
  const napcatFile = join(dir, 'webui-napcat.json')
  writeFileSync(napcatFile, JSON.stringify({ host: '127.0.0.1', port: 6099, token: 'tk-napcat' }))
  const autoApi = createAccountsApi({
    webUiFile: napcatFile,
    snowlumaDir: root,
    snowlumaSecretFile: secretFile,
    sideProbe: async () => true,
  })
  const summary = await autoApi.summary()
  check('api：auto 判定两个都在听时落到 snowluma', summary.side === 'snowluma', brief(summary))
}
{
  const napcatFile = join(dir, 'webui-napcat2.json')
  writeFileSync(napcatFile, JSON.stringify({ host: '127.0.0.1', port: 6099, token: 'tk-napcat' }))
  const napcatApi = createAccountsApi({ protocolSide: 'napcat', webUiFile: napcatFile, snowlumaDir: '' })
  const summary = await napcatApi.summary()
  check('api：写死 napcat 时 summary 仍是 NapCat 形状（侧别只多一个字段）', summary.side === 'napcat'
    && summary.webui.hasToken === true && summary.webui.port === 6099, brief(summary))
  check('api：NapCat 侧 webui 投影仍是打码 token', String(summary.webui.tokenMasked ?? '').length > 0
    && String(summary.webui.tokenMasked) !== 'tk-napcat', brief(summary.webui))
}

rmSync(dir, { recursive: true, force: true })
console.log('')
console.log(passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)

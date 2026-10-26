/**
 * qq-ext-house-lite 的「肉」——小屋 8 个写工具（v4，2026-10-26 从补丁 42 迁出）。
 *
 * 为什么在插件里而不是补丁器里：这 8 个工具只依赖 config 与工作区根，不碰桥的运行时状态，
 * 是官方 provider 接缝最合适的搬迁对象（Tier A）。迁出后补丁 42 只剩 git 自动提交那一小块。
 *
 * 三条硬约束（provider 工具与 defineTool 方言不同，回归断言在 tools/test-ext-house-lite.mjs）：
 *   1. 参数与输出必须是标准 JSON Schema —— required 只能写在 object 上、且是数组；
 *   2. provider 必须同步返回 { tools, sections }，返回 Promise 会被 extension.js 拒收；
 *   3. 单次注入 toolsPerProvider 上限 8 —— 本包正好 8 个，再多会被静默截断。
 */

import fs from 'node:fs'
import path from 'node:path'
import { existsSync, statSync, lstatSync, readdirSync, mkdirSync, renameSync, readFileSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs'
import { resolve, dirname, join, basename, extname, sep } from 'node:path'
import { execFile } from 'node:child_process'

/** 热更指纹：改完这个文件把它跟着改一下，便于在 trace 里确认到底加载了哪一版。 */
export const variant = 'v4-house8'

const DEFAULT_HOUSE_DIR = '米白鲸私人小屋'

// 与桥内同名常量逐字一致（补丁 42 的守卫口径，改一处必须改两处）
const P42_HOUSE_EXTS = new Set(['.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yml', '.yaml', '.log', '.ini', '.toml', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif'])
const P42_HOUSE_TEXT = new Set(['.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.yml', '.yaml', '.log', '.ini', '.toml'])
const P42_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const P42_DENIED_NAMES = new Set(['desktop.ini', 'autorun.inf', 'thumbs.db', '.gitignore', '.gitattributes', '.gitmodules'])

/** 诊断日志：只写 stderr，失败也吞掉 —— 工具不能因为日志挂掉。 */
function debugLog(message) {
  try { process.stderr.write('[qq-ext-house] ' + message + '\n') } catch { /* ignore */ }
}

/** 只读统计：跳过符号链接，深度和条目都有硬上限，避免被自己的目录结构拖死。 */
export function houseUsage(root) {
  let bytes = 0
  let files = 0
  const dirs = []
  const walk = (dir, depth) => {
    if (depth > 6 || files > 4000) return
    let list = []
    try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of list) {
      if (files > 4000) return
      const p = path.join(dir, ent.name)
      if (ent.isSymbolicLink()) continue
      if (ent.isDirectory()) {
        if (depth === 0) dirs.push(ent.name + '/')
        walk(p, depth + 1)
        continue
      }
      try { bytes += fs.statSync(p).size; files += 1 } catch { /* 文件刚被删 */ }
    }
  }
  walk(root, 0)
  return { bytes, files, dirs }
}

/** 小屋根：<workspaceRoot>/<houseDir>。出口没给 workspaceRoot 时退回 config.cwd，再退回 process.cwd()。 */
export function houseRootOf(config = {}, workspaceRoot = '') {
  const dir = String(config?.houseDir ?? '').trim() || DEFAULT_HOUSE_DIR
  const base = String(workspaceRoot || config?.cwd || process.cwd())
  return path.resolve(base, dir)
}

function gitTop(dir) {
  let cur = resolve(String(dir ?? ''))
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(cur, '.git'))) return cur
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return ''
}

async function houseSnapshot(config, workspaceRoot, label) {
  if (config.houseGitEnabled === false) return ''
  const root = houseRootOf(config, workspaceRoot)
  const gitRoot = gitTop(root)
  if (gitRoot === '') return ''
  const run = (args) => new Promise((done) => {
    execFile('git', ['-C', gitRoot, ...args], { windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
      done({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
  const added = await run(['add', '-A'])
  if (added.error) {
    debugLog(`house git add failed: ${added.stderr || added.error.message}`)
    return ''
  }
  const message = `auto: ${String(label ?? 'snapshot').replace(/\s+/g, ' ').slice(0, 60)}`
  const committed = await run(['-c', 'user.name=米白鲸小屋', '-c', 'user.email=house@localhost', 'commit', '-m', message, '--no-gpg-sign'])
  if (committed.error) {
    const text = `${committed.stdout}${committed.stderr}`
    if (!/nothing to commit|no changes added|nothing added/i.test(text)) {
      debugLog(`house git commit failed: ${text.trim().slice(0, 200)}`)
      return ''
    }
    return ''
  }
  return message
}

export function housePath(config, workspaceRoot, requested, { forWrite = false, kind = 'file', allowEmpty = false } = {}) {
  const root = houseRootOf(config, workspaceRoot)
  const rootLower = root.toLowerCase()
  const bad = (reason) => ({ ok: false, reason })
  const raw = String(requested ?? '').trim()
  if (raw === '' && !allowEmpty) return bad('路径不能为空。')
  if (raw.includes('\u0000')) return bad('路径里有非法字符。')
  if (/^[a-zA-Z]:/.test(raw)) return bad('只用小屋内的相对路径，不要写盘符（如 D:\\ 或 C:）。')
  if (/^[\\/]{2}/.test(raw)) return bad('只用小屋内的相对路径，不要写网络路径（\\\\server\\share）。')
  if (raw.includes('://')) return bad('这看起来是网址，不是路径。')
  if (/^[\\/]/.test(raw)) return bad('只用相对路径，不要以斜杠开头。')
  const parts = raw.split(/[\\/]+/).filter((p) => p !== '' && p !== '.')
  if (parts.length === 0) {
    if (allowEmpty) return { ok: true, root, abs: root, rel: '', isRoot: true }
    return bad('路径不能为空。')
  }
  if (parts.some((p) => p === '..')) return bad('路径里不允许出现 ..（不许往上走）。')
  if (parts.some((p) => p.toLowerCase() === '.git')) return bad('.git 由系统维护，不接受读写。')
  const base = parts[parts.length - 1]
  if (base.includes(':')) return bad('文件名里不允许出现冒号（Windows 数据流写法）。')
  if (/[ .]$/.test(base)) return bad('文件名不能以空格或点结尾。')
  if (P42_RESERVED.test(base)) return bad(`"${base}" 是 Windows 保留设备名，换一个文件名。`)
  if (P42_DENIED_NAMES.has(base.toLowerCase())) return bad(`"${base}" 是系统认的特殊文件，不接受写入。`)
  const ext = extname(base).toLowerCase()
  if (forWrite && kind === 'file' && !P42_HOUSE_EXTS.has(ext)) {
    return bad(`小屋只收文本、图片和 PDF（${[...P42_HOUSE_EXTS].join(' ')}）；"${ext === '' ? '没有扩展名' : ext}" 不收。`)
  }
  const abs = resolve(root, ...parts)
  const inside = (candidate) => {
    const a = String(candidate).toLowerCase()
    return a === rootLower || a.startsWith(rootLower + sep)
  }
  if (!inside(abs)) return bad('这个路径落在小屋外面了，拒绝。')
  let cursor = root
  for (const seg of parts) {
    cursor = join(cursor, seg)
    let st = null
    try { st = lstatSync(cursor) } catch { break }
    if (st.isSymbolicLink()) return bad('路径里有符号链接或 junction，拒绝了（它能绕出小屋）。')
  }
  const realInside = (target) => {
    try { return inside(realpathSync(target)) } catch { return null }
  }
  const exact = realInside(abs)
  if (exact === false) return bad('这个路径的真实位置在小屋外面（符号链接），拒绝。')
  if (exact === null) {
    const parent = realInside(dirname(abs))
    if (parent === false) return bad('父目录的真实位置在小屋外面（符号链接），拒绝。')
  }
  return { ok: true, root, abs, rel: parts.join('/'), ext, isRoot: false }
}

/** 8 个工具共用的返回形状。 */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'detail'],
    properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
  },
  render: (_args, value) => [{ type: 'text', text: value.detail }],
}

/** 8 个工具本体。config / workspaceRoot 都在调用时求值，热更后立刻生效。 */
export function makeTools(config = {}, workspaceRoot = '') {
  const root = houseRootOf(config, workspaceRoot)
  const denied = (reason) => '小屋写入被拒绝：' + reason + '不要重试、不要换别的路径或工具绕过；'
    + '如实告诉对方：你只能改自己的工作目录（' + root + '），那里只放文本、图片和 PDF。'
  const maxFile = Math.max(1024, Number(config.houseMaxFileBytes) || 1048576)
  const maxTotal = Math.max(1048576, Number(config.houseMaxTotalBytes) || 209715200)
  const readMax = Math.max(1000, Number(config.workspaceReadMaxChars) || 20000)

  return [
    {
      name: 'qq_house_list',
      description: `List files and folders INSIDE your own writable folder (${root}). Paths are relative to that folder; "" lists the top level.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: {
          dir: { type: 'string', description: 'Relative folder path ("" for the top level).' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        const hit = housePath(config, workspaceRoot, String(args.dir ?? ''), { allowEmpty: true })
        if (!hit.ok) return { ok: false, detail: denied(hit.reason) }
        let list = []
        try { list = readdirSync(hit.abs, { withFileTypes: true }) } catch {
          return { ok: true, detail: `「${hit.rel || '/'}」还不存在，是空的。` }
        }
        const rows = []
        for (const ent of list.slice(0, 200)) {
          if (ent.isSymbolicLink()) { rows.push(`· ${ent.name}（符号链接，已忽略）`); continue }
          if (ent.isDirectory()) { rows.push(`· ${ent.name}/`); continue }
          let size = 0
          try { size = statSync(join(hit.abs, ent.name)).size } catch { /* ignore */ }
          rows.push(`· ${ent.name}（${Math.max(1, Math.round(size / 1024))} KB）`)
        }
        if (rows.length === 0) return { ok: true, detail: `「${hit.rel || '/'}」是空的。` }
        return { ok: true, detail: `「${hit.rel || '/'}」共 ${rows.length} 项：\n${rows.join('\n')}` }
      },
    },
    {
      name: 'qq_house_read',
      description: `Read a text file INSIDE your own folder (${root}). Images/PDF are not decoded here — send them with qq_send_image / qq_send_file instead.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Relative path inside your folder.' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        const hit = housePath(config, workspaceRoot, String(args.path ?? ''))
        if (!hit.ok) return { ok: false, detail: denied(hit.reason) }
        const ext = hit.ext
        if (!P42_HOUSE_TEXT.has(ext)) {
          return { ok: false, detail: `「${hit.rel}」不是文本文件（${ext || '无扩展名'}）：图片/PDF 用 qq_send_image / qq_send_file 发出去，别当文本读。` }
        }
        let text = ''
        try { text = readFileSync(hit.abs, 'utf8') } catch {
          return { ok: false, detail: `读不到「${hit.rel}」：它可能还不存在。` }
        }
        if (text.length > readMax) {
          return { ok: true, detail: `「${hit.rel}」前 ${readMax} 字（全文 ${text.length} 字，已截断）：\n\n${text.slice(0, readMax)}` }
        }
        return { ok: true, detail: `「${hit.rel}」全文（${text.length} 字）：\n\n${text}` }
      },
    },
    {
      name: 'qq_house_write',
      description: `Create or overwrite a text file INSIDE your own folder (${root}). Allowed extensions: ${[...P42_HOUSE_TEXT].join(' ')}. Overwriting an existing file snapshots it first.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'text'],
        properties: {
          path: { type: 'string', description: 'Relative path inside your folder.' },
          text: { type: 'string', description: 'Full file content (UTF-8).' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        const hit = housePath(config, workspaceRoot, String(args.path ?? ''), { forWrite: true })
        if (!hit.ok) return { ok: false, detail: denied(hit.reason) }
        const text = String(args.text ?? '')
        const bytes = Buffer.byteLength(text, 'utf8')
        if (bytes > maxFile) return { ok: false, detail: `这次写了 ${Math.round(bytes / 1024)} KB，超过单文件上限 ${Math.round(maxFile / 1024)} KB；拆成几个文件。` }
        const existed = existsSync(hit.abs)
        if (!existed) {
          const usage = houseUsage(root)
          if (usage.bytes + bytes > maxTotal) {
            return { ok: false, detail: `小屋已经用了 ${Math.round(usage.bytes / 1024 / 1024)} MB，再加这些会超过 ${Math.round(maxTotal / 1024 / 1024)} MB 上限；先整理或让它挪走旧文件。` }
          }
        }
        let snapshot = ''
        if (existed) snapshot = await houseSnapshot(config, workspaceRoot, `before write ${hit.rel}`)
        try {
          mkdirSync(dirname(hit.abs), { recursive: true })
          writeFileSync(hit.abs, text, 'utf8')
        } catch (error) {
          return { ok: false, detail: `写不进去：${error.message}` }
        }
        return { ok: true, detail: `${existed ? '已覆盖' : '已新建'}「${hit.rel}」（${bytes} 字节）${snapshot === '' ? '' : `，改动前已打快照（${snapshot}）`}。` }
      },
    },
    {
      name: 'qq_house_append',
      description: `Append text to a file INSIDE your own folder (${root}). Creates it if missing. Use this for notes/logs instead of rewriting the whole file.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'text'],
        properties: {
          path: { type: 'string', description: 'Relative path inside your folder.' },
          text: { type: 'string', description: 'Text to append (UTF-8).' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        const hit = housePath(config, workspaceRoot, String(args.path ?? ''), { forWrite: true })
        if (!hit.ok) return { ok: false, detail: denied(hit.reason) }
        const text = String(args.text ?? '')
        const bytes = Buffer.byteLength(text, 'utf8')
        if (bytes > maxFile) return { ok: false, detail: `一次追加 ${Math.round(bytes / 1024)} KB 太大了；分几次写。` }
        const usage = houseUsage(root)
        if (usage.bytes + bytes > maxTotal) {
          return { ok: false, detail: `小屋已经用了 ${Math.round(usage.bytes / 1024 / 1024)} MB，再加会超过上限；先整理。` }
        }
        try {
          mkdirSync(dirname(hit.abs), { recursive: true })
          appendFileSync(hit.abs, text, 'utf8')
        } catch (error) {
          return { ok: false, detail: `追加不进去：${error.message}` }
        }
        return { ok: true, detail: `已追加到「${hit.rel}」（${bytes} 字节）。` }
      },
    },
    {
      name: 'qq_house_edit',
      description: `Replace ONE exact occurrence of a substring in a text file INSIDE your own folder (${root}). Fails when the snippet appears zero or multiple times — pass a longer snippet instead of guessing.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'find'],
        properties: {
          path: { type: 'string', description: 'Relative path inside your folder.' },
          find: { type: 'string', description: 'Exact existing text (must occur exactly once).' },
          replace: { type: 'string', description: 'Replacement text (may be empty to delete the snippet).' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        const hit = housePath(config, workspaceRoot, String(args.path ?? ''), { forWrite: true })
        if (!hit.ok) return { ok: false, detail: denied(hit.reason) }
        const find = String(args.find ?? '')
        if (find === '') return { ok: false, detail: 'find 不能为空：要改哪段就把它原样贴进来。' }
        let text = ''
        try { text = readFileSync(hit.abs, 'utf8') } catch {
          return { ok: false, detail: `读不到「${hit.rel}」：它可能还不存在（要新建用 qq_house_write）。` }
        }
        const count = text.split(find).length - 1
        if (count === 0) return { ok: false, detail: `「${hit.rel}」里找不到这段文字。先用 qq_house_read 看一眼原文，再贴更准的一段。` }
        if (count > 1) return { ok: false, detail: `这段文字在「${hit.rel}」里出现了 ${count} 次，不确定改哪个；把 find 写长一点，让它只命中一处。` }
        const next = text.replace(find, () => String(args.replace ?? ''))
        const bytes = Buffer.byteLength(next, 'utf8')
        if (bytes > maxFile) return { ok: false, detail: `改完会到 ${Math.round(bytes / 1024)} KB，超过单文件上限；换个改法。` }
        const snapshot = await houseSnapshot(config, workspaceRoot, `before edit ${hit.rel}`)
        try { writeFileSync(hit.abs, next, 'utf8') } catch (error) {
          return { ok: false, detail: `写不进去：${error.message}` }
        }
        return { ok: true, detail: `已改「${hit.rel}」（${bytes} 字节）${snapshot === '' ? '' : `，改动前已打快照（${snapshot}）`}。` }
      },
    },
    {
      name: 'qq_house_mkdir',
      description: `Create a folder INSIDE your own folder (${root}), including missing parents.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Relative folder path.' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        const hit = housePath(config, workspaceRoot, String(args.path ?? ''), { forWrite: true, kind: 'dir' })
        if (!hit.ok) return { ok: false, detail: denied(hit.reason) }
        try { mkdirSync(hit.abs, { recursive: true }) } catch (error) {
          return { ok: false, detail: `建不了目录：${error.message}` }
        }
        return { ok: true, detail: `已建目录「${hit.rel}/」。` }
      },
    },
    {
      name: 'qq_house_move',
      description: `Rename or move a file INSIDE your own folder (${root}). Both ends must stay inside; an existing target is never overwritten.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', description: 'Relative source path.' },
          to: { type: 'string', description: 'Relative destination path.' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        const src = housePath(config, workspaceRoot, String(args.from ?? ''), { forWrite: true })
        if (!src.ok) return { ok: false, detail: denied(src.reason) }
        const dst = housePath(config, workspaceRoot, String(args.to ?? ''), { forWrite: true })
        if (!dst.ok) return { ok: false, detail: denied(dst.reason) }
        if (!existsSync(src.abs)) return { ok: false, detail: `「${src.rel}」不存在。` }
        if (existsSync(dst.abs)) return { ok: false, detail: `「${dst.rel}」已经存在；要改它就用 qq_house_write / qq_house_edit。` }
        const snapshot = await houseSnapshot(config, workspaceRoot, `before move ${src.rel}`)
        try {
          mkdirSync(dirname(dst.abs), { recursive: true })
          renameSync(src.abs, dst.abs)
        } catch (error) {
          return { ok: false, detail: `移动失败：${error.message}` }
        }
        return { ok: true, detail: `已把「${src.rel}」移到「${dst.rel}」${snapshot === '' ? '' : `（移动前快照：${snapshot}）`}。` }
      },
    },
    {
      name: 'qq_house_trash',
      description: `Move a file INSIDE your own folder (${root}) into .trash/ instead of deleting it. Anything here can be recovered by hand.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Relative path of the file to retire.' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        const hit = housePath(config, workspaceRoot, String(args.path ?? ''))
        if (!hit.ok) return { ok: false, detail: denied(hit.reason) }
        if (!existsSync(hit.abs)) return { ok: false, detail: `「${hit.rel}」不存在。` }
        const trashDir = join(root, '.trash')
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        let target = join(trashDir, `${stamp}-${basename(hit.abs)}`)
        if (existsSync(target)) target = join(trashDir, `${stamp}-${Date.now()}-${basename(hit.abs)}`)
        const snapshot = await houseSnapshot(config, workspaceRoot, `before trash ${hit.rel}`)
        try {
          mkdirSync(trashDir, { recursive: true })
          renameSync(hit.abs, target)
        } catch (error) {
          return { ok: false, detail: `回收失败：${error.message}` }
        }
        return { ok: true, detail: `已把「${hit.rel}」移进 .trash/（没有真删，需要时可以手工捞回来）${snapshot === '' ? '' : `；操作前快照：${snapshot}`}。` }
      },
    },
  ]
}

/** provider 本体（同步，返回 { tools, sections }；返回 Promise 会被 extension.js 明确拒收）。 */
export function provider(context = {}) {
  try {
    const workspaceRoot = context?.workspaceRoot || ''
    // 面板「能力勾选」里的 houseToolsEnabled 仍然管用：关掉就一个工具都不出（等价于旧补丁里那条 if）。
    if (context?.config?.houseToolsEnabled === false) return { tools: [], sections: [] }
    return { tools: makeTools(context?.config ?? {}, workspaceRoot), sections: [] }
  } catch (error) {
    // provider 抛错只跳过自己，但这里再兜一层：坏掉的第三方不该让整条消息失败。
    return { tools: [], sections: [], reason: 'qq-ext-house-lite: ' + String(error?.message ?? error) }
  }
}

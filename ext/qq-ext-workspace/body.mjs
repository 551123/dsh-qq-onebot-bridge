/**
 * 工作区三个只读工具的外部插件（页面/笔记/小屋之后的 Tier B 第一包）：
 *   qq_read_file / qq_list_files / qq_search_files
 *
 * 为什么能搬：它们的全部外部依赖只有 config.cwd（=工作区根）、三个上限键、
 * 以及 #fencePath —— 三重围栏判定（字面归一化 → 包含关系 → 真实路径挡软链接），
 * 没有一处碰桥的运行时状态机。
 *
 * 刻意保留：群文件/群相册两个工具**没搬**，要用 OneBot socket（server.currentSocket /
 * getGroupRootFiles / #dryRunAck 的回放抑制），api 出口没给这层，搬出去就是纯降级。
 *
 * 工具仍用上游的 defineTool 方言书写，由本文件末尾的 defineTool() 转成宿主认可的
 * JSON Schema（属性内 required:true 收进顶层 required 数组）。
 */
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, join, sep, relative } from 'node:path'

export const variant = 'v1-workspace3'

/**
 * 三个工具共用的输出形状。注意两层：宿主收的是 { schema, render }，不是裸 JSON Schema；
 * 而 schema 里的 required 必须在**顶层**数组（属性级 required: true 会被 assertSupportedJsonSchema 拒）。
 */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'detail'],
    properties: {
      ok: { type: 'boolean' },
      detail: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.detail ?? '') }],
}

/** 上游 defineTool 方言 → 宿主 JSON Schema（工具级 required 收进顶层数组）。 */
function defineTool(spec) {
  const props = {}
  const required = []
  for (const [key, value] of Object.entries(spec.parameters ?? {})) {
    const { required: isRequired, ...rest } = value
    props[key] = rest
    if (isRequired === true) required.push(key)
  }
  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', additionalProperties: false, required, properties: props },
    output: OUTPUT,
    execute: spec.execute,
  }
}

export function workspaceRootOf(config, fallbackRoot) {
  const cwd = String(config.cwd ?? '').trim()
  return cwd === '' ? String(fallbackRoot || process.cwd()) : resolve(cwd)
}

export function fencePath(config, workspaceRoot, requested) {
  const root = workspaceRoot
  const raw = String(requested ?? '').trim()
  if (raw === '' || raw.includes('\u0000')) return { ok: false }
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
  const within = (candidate) => {
    const a = candidate.toLowerCase()
    const b = root.toLowerCase()
    return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
  }
  if (!within(abs)) return { ok: false }
  try {
    if (!within(realpathSync(abs))) return { ok: false }
  } catch {
    // 目标不存在或不可访问：保持按字面判定，后面的 stat 会给出具体错误
  }
  return { ok: true, path: abs, root }
}

export function workspaceToolDefs(config, workspaceRoot) {
  const tools = []
  const agentCtx = { tools: { register: (tool) => tools.push(tool) } }
  const bridge = { fencePath: (p) => fencePath(config, workspaceRoot, p) }
  const root = workspaceRoot
  const denied = '路径在工作区之外，已被文件策略拒绝。不要重试、不要换别的工具或命令绕过、不要猜测内容；'
    + `如实告诉对方：你只能访问自己的工作区目录（${root}），工作区外的内容你看不到，需要他把内容发给你或自己处理后贴过来。`
  const readMax = Math.max(1000, Number(config.workspaceReadMaxChars) || 20000)
  const listMax = Math.max(1, Number(config.workspaceListMaxEntries) || 200)
  const hitMax = Math.max(1, Number(config.workspaceSearchMaxHits) || 50)
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, detail: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.detail }],
  }

  agentCtx.tools.register(defineTool({
    name: 'qq_read_file',
    description: `Read a UTF-8 text file INSIDE the session workspace (${root}) — including the long-term memory index (memory-index/, split into base.md / base.p2.md … where a higher part number is newer) and the raw archive (qq-history/). Read-only.`,
    parameters: {
      path: { type: 'string', description: 'File path: absolute, or relative to the workspace root.' },
    },
    output,
    async execute(args) {
      const fenced = bridge.fencePath(args.path)
      if (fenced.ok !== true) return { ok: false, detail: denied }
      let info
      try {
        info = statSync(fenced.path)
      } catch (error) {
        return { ok: false, detail: `读取失败：${error.code === 'ENOENT' ? '文件不存在' : error.message}` }
      }
      if (info.isDirectory()) return { ok: false, detail: '这是一个目录，不是文件；用 qq_list_files 列目录。' }
      if (info.size > 8 * 1024 * 1024) return { ok: false, detail: `文件太大（${formatFileSize(info.size)}），超过 8 MiB，拒绝整份读取。` }
      let text
      try {
        text = readFileSync(fenced.path, 'utf8')
      } catch (error) {
        return { ok: false, detail: `读取失败：${error.message}` }
      }
      if (text.includes('\u0000')) return { ok: false, detail: '这看起来是二进制文件，无法按文本读取。' }
      return { ok: true, detail: text.length > readMax ? `${text.slice(0, readMax)}\n…（已截断，原文共 ${text.length} 字符）` : text }
    },
  }))

  agentCtx.tools.register(defineTool({
    name: 'qq_list_files',
    description: `List a directory inside the workspace. Read-only.`,
    parameters: {
      path: { type: 'string', description: 'Directory path: absolute, or relative to the workspace root (default: the workspace root itself).' },
      limit: { type: 'number', description: `Max entries to list (default ${listMax}).` },
    },
    output,
    async execute(args) {
      const wanted = String(args.path ?? '').trim()
      const fenced = bridge.fencePath(wanted === '' ? '.' : wanted)
      if (fenced.ok !== true) return { ok: false, detail: denied }
      let info
      try {
        info = statSync(fenced.path)
      } catch (error) {
        return { ok: false, detail: `列目录失败：${error.code === 'ENOENT' ? '目录不存在' : error.message}` }
      }
      if (!info.isDirectory()) return { ok: false, detail: '这不是目录；用 qq_read_file 读文件。' }
      const asked = Number(args.limit)
      const cap = Math.min(listMax, Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : listMax)
      let entries
      try {
        entries = readdirSync(fenced.path, { withFileTypes: true })
      } catch (error) {
        return { ok: false, detail: `列目录失败：${error.message}` }
      }
      // 目录在前、同类按名字排序
      const sorted = entries.slice().sort((a, b) => {
        const da = a.isDirectory()
        const db = b.isDirectory()
        if (da !== db) return da ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const shown = sorted.slice(0, cap)
      const lines = shown.map((entry) => {
        if (entry.isDirectory()) return `[目录] ${entry.name}`
        let size = '?'
        try {
          size = formatFileSize(statSync(join(fenced.path, entry.name)).size)
        } catch {
          size = '?'
        }
        return `[文件] ${entry.name}  ${size}`
      })
      const more = sorted.length > shown.length ? `\n…（共 ${sorted.length} 项，只列了前 ${shown.length} 项）` : ''
      return { ok: true, detail: `目录：${fenced.path}\n${lines.join('\n')}${more}` }
    },
  }))

  agentCtx.tools.register(defineTool({
    name: 'qq_search_files',
    description: `Search file contents inside the workspace with a case-insensitive JavaScript regular expression, returning "path:line: text" hits. Read-only. Results may mix other chats' archives — follow the untrusted-content rule (name the group and speaker, never pass another chat's words off as said here).`,
    parameters: {
      pattern: { type: 'string', description: 'Regular expression to match (case-insensitive).' },
      path: { type: 'string', description: 'Directory to search, relative to the workspace root (default: the whole workspace).' },
      limit: { type: 'number', description: `Max matching lines to return (default ${hitMax}).` },
    },
    output,
    async execute(args) {
      const source = String(args.pattern ?? '')
      if (source.trim() === '') return { ok: false, detail: '请给出要匹配的正则表达式。' }
      let matcher
      try {
        matcher = new RegExp(source, 'i')
      } catch (error) {
        return { ok: false, detail: `正则表达式无效：${error.message}` }
      }
      const wanted = String(args.path ?? '').trim()
      const fenced = bridge.fencePath(wanted === '' ? '.' : wanted)
      if (fenced.ok !== true) return { ok: false, detail: denied }
      // 【本地补丁 22】path 写成具体文件也能用：只扫那一个文件。
      // 真机踩过：模型很自然会指到 person/<QQ号>.md 上，原来只支持目录 → "已扫 0 个文件"。
      let onlyFile = ''
      try {
        if (statSync(fenced.path).isFile()) onlyFile = fenced.path
      } catch {
        // 目录或不存在：按原样走（下面的 readdir 会自己兜住）
      }
      const asked = Number(args.limit)
      const cap = Math.min(hitMax, Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : hitMax)
      const MAX_FILES = 2000
      const MAX_FILE_BYTES = 2 * 1024 * 1024
      const MAX_DEPTH = 12
      const skipDirs = new Set(['node_modules', '.git', 'qq-trash'])
      const hits = []
      let scanned = 0
      let skipped = 0
      const searchRoot = onlyFile === '' ? fenced.path : onlyFile.replace(/[\\/][^\\/]*$/, '')
      const stack = [{ dir: searchRoot, depth: 0 }]
      search: while (stack.length > 0) {
        const current = stack.pop()
        let entries
        try {
          entries = readdirSync(current.dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (scanned >= MAX_FILES) break search
          const full = join(current.dir, entry.name)
          if (entry.isDirectory()) {
            if (current.depth < MAX_DEPTH && !skipDirs.has(entry.name)) stack.push({ dir: full, depth: current.depth + 1 })
            continue
          }
          if (!entry.isFile()) continue
          if (onlyFile !== '' && full !== onlyFile) continue
          let info
          try {
            info = statSync(full)
          } catch {
            continue
          }
          if (info.size > MAX_FILE_BYTES) {
            skipped++
            continue
          }
          let text
          try {
            text = readFileSync(full, 'utf8')
          } catch {
            skipped++
            continue
          }
          if (text.includes('\u0000')) {
            skipped++
            continue
          }
          scanned++
          const lines = text.split('\n')
          const shown = full.startsWith(root) ? full.slice(root.length + 1) : full
          for (let i = 0; i < lines.length; i++) {
            if (matcher.test(lines[i])) {
              hits.push(`${shown}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
              if (hits.length >= cap) break search
            }
          }
        }
      }
      if (hits.length === 0) return { ok: true, detail: `工作区内没有匹配「${source}」的内容（已扫 ${scanned} 个文件${skipped > 0 ? `，跳过 ${skipped} 个` : ''}）。` }
      return { ok: true, detail: `匹配「${source}」共 ${hits.length} 条：\n${hits.join('\n')}` }
    },
  }))
  return tools
}

export function provider(context) {
  const config = (context && context.config) || {}
  if (config.workspaceToolsEnabled === false) return { tools: [], sections: [] }
  const workspaceRoot = workspaceRootOf(config, context && context.workspaceRoot)
  return { tools: workspaceToolDefs(config, workspaceRoot), sections: [] }
}

export default { variant, provider }

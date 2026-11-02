/**
 * 群聊/私聊消息的**归档**（历史检索底座）：把每条消息落盘成按天分片的
 * `YYYY-MM-DD.jsonl`，供 `/找 关键词` 在本地翻旧账。
 *
 * 为什么另起一套而不是复用 lib/inbox.js：`qq-inbox.jsonl` 有 2 MiB 轮转上限，
 * 它的定位是"给模型回放最近几条"，写满就被截断；检索需要的是**不会被轮转吃掉**的
 * 长期归档，所以这里按天切片、永不自截断（过期分片只是被移到回收站）。
 *
 * 设计取舍：
 * - **按本地日期分片**（不是 UTC）：东八区凌晨 0~8 点的消息若按 UTC 算会被塞进
 *   前一天的文件，"最近 N 天"的检索窗口就会莫名其妙漏掉当天。日期格式化自备，
 *   不用 `toISOString()`。
 * - **过期只移不删**：`prune()` 把过期分片搬到回收站目录（未给 `trashDir` 时是
 *   `dir` 同级的 `qq-trash/<当天>/`），与 lib/store.js 的删除策略一致。
 * - **落盘行是自包含的纯文本**：`archiveLine()` 把空白压平、2000 字截断，
 *   保证"一条记录一行"，换行符永远不会把一条消息劈成两行、毁掉按行解析。
 * - **检索从新到旧**：只扫 `days` 天的分片，读满 `limit` 条就提前收工，
 *   所以 `scanned` 是"真正读了多少行"，越新的数据越快命中。
 *
 * 与 lib/history.js 是**同族但独立**的模块（那边是 OneBot 历史消息的规范化与排版）：
 * 容错取向一致，但刻意不互相 import，任一方改动都不会牵连另一方。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 单条文本落盘上限（字符）。 */
const MAX_TEXT_CHARS = 5000
/** 单次检索最多接受多少个检索词（挡住病态超长关键词）；超出部分忽略。 */
const MAX_TERMS = 8
/** 单个分片最多读多少行（挡住畸形巨型文件的极端情况）。 */
const MAX_LINES_PER_FILE = 200000
/** 分片文件名形状：`YYYY-MM-DD.jsonl`。 */
const SHARD_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
/** 默认保留天数。 */
const DEFAULT_KEEP_DAYS = 90
/** 默认单次检索条数。 */
const DEFAULT_LIMIT = 20
/** 默认检索窗口天数。 */
const DEFAULT_DAYS = 7
/** 群上下文默认读取的最近条数（本地补丁 7：按群取最近对话喂给模型）。 */
const DEFAULT_RECENT_LINES = 30

const pad2 = (n) => String(n).padStart(2, '0')

/** 归一化数值字段：非有限数（NaN / Infinity / 'abc' / undefined）→ 0。 */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 归一化字符串字段：非字符串或缺失 → ''。 */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/** 压平空白：换行/制表/连续空格/全角空格 → 单个半角空格，并 trim。 */
function collapse(value) {
  return String(value ?? '').replace(/[\s\u3000]+/g, ' ').trim()
}

/** 硬截断到 `max` 字符；超出时补省略号（未超出返回原文）。 */
function clip(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 本地日期 → `YYYY-MM-DD`。
 * 刻意不用 `toISOString()`：那个是 UTC 日期，东八区凌晨的消息会落到前一天的分片里。
 */
function dayOf(date) {
  const d = (date instanceof Date) ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return dayOf(new Date())
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 偏移 `offset` 天后的日期字符串（本地时区，按"日期"加减，不踩夏令时的坑）。 */
function dayOffset(baseMs, offset) {
  const d = new Date(num(baseMs))
  if (Number.isNaN(d.getTime())) return dayOf(new Date())
  d.setDate(d.getDate() + offset)
  return dayOf(d)
}

/** `YYYY-MM-DD` 字符串是否合法（同时挡住 '2026-13-45' 这类形状对但值不对的）。 */
function isValidDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const probe = new Date(y, m - 1, d)
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d
}

/** 把分片内容按行解析成记录，坏行跳过（不抛错）。返回 { records, lines }。 */
function readShard(file) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return { records: [], lines: 0 } }
  // CRLF 文件同样按行切开（\r 会被 JSON.parse 当空白吃掉，但统一剥掉更稳）
  const lines = text.split('\n')
  let count = 0
  const records = []
  for (const raw of lines) {
    if (count >= MAX_LINES_PER_FILE) break
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '') continue
    count++
    const record = parseArchiveLine(line)
    if (record !== null) records.push(record)
  }
  return { records, lines: count }
}

/**
 * 把一条记录序列化成单行 JSON（**不含换行符**）。
 * 文本里的换行会被替换成空格、连续空白压成一个，并截断到 2000 字。
 * @param {{ ts?: number, chatKey?: string, userId?: number, name?: string, kind?: string, text?: string }} record
 * @returns {string}
 */
export function archiveLine(record) {
  const source = (record !== null && typeof record === 'object') ? record : {}
  // 字段顺序固定：ts 最前，方便肉眼看文件时快速定位时间
  const normalized = {
    ts: num(source.ts),
    chatKey: str(source.chatKey),
    userId: num(source.userId),
    name: str(source.name),
    kind: str(source.kind),
    text: clip(collapse(source.text), MAX_TEXT_CHARS),
  }
  try {
    return JSON.stringify(normalized)
  } catch {
    // 理论上进不来（字段都归一化过），兜底也保持"一行"契约，绝不抛错
    return JSON.stringify({ ts: 0, chatKey: '', userId: 0, name: '', kind: '', text: '' })
  }
}

/**
 * 解析一行归档。**坏行一律返回 null，绝不抛错**：
 * 手工编辑、半截写入、旧版本格式、非对象（数组/字符串/数字）、关键字段全缺的行
 * 都当作"没有这条"，交给调用方跳过。
 *
 * 数值字段归一化（`ts` / `userId` 非有限数 → 0），字符串字段缺失 → `''`；
 * 多余的未知字段原样留着，方便以后扩展而不丢数据。
 * @param {string} line
 * @returns {{ ts: number, chatKey: string, userId: number, name: string, kind: string, text: string }|null}
 */
export function parseArchiveLine(line) {
  if (typeof line !== 'string') return null
  const text = line.trim()
  if (text === '') return null
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  // 数组 / null / 字符串 / 数字都不是记录
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  // 关键字段一个都没有 → 不是归档行（挡住 `{}` 和随便一个 JSON 对象）
  const hasKey = data.chatKey !== undefined || data.ts !== undefined
    || data.userId !== undefined || data.text !== undefined
  if (!hasKey) return null
  return {
    ...data,
    ts: num(data.ts),
    chatKey: str(data.chatKey),
    userId: num(data.userId),
    name: str(data.name),
    kind: str(data.kind),
    text: str(data.text),
  }
}

/**
 * 把一个文件搬进回收站目录（`<trashDir>/<当天>/<文件名>`），**永不删除**。
 * 同名冲突时追加 `.1` / `.2` 后缀，绝不覆盖已有的备份。
 * 返回新路径；失败返回 ''（此时原文件必须原样留着）。
 */
function moveIntoTrash(file, trashDir, nowMs) {
  try {
    if (!trashDir) return ''
    const bucket = join(trashDir, dayOf(nowMs))
    mkdirSync(bucket, { recursive: true })
    const leaf = basename(file)
    const dot = leaf.lastIndexOf('.')
    const stem = dot > 0 ? leaf.slice(0, dot) : leaf
    const ext = dot > 0 ? leaf.slice(dot) : ''
    let dest = join(bucket, leaf)
    let n = 1
    while (existsSync(dest)) {
      dest = join(bucket, `${stem}.${n}${ext}`)
      n += 1
    }
    renameSync(file, dest)
    return dest
  } catch {
    return ''
  }
}

/**
 * 按天分片的本地消息归档。
 *
 * 所有 fs 操作都是"尽力而为"：失败不抛错，只是返回 false / 跳过。
 * 归档是旁路功能，绝不能把桥的主流程带崩。
 */
export class HistoryArchive {
  /**
   * @param {{ dir?: string, keepDays?: number, now?: () => number }} [options]
   *   dir 归档目录（惰性创建）；keepDays 保留天数（默认 90，<0 按 0 算）；
   *   now 注入当前时间（测试用）。
   */
  constructor(options = {}) {
    const opts = (options !== null && typeof options === 'object') ? options : {}
    this.dir = typeof opts.dir === 'string' ? opts.dir : ''
    this.keepDays = Math.max(0, Math.floor(num(opts.keepDays === undefined ? DEFAULT_KEEP_DAYS : opts.keepDays)))
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.ready = false
  }

  /** 当前时间（归一化，挡住注入的假时钟返回垃圾）。 */
  #nowMs() {
    let value = 0
    try { value = this.now() } catch { value = 0 }
    if (!Number.isFinite(Number(value))) value = 0
    return num(value)
  }

  /** 惰性创建归档目录（失败返回 false，不抛错）。 */
  #ensureDir() {
    if (this.ready) return true
    if (this.dir === '') return false
    try {
      mkdirSync(this.dir, { recursive: true })
      this.ready = true
      return true
    } catch {
      return false
    }
  }

  /** 一条记录所属的分片文件（日期取自记录自身 `ts`，缺失才回落到"现在"）。 */
  #fileFor(record, nowMs) {
    const ts = num(record && record.ts)
    return join(this.dir, `${dayOf(ts > 0 ? ts : nowMs)}.jsonl`)
  }

  /** 目录下的分片文件名，**按文件名升序**（时间序），目录不存在 → []。 */
  #shardNames() {
    let names = []
    try { names = readdirSync(this.dir) } catch { return [] }
    return names.filter((name) => SHARD_RE.test(name)).sort()
  }

  /**
   * 追加一条记录到它所属的那一天的分片。
   * @returns {boolean} 是否写入成功（失败返回 false，绝不抛错）
   */
  append(record) {
    if (record === null || typeof record !== 'object') return false
    if (!this.#ensureDir()) return false
    let line = ''
    try { line = archiveLine(record) } catch { return false }
    try {
      appendFileSync(this.#fileFor(record, this.#nowMs()), `${line}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /**
   * 就地替换**最后一条**归档记录（原地更新最后一行的文本）。
   *
   * 用途：合并转发卡片在入档那一刻 `message.text` 是空串——正文要靠 `get_forward_msg` 异步展开，
   * 而展开排在 @ / 私聊门控之后。所以先落占位行，展开成功后再用本方法把正文补进那一行，
   * 避免"同一条消息两行、其中一行空"。
   *
   * 安全性来自**逐字段校验**：`ts` 与 `chatKey` 会与最后一行的同名字段**始终**比对（这两个字段
   * 不接受关闭），再叠加调用方通过 `match` 指定的额外字段；**任一不符就追加**一条新记录，
   * 绝不覆盖别人的行。传入 `{}` 表示"除 ts / chatKey 外不做额外校验"。
   * 另外 `ts` 决定落在哪个分片，所以本方法只会动"新记录所属分片"的最后一行。
   *
   * 与 `append()` 同样是"尽力而为"：失败返回 false，绝不抛错，也绝不把桥的主流程带崩。
   *
   * @param {object} record 新的记录（复用 `archiveLine()` 的归一化：压平空白 + 2000 字截断）
   * @param {object} [expect] 期望的字段值；键名取自 `archiveLine()` 产出的字段
   * @param {object} [match] 逐字段校验方式；`true` = 全等，`false` = 不等，省略 = 全等
   * @returns {{ updated: boolean, appended: boolean }} updated=就地替换，appended=退回追加
   */
  updateLast(record, expect = {}, match = {}) {
    if (record === null || typeof record !== 'object') return { updated: false, appended: false }
    const wanted = (expect !== null && typeof expect === 'object') ? expect : {}
    const mode = (match !== null && typeof match === 'object') ? match : {}
    let line = ''
    try { line = archiveLine(record) } catch { return { updated: false, appended: false } }
    const file = this.#fileFor(record, this.#nowMs())
    // 先按换行切；只有"读到了末尾那行"才敢替换，读到坏行/空行一律退回追加（保守）
    let lines = null
    try { lines = readFileSync(file, 'utf8').split('\n') } catch { lines = null }
    if (lines !== null && lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (lines !== null && lines.length > 0) {
      const last = parseArchiveLine(lines[lines.length - 1])
      // 自己那条记录的形状：ts 是定位键（分片内唯一到毫秒），chatKey 归属校验。
      // 这两个字段**始终校验**，不接受调用方关掉——否则"ts 只差 1 秒的两条消息"
      // 或"另一个会话的消息"都可能被误覆盖。
      let ok = last !== null
      if (ok) {
        ok = last.ts === num(record.ts) && last.chatKey === str(record.chatKey)
      }
      // 调用方额外的字段校验（omit = 全等，false = 不等）
      if (ok) {
        for (const key of Object.keys(wanted)) {
          const shouldEqual = mode[key] !== false
          if ((last[key] === wanted[key]) !== shouldEqual) { ok = false; break }
        }
      }
      if (ok) {
        lines[lines.length - 1] = line
        try {
          writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
          return { updated: true, appended: false }
        } catch {
          // 原地写失败 → 落到下面的追加，至少别把展开结果丢掉
        }
      }
    }
    return { updated: false, appended: this.append(record) === true }
  }

  /**
   * 在最近 `days` 天的分片里检索。
   *
   * 关键词大小写不敏感，空格分隔的多个词是 **AND** 关系（全部命中才算）。
   * 分片从新到旧读，命中按时间新→旧返回，最多 `limit` 条。
   *
   * @param {string} keyword
   * @param {{ days?: number, limit?: number, chatKey?: string }} [options]
   * @returns {{ hits: Array<object>, scanned: number, files: string[], truncated: boolean }}
   *   scanned 是真正读过的行数（坏行也算，因为确实读了一行）；
   *   files 是读过的分片文件名（新→旧）；truncated 表示是否因 limit 被截断。
   */
  search(keyword, options) {
    const empty = { hits: [], scanned: 0, files: [], truncated: false }
    // 关键词为空/非字符串 → 空结果（在碰 fs 之前就返回）
    if (typeof keyword !== 'string' || keyword.trim() === '') return empty

    const opts = (options !== null && typeof options === 'object') ? options : {}
    const limit = Math.floor(num(opts.limit)) >= 1 ? Math.floor(num(opts.limit)) : DEFAULT_LIMIT
    const days = Math.floor(num(opts.days)) >= 1 ? Math.floor(num(opts.days)) : DEFAULT_DAYS
    const chatKey = typeof opts.chatKey === 'string' ? opts.chatKey : ''

    const terms = collapse(keyword).toLowerCase().split(' ').filter((term) => term !== '').slice(0, MAX_TERMS)
    if (terms.length === 0) return empty

    const base = this.#nowMs()
    // 当天 + 前 days-1 天，新 → 旧
    const wanted = []
    for (let offset = 0; offset < days; offset++) wanted.push(dayOffset(base, -offset))

    const files = []
    const seen = new Set()
    const hits = []
    let scanned = 0
    let truncated = false
    let full = false

    outer: for (const day of wanted) {
      const name = `${day}.jsonl`
      if (seen.has(name)) continue
      seen.add(name)
      const { records, lines } = readShard(join(this.dir, name))
      // 只有真的读到东西才算"读过的文件"，目录不存在/文件缺失不进 files
      if (lines === 0) continue
      files.push(name)
      scanned += lines
      // 同一文件内后写的 ts 更大：倒序读即天然的新→旧
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]
        if (chatKey !== '' && record.chatKey !== chatKey) continue
        const haystack = `${record.text} ${record.name}`.toLowerCase()
        if (!terms.every((term) => haystack.includes(term))) continue
        if (hits.length >= limit) { truncated = true; full = true; break outer }
        hits.push(record)
      }
    }

    return { hits, scanned, files, truncated }
  }

  /**
   * 取某会话**最近**的若干条归档记录（本地补丁 7：群上下文）。
   *
   * 与 `search()` 的区别：不筛关键词，只要最近的；而且返回**时间正序**（旧→新），
   * 因为它是给模型当"刚才群里聊了什么"读的，倒序会让人读反。
   *
   * 两个上限是"先到先停"（不是"条数够再按字数砍"）：
   * 目的是**限制注入系统的 token**，所以一旦达到条数或字符预算就停止收集，
   * 再把已收集的正序返回 —— 这样切出来的一定是"最近的那一段"。
   *
   * @param {{ chatKey?: string, limit?: number, maxChars?: number, days?: number }} [options]
   * @returns {Array<object>} 归档记录（时间正序：旧→新）；读不到任何东西时返回空数组
   */
  readRecent(options) {
    const opts = (options !== null && typeof options === 'object') ? options : {}
    const chatKey = typeof opts.chatKey === 'string' ? opts.chatKey : ''
    const limit = Math.floor(num(opts.limit)) >= 1 ? Math.floor(num(opts.limit)) : DEFAULT_RECENT_LINES
    const maxChars = Math.floor(num(opts.maxChars)) >= 100 ? Math.floor(num(opts.maxChars)) : 1000
    const days = Math.floor(num(opts.days)) >= 1 ? Math.floor(num(opts.days)) : 2

    const base = this.#nowMs()
    const wanted = []
    for (let offset = 0; offset < days; offset++) wanted.push(dayOffset(base, -offset))

    const picked = []
    let chars = 0
    let full = false

    outer: for (const day of wanted) {
      const name = `${day}.jsonl`
      const { records } = readShard(join(this.dir, name))
      // 同一分片内后写的 ts 更大：倒序读即天然的新→旧
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]
        // chatKey 为空时不过滤（调用方明确要"不分会话"）；否则只认本会话
        if (chatKey !== '' && record.chatKey !== chatKey) continue
        const text = record.text
        if (typeof text !== 'string' || text.trim() === '') continue
        if (picked.length >= limit || chars + text.length > maxChars) { full = true; break outer }
        picked.push(record)
        chars += text.length
      }
    }

    return picked.reverse()
  }

  /**
   * 【本地补丁 23 · 步3】按正文子串找记录（修订定位用）。
   *
   * 与 `search()` 的区别：不分词、不玩 AND、也不比对人名 —— 只认一段**连续原文**，
   * 因为修订给的是一句引文，拆成词反而会命中一堆无关行。新→旧扫，命中即返回。
   *
   * @param {string} needle 原话片段（大小写不敏感）
   * @param {{ days?: number, limit?: number, kinds?: string[] | null }} [options]
   * @returns {object[]} 归档记录（新→旧）
   */
  findText(needle, options) {
    const opts = (options !== null && typeof options === 'object') ? options : {}
    const want = str(needle).trim().toLowerCase()
    if (want.length < 2) return []
    const max = Math.max(1, Math.min(200, Math.floor(num(opts.limit)) || 20))
    const window = Math.max(1, Math.min(180, Math.floor(num(opts.days)) || 30))
    const kinds = Array.isArray(opts.kinds) ? opts.kinds : null
    let names = this.#shardNames()
    if (names.length > window) names = names.slice(names.length - window)
    const hits = []
    for (let i = names.length - 1; i >= 0; i--) {
      const { records } = readShard(join(this.dir, names[i]))
      for (let j = records.length - 1; j >= 0; j--) {
        const record = records[j]
        if (kinds !== null && kinds.includes(str(record.kind)) !== true) continue
        if (str(record.text).toLowerCase().includes(want) !== true) continue
        hits.push(record)
        if (hits.length >= max) return hits
      }
    }
    return hits
  }

  /**
   * 把早于 `keepDays` 的分片**移走**（搬到回收站，绝不直接删除）。
   *
   * @param {{ trashDir?: string }} [options] trashDir 为空时用 `dir` 同级的 `qq-trash/<当天>/`
   * @returns {{ moved: string[], kept: number }} moved 是成功搬走的文件名（升序）；kept 是留在原地的分片数
   */
  prune(options) {
    const opts = (options !== null && typeof options === 'object') ? options : {}
    const nowMs = this.#nowMs()
    const names = this.#shardNames()
    // 今天是第 0 天：keepDays=90 表示"保留今天+前 89 天"，第 90 天及更早搬走
    const cutoff = dayOffset(nowMs, -this.keepDays)
    const trashDir = (typeof opts.trashDir === 'string' && opts.trashDir !== '')
      ? opts.trashDir
      : join(dirname(this.dir), 'qq-trash')

    const moved = []
    let kept = 0
    for (const name of names) {
      const day = name.slice(0, -'.jsonl'.length)
      // 不合法日期的分片不动它（免得把别人的文件搬走）
      if (!isValidDay(day) || day >= cutoff) { kept++; continue }
      const dest = moveIntoTrash(join(this.dir, name), trashDir, nowMs)
      if (dest === '') { kept++; continue }
      moved.push(name)
    }
    return { moved, kept }
  }

  /**
   * 归档概览：分片数、总字节、最早/最新的分片日期。
   * 只按文件名排序取首尾，不解析任何内容。
   * @returns {{ dir: string, files: number, bytes: number, oldest: string, newest: string }}
   */
  stats() {
    const names = this.#shardNames()
    let bytes = 0
    for (const name of names) {
      try { bytes += statSync(join(this.dir, name)).size } catch { /* 单个文件读不到就跳过 */ }
    }
    return {
      dir: this.dir,
      files: names.length,
      bytes,
      // 文件名升序 = 时间升序，所以首=最早、尾=最新
      oldest: names.length > 0 ? names[0].slice(0, 10) : '',
      newest: names.length > 0 ? names[names.length - 1].slice(0, 10) : '',
    }
  }
}


/** 索引目录里的 README（给模型看的"这堆文件是什么、怎么用"）。 */
const MEMORY_INDEX_README = [
  '# 长期记忆索引（本地补丁 21）',
  '',
  '这个目录由 QQ 桥自动维护：每条消息（含机器人自己的回复、以及它顺手留的摘要）都会追加一行，写的时候不需要模型。',
  '',
  '- `day/<YYYY-MM-DD>.md`：按天。每行 `- HH:MM [会话] 说话人(QQ号)：文本`',
  '  机器人自己的话单独标：`🤖名字` = 它真发出去的回复（kind=reply），`📝名字` = 它自己写的记忆摘要（kind=note）',
  '- `person/<QQ号>.md`：按人。同一个人跨天、跨群说过的话都在这里',
  '- `group/<群号>.md` / `private/<QQ号>.md`：按会话（群聊 / 私聊）',
  '- `DIGEST.md`：最近几天的概览；常驻提示词里注入的就是它',
  '',
  '**分段规则**：同一个容器写满约 1.8 万字节就另起一段，文件名依次是',
  '`base.md` → `base.p2.md` → `base.p3.md`…（段号越大越新）。',
  '这样分是因为 `qq_read_file` 单次只返回 2 万字：不分段的话，文件长起来之后',
  '模型读到的永远是最老的开头。翻最近的记录，先看段号最大的那个文件。',
  '',
  '翻旧账的顺序：`qq_search_files` 搜关键词 → `qq_read_file` 读命中的整个文件。',
  '**`qq_search_files` 的 path 只能写到目录**（如 `memory-index/person`、`memory-index/day`、`memory-index/day/2026-10`）；',
  '写成具体文件名（`memory-index/person/<QQ号>.md`）会扫到 0 个文件 —— 已经知道是哪个文件就直接 `qq_read_file`。',
  '单行有截断（上限见配置 `memoryIndexMaxLineChars`），完整原文在 `qq-history/` 的日分片里。',
  '',
  '**什么时候写、写哪里**：想让你自己长期记住 → `qq_memory_note`（写一次，归档和索引都会有，不要重复写）；只是这轮要说、过后忘了也无所谓 → 什么都不用写，本聊天的转录会自动留在索引里；说错了 → `qq_memory_fix`（原文不删）。**同一条事实只记一处**，别既写 note 又在回复里复述一遍。',
  '',
  '**修订（本地补丁 23 · 步3）**：记错 / 过期的记忆不删原文，只标记。',
  '- `FIXES.md`：追加式台账（什么时候、在哪个会话、改了哪一段、改成了什么）；',
  '- 索引正文里被修订的那一行会带后缀：`⟪已更正 2026-10-16 00:52：新说法⟫` / `⟪已过期 2026-10-16 00:52⟫` / `⟪已撤回 2026-10-16 00:52⟫`；',
  '- 读到带后缀的行，**一律以后缀里的说法为准**；原文没被删，只是不再代表现在的事实；',
  '- 修订是机器人用 `qq_memory_fix` 工具做的（`find` 给一段原话定位，`action` 选 correct / stale / retract）；想主动补记一条用 `qq_memory_note`。',
].join('\n')

/** 本地时间 `HH:MM`。 */
function hhmm(ts) {
  const d = new Date(num(ts))
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 归档会话键 → 索引分桶（群 / 私聊）。 */
function chatBucket(chatKey) {
  const key = str(chatKey)
  if (key.startsWith('g:')) return { dir: 'group', key: key.slice(2).replace(/[^\w-]/g, '_') || 'unknown' }
  if (key.startsWith('u:')) return { dir: 'private', key: key.slice(2).replace(/[^\w-]/g, '_') || 'unknown' }
  return { dir: 'group', key: 'other' }
}

/** 归档会话键 → 人能看懂的标签。 */
function chatLabel(chatKey) {
  const key = str(chatKey)
  if (key.startsWith('g:')) return `群${key.slice(2)}`
  if (key.startsWith('u:')) return `私聊${key.slice(2)}`
  return key === '' ? '未知会话' : key
}

/**
 * 索引行里的说话人：机器人自己的话单独标出来。
 * `🤖` = 它真的发出去的回复（kind=reply），`📝` = 它顺手留的记忆摘要（kind=note，本地补丁 22），
 * `🩹` = 修订台账行（kind=fix，本地补丁 23）。
 */
function speaker(record) {
  const name = str(record.name)
  const kind = str(record.kind)
  if (kind === 'reply') return `🤖${name || '助手'}`
  if (kind === 'note') return `📝${name || '助手'}`
  if (kind === 'fix') return `🩹${name || '助手'}`
  const uid = num(record.userId)
  return `${name || 'QQ' + uid}(${uid})`
}

/**
 * 【本地补丁 22 · 步2】把回复末尾的摘要行摘出来。
 *
 * 约定：模型在这一轮回复的最后另起一行写 `<marker>摘要</marker>`（标记由
 * `memoryNoteMarker` 配置，默认 `⟦M⟧` / `⟦/M⟧`）。摘要是它本来就输出的文本，
 * 所以这条链路**零额外模型调用**；摘要在发送前剥掉，对方看不到标记。
 *
 * 三条硬约定（都是"宁可不记，也不能影响回复"）：
 * - 只剥标记块，标记块之外的内容一个字不动；
 * - 命中失败（没写/写坏/开关关掉）→ 原样返回，回复照常发；
 * - 剥完只剩空白（整条消息就是一个摘要）→ 返回空正文，由调用方决定不发空消息；
 *   但仍会把摘要交回去，因为它本身是真的。
 */
export function extractNote(text, { marker = '⟦M⟧', maxChars = 200 } = {}) {
  const raw = String(text ?? '')
  const mk = String(marker ?? '')
  if (mk.length < 2) return { text: raw, note: '' }
  const open = mk.slice(0, 1)
  const name = mk.slice(1, -1)
  const close = mk.slice(-1)
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const limit = Math.max(1, num(maxChars))
  // 内层上限给得比 limit 宽松，是为了"写得长"不要变成"整条都匹配不上"（宁可截断，不可漏剥）。
  const cap = Math.min(20000, Math.max(500, limit * 5))
  // 【补丁 42】三条容错（都是线上事故换来的）：
  //   ① 收尾：约定是 ⟦/M⟧，实测会写成 ⟦／M⟧（全角斜杠）、⟦⟧，甚至只留一个 ⟧ —— 长写法必须排在
  //      前面，否则裸 ⟧ 先吃掉 ⟦/M⟧ 的最后一笔，正文里留下半个标记（比不剥更难看）；
  //   ② 位置：约定是"另起一行"，实测会紧跟正文同一行（前面只隔一个空格）—— 不再锚行首，
  //      只用"标记 + 收尾"这对括号定位，避免整块漏剥；
  //   ③ 标记本身也会写空（⟦⟧，名字段没了）—— 名字段按可选处理。
  const closers = [open + '/' + name + close, open + '／' + name + close, open + close, close]
    .filter((item, index, list) => item !== '' && list.indexOf(item) === index)
    .sort((a, b) => b.length - a.length)
    .map((item) => esc(item))
    .join('|')
  const markRe = esc(open) + (name === '' ? '' : '(?:' + esc(name) + ')?') + esc(close)
  const re = new RegExp(markRe + '([\\s\\S]{0,' + cap + '}?)(?:' + closers + ')', 'g')
  const PLACE = '\u0000N\u0000'
  const DROP_NEXT_LINE = '\u0000L\u0000'
  const DROP_PREV_LINE = '\u0000H\u0000'
  let found = false
  let last = ''
  let source = raw.replace(re, (all, inner, offset, whole) => {
    found = true
    last = inner
    const head = whole.slice(0, offset)
    const tail = whole.slice(offset + all.length)
    // 摘要独占一行是模型的常态写法，剥掉整块之后那一行的换行也要一起去掉，否则正文中间会多出
    // 一条空行（用户看到的就是"格式掉了"的另一种形状）。
    if (/(?:^|\n)[ \t\u3000]*$/.test(head)) {
      if (/^[ \t\u3000]*\r?\n/.test(tail)) return DROP_NEXT_LINE
      return DROP_PREV_LINE
    }
    return PLACE
  })
  if (found === false) {
    // 【补丁 42】兜底：连收尾都彻底写坏了（标记后面再没有任何收尾符号）。协议规定摘要永远写在
    //   回复最后，所以「最后一个标记 → 文本结尾」整段按摘要处理：宁可多剥一句，也不让标记进群。
    const hits = [...raw.matchAll(new RegExp(markRe, 'g'))]
    if (hits.length > 0) {
      const hit = hits[hits.length - 1]
      found = true
      last = raw.slice(hit.index + hit[0].length)
      source = raw.slice(0, hit.index) + PLACE
    }
  }
  if (found === false) return { text: raw, note: '' }
  const body = source
    .replace(new RegExp(DROP_NEXT_LINE + '[ \\t\\u3000]*\\r?\\n', 'g'), '')
    .replace(new RegExp('\\r?\\n[ \\t\\u3000]*' + DROP_PREV_LINE, 'g'), '')
    .split(DROP_NEXT_LINE).join('')
    .split(DROP_PREV_LINE).join('')
    .split(PLACE).join('')
    .split(mk).join('')
    .replace(/[ \t\u3000]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd()
  const note = collapse(last).trim().slice(0, limit)
  return { text: body, note }
}

/** 修订动作：`correct` = 换一个正确说法；`stale` = 标过期（不再成立）；`retract` = 撤回（这条本身是错的）。 */
export const FIX_ACTIONS = ['correct', 'stale', 'retract']

/** 修订记录在归档里的前缀：`kind='fix'` 的 text 就是 `⟦FIX⟧{json}`，重建索引时可原样重放。 */
const FIX_PREFIX = '⟦FIX⟧'

/**
 * 【本地补丁 23 · 步3】把一次修订组装成归档记录（写进 `qq-history/<日期>.jsonl`）。
 *
 * 为什么把目标记录的字段一起存进去：重建索引时要能把"那一行"原样复现出来再加后缀，
 * 所以目标的时间 / 会话 / 说话人 / 原文都得跟着修订一起走。原文一个字不删。
 *
 * @param {{ ts?: number, action?: string, chatKey?: string, by?: string, find?: string, note?: string, reason?: string, target?: object }} fix
 * @returns {{ ts: number, chatKey: string, userId: number, name: string, kind: string, text: string }}
 */
export function makeFixRecord(fix = {}) {
  const source = (fix !== null && typeof fix === 'object') ? fix : {}
  const target = (source.target !== null && typeof source.target === 'object') ? source.target : {}
  const ts = num(source.ts) || Date.now()
  const payload = {
    v: 1,
    ts,
    action: str(source.action),
    chatKey: str(source.chatKey),
    by: str(source.by),
    find: clip(collapse(source.find), 200),
    note: clip(collapse(source.note), 400),
    reason: clip(collapse(source.reason), 200),
    target: {
      ts: num(target.ts),
      chatKey: str(target.chatKey),
      userId: num(target.userId),
      name: str(target.name),
      kind: str(target.kind),
      text: clip(collapse(target.text), 600),
    },
  }
  return {
    ts,
    chatKey: payload.chatKey || payload.target.chatKey,
    userId: payload.target.userId,
    name: payload.by || '助手',
    kind: 'fix',
    text: `${FIX_PREFIX}${JSON.stringify(payload)}`,
  }
}

/** 解析 `kind='fix'` 的归档记录 → 修订载荷；坏行 / 旧格式一律返回 null（绝不抛错）。 */
export function parseFixRecord(record) {
  try {
    const text = str((record !== null && typeof record === 'object') ? record.text : '')
    if (text.startsWith(FIX_PREFIX) !== true) return null
    const payload = JSON.parse(text.slice(FIX_PREFIX.length))
    if (payload === null || typeof payload !== 'object') return null
    if (FIX_ACTIONS.includes(str(payload.action)) !== true) return null
    const target = payload.target
    if (target === null || typeof target !== 'object' || num(target.ts) <= 0) return null
    return payload
  } catch {
    return null
  }
}

/**
 * 长期记忆索引（本地补丁 21 · 步1）：把归档切成"按天 / 按人 / 按会话"的 markdown
 * 索引，再把最近几天的概览压成一份常驻摘要。
 *
 * 为什么不上向量库：QQ 里的检索是"翻旧账"，关键词字面命中就够；真正的成本在**读侧**——
 * 每轮先搜一遍再开口，token 账立刻起飞。这里改成"写做便宜、读做懒加载"：
 * 写入零模型调用（每条消息追加一行），读取交给 qq_search_files / qq_read_file，
 * 模型自己 grep，不花额外 token。
 *
 * 两条硬约束（都是被真档案打出来的）：
 * - **单文件必须读得完**：`qq_read_file` 单次上限 2 万字，所以每个容器写满
 *   `chunkBytes` 就分段（`base.p2.md`…），否则文件长大后模型只能看到最老的开头。
 * - **整窗追平必须快**：状态游标不能"每条记录写一次盘"（真档案 3370 条要 22 秒），
 *   批量追平时改成延迟落盘、收尾一次写；逐条 append（线上路径）仍然即时落盘。
 *
 * 目录结构见 `MEMORY_INDEX_README`。所有 fs 操作尽力而为、失败返回 false/空、绝不抛错
 * （索引是旁路，坏掉不能带崩桥——与 HistoryArchive 同一条约定）。
 */
export class MemoryIndex {
  /**
   * @param {{ dir?: string, digestDays?: number, digestMaxChars?: number, maxLineChars?: number, chunkBytes?: number, now?: () => number }} options
   */
  constructor({ dir, digestDays = 3, digestMaxChars = 1200, maxLineChars = 200, chunkBytes = 18000, now } = {}) {
    this.dir = str(dir)
    this.dirLabel = basename(this.dir) || 'memory-index'
    this.digestDays = Math.max(1, Math.min(30, num(digestDays) || 3))
    this.digestMaxChars = Math.max(200, Math.min(4000, num(digestMaxChars) || 1200))
    this.maxLineChars = Math.max(40, Math.min(1000, num(maxLineChars) || 200))
    // 默认 18000 字节：CJK 一个字 3 字节，最坏情况（全 ASCII）也还有 2 万字的安全余量
    this.chunkBytes = Math.max(2000, Math.min(19000, num(chunkBytes) || 18000))
    this.now = typeof now === 'function' ? now : Date.now
    this.lastTs = 0
    this.days = {}
    this.parts = {}
    this.cachedText = ''
    this.pendingSaves = 0
    // 【本地补丁 23 · 步3】修订台账：从 FIXES.md 读回来（重启后不靠状态文件也能续写），上限 500 行。
    this.fixLines = []
    this.#loadFixLines()
    this.#loadState()
  }

  /** 索引根目录下的完整路径。 */
  #file(...parts) {
    return join(this.dir, ...parts)
  }

  /** 写文件：append=false 时用"临时文件 + rename"原子替换（半截文件永远不会被 grep 到）。 */
  #write(file, text, append = false) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      if (append) {
        appendFileSync(file, text)
        return true
      }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, text)
      renameSync(tmp, file)
      return true
    } catch {
      return false
    }
  }

  #stateFile() {
    return this.#file('.state.json')
  }

  #loadState() {
    try {
      const parsed = JSON.parse(readFileSync(this.#stateFile(), 'utf8'))
      if (parsed !== null && typeof parsed === 'object') {
        this.lastTs = num(parsed.lastTs)
        if (parsed.days !== null && typeof parsed.days === 'object') this.days = parsed.days
        if (parsed.parts !== null && typeof parsed.parts === 'object') this.parts = parsed.parts
      }
    } catch {
      // 没有状态文件 = 第一次跑，lastTs=0 会让 catchUp 整窗重扫
    }
  }

  #saveState() {
    const names = Object.keys(this.parts)
    if (names.length > 500) for (const key of names.slice(0, names.length - 400)) delete this.parts[key]
    const body = JSON.stringify({ lastTs: this.lastTs, days: this.days, parts: this.parts })
    this.#write(this.#stateFile(), body)
    this.pendingSaves = 0
  }

  /**
   * 索引是否已经有内容（挡住"状态还在、内容被删了"的静默漏记）。
   * 只看 `day/`：它是索引的主干，任何一条记录都必须写它；
   * person / group / private 允许为空（比如某个会话还没说过话）。
   */
  #hasContent() {
    try {
      return readdirSync(this.#file('day')).length > 0
    } catch {
      return false
    }
  }

  /** 某一段的文件名（段 1 不带后缀）。 */
  #partName(base, part) {
    return part <= 1 ? `${base}.md` : `${base}.p${part}.md`
  }

  /** 给人看的相对路径（digest 里引用用，永远用 / 分隔）。 */
  #display(dir, base, part) {
    return `${this.dirLabel}/${dir}/${this.#partName(base, part)}`
  }

  /**
   * 分段写入：同一容器写满 `chunkBytes` 就另起一段。
   * `header(part)` 只在"这个段文件是新建的"时候写一次。
   */
  #writeChunked(dir, base, line, header = null) {
    const key = `${dir}/${base}`
    let part = num(this.parts[key]) || 1
    for (let guard = 0; guard < 1000; guard++) {
      const file = this.#file(dir, this.#partName(base, part))
      let size = -1
      try { size = statSync(file).size } catch { size = -1 }
      if (size < 0 || size < this.chunkBytes) {
        this.parts[key] = part
        const prefix = (size < 0 && typeof header === 'function') ? header(part) : ''
        this.#write(file, `${prefix}${line}`, true)
        return
      }
      part++
    }
  }

  /** 每日计数：给 DIGEST 用，避免每次刷摘要都重扫分片。 */
  #bump(record, day) {
    let bucket = this.days[day]
    if (bucket === null || typeof bucket !== 'object') {
      bucket = { count: 0, users: {}, chats: {}, first: 0, last: 0 }
      this.days[day] = bucket
    }
    bucket.count = num(bucket.count) + 1
    const uid = String(num(record.userId))
    bucket.users[uid] = num(bucket.users[uid]) + 1
    const chatKey = str(record.chatKey)
    if (chatKey !== '') bucket.chats[chatKey] = num(bucket.chats[chatKey]) + 1
    const ts = num(record.ts)
    if (num(bucket.first) === 0 || (ts > 0 && ts < num(bucket.first))) bucket.first = ts
    if (ts > num(bucket.last)) bucket.last = ts
    // 只留最近 14 天，防止状态文件无限长大
    const names = Object.keys(this.days).sort()
    for (const stale of names.slice(0, Math.max(0, names.length - 14))) delete this.days[stale]
  }

  /**
   * 一条记录 → 三向索引（天 / 人 / 会话）+ 计数。
   * @param {{ ts?: number, chatKey?: string, userId?: number, name?: string, kind?: string, text?: string }} record
   * @param {{ deferState?: boolean }} options 批量追平时用 deferState:true（收尾统一落盘）
   * @returns {boolean} 是否写入
   */
  append(record, { deferState = false } = {}) {
    try {
      const rec = (record !== null && typeof record === 'object') ? record : {}
      const ts = num(rec.ts)
      const text = collapse(rec.text)
      if (ts <= 0 || text === '') return false
      const day = dayOf(ts)
      const time = hhmm(ts)
      const line = clip(text, this.maxLineChars)
      const bucket = chatBucket(rec.chatKey)
      const label = chatLabel(rec.chatKey)
      // ① 按天
      this.#writeChunked('day', day, `- ${time} [${label}] ${speaker(rec)}：${line}\n`,
        (part) => `# ${day}（第 ${part} 段，越靠后越新）\n\n`)
      // ② 按人（首次出现补一行"这是谁"的表头，方便模型只看一个文件就够）
      const uid = num(rec.userId)
      if (uid > 0) {
        const who = str(rec.name) || 'QQ' + uid
        this.#writeChunked('person', String(uid), `- ${day} ${time} [${label}] ${line}\n`,
          (part) => `# ${who} (QQ ${uid})${part > 1 ? ` · 第 ${part} 段（越靠后越新）` : ''}\n\n`)
      }
      // ③ 按会话
      this.#writeChunked(bucket.dir, bucket.key, `- ${day} ${time} [${speaker(rec)}] ${line}\n`,
        (part) => `# ${label}${part > 1 ? ` · 第 ${part} 段（越靠后越新）` : ''}\n\n`)
      this.#bump(rec, day)
      if (ts > this.lastTs) {
        this.lastTs = ts
        this.pendingSaves++
        // 批量追平：每 200 条落一次盘（不要每条都写——真档案 3370 条会慢到 20 秒）；
        // 线上逐条路径（deferState=false）仍然即时落盘，保证重启后游标是准的。
        if (deferState === false || this.pendingSaves >= 200) this.#saveState()
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * 从归档分片追平：把 `lastTs` 之后的记录补进索引（启动时跑一次）。
   * 第一次跑（lastTs = 0）或 `day/` 被清空时会整窗重扫。
   * @param {{ dir?: string, days?: number }} options
   * @returns {{ indexed: number, days: number, rebuilt: boolean }}
   */
  catchUp({ dir, days = 30 } = {}) {
    const archiveDir = str(dir)
    if (archiveDir === '') return { indexed: 0, days: 0, rebuilt: false }
    let rebuilt = false
    if (this.lastTs > 0 && !this.#hasContent()) {
      this.lastTs = 0
      rebuilt = true
    }
    const window = Math.max(1, Math.min(180, num(days) || 30))
    let names = []
    try {
      names = readdirSync(archiveDir).filter((name) => SHARD_RE.test(name)).sort()
    } catch {
      return { indexed: 0, days: 0, rebuilt }
    }
    // 只补最近 `window` 天的分片（文件名升序 = 时间升序）
    if (names.length > window) names = names.slice(names.length - window)
    let indexed = 0
    let scanned = 0
    for (const name of names) {
      const { records } = readShard(join(archiveDir, name))
      scanned++
      for (const record of records) {
        if (num(record.ts) <= this.lastTs) continue
        // 【本地补丁 23】修订也走同一条追平路：重建索引时按时间顺序重放，
        // 于是"哪条被改过、改成了什么"不依赖额外状态就能复原。
        if (str(record.kind) === 'fix') {
          const payload = parseFixRecord(record)
          if (payload !== null && this.fix(payload, { deferState: true }) === true) indexed++
          // 游标也要跟着走：修订常常是归档里的最后一条，不推游标每次追平都会把它当新记录重放。
          this.lastTs = Math.max(this.lastTs, num(record.ts))
          continue
        }
        if (this.append(record, { deferState: true }) === true) indexed++
      }
    }
    this.#saveState()
    return { indexed, days: scanned, rebuilt }
  }

  /* ------------------------------------------------------------------ *
   * 【本地补丁 23 · 步3】修订层：记错了能改、能标过期，而不是只剩"删掉"
   * ------------------------------------------------------------------ */

  /** 读回已有的修订台账（FIXES.md 是人可读文件，重启后直接续写）。 */
  #loadFixLines() {
    try {
      const body = readFileSync(this.#file('FIXES.md'), 'utf8')
      const lines = body.split('\n').filter((line) => line.startsWith('- '))
      this.fixLines = lines.slice(Math.max(0, lines.length - 500))
    } catch {
      // 还没有台账
    }
  }

  /** 重写 FIXES.md（原子写）。 */
  #writeFixLedger() {
    const head = [
      '# 修订台账（本地补丁 23 · 步3：追加式，只标不改史）',
      '',
      '索引正文里被修订的那一行会带后缀：`⟪已更正 <时间>：新说法⟫` / `⟪已过期 <时间>⟫` / `⟪已撤回 <时间>⟫`。',
      '读到带后缀的行，一律以修订为准；原文没有被删掉，仍在 `qq-history/` 的日分片里。',
      '',
    ]
    this.#write(this.#file('FIXES.md'), `${head.concat(this.fixLines.length > 0 ? this.fixLines : ['（暂无修订：还没有哪条记忆被更正 / 标过期 / 撤回）']).join('\n')}\n`)
  }

  /** 台账里的一行（人可读；也是常驻摘要引用"最近一条修订"的来源）。 */
  #fixLedgerLine(payload) {
    const ts = num(payload.ts) || this.now()
    const stamp = `${dayOf(ts)} ${hhmm(ts)}`
    const action = str(payload.action)
    const target = (payload.target !== null && typeof payload.target === 'object') ? payload.target : {}
    const label = chatLabel(str(payload.chatKey) || str(target.chatKey))
    const who = str(payload.by) || '助手'
    const quote = clip(str(payload.find) || collapse(target.text), 60)
    const note = str(payload.note)
    const reason = str(payload.reason)
    const head = action === 'correct'
      ? `更正「${quote}」→「${clip(note, 160)}」`
      : (action === 'stale' ? `标记过期「${quote}」` : `撤回「${quote}」`)
    return `- ${stamp} [${label}] 🩹${who}：${head}${reason === '' ? '' : `（原因：${clip(reason, 80)}）`}`
  }

  /** 复现 `append()` 会写出的三行（修订要在 day / 人 / 会话三处都标，模型读哪个文件都能看到）。 */
  #lineVariants(target) {
    const rec = (target !== null && typeof target === 'object') ? target : {}
    const ts = num(rec.ts)
    const text = collapse(rec.text)
    if (ts <= 0 || text === '') return []
    const record = { ts, chatKey: str(rec.chatKey), userId: num(rec.userId), name: str(rec.name), kind: str(rec.kind), text }
    const day = dayOf(ts)
    const time = hhmm(ts)
    const line = clip(text, this.maxLineChars)
    const bucket = chatBucket(record.chatKey)
    const label = chatLabel(record.chatKey)
    const out = [{ dir: 'day', base: day, line: `- ${time} [${label}] ${speaker(record)}：${line}` }]
    if (record.userId > 0) out.push({ dir: 'person', base: String(record.userId), line: `- ${day} ${time} [${label}] ${line}` })
    out.push({ dir: bucket.dir, base: bucket.key, line: `- ${day} ${time} [${speaker(record)}] ${line}` })
    return out
  }

  /**
   * 某个容器实际存在的段号（从大到小）。不用状态里的段号，是因为状态可能比磁盘旧
   * （比如 `.state.json` 被删过），漏扫段 = 该标的行没标上。
   */
  #partNumbers(dir, base) {
    const found = []
    const esc = String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try {
      for (const name of readdirSync(this.#file(dir))) {
        if (name === `${base}.md`) { found.push(1); continue }
        const matched = new RegExp(`^${esc}\\.p(\\d+)\\.md$`).exec(name)
        if (matched !== null) found.push(num(matched[1]))
      }
    } catch {
      // 目录不存在
    }
    if (found.length === 0) found.push(num(this.parts[`${dir}/${base}`]) || 1)
    return found.sort((a, b) => b - a)
  }

  /**
   * 给某一行补后缀（原文一个字不动，只在行尾追加 `⟪…⟫`）。
   * 已有后缀先摘掉再写 —— 这样同一条被改第二次不会叠成一串，重放也天然幂等。
   */
  #suffixLine(dir, base, line, suffix) {
    for (const part of this.#partNumbers(dir, base)) {
      const file = this.#file(dir, this.#partName(base, part))
      let body = ''
      try {
        body = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const at = body.indexOf(line)
      if (at < 0) continue
      let end = body.indexOf('\n', at)
      if (end < 0) end = body.length
      const current = body.slice(at, end).replace(/ ⟪[^⟫]*⟫/g, '')
      return this.#write(file, `${body.slice(0, at)}${current}${suffix}${body.slice(end)}`)
    }
    return false
  }

  /** 修订行本身也进 day / 会话 / 人（与 `append()` 同构，但不计数、不动游标）。 */
  #writeFixLine(record) {
    const rec = (record !== null && typeof record === 'object') ? record : {}
    const ts = num(rec.ts)
    const text = collapse(rec.text)
    if (ts <= 0 || text === '') return
    const day = dayOf(ts)
    const time = hhmm(ts)
    const line = clip(text, this.maxLineChars)
    const bucket = chatBucket(rec.chatKey)
    const label = chatLabel(rec.chatKey)
    this.#writeChunked('day', day, `- ${time} [${label}] ${speaker(rec)}：${line}\n`,
      (part) => `# ${day}（第 ${part} 段，越靠后越新）\n\n`)
    const uid = num(rec.userId)
    if (uid > 0) {
      const who = str(rec.name) || 'QQ' + uid
      this.#writeChunked('person', String(uid), `- ${day} ${time} [${label}] ${line}\n`,
        (part) => `# ${who} (QQ ${uid})${part > 1 ? ` · 第 ${part} 段（越靠后越新）` : ''}\n\n`)
    }
    this.#writeChunked(bucket.dir, bucket.key, `- ${day} ${time} [${speaker(rec)}] ${line}\n`,
      (part) => `# ${label}${part > 1 ? ` · 第 ${part} 段（越靠后越新）` : ''}\n\n`)
  }

  /**
   * 【本地补丁 23 · 步3】修订一条记忆：给目标行加后缀 + 写台账 + 在索引里留一行 `🩹`。
   *
   * 三条约定：
   * - **不删史**：目标行原样保留，只追加 `⟪已更正…⟫` / `⟪已过期…⟫` / `⟪已撤回…⟫`；
   * - **可重放**：`catchUp()` 重扫分片时会得到同一结果（靠"先摘旧后缀再写新后缀"保证幂等）；
   * - **尽力而为**：目标行找不到（已超出索引窗口 / 被清过）→ 只写台账与 `🩹` 行，不抛错。
   *
   * @param {object} payload `parseFixRecord()` 的输出（或同形对象）
   * @param {{ deferState?: boolean }} [options]
   * @returns {boolean} 是否至少标注到了一处
   */
  fix(payload, { deferState = false } = {}) {
    try {
      const fix = (payload !== null && typeof payload === 'object') ? payload : null
      if (fix === null) return false
      const action = str(fix.action)
      if (FIX_ACTIONS.includes(action) !== true) return false
      const target = (fix.target !== null && typeof fix.target === 'object') ? fix.target : null
      if (target === null || num(target.ts) <= 0) return false
      const ts = num(fix.ts) || this.now()
      const stamp = `${dayOf(ts)} ${hhmm(ts)}`
      const note = collapse(fix.note)
      let suffix = ''
      if (action === 'correct') suffix = ` ⟪已更正 ${stamp}${note === '' ? '' : `：${clip(note, 80)}`}⟫`
      else if (action === 'stale') suffix = ` ⟪已过期 ${stamp}⟫`
      else suffix = ` ⟪已撤回 ${stamp}⟫`
      let marked = 0
      for (const variant of this.#lineVariants(target)) {
        if (this.#suffixLine(variant.dir, variant.base, variant.line, suffix) === true) marked++
      }
      const quote = clip(str(fix.find) || collapse(target.text), 60)
      const record = {
        ts,
        chatKey: str(fix.chatKey) || str(target.chatKey),
        userId: num(target.userId),
        name: str(fix.by) || '助手',
        kind: 'fix',
        text: `已${action === 'correct' ? '更正' : action === 'stale' ? '标记过期' : '撤回'}「${quote}」${note === '' ? '' : `→「${clip(note, 120)}」`}`,
      }
      this.#writeFixLine(record)
      // 修订也占时间轴：游标推到它，下一次追平才不会把它当新记录重放一遍。
      this.lastTs = Math.max(this.lastTs, ts)
      const ledger = this.#fixLedgerLine({ ...fix, ts, action, target })
      if (this.fixLines.includes(ledger) !== true) {
        this.fixLines.push(ledger)
        if (this.fixLines.length > 500) this.fixLines = this.fixLines.slice(this.fixLines.length - 500)
      }
      this.#writeFixLedger()
      if (deferState === false) this.#saveState()
      return marked > 0
    } catch {
      return false
    }
  }

  /** 最近 N 天的概览（DIGEST.md 的正文，也是常驻段注入的内容）。 */
  #digestBody() {
    const today = dayOf(this.now())
    const newestParts = []
    for (const [key, part] of Object.entries(this.parts)) {
      const [dir, base] = key.split('/')
      if (dir !== 'day' || base !== today) continue
      newestParts.push(this.#display('day', base, num(part)))
    }
    const lines = [
      `${this.dirLabel}/ —— 本地补丁 21 维护的长期记忆索引（机械落盘，不花 token）`,
      `- 按天 ${this.dirLabel}/day/<日期>.md ｜ 按人 ${this.dirLabel}/person/<QQ号>.md ｜ 按群 ${this.dirLabel}/group/<群号>.md ｜ 按私聊 ${this.dirLabel}/private/<QQ号>.md`,
      `- 翻旧账：先用 qq_search_files 搜关键词，**path 只写到目录**（如 ${this.dirLabel}/person 或 ${this.dirLabel}/day/${today.slice(0, 7)}）——写成具体文件名会扫到 0 个文件；命中的文件用 qq_read_file 读（分成多段时先读段号最大的），已经知道是哪个文件就直接读。第一次没搜到就换个词再搜，别凭印象猜。`,
      '- 分段：长文件会被切成 `base.md`、`base.p2.md`、`base.p3.md`…**段号越大越新**（qq_read_file 单次上限 2 万字，分段保证每段都读得完）。',
      `- 记错 / 过期了：用 qq_memory_fix 修（原文不删——历史行会带上 ⟪已更正…⟫ / ⟪已过期…⟫ / ⟪已撤回…⟫ 后缀，台账在 ${this.dirLabel}/FIXES.md）；想主动补记一条用 qq_memory_note。`,
      `- 什么时候写、写哪里：想让你自己长期记住 → qq_memory_note（写一次，归档和索引都会有，不要重复写）；只是这轮要说、过后忘了也无所谓 → 什么都不用写，本聊天的转录会自动留在 ${this.dirLabel} 里；说错了 → qq_memory_fix（原文不删）。同一条事实只记一处，别既写 note 又在回复里复述一遍。`,
    ]
    if (newestParts.length > 0) lines.push(`- 今天的文件：${newestParts.join(' / ')}`)
    if (this.fixLines.length > 0) {
      const last = this.fixLines[this.fixLines.length - 1]
      lines.push(`- 修订：历史共 ${this.fixLines.length} 条，最近一条 ${last.slice(2, 18)} —— 带 ⟪…⟫ 后缀的行以修订为准（详见 ${this.dirLabel}/FIXES.md）。`)
    }
    lines.push(`- 最近 ${this.digestDays} 天：`)
    let seen = 0
    for (let offset = 0; offset < this.digestDays; offset++) {
      const day = dayOffset(this.now(), -offset)
      const bucket = this.days[day]
      if (bucket === null || typeof bucket !== 'object' || num(bucket.count) === 0) continue
      const chats = Object.entries(bucket.chats ?? {})
        .sort((a, b) => num(b[1]) - num(a[1]))
        .slice(0, 3)
        .map(([key, count]) => `${chatLabel(key)} ${num(count)}`)
        .join(' / ')
      const people = Object.keys(bucket.users ?? {}).length
      const first = hhmm(bucket.first)
      const last = hhmm(bucket.last)
      const span = first === last ? last : `${first}–${last}`
      lines.push(`  · ${day}：${num(bucket.count)} 条 · ${people} 人 · ${span}${chats === '' ? '' : ` · ${chats}`}`)
      seen++
    }
    if (seen === 0) lines.push('  · 暂无记录（索引随本补丁上线后开始积累）')
    // 硬预算：`clip()` 会额外补一个省略号（= 预算 + 1 字），常驻段这里必须严格不超预算。
    const body = lines.join('\n')
    return body.length > this.digestMaxChars ? `${body.slice(0, Math.max(0, this.digestMaxChars - 1))}…` : body
  }

  /** 重写 DIGEST.md 与 README.md（原子），并更新内存缓存。返回写入的摘要正文。 */
  writeDigest() {
    const body = this.#digestBody()
    this.#write(this.#file('DIGEST.md'), `${body}\n`)
    this.#write(this.#file('README.md'), `${MEMORY_INDEX_README}\n`)
    // 【本地补丁 21 · 步1】台账开机即建：FIXES.md 要等第一条修订才出现的写法在真机上被误读成
    // "修订功能没落地"（README 与 DIGEST 都写着台账在 FIXES.md，目录里却找不到那个本子）。
    this.#writeFixLedger()
    this.cachedText = body
    return body
  }

  /** 常驻段用的文本：只读内存缓存，不碰磁盘（每轮装配都会调用它）。 */
  text() {
    return this.cachedText
  }

  /** 概览（自检脚本 / 运行快照用）。 */
  stats() {
    let files = 0
    let bytes = 0
    for (const sub of ['day', 'person', 'group', 'private']) {
      try {
        for (const name of readdirSync(this.#file(sub))) {
          files++
          try { bytes += statSync(this.#file(sub, name)).size } catch { /* 读不到就跳过 */ }
        }
      } catch {
        // 目录不存在
      }
    }
    return {
      dir: this.dir,
      files,
      bytes,
      lastTs: this.lastTs,
      days: Object.keys(this.days).length,
      parts: Object.keys(this.parts).length,
      digestChars: this.cachedText.length,
      fixes: this.fixLines.length,
    }
  }
}

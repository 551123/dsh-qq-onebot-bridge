/**
 * 记忆卡片：把 qq-history 里的 note 记录做成可按意思检索的卡片。
 *
 * 两段式：
 *   1) 词法（永远可用，零依赖）：2-gram 覆盖率 + 精确子串 + 名字命中 + 时间衰减。
 *   2) 语义（可选）：bge-small-zh-v1.5 量化模型 + onnxruntime-node，CLS pooling + L2 归一化，
 *      与词法结果做 RRF 融合（1/(60+rank)）。
 *
 * 卡片产物落在 <root>/_memext/{cards.jsonl,vectors.bin,state.json}；
 * 可调项走 <root>/_memext/config.json（5 秒 TTL），不改 yml、不改 schema。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

export const variant = 'cards-v1'

const DEFAULTS = {
  searchMaxHits: 8,
  cardMaxChars: 160,
  cacheTtlSeconds: 60,
  semanticEnabled: true,
  maxQueryChars: 64,
  vectorTimeoutMs: 4000,
  semanticFloor: 0.5,
  candidatePool: 40,
  docMaxTokens: 256,
  queryMaxTokens: 64,
}

const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

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

function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: spec.required ?? [],
      properties: spec.properties ?? {},
    },
    output: OUTPUT,
    execute: spec.execute,
  }
}

/* ---------------------------------------------------------------- 基础工具 */

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
  } catch { /* 已存在 */ }
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function withTimeout(promise, ms) {
  let timer = null
  const guard = new Promise((done) => {
    timer = setTimeout(() => done(null), ms)
  })
  return Promise.race([promise, guard]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/* ------------------------------------------------------------------ 配置 */

const settingsCache = new Map()

function settings(root) {
  const hit = settingsCache.get(root)
  if (hit && Date.now() - hit.at < 5000) return hit.value
  const raw = readJson(join(root, '_memext', 'config.json'), null)
  const value = { ...DEFAULTS }
  if (raw && typeof raw === 'object') {
    for (const [key, item] of Object.entries(raw)) {
      if (key in DEFAULTS && item !== null && item !== undefined) value[key] = item
    }
  }
  value.semanticEnabled = value.semanticEnabled !== false
  value.searchMaxHits = Math.max(1, Math.min(20, Number(value.searchMaxHits) || DEFAULTS.searchMaxHits))
  value.cardMaxChars = Math.max(60, Math.min(400, Number(value.cardMaxChars) || DEFAULTS.cardMaxChars))
  value.candidatePool = Math.max(8, Math.min(200, Number(value.candidatePool) || DEFAULTS.candidatePool))
  value.semanticFloor = Math.max(0.2, Math.min(0.95, Number(value.semanticFloor) || DEFAULTS.semanticFloor))
  settingsCache.set(root, { at: Date.now(), value })
  return value
}

function resolveRoot(context) {
  const fromExt = String(context?.extConfig?.memoryRoot ?? '').trim()
  if (fromExt) return resolve(fromExt)
  const cwd = String(context?.config?.cwd ?? '').trim()
  if (cwd) return resolve(cwd)
  return resolve('D:/qq-work')
}

function paths(root) {
  const mem = join(root, '_memext')
  return {
    mem,
    history: join(root, 'qq-history'),
    cards: join(mem, 'cards.jsonl'),
    vectors: join(mem, 'vectors.bin'),
    state: join(mem, 'state.json'),
    model: join(mem, 'models', 'bge-small-zh-v1.5@512', 'model_quantized.onnx'),
    vocab: join(mem, 'models', 'bge-small-zh-v1.5@512', 'vocab.txt'),
    ort: join(mem, 'vendor', 'ort'),
  }
}

/* ------------------------------------------------------------------ 卡片 */

function historyFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
  } catch {
    return []
  }
}

function sourceSignature(dir) {
  const files = historyFiles(dir)
  let bytes = 0
  let newest = 0
  for (const name of files) {
    try {
      const st = statSync(join(dir, name))
      bytes += st.size
      if (st.mtimeMs > newest) newest = Math.floor(st.mtimeMs)
    } catch { /* 文件正在轮转 */ }
  }
  return sha1(files.length + '|' + bytes + '|' + newest)
}

function buildCards(dir) {
  const seen = new Set()
  const cards = []
  for (const name of historyFiles(dir)) {
    let text = ''
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const raw = line.trim()
      if (raw === '') continue
      let row = null
      try {
        row = JSON.parse(raw)
      } catch {
        continue
      }
      if (!row || row.kind !== 'note') continue
      const body = String(row.text ?? '').trim()
      if (body === '') continue
      const key = String(row.chatKey ?? '')
      if (key === '') continue
      const ts = Number(row.ts) || 0
      const id = 'note:' + key + ':' + ts
      if (seen.has(id)) continue
      seen.add(id)
      cards.push({
        id,
        ts,
        key,
        userId: Number(row.userId) || 0,
        name: String(row.name ?? ''),
        text: body,
      })
    }
  }
  cards.sort((a, b) => b.ts - a.ts)
  return cards
}

function readCardsFile(file) {
  const out = []
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const raw = line.trim()
    if (raw === '') continue
    try {
      const row = JSON.parse(raw)
      if (row && row.id && row.text) out.push(row)
    } catch { /* 半行写入，下次重建 */ }
  }
  return out
}

const cardCache = new Map()

function loadCards(root, s) {
  const now = Date.now()
  const hit = cardCache.get(root)
  if (hit && now - hit.at < s.cacheTtlSeconds * 1000) return hit.cards
  const p = paths(root)
  const sig = sourceSignature(p.history)
  if (hit && hit.sig === sig) {
    hit.at = now
    return hit.cards
  }
  const state = readJson(p.state, {})
  let cards = null
  if (state?.cards?.sourcesHash === sig && existsSync(p.cards)) {
    cards = readCardsFile(p.cards)
    if (cards.length !== Number(state.cards.count)) cards = null
  }
  if (!cards) {
    cards = buildCards(p.history)
    try {
      mkdirSync(p.mem, { recursive: true })
      const tmp = p.cards + '.tmp-' + process.pid
      writeFileSync(tmp, cards.map((card) => JSON.stringify(card)).join('\n') + '\n')
      renameSync(tmp, p.cards)
    } catch { /* 落盘失败不影响本次查询 */ }
    writeJsonAtomic(p.state, {
      ...state,
      cards: { sourcesHash: sig, count: cards.length, builtAt: new Date().toISOString() },
    })
  }
  cardCache.set(root, { at: now, sig, cards })
  return cards
}

/* ---------------------------------------------------------------- 分词器 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/
const ALNUM_RE = /[0-9a-z]/i
const UNK = 100
const CLS = 101
const SEP = 102
const PAD = 0

const vocabCache = new Map()

function loadVocab(file) {
  const hit = vocabCache.get(file)
  if (hit) return hit
  const map = new Map()
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    vocabCache.set(file, map)
    return map
  }
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const token = lines[i]
    if (token !== '' && !map.has(token)) map.set(token, i)
  }
  vocabCache.set(file, map)
  return map
}

function basicTokens(text) {
  const out = []
  let buf = ''
  const flush = () => {
    if (buf !== '') {
      out.push({ text: buf.toLowerCase(), cjk: false })
      buf = ''
    }
  }
  for (const ch of String(text ?? '')) {
    if (/\s/.test(ch)) {
      flush()
      continue
    }
    if (CJK_RE.test(ch)) {
      flush()
      out.push({ text: ch, cjk: true })
      continue
    }
    if (ALNUM_RE.test(ch)) {
      buf += ch
      continue
    }
    flush()
    out.push({ text: ch, cjk: false, punct: true })
  }
  flush()
  return out
}

function wordpiece(word, vocab) {
  if (vocab.has(word)) return [word]
  const out = []
  let start = 0
  while (start < word.length) {
    let end = word.length
    let piece = null
    while (end > start) {
      const candidate = (start === 0 ? '' : '##') + word.slice(start, end)
      if (vocab.has(candidate)) {
        piece = candidate
        break
      }
      end -= 1
    }
    if (piece === null) return null
    out.push(piece)
    start = end
  }
  return out
}

function encode(text, vocab, maxTokens) {
  const ids = []
  for (const token of basicTokens(text)) {
    if (token.cjk || token.punct) {
      const id = vocab.get(token.text)
      ids.push(id === undefined ? UNK : id)
      continue
    }
    const pieces = wordpiece(token.text, vocab)
    if (pieces === null) {
      ids.push(UNK)
      continue
    }
    for (const piece of pieces) ids.push(vocab.get(piece) ?? UNK)
    if (ids.length >= maxTokens) break
  }
  const body = ids.slice(0, Math.max(1, maxTokens - 2))
  return [CLS, ...body, SEP]
}

/* ------------------------------------------------------------------ 向量 */

const modelState = { ort: null, session: null, loading: null }
const vecCache = new Map()

function loadOrt(root) {
  if (modelState.ort) return modelState.ort
  const requireFromVendor = createRequire(join(paths(root).ort, 'noop.js'))
  modelState.ort = requireFromVendor('onnxruntime-node')
  return modelState.ort
}

async function getSession(root) {
  if (modelState.session) return modelState.session
  if (modelState.loading) return modelState.loading
  modelState.loading = (async () => {
    const ort = loadOrt(root)
    const session = await ort.InferenceSession.create(paths(root).model, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: 2,
    })
    modelState.session = session
    return session
  })()
  try {
    return await modelState.loading
  } finally {
    modelState.loading = null
  }
}

async function embedMany(root, texts, isQuery, s) {
  const ort = loadOrt(root)
  const session = await getSession(root)
  const vocab = loadVocab(paths(root).vocab)
  const limit = isQuery ? s.queryMaxTokens : s.docMaxTokens
  const out = []
  for (let offset = 0; offset < texts.length; offset += 8) {
    const chunk = texts.slice(offset, offset + 8)
    const encoded = chunk.map((text) => encode((isQuery ? QUERY_PREFIX : '') + text, vocab, limit))
    const width = encoded.reduce((max, ids) => Math.max(max, ids.length), 0)
    const batch = encoded.length
    const idsFlat = new BigInt64Array(batch * width)
    const maskFlat = new BigInt64Array(batch * width)
    for (let row = 0; row < batch; row += 1) {
      const ids = encoded[row]
      for (let col = 0; col < width; col += 1) {
        idsFlat[row * width + col] = BigInt(col < ids.length ? ids[col] : PAD)
        maskFlat[row * width + col] = BigInt(col < ids.length ? 1 : 0)
      }
    }
    const feeds = {
      input_ids: new ort.Tensor('int64', idsFlat, [batch, width]),
      attention_mask: new ort.Tensor('int64', maskFlat, [batch, width]),
      token_type_ids: new ort.Tensor('int64', new BigInt64Array(batch * width), [batch, width]),
    }
    let result = null
    try {
      result = await session.run(feeds)
    } catch (error) {
      delete feeds.token_type_ids
      result = await session.run(feeds)
    }
    const tensor = result.last_hidden_state ?? result[Object.keys(result)[0]]
    const dim = tensor.dims[tensor.dims.length - 1]
    const data = tensor.data
    for (let row = 0; row < batch; row += 1) {
      const vector = new Float32Array(dim)
      const base = row * width * dim
      let norm = 0
      for (let col = 0; col < dim; col += 1) {
        const value = data[base + col]
        vector[col] = value
        norm += value * value
      }
      norm = Math.sqrt(norm) || 1
      for (let col = 0; col < dim; col += 1) vector[col] /= norm
      out.push(vector)
    }
  }
  return out
}

function cardsHash(cards) {
  return sha1(cards.map((card) => card.id).join('|'))
}

async function ensureVectors(root, s, cards) {
  const key = root
  const ready = vecCache.get(key)
  if (ready && ready.data) return ready
  if (ready && ready.pending) return ready.pending
  const p = paths(root)
  if (!s.semanticEnabled || !existsSync(p.model) || !existsSync(p.ort)) return null
  const record = { data: null, ids: [], dim: 0, pending: null }
  vecCache.set(key, record)
  record.pending = (async () => {
    try {
      const source = cards ?? loadCards(root, s)
      const hash = cardsHash(source)
      const state = readJson(p.state, {})
      if (state?.vectors?.cardsHash === hash && state.vectors.count === source.length && existsSync(p.vectors)) {
        const buf = readFileSync(p.vectors)
        const dim = Number(state.vectors.dim) || 0
        if (dim > 0 && buf.byteLength === source.length * dim * 4) {
          const data = new Float32Array(source.length * dim)
          for (let i = 0; i < data.length; i += 1) data[i] = buf.readFloatLE(i * 4)
          record.data = data
          record.ids = source.map((card) => card.id)
          record.dim = dim
          return record
        }
      }
      const started = Date.now()
      const vectors = await embedMany(root, source.map((card) => card.text), false, s)
      const dim = vectors[0]?.length ?? 0
      if (dim === 0) return null
      const flat = new Float32Array(source.length * dim)
      vectors.forEach((vector, index) => flat.set(vector, index * dim))
      try {
        mkdirSync(p.mem, { recursive: true })
        const buf = Buffer.alloc(flat.length * 4)
        for (let i = 0; i < flat.length; i += 1) buf.writeFloatLE(flat[i], i * 4)
        const tmp = p.vectors + '.tmp-' + process.pid
        writeFileSync(tmp, buf)
        renameSync(tmp, p.vectors)
      } catch { /* 内存里已经可用 */ }
      writeJsonAtomic(p.state, {
        ...readJson(p.state, {}),
        vectors: {
          cardsHash: hash,
          count: source.length,
          dim,
          model: 'bge-small-zh-v1.5@512',
          builtAt: new Date().toISOString(),
          buildMs: Date.now() - started,
        },
      })
      record.data = flat
      record.ids = source.map((card) => card.id)
      record.dim = dim
      return record
    } catch (error) {
      console.warn('[qq-ext-memory] 向量层不可用，退回纯词法：' + String(error?.message ?? error))
      return null
    } finally {
      record.pending = null
    }
  })()
  return record.pending
}

async function queryVector(root, s, text) {
  const vectors = await embedMany(root, [text], true, s)
  return vectors[0] ?? null
}

/* -------------------------------------------------------------- 词法与融合 */

function squash(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
}

function bigrams(text) {
  const flat = squash(text)
  const set = new Set()
  if (flat.length === 1) set.add(flat)
  for (let i = 0; i + 1 < flat.length; i += 1) set.add(flat.slice(i, i + 2))
  return set
}

function lexicalScore(query, grams, card, now) {
  if (grams.size === 0) return 0
  const textGrams = bigrams(card.text)
  let hit = 0
  for (const gram of grams) if (textGrams.has(gram)) hit += 1
  const coverage = hit / grams.size
  const exact = card.text.toLowerCase().includes(query.toLowerCase()) ? 1 : 0
  const nameHit = card.name !== '' && query.includes(card.name) ? 1 : 0
  const relevance = 0.5 * coverage + 0.2 * exact + 0.15 * nameHit
  if (relevance <= 0) return 0
  const ageDays = Math.max(0, (now - card.ts) / 86400000)
  const decay = Math.pow(0.5, ageDays / 30)
  return relevance * (0.7 + 0.3 * decay)
}

function cosine(a, data, offset, dim) {
  let dot = 0
  for (let i = 0; i < dim; i += 1) dot += a[i] * data[offset + i]
  return dot
}

function fmtTime(ts) {
  const date = new Date(ts || 0)
  const pad = (value) => String(value).padStart(2, '0')
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function scopeOf(key) {
  const group = /^g:(\d+)/.exec(String(key ?? ''))
  if (group) return { kind: 'group', prefix: 'g:' + group[1], gid: group[1] }
  const priv = /^u:(\d+)/.exec(String(key ?? ''))
  if (priv) return { kind: 'private', prefix: 'u:' + priv[1], uid: priv[1] }
  return { kind: 'none', prefix: '' }
}

function labelOf(key) {
  const scope = scopeOf(key)
  if (scope.kind === 'group') return '群 ' + scope.gid
  if (scope.kind === 'private') return '私聊'
  return String(key || '未知')
}

function cardLine(card, maxChars) {
  const head = '[' + card.id + '] ' + fmtTime(card.ts) + ' ' + labelOf(card.key) + ' ' + (card.name || '群友') + '：'
  const room = Math.max(24, maxChars - head.length)
  const body = card.text.length > room ? card.text.slice(0, room - 1) + '…' : card.text
  return head + body
}

/* ------------------------------------------------------------------ 工具 */

function makeSearchTool(context) {
  return defineTool({
    name: 'qq_memory_search',
    description:
      '在自己的长期记忆卡片里翻旧账：按意思（语义）或关键词找出本会话过去记下的要点，返回带 id 的摘要行。' +
      '对方说「上次那个」「之前提过」「你还记得吗」而你不确定时用它，比凭印象猜准；要读全文再用 qq_memory_read。' +
      '只查本会话：群里查本群，私聊查私聊，不会翻到别的群。',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: '要回忆的内容，一句话或几个关键词都行（例如「说好的周末去哪」「那个显卡型号」）。',
      },
      scope: {
        type: 'string',
        enum: ['chat', 'group', 'all'],
        description: 'chat=本会话（默认）；group=本群全部；all=全部（群里会被钳到本群，私聊只有私聊卡片）。',
      },
      days: {
        type: 'number',
        minimum: 0,
        maximum: 3650,
        description: '只看最近多少天内的卡片；不填=不限。',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 8,
        description: '最多返回几条，默认 5，上限 8。',
      },
    },
    execute: async (args) => {
      try {
        const root = resolveRoot(context)
        const s = settings(root)
        const rawQuery = String(args?.query ?? '').trim().slice(0, s.maxQueryChars)
        if (rawQuery === '') return { ok: false, detail: 'query 是空的：把要回忆的关键词或一句话填进来。' }
        const scope = scopeOf(context?.key)
        if (scope.kind === 'none') return { ok: false, detail: '这条会话拿不到会话键，记忆卡片按会话隔离，这次查不了。' }
        const wanted = String(args?.scope ?? 'chat').trim().toLowerCase()
        const effective = scope.kind === 'group' ? 'group' : 'private'
        const days = Number(args?.days)
        const cutoff = Number.isFinite(days) && days > 0 ? Date.now() - days * 86400000 : 0
        const limit = Math.max(1, Math.min(s.searchMaxHits, Number(args?.limit) || 5))
        const allCards = loadCards(root, s)
        const cards = allCards.filter((card) => {
          if (card.key !== scope.prefix) return false
          if (cutoff > 0 && card.ts < cutoff) return false
          return true
        })
        if (cards.length === 0) {
          const total = allCards.length
          return {
            ok: true,
            detail:
              '本会话还没有记忆卡片（全库 ' + total + ' 条，都记在别的会话里）。' +
              '这轮就别硬猜了：要么直接问对方，要么等这轮结束后把要点记下来。',
          }
        }
        const now = Date.now()
        const grams = bigrams(rawQuery)
        const ranked = cards
          .map((card) => ({ card, score: lexicalScore(rawQuery, grams, card, now) }))
          .filter((row) => row.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, s.candidatePool)

        const rrf = new Map()
        const bump = (id, position) => {
          rrf.set(id, (rrf.get(id) ?? 0) + 1 / (60 + position))
        }
        ranked.forEach((row, index) => bump(row.card.id, index))
        let semanticUsed = false
        const record = await withTimeout(ensureVectors(root, s, allCards), s.vectorTimeoutMs)
        if (record && record.data && record.ids.length > 0) {
          const qv = await withTimeout(queryVector(root, s, rawQuery), s.vectorTimeoutMs)
          if (qv) {
            const position = new Map(record.ids.map((id, index) => [id, index]))
            const sims = cards
              .filter((card) => position.has(card.id))
              .map((card) => ({ card, score: cosine(qv, record.data, position.get(card.id) * record.dim, record.dim) }))
            sims.sort((a, b) => b.score - a.score)
            const kept = sims.filter((row) => row.score >= s.semanticFloor).slice(0, s.candidatePool)
            kept.forEach((row, index) => bump(row.card.id, index))
            semanticUsed = kept.length > 0
          }
        }

        const byCardId = new Map(cards.map((card) => [card.id, card]))
        const picked = [...rrf.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([id]) => byCardId.get(id))
          .filter(Boolean)

        if (picked.length === 0) {
          return {
            ok: true,
            detail:
              '「' + rawQuery + '」在' + (effective === 'group' ? '本群的 ' : '私聊的 ') + cards.length +
              ' 条卡片里没有对上。换个说法或放宽 days 再试；也可以直接问对方。',
          }
        }
        const lines = picked.map((card) => cardLine(card, s.cardMaxChars))
        const head =
          '找到 ' + picked.length + ' 条（' + (semanticUsed ? '语义 + 关键词' : '关键词') + '，按相关度排序）：'
        return {
          ok: true,
          detail: head + '\n' + lines.join('\n') + '\n要看全文用 qq_memory_read(id)。',
        }
      } catch (error) {
        return { ok: false, detail: '查记忆卡片出错：' + String(error?.message ?? error) }
      }
    },
  })
}

function makeReadTool(context) {
  return defineTool({
    name: 'qq_memory_read',
    description:
      '读一条记忆卡片的全文（先用 qq_memory_search 拿到 id）。卡片正文可能很长，默认只给前 2000 字；' +
      '里面如果写着「已更正 / 已过期 / 已撤回」，以修正后的说法为准。',
    required: ['id'],
    properties: {
      id: {
        type: 'string',
        description: '卡片 id，形如 note:g:123456:1730000000000（从 qq_memory_search 的结果行里取）。',
      },
      chars: {
        type: 'number',
        minimum: 200,
        maximum: 6000,
        description: '最多返回多少字，默认 2000。',
      },
    },
    execute: async (args) => {
      try {
        const root = resolveRoot(context)
        const s = settings(root)
        const id = String(args?.id ?? '').trim()
        if (id === '') return { ok: false, detail: 'id 是空的：先用 qq_memory_search 查，再把结果行里的 id 填进来。' }
        const chars = Math.max(200, Math.min(6000, Number(args?.chars) || 2000))
        const scope = scopeOf(context?.key)
        let cards = loadCards(root, s)
        let card = cards.find((item) => item.id === id)
        if (!card) {
          cards = buildCards(paths(root).history)
          cardCache.set(root, { at: Date.now(), sig: sourceSignature(paths(root).history), cards })
          card = cards.find((item) => item.id === id)
        }
        if (!card) return { ok: false, detail: '没有这条卡片：id 可能抄错了，或者这条已经不在库里。' }
        if (scope.kind !== 'none' && card.key !== scope.prefix) {
          return { ok: false, detail: '这条卡片属于别的会话（' + labelOf(card.key) + '），这次不跨会话读。' }
        }
        const body = card.text.length > chars ? card.text.slice(0, chars) + '…（还有 ' + (card.text.length - chars) + ' 字）' : card.text
        return {
          ok: true,
          detail:
            '[' + card.id + '] ' + fmtTime(card.ts) + ' ' + labelOf(card.key) + ' ' + (card.name || '群友') + '：\n' +
            body,
        }
      } catch (error) {
        return { ok: false, detail: '读卡片出错：' + String(error?.message ?? error) }
      }
    },
  })
}

export function provider(context) {
  const root = resolveRoot(context)
  const s = settings(root)
  try {
    loadCards(root, s)
  } catch { /* 首次建库失败不影响注册 */ }
  void ensureVectors(root, s, cardCache.get(root)?.cards ?? null).catch(() => null)
  // provider 契约：必须返回 { tools, sections }。返回裸数组会被 collectProviderAdditions 当成 0 工具（静默跳过）。
  return { tools: [makeSearchTool(context), makeReadTool(context)] }
}

export const __internals = {
  buildCards,
  loadCards,
  settings,
  paths,
  sourceSignature,
  bigrams,
  squash,
  lexicalScore,
  encode,
  loadVocab,
  basicTokens,
  wordpiece,
  scopeOf,
  cardLine,
  embedMany,
  ensureVectors,
  settingsCache,
  cardCache,
  vecCache,
  DEFAULTS,
}

export default { provider, variant }

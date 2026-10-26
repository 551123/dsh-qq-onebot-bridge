/**
 * qq-ext-face 的「肉」——收藏表情（QQ「我的表情」）的 5 个工具 + 1 段提示。
 *
 * 分工（和桥侧补丁 58 的分界线）：
 *   - **桥**（lib/faces.js + lib/bridge.js）负责：把收藏同步进 `<cwd>/qq-faces/favorites/`（要 socket 才能调
 *     get_fav_stickers / fetch_custom_face）、以及每条回复里自动贴 mface 段；
 *   - **本包**只读桥写好的同一批文件（favorites.json / tags.json / favorites/*.png），
 *     提供「查、挑、打标签、单独发、要求重同步」这五件事，**不做任何网络请求**。
 *
 * 三条 provider 硬约束（和 qq-ext-house-lite 同一套，回归断言在 ext/README.md 第 2 节）：
 *   1. 参数与输出必须是标准 JSON Schema —— required 只能写在 object 上、且是数组；
 *   2. provider 必须同步返回 { tools, sections }；
 *   3. 单次注入上限 8 工具 / 4 段 —— 本包 5 + 1。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

/** 热更指纹：改动这个文件时一起改，便于在 trace 里确认加载的是哪一版。 */
export const variant = 'v1-face5'

/** 与 lib/faces.js 的 FACE_TAGS 逐字一致（改一处必须改两处）。 */
const FACE_TAGS = ['开心', '烦', '气', '低落', '感动', '得意', '困', '惊', '喂', '点头', '无语']

/** 正文线索 → 标签（与 lib/faces.js 的 FACE_EMOTION_HINTS 同口径，只保留 qq_face_pick 用得到的部分）。 */
const EMOTION_HINTS = [
  ['哈哈哈', '开心'], ['哈哈', '开心'], ['笑死', '开心'], ['开心', '开心'], ['好耶', '开心'], ['爽', '开心'],
  ['烦', '烦'], ['无语', '无语'],
  ['生气', '气'], ['气死', '气'], ['讨厌', '气'], ['哼', '气'],
  ['困', '困'], ['累', '困'], ['睡', '困'],
  ['难过', '低落'], ['低落', '低落'], ['想哭', '低落'], ['唉', '低落'], ['失望', '低落'],
  ['谢谢', '感动'], ['感动', '感动'], ['暖', '感动'], ['抱抱', '感动'],
  ['厉害', '得意'], ['真是的', '得意'], ['那当然', '得意'], ['必须', '得意'],
  ['震惊', '惊'], ['惊', '惊'], ['啊这', '惊'], ['什么鬼', '惊'],
  ['在吗', '喂'], ['喂', '喂'], ['在不在', '喂'],
  ['好吧', '点头'], ['好的', '点头'], ['嗯嗯', '点头'], ['行吧', '点头'],
]

const OUTPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['ok', 'detail'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the call succeeded.' },
    detail: { type: 'string', description: 'Human-readable result for the user.' },
    count: { type: 'number', description: 'How many stickers matched / exist.' },
  },
}

function readJson(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  } catch { /* 坏文件当空，绝不抛 */ }
  return fallback
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

const asTags = (value) => (Array.isArray(value) ? value.filter((tag) => typeof tag === 'string' && tag !== '') : [])

/** `<cwd>/qq-faces`：优先用桥给的 cwd（config.cwd），再退回出口的 workspaceRoot，最后 cwd。 */
export function faceDirOf(config = {}, workspaceRoot = '') {
  const base = String(config?.cwd || workspaceRoot || process.cwd())
  return resolve(base, 'qq-faces')
}

/** 读桥写好的三份东西（favorites.json / tags.json / favorites 目录 + 手工丢进来的图片）。 */
export function loadLibrary(dir) {
  const favorites = readJson(join(dir, 'favorites.json'), [])
  const tags = readJson(join(dir, 'tags.json'), {})
  const list = []
  if (Array.isArray(favorites)) {
    for (const item of favorites) {
      if (!item || typeof item.file !== 'string' || item.file === '') continue
      if (!existsSync(item.file)) continue
      const id = String(item.id ?? '')
      if (id === '') continue
      list.push({
        id,
        name: String(item.summary || item.name || id),
        file: item.file,
        tags: asTags(tags[id]),
        source: 'favorite',
        url: String(item.url ?? ''),
      })
    }
  }
  // 手工丢进 <cwd>/qq-faces 的图片（桥的 reconcile() 也会把它们登记进 faces.json）
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue
      if (!/\.(png|jpe?g|gif|webp)$/i.test(ent.name)) continue
      const id = ent.name.replace(/\.[^.]+$/, '')
      if (list.some((item) => item.id === id)) continue
      list.push({
        id,
        name: id,
        file: join(dir, ent.name),
        tags: asTags(tags[id]),
        source: 'saved',
        url: '',
      })
    }
  } catch { /* 目录不存在 = 空库 */ }
  return { list, tags, favorites }
}

/** 正文 → 标签（与桥同表；最多两个）。 */
export function tagsFromText(text) {
  const value = String(text ?? '')
  const out = []
  for (const [hint, tag] of EMOTION_HINTS) {
    if (value.includes(hint) && !out.includes(tag)) {
      out.push(tag)
      if (out.length >= 2) break
    }
  }
  return out
}

/** 按标签 / 正文挑一张：命中标签优先；`fallback` 为 true 时才退回未打标签的那批。 */
export function pickSticker(list, { tag = '', text = '', fallback = false } = {}, random = Math.random) {
  if (!Array.isArray(list) || list.length === 0) return null
  const wanted = tag !== ''
    ? String(tag).split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean)
    : tagsFromText(text)
  if (wanted.length > 0) {
    const matched = list.filter((item) => item.tags.some((t) => wanted.includes(t)))
    if (matched.length > 0) return { item: matched[Math.floor(random() * matched.length)], matched: true, tags: wanted }
    if (!fallback) return { item: null, matched: false, tags: wanted }
  }
  if (!fallback) return { item: null, matched: false, tags: wanted }
  const untagged = list.filter((item) => item.tags.length === 0)
  const pool = untagged.length > 0 ? untagged : list
  return { item: pool[Math.floor(random() * pool.length)], matched: false, tags: wanted }
}

const lineOf = (item) => `· ${item.name}｜标签: ${item.tags.length > 0 ? item.tags.join(',') : '（无）'}｜id: ${item.id}`

function makeTools(config, workspaceRoot, key, extApi) {
  const dir = faceDirOf(config, workspaceRoot)
  const tagsFile = join(dir, 'tags.json')

  return [
    {
      name: 'qq_face_pick',
      description: '按标签或一句话里的情绪挑一张收藏表情，返回它是什么（不发送）。挑不到就如实说没命中，不要瞎猜。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: [],
        properties: {
          tag: { type: 'string', description: `直接指定标签（${FACE_TAGS.join('、')}）` },
          text: { type: 'string', description: '给一句话，按里面的情绪线索挑（tag 优先）' },
          fallback: { type: 'boolean', description: '没命中标签时是否退回随便一张（默认 false：宁可不贴）' },
        },
      },
      output: OUTPUT,
      async execute(args = {}) {
        const { list } = loadLibrary(dir)
        if (list.length === 0) return { ok: false, count: 0, detail: '表情库是空的，先 qq_face_refresh 或等桥同步。' }
        const picked = pickSticker(list, {
          tag: String(args.tag ?? '').trim(),
          text: String(args.text ?? ''),
          fallback: args.fallback === true,
        })
        if (!picked?.item) {
          const why = picked?.tags?.length > 0 ? `没有表情打了「${picked.tags.join('/')}」标签` : '没给标签也没看出情绪线索'
          return { ok: false, count: 0, detail: `${why}。现有标签：${[...new Set(list.flatMap((i) => i.tags))].join('、') || '（还没有任何标签）'}。` }
        }
        const item = picked.item
        return {
          ok: true,
          count: 1,
          detail: `挑中：${item.name}｜标签: ${item.tags.join(',') || '（无）'}｜id: ${item.id}${picked.matched ? '' : '（未命中标签，按 fallback 随机挑的）'}`,
        }
      },
    },
    {
      name: 'qq_face_tag',
      description: `给一张收藏表情打标签（覆盖式）。标签只认这几个词：${FACE_TAGS.join('、')}。传空数组 = 清空标签。`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'tags'],
        properties: {
          id: { type: 'string', description: '表情 id（qq_face_list 里的 id 字段）' },
          tags: { type: 'array', items: { type: 'string' }, description: `标签数组，最多 8 个，只认：${FACE_TAGS.join('、')}` },
        },
      },
      output: OUTPUT,
      async execute(args = {}) {
        const id = String(args.id ?? '').trim()
        if (id === '') return { ok: false, detail: '缺 id。' }
        const { list } = loadLibrary(dir)
        if (!list.some((item) => item.id === id)) {
          return { ok: false, detail: `库里没有 id=${id} 的表情，先 qq_face_list 看一眼。` }
        }
        const known = new Set(FACE_TAGS)
        const wanted = (Array.isArray(args.tags) ? args.tags : [])
          .map((tag) => String(tag).trim())
          .filter((tag) => tag !== '')
        const unknown = wanted.filter((tag) => !known.has(tag))
        const finalTags = wanted.filter((tag) => known.has(tag)).slice(0, 8)
        const table = readJson(tagsFile, {})
        const next = (table && typeof table === 'object' && !Array.isArray(table)) ? { ...table } : {}
        if (finalTags.length === 0) delete next[id]
        else next[id] = finalTags
        writeJson(tagsFile, next)
        const note = unknown.length > 0 ? `（忽略无效标签：${unknown.join('、')}）` : ''
        return {
          ok: true,
          count: finalTags.length,
          detail: finalTags.length === 0 ? `已清空 ${id} 的标签${note}` : `已给 ${id} 打上：${finalTags.join('、')}${note}`,
        }
      },
    },
    {
      name: 'qq_face_refresh',
      description: '要求同步一次 QQ「我的表情」（桥会在下一次回复前做，需要活着的 QQ 连接）。同时重扫本地目录。',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
      output: OUTPUT,
      async execute() {
        try {
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, '.resync'), String(Date.now()), 'utf8')
        } catch (error) {
          return { ok: false, detail: `写同步标记失败：${error.message}` }
        }
        const { list } = loadLibrary(dir)
        return { ok: true, count: list.length, detail: `已请求同步（标记已写）。当前库里 ${list.length} 张；桥在下一次回复时会拉取收藏并下载新图。` }
      },
    },
  ]
}

/** 常驻提示段：告诉她有这个库、怎么贴、别乱贴。建会话时算一次（静态）。 */
export function faceSection(config = {}, workspaceRoot = '') {
  const dir = faceDirOf(config, workspaceRoot)
  const { list } = loadLibrary(dir)
  const usedTags = [...new Set(list.flatMap((item) => item.tags))]
  const text = [
    `【表情包】你有一批收藏表情（同步自 QQ「我的表情」），当前 ${list.length} 张。可用标签：${FACE_TAGS.join('/')}；已打标签：${usedTags.length > 0 ? usedTags.join('/') : '（还没有）'}。`,
    '· 想在回复里顺手贴一张：正文写 [mface:标签]（例「好耶[mface:开心]」）。它只挑**打过该标签**的表情，没命中就不贴、也不会把标记原文发出去。',
    '· 想单独发一条表情：桥本体有 qq_face_list 看全部（含标签），qq_face_send 传名字/标签即可（收藏表情按 mface 段发，客户端显示成表情）；qq_face_pick 只是「先挑一张看看是哪张」。',
    '· 标签不够用 qq_face_tag 补（id + tags）；同步新收藏用 qq_face_refresh。',
    '· 别每句都贴：只在确实有情绪、或对方要你发表情时才用；拿不准就不贴。',
  ].join('\n')
  return { name: 'qq-face-sticker', order: 123, text }
}

/**
 * provider 入口（**必须同步返回**）。
 *
 * `context` 是桥给的 `{ agentCtx, route, key, config }`，外壳会额外塞一个 `extApi`（出口实例；
 * 本包目前只用 workspaceRoot 定位 qq-faces，发消息一律走桥本体）。任何异常都在这里兜住，
 * 只让本包失效、不拖垮整条消息。
 */
export function provider(context = {}) {
  try {
    const config = context?.config ?? {}
    if (config.faceToolsEnabled === false) return { tools: [], sections: [] }
    const workspaceRoot = String(context?.workspaceRoot || context?.extApi?.workspaceRoot || '')
    const key = String(context?.key ?? '')
    const extApi = context?.extApi ?? null
    const dir = faceDirOf(config, workspaceRoot)
    const tools = makeTools(config, workspaceRoot, key, extApi)
    const sections = config.facePromptSection === false ? [] : [faceSection(config, workspaceRoot)]
    return { tools, sections }
  } catch (error) {
    // 同 index.js：返回 reason 上游不读，抛出去才会进 trace。
    throw new Error('qq-ext-face(body): ' + String(error?.message ?? error))
  }
}

export default { provider, variant }

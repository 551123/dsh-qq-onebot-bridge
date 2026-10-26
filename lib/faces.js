/**
 * Face library: common yellow-face (CQ:face) id map plus a local library
 * of saved image stickers (favorite faces) under <cwd>/qq-faces.
 *
 * 【本地补丁 58 · 表情包】在原库之上加三样东西，全部落在 <cwd>/qq-faces 里，
 * 插件侧 qq-ext-face 读**同一份文件**，不重复实现同步：
 *   ① `favorites.json` + `favorites/`：从 QQ「我的表情」同步下来的收藏表情（可发 mface 段）；
 *   ② `tags.json`：给每张收藏打的标签，供 pickByTag() 按情绪挑；
 *   ③ `[mface:标签]` 文本标记 + stickerSegment()：模型可以显式点名贴哪一个。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'

/** Common OneBot yellow-face ids (subset of the QQ official emoji table). */
export const FACE_IDS = {
  惊讶: 0, 撇嘴: 1, 色: 2, 发呆: 3, 得意: 4, 流泪: 5, 害羞: 6, 闭嘴: 7, 睡: 8, 大哭: 9,
  尴尬: 10, 发怒: 11, 调皮: 12, 呲牙: 13, 微笑: 14, 难过: 15, 酷: 16, 抓狂: 97, 吐: 18,
  偷笑: 19, 可爱: 21, 白眼: 22, 傲慢: 23, 饥饿: 24, 困: 25, 惊恐: 26, 流汗: 27, 憨笑: 28,
  疑问: 32, 嘘: 33, 晕: 34, 折磨: 35, 衰: 36, 骷髅: 37, 敲打: 38, 再见: 39, 擦汗: 40,
  抠鼻: 41, 鼓掌: 42, 坏笑: 44, 鄙视: 48, 委屈: 49, 快哭了: 50, 阴险: 51, 亲亲: 52,
  可怜: 54, 爱心: 66, 心碎: 67, 蛋糕: 68, 炸弹: 70, 月亮: 75, 太阳: 76, 礼物: 77,
  拥抱: 78, 强: 79, 弱: 80, 握手: 81, 胜利: 82, 抱拳: 83, 拳头: 85, 爱你: 87,
  爱情: 90, 飞吻: 91, 跳跳: 92, 发抖: 93, 怄火: 94, 转圈: 95, 冷汗: 96,
}

/** 收藏表情的标签词表（打标签、按标签挑都只认这里的词，避免自由文本把标签打散）。 */
export const FACE_TAGS = ['开心', '烦', '气', '低落', '感动', '得意', '困', '惊', '喂', '点头', '无语']

/**
 * 正文里的情绪线索 → 标签（**按顺序**匹配，先命中先算；词长都 ≥2，避免「好」这种单字随处误命中）。
 * 桥在 #faceSegmentFor() 里用它把「她刚说的话」翻译成标签，再交给 pickByTag()。
 */
export const FACE_EMOTION_HINTS = [
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

class FaceLibrary {
  constructor(directory) {
    this.directory = directory
    this.indexPath = join(directory, 'faces.json')
    this.favoritesPath = join(directory, 'favorites.json')
    this.tagsPath = join(directory, 'tags.json')
    this.favoritesDir = join(directory, 'favorites')
    this.items = []
    /** 收藏表情：[{ id, url, file, summary, key, emojiId, emojiPackageId }] */
    this.favorites = []
    /** 标签表：{ [id]: string[] } */
    this.tags = {}
    this.load()
  }

  load() {
    try {
      if (existsSync(this.indexPath)) {
        const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'))
        if (Array.isArray(parsed)) this.items = parsed
      }
    } catch {
      this.items = []
    }
    this.loadFavorites()
    this.reconcile()
  }

  loadFavorites() {
    this.favorites = []
    try {
      if (existsSync(this.favoritesPath)) {
        const parsed = JSON.parse(readFileSync(this.favoritesPath, 'utf8'))
        if (Array.isArray(parsed)) this.favorites = parsed.filter((item) => item && typeof item === 'object')
      }
    } catch {
      this.favorites = []
    }
    this.loadTags()
  }

  loadTags() {
    this.tags = {}
    try {
      if (existsSync(this.tagsPath)) {
        const parsed = JSON.parse(readFileSync(this.tagsPath, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.tags = parsed
      }
    } catch {
      this.tags = {}
    }
  }

  saveTags() {
    try {
      mkdirSync(this.directory, { recursive: true })
      writeFileSync(this.tagsPath, JSON.stringify(this.tags, null, 2), 'utf8')
    } catch (error) {
      console.error(`[qq-bridge] face tags save failed: ${error.message}`)
    }
  }

  saveFavorites() {
    try {
      mkdirSync(this.directory, { recursive: true })
      writeFileSync(this.favoritesPath, JSON.stringify(this.favorites, null, 2), 'utf8')
    } catch (error) {
      console.error(`[qq-bridge] favorites save failed: ${error.message}`)
    }
  }

  /** 某张收藏/图片的标签（数组，永远不是 undefined）。 */
  tagsOf(item) {
    const id = typeof item === 'string' ? item : item?.id
    const list = id ? this.tags?.[String(id)] : null
    return Array.isArray(list) ? list : []
  }

  /** 覆盖式打标签（空数组 = 清空）；返回写入后的标签。 */
  setTags(id, tags) {
    const key = String(id ?? '').trim()
    if (key === '') return []
    const list = (Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，\s]+/))
      .map((tag) => String(tag).trim())
      .filter((tag) => tag !== '')
      .slice(0, 8)
    if (list.length === 0) delete this.tags[key]
    else this.tags[key] = list
    this.saveTags()
    return this.tags[key] ?? []
  }

  /**
   * Reconcile the index with the directory: drop entries whose file is gone
   * and register image files dropped into the directory manually.
   */
  reconcile() {
    try {
      if (!existsSync(this.directory)) return
      this.items = this.items.filter((item) => typeof item?.file === 'string' && existsSync(item.file))
      const known = new Set(this.items.map((item) => basename(item.file)))
      for (const file of readdirSync(this.directory)) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(file)) continue
        if (known.has(file)) continue
        const name = file.replace(/\.[^.]+$/, '')
        this.items.push({
          id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
          name,
          file: join(this.directory, file),
        })
      }
      this.save()
    } catch {
      // Directory scan is best-effort; the in-memory list stays usable.
    }
  }

  save() {
    try {
      mkdirSync(this.directory, { recursive: true })
      writeFileSync(this.indexPath, JSON.stringify(this.items, null, 2), 'utf8')
    } catch (error) {
      console.error(`[qq-bridge] face index save failed: ${error.message}`)
    }
  }

  list() {
    const yellow = Object.entries(FACE_IDS).map(([name, id]) => ({ kind: 'face', id: String(id), name }))
    // 【P58】saved 与 stickerList() 同源：既含「QQ 收藏同步下来的」，也含手工丢进 qq-faces 的图片，
    // 否则内置 qq_face_list 看不到收藏，模型只能靠猜标签去写 [mface:…]。
    const saved = this.stickerList().map((item) => ({
      kind: 'image',
      id: item.id,
      name: item.name,
      file: item.file,
      tags: item.tags,
      source: item.source,
    }))
    return { yellow, saved }
  }

  /** Add a downloaded sticker file into the library. */
  addImage(name, filePath) {
    const id = `f${Date.now().toString(36)}`
    this.items.push({ id, name, file: filePath })
    this.save()
    return { id, name, file: filePath }
  }

  /** Resolve a user-provided name or id to CQ segments (one face or one image). */
  resolve(nameOrId) {
    const key = String(nameOrId).trim()
    if (key === '') return null
    const yellow = Object.entries(FACE_IDS).find(([name, id]) => name === key || String(id) === key)
    if (yellow) return { segments: [{ type: 'face', data: { id: String(yellow[1]) } }], label: `黄脸[${yellow[0]}]` }
    const saved = this.items.find((item) => item.name === key || item.id === key)
    if (saved && existsSync(saved.file)) {
      return { segments: [{ type: 'image', data: { file: saved.file } }], label: `收藏图[${saved.name}]` }
    }
    // 【P58】QQ 收藏表情：按 summary/名字或标签精确命中时发 mface 段（客户端显示成表情，不是图片气泡）。
    // 只在前面都没命中时才查，避免抢掉手工图片的优先级。
    const favorite = this.stickerList().find(
      (item) => item.source === 'favorite' && (item.name === key || item.tags.includes(key)),
    )
    if (favorite) {
      const segment = this.stickerSegment(favorite)
      if (segment) {
        const kind = segment.type === 'mface' ? '表情' : '表情图'
        return { segments: [segment], label: `收藏${kind}[${favorite.name}]` }
      }
    }
    return null
  }

  /**
   * 可发的表情清单：同步下来的收藏（有落盘文件才收）+ 手工丢进 qq-faces 的图片。
   * 插件侧 qq_face_list / qq_face_pick 与桥的 pickByTag() 都以它为唯一真源。
   */
  stickerList() {
    const favorites = this.favorites
      .filter((item) => typeof item?.file === 'string' && item.file !== '' && existsSync(item.file))
      .map((item) => ({
        id: String(item.id),
        name: String(item.summary || item.name || item.id),
        file: item.file,
        tags: this.tagsOf(item),
        source: 'favorite',
        raw: item.raw ?? item,
      }))
    const saved = this.items
      .filter((item) => typeof item?.file === 'string' && existsSync(item.file))
      .map((item) => ({
        id: String(item.id),
        name: String(item.name || item.id),
        file: item.file,
        tags: this.tagsOf(item),
        source: 'saved',
        raw: item.raw ?? item,
      }))
    return [...favorites, ...saved]
  }

  /**
   * 按标签挑一张。`tags` 可以是数组或「逗号/空格分隔」的字符串；
   * 一个都没命中时退回**未打标签**的那批（随机），都打满标签就让全部参与随机。
   */
  pickByTag(tags = [], random = Math.random, { strict = false } = {}) {
    const list = this.stickerList()
    if (list.length === 0) return null
    const wanted = (Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，\s]+/))
      .map((tag) => String(tag).trim())
      .filter((tag) => tag !== '')
    if (wanted.length > 0) {
      const matched = list.filter((item) => item.tags.some((tag) => wanted.includes(tag)))
      if (matched.length > 0) return matched[Math.floor(random() * matched.length)]
      // strict：点名的标签一个都没打上就不贴（宁可不贴，也别在难过的时候甩个笑脸）。
      if (strict) return null
    }
    const untagged = list.filter((item) => item.tags.length === 0)
    const pool = untagged.length > 0 ? untagged : list
    return pool[Math.floor(random() * pool.length)]
  }

  /**
   * 合法 mface 段（客户端显示成 QQ 表情气泡，而不是图片气泡）。
   *
   * 四件套是 QQ 内核的硬要求：`emoji_id` + `emoji_package_id` + `key` + `summary`。
   * 缺 key 或 emoji_id 时内核直接 -13100（`EventChecker Failed … sendMsg`），整条消息被拒 ——
   * 所以这里宁可返回 null（让调用方退化），也不构造半残段。
   */
  mfaceSegment(item) {
    if (!item) return null
    const raw = item.raw ?? {}
    const key = String(raw.key ?? '')
    const emojiId = String(raw.emojiId ?? raw.emoji_id ?? '')
    if (key === '' || emojiId === '') return null
    const packageId = Number(raw.emojiPackageId ?? raw.emoji_package_id ?? raw.packageId ?? 0)
    return {
      type: 'mface',
      data: {
        emoji_id: emojiId,
        emoji_package_id: Number.isFinite(packageId) ? packageId : 0,
        key,
        summary: String(raw.summary || item.name || '[表情]'),
      },
    }
  }

  /** 本地图片段（mface 凑不齐时的兜底：图片气泡也比"什么都不贴"强）。 */
  imageSegment(item) {
    if (!item || typeof item.file !== 'string' || item.file === '' || !existsSync(item.file)) return null
    return { type: 'image', data: { file: item.file } }
  }

  /**
   * 一张收藏表情的发送段：**能构造合法 mface 就用真表情，否则退图片**。
   *
   * 现实约束：`fetch_custom_face` 只回图片直链、不回 key，所以从收藏夹同步来的表情
   * 天生凑不齐四件套 ⇒ 走 image；等哪天某条数据带上了 key（例如从真实表情消息里缓存的），
   * 同一条代码会自动升级成真表情气泡。
   */
  stickerSegment(item) {
    return this.mfaceSegment(item) ?? this.imageSegment(item)
  }

  /** Expand [face:xxx] / [img:xxx] / [mface:标签] markers inside reply text into CQ segments. */
  expandMarkers(text) {
    const marker = /\[(face|img|mface):([^\]]+)\]/g
    const segments = []
    let last = 0
    let match
    while ((match = marker.exec(text)) !== null) {
      if (match.index > last) segments.push({ type: 'text', data: { text: text.slice(last, match.index) } })
      last = match.index + match[0].length
      if (match[1] === 'mface') {
        /**
         * `[mface:标签]` 是模型**点名**要贴的，所以走 strict：
         * 点了名的标签一张都没打上 ⇒ **静默丢弃这个标记**（不随机顶替、也不把 `[mface:…]` 原文漏进群）。
         */
        const picked = this.pickByTag(match[2], Math.random, { strict: true })
        if (picked) {
          const segment = this.stickerSegment(picked)
          if (segment) segments.push(segment)
        }
        continue
      }
      const resolved = this.resolve(match[2])
      if (resolved) segments.push(...resolved.segments)
      else segments.push({ type: 'text', data: { text: match[0] } })
    }
    if (last < text.length) segments.push({ type: 'text', data: { text: text.slice(last) } })
    return segments.length > 0 ? segments : [{ type: 'text', data: { text } }]
  }

  /**
   * 把 QQ「我的表情」同步进 favorites/。
   *
   * `call(action, params)` 是 OneBot 动作调用器（桥传 `server.#call` 绑好的 socket 版本），
   * 所以本方法不碰网络细节，纯逻辑可单测。
   *
   * 流程：翻页 `fetch_custom_face` 拿 URL 列表 → 按 URL 生成稳定 id（fav-<sha1 前 16>）→
   * 缺文件的下载到 favorites/ → 落 favorites.json。**不动已有标签**（tags.json 以 id 为键）。
   */
  async syncFavorites(call, { pageSize = 100, maxDownload = 80, log = () => {} } = {}) {
    const result = { listed: 0, discovered: 0, downloaded: 0, failed: 0 }
    if (typeof call !== 'function') return result
    const byId = new Map(this.favorites.map((item) => [String(item.id), item]))
    let freshTotal = 0
    /**
     * `fetch_custom_face` 只吃 `count`，**没有 offset/start**（一次请求就是整批），
     * 所以只发一次。原先按 pages 循环会把同一页反复要一遍，靠 `fresh === 0` 提前退出，
     * 白跑两轮请求还容易让人以为"分页拉全了"。
     */
    let data
    try {
      data = await call('fetch_custom_face', { count: Math.max(1, pageSize) })
    } catch (error) {
      log(`fetch_custom_face 失败：${error.message}`)
    }
    const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : [])
    for (const raw of list) {
      const url = typeof raw === 'string' ? raw : String(raw?.url ?? '')
      if (url === '') continue
      const id = favoriteId(url)
      if (byId.has(id)) continue
      /**
       * 原始项整条留一份 `raw`：mface 四件套里的 key / emoji_id / emoji_package_id
       * 只可能出现在这里。当前 NapCat 的 fetch_custom_face 只回 url（所以收藏表情
       * 发不成真表情气泡），但别的版本/别的动作若回全了，这里自动就吃到了。
       */
      const summary = typeof raw === 'object' && raw !== null && raw.summary ? String(raw.summary) : `表情-${id.slice(4, 10)}`
      byId.set(id, {
        id,
        url,
        file: '',
        summary,
        raw: typeof raw === 'object' && raw !== null ? raw : { url },
      })
      freshTotal += 1
    }
    result.discovered = freshTotal
    let attempted = 0
    for (const item of [...byId.values()]) {
      if (attempted >= maxDownload) break
      if (typeof item.url !== 'string' || item.url === '') continue
      if (typeof item.file === 'string' && item.file !== '' && existsSync(item.file)) continue
      attempted += 1
      try {
        item.file = await this.#downloadFavorite(item)
        result.downloaded += 1
      } catch (error) {
        result.failed += 1
        log(`下载失败 ${item.id}：${error.message}`)
      }
    }
    this.favorites = [...byId.values()]
    this.saveFavorites()
    result.listed = this.favorites.length
    return result
  }

  /** 下载单张收藏到 favorites/fav-<id>.png（扩展名按 URL 猜）。 */
  async #downloadFavorite(item) {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`sticker download HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) throw new Error('sticker download empty or too large')
    mkdirSync(this.favoritesDir, { recursive: true })
    const stem = String(item.id).replace(/^fav-/, '').slice(0, 16)
    const filePath = join(this.favoritesDir, `fav-${stem}${guessExt(item.url)}`)
    writeFileSync(filePath, buffer)
    return filePath
  }

  /** Download a remote sticker image into the library and register it. */
  async addRemoteImage(url, name) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`sticker download HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) throw new Error('sticker download empty or too large')
    const ext = guessExt(url)
    mkdirSync(this.directory, { recursive: true })
    const fileName = `img-${Date.now().toString(36)}${ext}`
    const filePath = join(this.directory, fileName)
    writeFileSync(filePath, buffer)
    return this.addImage(name, filePath)
  }
}

/** 收藏表情的稳定 id：`fav-` + URL 的 sha1 前 16 位（同一张图永远同一个 id，标签不会错位）。 */
export function favoriteId(url) {
  return `fav-${createHash('sha1').update(String(url)).digest('hex').slice(0, 16)}`
}

function guessExt(url) {
  const clean = String(url).split('?')[0].toLowerCase()
  if (clean.endsWith('.gif')) return '.gif'
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return '.jpg'
  if (clean.endsWith('.webp')) return '.webp'
  return '.png'
}

export { FaceLibrary }
export default FaceLibrary

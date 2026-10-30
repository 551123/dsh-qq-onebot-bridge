/**
 * 【本地补丁 58b · 素材表情库】把 dsh-nekowhale-stickers 的本地素材接进出站表情。
 *
 * 素材库和收藏库（FaceLibrary）的差别：
 *   - 收藏库 = QQ「我的表情」镜像，~50 张，`fetch_custom_face` 只给 URL、没有 key，所以也走 image 段；
 *   - 素材库 = 322 张本地 GIF（D:/qq-work/stickers/packs/<包>/<文件>），带 emotion / tags / use / desc，
 *     情绪覆盖面远大于收藏库，而且**完全离线**。
 *
 * 关键约束：
 *   ① `[stk:…]` 标记的展开发生在 `faces.expandMarkers()`，那是**同步**函数 ⇒ 这个类必须
 *      「启动预载 + reload() 后纯查表」，构造完不能 await。
 *   ② 素材不经过 `#prepareImageForSend`（那条 4 MiB → ffmpeg 压缩只在 `#sendImageTo` 里），
 *      所以这里自己把 >4 MiB 的挑出去，避免群里发一个 5 MB 的动图。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

/** 素材段是 image（GIF 原文件直发，不会被转成 jpg）。 */
const MAX_BYTES = 4 * 1024 * 1024

/** 本体情绪 6 键 → 素材库 emotion 词（素材库一共 24 类中文情绪）。 */
export const MOOD_TO_STICKER_EMOTIONS = {
  joy: ['开心', '大笑', '喜欢', '得意'],
  cheer: ['兴奋', '搞怪', '打招呼', '赞同'],
  gratitude: ['感谢', '开心', '安慰'],
  irk: ['无语', '疑惑', '嘲讽', '思考'],
  anger: ['生气', '拒绝', '嘲讽'],
  down: ['难过', '哭', '疲惫', '害怕', '害羞'],
}

export class StickerIndex {
  constructor(dir) {
    this.dir = dir
    this.kit = null
    this.items = []
    this.byId = new Map()
    this.byStem = new Map()
    this.skipped = 0
  }

  /** 由 `index.js` 的 `ctx.inject(['stickers'])` 把 kit 送进来；没装素材库插件就永远不会被调用。 */
  attachKit(kit) {
    if (!kit || this.kit === kit) return
    this.kit = kit
    // kit.ready() 完成前 items 为空 → 下游一律「没就绪就不贴」，不会发半个空段。
    void Promise.resolve(kit.ready())
      .then(() => this.reload())
      .catch(() => {})
  }

  /** 从 kit.stickers（同步公开数组）重建索引。只挑本地确实存在、且不超过 4 MiB 的文件。 */
  reload() {
    const items = []
    let skipped = 0
    for (const s of this.kit?.stickers ?? []) {
      const file = join(this.dir, 'packs', s.pack, s.file)
      let bytes = 0
      try {
        bytes = statSync(file).size
      } catch {
        continue // 没落盘 = 离线镜像缺这张，直接不进池
      }
      if (bytes <= 0 || bytes > MAX_BYTES) {
        skipped++
        continue
      }
      items.push({ ...s, file, bytes })
    }
    this.items = items
    this.skipped = skipped
    this.byId = new Map(items.map((s) => [s.id, s]))
    this.byStem = new Map(items.map((s) => [s.stem, s]))
    return this
  }

  get ready() {
    return this.items.length > 0
  }

  stats() {
    const packs = {}
    const emotions = {}
    for (const s of this.items) {
      packs[s.pack] = (packs[s.pack] ?? 0) + 1
      emotions[s.emotion] = (emotions[s.emotion] ?? 0) + 1
    }
    return { total: this.items.length, skipped: this.skipped, packs, emotions, dir: this.dir }
  }

  /** 精确查：id / stem / 名字 / code。用于 `[stk:猫猫搓手]` 这种点名。 */
  byRef(ref) {
    const key = String(ref ?? '').trim()
    if (key === '') return null
    return this.byId.get(key) ?? this.byStem.get(key) ?? this.items.find((s) => s.name === key || s.code === key) ?? null
  }

  /**
   * 按查询词挑一张：情绪词优先（精确等于 emotion），其次名字/stem/tags/use 里包含该词。
   * 一个词都没命中时：`strict` 返回 null（点名必须打到），否则退化成全池随机。
   */
  pick(queries = [], rand = Math.random, { strict = false } = {}) {
    if (this.items.length === 0) return null
    const qs = queries.map((q) => String(q ?? '').trim()).filter(Boolean)
    let pool = this.items
    if (qs.length > 0) {
      const hits = this.items.filter((s) => {
        const hay = `${s.name} ${s.stem} ${s.tags?.join(' ') ?? ''} ${s.use ?? ''}`
        return qs.some((q) => s.emotion === q || hay.includes(q))
      })
      if (hits.length > 0) pool = hits
      else if (strict) return null
    }
    return pool[Math.floor(rand() * pool.length)] ?? null
  }

  /** 名字/情绪 → OneBot image 段；拿不到返回 null（调用方负责静默丢弃标记）。 */
  segmentFor(ref) {
    const item = this.byRef(ref) ?? (this.items.some((s) => s.emotion === String(ref ?? '').trim()) ? this.pick([String(ref).trim()], Math.random, { strict: true }) : null)
    return item ? this.segment(item) : null
  }

  segment(item) {
    if (!item?.file) return null
    return { type: 'image', data: { file: item.file } }
  }
}

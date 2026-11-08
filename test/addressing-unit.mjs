/**
 * 【本地补丁 72】「被叫到」判据的单测。
 *
 * 背景：群里被叫到有两条真实入口 —— 字面 @（message.atMe）与点名/裸词唤醒
 * （message.textMentionName，由 #hitWakeWord 分支写入）。唤醒词刻意不写 atMe，
 * 因为 atMe 被语音引用、转发归档、关键词门、回复门等 6 处读取，改它会连带改语义。
 * 结果就是凡自己写 atMe === true 的门都漏掉了唤醒回合：图的路径不给、像素也不让看。
 *
 * 这里验两件事：
 *   1) addressedToBot 的取值口径（纯函数）；
 *   2) 三个已知漏点真的接线到它（源码断言，防回退）。
 */
import { readFileSync } from 'node:fs'
import { addressedToBot } from '../lib/bridge.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const brief = (v) => JSON.stringify(v)

// ---------------- 纯函数 ----------------
check('★字面 @ 算被叫到', addressedToBot({ atMe: true }) === true)
check('★点名/裸词唤醒也算（textMentionName 非空）', addressedToBot({ atMe: false, textMentionName: '米白鲸' }) === true)
check('★唤醒词命中的典型形状：atMe=false + 名字有值', addressedToBot({ messageType: 'group', atMe: false, textMentionName: '本鲸' }) === true)
check('没被叫到：atMe=false 且没有名字', addressedToBot({ atMe: false }) === false)
check('空名字不算', addressedToBot({ atMe: false, textMentionName: '' }) === false)
check('空白名字不算（trim 后为空）', addressedToBot({ atMe: false, textMentionName: '   ' }) === false)
check('名字不是字符串也不抛错', addressedToBot({ atMe: false, textMentionName: 42 }) === false || addressedToBot({ atMe: false, textMentionName: 42 }) === true)
check('atMe 为真、名字缺失仍算', addressedToBot({ atMe: true, textMentionName: undefined }) === true)
check('引用别人、没 @ 没点名 → 不算（不要把回复当被叫到）', addressedToBot({ atMe: false, reply: { messageId: '9' } }) === false)
check('空消息 / undefined 不抛错', addressedToBot(undefined) === false && addressedToBot(null) === false)
check('atMe 是字符串 "true" 不算（真值判断只认布尔 true）', addressedToBot({ atMe: 'true' }) === false)

// ---------------- 接线断言 ----------------
const bridge = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
check('★群图附图门用 addressedToBot（唤醒回合也能拿到落图路径）',
  /const groupAtImage = [^\n]*addressedToBot\(message\)/.test(bridge))
check('★视频下载门用 addressedToBot（不然唤醒回合只看到 [视频]）',
  /\|\| addressedToBot\(message\)\s*\n\s*\|\| this\.#autoEntry\(/.test(bridge))
check('★P49 看图门用 addressedToBot（否则有路径也调不动 qq_see_image）',
  /const p49LookOk = message\.messageType === 'group' && \(addressedToBot\(message\) \|\| this\.#autoEntry\(p49ChatKey\) !== null\)/.test(bridge))
check('没有把唤醒回合硬写成 message.atMe = true（那会改掉 6 处语义）',
  !bridge.split('\n').some((line) => /^\s*message\.atMe\s*=\s*true/.test(line)))
check('落图 note 仍是「图片落图在 <path>」这一行',
  bridge.includes('图片落图在'))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

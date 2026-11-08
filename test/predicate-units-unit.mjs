/**
 * 【本地补丁 72】判据归一的单测（源码断言）。
 *
 * 背景：同一条判据被多条补丁各写一遍，改一处会被另一处覆盖，真机表现像"修复失效"。
 * 这里把两处已经归一的口径钉住：
 *   1) 群聊裸 @：`#bareAtGate(message)`（只服务"只发语音"与"纯 @ 固定短句"两条路）；
 *   2) native 多模态：`#nativeVision()`（引用图 / 图片 / 视频三处附图分支）。
 * 断言是源码级的：私有方法无法从外部调用，行为由既有域测试覆盖。
 */
import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) { passed++; console.log('PASS', name, extra) }
  else { failed++; console.log('FAIL', name, extra) }
}
const bridge = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
const count = (needle) => bridge.split(needle).length - 1

check('★#bareAtGate 有且只有一处定义', count('#bareAtGate(message) {') === 1)
check('★裸 @ 判据被两处门共用', count('this.#bareAtGate(message)') === 2)
check('★裸 @ 的原始表达式只剩 helper 内部一份',
  count("this.config.bareAtEnabled !== false && message.messageType === 'group' && message.atMe === true") === 1)
check('★#nativeVision 有且只有一处定义', count('#nativeVision() {') === 1)
check('★三处附图分支都走同一个方法', count('this.#nativeVision()') === 3)
check('★native 原始比较只剩 helper 与系统提示词文案两处',
  count("this.config.visionMode === 'native'") === 2)
check('裸 @ helper 不把唤醒词算进去（atMe 严格等于 true）',
  /#bareAtGate\(message\) \{\n\s+return this\.config\.bareAtEnabled !== false && message\.messageType === 'group' && message\.atMe === true/.test(bridge))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

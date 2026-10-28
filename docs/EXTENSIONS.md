# 扩展接缝（ctx.qqBridge）

面向"想在同一个宿主里给这个桥加东西"的插件作者。这里只写**稳定面**与**已知的坑**；
内部实现（私有方法、trace 字段、文件格式）随时会重构，不在此范围。

> 版本对应：`EXTENSION_VERSION = 1`（新增字段不升版；**删改**现有名字或形状才升版，且旧版至少保留一个小版本）。

## 1. 拿到出口

```js
// ① 有 ctx 的插件（正常情况）
const api = ctx.qqBridge

// ② 拿不到 ctx（加载顺序 / 独立进程）：包导出了入口，别再写 file:// 绝对路径
import { getExtensionApi } from 'dsh-qq-onebot-bridge/extension'
const api = getExtensionApi()   // 桥还没起来时返回 null，需要重试或等事件
```

出口对象里有：

| 字段 / 方法 | 说明 |
|---|---|
| `version` | 接缝版本，现在是 `1` |
| `instanceId` | **桥实例标识**（v0.7.5）。宿主重启 / 热重载 / 面板点开关都会重建桥 → 这个值变；同一个实例内稳定。判断"要不要重挂 provider"用它，别轮询 `toolProviders()` |
| `events` | `{ inbound: 'qqbridge:inbound', outbound: 'qqbridge:outbound' }` |
| `on(name, fn)` | 订阅只读事件，返回取消订阅函数 |
| `sendText / sendImage / sendFile / sendVoice` | 以桥的身份发送（**复用全部出站护栏**，并额外检查目标是否在白名单） |
| `recall / react` | 撤回机器人自己最近的消息 / 给某条消息贴表情 |
| `sessions / agents / config` | 只读视图（config 已脱敏） |
| `registerToolProvider(fn, { name })` | **实验性**：往每个会话注入工具与提示段（需要打开面板「实验性」组里的开关） |
| `toolProviders()` | 已登记的 provider 名字列表 |

## 2. 只读事件

```js
const off = ctx.qqBridge.on('qqbridge:inbound', (event) => {
  // event: { chatKey, messageType, userId, groupId, messageId, text, atMe, injected, at }
})
ctx.qqBridge.on('qqbridge:outbound', (event) => {
  // event: { chatKey, kind: 'text'|'image'|'file'|'voice', text, file?, bytes?, batches?, mode?, traceId?, at }
})
```

- **只读**：事件没有返回值语义，不能改写文本、不能拦截消息。要"能拦"的能力请另开插件，不走这个接缝。
- 位置在**门禁之后**：白名单/静默/去重都过了才会发出来，所以监听者看到的就是"真的会被处理的那份"。
- `injected` 为 `true` 的事件来自调试注入通道（不是真实用户消息）。

## 3. 工具 provider（实验性）

```js
ctx.qqBridge.registerToolProvider(({ agentCtx, route, key, config, workspaceRoot, extensionVersion }) => ({
  tools: [ defineTool({ /* ... */ }) ],
  sections: [ { name: 'my-note', order: 50, text: '只在这个会话的提示里出现的一段话' } ],
  // reason 可选：返回里带它会被写进 trace（空贡献时尤其有用）
}), { name: 'my-plugin' })
```

规矩（每条都是踩出来的）：

1. **必须同步**：返回 Promise 会被跳过（会话 setup 是同步链路，`await` 会拖住这条消息）；
2. **参数用标准 JSON Schema**：`required: true` 会被宿主的校验直接拒，要写成对象顶层的数组；
3. **状态放模块级**，别放 `apply()` 里 —— 热重载会复用模块实例，但会重跑 `apply()`；
4. **注册跟着桥实例走**：桥重建后旧注册失效，用 `api.instanceId` 变化来重挂；
5. 只能**新增**，不能覆盖内置工具；撞名会被跳过并记 trace；
6. 上限：每 provider **16 个工具 / 4 段提示**，全链 **40 / 12**；超了会**记一条 skipped**（不静默）；
7. 抛错只跳过你自己这个 provider，不影响其他 provider 与消息处理；`error.stack` 的**首帧**会被写进 trace
   （例：`包名→抛错：xxx @ /path/body.mjs:42:9`）。

## 4. 污点与 trace

- 本插件的污点事件带 `data.source = 'inbound-injection'`（常量 `TAINT_SOURCE_INBOUND`）。
  你自己那层污点（比如"刚读过外部网页"）请写**自己的** `source`，否则同一个会话的两条 taint 记录分不清谁打的。
- 拒绝/跳过都必须有 `reason`（本项目 v0.4 起的硬约束），别写"静默失败"的代码。

## 5. 会影响到你的配置键

| 键 | 作用 |
|---|---|
| `extensionToolsEnabled` | provider 链总开关（默认关） |
| `taintDryRunEnabled` / `taintWindowMinutes` | 污点窗口（默认关；命中后窗口内出站写动作 dry-run） |
| `taintExtraPatterns` | 自定义注入句式（正则数组，默认空） |
| `longReplySplitOnPunctuation` | 长回复分批时是否按标点断（默认开） |

## 6. 参考实现

社区里第一个真正用这套接缝的插件集（四个包 / 20 个工具，作者维护，不在本项目支持范围内）：

- <https://github.com/551123/dsh-qq-onebot-bridge/tree/patches/0.7.5/ext>

它的 `ext/README.md` 里有安装方式与作者总结的五条硬约束，可以当作"真实世界用法"来读。

# ext/ —— 四个 provider 示例包

这四个包是**扩展接缝的真实使用样本**：它们不修改桥的任何文件，只通过 `ctx.qqBridge.registerToolProvider()` 往每个会话注入工具。放在本分支里，是为了让「第三方能给桥加工具」这件事有可运行的证据，而不是一纸接口。

| 包 | 工具 | 数量 | 读的 config 键 |
| --- | --- | --- | --- |
| `qq-ext-house-lite` | `qq_house_list` `qq_house_read` `qq_house_write` `qq_house_append` `qq_house_edit` `qq_house_mkdir` `qq_house_move` `qq_house_trash` | 8 | `houseDir`、`houseToolsEnabled` |
| `qq-ext-page-note` | `qq_page_open` `qq_page_grep` `qq_page_read` `qq_note_save` `qq_note_list` `qq_note_read` | 6 | `pageToolsEnabled`、`noteToolsEnabled` |
| `qq-ext-workspace` | `qq_read_file` `qq_list_files` `qq_search_files` | 3 | `workspaceToolsEnabled`、`cwd` |
| `qq-ext-face` | `qq_face_pick` `qq_face_tag` `qq_face_refresh` | 3（+1 段提示） | `faceToolsEnabled`、`facePromptSection`、`cwd` |

合计 **20 个工具 + 1 段提示**；桥内仍是 25 个，一起构成 45 个名字。

现状与上限（`PROVIDER_LIMITS`）：v0.7.0 是单包 8 工具 / 4 段、总量 24 / 12；**v0.7.4 放宽到单包 16 工具 / 4 段、总量 40 / 12**，并且超限不再静默丢弃，改记 `skipped`（面板「实验性」组状态行可见）。小屋包那 8 个当初正好顶在旧上限上，多一个就得拆包——现在不用了。

## 目录结构

```
qq-ext-house-lite/
  index.js      稳定外壳：拿出口 → 每次 apply 重新 import body → registerToolProvider → 返回 disposer
  body.mjs      纯工具实现（不 import 宿主任何东西，可用假 ctx 单测）
  package.json  private 包，main 指向 index.js
```

外壳与实现分开，是因为 **cordis 的 live reload 只重新 apply、不重新 import 已加载模块**：外壳每次 apply 带时间戳重新 import `body.mjs`，于是「改工具 → 碰一下 `cordis.patch.yml` 触发 reload → 新工具生效」不用重启宿主；但改 `index.js` 本身仍要重启。

四个包之间**互不依赖**，也没有加载顺序要求——每次 apply 各拿各的出口、各注册各的工具。

## 安装

1. 把四个目录复制进宿主插件的同级 `node_modules/`（与 `dsh-qq-onebot-bridge` 同一个目录）。
2. 在 `cordis.patch.yml` 里 `- insert:` 四个 entry：

```yaml
- insert:
    - id: qq-ext-house-lite
      name: qq-ext-house-lite
      config:
        houseDir: 小屋目录名        # 相对工作区根；留空用包内默认值
    - id: qq-ext-page-note
      name: qq-ext-page-note
    - id: qq-ext-workspace
      name: qq-ext-workspace
      config:
        cwd: D:/qq-work            # 缺省时依次用宿主给的 workspaceRoot、进程 cwd
    - id: qq-ext-face
      name: qq-ext-face
      config:
        cwd: D:/qq-work
```

3. 把桥的 `extensionToolsEnabled` 显式设为 `true` —— 上游默认 `false`，不开这个开关 provider 一个都不会被调用。

装完在桥的 trace 里能看到类似 `provider「qq-ext-house-lite#v4-house8」注册了 8 个工具 / 0 段提示`，且 `skipped: 0`。

## provider 回调的失败要抛错，不要返回空数组

外壳里的 `catch` 曾经是这样：

```js
catch (error) {
  return { tools: [], sections: [], reason: 'qq-ext-house-lite: ' + error.message }
}
```

上游的注册函数只读 `tools` 和 `sections`，`reason` 被直接丢掉。后果是包炸了之后面板和 trace 上什么都不显示，看起来像「注册成功了但工具是零个」——比抛错难查得多。现在四个包全都是 `throw new Error('qq-ext-xxx: …')`，让桥去记。

## 五个硬约束（踩过的坑）

1. **必须走 `file://` 绝对 import + `getExtensionApi()`**。直接 `inject: ['qqBridge']` 在本机永远 pending：可选 inject 的解析顺序与插件加载顺序对不上。所以 `index.js` 用 `file://` 地址 import 桥的 `lib/extension.js`：默认按同装目录的兄弟包解析（`node_modules/qq-ext-*` 与 `dsh-qq-onebot-bridge` 并排），换布局时用 `QQBRIDGE_EXT_PATH` 指过去。**v0.7.4 起上游开了 `dsh-qq-onebot-bridge/extension` 这个 package `exports`**，理论上可以直接 `import('dsh-qq-onebot-bridge/extension')`；这四个包还没改过去，仍是上面那套手写路径猜测（四份重复代码），下一步收拢。
2. **`apply()` 里的状态必须放模块级**。live reload 复用模块实例，state 写在 apply 内会每次多堆一个同名 provider，新工具因重名被跳过（trace 里一串 `skipped`）。
3. **工具参数必须是标准 JSON Schema**。provider 链没有内置 `defineTool` 的方言编译器：属性内部写 `required: true` 会被 `assertSupportedJsonSchema` 直接拒，必须用 `required: ["name"]` 顶层数组。
4. **provider 必须同步返回 `{ tools, sections }`**。返回 Promise 会被明确拒收（上游刻意不支持异步 provider，避免每轮装配被 IO 拖住）。
5. **改 JS 要重启宿主**。改 `config` 的有效内容会触发热重载（per-entry），改 `index.js` 不会。所以示例 entry 里可以留一个没人读的探针数字，专门用来触发 reload。

## 与桥内能力的关系

- house / page-note / workspace 那 17 个工具原先在桥里，迁出后桥侧净减约 855 行；工具名、参数、行为都没变，模型侧无感。
- `qq-ext-face` 的 3 个是**新增**，不是迁出：桥内本来没有 pick / tag / refresh（`qq_face_list`、`qq_face_send` 还在桥里）。这也是总数从 42 变 45 的原因。
- 迁出后它们**不受** `qq-tools.json` 过滤约束（那份白名单只作用于桥建立的会话）；需要按群禁用时，用各自的 config 键（`houseToolsEnabled` 等）或干脆在 `cordis.patch.yml` 里不插入这个 entry。
- 提示段（`sections`）只有 `qq-ext-face` 用了 1 段（`qq-face-sticker`，且可以用 `facePromptSection: false` 关掉）；笔记索引段仍留在桥里。四包合起来只占掉 4 段配额里的 1 段。

## 已知限制

- 出口地址默认按兄弟包解析；只有包不放在桥旁边时才需要 `QQBRIDGE_EXT_PATH`（普通路径或 `file://` 都收），指到不存在的文件会告警并回落默认位置。
- 单包上限 16 工具 / 4 提示段，总量 40 / 12；四包合计 20 工具，距总量上限还有 20 个位置。
- 包是 `private: true` 的本地包，没有发布、没有版本语义，改动靠 commit。

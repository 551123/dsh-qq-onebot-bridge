# ext/ —— 三个 provider 示例包

这三个包是 **v0.7.0 官方「扩展接缝」的真实使用样本**：它们不修改桥的任何文件，只通过 `ctx.qqBridge.registerToolProvider()` 往每个会话注入工具。放在本分支里，是为了让「第三方能给桥加工具」这件事有可运行的证据，而不是一纸接口。

| 包 | 工具 | 数量 | 读的 config 键 |
| --- | --- | --- | --- |
| `qq-ext-house-lite` | `qq_house_list` `qq_house_read` `qq_house_write` `qq_house_append` `qq_house_edit` `qq_house_mkdir` `qq_house_move` `qq_house_trash` | 8 | `houseDir`、`houseToolsEnabled` |
| `qq-ext-page-note` | `qq_page_open` `qq_page_grep` `qq_page_read` `qq_note_save` `qq_note_list` `qq_note_read` | 6 | `pageToolsEnabled`、`noteToolsEnabled` |
| `qq-ext-workspace` | `qq_read_file` `qq_list_files` `qq_search_files` | 3 | `workspaceToolsEnabled`、`cwd` |

合计 17 个工具；桥内仍是 25 个，一起构成 42 个。单包上限是 8（上游 `PROVIDER_LIMITS.toolsPerProvider`），所以小屋包正好顶到上限，再加工具就得拆包。

## 目录结构

```
qq-ext-house-lite/
  index.js      稳定外壳：拿出口 → 每次 apply 重新 import body → registerToolProvider → 返回 disposer
  body.mjs      纯工具实现（不 import 宿主任何东西，可用假 ctx 单测）
  package.json  private 包，main 指向 index.js
```

外壳与实现分开，是因为 **cordis 的 live reload 只重新 apply、不重新 import 已加载模块**：外壳每次 apply 带时间戳重新 import `body.mjs`，于是「改工具 → 碰一下 `cordis.patch.yml` 触发 reload → 新工具生效」不用重启宿主；但改 `index.js` 本身仍要重启。

## 安装

1. 把三个目录复制进宿主插件的同级 `node_modules/`（与 `dsh-qq-onebot-bridge` 同一个目录）。
2. 在 `cordis.patch.yml` 里 `- insert:` 三个 entry：

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
```

3. 把桥的 `extensionToolsEnabled` 显式设为 `true` —— 上游默认 `false`，不开这个开关 provider 一个都不会被调用。

装完在桥的 trace 里能看到类似 `provider「qq-ext-house-lite#v4-house8」注册了 8 个工具 / 0 段提示`，且 `skipped: 0`。

## 五个硬约束（踩过的坑）

1. **必须走 `file://` 绝对 import + `getExtensionApi()`**。直接 `inject: ['qqBridge']` 在本机永远 pending：可选 inject 的解析顺序与插件加载顺序对不上。所以 `index.js` 里那一行 `BRIDGE_EXT` 是绝对路径。
2. **`apply()` 里的状态必须放模块级**。live reload 复用模块实例，state 写在 apply 内会每次多堆一个同名 provider，新工具因重名被跳过（trace 里一串 `skipped`）。
3. **工具参数必须是标准 JSON Schema**。provider 链没有内置 `defineTool` 的方言编译器：属性内部写 `required: true` 会被 `assertSupportedJsonSchema` 直接拒，必须用 `required: ["name"]` 顶层数组。
4. **provider 必须同步返回 `{ tools, sections }`**。返回 Promise 会被明确拒收（上游刻意不支持异步 provider，避免每轮装配被 IO 拖住）。
5. **改 JS 要重启宿主**。改 `config` 的有效内容会触发热重载（per-entry），改 `index.js` 不会。所以示例 entry 里可以留一个没人读的探针数字，专门用来触发 reload。

## 与桥内能力的关系

- 这 17 个工具原先在桥里，迁出后桥侧净减约 855 行；工具名、参数、行为都没变，模型侧无感。
- 迁出后它们**不受** `qq-tools.json` 过滤约束（那份白名单只作用于桥建立的会话）；需要按群禁用时，用各自的 config 键（`houseToolsEnabled` 等）或干脆在 `cordis.patch.yml` 里不插入这个 entry。
- 提示段（`sections`）三个包都没用：笔记索引段仍留在桥里。

## 已知限制

- `index.js` 里的 `BRIDGE_EXT` 是写死路径，换机器 / 换 profile 名要改三个文件。
- 单包 8 工具 / 4 提示段；三个包合计 17，距总量上限 24 还有 7 个位置。
- 包是 `private: true` 的本地包，没有发布、没有版本语义，改动靠 commit。

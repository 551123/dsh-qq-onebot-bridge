# 本分支相对上游 v0.7.0 做了什么

一句话：`patches/0.7.0` = tag `v0.7.0`（提交 `0c9456b`）**+ 17 个功能提交 + 三个 provider 示例包（`ext/`）+ 一个行尾固定提交**。检出的工作区就是可直接运行的完整源码，没有补丁器、没有 JSON 锚点、没有二次拼装。

> 上游仓库：`cheesehaqi/dsh-qq-onebot-bridge`（MIT）。本分支只增加提交，不重写上游历史。

## 1. 与上游的关系

- 从一个 tag 直接生长：`git switch -c patches/0.7.0 v0.7.0`，之后每条功能一个提交。
- 升级方式是 **rebase 到新 tag**，而不是重新打补丁：`git fetch upstream --tags && git rebase v0.8.0`。冲突点恰好是「功能与上游改动撞在一起」的地方，冲突解决结果就是新版本的功能实现。
- `package.json` 的 `name` / `version` 保持上游原值（这些提交不冒充上游发版），分支身份由分支名和本文件表达。
- 上游的 `README.md` / `README.en.md` 一个字节都没改，所以每次 rebase 都不会和上游文档产生冲突。

## 2. 规模

| 项 | 数量 |
| --- | --- |
| 修改文件（不含 `ext/` 与本文） | 20（19 个源文件 + `.gitattributes`） |
| 增删行 | +10 238 / −1 664 |
| 功能提交 | 17（`patch-01` … `patch-55`，编号是本地补丁库的历史编号） |
| 新增目录 | `ext/`（三个 provider 包，10 个文件，17 个工具） |

改动最集中的文件：`lib/bridge.js`（约 +8 200）、`control/ui.html`（约 +1 100）、`lib/archive.js`（约 +880）、`control/lib/supervisor.mjs`、`lib/onebot.js`、`lib/dice.js`、`control/lib/perf.mjs`（新增）、`lib/index.js`、`lib/panel.js`。三个上游测试文件也被同步改过（`test/archive-unit.mjs`、`test/onebot-api-unit.mjs`、`test/find-unit.mjs`）。

## 3. 装完多出什么

### 3.1 工具：42 个（桥内 25 + `ext/` 17）

| 组 | 工具 | 来源 |
| --- | --- | --- |
| 收发与互动 | `qq_send_message` `qq_send_image` `qq_send_file` `qq_send_voice` `qq_react` `qq_recall` | 桥 |
| 读消息 | `qq_read_unread` `qq_recent_history` `qq_search_history` `qq_recent_images` | 桥 |
| 群与成员 | `qq_locate` `qq_member_info` `qq_group_files` `qq_group_albums` `qq_people` `qq_people_note` | 桥 |
| 识别与检索 | `qq_see_image` `qq_image_search` `qq_kb_search` | 桥 |
| 记忆与状态 | `qq_memory_note` `qq_memory_fix` `qq_mood` | 桥 |
| 表情 | `qq_face_list` `qq_face_send` | 桥 |
| 画图 | `qq_draw_image` | 桥（默认关） |
| 小屋 | `qq_house_list` `qq_house_read` `qq_house_write` `qq_house_append` `qq_house_edit` `qq_house_mkdir` `qq_house_move` `qq_house_trash` | `ext/qq-ext-house-lite` |
| 页面与笔记 | `qq_page_open` `qq_page_grep` `qq_page_read` `qq_note_save` `qq_note_list` `qq_note_read` | `ext/qq-ext-page-note` |
| 工作区只读 | `qq_read_file` `qq_list_files` `qq_search_files` | `ext/qq-ext-workspace` |

`ext/` 的三个包不是补丁，是 **v0.7.0 官方 provider 接缝的真实使用者**：它们通过 `ctx.qqBridge.registerToolProvider()` 往每个会话注入工具，完全不碰桥的任何文件。详见 `ext/README.md`。

### 3.2 六个能力开关（配置键，不是代码分支）

| 配置键 | 默认 | 置 `false` 的效果 |
| --- | --- | --- |
| `faceEnabled` | true | 不注册 `qq_face_*`（表情渲染分支也一起关） |
| `houseToolsEnabled` | true | 不注册 8 个 `qq_house_*` |
| `pageToolsEnabled` | true | 不注册 3 个 `qq_page_*` |
| `noteToolsEnabled` | true | 不注册 3 个 `qq_note_*` |
| `peopleToolsEnabled` | true | 不注册 `qq_people*`，同时停掉群友印象落盘 |
| `groupFileToolEnabled` | true | 不注册 `qq_group_files` / `qq_group_albums` |

六个键都在设置面板「能力开关（工具组）」里有独立一行，改完由宿主热重载生效（约 2 秒），改的是配置、不改代码。

### 3.3 系统提示：19 段，全部排在宿主工具说明之前

| order | 段 | 作用 |
| --- | --- | --- |
| 118 | `qq-onebot-bridge` | 桥的存在与边界（受控、非全权代理） |
| 119–122 | 群上下文 / 记忆索引 / 心情 / 自主性 | 每轮快照，走 runtime context 通道 |
| 130–139 | 工作区、群资产、知识库、搜图、识图、笔记、记忆笔记、能力清单、画图提示、封闭边界 | 能力说明 |
| 150 | `qq-untrusted` | 外部内容不可信规则 |
| 160 | `qq-persona` | 人设正文（来自 `qq-persona.txt`） |
| 161 | `qq-reply-style` | 表达风格约束 |
| 10300 | `qq-persistent-memory` | 长期记忆索引摘要（放最后，避免每轮变动的段打掉前面的前缀缓存） |

### 3.4 人设与唤醒词

- 人设正文读**插件根目录**的 `qq-persona.txt`（UTF-8，上限 20 000 字符）。文件不存在时人设为空，并在宿主 stderr 打一条缺失警告，不再静默变成「没有性格的机器人」。
- 控制台「能力/白名单」页可以编辑这段正文（保存时旧文件留 `.bak`，空正文拒写）。它是 **import 期读进模块常量**的，所以改完要重启宿主。
- 唤醒词从常量改成了配置键 `wakeWords: string[]`；留空则用内置默认集。

### 3.5 工具白名单 `qq-tools.json`

放在桥的 `cwd` 下（默认由配置的 `cwd` 决定），形如：

```json
{ "enabled": true, "default": { "deny": ["qq_draw_image"] }, "chats": { "g:100000000": { "allow": ["*"] } } }
```

桥在装配每个会话时按 `g:<群号>` / `g:<群号>:u:<QQ号>` 逐条判定，支持 `*` 通配；文件每次调用重读，所以改完立刻生效，不用重启。它只作用于**本插件建立的 agent 会话**。

### 3.6 控制台 `control/`（127.0.0.1:8799，独立进程）

能看：端口/进程、事件流、决策链、体检、录制列表、运行快照。
能改：启停宿主 / NapCat / TTS、释放端口、离线回放（沙箱 + dry-run）、事件注入、能力表、人格 12 字段、人设正文。
鉴权：只绑回环地址 + token + 同源 Origin 校验。

### 3.7 归档与出站

合并转发转写、收件箱、历史归档与检索、出站审计、按群限流（`lib/ratelimit.js`）、长文本断句、`[face:x]` 展开、注入污点标记（外部内容命中注入模式后的 30 分钟窗口内，7 个出站动作进 dry-run）。

## 4. 安装（源码形态）

```sh
cd ~/.dsh/profiles/web/node_modules
git clone -b patches/0.7.0 <本仓库地址> dsh-qq-onebot-bridge
cd dsh-qq-onebot-bridge && npm i --omit=dev      # 唯一运行时依赖：ws
```

然后在 `cordis.patch.yml` 里注册 entry（`id` 与 `name` 都用 `dsh-qq-onebot-bridge`，`config` 见上游 README 的配置一节），重启宿主。

要启用 `ext/` 的三个示例包：把 `ext/qq-ext-*` 复制进同一个 `node_modules/`，并在 `cordis.patch.yml` 里 `- insert:` 三个 entry，同时把桥的 `extensionToolsEnabled` 显式打开（上游默认 `false`）。

## 5. 自检

```sh
for f in test/*-unit.mjs; do node "$f" || echo "FAIL $f"; done   # 上游 75 个测试文件
grep -o "name: .qq_[A-Za-z0-9_]*" lib/bridge.js ext/*/body.mjs | wc -l   # 期望 42
```

排查三问：人设没生效 → 看宿主 stderr 有没有「人设缺失」警告、`qq-runtime.json` 的 `features.personaChars` 是不是 0；工具没出现 → 看 trace 里 provider 是否有 `skipped`；改了配置没反应 → 只有**有效 config 内容**变化才会触发热重载。

## 6. 已知限制

1. **版本绑定**：这些提交锚在 v0.7.0 的源码文本上，升级靠 rebase。上游改了同一区域就要人读一遍冲突。
2. **`ext/` 的出口地址**：包要 import 桥的 `lib/extension.js`，而上游 `package.json` 的 `exports` 不含它，只能按 `file://` 绝对地址 import。默认取同装目录的兄弟包（`node_modules/qq-ext-*` 与 `dsh-qq-onebot-bridge` 并排），非默认布局用环境变量 `QQBRIDGE_EXT_PATH` 覆盖（普通路径或 `file://` 都收）。
3. `qq-tools.json` 的过滤只作用于桥建立的会话，管不到别的插件注册的工具。
4. 记忆与历史归档**不按群隔离**（`memory-index/` 与归档目录是全局的），只有一个提示层规则要求模型注明来源。
5. provider 接缝上限：单包 8 工具 / 4 提示段、总量 24 / 12、200 ms 预算、必须同步返回；`chips`（快捷挂载）上游明确不做。
6. 人设正文改动需要重启宿主；控制台是独立进程，重启 DSH 桌面端不会自动带起它。

## 7. 提交清单（`v0.7.0..HEAD`）

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `chore` | 固定 LF 行尾（`.gitattributes`） |
| 2–18 | `patch-01` … `patch-55` | 17 条功能提交，顺序与下面的功能分组一致：归档转发 → 人设/记忆 → 群内交互 → 工具与能力 → 拟人化 → 模型与审计 → 控制台 → 小屋 → 页面笔记 → 防线二 → 注意力收敛 → 表情 → 面板开关 → 预设注册 → 白名单提示 |
| 19 | `feat(ext)` | 三个 provider 示例包 |
| 20 | `docs` | 本文件与 `ext/README.md` |

提交信息里保留了本地补丁库的编号（`patch-XX`），只是为了对照历史；这些提交之间没有依赖顺序之外的含义，单独 cherry-pick 其中一条通常也能编译，但功能会缺前置。

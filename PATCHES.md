# 本分支相对上游 v0.7.7 做了什么

一句话：`patches/0.7.7` = tag `v0.7.7`（提交 `c59ca8f`）**+ `.gitattributes` + 18 条补丁各一个提交 + `ext/` 四个示例包 + 本文件**。检出的工作区就是可直接运行的完整源码，没有补丁器、没有 JSON 锚点、没有二次拼装。

> 上游仓库：`cheesehaqi/dsh-qq-onebot-bridge`（MIT）。本分支只增加提交，不重写上游历史。

## 1. 与上游的关系

| 分支 | 内容 | 状态 |
| --- | --- | --- |
| `main` | `v0.7.0` 的镜像，未加本地改动 | 只用于对照 |
| `patches/0.7.0` | `v0.7.0` + **25 个提交**（17 条功能提交 + ext 三个包 + 行尾固定 + 若干 fix），末条 `a15ae8da` | 归档 |
| `patches/0.7.4` | `v0.7.4` + **1 个提交**（`984006c`），含全部 159 条本地编辑 | 归档 |
| `patches/0.7.5` | `v0.7.5` + **23 个提交**（`.gitattributes` + 18 条补丁 + `ext/` + 分支文档），末条 `327a584`，157 编辑 | 归档（0.7.7 起不再前进） |
| `patches/0.7.7` | `v0.7.7` + **逐条导出**（`.gitattributes` + 18 条补丁各一提交 + `ext/` + 本文件），**156 编辑** | **现役** |

0.7.0 线是「一个功能一个提交，升级靠 `git rebase v新tag`」。0.7.4 线**没有沿用这个形态**：0.7.4 动了断句区与白名单时机，正好压在 17 个功能提交的锚点上，逐条 rebase 等于把每条冲突都重解一遍。所以改成用补丁器的 `tools/fork-export.mjs` 从补丁库全量重导；0.7.5 沿用同一条做法，0.7.7 也是（换版时补丁库重锚，fork 侧只重导）。

代价要讲清楚：**`git rebase` 不再回答「上游改版后还剩几条对得上」** —— 这个问题现在由补丁库回答（`node tools/reanchor.mjs` 离线预演 + `node apply-forward-archive-patch.mjs --verify` 报「可应用 / 已就位 / 阻塞」）。换来的是：换版不需要人重解 17 次冲突，只要补丁库能重锚。

`package.json` 的 `name` / `version` 保持上游原值（这些提交不冒充上游发版），分支身份由分支名和本文件表达。上游的 `README.md` / `README.en.md` 一个字节都没改，所以 rebase / 重导都不会和上游文档产生冲突。

## 2. 规模（对 `v0.7.7` 实测）

| 项 | 数量 |
| --- | --- |
| 提交 | 由 `fork-export` 逐条生成：`.gitattributes` + 18 条补丁（各一个提交）+ `ext/`；本文件的每次修订再加一个提交。总数以 `git rev-list --count v0.7.7..HEAD` 为准 |
| 改动文件（不含 `ext/`） | 20 个改动 + `.gitattributes` |
| `ext/` | 4 个包 / 13 个文件（每包 `index.js` + `body.mjs` + `package.json`，外加 `README.md`） |
| 增删行（不含 `ext/` 与本文） | **+10 693 / −1 670**，20 个文件（`.gitattributes` 另 +1） |
| `ext/` 增删行 | **+2 227**，13 个文件 |
| 来源 | 补丁库 `QQ助手补丁\patches\`：**18 条补丁 / 156 条编辑 / 20 个源文件** |

改动最集中的文件（增 / 删行）：`lib/bridge.js` +6 791 / −1 602、`control/ui.html` +1 103 / −4、`lib/archive.js` +875 / −2、`lib/onebot.js` +370 / −12、`lib/faces.js` +317 / −6、`control/lib/supervisor.mjs` +316 / −5、`control/lib/perf.mjs` +205 / −0（新增）、`lib/index.js` +139 / −1；其余为 `lib/dice.js`、`control/lib/config.mjs`、`lib/panel.js`、`control/lib/server.mjs`、`lib/broadcast.js`、`lib/napcat-launch.js`、`control/lib/diagnose.mjs`、`lib/imagegen.js`、`lib/trace.js`。四个上游测试文件也被同步改过（`test/archive-unit.mjs`、`test/onebot-api-unit.mjs`、`test/find-unit.mjs`、`test/static-unit.mjs`）。

`.gitattributes`（`* -text`，固定 LF）由 `tools/fork-export.mjs` 在开分支时先提交一条，每次 rebase / 重导都会带上它 —— 补丁锚点是按 LF 算的，这台机器 `core.autocrlf=true` 是系统级设置，只能靠仓库自己钉住。

## 3. 装完多出什么

### 3.1 工具：45 个（桥内 25 + `ext/` 20）

| 组 | 工具 | 来源 |
| --- | --- | --- |
| 收发与互动 | `qq_send_message` `qq_send_image` `qq_send_file` `qq_send_voice` `qq_react` `qq_recall` | 桥 |
| 读消息 | `qq_read_unread` `qq_recent_history` `qq_search_history` `qq_recent_images` | 桥 |
| 群与成员 | `qq_locate` `qq_member_info` `qq_group_files` `qq_group_albums` `qq_people` `qq_people_note` | 桥 |
| 识别与检索 | `qq_see_image` `qq_image_search` `qq_kb_search` | 桥 |
| 记忆与状态 | `qq_memory_note` `qq_memory_fix` `qq_mood` | 桥 |
| 表情（桥内） | `qq_face_list` `qq_face_send` | 桥 |
| 画图 | `qq_draw_image` | 桥（默认关） |
| 小屋 | `qq_house_list` `qq_house_read` `qq_house_write` `qq_house_append` `qq_house_edit` `qq_house_mkdir` `qq_house_move` `qq_house_trash` | `ext/qq-ext-house-lite`（8） |
| 页面与笔记 | `qq_page_open` `qq_page_grep` `qq_page_read` `qq_note_save` `qq_note_list` `qq_note_read` | `ext/qq-ext-page-note`（6） |
| 工作区只读 | `qq_read_file` `qq_list_files` `qq_search_files` | `ext/qq-ext-workspace`（3） |
| 表情（收藏库） | `qq_face_pick` `qq_face_tag` `qq_face_refresh` | `ext/qq-ext-face`（3，另加 1 段提示） |

`ext/` 的四个包不是补丁，是 **provider 接缝的真实使用者**：它们通过 `ctx.qqBridge.registerToolProvider()` 往每个会话注入工具，完全不碰桥的任何文件。详见 `ext/README.md`。

### 3.2 七个能力开关（配置键，不是代码分支）

| 配置键 | 默认 | 置 `false` 的效果 |
| --- | --- | --- |
| `faceEnabled` | true | 不注册 `qq_face_*`（表情渲染分支也一起关） |
| `houseToolsEnabled` | true | 不注册 8 个 `qq_house_*` |
| `pageToolsEnabled` | true | 不注册 3 个 `qq_page_*` |
| `noteToolsEnabled` | true | 不注册 3 个 `qq_note_*` |
| `peopleToolsEnabled` | true | 不注册 `qq_people*`，同时停掉群友印象落盘 |
| `groupFileToolEnabled` | true | 不注册 `qq_group_files` / `qq_group_albums` |
| `extensionToolsEnabled` | **false**（上游默认） | 不调用任何 provider —— `ext/` 四个包一个都不会被接进来 |

前六个键都在设置面板「能力开关（工具组）」里有独立一行，改完由宿主热重载生效（约 2 秒），改的是配置、不改代码。`extensionToolsEnabled` 必须显式打开，`ext/` 才生效。

### 3.3 系统提示段

提示段由 `sections` 机制注入，order 从小到大地排在宿主工具说明之前。当前实际用到的 order：`5`（工具限制提示）、`118`（桥的存在与边界：受控、非全权代理）、`119`/`123`/`130`–`134`/`139`（群上下文、记忆索引、心情、自主性、工作区、群资产、知识库、搜图、识图、笔记、能力清单、画图提示、封闭边界）、`10300`（长期记忆索引摘要，放最后，避免每轮变动的段打掉前面的前缀缓存）。精确清单以 `lib/bridge.js` 里 `sections` 的注册处为准 —— 别把这张表当唯一真源。

### 3.4 人设与唤醒词

- 人设正文读**插件根目录**的 `qq-persona.txt`（UTF-8，上限 20 000 字符）。文件不存在时人设为空，并在宿主 stderr 打一条缺失警告，不再静默变成「没有性格的机器人」。
- 控制台「能力/白名单」页可以编辑这段正文（保存时旧文件留 `.bak`，空正文拒写）。它是 **import 期读进模块常量**的，所以改完要重启宿主。
- 唤醒词从常量改成了配置键 `wakeWords: string[]`；留空则用内置默认集。

### 3.5 工具白名单 `qq-tools.json`

放在桥的 `cwd` 下（路径是 `<cwd>/qq-tools.json`），形如：

```json
{ "enabled": true, "default": { "deny": ["qq_draw_image"] }, "chats": { "g:100000000": { "allow": ["*"] } } }
```

桥在装配每个会话时按 `g:<群号>` / `g:<群号>:u:<QQ号>` 逐条判定；文件每次调用重读，所以改完立刻生效，不用重启。它只作用于**本插件建立的 agent 会话**。

`"*"` **是通配**：`#toolAllowed()` 里显式处理了它（`allow` 含 `*` 即全放行，`deny` 含 `*` 即全拦）。这条是 2026-10-19 事故后补上的 —— 旧实现是纯字面量比较，一旦控制台存下 `"allow": ["*"]` 会把该会话所有工具**全拦死**。凡是写着「白名单没有通配符」的旧文档都是那次事故之前的描述。

### 3.6 控制台 `control/`（127.0.0.1:8799，独立进程）

能看：端口/进程、事件流、决策链、体检、录制列表、运行快照。
能改：启停宿主 / NapCat / TTS、释放端口、离线回放（沙箱 + dry-run）、事件注入、能力表、人格 12 字段、人设正文。
鉴权：只绑回环地址 + token + 同源 Origin 校验。

### 3.7 归档与出站

合并转发转写、收件箱、历史归档与检索、出站审计、按群限流（`lib/ratelimit.js`）、长文本断句、`[face:x]` 展开、注入污点标记（外部内容命中注入模式后的 30 分钟窗口内，7 个出站动作进 dry-run）。

## 4. 安装（源码形态）

```sh
cd ~/.dsh/profiles/web/node_modules
git clone -b patches/0.7.7 <本仓库地址> dsh-qq-onebot-bridge
cd dsh-qq-onebot-bridge && npm i --omit=dev      # 唯一运行时依赖：ws
```

然后在 `cordis.patch.yml` 里注册 entry（`id` 与 `name` 都用 `dsh-qq-onebot-bridge`，`config` 见上游 README 的配置一节），重启宿主。

要启用 `ext/` 的四个示例包：把 `ext/qq-ext-*` 复制进同一个 `node_modules/`，在 `cordis.patch.yml` 里 `- insert:` 四个 entry，并把桥的 `extensionToolsEnabled` 显式打开（上游默认 `false`）。

## 5. 自检

```sh
for f in test/*-unit.mjs; do node "$f" || echo "FAIL $f"; done        # 62 个测试文件
grep -hoE "name: 'qq_[A-Za-z0-9_]+'" lib/bridge.js ext/*/body.mjs | sort -u | wc -l   # 期望 45
node -e "console.log(require('./package.json').version)"              # 0.7.7（跟上上游，不冒充发版）
```

排查三问：人设没生效 → 看宿主 stderr 有没有「人设缺失」警告、`qq-runtime.json` 的 `features.personaChars` 是不是 0；工具没出现 → 先确认 `extensionToolsEnabled`，再看 trace 里 provider 是否有 `skipped`；改了配置没反应 → 只有**有效 config 内容**变化才会触发热重载（改 `.js` 必须重启宿主）。

## 6. 已知限制

1. **版本绑定是「锚点」**：这些编辑锚在 v0.7.7 的源码文本上（字面串，不是 diff 上下文）。升级的权威路径是**补丁库重锚**（`tools/reanchor.mjs` 预演 → `apply-forward-archive-patch.mjs --verify` 看「可应用/已就位/阻塞」），再 `fork-export` 重导本分支；`git rebase` 只是重导之后的一个可选动作，锚点撞车时它帮不上忙（工作树里没有「编辑意图」，只有文本）。上游改了同一区域，仍要人读一遍「阻塞」那几条。
2. **`ext/` 的出口地址**：包要 import 桥的出口，而不同版本 `package.json` 的 `exports` 覆盖面不同。优先 `import('dsh-qq-onebot-bridge/extension')`（0.7.4 起 exports 已含它），解析失败再按兄弟包 `file://` 绝对地址兜底，环境变量 `QQBRIDGE_EXT_PATH` 始终最优先（普通路径或 `file://` 都收）。
3. `qq-tools.json` 的过滤只作用于桥建立的会话，管不到别的插件注册的工具；`ext/` 的工具也**不吃**这张表，要按包禁用就用各自的 config 键或干脆不 insert。
4. 记忆与历史归档**不按群隔离**（`memory-index/` 与归档目录是全局的），只有一个提示层规则要求模型注明来源。
5. provider 接缝上限：单包 **16** 工具 / **4** 提示段、总量 **40 / 12**、200 ms 预算、必须同步返回（v0.7.4 从 8 / 24 放宽，且超出不再静默丢弃，改记 `skipped`）；`chips`（快捷挂载）上游明确不做。
6. 人设正文改动需要重启宿主；控制台是独立进程，重启 DSH 桌面端不会自动带起它。
7. provider 回调**出错要抛**，不要 `return { tools: [], sections: [], reason }` —— 后者在上游眼里是「成功但空」，面板上看着一切正常、实际上一个工具都没接进来（0.7.0 分支末尾那条 `fix(ext)` 就是修这个）。
8. `ext/` 的四个包目录名是 `qq-ext-*`，会被桥的 `.gitignore` 里那条**无锚点**的 `qq-*/`（本意是拦根目录运行产物）整目录吞掉：`git add -A ext` 只进 `README.md`，12 个源文件静默跳过。已用 `!ext/qq-*/` 反选修好，别把这条删了。

## 7. 提交清单（`v0.7.7..HEAD`）

由 `tools/fork-export.mjs` 从补丁库逐条生成，一条补丁一个提交（提交总数以 `git rev-list --count v0.7.7..HEAD` 为准 —— 本文件自己每改一次就多一个提交，写死数字必然自相矛盾）：

| 序 | 提交 | 内容 |
| --- | --- | --- |
| 首 | `chore: 固定 LF 行尾` | `.gitattributes`（`* -text`）—— 系统级 `core.autocrlf=true`，只有仓库自己能钉住行尾 |
| 中 | `patch-NN: …` | 18 条补丁，各自一条提交，标题带补丁名（归档转发 / 人设记忆 / 群内交互 / 工具接线 / … / 表情段） |
| 后 | `feat(ext): 四个 provider 扩展包（20 工具）与使用说明` | `ext/` 13 个文件（从线上 `node_modules/qq-ext-*` 同步）+ `.gitignore` 反选 |
| 后 | `docs: …` | 本文件的首次落地与历次修订 |

**这个形状每次换版可能变**（0.7.0 逐条 17 提交 → 0.7.4 单提交快照 → 0.7.5/0.7.7 回逐条 18 条补丁各一提交）。判据只有一条：`fork-export` 逐条能不能干净落在上游 tag 上；撞在上游重写过我们插桩的段落、且会级联才降级成单提交，并在补丁器那边记原因。链接与仓库结构（分支名、`ext/` 位置）不受形状影响。

归档分支：`patches/0.7.0`（25 提交）、`patches/0.7.4`（单提交 `984006c`）、`patches/0.7.5`（23 提交，末条 `327a584`）。`git log <分支>` 可查，保留作为历史对照。

> 本文件在树内，所以**这里不写死提交 sha** —— 这条快照每 amend 一次 sha 就变（改本文也算），写死会自相矛盾。
> 真值在补丁器的 `upstream-installed.json`：`fork.commit`（完整 sha）与 `fork.remote["patches/0.7.7"]`；
> 自己看：`git -C <本仓库> rev-parse patches/0.7.7`。

提交信息里保留了本地补丁库的历史编号（`patch-XX`）以便对照。**改法一律是「改补丁库 JSON → 重跑 `fork-export`」**，不在本分支上手改源码：手改的差异下次重导就没了，而且会让 `fork 树 == 线上树` 这项门禁失去意义。

## 8. 0.7.7 这一版的差异（相对 0.7.5 线）

- **上游把断句开关收走了**：v0.7.7 自带 `longReplySplitOnPunctuation`（默认 `true`）与 `splitSegments(segments, limit, { punctuation })`。我们把 `patch-03` 里那条自造断句开关的整条编辑（`bridge:h01c`，19 行 to）**整条删掉** —— `patch-03` 从 29 条编辑降到 28 条，全库 157 → **156** 编辑。断句策略交还上游，我们只保留「分条（parts）+ 每批断句」。
- **三处配套清理**：运行快照白名单里的 `'splitLongReplies'` 与它那行注释（`patch-02` `bridge:h09`）、`lib/index.js` 的 `splitLongReplies: z.boolean().default(true)` 与其两行注释（`patch-03` `index:h23c`）一并删除；`grep -rn splitLongReplies lib/ patches/` 现在 0 命中。
- **重锚一条**：`patch-05` `bridge:h04` 的 from 从 39 行涨到 **46 行**（上游在原调用点上方加了 5 行说明注释、调用从两参变三参），to 里 `chunk` 那一行改成读上游的键：`{ punctuation: this.config.longReplySplitOnPunctuation !== false }`，并在上方补一段注释说明「分条归我们、批内断句归上游」。`patch-56` 的 `f05`/`f06` 两条锚点仍逐字落在 `h04` 的 to 里（这是硬约束：改 h04 必须连它们一起验）。
- **switch 语义别读错**：`punctuation: false` **只关「按标点找断点」，不关分批**。实测 5000 字 @ limit 1700 关掉后仍是 3 批（1700 / 1700 / 1600），只是每批硬切在 limit 上。想整条直发只能把 `maxMessageLength` 调大到超过正文。
- 结果：18 条补丁 / **156 编辑** / 20 文件，`--verify` 在 v0.7.7 上 **0 可应用 / 156 已就位 / 0 阻塞**。

## 9. 链接约定（给上游 README 用的）

上游 README 的「第三方扩展（社区）」一段指向 `.../tree/patches/<tag>/ext`。约定是：

1. 每次跟上上游发版，分支名就是 `patches/<上游 tag>`（这一版是 `patches/0.7.7`），父提交就是该 tag 解引用出来的 commit；
2. `ext/` 永远在分支根目录下，四个包的目录名不变（`qq-ext-face` / `qq-ext-house-lite` / `qq-ext-page-note` / `qq-ext-workspace`）；
3. 所以上游每次发版只需要把链接里的 tag 改一下，不用改路径结构；
4. **分支里的提交数会变，链接不会跟着变** —— 逐条提交还是单提交快照取决于当次 `fork-export` 能否逐条干净落地（见 §7 末段），那条分支名和 `ext/` 位置是稳定的契约。

要指就指到 `.../tree/patches/0.7.7/ext` 这个**目录**，别指具体文件 —— 实现文件名会变。

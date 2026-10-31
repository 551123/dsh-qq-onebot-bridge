# 本分支相对上游 v0.7.10 做了什么

一句话：`patches/0.7.10` = tag `v0.7.10`（提交 `1f45371`）**+ `.gitattributes` + 16 条补丁各一个提交 + `ext/` 四个示例包 + 本文件**。检出的工作区就是可直接运行的完整源码，没有补丁器、没有 JSON 锚点、没有二次拼装。

> 上游仓库：`cheesehaqi/dsh-qq-onebot-bridge`（MIT）。本分支只增加提交，不重写上游历史。

## 1. 与上游的关系

| 分支 | 内容 | 状态 |
| --- | --- | --- |
| `main` | `v0.7.0` 的镜像，未加本地改动 | 只用于对照 |
| `patches/0.7.0` | `v0.7.0` + **25 个提交**（17 条功能提交 + ext 三个包 + 行尾固定 + 若干 fix），末条 `a15ae8da` | 归档 |
| `patches/0.7.4` | `v0.7.4` + **1 个提交**（`984006c`），含全部 159 条本地编辑 | 归档 |
| `patches/0.7.5` | `v0.7.5` + **23 个提交**（`.gitattributes` + 18 条补丁 + `ext/` + 分支文档），末条 `327a584`，157 编辑 | 归档（0.7.7 起不再前进） |
| `patches/0.7.7` | `v0.7.7` + **21 个提交**（`.gitattributes` + 18 条补丁 + `ext/` + 分支文档），末条 `6655a9e`，156 编辑 | 归档 |
| `patches/0.7.8` | `v0.7.8` + **逐条导出**（`.gitattributes` + 20 条补丁各一提交 + `ext/` + 本文件），**159 编辑**；末条 `bd62ced`（含素材表情库 4 个提交） | 归档（0.7.9 起不再前进） |
| `patches/0.7.9` | `v0.7.9` + **逐条导出**（`.gitattributes` + 16 条补丁各一提交 + `ext/` + 本文件），**194 编辑**（2026-10-31 合并后），末条 `60e3e0a` | 归档（0.7.10 起不再前进） |
| `patches/0.7.10` | `v0.7.10` + **逐条导出**（`.gitattributes` + 16 条补丁各一提交 + `ext/` + 本文件），**194 编辑**（编辑数未变，只换了上游基座） | **现役** |

0.7.0 线是「一个功能一个提交，升级靠 `git rebase v新tag`」。0.7.4 线**没有沿用这个形态**：0.7.4 动了断句区与白名单时机，正好压在 17 个功能提交的锚点上，逐条 rebase 等于把每条冲突都重解一遍。所以改成用补丁器的 `tools/fork-export.mjs` 从补丁库全量重导；0.7.5 / 0.7.7 / 0.7.8 / 0.7.9 / 0.7.10 沿用同一条做法（换版时补丁库重锚，fork 侧只重导）。

代价要讲清楚：**`git rebase` 不再回答「上游改版后还剩几条对得上」** —— 这个问题现在由补丁库回答（`node tools/reanchor.mjs` 离线预演 + `node apply-forward-archive-patch.mjs --verify` 报「可应用 / 已就位 / 阻塞」）。换来的是：换版不需要人重解 17 次冲突，只要补丁库能重锚。

`package.json` 的 `name` / `version` 保持上游原值（这些提交不冒充上游发版），分支身份由分支名和本文件表达。上游的 `README.md` / `README.en.md` 一个字节都没改，所以 rebase / 重导都不会和上游文档产生冲突。

## 2. 规模（对 `v0.7.10` 实测）

| 项 | 数量 |
| --- | --- |
| 提交 | 由 `fork-export` 逐条生成：`.gitattributes` + 16 条补丁（各一个提交）+ `ext/`；本文件的每次修订再加一个提交。总数以 `git rev-list --count v0.7.10..HEAD` 为准 |
| 改动文件（不含 `ext/`） | 21 个改动 + `.gitattributes` |
| `ext/` | 4 个包 / 13 个文件（每包 `index.js` + `body.mjs` + `package.json`，外加 `README.md`） |
| 增删行（不含 `ext/` 与本文） | **+11074 / −1699**，21 个文件（`.gitattributes` 另 **+1 / −18** —— 替换上游同名属性文件，见 §8） |
| `ext/` 增删行 | **+2 227**，13 个文件 |
| 仓库自身文件 | `.gitignore` **+3** 行（`ext/` 反选块，见 §2 说明）；`.gitattributes` 是**替换**上游同名文件（+1 / −18） |
| 来源 | 补丁库 `QQ助手补丁\patches\`：**16 条补丁 / 194 条编辑 / 21 个源文件** |

改动最集中的文件（增 / 删行）：`lib/bridge.js` +6915 / −1626、`control/ui.html` +1106 / −4、`lib/archive.js` +875 / −2、`lib/faces.js` +378 / −8、`lib/onebot.js` +372 / −12、`control/lib/supervisor.mjs` +317 / −5、`control/lib/perf.mjs` +205 / −0、`lib/sticker-index.js` +159 / −0、`lib/index.js` +146 / −1、`lib/dice.js` +135 / −18；其余为 `control/lib/config.mjs`、`test/archive-unit.mjs`、`lib/panel.js`、`test/onebot-api-unit.mjs`、`control/lib/server.mjs`、`lib/broadcast.js`、`lib/napcat-launch.js`、`test/find-unit.mjs`、`control/lib/diagnose.mjs`、`lib/imagegen.js`、`lib/trace.js`。

`.gitattributes`（`* -text`，固定 LF）由 `tools/fork-export.mjs` 在开分支时先提交一条，每次 rebase / 重导都会带上它 —— 补丁锚点是按 LF 算的，这台机器 `core.autocrlf=true` 是系统级设置，只能靠仓库自己钉住。

## 3. 装完多出什么

### 3.1 工具：47 个（桥内 27 + `ext/` 20）

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
git clone -b patches/0.7.8 <本仓库地址> dsh-qq-onebot-bridge
cd dsh-qq-onebot-bridge && npm i --omit=dev      # 唯一运行时依赖：ws
```

然后在 `cordis.patch.yml` 里注册 entry（`id` 与 `name` 都用 `dsh-qq-onebot-bridge`，`config` 见上游 README 的配置一节），重启宿主。

要启用 `ext/` 的四个示例包：把 `ext/qq-ext-*` 复制进同一个 `node_modules/`，在 `cordis.patch.yml` 里 `- insert:` 四个 entry，并把桥的 `extensionToolsEnabled` 显式打开（上游默认 `false`）。

## 5. 自检

```sh
for f in test/*-unit.mjs; do node "$f" || echo "FAIL $f"; done        # 62 个测试文件
grep -hoE "name: 'qq_[A-Za-z0-9_]+'" lib/bridge.js ext/*/body.mjs | sort -u | wc -l   # 期望 45
node -e "console.log(require('./package.json').version)"              # 0.7.8（跟上上游，不冒充发版）
```

排查三问：人设没生效 → 看宿主 stderr 有没有「人设缺失」警告、`qq-runtime.json` 的 `features.personaChars` 是不是 0；工具没出现 → 先确认 `extensionToolsEnabled`，再看 trace 里 provider 是否有 `skipped`；改了配置没反应 → 只有**有效 config 内容**变化才会触发热重载（改 `.js` 必须重启宿主）。

## 6. 已知限制

1. **版本绑定是「锚点」**：这些编辑锚在 v0.7.8 的源码文本上（字面串，不是 diff 上下文）。升级的权威路径是**补丁库重锚**（`tools/reanchor.mjs` 预演 → `apply-forward-archive-patch.mjs --verify` 看「可应用/已就位/阻塞」），再 `fork-export` 重导本分支；`git rebase` 只是重导之后的一个可选动作，锚点撞车时它帮不上忙（工作树里没有「编辑意图」，只有文本）。上游改了同一区域，仍要人读一遍「阻塞」那几条。
2. **`ext/` 的出口地址**：包要 import 桥的出口，而不同版本 `package.json` 的 `exports` 覆盖面不同。优先 `import('dsh-qq-onebot-bridge/extension')`（0.7.4 起 exports 已含它），解析失败再按兄弟包 `file://` 绝对地址兜底，环境变量 `QQBRIDGE_EXT_PATH` 始终最优先（普通路径或 `file://` 都收）。
3. `qq-tools.json` 的过滤只作用于桥建立的会话，管不到别的插件注册的工具；`ext/` 的工具也**不吃**这张表，要按包禁用就用各自的 config 键或干脆不 insert。
4. 记忆与历史归档**不按群隔离**（`memory-index/` 与归档目录是全局的），只有一个提示层规则要求模型注明来源。
5. provider 接缝上限：单包 **16** 工具 / **4** 提示段、总量 **40 / 12**、200 ms 预算、必须同步返回（v0.7.4 从 8 / 24 放宽，且超出不再静默丢弃，改记 `skipped`）；`chips`（快捷挂载）上游明确不做。
6. 人设正文改动需要重启宿主；控制台是独立进程，重启 DSH 桌面端不会自动带起它。
7. provider 回调**出错要抛**，不要 `return { tools: [], sections: [], reason }` —— 后者在上游眼里是「成功但空」，面板上看着一切正常、实际上一个工具都没接进来（0.7.0 分支末尾那条 `fix(ext)` 就是修这个）。
8. `ext/` 的四个包目录名是 `qq-ext-*`，会被桥的 `.gitignore` 里那条**无锚点**的 `qq-*/`（本意是拦根目录运行产物）整目录吞掉：`git add -A ext` 只进 `README.md`，12 个源文件静默跳过。已用 `!ext/qq-*/` 反选修好，别把这条删了。

## 7. 提交清单（`v0.7.10..HEAD`，19 个提交）

编号 1 是行尾固定（`.gitattributes`），2–18 是 16 条补丁逐条落地，之后是 `ext/`；最后一条是本文件的这次修订。

| # | 提交 | 内容 |
| --- | --- | --- |
| 1 | `8b9c8cc` | chore: 固定 LF 行尾（补丁锚点按 LF 口径） |
| 2 | `fe46b36` | patch-01 补丁01 归档·转发·收件箱（基础管线） |
| 3 | `d484a6c` | patch-02 补丁02 人设·上下文·世界书·长期记忆·群友印象·结构化人格 |
| 4 | `4d65ed1` | patch-03 补丁03 群内交互与命令（@唤醒·骰子插话·断句·定时文案·群定位·只读） |
| 5 | `a899243` | patch-04 补丁04 工具与能力（会话接线·识图搜图·知识库·画图·工具白名单·能力勾选·工具参考页） |
| 6 | `05bcf05` | patch-05 补丁05 拟人化表驱动（情绪·回复表达·仿真·自主读发·封闭 Agent） |
| 7 | `bbcaf47` | patch-06 补丁06 模型·审计·用量（每群模型·出站审计·令牌花费） |
| 8 | `8569120` | patch-07 补丁07 控制台后端与 DSH 面板（配置加固·能力表后端·面板总开关·NapCat 路径·目录对齐） |
| 9 | `a16c401` | patch-08 补丁08 控制台前端（能力开关卡·表单化·表说明·断线分流·人格 12 格） |
| 10 | `39a023c` | patch-42 补丁42 小屋 git 自动化（唯一可写目录的每日快照与提交；8 个写工具已迁出） |
| 11 | `a0a794a` | patch-44 补丁44 群图默认落盘 + 笔记索引段（页面/笔记 6 个工具已迁出 → qq-ext-page-note） |
| 12 | `ecb7904` | patch-48 补丁 48：防线二（污点标记 + 出站 dry-run） |
| 13 | `47fa919` | patch-51 P51 · 注意力收敛（宿主工具 restrict + order 重排 + 上下文瘦身 + 人设指纹 + rotate 落盘） |
| 14 | `ff3bbce` | patch-52 P52 · qq_face_list 列出全部表情名 |
| 15 | `0ae4bdc` | patch-53 P53 · 面板「能力开关（工具组）」六行 |
| 16 | `fd0262f` | patch-56 补丁56 收藏表情（自动贴图·我的表情同步·标签·mface 降级） |
| 17 | `1ee5a66` | patch-60 P60 · 本地表情素材库（离线表情索引 + 两个工具 + 情绪标签） |
| 18 | `d5d0215` | feat(ext): 四个 provider 扩展包（20 工具）与使用说明 |
| 19 | （本文件修订） | `docs: 分支说明（0.7.10 口径）` |

## 8. 0.7.8 这一版的差异（相对 0.7.7 线 · 历史）

- **上游新增 `taintExtraPatterns`（自定义注入句式）**：正则数组、默认空、内置 8 条优先、保存时预编译。**不写补丁、不动配置** —— 默认空就等于关闭，想用直接在面板「实验性」里填；这条能力对我们纯白拿。
- **上游新增根 `.gitattributes`（`* text=auto eol=lf`，18 行）**：本分支的同名文件（`* -text`）**有意覆盖**它。理由是这条分支的字节契约：检出的工作区必须与线上安装树逐字节一致，而 `text=auto` 会把"仓库字节"换成"检出后一致"，一旦有人开 `core.autocrlf=true` 就是全树 diff。所以这里表现为 **+1 / −18**，不是"多了一个文件"。
  - **产物矩阵（2026-10-28 上游亲口澄清）**：`npm pack`（148 文件）**不含** `.gitattributes`（他的 `files` 白名单挡掉）；GitHub **源码 tarball 含**（510 B）。我们铺装用的是后者 ⇒ 安装命令里那条 **`--exclude=.gitattributes` 是必要的**，不是洁癖；漏了它会静默装进线上树，运行时没有任何报错、也没人读它，只会把上面的字节契约弄脏。补丁器的 `check.mjs` 第 8 项已经把「线上树不得存在 `.gitattributes`」做成断言。
  - **他也认同保留 `* -text`**（原话大意）："我保证的是**仓库内容（blob）是 LF**；你的门禁要的是 **fork 检出字节 == 线上树字节**" —— 两套契约并存、互不影响。所以这个覆盖是长期决定，不是临时绕过。
- **上游 `lib/bridge.js` +21/−2 全落在污点判定区**（构造 `this.taintExtra`、`start()` 里对坏句式写 trace、入站改成 `looksLikeInjection(text, this.taintExtra?.matchers ?? [])`），跟我们插桩的位置没有交集：`reanchor` 对 v0.7.8 是 **156 条 / exact 153 / conflict 0**，非 exact 的三条仍是 `patch-56` 的 f03 / f05 / f06（0.7.5 起就有的既存偏差）。**零重锚**。
- **断句文案**：上游把「关掉就退回按字数硬切」改成「关掉后仍按上限切成多条，只是每批不再往回找标点」——只改文案不改行为，我们 28 条断句断言不用动。
- **规模与 0.7.7 完全一致**：18 条补丁 / **156 编辑** / 20 个文件 / +10 693 −1 670。补丁库一条都没动，只是基座从 v0.7.7 换成 v0.7.8。
- 结果：`apply-forward-archive-patch --verify` 在 v0.7.8 上 **0 可应用 / 156 已就位 / 0 阻塞**；`fork-export` 逐条落地 **19 提交**（`.gitattributes` + 18 条补丁），跳过 0、语法体检 0 问题。

<details><summary>历史：0.7.7 那一版收走了我们什么（归档）</summary>

```
- **上游把断句开关收走了**：v0.7.7 自带 `longReplySplitOnPunctuation`（默认 `true`）与 `splitSegments(segments, limit, { punctuation })`。我们把 `patch-03` 里那条自造断句开关的整条编辑（`bridge:h01c`，19 行 to）**整条删掉** —— `patch-03` 从 29 条编辑降到 28 条，全库 157 → **156** 编辑。断句策略交还上游，我们只保留「分条（parts）+ 每批断句」。
- **三处配套清理**：运行快照白名单里的 `'splitLongReplies'` 与它那行注释（`patch-02` `bridge:h09`）、`lib/index.js` 的 `splitLongReplies: z.boolean().default(true)` 与其两行注释（`patch-03` `index:h23c`）一并删除；`grep -rn splitLongReplies lib/ patches/` 现在 0 命中。
- **重锚一条**：`patch-05` `bridge:h04` 的 from 从 39 行涨到 **46 行**（上游在原调用点上方加了 5 行说明注释、调用从两参变三参），to 里 `chunk` 那一行改成读上游的键：`{ punctuation: this.config.longReplySplitOnPunctuation !== false }`，并在上方补一段注释说明「分条归我们、批内断句归上游」。`patch-56` 的 `f05`/`f06` 两条锚点仍逐字落在 `h04` 的 to 里（这是硬约束：改 h04 必须连它们一起验）。
- **switch 语义别读错**：`punctuation: false` **只关「按标点找断点」，不关分批**。实测 5000 字 @ limit 1700 关掉后仍是 3 批（1700 / 1700 / 1600），只是每批硬切在 limit 上。想整条直发只能把 `maxMessageLength` 调大到超过正文。
- 结果：18 条补丁 / **156 编辑** / 20 文件，`--verify` 在 v0.7.7 上 **0 可应用 / 156 已就位 / 0 阻塞**。
```

</details>

## 9. 链接约定（给上游 README 用的）

上游 README 的「第三方扩展（社区）」一段指向 `.../tree/patches/<tag>/ext`。约定是：

1. 每次跟上上游发版，分支名就是 `patches/<上游 tag>`（这一版是 `patches/0.7.8`），父提交就是该 tag 解引用出来的 commit；
2. `ext/` 永远在分支根目录下，四个包的目录名不变（`qq-ext-face` / `qq-ext-house-lite` / `qq-ext-page-note` / `qq-ext-workspace`）；
3. 所以上游每次发版只需要把链接里的 tag 改一下，不用改路径结构；
4. **分支里的提交数会变，链接不会跟着变** —— 逐条提交还是单提交快照取决于当次 `fork-export` 能否逐条干净落地（见 §7 末段），那条分支名和 `ext/` 位置是稳定的契约。

要指就指到 `.../tree/patches/0.7.10/ext` 这个**目录**，别指具体文件 —— 实现文件名会变。

## 9. v4（2026-10-30）：退役「概率插话」+ 面板「本地补丁」12 行（历史）

这一轮不跟随上游换版，是补丁库自己的整理（用户拍板「载体 = 改 patch JSON」）：

- **退役 PATCH 15「概率插话」**：它从来不是独立补丁，而是散在 9 条大块编辑里（337 行 `to` 中约 115 行是它）。这次按行号逐条裁 `to`，共 **−133 行**；裁完即空的两条编辑（`patch-03 bridge:h05`、`patch-04 bridge:h11#11`）整条删掉 ⇒ 编辑数 156 → 154，补丁数不变。运行时文件 `qq-chatter.json` 改名 `.retired`；profile 的 `cordis.patch.yml` 同批删掉 8 个 `chatter*` 键（顺序必须先删 yml、后换代码：schema 少了键而 yml 还带着 = 冷启动整条 entry 加载失败）。
- **新增 PATCH 57「面板本地补丁组」**：12 个原先只能在 yml 里改的布尔开关（收藏表情 / 裸 @ / @ 名字 / 看一眼就收 / 群图商城表情 / 私聊搜图 / 长回复合并转发 / 自动收藏表情 / 只认点名贴表情 / 表情榜单 / 宿主工具白名单 / 外部内容防线）进了设置面板，单独一组 `id: localpatch`。顺带纠正三处过期文案与数字（sim 行提到「概率插话」、注释里的 schema 键数与面板登记数、文件头的 224 键）。
- **引擎补一小块**：`apply-forward-archive-patch.mjs` 的 `statusChecks` 原来只支持 `has`（"必须存在"），删除型补丁没法表达"必须不存在"；新增 `absent` 并抽出 `statusCheckHit()`，让两处判定共用同一口径。
- **规模**：**20 条补丁 / 159 条编辑 / 20 个源文件**，`+10588 / −1679`（`.gitattributes` 另 +1 / −18）；`--verify` = 0 可应用 / 159 已就位 / 0 阻塞；本分支 `v0.7.8..HEAD` = **23** 提交。

## 10. PATCH 58b（2026-10-30）：素材表情库接入（离线 322 张）（历史 —— 0.7.9 起收进 `patch-60`）

收藏库只有 QQ「我的表情」那几十张、还要联网取 URL；这一轮把第三方插件 `dsh-nekowhale-stickers`
的**本地镜像**接进出站表情，作为第二个表情来源。

- **新文件 `lib/sticker-index.js`**：`StickerIndex` 把 `kit.stickers`（含 `emotion` / `tags` / `use` 的 322 条）
  建成索引，只收本地确实落盘、且 ≤ 4 MiB 的（仓库里 4 张 5.19/4.91/4.17/5.58 MB 的 GIF 会被跳过 ⇒ 实际 318 张）。
  `MOOD_TO_STICKER_EMOTIONS` 把本体情绪的 6 键映射到素材库的 24 类中文情绪。
- **`lib/faces.js`**：新增 `setStickerResolver()` 回调位与 `[stk:名字|情绪]` 标记（`expandMarkers` 第 4 个标记类型）。
  素材一律出 `image` 段（QQ 收藏表情缺 `file` key，`mface` 会被内核以 `-13100` 拒），`segmentFor` 拿不到就静默丢弃标记。
- **`lib/bridge.js`**：`attachStickerKit()` / `stickerStats()`；`#faceSegmentFor` 增加「双库掷签」——
  `faceLibraryEnabled` 与 `stickerPackEnabled` 都开时按 `stickerAutoPercent`（0–100）决定这次问哪个库；
  `#pickStickerPack` 两级挑图（正文线索 strict → 本体情绪映射非 strict）。
- **`lib/index.js`**：三个配置键 `faceLibraryEnabled`（默认 false）/ `stickerPackEnabled`（默认 true）/
  `stickerAutoPercent`（默认 50）；`ctx.inject(['stickers'])` 接 kit（插件没装 ⇒ 回调不执行 ⇒ 素材库静默缺席，收藏库照旧）。
- **`lib/panel.js` + `control/ui.html`**：两个库开关 + 占比一行进「表情」组；`qq_sticker_list` / `qq_sticker_send` 补 chip。
- **规模**：fork 第 24 提交；工具 45 → 47（桥内 25 → 27），结构基线随之更新到 defineTool 27 / qqTools 27。
- **踩坑**：① 插件 `DEFAULT_PACKS` 仍写旧包名「大肥鱼」，P1 改名后必须由 `cordis.patch.yml` 显式给
  `packs: ['米白鲸','米白鲸和GPT娘']`，否则 `packs.includes()` 全 false ⇒ 0 张（离线自检就是这么先踩到的）；
  ② `kit` 的 `emotion` 来自 `bundledMeta`（`meta/nekowhale.json`），本地 `manifest.json` 里没有这个字段。

## 11. 0.7.9 这一版的差异
### 11.4 2026-10-30 追加：杂音瘦身批 3（同一条补丁线，未换上游版本）

- `patch-51` 由 2 条编辑扩到 5 条：新增 schema 键 `persistentMemoryLines`（默认 8），
  注入（`lib/bridge.js:7784`）与每日日报（`:9638`）两处硬编码 `.slice(-12)` 改按该键取条数。
- `qq-dynamic` 段从 `order: 119` 挪到 `10301`：原值夹在静态段中间，等于每轮都让 prompt 缓存从断点重启；
  现在排在 `qq-persistent-memory(10300)` 之后。
- 教训（第三次同类）：同一区域的两条编辑不要拆开——上一版把 `E07` 的 to 尾巴与 `E09` 的 from 撞在同一行，
  结果两条互相把对方判成「未应用」，`--verify` 报 1 可应用 + 1 阻塞；合并成一条后 0/191/0。
（相对 0.7.8 线）

- **上游把「能力矩阵」做成了机制**：新增 `lib/capability.js`（硬开关 + 提示级开关、`default` → `g:<群>` → 精确键的层叠）、`lib/redact.js`（出站脱敏）、`docs/COMPAT.md`（兼容性口径）、`test/capability-unit.mjs`。`lib/settings-routes.js` 多 7 行、`lib/onebot.js` 多 37 行（动作账本）、`lib/bridge.js` 多 143 行。这些都在**我们没插桩的区域**，`patch-06` 只有 `onebot:h05` 一条重锚（见下）。
- **新增 `patch-60`：把「素材表情库」从 fork 回填进补丁库**。此前它只存在于 `patches/0.7.8` 的 4 个直接提交（`36877a0`/`ad00a75`/`528e293`/`bd62ced`）与线上树，补丁库 0 条编辑覆盖 `lib/sticker-index.js` —— `fork-export` 只按 `patches/` 重放，换版会把整批改动静默丢掉。现在它是 29 条编辑（含一条**新建文件**编辑），`dependsOn: [2,3,4,54,56]`。
- **引擎加 `edit.create`**：`apply-forward-archive-patch.mjs` 原来遇到「目标文件不存在」直接判 mismatch，新建文件类型的编辑没法表达。现在 `create: true` + `from: ""` 即按 `to` 建文件；`patchOf()` 会把 `create` 原样透传。
- **`patch-06 onebot:h05` 重锚**：上游 `#call` 里新增动作账本（`const settled = new Promise(...)` / `const ledger = this.actionLedger` / `success`·`failure`），我们的审计门与 `options.timeoutMs` 必须叠在它之上；`from` 从 v0.7.8 的 19 行涨到 **36 行**，`to` 190 行（含恢复上游的 `setActionLedger()` 方法 —— 它落在被替换区里，第一版漏了）。
- **`patch-56` 的 statusChecks 换一个 token**：`FACE_EMOTION_HINTS } from './faces.js'` 在素材库接入后变成 `FACE_EMOTION_HINTS, sniffImageExt } from './faces.js'`，改用 `import { FaceLibrary, FACE_EMOTION_HINTS` 这一前缀（前后两个状态都成立）。
- **规模**：**16 条补丁 / 194 条编辑 / 21 个源文件**，`+11 077 / −1 699`（`.gitattributes` 另 +1/−18）；`--verify` = 0 可应用 / **195** 已就位 / 0 阻塞；工具 45 → **47**（桥内 25 → 27），结构基线 defineTool 27 / qqTools 27 / 私有成员 **402**。
- **已知口径**：`tools/reanchor.mjs` 逐条对比 pristine，`patch-60` 的 29 条编辑与 `patch-56` 的 f03/f05/f06 一样是**链式锚点**（`from` 只存在于前序补丁的产物里），因此预演里它们必然显示 conflict/notfound —— 这是判据的边界，不是漂移；真正要看的仍是 `--verify` 的「阻塞 0」。

### 11.5 v3 拟人化（PATCH 61）：把「现在」交给每一轮

- **问题**：模型能拿到时间的三处（`#orientationClock` / `#autoClock` / `stamp()`）都只在**工具被调用时**出现；`qq-core` 里没有一个字说现在几点 ⇒ 日常对话缺「当下感」。
- **做法（4 条编辑）**：新增 `#clockLine()`（本地时区，`YYYY-MM-DD 周X HH:MM · 时段`，23 点后带「可以话少一点」）与 `#msgStamp(ts)`（`MM-DD HH:mm`）；在 `qq-dynamic`（order **10301**）的函数列表**首位**加 `parts.push(() => bridge.#clockLine())`；`#groupContextText` 的普通发言行前缀时间戳；`lib/index.js` 加 `clockLineEnabled`（默认 true）。
- **两个不能踩的坑**：① 时钟绝不能进 `qq-core`（order 139，装配时求值一次就冻结）；② 在 `parts` 里也必须**推函数**而不是推结果——直接 `parts.push(this.#clockLine())` 同样冻结。
- **schema 行的写法**：`quietHoursEnabled` 是「前缀可定位、行尾还挂着 `.description(...)`」的行，新键必须插在它**前面**；插在后面会把原行的尾巴接到新键上，直接把 `lib/index.js` 写成语法错（本轮就撞了一次，已记进 `docs/改动记录.md`）。
- **没做的**：私聊归属行。私聊没有 people 档案、归档里也没有私聊记录（`D:/qq-work/qq-history` 抽样 0 条），名字只能编，不值得——等入站路径能带名片再说。
- **规模**：`patch-61` 3 条编辑（+ patch-49 里的一行时钟前缀），`dependsOn: [4]`；`--verify` 0/194/0；面板键数不变（schema 复用，不新增面板行）。

### 11.5b 2026-10-30 深夜：时钟为什么从「提示段」挪到「正文」

第一版把时钟行推给 `qq-dynamic`（`parts.push(() => bridge.#clockLine())`），按设计是对的——那段每轮装配都求值。但真机上问了两次都没看到时间，查日志才发现真因：

```
session resumed qq-fb68fad4… for g:873246594:u:3518287278
session ready qq-fb68fad4…
```

`#installSession` 只在**会话第一次创建**时跑（`bridge.js:7742` 传 `resumed: true` 的分支里，`entry.agent` 已在内存就直接 `#resumeSession` 早退），而 `#installPromptSections` 是 setup 的一部分。老会话复用的是内存里的 agent，段注册永远补不上 ⇒ 模型那一侧压根没有这一行。

**改法**：把时钟挪到入站正文——`patch-49` 的 `#handoff` 那一行前加 `(this.config.clockLineEnabled !== false ? this.#clockLine() + '\n' : '')`。正文每轮都是新拼的，与会话年龄无关；顺带还有个好处：归档里每条消息自带时间，问「刚才」时不用再翻 `ts`。

**为什么改在 `patch-49` 里而不是新开一条补丁**：那一行是 `patch-49` 的 `to` 产物。后来者去改它，`patch-49` 自己的 `to` 就再也匹配不上已应用状态，`--verify` 会报「锚点已失效」（`patch-08`/`control/ui.html` 那次已经踩过一次）。同理反过来：想动谁的产物，就改谁的 `to`。

**遗留**：`patch-61` 的「推 qq-dynamic」那条已删除（3 条编辑），所以 `qq-dynamic` 里不再有时钟；如果你哪天想让老会话也能拿到段级时间，得给会话加一条「重新 setup」的路径，而不是再往 `parts` 里推一次。

## 12. 2026-10-31 合并同类项（22 条 → 16 条，编辑数不变）

四组合并（引擎按 `patch-NN.json` 的数字序发现补丁，只能吸收到编号最小者）：

| 吸收方 | 被吸收 | 编辑 |
| --- | --- | --- |
| `patch-44` | 49 | 1 → 2 |
| `patch-51` | 61 | 5 → 8 |
| `patch-52` | 54 | 1 → 2 |
| `patch-53` | 55 / 57 / 59 | 1 → 7 |

- **只搬 `edits`，内容逐字未改**；`statusChecks` 按文件合并（`has`/`absent` 去重并集）；`expect`/`uniqueAfter` 只在 marker 文件相同时合并（`52←54` 的 token 长在 `lib/index.js`，由 statusChecks 覆盖，故不并）。
- 依赖声明同步：`p60` 的 `[2,3,4,54,56]` → `[2,3,4,52,56]`；`chain-report` 复检「依赖声明与实际锚点一致」。
- 被吸收的 6 个 JSON 退役到 `patches-retired/merged-v1-20261031/`（引擎不读）。
- **判据**：pristine 上全量重打后与线上树 `diff -rq` **逐字节 0 差异**；`reanchor` 与合并前逐字段相同（161 exact / 9 conflict / 16 notfound / 4 weak）；`check.mjs` 19/0；`--verify` 0/194/0。
- 同轮整理补丁器：新 `kit/`（`paths.mjs` + `patch-io.mjs`，6 个消费者接上，`apply` 与 `fork-export` 故意不动）、`tools/tables/`（10 个表 CLI，旧路径留 shim）、`tools/tests/`（28 个行为测试）、`work/` 一次性脚本 186 个进 `work/archive/`。

## 13. 0.7.10 这一版的差异（相对 0.7.9 线）

上游这一版是**收尾型**更新，没有动我们压着锚点的地方：

| 上游做了什么 | 对我们的影响 |
| --- | --- |
| `test/inject-guard-unit.mjs` 的 7 处数组全等改成 `followupEndsWith()`（`.some(e => e.endsWith(text))`）+ 3 条回归断言 | 我们那条「整段崩」白名单**撤掉**了：这套在打满 194 条编辑的树上 43/0 |
| `test/privacy-unit.mjs` 对 `.gitignore` 改成「git 检出缺 → 红 / 非 git 副本缺 → 跳过」；`test/redact-unit.mjs` 的假密钥改成运行期拼接 | `privacy-unit` 从「已知差异」降级成**固定哨兵** `{ expect: 0, kind: 'fixed' }` |
| 新增 `/能力体检`（21 个只读探针 + `assertProbeSafety()` 拒跑写操作）+ `lib/onebot.js` 的 `callRaw`（纯新增，仍走 `#call`）+ `lib/conformance.js` / `test/conformance-unit.mjs` | **一行补丁都不用加**，白拿；`callRaw` 没碰 `#call`，`patch-06` 的 5 条编辑零改动（`reanchor` 非 exact 集合与 0.7.9 逐条相同） |
| `lib/index.js` 未改 | 我们插在 schema 里的 `clockLineEnabled` 零风险 |

我们的动作只有三件：补丁库**没有一条编辑改动**（16 条 / 194 编辑不变）、两条白名单调整、上游基座换成 `v0.7.10`。

一条留给以后的约束（写在这里防止忘）：`followupEndsWith()` 只容忍**前缀**，所以入站正文末尾不能再追加东西 —— 我们的正文是 `clockLine + '\n' + effectiveText + p49ImageNote`，`p49ImageNote` 非空时那套测试仍然会红。

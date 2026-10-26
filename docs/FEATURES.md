# 功能细节（v0.5「看得见 · 找得回」）

> 从 README 搬出来（README 太长了）。这里只讲**已经能用的能力怎么用、坑在哪**；只想让它跑起来，看 [README](../README.md)。

v0.5 做两件事：把**已经封装好、却从没接上线**的能力接通，再补上"群里的东西能找回来"。

### 合并转发展开（先修一个违反硬约束的洞）

以前别人把「聊天记录」合并转发给机器人时，`parseMessage` 里根本没有 `forward` 分支，这条消息在传输层就被静默丢掉——**连 trace 都没有**，直接违反 v0.4 的第一条硬约束。现在：

- `forwards` 会被识别，经 `get_forward_msg` 展开成 `[转发聊天记录] 昵称: 内容` 交给模型（默认最多 50 条 / 4000 字，只展开一层，不递归）
- 群里仍然要 @ 机器人才处理（空文本不再绕过 @ 门与 `acceptPrivate` 门——这两个门都补上了）
- `forwardExpandEnabled: false` 可关闭；回放/注入模式（dry-run）不访问 QQ，注入时可用 `forwardText` 直接喂一份正文

### 接通的既有能力

| 能力 | 用法 |
|---|---|
| 群成员 | `/成员` 看名单（按身份/等级排序，标注头衔与禁言中）· `/成员 @某人` / `/成员 昵称` / `/成员 QQ号` 看详情（身份/等级/头衔/入群时间/最后发言/禁言状态）；agent 工具 `qq_member_info` |
| 群资料 | `/群信息`（群名/群号/人数与上限/群主/建群时间） |
| 好友列表 | `/好友`（**隐私项，默认关闭** `friendListEnabled`，且仅私聊里的管理员可用） |
| 群历史 | agent 工具 `qq_recent_history`（拉本会话最近 N 条，群聊/私聊都支持） |
| 表情回应 | agent 工具 `qq_react`（给消息贴 👍 之类，而不是发一条消息；写操作，过闸门） |
| 退群 | `/退群 确认`（**默认关闭** `leaveGroupEnabled`，必须显式二次确认，走闸门） |

### 群资产（只读为主）

| 命令 | 说明 |
|---|---|
| `/文件` | 列群文件与文件夹（文件名/大小/上传者/时间） |
| `/文件 <文件夹名>` | 进文件夹列文件 |
| `/取 <文件名>` | 下载群文件到 `cwd/qq-files/` 并**只发到发起人私聊**（不往群里丢文件）；精确/前缀/模糊匹配，文件名消毒（去路径、去 Windows 非法字符、保留名加前缀） |
| `/相册` | 列群相册（NapCat `get_qun_album_list`） |
| `/ocr` | 引用一张图片发 `/ocr`，用 NapCat 的 `ocr_image` 读出图里的文字（不消耗模型） |

### 历史检索与归档

- 每条白名单会话的真实消息按天归档到 `cwd/qq-history/YYYY-MM-DD.jsonl`；**注入/回放的假事件不入档**，`/` 开头的命令也不入档（否则每次 `/找 X` 都会命中自己刚敲的查询词）
- `/找 关键词`（空格分隔 = 同时包含，大小写不敏感）检索本会话最近 N 天；agent 工具 `qq_search_history` 同源同口径
- 保留期默认 90 天，过期分片在宿主启动时**移入** `qq-trash/<日期>/` 而不是删除
- 控制台新增「群资产 · 历史检索」卡片：看归档体积与时间范围、直接检索（与群内 `/找` 复用同一套解析）

新增配置（括号内为默认值）：`forwardExpandEnabled`(true) `forwardMaxNodes`(50) `forwardMaxChars`(4000) `memberQueryEnabled`(true) `memberListLimit`(20) `friendListEnabled`(false) `historyQueryEnabled`(true) `historyQueryLimit`(20) `reactToolEnabled`(true) `leaveGroupEnabled`(false) `ocrEnabled`(true) `ocrMaxImages`(3) `groupFileEnabled`(true) `groupFileDownloadEnabled`(true) `groupFileListLimit`(20) `groupFileMaxBytes`(50 MiB) `albumEnabled`(true) `historyArchiveEnabled`(true) `historyArchiveDir`("") `historyArchiveKeepDays`(90) `historySearchEnabled`(true) `historySearchDays`(7) `historySearchLimit`(20)。

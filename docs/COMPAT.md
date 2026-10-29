# 换 OneBot 实现会怎样（能力矩阵）

本插件走 **OneBot v11 反向 WebSocket**，不绑定某一家实现。但"标准动作"和"实现扩展动作"是两回事 ——
这里把 71 个 action 分层列清楚，换实现（NapCat → LLOneBot / Lagrange / go-cqhttp / 自建）时照着看即可。

> 运行时不用背这张表：连上后插件会调一次 `get_version_info` 认实现，并把**失败过的动作**记进账本 ——
> 在 QQ 里发 `/health`，或看面板「高级与调试」组的状态行，就能看到"当前实现是谁、哪些功能失败过、最可能为什么"。

## 三层分级

| 层 | 含义 | 换实现会怎样 | 数量 |
|---|---|---|---|
| **standard** | OneBot v11 标准动作 | 合规实现都该有；**这类失败更像连接/权限/协议问题** | 32 |
| **extension** | 实现扩展（各家命名/支持不同） | 大概率缺失 → 对应功能报错、记 trace、回一句人话 | 31 |
| **napcat** | NapCat 专属 | 换实现基本必然缺 | 4 |

## 换实现后**一定还在**的（standard）

收发消息（文本/图片/文件/@/引用）、撤回、群成员与群信息、禁言 / 踢人 / 全员禁言 / 名片 / 群名 / 头衔 / 设管理、
群文件（列目录、下载、上传、删除、建文件夹）、群公告（`_get_group_notice` / `_send_group_notice`）、
精华消息、群荣誉、点赞（`send_like`）、好友申请 / 群申请处理、`get_status` / `get_version_info`。

→ 日常 80% 的体验在这些里。

## 可能缺失的（extension）

| 功能 | 依赖 action |
|---|---|
| 表情回应（贴表情 / 谁赞了） | `set_msg_emoji_like` / `get_emoji_likes` |
| 历史消息 | `get_group_msg_history` / `get_friend_msg_history` |
| 合并转发 | `send_group_forward_msg` / `send_private_forward_msg` |
| 图片 OCR | `ocr_image` |
| **语音下载 / 转码**（最容易坏） | `get_record`（各实现 `out_format` 支持差异最大） |
| 已读标记、「正在输入」 | `mark_*_msg_as_read` / `set_input_status` |
| 戳一戳 | `group_poke` / `friend_poke` |
| 群信息扩展、@全体余量、群系统消息、被忽略通知、禁言名单 | `get_group_info_ex` / `get_group_at_all_remain` / `get_group_system_msg` / `get_group_ignored_notifies` / `get_group_shut_list` |
| 群策略（加群方式 / 邀请策略 / 成员权限 / 新成员可见历史 / 群头像 / 群备注） | `set_group_add_option` / `set_group_member_invite_policy` / `set_group_member_permissions` / `set_group_new_member_history_visibility` / `set_group_portrait` / `set_group_remark` |
| 批量踢人 | `set_group_kick_members` |
| 群文件移动 / 重命名 | `move_group_file` / `rename_group_file` |
| 可疑好友申请 | `get_doubt_friends_add_request` / `set_doubt_friends_add_request` |

## 换实现后**基本没有**的（NapCat 专属）

| 功能 | 依赖 action |
|---|---|
| 群相册 | `get_qun_album_list` / `upload_image_to_qun_album` |
| 群打卡 | `set_group_sign` / `get_group_signed_list` |

## 换实现检查清单

1. 连上后发 `/health`，看第一行 **OneBot 实现**是不是新实现的名字；
2. 看 **动作调用** 那行：失败数 0 = 没事；有失败会点名"哪个功能、最可能为什么"；
3. 失败的是 `extension`/`napcat` → 关掉对应功能开关即可，不影响其它；
4. 失败的是 `standard` → 先查：协议版本（要 v11）、`accessToken`、反向 WS 地址、实现自己的日志；
5. 面板「高级与调试」组的状态行与控制台事件流里有同样的信息（`stage: capability`）。

## 为什么不"主动探针"

那种"挨个 action 试一遍"的做法看着聪明，实际不可行：71 个 action 里有一半会**真的改变 QQ 状态**
（禁言、踢人、设精华、发通知…），探针等于拿真实群试错。所以这里只做两件安全的事：

- **读**：`get_version_info` / `get_status`（纯查询）；
- **记账**：每次真实调用成功/失败都记一笔（不记参数，避免把消息内容带进统计）。

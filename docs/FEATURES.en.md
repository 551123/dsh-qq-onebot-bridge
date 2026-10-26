# Feature details (v0.5 "See it, find it")

> Moved out of the README (which got too long). This page covers **how the shipped capabilities work and where the edges are**; to get it running, see the [README](../README.en.md).

v0.5 does two things: it wires up capabilities that were **already implemented but never called**, and it makes "what the group already said" findable again.

### Merged-forward expansion (fixing a hard-constraint violation first)

Until v0.5 a merged-forward ("chat record") card was dropped **inside the transport layer**: `parseMessage` had no `forward` branch, so a message containing only a card was silently discarded — with no `message` event and not even a trace line, violating v0.4's first hard constraint. Now:

- `forwards` is recognised and expanded via `get_forward_msg` into `[转发聊天记录] nickname: content` for the model (default max 50 nodes / 4000 chars, one level only, never recursive)
- Groups still require an @-mention, and the empty-text path now goes through both the @ gate and the `acceptPrivate` gate (it used to bypass them)
- `forwardExpandEnabled: false` turns it off; replay/injection (dry-run) never touches QQ, and an injection may carry `forwardText` to feed a transcript directly

### Capabilities that are now actually wired up

| Capability | How to use it |
|---|---|
| Group members | `/成员` lists the roster (owner → admins → members, level desc, titles and mutes marked) · `/成员 @someone` / `/成员 nickname` / `/成员 <qq>` shows one member's card, level, title, join date, last message and mute state; agent tool `qq_member_info` |
| Group info | `/群信息` (name, id, member count and cap, owner, creation time) |
| Friend list | `/好友` (**off by default** via `friendListEnabled`; private chats from an admin only) |
| Chat history | agent tool `qq_recent_history` (last N messages of this chat, groups and private chats) |
| Emoji reaction | agent tool `qq_react` (reacts to a message instead of sending one; a write action, gated) |
| Leaving a group | `/退群 确认` (**off by default** via `leaveGroupEnabled`, explicit second confirmation, gated) |

### Group assets (read-only by default)

| Command | What it does |
|---|---|
| `/文件` | Lists group files and folders (name / size / uploader / time) |
| `/文件 <folder>` | Lists the files inside one folder |
| `/取 <name>` | Downloads a group file into `cwd/qq-files/` and delivers it **to the requester's private chat only** (never posted into the group); exact → prefix → fuzzy matching, with the file name sanitised (path stripped, Windows-illegal characters removed, reserved names prefixed) |
| `/相册` | Lists the group albums (NapCat `get_qun_album_list`) |
| `/ocr` | Quote an image and send `/ocr` to read its text with NapCat's `ocr_image` (no model call) |

### History archive & search

- Every real allowlisted message is archived per day into `cwd/qq-history/YYYY-MM-DD.jsonl`; **injected/replayed frames are never archived**, and `/`-commands are skipped too (otherwise every `/找 X` would hit the query line it just wrote)
- `/找 <keywords>` (space-separated = all must match, case-insensitive) searches this chat's last N days; the `qq_search_history` agent tool shares the same index and semantics
- Retention defaults to 90 days; expired day files are **moved** into `qq-trash/<date>/` on host start, never deleted
- The console gained an "assets · history search" card (archive size and date range, plus keyword search reusing the plugin's own parser)

New config keys (defaults in brackets): `forwardExpandEnabled`(true) `forwardMaxNodes`(50) `forwardMaxChars`(4000) `memberQueryEnabled`(true) `memberListLimit`(20) `friendListEnabled`(false) `historyQueryEnabled`(true) `historyQueryLimit`(20) `reactToolEnabled`(true) `leaveGroupEnabled`(false) `ocrEnabled`(true) `ocrMaxImages`(3) `groupFileEnabled`(true) `groupFileDownloadEnabled`(true) `groupFileListLimit`(20) `groupFileMaxBytes`(50 MiB) `albumEnabled`(true) `historyArchiveEnabled`(true) `historyArchiveDir`("") `historyArchiveKeepDays`(90) `historySearchEnabled`(true) `historySearchDays`(7) `historySearchLimit`(20).

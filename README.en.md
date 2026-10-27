# dsh-qq-onebot-bridge

A bidirectional QQ ↔ DeepSeek Harness bridge plugin (independent bundle). QQ messages drive DSH agent sessions directly, and agent replies are sent back to QQ automatically.

## Architecture

```
QQ client ←→ OneBot implementation (NapCat / LLOneBot / OpenShamrock / Lagrange…)
                │ reverse WebSocket (the OneBot side connects to us)
                ▼
      dsh-qq-onebot-bridge (this plugin)
                │ ctx.agents.create / followup
                ▼
      DSH agent sessions (one per group / per private user)
```

## Install / uninstall

```sh

# install (local directory): install the runtime dependency inside the directory first,

# then register the plugin — a local directory is linked with pnpm's `link:`, which does

# not install the linked package's own dependencies (`ws`)

cd <this-directory> && npm install --omit=dev
dsh plugin --profile web add <this-directory>

# uninstall anytime (independent bundle, does not affect other plugins)

dsh plugin --profile web remove dsh-qq-onebot-bridge
```

Restart `dsh web` after install/uninstall.

> Official dependencies (`@deepseek-ai/dsh-*`, `@deepseek-ai/schemastery`) are declared as `peerDependencies` and installed by DSH together with the profile; they do not need to be installed inside the plugin directory.

### Official desktop client (DSH Desktop)

The official desktop client (the Electron `DeepSeek Harness.exe`) boots the `~/.dsh/profiles/desktop` profile, which is **managed exclusively by the application** (the CLI refuses `dsh --profile desktop`). It runs **the same DSH runtime version as the CLI**, so since v0.5.9 this plugin declares peer ranges covering both `^0.1.x` and `^0.2.0-rc.2`: either side installs it directly, with **no `dsh plugin allow-version` exemption needed**.

Installation is the same, through the desktop client's plugin manager:

1. Desktop client → Settings → Plugins → install, and pick the **local directory** (the directory this plugin lives in — the same path you gave `dsh plugin --profile web add`), or the GitHub repository URL;
2. configuration goes into `~/.dsh/profiles/desktop/cordis.patch.yml` (the `id: dsh-qq-onebot-bridge` config) — never into the repository;
3. restart the desktop client.

> When installing a local directory by hand (outside the marketplace), note that the dependency alone is not enough: **`dsh-qq-onebot-bridge` must also be listed in that profile's `package.json` under `dsh.profile.bundles`**, otherwise the loader never mounts it — it shows up as an installed dependency but does nothing (measured on this machine). A marketplace install does this for you.

> ⚠️ **Only one instance per machine may host the QQ bridge**: the web host and the desktop client can both install this plugin, but they compete for the same OneBot port (6700 by default) and only one can bind it — the other reports the true reason and **retries every 15 seconds**, taking over automatically once the port is free (since v0.5.9 it neither crashes nor blocks host startup). **Do not "just give the other profile a different port" to run both**: they share one `cwd` (`qq-sessions.json`, `qq-memory/`, `qq-reminders.json`, points and stats all live there), two instances writing it will clobber each other, and with `injectDryRun:false` queued injections would really be sent twice. To pin one host, **enable the plugin in only one profile** (remove it from the other's `dsh.profile.bundles`), or give it a different `cwd` as well.

## Toggling features from DSH Settings (v0.6 "QQ助手")

After installing the plugin and **restarting the host once** (so the panel routes mount): **DSH → Settings → QQ助手**.

- **Six everyday groups are laid out directly**: **AI account & allowlists** / chat basics / **limits: inbound / outbound** / **quiet hours** / group-ops toolbox / fun & interaction / voice & media; safety, record & notify, experimental and advanced start collapsed under "advanced". 11 groups, **65 switches + 11 numeric fields + 1 time-range list + 2 allowlists**, curated from 225 config keys; a **search box** at the top filters by Chinese label / config key.
  - The two rate limits share one group, ordered the way the pipeline runs, precisely so they are not confused: **per-minute inbound turn cap** (drops the message *before* it reaches the model, saving quota) versus **outbound reply rate limit** (the model already answered; the reply is dropped *before it is sent*, protecting against QQ-side throttling). Both are **off by default** and can be enabled independently.
  - **Quiet hours (v0.6.8)**: the feature existed but could only be reached by editing YAML; the whole thing is now in the panel — the switch, **weekend exemption**, and the **quiet-window list** (two native time inputs per window, overnight ranges such as `22:00-6:00`, up to 8 windows).
  - **AI account & allowlists (v0.6.8)**: this group answers "which bot account is this, and who does it answer" — the **AI account** (`botQq`, used for @-detection and pokes), **no allowlist (answer everyone)**, the two gate switches, and the `allowUsers` / `allowGroups` lists (**an empty list denies everything**). Turning "no allowlist" on makes the bot answer **every private chat and every group**, while **the @ requirement in groups stays** (that is `replyOnlyWhenMentioned`). The lists used to be YAML-only; they are edited in the panel now (input plus an add button, numbers written as **numbers** because string ids would never match), with a one-click "recent chats" shortcut, and both list rows are marked as inactive while "no allowlist" is on.
- **Numeric fields (v0.6.7)**: the risk-control thresholds no longer require editing YAML by hand — **per-minute turn value** (switch **off by default**, value 1–10 default 5), the outbound reply cap and its window, the dedup window, the four anti-flood thresholds, the poke-per-hour cap and the report window are edited in the panel with `− value +`. **Ranges and steps are read from the schema** (never copied into the panel), and out-of-range or fractional values are rejected with a 400 that names the allowed range.
- **Every row is explicit**: Chinese label, one line on what turning it off does, and the **config key name** (so you can find the same key in the file), with a toggle on the right and `非默认` / `更新中` badges when the value differs from the schema default or from what the running plugin currently uses.
- **One click writes it**: only this plugin's own config block inside the profile's `cordis.patch.yml` (other entries and comments are preserved), keys outside the whitelist or non-boolean values are rejected, and the write is a **temp-file-then-rename atomic replace** with a `.bak-qqai` backup.
- **How it applies**: DSH hot-reloads that plugin entry (the QQ bridge reconnects for a second or two); if hot reload is off, restart the host.
- **Hosts without a web server** (e.g. the TUI profile) simply have no such page — the `ctx.inject(['webServer'])` block never runs there and the plugin works as usual.
- **The bottom of the page links the changelog and the debug entry points**: `更新日志（v0.6.0）` (the GitHub `CHANGELOG.md`), `调试文档` (the README debugging section) and `调试台（独立控制台）`. The addresses are derived from `package.json` / `qq-control.json`.
  - **The console is a separate process and the plugin never starts it for you**: the panel probes `127.0.0.1:8799` and says `运行中` or `未启动` truthfully; when it is down, that row prints the exact command to start it.
  - The 调试台 link goes through the host's `/qqai/console`: when the console is up it 302s to the **tokenized** address (no manual token copying), and when it is down it returns a page telling you which command to run — no more "clicked it and it just would not connect". The token is read server-side only and never appears in the panel payload.

> Need a key that is not on the panel? Edit the profile's `cordis.patch.yml` directly (the panel header shows which file that is). The panel deliberately exposes only the everyday switches instead of being a general config editor.

## Configuration

Override `id: dsh-qq-onebot-bridge` config in the profile's `cordis.patch.yml` (full example in `examples/cordis.patch.example.yml`):

> ⚠️ **Do not edit the wrong file**: the repository root also has a `cordis.patch.yml` of the same name, but that one is the **bundle patch used for installation** (four lines, just `insert: - id: …`) — never put configuration in it. Edit the one inside your **profile** instead (e.g. `~/.dsh/profiles/web/cordis.patch.yml`). It lives outside the repository, so **keys written there never reach git**.

| Key | Default | Description |
|---|---|---|
| `host` | `127.0.0.1` | Reverse-WS listen host |
| `port` | `6700` | Reverse-WS listen port |
| `accessToken` | `''` | Bearer token the OneBot client must present (empty = no check) |
| `allowUsers` | `[]` | Private-chat user allowlist (**empty = deny all private chats**; list your own QQ id) |
| `allowGroups` | `[]` | Group allowlist (**empty = deny all group messages**; list the groups the bot serves) |
| `botQq` | `0` | Bot QQ id used for @-mention detection in groups (0 = treat every group message as mentioned) |
| `replyOnlyWhenMentioned` | `true` | In groups, only respond when the bot is @-mentioned |
| `acceptPrivate` | `true` | Whether to respond to private chats (private chats still require allowUsers allowlisting) |
| `autoCollectStickers` | `false` | Auto-save image stickers from messages into the local library |
| `faceEnabled` | `true` | Master switch for emoji features ([face:] markers and qq_face_* tools) |
| `sessionMode` | `chat` | Group session mapping: `chat` = one session per group, `user` = one per sender |
| `cwd` | `''` | Working directory (also determines `qq-faces/`, `qq-images/`, `qq-replies/`, and the debug log location) |
| `provider` | `''` | LLM provider override (empty = agent default) |
| `model` | `''` | LLM model override (empty = agent default) |
| `maxMessageLength` | `1700` | Max chars per outbound QQ message before chunking |
| `botName` | `小鲸鱼` | Bot display name used in merged-forward cards |
| `sessionResumeEnabled` | `true` | Resume the chat's previous session after a host restart (full transcript); `false` = always start a new session |
| `agentMediaToolsEnabled` | `true` | Expose the `qq_send_image` / `qq_send_file` / `qq_send_voice` / `qq_recall` tools |
| `fileSendDirs` | `[]` | Extra directories the agent may send files from (the session cwd is always allowed) |
| `fileSendMaxBytes` | `52428800` | Max size of a file the agent may send (bytes, default 50 MiB) |
| `imageSendMaxBytes` | `4194304` | Images larger than this (default 4 MiB) are compressed with ffmpeg before sending |
| `recallWindowSeconds` | `110` | How long an outbound message stays withdrawable via `qq_recall` / `/撤回` |
| `forwardLongReplies` | `false` | Deliver long group replies as a merged-forward card |
| `forwardThresholdChars` | `600` | Character count from which a group reply becomes a merged-forward card |
| `actionRatePerMinute` | `20` | Write-action gate: max OneBot write actions per minute across all chats |
| `actionRatePerDay` | `500` | Write-action gate: max OneBot write actions per day across all chats |
| `actionAuditEnabled` | `true` | Append every write action and denial to `cwd/qq-actions.log` |
| `keywordEnabled` | `false` | Keyword wordbook (default OFF): matching messages are answered from a local JSON file without calling the model or requiring an @-mention |
| `keywordFile` | `''` | Wordbook path (empty = `cwd/qq-keywords.json`); exact/contains/regex triggers, random reply pools, images, scopes and cooldowns |
| `fortuneEnabled` | `true` | Local fortune features: 今日人品/运势, 抽签, 塔罗 (deterministic per QQ id + day) |
| `diceEnabled` | `true` | Dice (`.r 3d6`) and random picks (`/抽一个 A B C`) |
| `pointsEnabled` | `false` | Points economy (default OFF): `/积分`, `/排行榜`, `/转账 @user amount` |
| `pointsPerMessage` | `1` | Points earned per chat message (0 = chatting earns nothing) |
| `pointsDailyCap` | `20` | Max points a member can earn from chatting per day |
| `pointsCheckinBonus` | `5` | Extra points for the daily check-in |
| `gameEnabled` | `false` | Chat mini-games (default OFF): idiom chain and guess-the-number |
| `idiomChainTimeoutSeconds` | `120` | Idle timeout of an idiom-chain round |
| `guessNumberMax` | `100` | Upper bound of guess-the-number |
| `guessNumberMaxTries` | `10` | Allowed guesses in guess-the-number |
| `antiRecallEnabled` | `false` | Anti-recall (default OFF): cached messages are reposted when withdrawn |
| `antiRecallInGroup` | `true` | Post into the group (`false` = private message to the first admin) |
| `antiRecallImages` | `true` | Re-send withdrawn images (up to 3) |
| `antiRecallCacheSize` | `50` | Messages cached per chat |
| `antiRecallMaxAgeMinutes` | `120` | How long a cached message stays recoverable |
| `antiRecallCooldownSeconds` | `5` | Min seconds between two anti-recall posts in one chat |
| `filterEnabled` | `false` | Sensitive-word filter (default OFF) |
| `filterWordsFile` | `''` | Word list path (empty = `cwd/qq-badwords.txt`; `#` comments, `re:` regex, hot reload) |
| `filterAction` | `warn` | Reaction: `warn` / `recall` / `mute` |
| `filterMuteSeconds` | `300` | Mute duration for `mute` and flood escalation |
| `filterWhitelist` | `[]` | Always-allowed words/patterns |
| `floodEnabled` | `false` | Anti-flood (default OFF) |
| `floodWindowSeconds` | `10` | Flood detection window |
| `floodMaxMessages` | `8` | Messages allowed per window |
| `floodMuteSeconds` | `300` | Mute duration when the flood guard escalates |
| `floodStrikeLimit` | `3` | Warnings before a flood mute |
| `chatTurnLimitEnabled` | `false` | **Master switch for the per-minute turn cap** (**OFF by default**): nothing is limited while it is off |
| `chatTurnsPerMinute` | `5` | **Per-minute turn cap value** (1–10, default 5): how many messages per chat may reach the model per minute. Anything beyond that is dropped with a trace reason (never queued). Different from `rateLimitMaxReplies`, which caps how many replies go **out**. Edited in the panel under 安全与风控 with `− value +` |
| `verifyEnabled` | `false` | Join/friend verification (default OFF): requests are queued and pushed to admins |
| `verifyKeyword` | `''` | Passphrase that auto-approves a request (empty = always human approval) |
| `verifyTimeoutSeconds` | `300` | Request expiry before it leaves the queue and admins are reminded |
| `verifyMaxPending` | `20` | Max queued requests |
| `statsEnabled` | `false` | Message statistics (default OFF): `/统计` today, `/周榜` this week; also feeds the daily report |
| `statsKeepDays` | `30` | Days of per-member counts kept |
| `groupReadEnabled` | `true` | Read-only group queries: `/荣誉` `/公告` `/群精华` |
| `mcStatusEnabled` | `true` | `/mc <host[:port]>` Minecraft Java status via Server List Ping (no key) |
| `mcStatusTimeoutMs` | `5000` | Minecraft status ping timeout |
| `recurringReminderEnabled` | `true` | Recurring reminders ("每天8点", "每周一9点", "每个工作日15点") |
| `dailyReportEnabled` | `false` | Daily group report (default OFF): the agent summarizes the day at `dailyReportTime` |
| `dailyReportTime` | `22:00` | Local time (HH:mm) of the daily report |
| `dailyReportChats` | `[]` | Chats that always receive the report (e.g. `["g:100000001"]`; empty = chats that ran `/日报 on`, then all allowlisted groups) |
| `sttEnabled` | `false` | Speech-to-text master switch |
| `sttBaseUrl` | `https://open.bigmodel.cn/api/paas/v4` | STT endpoint (OpenAI-compatible `/audio/transcriptions`) |
| `sttModel` | `glm-asr-2512` | STT model (Zhipu `glm-asr-2512` / SiliconFlow `FunAudioLLM/SenseVoiceSmall`) |
| `sttApiKey` | `''` | STT API key (can reuse a Zhipu GLM key) |
| `privateImageView` | `true` | In private chats, proactively download and view images/animated stickers the user sends (saved to `cwd/qq-images/`, viewed with describe_image) |
| `visionMode` | `tool` | Image viewing mode: `tool` = save to disk and view via `visionToolName` (stable); `native` = attach images as native multimodal attachments (DSH 0.1.1+, text-only models degrade automatically) |
| `visionToolName` | `describe_image` | Vision tool used in `tool` mode |
| `imageTrashEnabled` | `true` | **Deletion policy: recycle, never destroy** — expired downloads are MOVED to `cwd/qq-trash/<date>/` (a failed move keeps the original file) |
| `imageTrashDir` | `''` | Trash directory (empty = `cwd/qq-trash`); never auto-pruned, clean it up yourself when convenient |
| `memoryEnabled` | `true` | Per-chat persistent memory (recent conversation saved to `cwd/qq-memory/`, restored after host restarts; `/new` clears it) |
| `memoryMaxEntries` | `30` | Max conversation lines kept per chat |
| `rateLimitEnabled` | `false` | Outbound reply rate limiting (off by default); when on, each chat gets at most `rateLimitMaxReplies` replies per window |
| `rateLimitMaxReplies` | `10` | Max replies per chat per window |
| `rateLimitWindowSeconds` | `60` | Rate limit sliding window (seconds) |
| `dedupEnabled` | `true` | Ignore duplicate inbound message ids within the window (reconnect re-delivery) |
| `dedupWindowSeconds` | `300` | Dedup window (seconds) |
| `reminderEnabled` | `true` | Scheduled reminders (groups require @-mention; private chats work directly; persisted in `cwd/qq-reminders.json` across restarts) |
| `reminderMaxPerChat` | `10` | Max pending reminders per chat |
| `quietHoursEnabled` | `false` | Avoid-peak-hours switch (**off by default**); while on, the bot replies to no inbound message during the quiet windows on weekdays (no model calls consumed); scheduled reminders and vote publishing still fire |
| `quietHours` | `['9:00-12:00', '14:00-18:00']` | Quiet windows as local-time `H:MM-H:MM` ranges (full-width colons are normalized; overnight ranges like `22:00-2:00` work) |
| `quietWeekendExempt` | `true` | Saturdays and Sundays are not subject to quiet hours |
| `ttsEnabled` | `false` | Voice-reply master switch (off by default; when on, a voice message follows each text reply) |
| `ttsProvider` | `azure` | Synthesis backend: `azure` (Microsoft Xiaoxiao) / `openai` (any OpenAI-compatible `/audio/speech`) / `local` (**local GPT-SoVITS voice cloning, zero API cost**) |
| `ttsApiKey` | `''` | Azure / OpenAI-compatible API key (not needed for `local`) |
| `ttsVoice` | `zh-CN-XiaoxiaoNeural` | Cloud voice id |
| `ttsStyle` | `chat` | Azure speaking style (cheerful/sad…) |
| `ttsMaxChars` | `120` | Max chars spoken per voice reply (truncation affects voice only) |
| `ttsLocalUrl` | `http://127.0.0.1:9880` | Local GPT-SoVITS api_v2 server URL |
| `ttsLocalRefAudio` | `''` | **Required for local TTS**: absolute path to the reference voice clip (3-10s wav, e.g. `D:/voice/xiaojingyu.wav`) |
| `ttsLocalPromptText` | `''` | Transcript of the reference clip (may be empty) |
| `ttsLocalTextLang` | `zh` | Language of the text to synthesize |
| `ttsLocalPromptLang` | `zh` | Language of the reference clip transcript |
| `ttsLocalConvertToMp3` | `true` | Auto-convert local wav output to mp3 with ffmpeg before sending (better QQ/NapCat compatibility) |
| `pokeEnabled` | `true` | Poke replies: a random cute line when someone pokes the bot (allowlisted chats only) |
| `pokeReplies` | `[...]` | Poke reply lines (one is picked randomly) |
| `pokeCooldownSeconds` | `15` | Min seconds between poke replies per chat (anti-spam) |
| `voiceReadingEnabled` | `true` | Voice reading: @bot + quote text saying "读一下/念出来", or `/读 <text>` (synthesized via ttsProvider) |
| `checkinEnabled` | `false` | Daily check-in (**off by default**): say the keyword (default 签到) to check in; streaks persisted per chat in `cwd/qq-checkin/`; 签到榜 shows the leaderboard |
| `checkinKeyword` | `签到` | Check-in trigger keyword |
| `welcomeEnabled` | `false` | New-member welcome (**off by default**): @-mention the newcomer with the welcome text when someone joins (bot itself excluded) |
| `welcomeText` | `''` | Welcome text (empty = built-in default) |
| `imageGenEnabled` | `false` | Image generation switch (**off by default**): `/画 <prompt>` generates an image (groups require @-mentioning the bot) |
| `imageGenProvider` | `openai` | Backend: `openai` = any OpenAI-compatible `/images/generations` (DALL·E/CogView/SiliconFlow…); `local` = local SD WebUI (AUTOMATIC1111) |
| `imageGenBaseUrl` | `''` | Backend base URL (empty = provider default: api.openai.com or 127.0.0.1:7860) |
| `imageGenApiKey` | `''` | API key for OpenAI-compatible providers (not needed for local) |
| `imageGenModel` | `''` | Model id (empty = provider default, e.g. gpt-image-1; ignored by local) |
| `imageGenSize` | `1024x1024` | Image size WxH (local supports arbitrary sizes like 768x512) |
| `imageGenSteps` | `20` | Sampling steps (local only) |
| `imageGenCfgScale` | `7` | CFG scale (local only) |
| `imageGenSampler` | `''` | Sampler (local only; empty = WebUI default) |
| `imageGenCooldownSeconds` | `60` | Min seconds between generations per chat (cost/spam guard) |
| `imageGenDailyLimit` | `20` | Max generations per chat per day |
| `imageGenMaxPromptChars` | `400` | Max prompt characters (truncated beyond) |
| `imageGenCommand` | `/画` | Trigger command for image generation |
| `traceEnabled` | `true` | structured end-to-end events (one trace id per message, every branch carries a reason); turning it off leaves the console with ports and logs only |
| `traceLevel` | `debug` | `debug` records every event including silent drops; `warn` keeps problems only, for long-running deployments |
| `traceMemorySize` | `500` | recent events kept in memory for the console's decision-chain view (the JSONL file rotates at 4 MiB on top of that) |
| `traceFile` | `''` | event file path (empty = `cwd/qq-trace.jsonl`) |
| `recordInbound` | `true` | **recording**: append every inbound message/notice/request to `qq-inbox.jsonl` so it can be replayed offline; local file only, never changes replies |
| `inboxFile` | `''` | recording file path (empty = `cwd/qq-inbox.jsonl`, rotated at 2 MiB) |
| `inboxRedact` | `false` | mask 6+ digit runs (QQ ids) before writing, so a recording can be shared for debugging |
| `injectEnabled` | `false` | **event injection** (off by default): the bridge polls `qq-inject.jsonl` every `injectIntervalMs` and feeds new lines into the real pipeline |
| `injectFile` | `''` | injection queue path (empty = `cwd/qq-inject.jsonl`); lines already present at startup are skipped and the skip is recorded with a reason |
| `injectDryRun` | `true` | **keep this true**: every outbound call triggered by an injection (send/recall/moderation…) is intercepted and counted, never sent to QQ — including the **asynchronous agent turn's reply**, whose text is recorded in the event stream |
| `injectIntervalMs` | `2000` | injection queue poll interval in milliseconds (minimum 500) |

## OneBot side setup

With NapCat, set the WebSocket client URL in the OneBot11 config to:

```
ws://127.0.0.1:6700/
```

Other implementations work the same way (LLOneBot: reverse WebSocket; OpenShamrock: passive WebSocket; go-cqhttp: `ws-reverse`). If `accessToken` is set, use the same token on the OneBot side.

### Launching NapCat, and what the errors mean (v0.6.5)

**Being online only requires NapCat to dial 6700** — it does not require you to launch it from here. Signing in / scanning the QR code usually does.

- **No path to copy by hand**: the DSH panel's 快捷操作 → 启动 NapCat and the console's 启动 NapCat **detect** the usual install
  locations (`%LOCALAPPDATA%\Programs\NapCat\bootmain\`, `%ProgramFiles%\NapCat\bootmain\`, `~\.dsh-qq\`). Only if none of
  them exists do you have to fill one in: console → 配置 → NapCat 启动脚本 = `…\NapCat\bootmain\launcher.bat`
  (**not** the sibling `napcat.bat`: in this NapCat build that one only starts the loader and `pause`s, and exits doing
  nothing). The console and the DSH panel read the **same** `qq-control.json`, so filling it once covers both.
- **Both generated files live in your working directory** (`cwd` in `qq-control.json`): `qq-napcat-launch.cmd` (the
  **shim script** — written the moment you press 启动 NapCat, so it is not shipped in the package and you will not find it
  in the plugin folder) and `qq-napcat-launch.log` (the elevated window is hidden, so the launcher's output ends up here).
- **Success is judged by the heartbeat line** in that log (`=== shim start … ===`). When the elevation hop is silently
  refused, powershell still exits 0 and 6099 may still be listening (NapCat was already up), so only the heartbeat proves
  the command actually landed. Without it the UI says "nothing happened this time" — restart the console/host **as
  administrator**, or right-click `launcher.bat` → Run as administrator.
- **With `ConsentPromptBehaviorAdmin=0` elevation never prompts**, so seeing no UAC dialog is normal.
- **Reading "桥：无快照" (no snapshot)** (hover for the full explanation since v0.6.5): ① the snapshot stopped N minutes ago
  ⇒ the bridge stopped or the plugin was disabled; ② the host is not running ⇒ the snapshot is written by the plugin inside
  the host; ③ the host is running but nothing writes a snapshot ⇒ the plugin is not enabled, or **the plugin's working
  directory differs from the console's** (the plugin writes `<its own cwd>\qq-runtime.json`; starting the host from the
  console keeps both in sync).

## Speech-to-text (STT)

**Trigger rules** (final):

| Scenario | Behavior |
|---|---|
| Group: @-mention the bot + quote (reply to) a voice message | ✅ Transcribe the quoted voice and reply with text |
| Group: plain voice message (no @ / no quote) | ❌ No trigger |
| Private: direct voice message | ✅ Transcribe and reply (independent of `acceptPrivate`) |
| Private: text + quoted voice | ✅ Transcribe the quoted voice |

Pipeline: the quoted message → `get_msg` → contains a `record` segment → OneBot `get_record` (`out_format` mp3/wav, response contains `base64`) → POST `{sttBaseUrl}/audio/transcriptions` (multipart field **`file`**, binary) → transcription injected into the session.

Notes:
- Zhipu GLM-ASR-2512 accepts wav/mp3, **≤ 30 s**, ≤ 25 MB; use SiliconFlow or another endpoint for longer audio
- The Zhipu endpoint requires the multipart field `file` (binary) — the documented `file_base64` field is rejected at runtime with error 1214

## Session grouping

- Groups: with `sessionMode: chat` (default), each group has one session shared by all members; with `user`, one session per sender
- Private chats: one session per user, fully isolated from groups
- The agent's system prompt includes the chat scope ("You are chatting in QQ group xxx" / "You are in a private QQ chat with user xxx") and is told not to mix up context between chats
- `/new` resets only the **current** session; sessions live in memory and are rebuilt after a host restart (not persisted)

## Face system

- `[face:鼓掌]`-style markers in replies are expanded into CQ face segments (see the yellow-face table in `lib/faces.js`, ~70 entries)
- With `faceEnabled=true`, each session registers `qq_face_list` / `qq_face_send` tools
- Dropping image files into `cwd/qq-faces/` registers them as sendable stickers automatically (file name = sticker name); deleting a file removes it
- With `autoCollectStickers=true`, image stickers from incoming messages are collected automatically

## Extension seams (v0.7.0)

Other plugins in the same host can send a message, observe traffic and add tools **without patching this plugin** —
but there is no second path around the guards:

```js
// ① instance outlet (mounted as ctx.qqBridge; import { getExtensionApi } as a fallback)
const r = await ctx.qqBridge.sendText('g:123456', 'hello')   // { ok, reason, chatKey }
await ctx.qqBridge.sendImage('u:1001', '/abs/pic.png', 'caption')
ctx.qqBridge.sessions()   // [{ chatKey, sessionId, turnActive }] (read-only copy)
ctx.qqBridge.config()     // snapshot with token / apiKey / secret / password / cookie redacted

// ② read-only events (ctx.on or api.on; returns an unsubscribe function)
ctx.on('qqbridge:inbound',  (e) => console.log(e.chatKey, e.text))
ctx.on('qqbridge:outbound', (e) => console.log(e.chatKey, e.kind, e.text))

// ③ experimental: tool providers (requires the panel's Experimental switch)
ctx.qqBridge.registerToolProvider(({ agentCtx, route, key, config, workspaceRoot }) => ({
  tools: [ /* whatever defineTool(...) returned */ ],
  sections: [ /* { name?, order?, text } */ ],
}), { name: 'my-plugin' })

// ④ no ctx available (load order, out-of-process)? the package now exports an entry — stop hard-coding file:// paths
import { getExtensionApi } from 'dsh-qq-onebot-bridge/extension'
const api = getExtensionApi()

// ⑤ bridge instance id: it changes whenever the host rebuilds the bridge (restart / hot reload / a panel toggle),
//    so a plugin can tell whether the provider it registered still lives on the same instance — no polling needed
if (api.instanceId !== lastInstanceId) { lastInstanceId = api.instanceId; reRegister() }
```

- **Every send reuses the existing guards** (outbound rate limit, injection suppression, splitting, merged-forward, path
  resolution, ActionGate quota, TTS availability) **and additionally checks the destination allowlist** — otherwise a third
  party could proactively message people/groups outside the allowlist, and QQ risk control would hit the bot's own account.
- **Inbound events fire after allowlist / quiet hours / dedup and before commands and the model**, so listening can never
  bypass the gates; the text is already normalised.
- **Read-only**: events cannot rewrite or block anything, and a throwing/rejecting listener only logs debug.
- **Tool providers are experimental and off by default**: additive only (the 10 built-in `qq_*` tools cannot be
  overridden), a throwing provider is skipped alone, caps of **16 tools / 4 sections** per provider and **40 / 12** in
  total, and everything injected or skipped is traced. **Third-party extension behaviour is outside this project's support scope.**
  (The tool cap went from 8 to 16 in v0.7.1: a real user splits tools into one package per topic and was hitting 8 exactly.
  Sections stay at 4 — those are a fixed per-message cost.)
- **Three things to watch when writing a provider** (① is a third-party field report; ②③ were checked against the host source):
  ① **Never mutate `agentCtx.tools`** (e.g. assigning to `.register`). Behind it is the host's **shared** `ToolRuntime`
      (`class ToolRuntime extends Service` in `@deepseek-ai/dsh-tools`; `register()` internally does
      `this.layers.effect(this.ctx, layer => layer.tools.insert(name, definition))`). A third party measured that assigning
      through it reaches the **process-wide** instance — every agent changes, with no warning. To filter per session, build a
      view with `Object.create(tools)`, `defineProperty` only `register`, and proxy just the `tools` key, reflecting everything
      else (`systemPrompt`, `context`, `ctx`) untouched.
  ② **`tools.restrict({ allow, deny })` only masks global tools** — it does not "narrow this layer down to a few". From the
      `@deepseek-ai/dsh-tools@0.2.0-rc.2` type declarations: *"Per-scope filter over global tools. Restrictions intersect and
      do not affect scoped registrations"*, and `allow` is *"Global tool names that stay visible; everything else is removed"*.
      So unnamed **global** tools silently disappear (including `web_search` from the preset layer), while tools registered in
      your **own scope are untouched**.
  ③ That `restrict()` is only half silent: names must be **known global tools** — a typo, an empty filter, `run_code`, or a
      scope-local name **throws** (`unknown global tool` / `requires a scoped context` / `is a no-op`).
      Prefer `deny`, or filter in your own view, instead of touching the shared runtime.
- **Four more provider rules** (v0.7.3, from the first real third-party plugin — see issue #4's `ext/README.md`):
  ① **Parameters must be standard JSON Schema.** When you return a bare tool object, the host validates it with
     `assertSupportedJsonSchema`: `required: true` inside a property is **rejected** — use a top-level `required: ['name']`
     array. Returning `defineTool({...})` gives you exactly that shape (recommended).
  ② **Keep no per-apply state in the provider.** cordis' live reload re-runs `apply()` but **reuses the module instance**, so
     state created inside `apply` piles up another same-named provider on every reload (its tools get skipped as duplicates).
     Put state at module level.
  ③ **Registrations die with the bridge instance.** A host restart, a hot reload or a panel toggle rebuilds it and your
     provider is gone — re-register yourself (e.g. every 5 s check `api === lastApi && api.toolProviders().includes(name)`,
     and register again when it is not; do *not* stop polling after the first success).
  ④ **Editing JS needs a host restart.** Changing `cordis.patch.yml` config triggers a reload (re-runs `apply`), but editing
     `index.js` itself is not re-imported — the common workaround is to keep tools in `body.mjs` and re-import it with a
     cache-busting query on every `apply`.
- Deliberately not implemented: rewritable/blockable events, multi-account, vector memory.

### Third-party extensions (community)

- **[551123 / dsh-qq-onebot-bridge · `patches/0.7.5/ext`](https://github.com/551123/dsh-qq-onebot-bridge/tree/patches/0.7.5/ext)** —
  the first plugin set that actually uses `registerToolProvider`: four packages (house / pages & notes / workspace / faces) with
  20 tools, maintained against our tags; its `ext/README.md` documents installation and the five hard constraints
  (`file://` resolution, standard JSON Schema, synchronous return, module-level state, …).
  **Maintained by its author, outside this project's support scope** — this is a pointer only; please file issues there.
  Link convention (agreed with the author, written down so nobody has to ask again): the branch is always
  **`patches/<our tag>`** and **`ext/` always sits at its root**, so this URL only needs to follow the newest tag — whether the
  branch holds one commit or a dozen does not change the address.

### Compatibility promise (how these interfaces may change)

Once something is public and used, it cannot be renamed casually — so the rules are written down here:

- **Additive only**: a new method, a new event field, a new return field → **no version bump**; existing callers keep working.
- **Renaming or reshaping** (renaming, reordering parameters, changing what a return value means, sync→async…) →
  **bump `version`** (currently `1`) and keep the old one for **at least one minor release**, marked `deprecated` here.
- **Events stay read-only**: no "can rewrite / can block" return value will ever be added to `inbound` / `outbound`.
- **You can see whether anyone uses it — without it looking like telemetry**: only once the outlet has actually been
  called does the panel's Experimental group add a line
  `outlet calls (local counter: kept in memory only, no message content, never sent anywhere, reset on restart): sendText N · …`.
  When every count is zero the line is **not shown at all**. It is never written to disk, never enters `qq-runtime.json`,
  never triggers a request, and the panel is served by the local host only — in other words, **it counts whether a plugin
  called this API, not what you are doing**. All zero means nobody uses it, so a breaking change costs nothing; as soon as
  there is a number, the three rules above apply.
- Internals (private methods, file formats, trace fields) are **not** covered — they may change freely.

### About forks: upstream is a single line

- **This repository maintains `main` plus tags only** (e.g. `v0.7.4`). A GitHub fork is **someone else's copy**: it is not an
  upstream branch and never lands here automatically — no matter how many commits a fork has, this `main` is unaffected.
- **We do not merge or rebase other people's fork history**: those commits follow their author's own rhythm and folding them in
  would make the history unreadable. Contribute via an issue or a PR (a small PR is fastest); maintaining your own line is
  perfectly fine too — rebase on our tags. We will not copy your commit history, but **ideas are fair game** (v0.7.4's taint
  window came from issue #4's patch branch).
- Install from **this repository or the npm package**, not from an arbitrary fork — the code there may be modified, while the
  README and CHANGELOG describe this line only.
- **For people maintaining literal-anchor patches**: we will not slow refactoring down for compatibility, but we do call it out
  in the CHANGELOG — especially the **import block at the top of `lib/bridge.js`** and any function that gets **rewritten as a
  whole**, since those force a re-anchor. (Asked for by issue #4's author: his patch library locates edits by "replace this
  unique string in the pristine tree", so a changed import line kills the anchor.)

## Commands & debugging

- `/new`: end the current session and start a fresh one
- `/status`: show the current session state and session id prefix
- **`/why` (v0.6.9)**: why a message got no reply — quote it and send `/为什么` (or `/为什么 <messageId>`, or no
  argument for the newest message in this chat) and the trace decision chain is rendered as
  `inbound ✅ → allowlist ✅ → quiet hours ⛔` plus "blocked at 「quiet hours」: …". Admins only in groups; it prints
  stages and reasons, never the message text.
- Debug log: `{cwd}/qq-bridge-debug.log` (message routing, voice transcription, agent events, timestamped)
- Host error log: redirect stderr when starting `dsh web` (e.g. `D:\qq-work\qq-host-err.log`) to diagnose startup crashes
- Key log markers: `voice fetched via get_record`, `quoted voice transcribed`, `followup sent (voice)`, `group msg without @bot ignored`

## More docs

- **[docs/DEBUG.en.md](docs/DEBUG.en.md)** — debugging: trace, offline replay, event injection, one-shot diagnostics, diagnostic bundles, acceptance page
- **[docs/FEATURES.en.md](docs/FEATURES.en.md)** — v0.5 details: merged-forward expansion, `/文件` `/取` `/相册` `/ocr`, per-day archive and `/找`, members and group info, reactions

## Standalone control console (`control/`, v0.4.0)

The plugin ships an independent local operations console that does **not** depend on DSH Desktop: it keeps working when the host is down, and shows every port and process at a glance.

```sh

# starts on http://127.0.0.1:8799 and prints the tokenised URL

npm run control            # or: node control/bin/qq-control.mjs --open

# on Windows you can also double-click control/启动控制台.bat

```

| Capability | Detail |
|---|---|
| Port overview | listening state, owning PID and process name for console 8799 / host 3080 / OneBot 6700 / NapCat 6099 / GPT-SoVITS 9880; the connection count on 6700 *is* the "bot online" signal |
| Start / stop | start, stop and restart the host (always with `--no-open`, logs appended to `qq-host-out.log` / `qq-host-err.log`), start/stop NapCat and QQ, start/stop GPT-SoVITS, stop everything at once |
| Start pre-flight | checks 3080/6700 first and refuses to start with "port ← process#PID" instead of failing silently |
| Free a port | one-click `taskkill /T /F` for the process owning a watched port (guard rail: only watched-port owners and known bot processes, never an unrelated PID) |
| Logs | host stdout / stderr / bridge debug log with live follow and line count |
| QR login state | whether the NapCat QR image exists and is fresh, plus a link to the 6099 page |
| Config | `qq-control.json` is the single source of truth for ports and paths (node, `dsh bin.js`, NapCat, TTS script auto-detected; paths editable in the UI); **6700 is pinned by the NapCat config, do not change it** |
| Debugging | "录制 · 回放 · 注入": lists every recorded inbound event from `qq-inbox.jsonl`, replays any of them offline (sandbox + dry-run) or injects a synthetic event; the injection queue state (lines / consumed this run / dry-run) is shown inline |
| Acceptance | "硬约束验收台" at the top: live evidence for all 6 hard constraints (no silent branch / trace id / replay / diagnosis / export / injection), with "where to click" for anything not met; `GET /api/acceptance` |
| Security | binds `127.0.0.1` only, every API needs the token, and any request carrying a cross-site `Origin` is rejected |

> A future tray/desktop build can simply wrap this HTTP API in Electron/Tauri — no logic rewrite needed.

## Tests

60 unit suites, 4014 assertions in `test/*-unit.mjs`, plus 3 live scripts:

```sh

# 1) unit tests: no network, no host, pure logic in temp dirs (run after every change)

node test/control-unit.mjs        # or one at a time: node test/<name>-unit.mjs

#    61 files: bridge branches/commands/guards, console HTTP + diagnosis, recording/replay/injection,

#    injection safety boundaries, the hard-constraint acceptance page, the `/why` decision-chain wording…

#    run them all (PowerShell):

#    Get-ChildItem test -Filter '*-unit.mjs' | ForEach-Object { node $_.FullName }

# 2) replay end-to-end acceptance: real bridge code + real OneBot server, sandbox + dry-run, no host needed

node test/replay-live.mjs

# 3) live scripts (host/console already running; they impersonate the OneBot client on 6700)

node test/live-e2e.mjs        # message -> reply, full path
node test/live-stream.mjs     # event stream / decision chain / diagnosis endpoints (console 8799)
node test/replay-live-host.mjs --token <console token>   # record -> offline replay -> injection
```

The older `sim-*.mjs` protocol scripts are still in `test/` for manual poking (`node test/sim-group.mjs`, host running).
The STT path is best tested with a real QQ voice message (simulated scripts require a real STT call).

## Persona & memory (important)

This plugin ships **no persona, preferences, or group rules**. The whale-girl persona, Q&A preferences, and group behavior rules are injected into every QQ session by the **dsh-mnemon** plugin's runtime memory (`~/.mnemon/runtime/USER.md` + `MEMORY.md`) — the plugin provides the *functionality*, memory provides the *personality*, and the two are fully decoupled. Change the persona by editing Mnemon memory; change behavior by editing this plugin.

## ⚠️ Risks & compliance (read before use)

### Account risk control

- This plugin connects to QQ through **third-party protocol implementations** (NapCat etc.), which are **not official Tencent APIs** and conflict with the QQ license agreement; Tencent explicitly bans unofficial clients/protocols
- Using third-party protocols carries the risk of **login restrictions, freezes, or permanent bans**, and may affect other QQ accounts on the same device/IP
- Use a **dedicated bot account** — never your main account
- Common risk triggers: high-frequency messaging, mass messaging in short periods, marketing/advertising/violating content, reports from other users, unusual login devices
- Mitigations: lower reply frequency, run only in small/private groups, avoid 24/7 spamming, keep content compliant

### Content compliance

- Everything the agent generates is sent under the bot account — **you are responsible for everything published by that account**
- Constrain outputs in the persona/system prompt; violating content triggers account penalties and possibly legal liability

### Security

- With `allowUsers` / `allowGroups` unset (empty), the plugin **denies all private and group messages by default** — explicitly list your own QQ id and the groups to serve before use; once configured, nobody outside the allowlists can drive your agent
- The plugin listens on `127.0.0.1` only; do not change it to `0.0.0.0`
- Voice and images are uploaded to third-party cloud services (STT API) — **do not send sensitive audio**

### Compliance tips

- For personal learning and small internal groups only; do not use for mass marketing, advertising, harassment, or bot-farming
- Comply with local laws and Tencent platform rules
- Using third-party protocols is **at your own risk**; this plugin offers no ban-free guarantee

### Disclaimer

This plugin is provided for technical learning and personal research. Users must assess and bear all risks and consequences of using third-party QQ protocols themselves.

## Security notes

- With `allowUsers` / `allowGroups` empty, all messages are denied by default — list your own QQ id and groups before use
- The port listens on 127.0.0.1 only; do not expose it
- OneBot implementations themselves carry QQ ban risk; assess third-party bot protocols yourself
- **Prompt injection**: external content the model sees (forwarded messages, group files, web echoes) can carry instructions.
  By default it is processed normally, with only a system-prompt rule saying external content is untrusted. For more, turn on the
  **taint window** in the panel's Experimental group — after an injection-looking message, outbound writes for a while become
  dry-runs (**side effect: replies stop reaching QQ and are only visible in trace and the panel status line**)

## Privacy and redaction

Debugging usually means sending logs to someone else, so the plugin is explicit about where data goes:

| Item | Rule |
|---|---|
| Diagnostic bundle | "导出诊断包" exports **redacted by default**: QQ ids are masked digit-by-digit (first two kept) and message bodies become "[已脱敏 N 字]"; the bundle carries a `REDACTED.json` describing the policy. Unchecking the box exports plaintext (with a warning toast) |
| Runtime artefacts | `qq-inbox.jsonl` (message bodies), `qq-trace.jsonl` (chat keys + text snippets), `qq-runtime.json`, `qq-actions.log` are written to the local working directory only and are **all covered by `.gitignore`** (`qq-*/`, `qq-*.json`, `qq-*.jsonl`, `qq-*.log` plus explicit entries), so a cwd inside the repo still cannot commit them |
| Recording redaction | `inboxRedact: true` masks QQ ids already at record time |
| The repository | contains no keys, passwords or real QQ ids: secrets live only in your DSH profile config (outside the repo), and `test/privacy-unit.mjs` re-scans every tracked file on each test run (the private ids are read from your machine-local config or `DSH_QQ_PRIVATE_IDS`, never stored in the test) |
| Console | binds `127.0.0.1` only, every endpoint needs the token (kept in the ignored `qq-control.json`), cross-site Origins are rejected |

> Deployment fact: this plugin is a **DSH bundle** and runs inside a DSH profile; official peer dependencies (`@deepseek-ai/dsh-*`, `@deepseek-ai/schemastery`) are installed together with the profile. **Official packages must be imported by their full scoped name**: the unscoped `schemastery` is a different package (3.18.0) that only resolved when another plugin happened to hoist it into the shared node_modules — which is how `lib/` was written up to v0.4.0, and it fails with `ERR_MODULE_NOT_FOUND` on a clean install ([issue #1](https://github.com/cheesehaqi/dsh-qq-onebot-bridge/issues/1)); it now uses the scoped name, enforced statically by `test/static-unit.mjs` (a bare or undeclared import fails the test). `ws` is an ordinary runtime dependency, so a local-directory install needs the `npm install` step above. Copying `lib/` out and running it standalone still will not work by design.

## Changelog

The five most recent versions (always kept rolling):

- **v0.7.7** — "punctuation-aware splitting becomes a config key": new **`longReplySplitOnPunctuation`** (on by default, one row in the panel's Conversation group) — `#replyTo` now reads it directly, so a third party no longer has to touch our function signature or the call site (v0.7.6 only added the parameter, without wiring it). Only replies longer than the per-message limit are affected; turning it off falls back to a plain character-count cut.
- **v0.7.6** — "three small follow-ups for patch authors": ① **`splitSegments(segments, limit, { punctuation: false })`** gives callers a switch to turn punctuation-aware splitting off (the default stays three-level: sentence → inner → hard cut), which lets issue #4's author drop the last edit he kept for 0.7.5; ② the README community link follows to **`patches/0.7.5/ext`** and spells out the agreed convention — the branch is always `patches/<our tag>`, `ext/` always at its root, and the number of commits inside does not change the URL; ③ a promise written down: **changes that force a re-anchor (the import block at the top of `lib/bridge.js`, whole-function rewrites) get called out in the CHANGELOG** — he locates edits by literal anchors, and only asks to be told.
- **v0.7.5** — "five things the third party asked for": ① **`api.instanceId`** (a random id per bridge instance) so a plugin can tell when the host rebuilt the bridge instead of polling `toolProviders()` prefixes (the author measured both false positives and missed switches); ② **provider failures are no longer silent** — a returned `reason` is traced, and a throw now carries the **first stack frame** (`body.mjs:42:9`); ③ **taint events carry `data.source`** (`inbound-injection`) so they do not blur with a third party's own taint; ④ **second-level sentence splitting**: sentence-end punctuation (60% window) → inner punctuation (50%, `，,、）)」』：:`) → hard cut, so long Chinese sentences stop clumping; ⑤ README gained a **third-party extensions (community)** pointer (four packages / 20 tools; author-maintained; links the directory, not files).
- **v0.7.4** — "sentences, allowlist timing, taint window": ① **long replies split on sentence boundaries** — `splitSegments` used to cut purely by character count (slicing a sentence in half); now it prefers the last sentence-ending punctuation and only hard-cuts when there is none, with the reassembled text byte-identical. ② The panel now spells out that the **allowlist gates before a session is created** (a chat outside it never exists, so there is no "rejection reply" — use `/为什么` to see it). ③ **Taint window (experimental, off by default)**: when inbound text looks like a prompt-injection instruction (`忽略之前所有指令`, `ignore all previous instructions`, `print your system prompt`, …), that chat is marked for a bounded window (30 min by default, 1–1440 configurable) during which **text / image / file / voice / recall / reaction are all downgraded to dry-run** while Q&A keeps running; marking and **every block** are traced, the outlet returns `ok:false` with the reason, the panel shows how many chats are being held, and `clearTaint()` releases it. Also fixed three real bugs found on the way: media tools reporting `sent:true` while blocked, `/取 文件` claiming "✅ sent to your DM" when nothing was sent, and the outlet returning a generic gate reason. New `test/taint-unit.mjs` (25 assertions), panel 80 → **83 keys**; **62 suites / 4110 assertions green**
- **v0.7.3** — "field lessons from the first real plugin": the issue #4 author published `patches/0.7.0` (22 commits, three `ext/` packages actually using `registerToolProvider`), and reading them produced three changes. ① **The package now exports `/extension`**: previously a third party could only reach the outlet by importing `lib/extension.js` through an absolute `file://` URL (his packages shipped a `QQBRIDGE_EXT_PATH` fallback for exactly that); now `import { getExtensionApi } from 'dsh-qq-onebot-bridge/extension'` just works. ② **Provider context gained `workspaceRoot` / `extensionVersion`** — he assumed `workspaceRoot` existed by analogy with the outlet, but upstream never passed it, so it was silently `undefined`. ③ README gained four provider rules: parameters must be **standard JSON Schema** (`required: true` inside a property is rejected — use the top-level array), **no per-apply state** (live reload reuses the module instance), **registrations die with the bridge instance** (re-register yourself), and **editing JS needs a host restart** (only config changes trigger a reload).

**Older versions (the v0.4 line and earlier) are in [CHANGELOG.md](CHANGELOG.md)** — the full history, including every release's defect list and test counts.

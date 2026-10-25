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
ctx.qqBridge.registerToolProvider(({ agentCtx, route, key, config }) => ({
  tools: [ /* whatever defineTool(...) returned */ ],
  sections: [ /* { name?, order?, text } */ ],
}), { name: 'my-plugin' })
```

- **Every send reuses the existing guards** (outbound rate limit, injection suppression, splitting, merged-forward, path
  resolution, ActionGate quota, TTS availability) **and additionally checks the destination allowlist** — otherwise a third
  party could proactively message people/groups outside the allowlist, and QQ risk control would hit the bot's own account.
- **Inbound events fire after allowlist / quiet hours / dedup and before commands and the model**, so listening can never
  bypass the gates; the text is already normalised.
- **Read-only**: events cannot rewrite or block anything, and a throwing/rejecting listener only logs debug.
- **Tool providers are experimental and off by default**: additive only (the 10 built-in `qq_*` tools cannot be
  overridden), a throwing provider is skipped alone, caps of 8 tools / 4 sections per provider and 24 / 12 in total,
  and everything injected or skipped is traced. **Third-party extension behaviour is outside this project's support scope.**
- Deliberately not implemented: rewritable/blockable events, multi-account, vector memory.

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

## Debugging (v0.4 "everything debuggable")

Every inbound message gets a **trace id**, and every decision point — **including every silent drop** — records `stage + ok + reason + duration`. That is the design philosophy of this release: when something goes wrong you should never have to guess.

| What you want to know | Where to look |
|---|---|
| **Are the 6 hard constraints met right now?** | Console → "**硬约束验收台**" at the top: 6 status lights, the evidence currently on the machine, and where to click next; recomputed every 30s |
| The full decision chain of one message | Console → "实时事件流": click any row, the "决策链" card shows the timeline, where it stopped and why |
| Why the bot did not reply | Filter the event stream to failures — the most common reasons are listed (e.g. `mention: 群聊未 @ 机器人`) |
| Port ownership and liveness | Console → "端口 / 进程" (connections on 6700 = bot online) |
| One-click triage | Console → "一键体检": 15-19 pass/fail checks with fix hints (paths, ports, link, snapshot, errors, gate denials…) |
| Effective config (why a feature is off) | Console → "运行快照" ("关闭中的开关"); full fields in `qq-runtime.json` → `features` (never any secret) |
| A bundle to hand to someone else | "导出诊断包" → one zip (events, audit, bridge log, host logs, runtime snapshot, diagnosis, environment) |
| File-level digging | `qq-trace.jsonl` (structured events, jq/grep friendly), `qq-bridge-debug.log`, `qq-actions.log` (write-action audit), `qq-host-out.log` / `err.log` |

Config: `traceEnabled` (on by default), `traceLevel` (`debug` = everything, `warn` = problems only), `traceMemorySize`, `traceFile`.
Debug endpoints (console, token + Origin guarded): `/api/trace`, `/api/stream` (SSE), `/api/runtime`, `/api/diagnose`, `/api/export`.

### Recording · offline replay · event injection (v0.4 phase 3)

The first two answer "what is happening right now"; these three answer "why did *this* message go that way, and what would a different input do".

| Capability | How | Detail |
|---|---|---|
| Recording | automatic | every inbound message/notice/request is appended to `qq-inbox.jsonl` (JSONL, size-rotated). Local file only, never changes how the bot replies |
| Offline replay | console → "录制 · 回放 · 注入" → "回放这条" / "回放最近 5 条" | re-runs that message through the **real bridge code** inside a **sandbox directory**: dry-run intercepts every outbound call, no QQ connection is ever created, the live working directory is not touched. Each entry gets a verdict — replied / silent / error — **with the reason** and what it would send |
| Event injection | console → fill group id / QQ id / text → "注入" | appends a line to `qq-inject.jsonl`; the bridge polls it (`injectIntervalMs`, default 2s) and feeds it through the **real pipeline**. With `injectDryRun` (default on) every outbound call is intercepted and counted, so injected content is never actually sent to QQ |

Replay fidelity comes from the live decision config carried in the runtime snapshot (allowlists, quiet hours, feature switches — 28 keys under `replay` in `qq-runtime.json`); without it the plugin defaults ("empty allowlist = deny everything") would make every replay look silent. Replay does **not** contain real model output: the model turn is replaced by a canned line prefixed with `[回放]`, so it validates the pipeline and the branch, not the wording.

Operational notes:

- if the injection channel is off the console **fails loudly with the switch name** (`injectEnabled`) instead of silently queueing;
- the injected **agent turn is asynchronous**: the dry-run window only covers the synchronous stage, so the model's actual reply is intercepted separately and recorded in the event stream (`injected turn reply suppressed (dry-run, not sent): <text>`). Injection therefore runs the real pipeline without ever leaking a message; a real inbound message clears the mark immediately;
- replayed frames are marked `replay: offline replay (sandbox + dry-run, never touches QQ)` while injected frames are marked `inject`, so the two never get confused;
- lines already present when the bridge starts are skipped, with a recorded reason ("skipped N historical lines, only lines appended after start are processed") — a restart never replays old injections;
- injected frames are never recorded, so injection and replay cannot feed each other;
- replay sandboxes: the newest 5 are kept, older ones are **moved to the recycle/trash directory** (`qq-replay/_trash/<date>/`), never deleted outright.

Config: `recordInbound` (on), `inboxFile`, `inboxRedact`, `injectEnabled` (off), `injectFile`, `injectDryRun` (on), `injectIntervalMs`.
Endpoints: `/api/inbox`, `/api/replay`, `/api/inject`, `/api/queue/clear`.

### Hard-constraint acceptance page (v0.4 phase 4)

The two features above answer "what is happening" and "why did this message go that way". The acceptance page answers the third question: **did the design philosophy actually land?**

`GET /api/acceptance` turns each of the 6 hard constraints into `✅ met / ⚠️ hint / ❌ not met / ❔ not enough evidence`, computed from artefacts that already exist on the machine, plus the evidence and the next step:

| Constraint | Evidence used |
|---|---|
| ① No silent branch | every `ok:false` event (rejected/failed) in the last 500 events must carry a non-empty reason; missing ones are named by stage |
| ② Correlatable (traceId) | traceId coverage of message-scoped events and how many messages actually reached `inbound→reply` |
| ③ Replayable | recording count plus the last replay's stats and **safety** (dry-run on, 0 QQ connections, sandboxed cwd); dry-run being off fails the row |
| ④ Diagnosable | diagnosis pass/fail/blocker counts and verdict, failing checks named |
| ⑤ Exportable | how many of the bundle's source artefacts are present (or the last export's size and filename) |
| ⑥ Injectable | channel switch, dry-run switch (off ⇒ not met, because it would send to QQ), lines consumed, and how many **asynchronous agent-turn replies have been intercepted** |

Every row has a "去看 →" link that jumps to the matching card; the verdict is one of `all-green / partial / unknown / broken`. The evaluator is a pure function (`control/lib/acceptance.mjs`) with every branch asserted in tests, refreshed every 30s and immediately after a replay finishes.

## See it, find it (v0.5)

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

- **v0.7.0** — "Experimental & Extensions": the extension points that were evaluated but left out of 0.6.x come back as **experiments, off by default**. ① **instance outlet `ctx.qqBridge`**: `sendText/sendImage/sendFile/sendVoice` speak as the bridge and **reuse the existing guards** (outbound rate limit, injection suppression, path resolution, ActionGate quota, TTS check) **plus a destination allowlist check**; read-only `sessions()/agents()/config()` snapshots (copies, secrets redacted); every outlet send is traced. ② **read-only events `qqbridge:inbound` / `qqbridge:outbound`**: observe only, never rewrite or block; inbound fires after allowlist/quiet-hours/dedup, outbound only after a message really went out and carries a `kind`. ③ **experimental tool-provider chain** (`registerToolProvider`, gated by `extensionToolsEnabled`, off by default): a plugin can add tools and prompt sections per session — additive only, a throwing provider is skipped alone, per-provider and total caps apply, and everything injected is traced; new **"Experimental (EXPERIMENTAL)"** panel group. New `test/extension-unit.mjs` (46 assertions), panel 78 → **79 keys**; **61 suites / 4075 assertions green**
- **v0.6.9** — "Ask why, find it, quote it": three time-savers. ① **`/why`** (new command): quote a message and send `/为什么` (or `/为什么 <messageId>`, or nothing for the newest one; plain "为什么没回" works too) and the trace chain is rendered as `inbound ✅ → allowlist ✅ → quiet hours ⛔` plus "blocked at 「quiet hours」: …". Four shapes get honest wording (blocked / passed and replied / reached the model without an outbound reply / handled by a pre-model branch), admins only in groups, and the message text is never echoed. The wording is a pure `summarizeTrace()`; the spoken form lives in `lib/why.js` and only matches a whole sentence. ② **panel search box**: filter by Chinese label / config key / hint (pure front-end), keep a matching group whole, auto-expand "advanced" groups while searching, show "matched N groups / M rows", and say "try another word" on no hits. ③ **quote the message being answered** (`quoteReplyEnabled`, off by default, **groups only**): the first batch of a reply carries a native QQ `reply` segment; a failed quote is retried once without it; injected/replayed frames and replies without a message id never quote. Outbound has two paths (commands `#reply()` and model `assistant/message`) — both now go through `#quoteFor()`; the first cut missed the model path and a real-hardware regression caught it. New `test/why-unit.mjs` (17) and `test/quote-unit.mjs` (11), `settings-unit` 267 → **271**, panel 77 → **78 keys**; **60 suites / 4020 assertions green**
- **v0.6.8** — "Quiet hours in the panel": quiet hours (`quietHoursEnabled` / `quietHours` / `quietWeekendExempt`) existed all along but could only be edited in YAML; the whole thing now lives in the panel — the **quiet-hours switch** (off by default), **weekend exemption** (on by default) and the **quiet-window list** (two native time inputs per window, overnight ranges such as `22:00-6:00`, up to 8 windows, an empty list meaning "never quiet"). Windows are normalised the way the engine parses them (`9:0-12:0` → `09:00-12:00`); identical start/end, out-of-range hours or unreadable text are rejected with a 400 that leaves the file untouched. The config keeps them as a flow sequence `["09:00-12:00","22:00-06:00"]`, which `readPatchValue` reads back — so the row can tell when its file value is newer than what the running plugin uses (that is the 「更新中」 badge: refresh the page once, no restart needed). Also fixed the "default" badge, which used to know only booleans (numeric and time-range defaults are now read from the schema too); the panel now **updates the click immediately, then greys out for 3 s and refreshes once automatically** (measured: the host needs ~2.3 s to apply a patch) instead of making you click twice; made **Refresh report what it did** ("refreshing…" then "refreshed: N groups · host vX") with the loaded plugin version shown next to the title — if a group you expect is missing, look there first; and **writes now work in profiles where the plugin is mounted by a bundle** (the profile's `cordis.patch.yml` may have no entry for it: the mount lives in the package's own bundle layer, so the panel appends a patch entry — `- id` / `name` / `config:` — at the end instead of refusing). The panel is **10 groups / 63 switches + 11 numeric fields + 1 time-range list + 2 allowlists**; `settings-unit` 213 → **267**; **58 suites / 3988 assertions green**
- **v0.6.7** — "Configurable numbers": added the **per-minute turn cap** as a switch plus a value — `chatTurnLimitEnabled` (**OFF by default**) and `chatTurnsPerMinute` (1–10, **default 5**). While the switch is off nothing is limited, so busy groups behave exactly as before; once on, each chat may send at most that many messages to the model per minute, and anything beyond is dropped with a trace reason and never queued (different from the reply-rate limit, which caps how many replies go *out*). The panel also grew from switches-only to **numeric controls**: `− value +`, written on Enter/blur rather than per keystroke, with **ranges and steps read from the schema** (never duplicated) and out-of-range or fractional values rejected by the server with the allowed range in the reason. Every threshold the old hints told you to edit in the config file is now a control too — **10 numeric fields in total** (dedup window, the two reply-rate numbers, the four anti-flood thresholds, poke-per-hour, report window), so the panel is 60 switches + 10 numbers. Also: **injected/replayed frames no longer consume quota** (local debug traffic must not be squeezed out by real volume), `upsertPatchValue` accepts integers and writes them as number literals, a quoted `"7"` stays a string instead of pretending to be a number, and numeric rows fail closed when no range is known. New `ratelimit-unit` (12 assertions); `commands-unit` 78 → **83**, `settings-unit` 193 → **210**; **58 suites / 3925 assertions green**
- **v0.6.6** — "Console freeze fixed": the console page locked up and accepted no input, with the browser showing "this page is not responding". Two causes, one at each end. ① **Server**: `/api/stream` built a fresh tailer per connection and its first poll replayed the trace tail **by bytes** (256 KiB) as individual events — a 254 KiB file here meant **1180 events in three seconds**; the first replay is now capped **by count** (the most recent 300), while explicit history still goes through `/api/trace?limit=`. ② **Client**: `onmessage` re-rendered the whole table per event (`renderStream()` rebuilds up to 400 rows of `innerHTML`, plus `updateErrPill()`), so 1180 events meant 1180 full rebuilds and a locked renderer; renders are now **coalesced** (`scheduleStreamRender`, at most one every 250 ms, so a burst is a single repaint). Measured on the same trace: **1180 events / 263 KB → 303 events / 68 KB**, client repaints **1180 → 1**. ③ Also fixed a misuse of the same feature: on the Desktop the host's `process.execPath` is **Electron itself**, and it used to be handed `control/bin/qq-control.mjs` directly — i.e. the script was treated as **an Electron app entry** (the live console process literally read `"…\DeepSeek Harness.exe" …\qq-control.mjs` and weighed 126 MB); it now spawns with `ELECTRON_RUN_AS_NODE=1` per the official docs (appended to, never replacing, the host environment), with CLI hosts unaffected. `console-debug-unit` 72 → **78**, `settings-unit` 189 → **193**; **57 suites / 3891 assertions green**

**Older versions (the v0.4 line and earlier) are in [CHANGELOG.md](CHANGELOG.md)** — the full history, including every release's defect list and test counts.

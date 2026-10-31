# Swapping the OneBot implementation (capability matrix)

This plugin speaks **OneBot v11 over a reverse WebSocket** and is not tied to one implementation. But "standard actions" and
"implementation extensions" are different things — here are the 71 actions we call, tiered, so you can check before/after a swap
(NapCat → LLOneBot / Lagrange / go-cqhttp / your own).

> You do not need to memorise this table at runtime: after connecting, the plugin calls `get_version_info` once to identify the
> implementation and keeps an **action ledger** of failures. Send `/health` in QQ, or read the status line under the panel's
> "advanced" group, to see *which implementation is running, which features failed, and the most likely reason*.

## Three tiers

| Tier | Meaning | After a swap | Count |
|---|---|---|---|
| **standard** | OneBot v11 standard actions | Every compliant implementation should have them; **a failure here points at connection/permission/protocol** | 32 |
| **extension** | Implementation extensions (naming/support varies) | Likely missing → the feature errors, a trace is written, the bot replies in plain words | 31 |
| **napcat** | NapCat-only | Almost certainly gone after a swap | 4 |

## Always available (standard)

Sending text / images / files / @ / quotes, recall, group members and group info, mute / kick / whole-group mute / card / group
name / title / set-admin, group files (list, download, upload, delete, create folder), group notices
(`_get_group_notice` / `_send_group_notice`), essence messages, group honours, likes (`send_like`), friend/group request
handling, `get_status` / `get_version_info`.

→ Roughly 80% of the day-to-day experience lives here.

## Possibly missing (extension)

| Feature | Depends on |
|---|---|
| Emoji reactions (react / who reacted) | `set_msg_emoji_like` / `get_emoji_likes` |
| Message history | `get_group_msg_history` / `get_friend_msg_history` |
| Merged-forward messages | `send_group_forward_msg` / `send_private_forward_msg` |
| Image OCR | `ocr_image` |
| **Voice download / transcode** (breaks most often) | `get_record` (`out_format` support varies the most) |
| Read marks, "typing" status | `mark_*_msg_as_read` / `set_input_status` |
| Pokes | `group_poke` / `friend_poke` |
| Extended group info, @all quota, system messages, ignored notices, mute list | `get_group_info_ex` / `get_group_at_all_remain` / `get_group_system_msg` / `get_group_ignored_notifies` / `get_group_shut_list` |
| Group policies (join mode / invite policy / member permissions / new-member history / portrait / remark) | `set_group_add_option` / `set_group_member_invite_policy` / `set_group_member_permissions` / `set_group_new_member_history_visibility` / `set_group_portrait` / `set_group_remark` |
| Batch kick | `set_group_kick_members` |
| Move / rename group files | `move_group_file` / `rename_group_file` |
| Doubtful friend requests | `get_doubt_friends_add_request` / `set_doubt_friends_add_request` |

## Basically gone (NapCat-only)

| Feature | Depends on |
|---|---|
| Group albums | `get_qun_album_list` / `upload_image_to_qun_album` |
| Group check-in | `set_group_sign` / `get_group_signed_list` |

## Swap checklist

1. After connecting, send `/health`; the first line shows the detected **OneBot implementation**;
2. Look at the **action calls** line: zero failures means nothing to do; otherwise it names the feature and the likely reason;
3. Failures in `extension` / `napcat` tiers → just turn those features off; everything else keeps working;
4. Failures in the `standard` tier → check protocol version (needs v11), `accessToken`, reverse-WS address, and the
   implementation's own logs;
5. The panel's "advanced" status line and the console event stream show the same information (`stage: capability`).

## Active probing: read-only check-ups only, never "try everything"

Blind probing is not viable: about half of the 71 actions **really change QQ state** (mute, kick, set essence, send
notices…) — trying them all would mean experimenting on a real group. So there are three safe things:

- **read**: `get_version_info` / `get_status` (pure queries);
- **account**: every real call records success/failure (never its parameters, so message content stays out of the statistics);
- **on-demand check-up** (v0.7.9): send **`/能力体检`** in QQ and it probes **21 read-only actions**, classifying each as
  "supported / unsupported / bad parameters / permission denied / no response", with the result written to the trace and the
  panel status line.

The boundary is enforced in code, twice:

1. the probe list is an **allowlist** (`get_*` / `_get_*` only), and `assertProbeSafety()` refuses any entry matching
   `send_ / set_ / delete_ / upload_ / mark_ / kick …` — if someone later slips in a mutating call, the check-up refuses to run
   and says so in the trace;
2. it only runs **when you ask for it** (never on startup or per message), and in groups only admins may trigger it.

**Mutating actions are never probed** — they are only answered by failures during real use (the passive ledger).
`retcode 1404` is deliberately not treated as "unsupported": it may mean the API is missing *or* that the target group/member
does not exist, so it gets its own `not-found` bucket.

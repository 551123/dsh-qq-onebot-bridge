# Debugging (trace · replay · diagnostics · injection)

> Moved out of the README (which got too long). This page is for digging into **why one specific message got no reply**; if you only want it running, the [README](../README.en.md) is enough.
> Every console entry below lives in `control/` (default `127.0.0.1:8799`); the panel's "调试台" link starts it for you.

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

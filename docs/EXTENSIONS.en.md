# Extension seam (`ctx.qqBridge`)

For plugin authors who want to add things to this bridge from inside the same host. Only the **stable surface**
and the **known traps** are documented here; internals (private methods, trace fields, file formats) may change freely.

> Versioning: `EXTENSION_VERSION = 1`. Adding fields does not bump it; **renaming or reshaping** an existing one does,
> and the old shape is kept for at least one minor version.

## 1. Getting the outlet

```js
// (1) plugins that have ctx — the normal case
const api = ctx.qqBridge

// (2) no ctx (load order, out-of-process): the package exports an entry, stop hard-coding file:// paths
import { getExtensionApi } from 'dsh-qq-onebot-bridge/extension'
const api = getExtensionApi()   // null while the bridge is not up yet — retry or wait for an event
```

| Field / method | Meaning |
|---|---|
| `version` | seam version, currently `1` |
| `instanceId` | **bridge instance id** (v0.7.5). Restart / hot reload / a panel toggle rebuilds the bridge → the value changes; stable within one instance. Use it to decide whether to re-register providers instead of polling `toolProviders()` |
| `events` | `{ inbound: 'qqbridge:inbound', outbound: 'qqbridge:outbound' }` |
| `on(name, fn)` | subscribe to a read-only event; returns an unsubscribe function |
| `sendText / sendImage / sendFile / sendVoice` | send as the bridge (**all outbound guards apply**, plus a destination allowlist check) |
| `recall / react` | recall the bot's own recent messages / react to a message |
| `sessions / agents / config` | read-only views (config is redacted) |
| `registerToolProvider(fn, { name })` | **experimental**: inject tools and prompt sections into every session (needs the panel's Experimental toggle) |
| `toolProviders()` | names of registered providers |

## 2. Read-only events

```js
ctx.qqBridge.on('qqbridge:inbound', (event) => {
  // { chatKey, messageType, userId, groupId, messageId, text, atMe, injected, at }
})
ctx.qqBridge.on('qqbridge:outbound', (event) => {
  // { chatKey, kind: 'text'|'image'|'file'|'voice', text, file?, bytes?, batches?, mode?, traceId?, at }
})
```

- **Read-only**: events have no return-value semantics — you cannot rewrite or block a message. If you need blocking,
  write your own plugin instead of bending this seam.
- They fire **after** the gates (allowlist / quiet hours / dedup), so listeners see exactly what will be processed.
- `injected: true` marks debug-injection traffic, not a real user message.

## 3. Tool providers (experimental)

```js
ctx.qqBridge.registerToolProvider(({ agentCtx, route, key, config, workspaceRoot, extensionVersion }) => ({
  tools: [ defineTool({ /* ... */ }) ],
  sections: [ { name: 'my-note', order: 50, text: 'a paragraph that only appears in this session prompt' } ],
  // optional reason: traced as-is (especially useful when you contribute nothing)
}), { name: 'my-plugin' })
```

Rules (each one was learned the hard way):

1. **Must be synchronous** — returning a Promise is skipped (session setup is a synchronous path; `await` would stall the message);
2. **Parameters must be standard JSON Schema** — `required: true` is rejected by the host validator; write an array at the object root;
3. **Keep state at module level**, not inside `apply()` — hot reload reuses the module instance but re-runs `apply()`;
4. **Registration dies with the bridge instance** — re-register when `api.instanceId` changes;
5. You can only **add**; a name that collides with a built-in tool is skipped and traced;
6. Limits: **16 tools / 4 sections per provider**, **40 / 12 overall**; going over records a `skipped` entry (not silent);
7. A throw only skips your provider; the **first stack frame** of `error.stack` is traced
   (e.g. `my-pkg→抛错：xxx @ /path/body.mjs:42:9`).

## 4. Taint and trace

- This plugin's taint events carry `data.source = 'inbound-injection'` (constant `TAINT_SOURCE_INBOUND`). If you run your
  own taint layer ("this session just read external content"), write **your own** `source` — otherwise two records for the
  same chat cannot be told apart.
- Every rejection/skip must carry a `reason` (a hard rule here since v0.4). No silent failures.

## 5. Config keys that affect you

| Key | Effect |
|---|---|
| `extensionToolsEnabled` | master switch for the provider chain (default off) |
| `taintDryRunEnabled` / `taintWindowMinutes` | taint window (default off; outbound writes become dry-runs inside it) |
| `taintExtraPatterns` | custom injection patterns (regex array, default empty) |
| `longReplySplitOnPunctuation` | whether long replies break at punctuation (default on) |

## 6. Reference implementation

The first plugin set that actually uses this seam (four packages / 20 tools, author-maintained, outside this project's
support scope):

- <https://github.com/551123/dsh-qq-onebot-bridge/tree/patches/0.7.9/ext>
  (the branch always follows our newest tag and `ext/` always sits at its root — only the tag part changes)

Its `ext/README.md` documents installation and the five hard constraints its author learned — useful as real-world reading.

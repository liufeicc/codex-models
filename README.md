**English** | [简体中文](README.zh-CN.md)

# codex-models (cxm)

Switch providers on the fly for Codex: pick a profile in the **/model picker**, and the current
window switches to that profile's full set of settings (gateway + token + model group) —
**independently per window**. You can also switch a running window from another terminal with
`cxm use <profile>`, no restart needed.

**The gateway starts and stops itself**: the first window brings up the local gateway; about 10
seconds after the last window closes, it shuts down on its own. No manual `cxm start` / `cxm stop`.

Zero runtime dependencies: only Node 22 built-ins (`node:http`, `fetch`).

## Install

Prerequisites: **Node 22+** and the **Codex CLI** installed (`codex` on your `PATH`).

```bash
cd /path/to/codex-models
npm install --include=dev    # install tsc (skip if node_modules already present)
npm run build                # must build first: cxm and the shim run the dist/ output
npm link                     # get the global cxm command (first time only)
cxm setup                    # install the codex shim + generate a config template
# edit ~/.codex-models/config.json: fill in each profile's gateway URL and token
# then just run codex and press /model to switch profiles
```

`cxm setup` wires the `codex` command through cxm (a transparent shim), so afterwards you
**keep typing `codex`** as usual — cxm starts the gateway and injects the profile for you.
To revert: `cxm uninstall`.

The shim lives in `~/.codex-models/bin` (cxm's own directory, *not* npm's global bin), and
`cxm install` adds one marked line to your shell startup file (`~/.bashrc` / `~/.zshrc`) so that
this directory comes first on `PATH`. Upgrading Codex with `npm i -g @openai/codex` no longer
wipes the shim, so no re-install is needed afterwards. `cxm uninstall` removes both the shim
and that line.

## 30-second tour

```bash
cxm list          # list profiles (= what /model will show)
cxm              # launch Codex with the default profile; or: cxm dashscope
```

Inside a session:

```
/model  →  the picker shows:
  1. probe · probe-real-model        ← one row per profile: key · its main model
  2. chatter · chat-real-model
  3. deepseek · deepseek-chat
```

Pick a row and every later request from that window goes to that profile. **It only affects the
current window** — other windows keep their own profile. Codex's built-in model rows are filtered
out (removed by the model catalog cxm injects; see "How it works" below).

Another way to switch (no new window, no UI change):

```bash
cxm use deepseek                 # switch the most recently active window
cxm use deepseek --session 7c65  # target one window (cxm sessions lists ids)
cxm use deepseek --last          # same as above (most recently active)
```

> When you run a command inside a window (e.g. Codex executing a shell command), `cxm use`
> automatically targets **that window** — cxm injects a `CXM_SESSION` env var at startup.

## How it works

```
codex (shim directory ~/.codex-models/bin first on PATH → cxm launch)
  ▼
cxm launcher
  │ ensure the shared gateway is up (start it if not)
  │ register the session: get a per-window token (an identity badge, not a credential)
  │ inject: provider → local gateway + this profile's marker model + model catalog
  ▼
cxm local gateway (127.0.0.1:4171, one shared by all windows)
  │ remembers "this window's current profile" by token → rewrites body.model
  │   from marker to the real model, then forwards with that profile's gateway/token
  │   (responses passthrough, or chat translation)
  │ window exits → session deregistered; ~10s after the last session, the gateway exits
  ▼
each profile's real upstream (DashScope / private gateway / DeepSeek …)
```

### 1. The picker shows only your profiles (profile markers)

Codex's `/model` list comes from its "model catalog". When starting a window, cxm replaces the
**entire catalog with one row per profile** via `-c model_catalog_json=…`, so the built-in model
rows (GPT-6-Astra / Sol / Terra …) all disappear and only your profile rows remain.

- each profile's `slug` is the marker `cxm-profile-<key>`; the display name is `key · main model`;
- the entry's metadata (system prompt, context window, tool set, shell type …) is **cloned** from
  one of your Codex built-in catalog entries (`catalogTemplate` picks which; auto by default), so
  behavior matches a built-in profile — only slug/name/context window are changed.

### 2. Switching: the model name in the request *is* the switch

Once you pick a profile row, the `model` in Codex's request is the marker. The gateway sees the
marker → switches profile and rewrites it to that profile's real model. **The rule** (the key to
having two switching paths coexist):

- marker **differs** from the previous request → the user switched via the picker → switch and record;
- marker **equals** the previous request → it's an echo (Codex sends the same `model` every turn)
  → keep the current profile — so a profile changed by `cxm use` won't be silently reverted by the
  next request.

Non-marker models (e.g. from old sessions or Codex internal sub-tasks) don't switch profiles; they
are forwarded under the current profile, and a profile's `modelMap` can map them to one of that
profile's real models.

### 3. Tool mode: classic mode by default (important)

Codex's built-in profile metadata carries `tool_mode = "code_mode_only"` + `use_responses_lite =
true`, which puts Codex into **Code Mode**: instead of a top-level `tools` array, tools go into an
`additional_tools` input item and the model is expected to orchestrate `functions.exec` calls in
JS. Third-party models/gateways generally can't handle this (even cxm's chat translation can't).

Measured (same `codex exec`, only the catalog metadata changed):

| Catalog metadata | Request Codex sends |
|---|---|
| keep `tool_mode` + `use_responses_lite=true` | `input=[additional_tools,message]`, top-level `tools` empty |
| drop `tool_mode` + `use_responses_lite=false` | `input=[message]`, `tools=[exec_command, …]` (classic) |

So cxm writes **classic mode** by default (drop `tool_mode`, disable `use_responses_lite`, disable
`node_repl`) — the most compatible. To try the official Code Mode, set `toolMode` to `"inherit"`.

### 4. Upstream protocol: `responses` passthrough / `chat` translation

Codex 0.159.3 only supports `wire_api = "responses"` (official Codex removed `chat`). So:

- profile with `"wireApi": "responses"` (default): the gateway only rewrites the model name and
  **passes through unchanged**; the upstream must support the Responses API (OpenAI, DashScope
  compatible-mode, recent new-api/one-api, …);
- profile with `"wireApi": "chat"`: the gateway translates the request to `/chat/completions` and
  translates the upstream Chat SSE back into the Responses event stream Codex expects. Good for
  upstreams that only offer Chat Completions (e.g. DeepSeek official).

Known trade-offs of `chat` translation (the gateway logs each):

| Item | Handling |
|---|---|
| `namespace` tools (e.g. `collaboration`) | flattened into `namespace.tool` functions |
| `custom` tools (`apply_patch` free text) | turned into a function with a single string param `input`, restored to `custom_tool_call` on the way back |
| `web_search` tool | no equivalent in Chat; dropped (logs `丢弃工具=web_search`) |
| reasoning (`reasoning_content`) | dropped by default (not risking Codex's reasoning-item validation before it's verified) |
| image input `input_image` | converted to Chat's `image_url` |

### 5. usage normalization (optional, default auto)

Codex estimates context usage from the upstream `usage.input_tokens` and decides when to compact.
The Responses (OpenAI official) convention is that `input_tokens` **includes** cache hits; a few
gateways that wrap an Anthropic-style API into responses report only the non-cached part, so
`cached_tokens` can exceed `input_tokens` — impossible under the OpenAI convention. Codex then
badly underestimates usage, compacts too late, and eventually hits the upstream's context limit.

The gateway only acts when the numbers are self-contradictory: 3 consecutive requests with
`input < cached` → classify that profile as Anthropic convention → afterwards report
`input_tokens` as `input + cached`. A normal OpenAI-convention gateway is never rewritten. Force it
with a profile's `usageNormalize` = `on` / `off`. The verdict is per-profile, held in the gateway
process; `cxm status` shows each profile's current verdict.

### 6. Upstream "context too long" message adaptation (default auto)

Some gateways (common in the new-api family) estimate tokens treating image base64 in the request
body as prose text, so they return:

```
400 This model's maximum context length is 1048576 tokens.
    However, you requested 5004662 tokens (4876662 in the messages, 128000 in the completion).
```

even though the context isn't actually that large. cxm rewrites this into a form carrying the
`context window exceeded` keyword plus a structured `codex_error_info` field (original text kept in
parentheses), giving Codex a chance to classify it as "context over limit". Only "400/413 + JSON +
content-length present and ≤256KB + a parseable limit/requested pair" is recognized; anything else
is passed through unchanged. Disable with a profile's `errorAdapt` = `"off"`.

> Measured note: Codex 0.159.3 doesn't always classify third-party wording as "context over
> limit"; when a session is really stuck, manual `/compact` always works.

### 7. Gateway lifecycle and multi-window isolation

- **Auto-start**: any window that finds the gateway down starts it (`cxm start` also starts it by hand);
- **Auto-stop**: after sessions drop to zero, wait 10 seconds (debounce); if still no window, the gateway exits;
- **Fallback**: if a window is `kill -9`'d or its terminal closes before it can deregister, the gateway probes each session pid every 15 seconds (`process.kill(pid,0)`) and reaps the dead ones; pid-less temporary sessions are reaped after 5 minutes idle;
- **Multi-window isolation**: one token per window; the current profile is recorded per token, routing is stateless. The token is just an identity badge, not a credential (the real token lives only in the gateway and never enters argv).

## Commands

```bash
codex                    # with the shim installed: same as cxm, auto-routed through the gateway (recommended)
cxm                      # the equivalent entry point without the shim
cxm <profile> [codex args...] # launch with a specific profile; Codex args pass through (cxm resume, cxm exec …)
cxm list                 # list profiles (= /model content) and each profile's real model
cxm use <profile>        # switch a running window (--session <id> / --last)
cxm sessions             # list window sessions and their current profiles
cxm start|stop|status    # manage the local gateway (usually automatic; manual start stays resident)
cxm catalog              # regenerate the model catalog; --list shows template candidates; --refresh refetches the built-in catalog
cxm doctor               # self-check (config / real binary / shim / catalog / gateway / sessions)
cxm setup                # one shot: install shim + generate a config template
cxm install|uninstall    # install/remove just the codex shim
cxm init                 # generate just the config template
cxm proxy                # run the gateway in the foreground (debugging; no auto-exit)
cxm -h | --help          # cxm's own help (not passed through to Codex)
```

## Relationship to your global `~/.codex/config.toml`

- cxm **does not modify** your `~/.codex/config.toml`: profiles, provider and model catalog are all
  injected at launch via `-c key=value` overrides, effective only for windows started through cxm;
- running the real binary directly (bypassing the shim) still uses your own `config.toml`, and is
  unaffected by cxm;
- your own `-c` / `-m` args come after cxm's injected args, so they can override cxm's defaults.

## FAQ

- **Port already in use**: change `port` in the config, or `cxm stop` and retry;
- **Gateway log**: `~/.codex-models/run/proxy.log` (per-request `session/profile/model rewrite/protocol/status/upstream/latency/usage`, plus register, switch, reap, exit records);
- **Profiles missing from the picker**: make sure this session was started via `codex` (the shim) or `cxm`;
- **A newly added profile doesn't show in an open window**: the model catalog is **frozen at window start**; reopen the window (the gateway side takes effect immediately);
- **`cxm use` switched the profile but the UI's model label didn't change**: expected — the label is Codex's own view; the actual requests already go to the new profile. To make both agree, switch via `/model`;
- **Upgrading Codex no longer breaks the shim**: the shim lives in `~/.codex-models/bin` with that directory first on `PATH`, so npm's upgrade of `@openai/codex` can't touch it. If you migrated from an older cxm, one `cxm install` moves the old shim out of npm's bin directory. `cxm doctor` warns when the shim is installed but not first on `PATH` (e.g. after switching to a shell cxm can't edit, like fish);
- **After editing config / restarting the gateway, what about open windows?**: the catalog is frozen at window start, so new profiles won't show in `/model`; reopening is easiest. Old windows keep working (their next request falls back to `defaultProfile`, logged as a temporary session). A gateway started by hand with `cxm start` stays resident (won't auto-exit with no windows), so windows open during a restart aren't refused;
- **"Cannot find the real Codex binary"**: the shim records the real path in its `# CXM_REAL_CODEX:` line, so cxm can recover it even if `state.json` is lost or `CXM_HOME` changed; if all else fails, set `"codexBin": "/path/@openai/codex/bin/codex.js"` in the config;
- **A profile reports "warming up" / won't connect**: `cxm status` to check the gateway, `cxm doctor` to check item by item.

## Known limitations

- Rewriting `body.model` requires buffering the whole request body (up to 64MB);
- After changing gateway code (`proxy.ts` etc.), you must `cxm stop` and restart (code is not hot-reloaded; config is); `cxm stop` invalidates open windows' session tokens, so their next requests fall back to the default profile — prefer restarting when no windows are open;
- Catalog entries must carry the system prompt and other required fields, or Codex errors with `failed to parse model_catalog_json … missing field x`; cxm clones built-in entries, but **a major Codex upgrade may add/remove fields** — after upgrading, run `cxm catalog --refresh`;
- `chat` translation covers text / function calls / custom tools / images; if the upstream returns non-standard events (e.g. tool arguments that aren't a JSON string), cxm falls back to the raw text rather than breaking the session.

## Development

```bash
npm run build     # compile tsc to dist/
npm run dev       # tsc --watch
```

```
src/
├── cli.ts        # command dispatch (list/use/sessions/install/doctor/…)
├── config.ts     # config loading (JSONC), profile derivation, directory resolution
├── catalog.ts    # model catalog generation (clone template + tool mode)
├── proxy.ts      # core gateway: session table, switch routing, forwarding, admin API, lifecycle
├── translate.ts  # Responses ⇄ Chat Completions translation
├── adapt.ts      # usage normalization + context-error message adaptation
├── daemon.ts     # gateway daemon management (probe/start detached/stop)
├── codexBin.ts   # locate the real Codex binary + install/remove the codex shim
├── shellPath.ts  # inject/remove the shim directory in the shell startup file's PATH
├── launch.ts     # launch Codex: register session, inject profile, pass args
└── proxy-main.ts # daemon entry point
```

Regression tests (all against local fake upstreams, no network):

```bash
npm run build && npm test      # test/e2e.sh: 17 assertions covering rewrite/translate/switch/normalize/message adaptation
```

The script creates an isolated `CXM_HOME`, starts its own fake upstreams, and pins the real Codex
binary (on a machine with the shim installed, `codex` on `PATH` is the shim itself, so without
pinning the result drifts by environment). It cleans up afterwards.

Real-upstream smoke test (optional; sends one real request and consumes quota):

```bash
codex exec --skip-git-repo-check "reply with exactly: link ok"   # single responses-protocol profile
cxm list && cxm doctor                                           # re-verify profiles and connectivity
```

Isolated test (without touching your production environment):

```bash
CXM_HOME=/tmp/cxm-test node dist/cli.js list
# isolated config dir + port; CXM_HOME decides where config/runtime/catalog files live
```

For more implementation detail and measured findings, see [CLAUDE.md](CLAUDE.md).

## License

[MIT](LICENSE) © 2026 liufei

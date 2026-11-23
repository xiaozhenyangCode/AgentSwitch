# Reasonix as the 4th engine — design

Date: 2026-11-23 · Status: awaiting approval (rev 2: builder-check questions resolved)

## Intent

The maintainer uses DeepSeek through Reasonix (`reasonix`, v2.61.0) and finds it more
accurate, less wordy and cheaper than DeepSeek run through Claude Code. They want Reasonix
in AgentSwitch as a fourth engine next to Claude, Gemini (agy) and Codex: same chat, same
multi-model collaboration, same account list.

Reasonix is a coding agent CLI with its own prompts, tools, effort defaults (`flash` →
`low`) and prompt-cache discipline. Those, not the model, are what make it feel better.
So we run the Reasonix CLI itself rather than copying its settings into Claude Code.

## Verified behaviour (2026-11-23, real key, throwaway `REASONIX_HOME` in /tmp, since deleted)

- `REASONIX_HOME=<dir>` relocates everything: `config.toml`, `.env`, `projects/` (sessions),
  `cache/`, `stats/`, `provider-keys.json`, locks.
- **The key is read only from `<REASONIX_HOME>/.env`.** `DEEPSEEK_API_KEY` in the process env
  is ignored (despite `--help` saying "Secrets come from the environment"). With an empty
  `.env` the run fails with
  `provider "deepseek-flash": no stored key for DEEPSEEK_API_KEY in <home>/.env; run 'reasonix setup'`.
- `reasonix -p --output-format stream-json [--model M] [--effort L] [--permission-mode P]
  [--resume <sessionId>] [--add-dir PATH] <task>` streams one JSON object per line and exits 0.
  Stderr was empty on success.
- `--resume <sessionId>` continues the conversation (second turn correctly answered "a.txt").
- `reasonix run --events-jsonl` is **redacted** (event kinds, no text) — not usable.
- Cost of a small tool-using turn: ≈ $0.0005; cache hit 6528 / 6735 prompt tokens.

### stream-json schema (observed)

Every line except the last has `kind`, `sessionId`, `turnId`, `seq`, `status`.

| kind | useful fields |
|---|---|
| `turn_status` | `status: queued` |
| `turn_started` | `modelRef` e.g. `deepseek/deepseek-flash` |
| `user_message`, `turn_phase`, `stream_attempt` | ignored (attempt retries could show as a note) |
| `tool_dispatch` | `tool{id,name,args(JSON string),readOnly,partial}` — first a `partial:true` copy without args, then the full one |
| `tool_started` | `tool{id,name,startedAt}` |
| `tool_result` | `tool{id,name,args,output,startedAt,endedAt}` |
| `text` | streaming delta `text` |
| `message` | full assistant text of this step |
| `usage` | `usage{promptTokens,completionTokens,cacheHitTokens,cacheMissTokens}` per request |
| `turn_done` | `status: completed` |

Last line: `{"type":"result","subtype":"success"|"error_during_execution","is_error",
"result":<final text or error message>,"session_id","total_cost_usd","currency",
"usage":{input_tokens,output_tokens,cache_read_input_tokens,...},"permission_denials",...}`.

Not yet observed: a reasoning/thinking event (`--show-thinking` is off by default and the
probe tasks didn't think visibly), approval-request events in `-p` mode. The plan's first
task captures these with a harder prompt and `--show-thinking`.

## Approaches

- **A. Spawn the CLI per turn (chosen).** `reasonix -p --output-format stream-json`, one process
  per turn, `--resume` for continuity. Same shape as the Claude/Codex/agy adapters; reuses
  `agentRunner` spawn, stop, logging and event plumbing. Cost: process start per turn
  (~1 s first token measured), no in-chat approvals.
- **B. ACP (`reasonix acp`), later.** The agy ACP runtime (`src/main/acp/`) already exists. A
  persistent Reasonix ACP session would give in-chat approvals and no per-turn startup.
  Deferred: A first, B as a follow-up once A is proven, swapping only the runtime.
- **C. Copy Reasonix's settings into Claude Code (rejected).** Effort/prompt tweaks on Claude
  Code don't reproduce Reasonix's tool set, prompts or cache behaviour; the maintainer
  explicitly wants Reasonix's logic.

## Goals

- `reasonix` is a new `ProfileKind`: shows in the account list, model picker, chat, history,
  usage and collaboration flows like the other three.
- **Option 1 — import:** add the existing `~/.reasonix` as an account. AgentSwitch never
  reads, writes or displays its `.env`.
- **Option 2 — new account:** AgentSwitch creates a managed `REASONIX_HOME`, writes a DeepSeek
  `config.toml` and the key into `<dir>/.env` (mode 0600). The UI says plainly that Reasonix
  keeps its key in plain text in its own directory.
- Thinking is folded by default.

## Non-goals (v1)

- ACP runtime, in-chat tool approvals (approach B).
- Providers other than the DeepSeek preset for new accounts (imported accounts keep whatever
  their `config.toml` has; the model picker lists it).
- Local models, Reasonix login (`reasonix login` is forum-only), `serve`/`web`/`review`.
- Editing an imported account's `config.toml`.

## Anti-goals

- Touching the user's real `~/.reasonix/.env` or writing anything into `~/.reasonix` for an
  imported account beyond what Reasonix itself writes during a run.
- The key appearing anywhere except `<dir>/.env`: not in `config.json`, logs, debug banner,
  env preview, toasts, argv, or `secrets.json` decrypt paths logged.
- A Reasonix failure being silent. Every non-success `result` surfaces its `result` text.

## Design

### Kind and metadata (`src/shared/types.ts`, i18n, `brandIcons.tsx`)

- `ProfileKind = 'claude' | 'gemini' | 'codex' | 'reasonix'`; append to `KINDS`.
- `KIND_META.reasonix = { name: 'Reasonix', cli: 'reasonix', vendor: 'DeepSeek', letter: 'R', ... }`.
- Icon: reuse `DeepSeekIcon` with a small "R" badge (no Reasonix brand asset copied).
- Every `Record<ProfileKind, …>` that the compiler flags gets a `reasonix` entry; places
  that switch on kind with a default branch are checked one by one (list in the plan from
  `grep "'gemini'"`: agentRunner, apiKey, extensions, history, ipc, models, orchestrator,
  profiles, usage, acp/pool, LoginModal, ProfileConfigModal, WorkbenchPage, state/chat,
  state/usage).

### Accounts (`src/main/profiles.ts`)

- `KIND_DEFAULTS.reasonix`: default config dir `~/.reasonix`, `COMMAND_DEFAULTS`: run
  `reasonix`, no login command.
- `isolationEnv`: `{ REASONIX_HOME: dir }`. Always set, also for the imported `~/.reasonix`
  (explicit beats implicit). `REASONIX_TELEMETRY` is left alone.
- `stripCredentials('reasonix', env)` drops inherited `DEEPSEEK_API_KEY` etc. (harmless since
  Reasonix ignores them, but keeps env previews clean).
- **Signed in** (`detectLoggedIn`): parse `config.toml`, find the provider of `default_model`,
  read its `api_key_env`, and check that `<dir>/.env` has a non-empty line for that name.
  The value is read into memory only to test non-emptiness and never returned.
- **Import (option 1):** the "add account" flow for Reasonix offers "Use existing ~/.reasonix"
  when that dir exists. Saved as `imported: true`. Not signed in → message "run
  `reasonix setup` in a terminal" (we don't drive its TUI wizard).
- **New (option 2):** a form like the API-key form (name, DeepSeek key, default model
  `deepseek-flash` | `deepseek-v4-pro`). `prepareProfileDir` creates the managed dir (0700)
  and writes:
  - `config.toml` from a built-in template (`src/main/reasonixTemplate.ts`): `config_version = 12`,
    `default_model = "<chosen>"`, `language` from the app locale, and exactly this provider
    block (copied from the maintainer's working config; Reasonix model ids, unrelated to the
    `[1m]` ids of the Claude Code DeepSeek preset):

    ```toml
    [[providers]]
    name        = "deepseek"
    kind        = "anthropic"
    base_url    = "https://api.deepseek.com/anthropic"
    models      = ["deepseek-flash", "deepseek-v4-pro"]
    default     = "deepseek-flash"
    api_key_env = "DEEPSEEK_API_KEY"
    balance_url = "https://api.deepseek.com/user/balance"
    context_window = 1000000
    prices      = { "deepseek-flash" = { cache_hit = 0.003, input = 0.15, output = 0.6, currency = "$" }, "deepseek-v4-pro" = { cache_hit = 0.022, input = 0.66, output = 1.98, currency = "$" } }
    billing_currency = "USD"
    thinking    = "enabled"
    vision_models = ["deepseek-flash"]
    web_search  = true
    model_overrides = { "deepseek-flash" = { supported_efforts = ["disabled", "low", "high", "max"], default_effort = "low", vision = true }, "deepseek-v4-pro" = { supported_efforts = ["disabled", "high", "max"], default_effort = "high" } }
    ```

    Everything else is left to Reasonix's built-in defaults;
  - `.env` with `DEEPSEEK_API_KEY=<key>`, created with `open(..., 'wx', 0o600)` / rewritten
    via temp file + rename at 0600.
  - The key is passed from the renderer once over IPC and is **not** kept in
    `secrets.json` (it would be a second copy). Changing the key rewrites `.env`.
  - Warning shown in the form and in the account's config modal:
    "Reasonix 把密钥以明文保存在它自己的目录 `<dir>/.env`（仅本人可读）。AgentSwitch 不另存副本。"
- Deleting an account follows the app convention (config only, the dir stays) **with one
  exception**: for a managed Reasonix account, the `.env` file is deleted so the plaintext key
  doesn't outlive the account. Guard: only when `realpath(dir)` is inside
  `userData/profiles/<id>/` and the account is not `imported`; never `~/.reasonix`.
  Deleting an imported account never touches `~/.reasonix`.

### Runner (`src/main/agentRunner.ts`)

New `reasonixAdapter(spec)`:

- args: `-p --output-format stream-json`, `--model <m>` if set, `--effort <e>` if set,
  `--permission-mode <p>` when mapped (below), `--resume <sid>` if the chat has one, then the
  prompt. (`--add-dir` is not used in v1; `RunSpec` has no extra-dir field.) Prompt in argv like agy (`stdin: null`), built with `full(spec)`.
  Long prompts: check argv limit; if needed fall back to stdin (`echo … | reasonix -p`
  is supported per help) — the plan verifies which.
- Permission mapping from the account's `autoApprove`, matching what `'cli'` means for the
  other engines: `cli` → **no flag** (Reasonix's own `[permissions]` config applies), `edits` →
  `acceptEdits`, `full` → `bypassPermissions`. No reviewer-specific read-only mode in v1 —
  reviewers run with the account's setting like every other engine. Plan task 1 checks what
  `-p` does when its own config would ask for approval (deny + `permission_denials`, or hang);
  a hang would force `cli` → `auto`.
- `onLine`:
  - `turn_started` → record `modelRef` as model.
  - `text` → text delta. `message` → ignored when deltas were seen (avoid duplicates).
  - `tool_dispatch` with `partial:false` → tool-start activity (name + capped args);
    map `read_file`/`write_file`/`edit_file`/`shell`… onto the existing tool categories.
  - `tool_result` → tool output (`capText`).
  - reasoning kind (name confirmed in plan task 1) → thinking event, which the UI folds.
  - `usage` → accumulate prompt/completion/cache hit/miss.
  - `result` → `ok = !is_error`, `error = is_error ? result : null`, `sessionId = session_id`,
    cost `total_cost_usd`.
- Rate limit / invalid key: reuse `RATE_LIMIT_RE`, `isInvalidKeyError`; add the
  `no stored key for` message → "not signed in" hint.

### Models (`src/main/models.ts`)

Parse `<dir>/config.toml` `[[providers]]` → `models` (+ `default`). No network call. Effort
choices from `model_overrides[m].supported_efforts`, default `default_effort`.

### History (`src/main/history.ts`)

Session ids are kept per chat like the other engines. Listing past Reasonix sessions uses
`reasonix session list --json --dir <cwd>` (redacted metadata only) if the history page
needs it; v1 may show AgentSwitch's own transcript only. Plan decides after checking what
the history page requires of an engine.

### Usage (`src/main/usage.ts`, renderer usage state)

No subscription quota (`hasSubscriptionQuota` false). Show per-run cost (USD, and CNY from
`result.cost_quote.valuations.CNY` when present — observed in the probe) and cache hit rate from the `usage` events. Optional later: DeepSeek
balance API.

### Thinking display (`Process.tsx`)

Finished thinking blocks already render collapsed for every engine; Reasonix thinking events
use the same event type and get the same behaviour. No change to `Process.tsx` in v1.

### Install / detection

`reasonix` not on PATH → the account shows "未安装", with `npm i -g reasonix`. Note in the UI
that the package is no longer maintained upstream (last release 2026-11-12) and pin-tested
against 2.61.0; the adapter ignores unknown event kinds.

## Testing

- Unit: adapter `onLine` against recorded stream-json fixtures (the probe output above,
  a failing run, a thinking run); `detectLoggedIn` on fixture dirs; `.env` writer mode 0600
  and no key in `config.json`/logs; permission mapping; model parsing from `config.toml`.
- Manual: import `~/.reasonix`, chat, resume across turns, stop mid-turn, collaboration with
  Claude reviewing Reasonix's change; create a new account with a key and run.

## Risks

- **Unmaintained upstream.** Schema may not change, but bugs won't be fixed. Mitigation:
  tolerant parser, version shown in the account card.
- **Plaintext key** in option 2 — accepted by the maintainer, disclosed in the UI.
- **Project config override:** a `reasonix.toml` in the chat's cwd can change provider/model.
  Accepted (it's Reasonix's own behaviour); the model shown comes from `turn_started.modelRef`.
- **Concurrent runs on one home** (two chats on the same account): Reasonix uses locks under
  `locks/`; plan verifies two parallel `-p` runs don't block or corrupt.

# API-key accounts (official keys for all three CLIs + DeepSeek / custom for Claude Code) — design

Date: 2026-11-23 · Status: awaiting approval (rev 2: scope widened to all three CLIs)

## Intent

Today every account signs in through the CLI's browser OAuth flow. The maintainer wants a
second way to connect an account: **paste an API key**. Two cases:

1. **Official keys** for each CLI: Anthropic key for Claude Code, OpenAI key for Codex,
   Gemini API key for Gemini (agy).
2. **Third-party Anthropic-compatible endpoints** run through Claude Code, starting with
   **DeepSeek**, plus a **Custom** endpoint for anything else.

API-key accounts must work **side by side with subscription-signed-in accounts of the same
CLI**, including in the same conversation (e.g. DeepSeek writes, official Claude reviews).

DeepSeek has no CLI of its own. Its documented path is to run Claude Code against
`https://api.deepseek.com/anthropic`
([DeepSeek: Claude Code](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code),
[DeepSeek: Anthropic API](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)).

## Verified behaviour (2026-11-23, fake keys, empty config dirs)

Tested with Claude Code 2.1.330, Codex 0.171.0 and the installed agy. In every case below
the key was passed **only as an environment variable**, the request reached the vendor
(which rejected the fake key), and a recursive grep of the config dir afterwards found
**no copy of the key on disk**.

| CLI | Key mechanism | Result with a fake key |
|---|---|---|
| Claude Code, Anthropic key | `ANTHROPIC_API_KEY` | `Invalid API key` from Anthropic |
| Claude Code, DeepSeek | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL` | reaches DeepSeek; stderr warns `[claude-code:unrecognized_model]` (harmless) |
| Codex | `CODEX_API_KEY` (**not** `OPENAI_API_KEY`, which Codex ignores) | `codex exec` → `turn.failed`, `401 invalid_api_key` from `api.openai.com/v1`; no `auth.json` written |
| Gemini (agy) | `GEMINI_API_KEY` **plus** setting `modelProvider: "gemini"` | without the setting agy ignores the key and asks for OAuth; with `--settings '{"modelProvider":"gemini"}'` → `400 API key not valid` from the Gemini API |

So `codex login --with-api-key` (which writes the key to `auth.json` in plain text) is **not**
used. All three CLIs get the key from the spawn env only.

## Goals

- Any account can be connected by **official sign-in** (today) or **API key**.
- API key, official: Claude (Anthropic), Codex (OpenAI), Gemini (Google AI Studio key).
- API key, third-party, Claude Code only: **DeepSeek** preset and **Custom** endpoint.
- API-key accounts run alongside sign-in accounts with no cross-talk.
- The key is never stored or shown in plain text.
- Third-party accounts show their own identity: default name "DeepSeek 1", DeepSeek icon,
  DeepSeek models in the model picker.

## Non-goals (v1)

- Third-party endpoints for Codex or Gemini. Codex + DeepSeek needs a local
  Responses→Chat translation proxy; agy's `GOOGLE_GEMINI_BASE_URL` exists but is untested.
- Kimi / GLM / other presets (adding one later = one preset entry + icon).
- Vertex AI / Google Cloud project auth for agy, Bedrock / Vertex for Claude.
- Validating the key when it is saved. The first chat run surfaces auth errors.
- Usage quotas for API-key accounts (there are none; see Usage).

## Anti-goals (would make this a failure even if it "works")

- The key appearing anywhere in plain text: `config.json`, CLI config dirs, the debug
  drawer's spawn banner, the account settings "environment preview", logs, crash output.
- A sign-in account silently using a key or third-party endpoint because the user exported
  one in `~/.zshrc`.
- An API-key account touching the real `~/.claude`, `~/.codex` or `~/.gemini`.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Each account gets an optional **connection**: sign-in (default) or API key; Claude's API-key option also offers provider presets (Anthropic / DeepSeek / Custom). | Small maintenance cost per preset; best UX; scales to Kimi/GLM later. |
| B | Generic "endpoint + key + model" fields only, no presets. | Least code; users must look up URLs/model names; DeepSeek shows as a plain "Claude account". |
| C | New top-level engine kind `deepseek`. | Still runs `claude`; touches every `kind` switch in the app for no extra benefit. |

The maintainer picked **A**, with official keys for all three CLIs plus DeepSeek + Custom.
Build order: shared plumbing → DeepSeek end to end (validates the whole path) → official
keys for Claude, Codex, Gemini.

## Design

### Data model

`ProfileConfig` (src/shared/types.ts) gains one optional field. Absent = official sign-in,
so existing accounts need no migration:

```ts
apiKey?: {
  provider: 'official' | 'deepseek' | 'custom'   // deepseek/custom only for kind 'claude'
  baseUrl?: string    // deepseek: fixed; custom: required; official: unset
  models?: string[]   // deepseek: preset; custom: required (>=1); official: unset (CLI's list)
}
```

The key itself is **not** in `ProfileConfig`.

Presets in one table in the main process (new `src/main/providers.ts`):

```ts
deepseek: {
  label: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: ['deepseek-flash[1m]', 'deepseek-v4-pro[1m]'],  // first = default, as in DeepSeek's doc
  smallModel: 'deepseek-flash',                            // background tasks / subagents
  env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' }       // from DeepSeek's doc
}
```

Model ids follow DeepSeek's doc. Verify them against the doc at implementation time; they
have changed before. The picker shows them without the `[1m]` suffix.

### Key storage

- Encrypt with Electron `safeStorage` (Keychain-backed key on macOS) and store the
  ciphertext in `userData/secrets.json` as `{ [profileId]: base64 }`, file mode 0600.
- Main process only. The renderer can set/replace a key and ask `hasKey`; it never gets a
  key back.
- `removeProfile` deletes the entry.
- If `safeStorage.isEncryptionAvailable()` is false, refuse to save and show an error;
  never fall back to plaintext.

### Spawn env (src/main/profiles.ts `buildSpawnSpec` / `isolationEnv`)

Order (later wins):

1. base env from the login shell, minus the **credential vars of this CLI kind** (list below)
2. isolation var (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `HOME`); API-key accounts are always
   in an AgentSwitch-managed directory
3. API-key env (below), only for API-key accounts
4. the account's `extraEnv` (unchanged; a deliberate user override still works)

Step 1 applies to **every** account, including sign-in ones, so a global export in
`~/.zshrc` can't change which account or endpoint a sign-in account uses.

Credential vars per kind:
- claude: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
  `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`
- codex: `CODEX_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`
- gemini: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`,
  `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`

API-key env:

| Account | Env |
|---|---|
| Claude, official | `ANTHROPIC_API_KEY` = key |
| Claude, DeepSeek / Custom | `ANTHROPIC_BASE_URL` = baseUrl; `ANTHROPIC_AUTH_TOKEN` = key; `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` = account `defaultModel` or `models[0]`; `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` = preset `smallModel` (Custom: same as `ANTHROPIC_MODEL`); preset `env` |
| Codex, official | `CODEX_API_KEY` = key |
| Gemini, official | `GEMINI_API_KEY` = key, and agy must see `modelProvider: "gemini"` (see below) |

**agy `modelProvider`**: write `{"modelProvider":"gemini"}` into the settings file inside the
account's own isolated HOME (it holds no secret), so every agy invocation of that account
(chat runs, model list, usage probe, built-in terminal) picks it up. Never touch the real
`~/.gemini`. If the settings file location turns out to be unreliable, fall back to passing
`--settings '{"modelProvider":"gemini"}'` on every agy invocation. The builder verifies
which file agy reads.

Model choice per message is unchanged (`--model <id>`); for DeepSeek/Custom the picker lists
`apiKey.models`.

### Secret masking

`SpawnSpec.injected` feeds the debug-drawer banner (`ptyManager.start`) and the settings
"environment preview" (`envPreview`). The key must appear masked in both: first 3 + last 4
chars (`sk-…abcd`), or `••••` when shorter. `injected` carries the masked value; the real
value goes only into `env`. Check no other path prints `env`.

### Signed-in state

`detectLoggedIn` for an API-key account = a key exists in the secret store.
API-key accounts have no login session, so `loginSignature` and the login sheet don't apply.

### UI

**Add account** (Engines page, per CLI section): "Add <CLI> account" first asks how to connect.

Claude:
```
How should this account connect?
  (•) Sign in with Claude (subscription)        ← today's flow, unchanged
  ( ) Anthropic API key
  ( ) DeepSeek API key
  ( ) Custom endpoint (Anthropic-compatible)
```
Codex: `Sign in with ChatGPT` / `OpenAI API key`.
Gemini: `Sign in with Google` / `Gemini API key`.

- Key-only options → one password field (paste-friendly) + link to the vendor's key page.
- Custom → endpoint URL, key, model ids (at least one).
- Save creates the account in a managed directory and stores the key. No browser.

**Account row**: API-key accounts show `API key` (or `DeepSeek · API key`) instead of the
directory detail. The row's "log in" action becomes "Change API key".

**Account settings modal** (ProfileConfigModal): for API-key accounts, a section with the
connection type, endpoint (read-only for DeepSeek), models (editable for Custom) and
"Replace key". Login command fields are hidden for API-key accounts.

**Identity**: DeepSeek accounts default to "DeepSeek 1", "DeepSeek 2"; Custom to
"Custom API 1". Official-key accounts keep the normal default ("Claude 账号 3") and the CLI
icon. Avatar: DeepSeek logo for DeepSeek; CLI icon with a small "API" badge for Custom.
`KindAvatar` is used in ~37 places with only `kind`; add a profile-aware avatar (or an
optional prop) so chat headers, the @-picker and account lists show it.

All new strings in the 4 locale files (en, zh-CN, zh-TW, ja).

### Usage & quotas

- Claude: skip the OAuth `/api/oauth/usage` lookup for API-key accounts.
- Codex: skip any ChatGPT-plan quota lookup for API-key accounts.
- Gemini: the existing `/usage` probe already treats exit code 2 as "API key, no quota";
  skip the probe entirely for API-key accounts.
- Keep local context-window stats where the run output provides token counts.
- Hide the 5-hour / 7-day quota UI for API-key accounts.

### Run output

Drop Claude Code's `[claude-code:unrecognized_model] …` stderr line (and the
"doesn't recognize the model" warning above it) for DeepSeek/Custom accounts so it doesn't
show as an error in chat.

### Sessions

API-key accounts have their own config dir, so their `sessionStoreKey` differs from
sign-in accounts; cross-account continuation keeps using the existing handoff path.

## Error cases

- Wrong / revoked key: the CLI fails the turn as above; the run shows it as today, with an
  added hint "Check the API key in account settings" when the error mentions an invalid key
  (Anthropic `Invalid API key`, OpenAI `invalid_api_key`, Gemini `API key not valid`).
- Endpoint unreachable: surfaced as the CLI's error.
- Keychain unavailable: saving the key fails with a clear message; nothing is written.
- CLI not installed: same "install CLI" state as any account of that kind.

## Testing

- Unit: env builder per kind × connection (credential vars stripped for sign-in accounts;
  API-key vars present; extraEnv wins; key absent from `injected`).
- Unit: secret store round-trip, delete on account removal, no plaintext on disk.
- Integration (fake keys, as in "Verified behaviour"): each kind × API-key connection
  reaches its vendor and fails with the vendor's invalid-key error; grep the account dir
  for the key afterwards → no match.
- Manual with real keys: DeepSeek account and official Claude account in the same
  conversation; debug drawer and env preview show a masked key; with `ANTHROPIC_BASE_URL`
  exported in `~/.zshrc`, the sign-in Claude account still uses Anthropic.

## Calls I made (for review)

- Keys go only through env vars; `codex login --with-api-key` is not used (writes plaintext).
- Claude third-party endpoints use `ANTHROPIC_AUTH_TOKEN` (DeepSeek's documented variable);
  the official Anthropic key uses `ANTHROPIC_API_KEY`.
- `safeStorage` + `secrets.json` rather than writing Keychain items directly.
- No key validation on save in v1.
- DeepSeek default model `deepseek-flash` (DeepSeek's own default, cheaper); `deepseek-v4-pro`
  is one click away in the model picker.
- `CLAUDE_CODE_EFFORT_LEVEL=max` from DeepSeek's doc is left out: effort is a per-message
  choice in AgentSwitch.
- Credential vars are stripped from the inherited env for **all** accounts, not just Claude.

## Left to the builder

File layout inside `src/main` and `src/renderer`, the exact add-account dialog layout,
IPC channel names, how the model picker reads `apiKey.models`, and which agy settings file
holds `modelProvider`.

# API-key Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any account connect with an API key instead of browser sign-in: official keys for Claude Code, Codex and Gemini (agy), plus DeepSeek and custom Anthropic-compatible endpoints for Claude Code.

**Architecture:** Keys live encrypted (Electron `safeStorage`) in `userData/secrets.json`, never in `config.json`. A new pure module `src/main/apiKey.ts` turns an account's `apiKey` config + key into spawn env (and a masked copy for display); `profiles.ts` wires it into `buildSpawnSpec`, strips inherited credential vars for every account, and treats "key present" as signed in. UI adds a connection choice to the add-account dialog and key management to the account settings.

**Tech Stack:** Electron 45, React, TypeScript, node-pty, vitest (new, dev-only).

**Spec:** `docs/superpowers/specs/2026-11-23-api-key-accounts-design.md`

## Global Constraints

- Work in the worktree `/Volumes/oneday/NewProject/AgentSwitch-api-keys`, branch `feat/api-key-accounts`. Never edit `/Volumes/oneday/NewProject/AgentSwitch` (main checkout; other agents work there).
- A key must never be written in plain text anywhere: `config.json`, CLI config dirs, logs, the debug-drawer banner, the env preview, error toasts.
- Key env vars, exactly: Claude official `ANTHROPIC_API_KEY`; Claude DeepSeek/Custom `ANTHROPIC_AUTH_TOKEN`; Codex `CODEX_API_KEY` (not `OPENAI_API_KEY`); Gemini `GEMINI_API_KEY` + `modelProvider: "gemini"` in `<HOME>/.gemini/antigravity-cli/settings.json`.
- Never run `codex login --with-api-key` (it writes the key to `auth.json`).
- DeepSeek preset: base URL `https://api.deepseek.com/anthropic`; models `['deepseek-flash[1m]', 'deepseek-v4-pro[1m]']` (first = default); small model `deepseek-flash`; extra env `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432`. Do not set `CLAUDE_CODE_EFFORT_LEVEL`.
- API-key accounts always use an AgentSwitch-managed config dir (never `~/.claude`, `~/.codex`, real `~/.gemini`).
- The connection is chosen when the account is created. v1 does not convert an existing sign-in account to API key or back.
- All new UI strings go in all 4 locales: `src/shared/i18n/{en,zh-CN,zh-TW,ja}.ts`.
- `pnpm typecheck` and `pnpm test` pass at the end of every task. Commit per task, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Installs need the proxy: prefix `pnpm add` with `NODE_USE_ENV_PROXY=1`.

## Review Focus

1. **Key pasted with spaces or a trailing newline** → stored trimmed; an all-whitespace key is rejected. Test in Task 2.
2. **A plaintext key already sitting in an account's `extraEnv`** (allowed today) → the env preview and debug banner mask it like a stored key. Test in Task 1.
3. **Custom endpoint typed as `https://host/anthropic/` or with spaces, or `ftp://…`** → trailing slash and whitespace removed; anything not `http(s)://` rejected with a clear error. Test in Task 1.
4. **`secrets.json` missing, corrupt, or `safeStorage` unavailable** → no crash; the account reads as "not signed in"; saving a key shows an error and writes nothing. Test in Task 2.
5. **User exports `ANTHROPIC_BASE_URL` / `CODEX_API_KEY` / `GEMINI_API_KEY` in `~/.zshrc`** → a sign-in account's spawn env does not contain them. Test in Task 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `vitest.config.ts` (new) | test runner config, `@shared` alias |
| `src/shared/types.ts` | `ApiKeyConfig`, `API_KEY_PAGES`, `ProfileConfig.apiKey`, IPC names |
| `src/main/apiKey.ts` (new, pure, no electron import) | presets, credential var lists, env building, masking, validation, error helpers |
| `src/main/apiKey.test.ts` (new) | unit tests for the above |
| `src/main/secrets.ts` (new) | encrypted key store; `createSecretStore` is pure (cipher injected), `secrets()` binds to `safeStorage` |
| `src/main/secrets.test.ts` (new) | unit tests with a fake cipher |
| `src/main/profiles.ts` | wire env, managed dirs, signed-in state, agy settings file, removal |
| `src/main/ipc.ts`, `src/preload/index.ts`, `src/preload/index.d.ts` | add-with-key, set-key IPC |
| `src/main/usage.ts`, `src/main/models.ts`, `src/main/agentRunner.ts` | skip quotas, model list for DeepSeek/Custom, filter Claude model warning, invalid-key hint |
| `src/renderer/src/components/dialogs.tsx` | connection choice + key fields in `AddAccountModal` |
| `src/renderer/src/components/ProfileConfigModal.tsx` | API-key section: replace key, edit models (Custom) |
| `src/renderer/src/pages/EnginesPage.tsx` | row detail text, "Change API key" action |
| `src/renderer/src/components/common.tsx`, `brandIcons.tsx` | `ProfileAvatar` (DeepSeek logo, "API" badge) |
| `src/shared/i18n/*.ts` | strings |

---

### Task 1: Test runner + pure env module

**Files:**
- Create: `vitest.config.ts`, `src/main/apiKey.ts`, `src/main/apiKey.test.ts`
- Modify: `package.json` (devDependency `vitest`, script `"test": "vitest run"`), `src/shared/types.ts`

**Interfaces:**
- Produces (in `src/shared/types.ts`):
  ```ts
  export type ApiKeyProvider = 'official' | 'deepseek' | 'custom'
  export const API_KEY_PAGES: Record<'claude' | 'codex' | 'gemini' | 'deepseek', string>  // renderer uses these links
  export interface ApiKeyConfig { provider: ApiKeyProvider; baseUrl?: string; models?: string[] }
  // ProfileConfig gains: apiKey?: ApiKeyConfig
  ```
- Produces (in `src/main/apiKey.ts`):
  ```ts
  export const DEEPSEEK: { label: string; baseUrl: string; models: string[]; smallModel: string; env: Record<string, string> }
  export const CREDENTIAL_VARS: Record<ProfileKind, string[]>
  export const SECRET_VARS: string[]   // ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CODEX_API_KEY','GEMINI_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY']
  export function resolveApiKeyConfig(kind: ProfileKind, cfg: ApiKeyConfig): ApiKeyConfig   // fills DeepSeek baseUrl/models
  export function validateApiKeyConfig(kind: ProfileKind, cfg: ApiKeyConfig): string | null // i18n key or null; also normalizes baseUrl in place
  export function apiKeyEnv(kind: ProfileKind, cfg: ApiKeyConfig, key: string, defaultModel: string): Record<string, string>
  export function stripCredentials(kind: ProfileKind, base: Record<string, string>): Record<string, string>
  export function maskSecret(v: string): string
  export function maskEnv(env: Record<string, string>): Record<string, string>   // masks SECRET_VARS entries
  export function displayModel(id: string): string    // strips a trailing "[1m]"
  export function isInvalidKeyError(text: string): boolean
  export function isClaudeModelWarning(line: string): boolean
  ```

- [ ] **Step 1: Add vitest.** `NODE_USE_ENV_PROXY=1 pnpm add -D vitest`; add `"test": "vitest run"`; `vitest.config.ts` with `test.include: ['src/**/*.test.ts']`, `environment: 'node'`, and the same `@shared` alias as `electron.vite.config.ts` uses for main.

- [ ] **Step 2: Write failing tests** in `src/main/apiKey.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { apiKeyEnv, displayModel, isClaudeModelWarning, isInvalidKeyError, maskEnv, maskSecret, resolveApiKeyConfig, stripCredentials, validateApiKeyConfig } from './apiKey'

describe('apiKeyEnv', () => {
  it('claude official uses ANTHROPIC_API_KEY only', () => {
    expect(apiKeyEnv('claude', { provider: 'official' }, 'sk-ant-x', '')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-x' })
  })
  it('claude deepseek sets endpoint, bearer token, models and preset env', () => {
    const env = apiKeyEnv('claude', resolveApiKeyConfig('claude', { provider: 'deepseek' }), 'sk-d', '')
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-d',
      ANTHROPIC_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432'
    })
  })
  it('account defaultModel overrides the first preset model', () => {
    const env = apiKeyEnv('claude', resolveApiKeyConfig('claude', { provider: 'deepseek' }), 'k', 'deepseek-v4-pro[1m]')
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-flash')
  })
  it('custom uses its own models for every slot', () => {
    const env = apiKeyEnv('claude', { provider: 'custom', baseUrl: 'https://x.test/anthropic', models: ['m1', 'm2'] }, 'k', '')
    expect(env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://x.test/anthropic', ANTHROPIC_MODEL: 'm1', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm1', CLAUDE_CODE_SUBAGENT_MODEL: 'm1' })
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
  })
  it('codex uses CODEX_API_KEY, gemini uses GEMINI_API_KEY', () => {
    expect(apiKeyEnv('codex', { provider: 'official' }, 'sk-o', '')).toEqual({ CODEX_API_KEY: 'sk-o' })
    expect(apiKeyEnv('gemini', { provider: 'official' }, 'AIza', '')).toEqual({ GEMINI_API_KEY: 'AIza' })
  })
})

describe('stripCredentials (Review Focus 5)', () => {
  it('drops inherited credential vars of that kind only', () => {
    const base = { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://evil', ANTHROPIC_API_KEY: 'a', CODEX_API_KEY: 'c', GEMINI_API_KEY: 'g' }
    expect(stripCredentials('claude', base)).toEqual({ PATH: '/bin', CODEX_API_KEY: 'c', GEMINI_API_KEY: 'g' })
    expect(stripCredentials('codex', base)).not.toHaveProperty('CODEX_API_KEY')
    expect(stripCredentials('gemini', base)).not.toHaveProperty('GEMINI_API_KEY')
  })
})

describe('masking (Review Focus 2)', () => {
  it('keeps first 3 and last 4 chars', () => expect(maskSecret('sk-1234567890abcd')).toBe('sk-…abcd'))
  it('fully masks short values', () => expect(maskSecret('short')).toBe('••••'))
  it('masks secret vars, including ones from extraEnv, and leaves others', () => {
    expect(maskEnv({ ANTHROPIC_AUTH_TOKEN: 'sk-1234567890abcd', OPENAI_API_KEY: 'sk-abcdefghijkl', HOME: '/h' }))
      .toEqual({ ANTHROPIC_AUTH_TOKEN: 'sk-…abcd', OPENAI_API_KEY: 'sk-…ijkl', HOME: '/h' })
  })
})

describe('validateApiKeyConfig (Review Focus 3)', () => {
  it('normalizes custom baseUrl', () => {
    const c = { provider: 'custom' as const, baseUrl: '  https://h.test/anthropic/ ', models: ['m'] }
    expect(validateApiKeyConfig('claude', c)).toBeNull()
    expect(c.baseUrl).toBe('https://h.test/anthropic')
  })
  it('rejects non-http(s), missing models, third-party on codex/gemini', () => {
    expect(validateApiKeyConfig('claude', { provider: 'custom', baseUrl: 'ftp://h', models: ['m'] })).toBe('apikey.badUrl')
    expect(validateApiKeyConfig('claude', { provider: 'custom', baseUrl: 'https://h', models: [] })).toBe('apikey.noModels')
    expect(validateApiKeyConfig('codex', { provider: 'deepseek' })).toBe('apikey.badProvider')
  })
})

describe('helpers', () => {
  it('displayModel strips [1m]', () => expect(displayModel('deepseek-flash[1m]')).toBe('deepseek-flash'))
  it('recognizes invalid-key errors from all three vendors', () => {
    for (const s of ['Invalid API key · Fix external API key', '401 Unauthorized: invalid_api_key', 'Error 400, Message: API key not valid.'])
      expect(isInvalidKeyError(s)).toBe(true)
    expect(isInvalidKeyError('rate limited')).toBe(false)
  })
  it('recognizes Claude unknown-model warnings', () => {
    expect(isClaudeModelWarning('[claude-code:unrecognized_model] {"model":"deepseek-flash"}')).toBe(true)
    expect(isClaudeModelWarning(`Claude Code doesn't recognize the model "deepseek-flash", so it assumes …`)).toBe(true)
    expect(isClaudeModelWarning('Error: boom')).toBe(false)
  })
})
```

- [ ] **Step 3: Run** `pnpm test` → FAIL (module missing).

- [ ] **Step 4: Implement `src/main/apiKey.ts`** with the interfaces above. `CREDENTIAL_VARS` and the DeepSeek preset are copied from the spec's "Spawn env" section. `API_KEY_PAGES` (in `src/shared/types.ts`): deepseek `https://platform.deepseek.com/api_keys`, codex `https://platform.openai.com/api-keys`, gemini `https://aistudio.google.com/apikey`, claude `https://console.anthropic.com/settings/keys` (open each once to confirm it resolves; replace with the current page if it moved). No `electron` import in this file. Add `apiKey?: ApiKeyConfig` to `ProfileConfig` in `src/shared/types.ts`.

- [ ] **Step 5: Run** `pnpm test && pnpm typecheck` → PASS.

- [ ] **Step 6: Commit** `feat(api-key): pure env builder, presets and masking (+ vitest)`.

---

### Task 2: Encrypted secret store

**Files:**
- Create: `src/main/secrets.ts`, `src/main/secrets.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Cipher { available(): boolean; encrypt(plain: string): Buffer; decrypt(data: Buffer): string }
  export interface SecretStore { set(id: string, key: string): void; get(id: string): string | null; has(id: string): boolean; remove(id: string): void }
  export function createSecretStore(file: string, cipher: Cipher): SecretStore
  export function secrets(): SecretStore   // lazy singleton: userData/secrets.json + electron safeStorage
  ```
- `set` throws `Error('apikey.noKeychain')` when `!cipher.available()`, `Error('apikey.empty')` for an empty/whitespace key; stores `key.trim()`.

- [ ] **Step 1: Write failing tests** (fake cipher = reversible base64 wrapper with a marker prefix; temp dir per test):
  - `round-trips a key and trims it` — `set('a', '  sk-123  \n')` then `get('a') === 'sk-123'` (Review Focus 1).
  - `rejects whitespace-only` — throws `apikey.empty`.
  - `never writes plaintext` — after `set('a','sk-plain-marker')`, file contents do not contain `sk-plain-marker`; file mode is `0o600`.
  - `remove deletes the entry` — `has('a')` false after `remove('a')`.
  - `refuses without keychain` — cipher `available() → false`: `set` throws `apikey.noKeychain`, file not created (Review Focus 4).
  - `corrupt file reads as empty` — write `{not json` to the file: `get('a') === null`, `has('a') === false`, no throw (Review Focus 4).
  - `undecryptable entry reads as null` — decrypt throws → `get` returns `null`.

- [ ] **Step 2: Run** `pnpm test src/main/secrets.test.ts` → FAIL.

- [ ] **Step 3: Implement.** File format `{ "<profileId>": "<base64 ciphertext>" }`; write via temp file + rename, mode `0o600`. `secrets()` imports `app, safeStorage` from `electron` and uses `safeStorage.isEncryptionAvailable / encryptString / decryptString`.

- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit** `feat(api-key): encrypted secret store`.

---

### Task 3: Wire API-key accounts into profiles

**Files:**
- Modify: `src/main/profiles.ts` (`addProfile`, `buildSpawnSpec`, `isolationEnv`, `prepareProfileDir`, `detectLoggedIn`, `removeProfile`, `envPreview`, `updateProfile`), `src/shared/types.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces:
  ```ts
  export function addProfile(kind: ProfileKind, name?: string, apiKey?: ApiKeyConfig): ProfileConfig
  export function isApiKeyAccount(cfg: ProfileConfig): boolean
  ```
  `SpawnSpec.injected` keeps its type; its values are now masked.

- [ ] **Step 1: Implement** (logic is tested in Tasks 1–2; this task is wiring):
  - `addProfile(…, apiKey)`: run `validateApiKeyConfig` (throw `Error(t(code))`), store `resolveApiKeyConfig` result, always `managedDir`. Default name: DeepSeek → `"DeepSeek N"`, Custom → `"Custom API N"` (via i18n keys `acct.deepseekName` / `acct.customName`), official → existing `suggestName`.
  - `updateProfile`: drop `apiKey.provider` changes (connection fixed); allow `apiKey.models` edits for Custom after `validateApiKeyConfig`.
  - `buildSpawnSpec`: `env = { ...stripCredentials(kind, base), ...isolation, ...apiEnv, ...extraEnv }` where `apiEnv = apiKeyEnv(...)` only when `isApiKeyAccount` and `secrets().get(id)` is non-null; `injected = maskEnv({ ...isolation, ...apiEnv, ...extraEnv })`.
  - `prepareProfileDir`: for gemini API-key accounts, merge `{ modelProvider: 'gemini' }` into `<dir>/.gemini/antigravity-cli/settings.json` (create dirs; keep existing keys; skip if already set).
  - `detectLoggedIn`: API-key account → `secrets().has(id)`.
  - `removeProfile`: also `secrets().remove(id)`.
  - Add `apiKey` to `ProfileState` via the existing config spread (check `getState`).

- [ ] **Step 2: Verify by script** (no unit test: these functions need electron `app`). Run `pnpm build`, then in the dev app (Task 8 does it end to end); here just `pnpm typecheck && pnpm test` → PASS.

- [ ] **Step 3: Commit** `feat(api-key): spawn env, signed-in state and cleanup for API-key accounts`.

---

### Task 4: IPC + preload

**Files:**
- Modify: `src/shared/types.ts` (IPC names), `src/main/ipc.ts`, `src/preload/index.ts`, `src/preload/index.d.ts` if it re-declares the API

**Interfaces:**
- Produces (renderer API, `window.agentswitch.profiles`):
  ```ts
  add(kind: ProfileKind, name?: string, connect?: { apiKey: ApiKeyConfig; key: string }): Promise<ProfileId>
  setKey(id: ProfileId, key: string): Promise<void>
  ```
- `add` with `connect`: create profile, then `secrets().set`; if `set` throws, remove the new profile and rethrow with the translated message (no half-created account). `setKey` rejects for non-API-key accounts. Both broadcast state afterwards. The key never appears in thrown messages.

- [ ] **Step 1: Implement** the handlers (`IPC.profilesSetKey = 'profiles:setKey'`) and preload bindings.
- [ ] **Step 2: Run** `pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 3: Commit** `feat(api-key): IPC for creating API-key accounts and replacing keys`.

---

### Task 5: Runs, models and usage for API-key accounts

**Files:**
- Modify: `src/main/usage.ts` (`refreshUsage`), `src/main/models.ts` (`fetchLive`), `src/main/agentRunner.ts` (stderr handling ~line 818, error finish ~line 826)

**Interfaces:**
- Consumes: `isApiKeyAccount`, `displayModel`, `isInvalidKeyError`, `isClaudeModelWarning`.

- [ ] **Step 1: Implement:**
  - `refreshUsage`: exclude API-key accounts from `codexTask`, `agyTask`, `claudeTask` (the Claude probe would otherwise spend the user's API credits).
  - `fetchLive` case `claude`: if `cfg.apiKey` provider is `deepseek`/`custom`, return `cfg.apiKey.models` as `ModelOption`s (`id` = full id, label = `displayModel(id)`), `source: 'catalog'`. Official-key accounts keep the existing per-kind path.
  - `agentRunner` stderr: drop lines where `isClaudeModelWarning(line)` before appending to `errTail` (still send them to `onLog`).
  - On failure, if `isInvalidKeyError(error)` and the account is an API-key account, append `t('apikey.checkKey')` to the error text.
- [ ] **Step 2: Run** `pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 3: Commit** `feat(api-key): models, usage and error hints for API-key accounts`.

---

### Task 6: Add-account dialog

**Files:**
- Modify: `src/renderer/src/components/dialogs.tsx` (`AddAccountModal`), `src/shared/i18n/{en,zh-CN,zh-TW,ja}.ts`

**Interfaces:**
- Consumes: `profiles.add(kind, name, connect)`, `API_KEY_PAGES` from `@shared/types` (never import `src/main` from the renderer).

- [ ] **Step 1: Implement.** Above the name field, a radio list "How should this account connect?":
  - claude: `Sign in with Claude (subscription)` · `Anthropic API key` · `DeepSeek API key` · `Custom endpoint (Anthropic-compatible)`
  - codex: `Sign in with ChatGPT` · `OpenAI API key`
  - gemini: `Sign in with Google` · `Gemini API key`
  Sign-in keeps today's behaviour. Key options show a password input (`autoComplete="off"`, `spellCheck={false}`) and a "Get a key" link opening the vendor page via `sys.openExternal`. Custom also shows endpoint URL and model ids (comma or newline separated). Choosing DeepSeek/Custom switches the suggested name to `DeepSeek N` / `Custom API N` unless the user edited it. Submit with a key calls `add(kind, name, { apiKey, key })` and closes with a success toast (no login sheet). Show main-process validation errors inline.
- [ ] **Step 2: Run** `pnpm typecheck` → PASS; `pnpm dev`, open Engines → Add Claude account, check each option renders and validation messages show (screenshot not required).
- [ ] **Step 3: Commit** `feat(api-key): choose sign-in or API key when adding an account`.

---

### Task 7: Account row, settings and avatar

**Files:**
- Modify: `src/renderer/src/pages/EnginesPage.tsx` (`AccountRow`), `src/renderer/src/components/ProfileConfigModal.tsx`, `src/renderer/src/components/common.tsx`, `src/renderer/src/components/brandIcons.tsx`, call sites of `KindAvatar` that render a specific account, i18n files

**Interfaces:**
- Produces: `export function ProfileAvatar({ profile, size }: { profile: Pick<ProfileConfig, 'kind' | 'apiKey'>; size?: number })` in `common.tsx`. DeepSeek → DeepSeek logo tile; Custom → `KindAvatar` + small "API" badge bottom-right; otherwise `KindAvatar`.

- [ ] **Step 1: Implement:**
  - `AccountRow`: API-key accounts show `API key` / `DeepSeek · API key` / `Custom API · <host>` instead of the directory line; the "log in" action becomes "Change API key" (opens a small prompt calling `setKey`); never open `LoginModal` for them.
  - `ProfileConfigModal`: for API-key accounts hide login-command fields; add a section with connection label, endpoint (read-only), models (editable textarea for Custom, saved via `profiles.update`), and "Replace key". The env preview already shows masked values (Task 3).
  - Replace `KindAvatar kind={p.kind}` with `ProfileAvatar profile={p}` where a concrete account is rendered (account rows, chat message headers, @-picker, settings header). Kind-level places (CLI section headers) keep `KindAvatar`.
  - Hide quota (5h/7d) UI for API-key accounts in `Usage.tsx` / `UsagePage.tsx` (they never get quota data after Task 5; make sure empty state doesn't say "loading" forever).
- [ ] **Step 2: Run** `pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 3: Commit** `feat(api-key): account row, settings section and DeepSeek avatar`.

---

### Task 8: End-to-end verification

**Files:** none (fixes found here go into the owning task's files, committed as `fix(api-key): …`)

- [ ] **Step 1: Fake-key run per connection** in `pnpm dev` (isolated: `AGENTSWITCH_HOME` + `AGENTSWITCH_USER_DATA` pointing at a temp dir). Create one account per row and send "say hi":

| Account | Expected chat error (and "check the key" hint) |
|---|---|
| Claude · Anthropic key `sk-ant-fake` | `Invalid API key` |
| Claude · DeepSeek `sk-fake` | DeepSeek auth error; no `unrecognized_model` line in chat |
| Claude · Custom `https://api.deepseek.com/anthropic`, model `deepseek-flash` | same as DeepSeek |
| Codex · OpenAI key `sk-fake` | `invalid_api_key` |
| Gemini · key `AIza-fake` | `API key not valid` (not "Authentication required") |

- [ ] **Step 2: No plaintext anywhere.** `grep -rl "<each fake key>" "$AGENTSWITCH_USER_DATA" <each account dir>` → no matches (only `secrets.json` may exist and it must not match). Debug drawer banner and env preview show `sk-…` masked.
- [ ] **Step 3: Isolation.** With `export ANTHROPIC_BASE_URL=https://example.invalid` and `export CODEX_API_KEY=x` in the shell that launches the dev app, the existing sign-in Claude and Codex accounts still answer normally.
- [ ] **Step 4: Real DeepSeek key (maintainer).** Ask the maintainer to add a real DeepSeek key, chat with DeepSeek and the official Claude account in one conversation (DeepSeek writes, `@Claude` reviews).
- [ ] **Step 5:** `pnpm typecheck && pnpm test && pnpm build` → PASS. Push the branch and open a PR to `main` (only after the maintainer says so).

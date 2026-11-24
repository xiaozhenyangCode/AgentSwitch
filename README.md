<p align="center">
  <img src="build/icon.png" width="96" alt="AgentSwitch icon" />
</p>

<h1 align="center">AgentSwitch</h1>

<p align="center">
  One desktop workspace for the AI coding agents you already use: Claude Code, Codex CLI, Gemini (Antigravity CLI) and DeepSeek (Reasonix), side by side in the same chat.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" /></a>
  <img alt="Platform: macOS (Apple Silicon)" src="https://img.shields.io/badge/platform-macOS%20%28Apple%20Silicon%29-lightgrey.svg" />
</p>

<p align="center"><a href="https://agentswitch.app">Website</a> · <a href="https://github.com/yitian-builds/AgentSwitch">yitian-builds/AgentSwitch</a> · <a href="LICENSE">AGPL-3.0-only</a> · English · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center"><img src="docs/demo.gif" width="900" alt="Claude writes slugify.js, Codex reviews and fixes edge cases, Gemini adds and runs tests" /></p>

## Why

You probably pay for more than one AI coding subscription, and each one lives in its own terminal. AgentSwitch runs the official CLIs for you and lets them work together:

- **Multi-agent chat.** Talk to one agent, then `@` another to review, continue or take over. Agents can hand work to each other, and failed steps can be sent back for a retry.
- **Your own subscriptions.** AgentSwitch drives the official CLIs you already have installed and signed in to. It never sees or stores your passwords, and it does not resell any API.
- **Local history in one place.** Browse and search supported CLI sessions saved on your Mac, then continue them in a chat.
- **Usage and cost at a glance.** Context-window fill for the current model, plus 5-hour and 7-day quota windows where the CLI reports them, with a warning when you near your limit. Token usage is also priced at each model's official list price, with today, 7-day, 30-day and all-time views.
- **Separate accounts.** Keep a work and a personal account for the same CLI, each with its own isolated sign-in.
- **API-key accounts.** Instead of signing in, give an account an API key: the provider's own, DeepSeek, or a custom Anthropic-compatible endpoint. Keys are encrypted with a key held in the macOS Keychain.
- **Extensions.** See loaded MCP servers, skills, plugins and rules in one searchable panel.
- **Git tools, opt-in.** Turn on **Settings → Developer → Show Git management** to see the current branch and ahead/behind under the composer, switch or create branches, fetch, pull (fast-forward only) and push, and stage, discard and commit from the File changes panel. Off by default, so the panel stays a simple read-only view of what changed.
- **Built-in terminal** for installing, signing in to and debugging each CLI.

## Supported agents

| Agent | CLI | Install |
|---|---|---|
| Claude | Claude Code (`claude`) | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Codex | Codex CLI (`codex`) | `npm install -g @openai/codex` |
| Gemini | Antigravity CLI (`agy`) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| DeepSeek | Reasonix (`reasonix`) | `npm i -g reasonix` |

Reasonix uses a DeepSeek API key. Import your existing `~/.reasonix` setup or paste a key in the app. The app can also install the CLIs and guide you through sign-in where supported. More agents and local models are on the roadmap.

## Install

Download the latest `.dmg` from the [Releases](https://github.com/yitian-builds/AgentSwitch/releases) page.

The app is ad-hoc signed, not notarized by Apple, so macOS blocks it the first time you open it. To get past this, right-click the app and choose **Open**, or run:

```bash
xattr -cr /Applications/AgentSwitch.app
```

### Build from source

**Requirements:** macOS (Apple Silicon), Node.js 22 LTS or newer, [pnpm](https://pnpm.io).

```bash
pnpm install   # also rebuilds node-pty for Electron
pnpm dev       # run in development mode
pnpm dist      # build the .dmg into dist/
```

## Privacy

- **Local only.** Chats, settings and usage statistics stay on your Mac, under `~/Library/Application Support/agentswitch`.
- **No telemetry.** AgentSwitch makes only three kinds of network requests itself:
  - the install script you choose to run;
  - Anthropic's usage endpoint, called with your own Claude sign-in, to show quota;
  - once a day, [LiteLLM's public price list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) (a static JSON file on GitHub, nothing sent about you) to estimate cost. If it can't be fetched, a built-in copy is used.

  Everything else, including model requests and DeepSeek balance checks, goes through the CLIs themselves.
- **API keys stay local.** Keys for API-key accounts are encrypted with Electron safeStorage (its key lives in the macOS Keychain). They are never shown in the UI, only handed to the CLI when it runs. A DeepSeek key you paste for Reasonix is written to a `.env` file only you can read (mode 600) in that account's folder, because the Reasonix CLI reads it from there.
- **Doesn't rewrite your CLI data.** When you browse Local History, AgentSwitch only reads sessions under `~/.claude`, `~/.codex` and `~/.gemini`. Rule files are created or changed only when you save them in Extensions. If you explicitly choose to delete a CLI session, its files are moved to the Trash.

## Development

```bash
pnpm typecheck
pnpm build
```

The main process is in `src/main`, the preload bridge in `src/preload`, the React UI in `src/renderer`, and shared types and translations in `src/shared`. UI strings live in four dictionaries (`src/shared/i18n/{zh-CN,zh-TW,en,ja}.ts`), and every new string needs all four.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests require signing the [CLA](CLA.md) once, which a bot handles in the PR.

## Disclaimer

AgentSwitch is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic, OpenAI or Google. Claude, Codex, Gemini and their logos are trademarks of their respective owners. You are responsible for using each CLI in line with its provider's terms of service.

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

Copyright © 2026 yitian_builds

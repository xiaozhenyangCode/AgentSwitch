# AgentSwitch pre-launch repository audit

The v1 scope comes from the reviewer’s `.agentswitch/runs/08n4095wau9uxbmy/facts.md`. The repository search included hidden and ignored files and excluded directories named `.git`, `node_modules`, `out`, and `dist`. The checklist uses pre-edit line numbers for the READMEs. GitHub URLs were reviewed by namespace and use. Link and image existence was checked on disk.

## Checklist

| File:line | Issue | Severity | Recommended fix | Fixed? |
| --- | --- | --- | --- | --- |
| `README.md:8`, `README.zh-CN.md:8` | The opening description listed three agents and omitted DeepSeek via Reasonix. Both supported-agent tables already listed all four. | Medium | Add DeepSeek (Reasonix) to the original desktop workspace tagline. | yes |
| `README.md:11–16`, `README.zh-CN.md:11–16` | The opening linked to the website and used a license badge, but it lacked the GitHub repository identity and required the badge to load to show the license visually. | Medium | Keep the linked license and platform badges, specify Apple Silicon in the platform badge, and put the website, `yitian-builds/AgentSwitch`, the linked `AGPL-3.0-only` license, and the language switch in plain text below the badges. | yes |
| `README.md:30`, `README.zh-CN.md:30` | “Manage” implied the panel can modify MCP servers, skills, and plugins. The panel lists those items for inspection. Rule files are the editable items. | Medium | Describe Extensions as one searchable panel for viewing loaded MCP servers, skills, plugins, and rules. | yes |
| `README.md:26`, `README.zh-CN.md:26` | “Each CLI” overstated native session browsing. The Local History scan skips Reasonix at `src/main/history.ts:826`. | Medium | Refer to supported CLI sessions. | yes |
| `README.md:31` | “File Changes” differed from the rendered panel title. | Low | Use “File changes” from `chg.title`. | yes |
| `README.md:43`, `README.zh-CN.md:43` | The install and sign-in sentence could imply that Reasonix has a sign-in flow. The Chinese README explicitly applied it to every CLI. | Medium | Keep Reasonix’s DeepSeek API-key setup explicit and qualify sign-in by CLI support. | yes |
| `README.md:47`, `README.zh-CN.md:47` | `../../releases` has no on-disk target. The repository-hosted route can work on GitHub, but the relative form depends on where the README is rendered. | Low | Use the absolute Releases URL under `yitian-builds/AgentSwitch`. | yes |
| `README.md:75`, `README.zh-CN.md:75` | “Never changes CLI files” was broader than the history behavior it described. The reviewer verifies that the app can edit rule files. | Medium | Explain that browsing Local History reads CLI sessions, saving rules in Extensions creates or changes rule files, and explicit CLI session deletion moves its files to the Trash. | yes |
| `CLA.md:9`, `CLA.md:18` | The agreement identifies `xiaozhenyang` and `@xiaozhenyangCode`. Its definition of “Maintainer” names the recipient of contributor grants. | High | Confirm the intended legal person or entity and its identifying details. The organization and public brand establish repo identity. Using either as the named Maintainer requires a decision about who receives the grants. | needs-owner-decision |
| `.github/workflows/cla.yml:36` | The allowlist includes `xiaozhenyangCode` as a GitHub login. It exempts that account from the CLA signing requirement. | High | Confirm the actual GitHub login the owner intends to exempt. Keeping it preserves that exemption. Removing or changing it can revoke the current exemption or grant one to another account. Treat this as a separate decision from naming the CLA’s Maintainer. | needs-owner-decision |
| `package.json:4` | The package description still lists three agents. | Low | Mirror the four-agent README description. | no |
| `src/shared/i18n/en.ts:665`, `src/shared/i18n/ja.ts:665`, `src/shared/i18n/zh-CN.ts:687`, `src/shared/i18n/zh-TW.ts:685` | The About tagline omits DeepSeek via Reasonix in all four languages. | Low | Update `about.tagline` across the four dictionaries. | no |
| `src/shared/i18n/en.ts:872` | The English first-run copy says “all three.” The screen renders the four engines in `KINDS` from `src/shared/types.ts:33`. | Low | Say that one ready engine is enough and omit the total. | no |
| `CONTRIBUTING.md:9`, `CONTRIBUTING.md:11` | Bug-report guidance mentions Intel alongside Apple Silicon without saying which is supported, and its CLI-version examples omit Reasonix. | Low | State the supported platform and include Reasonix among the CLI examples. | no |
| `docs/superpowers/specs/2026-11-23-api-key-accounts-design.md:3`, `docs/superpowers/specs/2026-11-23-reasonix-engine-design.md:3` | Dated design specs still say “awaiting approval” for capabilities in the reviewer’s v1 scope. | Low | Mark them as historical design records if readers use them to check current status. | no |
| `docs/launch/x/x-first-post.md:21` | “Each CLI” implies Extensions coverage for Reasonix. The implementation scans Claude Code, Codex CLI, and Antigravity CLI and returns an empty scan for Reasonix (`src/main/extensions.ts:968`). | Medium | Describe viewing loaded extensions without promising coverage for every CLI. | no |
| `docs/launch/x/x-first-post.md:63`, `:64`, `:69`, `:70` | Four relative references resolve locally to the reviewer’s facts file, which Git ignores. They would be missing from a clean clone. | Low | If the draft will be checked in, use tracked evidence where available and cite the local review as plain text. | no |
| `.agentswitch/runs/qo267gxsxdk7ki8x/step-1.md:13`, `.agentswitch/runs/zrk1d4x3phuac2ko/step-1.md:11` | Two ignored release notes link to the former personal repository for v0.1.1 and v0.1.0. | Info | Retain the historical notes. Use the organization’s Releases page when sharing a current download link. | no |

## GitHub URL and local target checks

- The current project URLs in `package.json:8`, `package.json:11`, and `src/renderer/src/components/SettingsDialog.tsx:35` use `yitian-builds/AgentSwitch`. The CLA document URL at `.github/workflows/cla.yml:34` uses `${{ github.repository }}` to follow the repo that runs the workflow.
- The literal third-party GitHub URLs in the tracked files point to LiteLLM’s public pricing table (`README.md:71` and `README.zh-CN.md:71` after edits). The ignored bundled Node runtime license includes third-party attribution URLs at `build/runtime/mac-arm64/LICENSE:26`, `:667–669`, `:708`, and `:952`. Those URLs identify their respective upstream projects.
- Ignored `.agentswitch` files also contain T3 Code research links and historical mentions of the old name or login in run notes, prompts, and logs. The CLA and workflow are the tracked source files with those old strings. This report also records the findings.
- Checked relative Markdown links and images, link definitions, and HTML link and image attributes in `README*.md` and `docs/`. All remaining local targets exist on disk, including the icon, demo GIF, license, translated README links, and contributor documents. The four reviewer-facts references in the checklist depend on this checkout.

## README 10-second test

Both versions pass by inspection of the content above the demo image. The tagline presents one desktop workspace where four coding agents can work side by side in the same chat. The badge row shows the AGPL-3.0 license and macOS (Apple Silicon) platform. Below it, the text row links to the website, canonical GitHub repository, and license, and provides a language switch. The exact license identifier is visible even if images fail to load.

## Changes applied

- Both READMEs, lines 8 and 11–16. Restored the original desktop workspace tagline and added DeepSeek (Reasonix). Restored the AGPL-3.0 badge linked to `LICENSE` and specified macOS (Apple Silicon) on the platform badge. Kept the plain-text website, canonical GitHub repo, license, and language links below the badges.
- Both READMEs, line 26. Scoped history browsing, search, and continuation to supported CLI sessions.
- Both READMEs, line 30. Replaced Extensions management wording with viewing and search wording and included plugins.
- English README, line 31. Matched “File changes” to the panel title.
- Both READMEs, line 43. Clarified Reasonix’s API-key setup and sign-in availability. Kept additional agents and local models as roadmap items.
- Both READMEs, line 47. Replaced the relative Releases route with the canonical absolute URL.
- Both READMEs, line 75. Restored the privacy reassurance for `~/.claude`, `~/.codex`, and `~/.gemini`. Browsing Local History reads CLI sessions. Saving in Extensions can create or update a rule file, as verified in `prepareRuleTarget` and `writeRuleFile` in `src/main/extensions.ts`. Explicit CLI session deletion moves the session files to the macOS Trash, as verified in `src/main/threadDelete.ts`.

English UI strings were checked in `src/shared/i18n/en.ts`, including `nav.tabHistory` (64), `nav.settings` (73), `set.about` (581), `ext.title`, `ext.search`, and the tab labels (802–812), `chg.title` (969), and `set.developer` and `set.gitTools` (1002, 1005). The mirrored labels were checked in `src/shared/i18n/zh-CN.ts`.

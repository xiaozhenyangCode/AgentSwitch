# AgentSwitch v1 on X

## A. Standard main tweet

```text
AgentSwitch v1 is live. It's an open-source Mac app I built so I could ask Codex to review Claude Code's work in the same chat.

Next I'm borrowing ideas from t3code to improve the CLI runtime. I'm also planning a Minimal Mode for non-technical people.
```

Character count **252** (literal and X-weighted).

## B. Long main tweet (X Premium)

```text
AgentSwitch v1 is live. I wanted to ask a second coding agent to review the first one's work without copying the conversation into another terminal.

- Use Claude Code, Codex CLI, Gemini (Antigravity CLI), and DeepSeek (Reasonix) in one chat. Type @ to hand off a review or pick up where another agent left off.
- The first-run guide detects installed CLIs and helps you install and sign in.
- Search Local History and continue a session you started in the terminal.
- Open Extensions to see skills, plugins, MCP servers, and rules from your Claude Code, Codex CLI, or Antigravity CLI setup.
- Get a warning before sending if another app or terminal wrote to the same CLI session in the last 2 seconds.

What I'm working on next:
- Borrowing ideas from t3code to improve the low-level CLI experience.
- I'm planning a Minimal Mode for non-technical people.

When you switch coding agents mid-task, what do you wish carried over?
```

Character count **928** (literal and X-weighted).

## C. First reply

```text
AgentSwitch for macOS (Apple Silicon), licensed AGPL-3.0-only.

https://agentswitch.app
https://github.com/yitian-builds/AgentSwitch
```

Character count **132** literal, **111** X-weighted. Both counts include spaces and line breaks. [X character counting](https://docs.x.com/fundamentals/counting-characters)

## D. Launch and cold-start checklist

1. Pick a time when you can answer replies for the first hour. For a weekday launch aimed at US developers, try 10 a.m. ET, which is 11 p.m. Beijing time (UTC+8) and 11 p.m. SGT in November.
2. Post either A or B with a 15–20 second demo video attached. Start with Claude Code's answer on screen, type @ to bring in Codex, and end on Codex's review in the same chat.
3. As soon as the main tweet is public, post C as a direct reply.
4. From your profile, open the main tweet's `···` menu, choose **Pin to your profile**, and confirm. [X Help Center](https://help.x.com/en/managing-your-account/how-to-customize-your-profile)
5. Keep the main tweet free of links. Proofread the copy and preview the video before posting. Skip edits after publishing and add any correction in a reply. [X's edit guidance](https://help.x.com/en/using-x/edit-post)
6. Reply to early comments with a specific question about the person's CLI or workflow. Share a short example when it directly answers what they asked.

### Backup replies

- **Which CLI do you use most?** Which CLI do you reach for first? Is there a point where you'd bring in a second one for a review?
- **Why not just tmux?** If tmux already fits your workflow, I'd keep using it. I built AgentSwitch so I could ask a second CLI for a review with the conversation already in the same chat. How do you handle that handoff in tmux?
- **Is Windows coming?** v1 runs on Apple Silicon Macs only. I don't have a Windows plan or release date to share yet. What CLI do you use on Windows?

## E. Fact check

| Post | Claim | Source |
| --- | --- | --- |
| A | AgentSwitch is an open-source Mac app. | [package.json](../../../package.json) `license`, `scripts.dist` |
| A, B | Claude Code, Codex CLI, Gemini via Antigravity CLI, and DeepSeek via Reasonix share a chat. Use @ to ask a second agent to review or continue. | [WorkbenchPage.tsx](../../../src/renderer/src/pages/WorkbenchPage.tsx), [orchestrator.ts](../../../src/main/orchestrator.ts), [en.ts](../../../src/shared/i18n/en.ts) `wb.placeholder`, `ob.desc.gemini`, `ob.desc.reasonix` |
| B | The first-run guide detects installed CLIs and helps with installation and sign-in. | [OnboardingPage.tsx](../../../src/renderer/src/pages/OnboardingPage.tsx), [en.ts](../../../src/shared/i18n/en.ts) `ob.detecting`, `ob.foundAt`, `ob.next` |
| B | Search Local History and continue an existing terminal session. | [NavRail.tsx](../../../src/renderer/src/components/NavRail.tsx), [chat.ts](../../../src/renderer/src/state/chat.ts), [orchestrator.ts](../../../src/main/orchestrator.ts), [en.ts](../../../src/shared/i18n/en.ts) `nav.tabHistory`, `nav.searchHistory` |
| B | Extensions shows skills, plugins, MCP servers, and rules for Claude Code, Codex CLI, and Antigravity CLI setups. | [extensions.ts](../../../src/main/extensions.ts), [Extensions.tsx](../../../src/renderer/src/components/Extensions.tsx), [en.ts](../../../src/shared/i18n/en.ts) `ext.title`, `ext.tab.skills`, `ext.tab.plugins`, `ext.tab.mcp`, `ext.tab.context` |
| B | A warning appears before sending if another app or terminal wrote to the same CLI session within 2 seconds. | [WorkbenchPage.tsx](../../../src/renderer/src/pages/WorkbenchPage.tsx), [en.ts](../../../src/shared/i18n/en.ts) `wb.extBusyTitle`, `wb.extBusyDesc` |
| A, B | Borrowing from t3code to improve the CLI runtime is planned. | Planned — not in code (intentional) |
| A, B | Minimal Mode for non-technical people is planned. | Planned — not in code (intentional) |
| C | v1 runs on Apple Silicon macOS. | [package.json](../../../package.json) `scripts.dist` |
| C | The license is AGPL-3.0-only. | [package.json](../../../package.json) `license` |
| C | The site and GitHub repository are the two listed URLs. | [package.json](../../../package.json) `homepage`, `repository.url` |

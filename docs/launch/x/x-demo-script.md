# AgentSwitch v1 · 20-second X demo

## Shot list

| Time | Click path and UI labels | What must be visible | On-screen caption |
| --- | --- | --- | --- |
| 0–3s | Cut across three clean terminal panes. Click each pane in turn. Stage `claude --version`, `codex --version`, and `agy --version`. In the third pane, show `which agy` and start typing `export PATH=…`. | Three separate prompts, the CLI names, and the PATH edit. Keep the prompt and scrollback scrubbed. | Three CLIs, three terminals |
| 3–5.5s | Click `Model Engines` in the left rail. On the missing engine’s card, click `Check Again`. | An installed engine’s version and another engine’s `Not installed` state. Hold for the `{cli} not found` toast. | See what’s installed |
| 5.5–8s | Click the × with the `Close` tooltip, then `New Chat`. Click the composer and send “Write a one-line JS clamp for 0–100.” using the up-arrow button. | The Claude demo lead account and its short reply in the new chat. Cut over the wait for the reply. | Start a chat |
| 8–12s | In the same composer, type `@`. In `Invite a model`, click the Codex demo account row. Append “Review the clamp for edge cases. One sentence.” and click the up-arrow button. | The picker, the inserted mention, and a short Codex reply in the same thread. Cut over the wait for the review. | Ask Codex to review |
| 12–17.5s | Click `Extensions` beneath the composer. Hold on `Skills`, then click `MCP`, then `Plugins`. | The selected tab at each stop, the safe list or its real empty state, and `Read-only · no model calls`. Keep server rows collapsed. | Browse what your CLI loads |
| 17.5–20s | Cut to a static end card. | The product name and handle centered and readable for the full hold. | AgentSwitch v1 · @yitian_builds |

## Before recording

- Set the app’s UI language to English in `Settings` → `General` → `Language`. In `Default Account for New Chats`, pick the Claude demo account. Finish first-run setup off camera and confirm Claude and Codex are signed in and ready. Leave `agy` absent from the app’s effective PATH so the missing-engine take is reproducible.
- Use an isolated demo repo under `/tmp/demo` with a toy README and a generic branch. Before the take, open a scratch chat using `New Chat` → `Choose a project folder` and select `/tmp/demo`. Leave it active so the recorded `New Chat` inherits the folder. Rehearse the two prompts and preview the lead account’s extension lists for demo-safe content.
- Arrange three clean terminal panes inside the capture area. Use a short neutral prompt such as `demo %`. Stage the commands off camera, using demo paths if any output will be visible. Capture the app at about 1600 × 1000 and fit it into a 1920 × 1080 canvas without stretching or clipping controls. Use a small click highlight, turn on macOS Do Not Disturb, and close other apps.
- Export a 20-second MP4 at 1080p and 30 fps. X’s web limits include 1920 × 1200 for landscape, 40 fps, and 25 Mbps. Stay below 512 MB and 140 seconds for a standard account. [X Help Center](https://help.x.com/en/using-x/x-videos)

## Privacy checklist

- [ ] **macOS username and paths.** Prefer a temporary macOS user such as `demo`. For a local test launch, use a scratch `AGENTSWITCH_HOME` and separate `AGENTSWITCH_USER_DATA`. Check `Local config · {dir}`, `Own folder · {dir}`, the debug working-directory tooltip `Working directory: {path}`, the `Debug Log` drawer, the `Read from {dir}` footer, and terminal prompts and scrollback. Close debug views and cover any remaining private path with an opaque mask.
- [ ] **Projects and history.** Use only demo files and chats from `/tmp/demo`. Keep the rail on `Chats`, with only demo titles visible. Check `Local History` off camera for real session titles, and check terminal tabs, folder tooltips, and model replies for real project names.
- [ ] **API keys and environment.** Keep API-key accounts and credential screens out of frame. Inspect terminal startup output, shell history, config excerpts, and pasted commands off camera for tokens or keys. Keep full environment dumps out of the take.
- [ ] **MCP details.** In `Extensions` → `MCP`, click any open server row to collapse it before capture. `Env` and `Headers` list key names. Expanded rows can also expose command arguments, URLs, working directories, and config paths. Use demo-safe server names and keep details closed.
- [ ] **Account names and email addresses.** In `Model Engines`, double-click each demo account name, replace it with a neutral alias such as Claude Demo or Codex Demo, and press Return. Check account rows, chat avatars, the mention picker, and CLI banners for email addresses and other identifiers.
- [ ] **Quota and cost.** Keep `Usage & Limits` closed and avoid hovering over usage indicators. Check the sidebar and composer for any visible quota or cost figures and mask them if needed.
- [ ] **Git branches.** Use a generic demo branch such as `main`. In `Settings` → `Developer`, turn off `Show Git management`. Check the project header and terminal prompt for branch names.
- [ ] **Notifications and final review.** Turn on Do Not Disturb and quit messaging and email apps. Scrub the exported video frame by frame around cuts, hovers, and toasts for banners, personal details, and accidental audio before posting.

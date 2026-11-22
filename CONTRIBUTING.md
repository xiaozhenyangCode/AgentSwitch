# Contributing to AgentSwitch

Thanks for helping out. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue and include:

- your macOS version and Mac model (Apple Silicon or Intel);
- the AgentSwitch version (Settings → About);
- the affected CLI and its version (`claude --version`, `codex --version`, `agy --version`);
- steps to reproduce, and what you expected instead;
- the debug log, if possible: Settings → enable the debug terminal, then copy the log from the `>_` drawer. Remove anything private first.

## Pull requests

1. For anything larger than a small fix, open an issue first so we can agree on the approach.
2. Keep each PR focused on one change.
3. Before pushing, make sure both of these pass:
   ```bash
   pnpm typecheck
   pnpm build
   ```
4. UI work:
   - Check both light and dark mode.
   - Add every new UI string to all four dictionaries: `src/shared/i18n/{zh-CN,zh-TW,en,ja}.ts`.
5. Never commit secrets, tokens, or personal paths and data.

## Contributor License Agreement

The first time you open a pull request, a bot asks you to sign the [CLA](CLA.md). Reply to the PR with the sentence it gives you; you only need to do this once.

**Why a CLA?** AgentSwitch is licensed under the AGPL-3.0. The CLA lets the maintainers keep the project's licensing options open in the future: for example, moving to a more permissive license, or offering the code under other terms alongside the AGPL. You keep the copyright to your contribution, and your contribution stays available under the AGPL.

## License

By contributing, you agree that your contribution is licensed under the [AGPL-3.0](LICENSE) and under the terms of the [CLA](CLA.md).

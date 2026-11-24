# 阶段 3：无 Node 环境的内置运行时与打包设计

- 日期：2026-11-24
- 范围：macOS（`arm64`，脚本与打包路径已预留 `x64`）

## 1. 背景与目标

Claude Code (`claude`) 与 Gemini (`agy`) 已采用官方原生二进制安装脚本（`curl ... | bash`），不依赖 Node.js；但 Codex (`@openai/codex`)、Reasonix (`reasonix`) 及大量社区 MCP Server 依赖 `npm` 安装与 `#!/usr/bin/env node` / `npx` 运行。

目标：
1. 全新未安装 Node.js / Homebrew / nvm 的 Mac 安装 `AgentSwitch.dmg` 后，可直接一键安装并运行 Codex / Reasonix 与 `npx` MCP Server；
2. 已安装 Node.js 的机器保持零侵入，始终优先使用用户自己的系统 `node` / `npm` 与全局前缀；
3. 更新或覆盖安装 `AgentSwitch.app` 时，通过内置 `npm` 安装的 CLI 不丢失，且不破坏应用包内只读资源或签名；
4. 透传系统代理（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`），并兼容用户现有的 `~/.npmrc`。

## 2. 架构设计

### 2.1 两层目录分离
- **只读内置运行时**：由 `scripts/prepare-runtime.mjs` 下载官方 Node.js `v22.23.5` LTS（SHA-256 校验、缓存至 `.cache/node-runtime/`），裁剪 `include/`、`share/`、`corepack`、npm 文档与 man 手册后暂存至 `build/runtime/mac-<arch>/`，通过 `package.json` `build.extraResources` 打入 `AgentSwitch.app/Contents/Resources/runtime/`；`scripts/afterPack.cjs` 校验文件完整性和 `0o755` 可执行权限。
- **可写持久化全局前缀**：`<userData>/runtime/npm-global/`（二进制位于 `bin/`）与缓存目录 `<userData>/runtime/npm-cache/`，自动跟随 `AGENTSWITCH_USER_DATA`。

### 2.2 PATH 优先级（`src/main/shellEnv.ts` + `src/main/runtime.ts`）
```text
用户登录 Shell PATH
  → extraPaths() 本机常见目录
  → <userData>/runtime/npm-global/bin（目录存在时）
  → <resources>/runtime/bin（内置兜底）
  → /usr/bin:/bin:/usr/sbin:/sbin
```
- 系统已有 `node` / `npm` 时命中前两层，内置运行时完全隐身；
- 系统无 `node` / `npm` 时回退到内置运行时，`missingInstallTool()` 不再拦截。

### 2.3 安装与刷新链路（`src/main/profiles.ts` + `src/main/ipc.ts`）
- `buildInstallSpec()` 检测命令首词为 `npm` / `npx` 且 `findOnPath()` 指向内置运行时时：
  - 自动创建 `<userData>/runtime/npm-global/bin` 与 `npm-cache`；
  - 注入 `npm_config_prefix` 与 `npm_config_cache`，保留 `HOME = realHome`（兼容 `~/.npmrc`）及全部代理变量；
  - 使用 `zsh -fc` 避免 macOS `path_helper` 或异常 `~/.zshrc` 冲掉内置 `PATH`；
- `install:*` PTY 退出时调用 `refreshRuntimePaths()` 刷新 `PATH`，使刚安装到 `npm-global/bin` 的 CLI 立即生效。

### 2.4 状态展示与验证
- `AppInfo.nodeRuntime` 透出当前 CLI Node 来源（`system` / `bundled` / `none`），在「设置 → 关于 → 运行环境」中展示（同步四套 i18n）。
- 沙盒验证：支持 `AGENTSWITCH_CLEAN_PATH=1` + `AGENTSWITCH_HOME` + `AGENTSWITCH_USER_DATA` 在开发机上无损模拟纯净无 Node 的 Mac 进行端到端验证。

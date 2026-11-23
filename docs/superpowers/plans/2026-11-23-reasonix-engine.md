# 实施说明：Reasonix 作为第 4 个引擎（方案 A，每轮启动 CLI）

依据：`docs/superpowers/specs/2026-11-23-reasonix-engine-design.md`（rev 2）。本文件和设计文档冲突时以本文件为准；两者都没说的，你自己定，但必须写进最终报告的「我做的决定」一节。

## 0. 工作方式（必须遵守，违反任何一条整单打回）

- **在独立 worktree 里做**：`git worktree add ../AgentSwitch-reasonix -b feat/reasonix-engine main`，然后在那里 `pnpm install`。主目录 `/Volumes/oneday/NewProject/AgentSwitch` 里有别的 agent 在工作，**一个文件都不许改**。把主目录里还没提交的设计文档和本文件复制进 worktree 的同名路径。
- **不要 commit、不要 push、不要打包**，不碰 `/Applications/AgentSwitch.app` 和 `dist/`。审核通过后由架构师提交。
- 不新增 npm 依赖。TOML 只需要读 `default_model` 和 `[[providers]]` 里的 `name / models / default / api_key_env / model_overrides`：写一个只覆盖这些字段的小解析器，**解析失败返回 null，不能抛到调用方**。
- 代码风格和现有 `src/main`、`src/renderer` 一致：2 空格缩进、不写分号、单引号；英文注释要短，只写“为什么”。
- **Claude、Codex、Gemini 三个引擎的行为一个字节都不能变**，包括它们的参数、环境变量、登录检测、用量、历史。`src/main/acp/` 不许动（`pool.ts` 若因 `ProfileKind` 扩展报类型错，只允许最小改动让它编译过）。
- 完成前必须全部通过：`pnpm run typecheck`、`pnpm test`、`pnpm run build`。

### 密钥红线

- **绝不读取、打印、复制、修改** `~/.reasonix/.env`，也不能把它的内容放进测试夹具、日志或报告。需要真实密钥做手动验证时，按第 7 节的方法在 `/tmp` 里做，做完立即删除。
- 选项 2 的密钥只能出现在 `<托管目录>/.env`，文件权限 0600。它不能出现在以下位置：
  - `config.json`
  - `secrets.json`
  - argv
  - spawn 的 env
  - `onLog` 日志、调试横幅、环境变量预览、toast
  - 报错信息
  - 测试快照
- 判断账号是否已登录时，主进程只能在内存里读出 `.env` 里那个值，并且只判断它是否非空。这个值不能被返回，也不能写进日志。

## 1. 先做：探测（任务 1，不写产品代码）

用第 7 节的临时目录方法，最多跑 **6 次** `reasonix -p`，prompt 要短，cwd 用 `/tmp/agentswitch-reasonix-check`。要弄清楚的：

1. **思考事件**：加 `--show-thinking`，并用一个需要推理的 prompt（例如“比较两种排序算法的稳定性，一句话”），记录思考事件的 `kind` 名和字段。再不加 `--show-thinking` 跑一次，看是只给一个空的思考标记，还是什么都不给。
2. **长 prompt 的传法**：help 里写了 `echo … | reasonix run`。验证 `reasonix -p --output-format stream-json`（不带 task 参数）能不能从 stdin 读 prompt。能读就统一走 stdin（`stdin: full(spec)`），不能读才把 prompt 放进 argv。
3. **权限**：在不传 `--permission-mode` 的情况下，用当前 `config.toml` 的默认权限让它执行一条 shell 命令（如 `ls`），看 `-p` 是直接拒绝（`permission_denials` 非空），还是卡住。卡住超过 60 秒就杀掉，并记为“卡住”。
4. **失败事件**：故意用一个不存在的模型 `--model nope-x`，记录失败时的 `result` 行和退出码。
5. **并发**：同一个 HOME 并发跑两条 `-p`，看会不会互相阻塞、报锁错误或写坏会话。

把每次的 stream-json 输出**脱敏后**存成测试夹具，放在 `src/main/__fixtures__/reasonix/*.jsonl`。脱敏规则：
- 去掉所有 `cacheDiagnostics`；
- 文件路径换成 `/tmp/x`；
- 夹具里不许出现任何密钥或它的前缀，用 `grep -c sk-` 检查，结果必须为 0。

探测结论写到 `docs/superpowers/plans/2026-11-23-reasonix-engine-probe.md`，最终报告里也要附上。

**探测结论决定下面两处**：
- 第 3 问“卡住”：`autoApprove: 'cli'` 改为传 `--permission-mode auto`，并在注释里写明原因。
- 第 3 问“直接拒绝”：`cli` 不传 `--permission-mode`，沿用设计文档。

## 2. 类型与元数据（`src/shared/types.ts`、i18n、图标）

- `ProfileKind` 加 `'reasonix'`，`KINDS` 末尾追加。
- `KIND_META.reasonix`：`name 'Reasonix'`、`cli 'reasonix'`、`vendor 'DeepSeek'`、`letter 'R'`。颜色和 bar 用 DeepSeek 的蓝色系，但不能和 Claude 的 DeepSeek 账号完全一样。
- `API_KEY_PAGES` 的类型是 `Record<ProfileKind | 'deepseek', string>`，要加上 `reasonix: API_KEY_PAGES.deepseek` 同一地址。写法要让它能通过类型检查。
- `ProfileConfig.configDir` 的注释加一行 `reasonix -> REASONIX_HOME`。
- 图标 `brandIcons.tsx`：复用 `DeepSeekIcon`，右下角叠一个 “R” 小角标。**不得引入任何 Reasonix 官方图形资源**。
- 4 种语言的 i18n（zh-CN / zh-TW / en / ja）都要补齐所有新文案，键名要和现有风格一致。

## 3. 账号（`src/main/profiles.ts`、`src/main/apiKey.ts`、`src/main/ipc.ts`）

- **默认配置**：
  - `KIND_DEFAULTS.reasonix`：`binary 'reasonix'`、`installCommand 'npm i -g reasonix'`、`updateCommand ''`、`models ['deepseek-flash', 'deepseek-v4-pro']`。
  - `COMMAND_DEFAULTS.reasonix`：`loginCommand ''`、`runCommand 'reasonix'`。
- **目录**：`managedDir(id, 'reasonix')` 就是 `userData/profiles/<id>`，不带子目录。`isolationEnv` 恒为 `{ REASONIX_HOME: dir }`，导入账号也一样。
- **剥离继承的环境变量**：`CREDENTIAL_VARS.reasonix = ['DEEPSEEK_API_KEY']`，保证继承来的同名变量会被 `stripCredentials` 去掉。
- **新文件 `src/main/reasonix.ts`（纯函数，可测）**：
  - `parseReasonixConfig(text)`：返回 `{ defaultModel, providers: [{ name, models, default, apiKeyEnv, efforts: Record<model, { supported: string[]; default?: string }> }] }`，解析失败返回 `null`。
  - `keyEnvName(cfg)`：找到 `default_model` 所在 provider 的 `api_key_env`。`default_model` 既可能等于 provider 的 `name`，也可能是 `models` 里的一项，两种都要支持。找不到返回 `null`。
  - `envHasValue(envText, name)`：识别 `NAME=value`，也要支持 `export NAME=value` 和带引号的值。值为空时返回 false。
  - `renderConfigToml({ defaultModel, language })`：模板原样采用设计文档 rev 2 里的 provider 块。
  - `writeEnvFile(dir, name, key)`：先写临时文件，`open` 时就给 `0o600`，再 `rename` 覆盖。写之前用 `realpath` 校验 `dir` 在 `userData/profiles/` 下，否则抛错。key 里如果有换行，直接拒绝。
- **登录检测** `detectLoggedIn` 的 `'reasonix'` 分支：读 `<dir>/config.toml`，算出 `keyEnvName`，再看 `<dir>/.env` 有没有这个值。任何一步失败都返回 false。`loginSignature` 用这两个文件的 mtime 和 size 来算。
- **`apiKey.ts`**：
  - `hasSubscriptionQuota` 对 reasonix 返回 false。签名可以改成接收 `{ kind, apiKey }`，但所有调用方都要跟着更新，而且其余三种引擎的结果不能变。
  - `ptyModeAllowed` 对 reasonix 禁止 `login`，允许 `shell`。在 shell 里运行 `reasonix setup` 是导入账号未登录时的修复路径。
- **新增账号**（`profilesAdd`）：`connect` 增加 Reasonix 专用的两种形态，`assertConnect` 要严格校验：
  - **导入（选项 1）**：`{ reasonix: 'import' }`。
    - `configDir: '~/.reasonix'`，`imported: true`。
    - 如果已经有一个 `configDir` 指向 `~/.reasonix` 的账号，就报错，不允许重复导入。
    - 这条路径**不写任何文件**。
  - **新建（选项 2）**：`{ reasonix: 'managed', key, defaultModel }`。
    - `defaultModel` 只能是 `deepseek-flash` 或 `deepseek-v4-pro`。
    - 先建目录（0700），写 `config.toml`，再写 `.env`。任何一步失败，就删除整个托管目录、移除这个账号，然后把错误抛出去，报错里不能带 key。
    - **不调用 `secrets().set`**。
- **改密钥**：`profilesSetKey` 对 reasonix 账号的处理：
  - 托管账号：重写 `.env`。
  - 导入账号：报错 `t('reasonix.importedKeyReadonly')`。
  - `isApiKeyAccount` 的判断不能把 reasonix 账号挡在外面。
- **删账号**：`removeProfile` 对托管的 reasonix 账号删除 `<dir>/.env`，只删这一个文件。删除前要满足三个条件：
  - `imported` 为 false；
  - `realpath(dir)` 在 `userData/profiles/<该 id>` 下；
  - 不等于 `realpath(~/.reasonix)`。
  - 其余引擎的删除行为不变。
- **首次运行**（`detectExisting`）：**不要**自动导入 `~/.reasonix`，只在新增账号的弹窗里提供导入入口。

## 4. 运行（`src/main/agentRunner.ts`）

新增 `reasonixAdapter(spec)`，在 `adapter =` 的三元表达式里接入。

- **参数**：`-p --output-format stream-json`，然后：
  - `--model <m>`：设了模型才传；
  - `--effort <e>`：只在 spec 或账号里有显式档位时才传，传法看现有代码怎么把 effort 传给 claude，沿用同一个字段；
  - 权限：按第 1 节的结论；
  - `--resume <sid>`：有会话 ID 时才传。
  - prompt 按第 1 节第 2 问的结论，走 stdin 或 argv。
  - `system` 和 `images` 的处理沿用 agy：`full(spec)`，图片路径列进 prompt。
- **权限映射**：`edits` 对应 `acceptEdits`，`full` 对应 `bypassPermissions`。`permission_denials` 非空时 emit `notice`，复用 `deniedText`。
- **事件映射**（`onLine`）：

  | 输入 | 输出 |
  |---|---|
  | `turn_started` | 记下 `modelRef`，去掉 `provider/` 前缀后作为 model；收到 sessionId 后只 emit 一次 `{t:'session'}` |
  | `text` | `{t:'text', delta}`，同时标记“已收到增量” |
  | `message` | 本步骤没收到过增量时，才作为 text 发出 |
  | 思考事件（第 1 节确认的 kind） | `{t:'thinking', delta}` |
  | `tool_dispatch`（只处理 `partial !== true`） | `{t:'activity', id:'rnx:'+tool.id, status:'running', type, target}` |
  | `tool_result` | 同一个 id 改成 `done`，output 用 `capText`；结果带错误标记时改成 `error` |
  | `usage` | 每次请求累加；用现有的 `Usage` 结构表示，缓存命中和未命中映射到已有字段，不新增字段，除非 `Usage` 里真的没有对应字段 |
  | 最后的 `{type:'result'}` | `result()` 返回 `{ ok: !is_error, error: is_error ? String(result) : null }`；sessionId 取 `session_id` |
  | 其他 kind | 静默忽略：`turn_status` / `user_message` / `turn_phase` / `stream_attempt` / `tool_started` / `turn_done`；别的未知 kind 走 `other(kind, obj)` 转发，不能抛错 |

  `type` 和 `target` 的取法：工具名映射到现有的 `ActivityType`（`read_file` 是读，`write_file`/`edit_file` 是写，`shell`/`bash` 是命令，`grep`/`glob` 是搜索，`web_*` 是网络，其他归为通用）。`target` 从 args JSON 里取 `path`、`command` 或 `pattern`，解析失败就用工具名。
- **出错**：
  - 进程退出码非 0，而且没收到 `result`：取 stderr 尾部作为错误，并且不能包含 key。
  - 错误文本匹配 `RATE_LIMIT_RE`：emit `rate_limited`。
  - 错误文本包含 `no stored key for`：错误替换成 i18n 文案 `reasonix.noKey`，内容是“这个 Reasonix 账号还没有密钥：导入账号请在终端运行 reasonix setup；托管账号请在账号设置里填写”。
  - 匹配 `isInvalidKeyError`：沿用现有处理。

## 5. 模型、用量、历史、界面

- **模型**（`src/main/models.ts`）：
  - reasonix 不发网络请求，读 `<dir>/config.toml`，列出所有 provider 的 `models`。
  - 默认模型是 `default_model`；它是 provider 名时，取该 provider 的 `default`。
  - 档位取 `efforts`。`disabled` 显示为“不思考”。
  - 解析失败时退回 `KIND_DEFAULTS.reasonix.models`。
- **用量**（`src/main/usage.ts`、`src/renderer/src/state/usage.ts`）：
  - 不查任何配额，`hasSubscriptionQuota` 为 false 的路径要全部走通。
  - 每轮显示花费：USD 来自 `total_cost_usd`；有 `cost_quote.valuations.CNY.money.amount` 时也显示 CNY。
  - 同时显示缓存命中率 hit/(hit+miss)。如果现有 UI 没有放花费的位置，就放进本轮的 usage 信息里，按现有 UI 已有的展示方式最小接入，不重做界面。
- **历史**（`src/main/history.ts`）：v1 不扫描 Reasonix 的磁盘会话，返回空列表，并留一行 `// TODO(reasonix-history)` 注释。但要保证聊天里存下来的 sessionId 能用来续聊（`--resume`）。
- **新增账号弹窗**（`LoginModal.tsx` 或现有的新增账号入口）：选 Reasonix 后出现两个选项。
  - **使用现有 ~/.reasonix**：主进程报告该目录不存在时，这个选项置灰。需要新增一个只返回 boolean 的 IPC，或者放进现有 snapshot，不能把目录内容传给 renderer。
  - **新建账号**：表单包含名称、DeepSeek 密钥（password 输入框）、默认模型。
    - 表单里固定显示这句警告：「Reasonix 会把密钥以明文保存在它自己的账号目录 `.env` 文件里（仅本人可读，权限 600）。AgentSwitch 不另存副本。」
    - 账号设置弹窗（`ProfileConfigModal.tsx`）里也要显示同一句警告。导入账号显示「密钥由 Reasonix 自己管理（~/.reasonix/.env），AgentSwitch 不读取」。
- **其余用到 kind 的地方**：
  - `extensions.ts`、`orchestrator.ts`、`WorkbenchPage.tsx`、`state/chat.ts` 等文件里所有按 kind 分支的代码，逐个检查一遍。
  - 有 default 分支的，确认 reasonix 走 default 是对的，不对就补上分支。
  - `orchestrator.ts:484` 附近告诉模型权限含义的 system prompt，要给 reasonix 补上和第 4 节一致的说明。
- **安装提示**：未安装时显示 `npm i -g reasonix`。同时显示一行小字：「Reasonix 上游已停止维护（最后版本 2.61.0），按 2.61.0 适配」。

## 6. 测试（vitest，先写测试，看它失败，再实现）

至少要有下面这些测试，每个都要能说清楚：它是为了防住哪种错误的改动。

- `reasonix.test.ts`：
  - `parseReasonixConfig`：要覆盖三种输入。
    - 维护者的真实结构：用设计文档里的 provider 块拼一个夹具。
    - `default_model` 写成 provider 名和写成模型名两种情况。
    - 坏 TOML 返回 null。
  - `keyEnvName`。
  - `envHasValue`：普通写法、`export`、带引号、空值、注释行。
  - `renderConfigToml`：用 `parseReasonixConfig` 回读，结果要等价。
  - `writeEnvFile`：
    - 写出的文件权限是 0600；
    - 目录在 `userData/profiles` 之外时抛错；
    - key 带换行时抛错；
    - 覆盖写之后，旧值不再存在。
- `agentRunner` 的 reasonix 适配器测试：
  - 把第 1 节的各个夹具逐行喂给 `onLine`，断言 emit 出来的事件序列，包括文本不重复、工具 running→done、sessionId、model、usage 累加、失败时的 result。
  - 未知 kind 不抛错。
  - 参数构造：四种权限映射，以及 resume、model、effort 在有和没有时各一种情况。
  - **断言 argv 和 env 里都不含夹具里的假 key**。
- `profiles` / `apiKey` 测试：
  - `isolationEnv` 给出 `REASONIX_HOME`；
  - `stripCredentials('reasonix')` 会去掉 `DEEPSEEK_API_KEY`；
  - `hasSubscriptionQuota` 和 `ptyModeAllowed` 对 reasonix 的结果；
  - **现有三个引擎原有测试的断言一条都不改**。
- 删除账号：托管账号的 `.env` 被删掉；导入账号或路径不在托管目录下时，什么都不删。

## 7. 手动验证（真实 CLI，严格限量）

- **准备临时目录**：
  1. `T=$(mktemp -d /tmp/rnx-codex.XXXX)`；
  2. `cp ~/.reasonix/config.toml $T/home/`；
  3. 在 `umask 077` 下 `cp ~/.reasonix/.env $T/home/.env`。复制是唯一允许的操作，**不能 cat、不能 grep 出值**。
  4. 所有真实运行都设 `REASONIX_HOME=$T/home`。
- **用量上限**：第 1 节的探测加上下面的端到端验证，总共最多 10 次 `reasonix` 调用，每条 prompt 一句话以内。
- **端到端验证**：用 vitest 或 node 脚本直接调用 `runAgent`（或等价入口），构造一个指向 `$T/home` 的托管账号配置。不启动 Electron 窗口。
  - 跑 1 轮读文件任务，再 `--resume` 跑 1 轮；
  - 中途 stop 1 次，确认子进程退出。
- **收尾**：做完立即 `rm -rf $T`。在报告里写明“已删除 $T”，并贴出 `ls $T` 的报错作为证据。

## 8. 交付报告（回复里必须包含，缺项视为未完成）

1. worktree 路径、分支名，以及 `git -C <worktree> status --short`。
2. 改动文件清单，每个文件一句话说明改了什么。
3. 探测结论：第 1 节的 5 个问题逐条回答，附脱敏后的关键事件样例。
4. `pnpm run typecheck`、`pnpm test`、`pnpm run build` 的结果：贴最后几行原始输出，以及测试的数量。
5. 新增测试列表，每个写一句“它防住哪种错误的改动”。
6. 「我做的决定」：所有偏离本说明或补充本说明的地方，每条写清楚“决定 / 原因 / 如果错了代价是什么”。
7. 密钥自查：用 `grep -rn "sk-" src docs` 检查 worktree，以及第 7 节临时目录已删除的证据。
8. 没做完或不确定的地方，如实写明。**不许把没跑过的东西说成通过。**

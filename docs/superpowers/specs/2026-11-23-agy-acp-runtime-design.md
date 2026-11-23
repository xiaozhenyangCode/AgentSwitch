# agy ACP 常驻会话改造 · 设计方案

- 日期：2026-11-23
- 状态：草案，待确认（已补充 T3 Code 源码中的踩坑经验，见第 11 节）
- 范围：仅 Gemini（Antigravity CLI `agy`）。Claude / Codex 不在本期，见第 9 节。

## 1. 背景与目标

现状（`src/main/agentRunner.ts` → `agyAdapter`）：每轮对话冷启动一次
`agy --output-format stream-json [--model …] [--conversation <id>] -p "<prompt>"`，读完 NDJSON 后进程退出。

限制：
1. 权限只能在启动前定死（`autoApprove`: `cli` / `edits` / `full`），agy 想执行命令时没法在界面上问用户；被拒的动作只能事后以 `notice` 提示。
2. 拿不到思考过程文本（`-p` 模式只给 `thinking_tokens`）。
3. 图片只能把路径写进 prompt 文本。
4. 每轮冷启动：加载登录态 / MCP / 规则。

目标：新增基于 `agy acp`（ACP，JSON-RPC over stdio）的运行方式，支持**界面内权限审批**、**思考文本**、**原生图片输入**、**会话内切模型/思考强度**，并且**不破坏现有历史、续聊、多账号隔离、用量统计**。保留 `-p` 方式作为后备。

非目标（本期不做）：通用 `kind: 'acp'` 第三方 Agent 接入、Claude/Codex 改造、手机远程审批。

## 2. 实测结论（agy 1.5.14，隔离账号 gemini-efe62d，2026-11-23）

| 项 | 结果 |
|---|---|
| `initialize` | 383ms。`agentCapabilities`: `loadSession`、`promptCapabilities.image=true`、`embeddedContext=true`、`sessionCapabilities`: resume / load / list / close / additionalDirectories；`_meta.antigravity.systemPrompt.append=true` |
| 认证 | 沿用隔离 HOME + 隔离钥匙串，无需额外处理，无弹窗。`authMethods` 含 oauth-personal / oauth-business / gemini-api-key / agent-platform |
| `session/new` | 2.1s。返回 `sessionId`、`models.availableModels`（含 `gemini-4-neon-high` 等带 effort 后缀的 ID）、`modes`（default / accept-edits / auto / plan）、`configOptions`（`model`、`thought_level`） |
| 会话 ID 兼容 | **ACP 的 `sessionId` 与 `-p` 的 `conversation_id` 是同一套**，都落在 `~/.gemini/antigravity-cli/conversations/<id>.db`。`-p` 建的旧会话可以 `session/resume`（不回放）或 `session/load`（回放全部历史事件） |
| 不存在的 ID | `session/resume` 报错 `-32603 Failed to read session…`；`session/load` 却返回 ok（会静默新建）→ 续聊必须用 `resume`，失败再降级 |
| `session/list` | 可用，返回 sessionId / cwd / title / updatedAt |
| 一轮 prompt | “执行 `echo acp-probe`” 共 8.9s。事件：`session_info_update`(title) → `tool_call`(kind=execute, in_progress) → `tool_call_update`(pending) → **`session/request_permission`**（options: `allow`/allow_once、`deny`/reject_once）→ in_progress → completed → `agent_message_chunk` → `usage_update` |
| prompt 结果 | `{stopReason:"end_turn", usage:{inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens}}` |
| 思考文本 | 回放历史时出现 `agent_thought_chunk`，说明 ACP 下**能拿到思考文本**（`-p` 拿不到） |
| 上下文 | `usage_update {used, size}`，size=1048576 |

> 探测时在该账号里留下了 2 个测试会话（cwd=`/tmp/acpprobe`，ID `fb8d2a1e…`、`5ce854ed…`），可以删除。

## 3. 总体架构

```
orchestrator.ts ──runAgent(spec)──▶ agentRunner.ts
                                      ├─ claude / codex：不变（每轮进程）
                                      └─ gemini：
                                           cfg.agyTransport === 'acp' ?
                                             acp/agySession.ts  ──▶ AcpPool（每账号 1 个常驻 agy acp 进程）
                                           : agyAdapter（现有 -p，后备）
```

新增模块（`src/main/acp/`）：

| 文件 | 职责 |
|---|---|
| `jsonrpc.ts` | 通用 NDJSON JSON-RPC 2.0 客户端：请求/响应配对、通知分发、**处理 agent 发来的请求**（`session/request_permission`、`fs/*`）、超时、进程退出时让所有挂起请求失败 |
| `acpProcess.ts` | 通用 ACP 进程：spawn（`detached`，复用 `buildSpawnSpec(id,'run').env`）、`initialize`、stderr 进调试抽屉、崩溃检测。**与 agy 无关**，第二阶段 `kind:'acp'` 直接复用 |
| `pool.ts` | 进程池：key = `profileId`；懒启动；空闲 **10 分钟**回收；账号配置/登录状态变化时回收；应用退出时全部关掉 |
| `agySession.ts` | agy 专用：把 `RunSpec` 翻译成 ACP 调用，把 `session/update` 翻译成现有 `AgentEvent`，对外仍返回 `RunHandle` |

**对 orchestrator 的接口不变**：`runAgent(spec, emit, onLog) → { done, kill }`。orchestrator、history、usage 都不用知道底层换了。

## 4. 一轮对话的流程

1. `pool.get(profileId)` 取/启进程（首次约 0.4s + 隔离目录准备）。
2. 会话：
   - `spec.resume` 有值 → `session/resume {sessionId, cwd, mcpServers: []}`；该 sessionId 已在本进程中活跃则跳过。
   - resume 失败 → 记 `notice`，`session/new`（与现在 `--conversation` 失效时的行为一致）。
   - 无 resume → `session/new`。
   - 拿到 sessionId 立即 `emit({t:'session', id, model})`。
3. 模型 / 思考强度：`splitSpec(spec.model)` → 与当前值不同才 `session/set_config_option`（`model`、`thought_level`）。具体方法名以 1.5.14 返回的 `configOptions` 为准，实现时先测。
4. 权限模式（**参考 T3 Code 修订，见 11.3**）：会话始终保持 agy 的 `default` 模式，不用进程级 `--dangerously-skip-permissions`。所有权限请求都由 AgentSwitch 按账号当前的 `autoApprove` 回复：`full` → 自动允许；`edits` → 改文件自动允许、执行命令询问用户；`cli` → 全部询问用户。这样修改权限设置后下一轮就生效，不用重启进程，池 key 也只需要 `profileId`。
5. `session/prompt`：
   - `prompt: [{type:'text', text}]`；`system` 优先用 `_meta.antigravity.systemPrompt.append`，不支持则沿用现在“前置拼接”的做法。
   - 图片：读文件转 `{type:'image', mimeType, data: base64}`，单张超过 5MB 或格式不支持时退回“路径写进文本”。
6. 等 `session/prompt` 返回 → 用 `stopReason` / `usage` 组装 `RunResult`。
7. `kill()` → `session/cancel`，按 11.2 的顺序处理：cancel 必须等 prompt 已经发到 agy 之后再发；发出后最多等 15s，agy 还没结束本轮就杀掉整个进程组（池里移除，下次重启）。
8. 本轮结束后检查会话数据库最后一步是不是错误（见 11.1），是的话把这一轮标成失败或限流，不能只看 `stopReason`。

## 5. 事件映射（ACP → AgentEvent）

| ACP `session/update` | AgentEvent |
|---|---|
| `agent_message_chunk` (text) | `{t:'text', delta}` |
| `agent_thought_chunk` | `{t:'thinking', delta}`（**新增能力**） |
| `tool_call` / `tool_call_update` | `{t:'activity', id: 'agy:'+toolCallId, …}`：复用 `agyTool()` 的分类规则（`name` + `rawInput` 等价于现在的 `tool_name` + `parameters`）；`kind` 字段（execute/edit/read/search…）作为更可靠的分类依据 |
| `usage_update {used,size}` | 记为上下文，最后放进 `usage.context` |
| `session_info_update` (title) | 先忽略（会话标题由 AgentSwitch 自己管） |
| `available_commands_update` | 先忽略（第二期可用于 `/` 命令补全） |
| `plan` | `other_event`，后续可做计划视图 |
| 其他 | `other_event`（沿用 200 条上限） |
| `session/prompt` 结果 `usage` | `{t:'usage', usage:{input, output, cacheRead, reasoning: thoughtTokens, context}}` |
| `stopReason` = `end_turn` | `ok: true`；`cancelled` → `stopped`；`refusal` / `max_tokens` 等 → `ok:false` + 原因 |
| JSON-RPC error 含 `RESOURCE_EXHAUSTED` / 限流文本 | `{t:'rate_limited'}`（复用 `RATE_LIMIT_RE`） |

## 6. 界面内权限审批（本次唯一需要改 UI 的地方）

流程：agy 发来 `session/request_permission` → 主进程挂起该请求 → 通过现有 orchestrator 事件通道发 `{t:'permission', requestId, tool, target, options}`（新增 AgentEvent 类型）→ 渲染进程在该步骤的活动卡片上显示「允许 / 拒绝」（若 agy 给了 `allow_always` 也显示）→ IPC `agent:permission-reply` → 主进程回复 `{outcome:{outcome:'selected', optionId}}`。

规则：
- 只有 `autoApprove = 'cli'` 和 `edits`（仅命令类）才会弹；`full` 自动允许，不弹。
- **选择题**也走同一个 `session/request_permission`（`toolCallId` 以 `interaction_` 开头，见 11.4），卡片显示成问题和选项；`full` 也不能自动回答。
- 显示 `allow_always`（“本会话都允许”）和它附带的安全警告；另有「取消」按钮（见 11.3）。
- 用户停止本轮 / 关闭会话 → 回复 `{outcome:{outcome:'cancelled'}}`。
- **dispatch 自动派活场景**：没人盯着时不能无限等。默认 **5 分钟**无响应自动拒绝并给 `notice`；后续可加设置项。
- 卡片上展示命令全文 / 文件路径，按现有 activity 样式，不做新弹窗。

## 7. 多账号隔离、历史与用量

- 进程 env 完全复用 `buildSpawnSpec(id,'run')`：隔离 HOME、隔离钥匙串、清理 Google 变量、`AGY_CLI_DISABLE_AUTO_UPDATE=1` 都自动继承。不改用 `--gemini-dir`（会和现有 `prepareProfileDir` 的软链、钥匙串布局冲突，没有收益）。
- 历史：会话仍写在 `conversations/<id>.db`，`history.ts` 的读取逻辑**不用改**；`saveSession(threadId, profileId, sessionId)` 也不变，ACP 与 `-p` 可以互相续聊。
- 用量：`refreshAgyQuota`（`agy -p "/usage"`）不变。
- 模型列表：`session/new` 返回的 `availableModels` 比 `agy models` 更全（含 effort 后缀），可顺手更新 `models.ts` 的缓存，但非必须。
- 并发：同一账号同时跑两轮（不同线程）→ 同一进程里两个 session 并行，ACP 支持；如果实测有问题，就对同一账号排队或加 `--process-per-session`。

## 8. 开关、回退与上线步骤

- 新增账号级配置 `agyTransport: 'print' | 'acp'`（Gemini 账号设置里一个开关，默认 `print`）。
- ACP 进程启动 / `initialize` 失败 → 本轮自动退回 `-p`，并给 `notice`；连续失败 3 次后该账号本次运行期内固定走 `-p`。
- 分步：
  1. **P1 运行时**：`jsonrpc.ts` + `acpProcess.ts` + `pool.ts` + `agySession.ts`，权限先按模式自动回复（不改 UI），事件映射、续聊、停止、用量都跑通。默认关闭，设置里手动打开。
  2. **P2 审批 UI**：新增 `permission` 事件、活动卡片按钮、IPC、超时拒绝。
  3. **P3 增强**：思考文本展示、原生图片、`/` 命令、模型列表更新。
  4. 稳定后把默认改成 `acp`，`-p` 留作后备。
  5. （另立方案）基于 `acpProcess.ts` 做通用 `kind: 'acp'`。

## 9. Claude 和 Codex 要不要一起改？——建议本期不改

| | 现状 | 有没有对应的“常驻/双向”方式 | 建议 |
|---|---|---|---|
| Claude | `claude -p --output-format stream-json`，权限按 `--permission-mode` 预设 | 有：`--input-format stream-json` 可以一个进程连续收多条消息；`--permission-prompts host` / `--permission-prompt-tool` 可以把权限请求交给宿主（本机 2.1.330 已支持）。另有第三方 ACP 适配器（基于 Claude Agent SDK） | **本期不做**。Claude 的流已经有思考文本、图片、精确的用量；缺的只有界面审批。等 P2 的审批 UI 做好后，用它自己的 `--permission-prompts host` 接进同一个审批卡片即可，不需要走 ACP |
| Codex | `codex exec --json` + `resume`，`approval_policy="never"` | 有：`codex app-server`（官方 JSON-RPC，本机 0.171.0 标注 experimental），也有社区 `codex-acp` | **本期不做**。app-server 还是实验性，协议可能会变；等它稳定后，单独做一个 Codex 适配器接同一个审批 UI |

理由：
1. 三家各有自己的原生协议，ACP 对 Claude/Codex 都要靠第三方适配器，多一层依赖、更容易坏。
2. 真正通用的是**界面审批卡片 + `permission` 事件**（P2），这部分做成与具体 CLI 无关，以后 Claude（`--permission-prompts host`）和 Codex（app-server）都能接进来。
3. 先在 agy 一家上验证常驻进程的稳定性（崩溃、空闲回收、并发、长时间运行），风险最小。

## 10. 风险与待验证

| 风险 | 应对 |
|---|---|
| agy 版本升级改了 ACP 字段 | 事件解析全部容错，未知字段进 `other_event`；`initialize` 记录 `agentInfo.version` 到调试日志 |
| 常驻进程内存占用 | 空闲 10 分钟回收；设置页显示当前常驻进程数 |
| 进程崩溃 | 挂起请求全部失败 → 本轮报错；下次自动重启；配合第 8 节的回退 |
| 登录过期 | prompt 返回认证错误时提示重新登录，并回收该账号进程 |
| `session/load` 对不存在的 ID 静默新建 | 续聊只用 `session/resume` |
| 并发 session 是否互相影响 | P1 实测；有问题就对同一账号排队 |
| `session/set_config_option` 的方法名和参数 | P1 开头用探测脚本确认 |
| **上游错误 / 限流以 `end_turn` 返回** | 每轮结束读会话数据库最后一步（11.1） |
| 停止时 cancel 被丢掉 / agy 不响应 | 按 11.2 的时序，超时杀进程组 |
| 本轮结束后后台命令继续跑、agy 自己再回复 | 只记日志，回收前检查（11.5） |
| stderr 泄露令牌 / 登录链接 | 落盘前脱敏（11.6） |
| 同一会话并发 prompt 会被插进当前轮 | 同一会话串行（11.9） |

## 11. 借鉴 T3 Code 的坑（读源码所得）

来源：`pingdotgg/t3code` @ `58e309e7`（浅克隆在 `/Volumes/oneday/NewProject/_ref/t3code`，只读）。主要文件：
`packages/provider-acp/src/server/AcpSessionRuntime.ts`（3247 行，通用 ACP 运行时）、`stderr.ts`，
`apps/server/src/provider/acp/AntigravityAcpSupport.ts`、`AntigravityProtocol.ts`、`AntigravityTurnOutcome.ts`、`AntigravitySessionFiles.ts`，`apps/server/src/provider/antigravityAuthSupport.ts`。
T3 Code 是 MIT 协议；这里只借鉴做法，不拷代码。

### 11.1 上游错误会伪装成正常结束（最重要）
`AntigravityTurnOutcome.ts`：agy 遇到上游 API 失败（限流、配额用尽、502 等）时，**把错误当成一条普通聊天消息发出来，然后照样返回 `stopReason: end_turn`**。只有会话数据库里这一轮的最后一步是 error step（step_type 17）。
- 对我们的影响：只看 `stopReason` 的话，限流会被当成成功，`rate_limited` 事件、限流后自动换账号、失败重做全都会失效。
- 做法：prompt 前记下 `conversations/<id>.db` 当前最大的 step 序号；返回后只读新增的步骤，最后一步是 error 就把这一轮标成失败。错误文本按 T3 用的格式解析：`Error NNN, Message: …, Status: …`、`STATUS (code NNN): …`、`reason:QUOTA_EXHAUSTED`、`quotaResetTimeStamp` / `quotaResetDelay` / `retryDelay`，解析结果接到现有的 `rate_limited` 和用量窗口。`history.ts` 已经能读这个 sqlite 和 protobuf 步骤，可以复用。
- 另一个相关的坑：在 agy 里用 Claude 模型时，如果历史里存了一个签名无效的 thinking 块，**这个会话以后每一轮都会以同样的错误失败**（`thinking.signature: Field required` / ``Invalid `signature` in `thinking` block``）。遇到这个错误要提示用户“这个会话已经不能继续，需要新开”，并且不要自动重试。

### 11.2 停止（cancel）的时序
`AcpSessionRuntime.ts` 的 `cancel`，agy 用的是 `cancelBehavior: "wait-for-prompt"`：
- **cancel 发早了会被 agy 直接丢掉**：如果 `session/cancel` 比它要取消的 `session/prompt` 先到，agy 不会处理。所以必须等 prompt 已经写进 stdin 后再发 cancel（最多等 15s）。
- 发出 cancel 后，**等 prompt 自己返回**（agy 会返回 `stopReason: cancelled`），并把剩下的事件处理完再结束本轮；15s 内没返回，就认为进程卡死，杀掉整个进程组。
- 杀进程：先 SIGTERM，等 1s，再 SIGKILL，**对整个进程组发信号**（agy 执行的命令是它的子进程）。现有 runner 已经用 `detached: true`，沿用即可。

### 11.3 权限：会话保持 default 模式，由客户端回答
`AntigravityAcpSupport.ts`：`agy acp` 会拒绝 `yolo` / `auto_edit` 模式，而且只有部分会话支持 `auto`。T3 的做法是会话一直保持 `default`，所有权限请求都由 T3 按当前策略回复，权限改动下一轮生效，不用重启。第 4 节已按这个改。
- 权限选项按 `kind` 找（`allow_once` / `allow_always` / `reject_once`），不按 `optionId` 写死。
- `allow_always` 选项的 `_meta["agy.security.warning"]` 里可能带安全警告（shell / 网页类），要显示在按钮旁边。
- 界面上另加一个「取消」：回复 `{outcome:'cancelled'}`。

### 11.4 选择题也走权限请求
`AntigravityProtocol.ts`：agy 向用户提问（给选项让用户选）时用的是**同一个 `session/request_permission` 方法**，区别是 `toolCall.toolCallId` 以 `interaction_` 开头。这时的选项是答案，不是允许 / 拒绝。
- 审批卡片要区分两种请求：`interaction_*` 显示成问题和选项按钮；其他显示成允许 / 拒绝。
- 自动派活时：`full` 模式可以自动允许权限请求，但**不能自动回答问题**。问题超时（5 分钟）就取消，并给 notice。

### 11.5 工具调用可能比本轮活得更久
`AntigravityProtocol.ts`：agy 的 `run_command`（非 daemon）和 `schedule` 工具，在本轮 prompt 返回后还可能继续运行，**结束后 agy 会自己再发一轮回复**；daemon 命令可能永远不结束。
- `-p` 模式下进程退出就全没了，所以现在没遇到过；常驻进程下**本轮结束后还可能收到这个会话的 `session/update`**。
- P1 的做法：本轮结束后收到的这个会话的事件，只写进调试日志，不发给界面；并且在本轮结束时把还在 `in_progress` 的工具标成「后台运行中」。以后可以考虑把这种延迟回复追加到对话里。
- 空闲回收进程前，先确认没有还在运行的命令类工具，有的话推迟回收。

### 11.6 进程启动和 stderr
- **每个启动请求都要设超时**：`initialize`、`session/new`、`session/resume` 都设 90s。进程活着但一直不回握手时，没有超时的话这一轮会永远卡住。
- **stderr 可能出现 16KB 长的 Google 登录 URL**，单条 stderr 按 32KB 截断，只保留最后 4KB 用于报错。
- **stderr 写进日志和报错前要脱敏**（参考 `stderr.ts`）：把 HOME 路径换成 `~`，屏蔽 `accounts.google.com` 链接、`Bearer …`、`Authorization: Basic …`、`x-api-key:`、`sk-…`、`ghp_…`、`xox?-…`。我们的调试抽屉和 runDir 日志都会落盘，这一步必须做。
- 进程退出时，等 stderr 读完（最多 250ms）再生成错误信息，否则报错里常常看不到真正的原因。

### 11.7 客户端能力声明
- `fs.writeTextFile` **不要声明为 true**：声明后 agy 会改用 `client_edit_file` 整文件写入，丢掉 diff 形式的编辑，活动卡片就没法显示改动。P1 两个 fs 能力都声明 false，`terminal: false`。
- `session/new` / `resume` 每次都要带上 `additionalDirectories`（ACP 叫 roots）：**不带会清空 agy 记住的额外目录**。我们目前不用额外目录，传空数组，但字段要一直带。
- system prompt 只在 `initialize` 返回 `_meta.antigravity.systemPrompt.append === true` 时，通过 `session/new` / `resume` 的 `_meta.antigravity.systemPrompt.append` 传，否则退回前置拼接（我们实测 1.5.14 支持）。

### 11.8 模型选择
- **冷启动续聊时返回的“当前模型”是默认值，不是这个会话上次用的模型**。不能用它覆盖用户选的模型，每次 resume 后都按 AgentSwitch 自己保存的选择重新设置一次。
- 1.4 起思考强度是单独的 `thought_level` 选项，1.3 是写在模型 ID 里（`gemini-3.8-flash-high`）。agy 仍然接受旧格式的 ID，所以解析时先按 `configOptions` 找模型家族，找不到再当完整 ID 传。
- 设置选项时，如果 agy 在请求还没返回前就推送了新的 `config_option_update`，以推送的为准（T3 在 Kiro 上遇到过返回值比推送更旧的情况）。

### 11.9 并发与“追加提示”
- **agy 1.5.0 起，一轮还在跑时再发一个 prompt，会把新消息插进正在跑的这一轮（steer），而不是排队**（1.4 是排队）。所以同一个会话必须串行：上一轮的 `session/prompt` 返回之前，不能发下一个。T3 用了三把锁（prompt 串行、prompt 发送、session/load）。
- 同一个进程里不同会话可以并行，但对某个会话做 `session/load` 回放历史时，只隔离那一个会话的事件，其他会话照常。
- 回放历史产生的事件（`user_message_chunk` 等）**不能当成新一轮的输出**。P1 续聊只用 `session/resume`（不回放），就没有这个问题；以后要用 `session/load` 时，要按“2 秒没有新的回放事件就算加载完”来判断，因为有的 agent 的 `session/load` 一直不返回。

### 11.10 和 T3 Code 不同、不照搬的地方
| T3 Code 的做法 | AgentSwitch | 原因 |
|---|---|---|
| `--gemini-dir <profile> --app-data-dir antigravity-acp`，ACP 会话存在单独的 `antigravity-acp/conversations` | 不传，沿用隔离 HOME，会话存在 `antigravity-cli/conversations` | 和 `-p` 模式共用会话，历史和续聊不用改；T3 没有历史包袱 |
| 设 `SSH_CONNECTION` 让 agy 用文件存凭据，登录走 `agy acp --login` 贴回调码 | 隔离钥匙串（`1933dee`） | macOS 上登录不用多操作；以后做 Linux / Windows 再考虑 |
| Linux cgroup、Windows taskkill、子进程树台账 | 只用进程组 SIGTERM → SIGKILL | 目前只支持 macOS |
| 每个对话线程一个运行时 | 每个账号一个进程，多个会话 | 省内存；agy 支持一个进程里多个会话。如果实测有问题，改成每个线程一个进程，接口不变 |
| 用 Effect 框架写 | 普通 TypeScript + Promise | 和现有代码风格一致 |

## 12. 工作量估计

- P1：主进程约 700–900 行新代码（比初稿多出的部分是 11.1 的错误检测、11.2 的停止时序、11.6 的脱敏），`agentRunner.ts` 少量改动，加单元测试（JSON-RPC 配对、事件映射用录制的 NDJSON 做 fixture）。
- P2：主进程约 100 行，渲染进程约 150–200 行（活动卡片按钮 + IPC + i18n）。
- P3：按需。

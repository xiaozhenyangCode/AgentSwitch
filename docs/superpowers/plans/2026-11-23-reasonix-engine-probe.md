# Reasonix 2.61.0 探测记录

在 /tmp 中隔离配置和工作目录，使用第 7 节的文件复制例外执行六次 `-p`。只保存脱敏后的 JSONL 到 `src/main/__fixtures__/reasonix/`。六个文件中的密钥前缀匹配数均为 0。

| 问题 | 结果 |
| --- | --- |
| 思考 | `--show-thinking` 得到 `{"kind":"reasoning","text":"The"}`。快捷 stdin 任务省略该标志时没有思考事件，省略标志的 shell 任务仍收到非空思考增量。用现有 UI 折叠这些事件。 |
| 标准输入 | 无 positional task、只从 stdin 传入短提示，得到 `{"type":"result","is_error":false,"result":"STDIN_OK_71"}`。所有提示从 stdin 传递。 |
| 权限 | 复制来的配置为 `mode = "ask"`。无权限参数执行无副作用的 `ls`，4.1 秒完成，退出 0，`permission_denials: []`。这条命令没有触发审批。在后续端到端验证中，只在临时配置里添加 `ask = ["Bash"]`。进程在 21.1 秒内成功退出，适配器收到 1 条权限拒绝通知。CLI 模式保留各账号的权限规则。 |
| 失败 | 不存在的模型在 stdout 产生 `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"unknown model …"}`，无会话 ID，退出 1，stderr 为空。 |
| 并发 | 两个进程共享一个 HOME，0.9 秒和 0.8 秒分别成功，结果和会话 ID 各自独立，stderr 均为空。两次任务使用不同会话。 |

同一工具的非 partial dispatch 在样本中出现两次，使用工具 ID 避免重复的 running 事件。用量事件按请求给出增量，带两次请求的 shell 样本命中 12928、未命中 530。最终结果另给出 USD 及 CNY 数值。

```json
{"kind":"turn_started","sessionId":"fixture-6","modelRef":"deepseek/deepseek-flash"}
{"kind":"tool_dispatch","tool":{"id":"fixture-8","name":"bash","partial":true}}
{"kind":"tool_result","tool":{"id":"fixture-8","name":"bash","output":"exit status: 0\n","execution":{"exitCode":0}}}
{"kind":"usage","usage":{"promptTokens":6771,"completionTokens":24,"cacheHitTokens":6528,"cacheMissTokens":243}}
```

探测 HOME 删除证据

```text
ls: /tmp/rnx-codex.4525e30x: No such file or directory
```

## 真实 CLI 端到端

共使用 10 次 CLI 进程，其中 6 次探测和 4 次端到端。第一次测试脚本未完成加载，未启动 CLI。第二次用精简环境启动，读文件进程退出 1，随后显式 shell 审批场景退出 0 并收到 1 条权限拒绝通知。最后两次带上实际环境中的代理变量，读文件和用量通过验证。续聊在同一会话输出了上一轮文件内容，随后停止，进程组收到 SIGTERM，检查返回 ESRCH。

```text
[live] ── exited (code 0)
[live] file {"ok":true,"session":true,"read":true,"recalled":true,"cost":true,"cny":true,"cache":true}
[live] ── exited (code null, SIGTERM)
[live] resume {"same":true,"recalled":true,"stoppedAfterText":true,"stopped":true}
[live] stop terminated the process group (ESRCH)
ls: /tmp/rnx-codex.c0BM: No such file or directory
ls: /tmp/rnx-codex.fRVs: No such file or directory
ls: /tmp/rnx-codex.pB5v: No such file or directory
```

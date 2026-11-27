# Antigravity Resilient for Paseo

Paseo 0.17+ 内置了基于 ACP（`agy acp`）的官方 Antigravity provider。本插件（`0.3.1`）直接基于 Paseo `v0.17.4` 官方 [`plugins/antigravity-provider`](https://github.com/getpaseo/paseo/tree/a583aec723d0bbd99ba1b3f42cf07b2ab7c3705c/plugins/antigravity-provider) 重新构建，完整继承官方 ACP 能力，并保留独立身份与生产环境韧性增强。

插件注册为独立的 provider `antigravity-resilient`（插件 ID `antigravity-resilient-provider`），可与内置 `antigravity` 并存。对比基线与模块说明见 [docs/UPSTREAM.md](docs/UPSTREAM.md)，安装步骤见 [docs/INSTALL.md](docs/INSTALL.md)。

## 继承的官方 `v0.17.4` ACP 能力

- 原生 `agy acp` 会话生命周期、`session/load` 完整历史回放（含用户消息、流式思考 `agent_thought_chunk`、带输出的工具调用及压缩前历史）。
- 每个模型独立的思考档位（`perModelThinkingOptions`，如 Orchestrator 无思考档位、Neon 支持到 `xhigh`）。
- 默认开启 `full-access` 自动审批模式，同时支持切换 `agy` 原生模式（`default`、`accept-edits`、`plan` 等）。
- 非 daemon 后台工具（`run_command` 后台任务）保持回合打开，而 `IsDaemon: true` 与周期性 `schedule`（`CronExpression`）在 `end_turn` 后立即收尾回合。
- 内置命令（`goal`、`compact`、`schedule` 等）与技能（`kind: "skill"`）分类展示，以及规范化 `shell` / `read` / `write` / `edit` / `web_search` / MCP 工具详情映射。

## 本插件在此之上的增强

### 1. 自动上下文压缩（空闲压缩 + 轮前压缩 + 熔断保护）

- **请求后 2.5 分钟空闲压缩**：Gemini 隐式提示缓存名义 TTL 为 5 分钟，但 4–5 分钟区间命中率显著下降。当 `session.usage` 的 `contextWindowUsedTokens >= 150,000`（可通过环境变量 `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` 覆盖，下限 `100,000`）时，本插件以模型请求发起时刻为锚点，在约 2.5 分钟后（`autoCompactLeadMs = 150,000`）自动在 ACP 会话内执行 `/compact`。
- **轮前自动压缩**：持续忙碌的会话等不到空闲窗口。在新一轮非斜杠命令的业务请求开始前，若上下文 `>= 150,000` 且提示缓存已过期，或上下文 `>= 200,000`（`providerOptions.preTurnCompactTokenThreshold`），先执行 `/compact` 再发送本轮消息。
- **原生压缩时间线与无损排队**：内部 `/compact` 不会显示成用户消息或空回合，而是发出原生 `compaction` 时间线条目（`loading` → `completed`）；由于 `/compact` 返回后 `usage_update` 要到下一次真实模型请求才会下降，压缩完成后会标记已压缩直至下一轮真实模型请求更新用量，避免重复压缩（若同一长回合内原生压缩后又涨回阈值之上，仍会正常触发压缩）。压缩期间发来的用户消息自动排队等待，用户中断时立即取消压缩且不发送排队中的轮前消息。
- **开关与熔断**：设置 `DISABLE_COMPACT=1`（或 `providerOptions.autoCompactEnabled = false`）可关闭自动压缩；连续 3 次压缩失败或连续 3 次在 10 次模型请求内迅速回填到阈值会自动熔断并给出提示。

### 2. 有限次暂时性故障恢复与真实报错诊断

- **启动与目录阶段**：针对 `agy` 自更新替换二进制引发的 `EBUSY` / `EPERM` / `ENOENT` 启动失败按 `1s / 2s / 4s` 退避重试，并设每会话（60 秒最多 6 次）和全局（60 秒最多 30 次）启动频率上限；模型目录探测偶发失败时重试一次，仍失败则有限次沿用最近一次有效目录（标记 `catalogStale`）。
- **回合阶段自动恢复**：
  - **OAuth 401 刷新竞争**：等待 8 秒后自动重试 1 次；
  - **流中断或后端瞬时网络错误（`UNAVAILABLE` / `INTERNAL` / `EOF` / `502–504`）**：等待 2 秒后自动重试 1 次；
  - **回合中途 `agy` 进程异常退出**：等待 1.5 秒后通过 `session/load` 自动重开会话并恢复，最多 1 次（单回合总恢复次数上限为 2 次）。
  - **不重复执行副作用工具**：若故障发生在本轮已有进展或工具调用之后，恢复时发送续接指令而非重发原始 prompt，防止已执行工具被重复触发；每次恢复均推送可见 `session.notice`。
- **非暂时性错误快失败与模型列表核实**：登录真正失效、`RESOURCE_EXHAUSTED`（429）额度耗尽、`Session not found` 均立即失败；当 `agy` 拒绝某个模型时，等待 3 秒重新探测一次实时目录，若仍在列表中则重开一次会话，确已下架则立即返回 `INVALID_MODEL` 并刷新缓存键。
- **真实诊断替换**：将 SDK 的通用报错（如 `ACP transport closed unexpectedly`、`ACP connection closed`）替换为子进程退出码、信号、JSON-RPC 错误详情及脱敏后的 `stderr` 尾部。

### 3. 旧会话与旧模型 ID 无缝兼容

- **旧 `stream-json` 会话直开**：自动识别旧版插件持久化的 `{ version: 1, data: { conversationId } }` 及 `{ version: 1, data: { sessionKey } }`（只读解析 `~/.paseo/antigravity-resilient/conversations/session-keys/`），通过 ACP `session/load` 重开并回放历史；本机已有的旧版回放文件原样保留不删改。
- **思考档位后缀模型 ID 兼容**：目录中为每个模型自动补充 `<model>-<thinkingOption>` 别名（如 `gemini-4-hydrogen-medium`、`gemini-3.8-flash-low`），新建会话、重开会话与运行中切换模型时均自动拆分为基础模型 ID 与 `thought_level`。

### 4. CLI 订阅额度与 Windows 支持

- **纯 CLI 额度查询**：仅调用 `agy -p /usage --output-format json` 获取各模型组额度窗口与禁用状态，不再读取操作系统凭据库，也不直接请求远端配额接口。同账号会话共享归一化后的单个 `launch` 定位符与 5 分钟缓存（忽略 `PASEO_AGENT_ID` 等每会话变量，防止并发拉起多个 CLI 进程）；默认不在 `scope.kind === "global"` 注册全局源以避免未打开本插件会话时多跑一次查询（注：打开过 `antigravity-resilient` 会话后，Paseo 宿主的 `UsageSourceRegistry.mergeKnown()` 仍会将该会话源并入全局已知列表；若禁用了内置 `antigravity` 插件，可设 `PASEO_ANTIGRAVITY_RESILIENT_GLOBAL_USAGE=1` 开启初始全局发现）。
- **Windows 开箱即用与取消兜底**：daemon `PATH` 不含 `agy` 时自动回退 `%LOCALAPPDATA%\agy\bin\agy.exe`，同时若用户在 `~/.paseo/config.json` 配置了自定义 `env.PATH` 或 `env.LOCALAPPDATA` 则优先使用用户配置；使用宿主 SDK 终止完整子进程树；取消回合或压缩时附带 5 秒兜底超时（自动校正系统休眠唤醒时钟跳变）；回合仅执行了前景工具而未输出收尾正文时推送提示通知。

# Antigravity Resilient

在 Paseo 中以独立 provider `antigravity-resilient` 运行 Google Antigravity（`agy acp`）agent，可与内置的 `antigravity` provider 并存。插件基于 Paseo 0.17.4 官方 Antigravity provider 构建，在此之上增加了自动上下文压缩、暂时性故障的有限次恢复、旧会话兼容和额度卡片。

## 工作方式

插件为每个会话以 ACP 模式启动 `agy` CLI，保留官方 provider 的全部能力：通过 `session/load` 完整回放历史、每个模型独立的思考档位、agy 原生模式，以及相同的工具和时间线映射。下面这些增强都在同一个 ACP 会话内完成。

## 前置条件

- Paseo 0.17.3 或更高版本（在 0.17.4 上测试过）。
- Antigravity CLI `agy` 1.5.15 或更高版本，由运行 Paseo daemon 的同一用户安装并登录。Windows 下如果 daemon 的 `PATH` 里没有 `agy`，插件会改用 `%LOCALAPPDATA%\agy\bin\agy.exe`。
- 除了能正常登录的 `agy`，不需要其他账号、令牌或设置。

## 增强功能

- **自动压缩。** 会话上下文达到 150,000 token 后，插件在最后一次模型请求约 2.5 分钟后执行 agy 的 `/compact`，赶在 Gemini 提示缓存过期之前。持续忙碌的会话会在下一轮开始前压缩，条件是缓存已过期且上下文至少 150,000 token，或上下文达到 200,000 token。压缩在时间线里显示为压缩条目，期间发来的消息会排队，用户中断会取消压缩。连续 3 次失败或 3 次迅速回涨后会暂停并给出提示。压缩本身是一次模型请求，会消耗 Antigravity 额度。
- **有限次恢复。** 令牌刷新空档等 8 秒后重试 1 次。流中断或后端暂时性错误（`UNAVAILABLE`、`INTERNAL`、`EOF`、502 到 504）等 2 秒后重试 1 次。回合中途 `agy` 进程退出时，通过 `session/load` 重开 1 次。每个回合最多恢复 2 次。如果本轮已经执行过工具，插件发送续接指令而不是重发原始请求，工具不会重复执行。每次恢复都会显示提示。登录失效、额度耗尽（429）和会话不存在会立即失败。
- **更清楚的报错。** 通用的传输错误会替换成 agy 的退出码、信号、JSON-RPC 错误和脱敏后的 stderr 尾部。
- **启动加固。** agy 自更新替换二进制导致的启动失败会退避重试，并按会话和全局限制启动频率。
- **旧会话和旧模型 ID。** 本插件早期 stream-json 版本保存的会话可通过 `session/load` 重开。带思考档位后缀的模型 ID（如 `gemini-4-hydrogen-medium`）会被当作"基础模型 + 该档位"的别名。
- **额度卡片。** 额度窗口只通过运行 `agy -p /usage --output-format json` 获取，每个账号缓存 5 分钟。插件不读取系统凭据库，也不自己请求额度接口。

## 设置

- 在 daemon 环境里设置 `DISABLE_COMPACT=1` 可关闭自动压缩。
- `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` 修改空闲压缩阈值（最低 100,000）。
- `PASEO_ANTIGRAVITY_RESILIENT_GLOBAL_USAGE=1` 让额度卡片在还没打开过本 provider 的会话时就全局显示，适合禁用了内置 `antigravity` 插件的情况。

## 数据与权限

- 提示词、agent 读取的文件和工具结果由 `agy` 发送给 Google 的 Antigravity 服务，与任何 Antigravity 会话相同。
- 新会话默认使用 agy 的 `full-access` 模式，工具调用会自动放行。需要审批时，可按会话切换到 `default`、`accept-edits` 或 `plan`。
- 插件会启动和停止 `agy` 子进程，自己不写任何文件；早期版本留在 Paseo 目录下的会话文件只读取，不会修改。

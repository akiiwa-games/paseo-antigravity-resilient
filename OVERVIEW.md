# Antigravity Resilient

基于 Paseo `v0.17.4` 官方 ACP 版 Antigravity provider（`agy acp`）构建的增强插件，使用独立 provider ID `antigravity-resilient`（插件 ID `antigravity-resilient-provider`）。

完整保留官方 ACP 历史回放、逐模型独立思考档位、后台工具回合保持与 `full-access` 默认放行能力，并在此之上提供：请求后 2.5 分钟空闲自动压缩与轮前自动压缩、OAuth 刷新空档 / 流中断 / 进程退出的有限次恢复（已执行工具不重跑）、真实退出码与脱敏 `stderr` 诊断、旧版 `stream-json` 会话及带思考档位后缀模型 ID 兼容，以及纯 `agy -p /usage --output-format json` 额度显示。

功能说明见 [README](README.md)，安装与运行边界见 [docs/INSTALL.md](docs/INSTALL.md)，上游基线与模块对照见 [docs/UPSTREAM.md](docs/UPSTREAM.md)，许可证说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

需要 Paseo `>=0.17.3`（推荐 `0.17.4`）以及同一 daemon 用户已安装并登录的 `agy >=1.5.15`（Windows 下若 daemon `PATH` 未包含 `agy`，会自动回退 `%LOCALAPPDATA%\agy\bin\agy.exe`）。额度仅通过本机 `agy` CLI 查询，不读取系统凭据库；设置 `DISABLE_COMPACT=1` 可关闭空闲与轮前自动压缩。

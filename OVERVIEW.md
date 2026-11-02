# Antigravity Resilient

Paseo 官方 Antigravity provider 的修改版，使用独立 ID `antigravity-resilient`。
在原生 CLI 会话续接和流式工具进度之上，增加持久化聊天时间线回放、暂时性
CLI 故障的有限恢复、压缩状态管理、上下文估计和订阅额度显示，并补齐最终
文本和部分本机 reasoning 记录。

图片临时文件、最低 CLI 版本检查、进程树清理和 full-access 模式均为官方
已有能力。功能差异见 [README](README.md)，安装与运行边界见 [docs/INSTALL.md](docs/INSTALL.md)，
许可证来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

需要 Paseo >=0.11.2，以及 daemon 用户已安装、登录且可在 PATH 找到的
agy >=1.1.15。仅提供 full-access，CLI 将使用 --dangerously-skip-permissions。
提示与工具结果经 agy 发往 Antigravity。回放保存在主机本地；额度查询读取
系统凭据并调用 Google 接口，不负责刷新凭据。DISABLE_COMPACT=1 可禁用
空闲自动压缩；上下文窗口是可覆盖的估计值。

macOS/Linux 尚未完成端到端验证；Linux 额度发现不支持。

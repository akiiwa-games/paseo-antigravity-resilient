# Antigravity Resilient

Paseo 官方 Antigravity provider 的修改版，使用独立 ID `antigravity-resilient`。
在原生 CLI 会话续接和流式工具进度之上，增加持久化聊天时间线回放、暂时性
CLI 故障的有限恢复、压缩状态管理、上下文估计和订阅额度显示。本次还适配
官方已有的生命周期修复，并补齐最终文本和部分本机 reasoning 记录。

图片临时文件、最低 CLI 版本检查、进程树清理和 full-access 模式均为官方
已有能力。准确的增量归属、验证状态和许可证来源见 [README](README.md)。

需要 Paseo >=0.11.2，以及 daemon 用户已安装、登录且可在 PATH 找到的
agy >=1.1.15。仅提供 full-access，CLI 将使用 --dangerously-skip-permissions。
提示与工具结果经 agy 发往 Antigravity。回放保存在主机本地；额度查询读取
系统凭据并调用 Google 接口，不负责刷新凭据。DISABLE_COMPACT=1 可禁用
空闲自动压缩；上下文窗口是可覆盖的估计值。

当前版本为 0.2.0，提供 Git tag v0.2.0。两台 Windows 主机已通过真实流式输出、
续接、回放和取消验收；79 项测试及干净打包安装通过。macOS/Linux 尚未完成
端到端验证；Linux 额度发现不支持。

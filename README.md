# Antigravity Resilient for Paseo

相对于 [Paseo 官方 Antigravity 插件](https://github.com/getpaseo/paseo/tree/da8d58bfee5279369c1a733cf5cf4ddc3bd56bb8/plugins/antigravity-provider)，本插件的差异如下：

| 功能 | 官方插件 | 本插件 |
| --- | --- | --- |
| Provider 标识 | `antigravity` | `antigravity-resilient`，可与官方插件并存 |
| 重启后的时间线 | 保存 CLI 会话 ID 供原生续接，不提供 provider 时间线回放 | 通过快照、追加日志和备份恢复用户消息、助手回复、工具及压缩记录；未收尾的旧工具显示为取消 |
| 错误恢复 | 上报 CLI 运行错误 | 对 OAuth 刷新间隙和暂时性传输失败进行有限重试；精确区分认证错误；依据明确完成信号识别 CLI 保留的已恢复传输错误，部分回复仍按失败处理 |
| 模型发现 | 调用 `agy models` 获取模型列表 | 容忍列表中的提示文本；根据 CLI 文件变化使缓存失效；暂时失败最多重试一次，并可回退到有效缓存；未知模型重新探测 |
| 启动与进程切换 | 默认启动等待 30 秒，提供进程树清理和基础生命周期管理 | 默认启动及模型发现等待 90 秒，启动等待可配置；隔离已退出进程的回调，等待关闭完成后再切换进程 |
| 最终回复 | 按 CLI 事件映射助手文本 | 结合累计 `result.response` 补齐缺失尾部，避免重复已输出的中间消息 |
| 思考内容 | 没有独立的原生 transcript 补读 | 从 CLI 新追加的本机 transcript 中补充 stdout 未提供的思考内容；通常随一次模型请求结束出现，非逐 token 输出 |
| 上下文与压缩 | 上报请求 token 用量，沿用 CLI 原生压缩行为 | 增加上下文窗口估计；统一持久化原生、手动及空闲自动压缩状态；提供压缩失败与快速回填熔断，可禁用空闲自动压缩 |
| 订阅额度 | 此 provider 不提供额度查询 | 读取 Windows Credential Manager 或 macOS Keychain 中的凭据，查询并显示 Google 订阅额度；不刷新凭据，Linux 凭据发现暂不支持 |
| 提示输入 | 文本、图片和首次 system prompt | 额外支持命令及非图片附件；为真实非命令提示附加一次“大文件先汇总、完整资料落盘”的处理指引 |

# Antigravity Resilient for Paseo

这是 Paseo 官方 Antigravity provider 的修改版，注册独立的 `antigravity-resilient` provider，可与内置 `antigravity` 并存。主要增量是：**重启后回放聊天时间线、有限重试与错误分类修正、持久化压缩状态、上下文与订阅额度显示**。本次还修复了工具状态收尾、最终文本补齐和旧传输错误的完成判定。

对比基线是 [getpaseo/paseo 的 `plugins/antigravity-provider`](https://github.com/getpaseo/paseo/tree/da8d58bfee5279369c1a733cf5cf4ddc3bd56bb8/plugins/antigravity-provider)，固定提交 `da8d58bfee5279369c1a733cf5cf4ddc3bd56bb8`，核对日期为 2026-11-02。该目录最近变更于 2026-10-05；本机安装的内置源码与该基线一致。下面的“原有增量”指本仓库首个提交中已经存在的功能，不表示确定了最初分叉日期。

## 相对官方的差异

| 能力 | 官方基线已有 | 本 fork 原有增量 | 本次修复或吸收 |
| --- | --- | --- | --- |
| 运行 agy、流式文本、工具进度、配置和中断 | 已有；full-access 和原生 conversation ID 续接也已有 | 独立 provider ID，方便与内置版本并存 | 保留原有能力 |
| 重启后的聊天记录 | 保存 conversation ID 供 CLI 续接；不提供 provider 时间线回放 | 快照、追加日志、备份恢复；在 ready 前回放用户、助手、工具和压缩记录；可回读本机原生日志 | 将旧记录里未收尾的工具显示为取消，不重跑工具、不改原快照 |
| 暂时性失败 | 有基础错误上报 | OAuth 401 刷新间隙、流中断分别有限重试；避免把 author 等误判成登录失败 | 历史 SSE 错误只有在明确响应完成或压缩 checkpoint 完成后才可忽略；部分文本不算完成，后续新错误仍失败 |
| 模型发现 | 调用 agy models | 容忍非表格提示；CLI 文件变化使缓存失效；暂时失败有限重试；未知模型重新探测 | 认证和发现的单次等待上限调整为 90 秒；识别 CLI 自身的模型列表超时，最多重试一次；CLI 启动默认也为 90 秒，可配置 |
| 上下文和压缩 | 上报请求 token 用量 | 增加上下文估计、原生/手动/空闲压缩的统一持久状态、失败与快速回填熔断；可禁用空闲自动压缩 | 保留 fork 状态模型 |
| 订阅额度 | 此 provider 未提供 | 读取系统凭据，查询 Google 额度接口；不刷新凭据 | 保留；Linux 凭据发现尚不支持 |
| 提示输入 | 文本、图片和首次 system prompt | 保留命令及非图片附件处理；下一条真实非命令提示附加一次大文件先汇总、完整资料落盘的指引 | **吸收官方**图片临时文件机制；不将其列为原创功能 |
| 进程生命周期 | 启动超时、stdin 错误、子进程树清理、会话身份校验、空闲运行失败、工具终态与拒绝动作去重 | 保留 fork 的恢复流程 | **吸收和适配官方**这些机制，增加退役进程回调隔离与关闭等待 |
| 最终文本与 reasoning | 映射助手、工具及 subagent 事件；无独立 reasoning 补读 | 能处理 CLI 已提供的 reasoning 事件 | result 补齐缺失文本尾部，避免重复中间消息；从新写入的本机 transcript 补充 stdout 未提供的 reasoning |
| 版本检查与安装 | 已要求 agy >=1.1.15 | 独立插件安装 | **吸收官方**最低版本检查；开发工具改用锁定的 npm 依赖，增加干净安装/打包检查 |

对应实现主要位于 `server/internal/store.ts`、`session.ts`、`compaction.ts`、`catalog.ts`、`native-reasoning.ts`、`server/usage.ts` 和 `credentials.ts`。逐项来源及后续合并规则见 [上游维护说明](docs/UPSTREAM.md)。这些改动不能保证修复持续的网络、认证或 CLI 故障；有限恢复也不构成工具操作的事务或严格去重保证。

## 当前验证范围

- 当前版本为 **0.2.0**，提供 Git tag `v0.2.0`；没有 npm registry 发布。
- Windows 下 **79 项测试**、干净安装、实际打包、离线包安装和真实 SDK 入口链接通过。协议回归包含实际子进程管道；模型发现超时用真实进程验证重试次数与持续失败，未把失败当作成功。源码检查使用了本地 SDK 类型声明，不能单独证明运行协议兼容。
- 已在两台 Windows 主机的真实 Paseo / agy 上验证流式输出、思考记录、工具收尾、续接、回放及取消子进程。第二台以公开源码运行：2 次真实命令、33 次最终文本更新、2 条思考记录；续接和回放通过，取消后实际 Python 子进程退出。开发检查使用 Node 24.12，第二台验证使用 Node 26.4，CLI 为 agy 1.4.12。
- 验收中出现的 Google 鉴权 EOF 也在原生 CLI 中复现，修复目标主机的代理路由后恢复。持续网络或登录故障仍会报错，插件的有限重试不能替代网络修复。回归 fixture 的时间、时长、用量与额度样本均为合成值，不是生产遥测。
- macOS、Linux 及 Node 22.15 的最低版本组合未完成端到端验证。reasoning 补充依赖 CLI 写本机日志，通常在一次模型请求末尾出现，不是逐 token 流式推理。缺失该日志不会阻止 stdout 协议运行。

## 安装

在目标 daemon 主机安装并登录 `agy >=1.1.15`，保证 daemon 用户的 `PATH` 能找到它；Paseo 需 **>=0.11.2** 且启用插件。开发检查需 Node **>=22.15**、npm。每台主机分别登录并保留自己的历史。

从已取得的本仓库 checkout 安装：

```sh
npm ci --ignore-scripts
npm run typecheck
paseo plugin install .
paseo plugin ls
paseo plugin logs antigravity-resilient-provider
```

插件状态应为 `running`。新建 agent 选择 `antigravity-resilient`、`full-access`；此模式会传入 `--dangerously-skip-permissions`。插件是受信任本机代码，可访问 daemon 主机。Git 安装可固定到 `--ref v0.2.0`。更新、Git 安装和验证步骤见 [安装与验证](docs/INSTALL.md)。

## 数据与行为

提示和工具结果经本机 `agy` 发给 Antigravity 服务。回放数据默认写入 `$PASEO_HOME/antigravity-resilient/conversations`，未设置时使用 `~/.paseo`；可用 `providerOptions.storeDir` 覆盖。自定义 home 尚无记录时可能继续使用旧的 `~/.paseo` store；还可读取同一用户 `~/.gemini/antigravity-cli/brain` 下的原生记录。迁移源码不会迁移登录或历史。持久化会过滤已知凭据字段及 token 格式，但不能保证任意自由文本都已脱敏。

额度显示会读取 Windows Credential Manager 或 macOS Keychain 的 Antigravity 凭据，并请求 Google `cloudcode-pa.googleapis.com`。凭据过期需重新打开 `agy` 登录。上下文窗口大小是估计值，可用 `providerOptions.contextWindowMaxTokens` 覆盖；daemon/provider 环境设置 `DISABLE_COMPACT=1` 可禁用空闲自动压缩。大文件汇总指引不会自动截断用户资料。

## 来源与许可证

上游源自 [getpaseo/paseo](https://github.com/getpaseo/paseo)，其 Apache-2.0 全文和版权声明保留在 [LICENSE.paseo](LICENSE.paseo)。本仓库对上游 provider 做了上述修改；本地修改的仓库级许可证仍待所有者决定，**公开仓库本身不代表已授予新的开源许可**。详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

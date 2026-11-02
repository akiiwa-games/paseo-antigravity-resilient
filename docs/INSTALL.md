# 安装与验证

功能差异见 [README](../README.md)。以下 Git 安装示例固定使用 `v0.2.1`。

## 安装条件

- 目标 daemon 主机上 Paseo >=0.11.2，启用插件。
- 同一 daemon 用户已安装并登录 agy >=1.1.15，其 PATH 能找到 agy。
- 源码开发/检查使用 Node >=22.15 和 npm；Git 安装需要 Git 及仓库读取权限。
- 插件运行时仅导入 Node 内置模块和 Paseo 提供的 SDK，无 npm 运行依赖。
  manifest 无 build 命令，无需复制本机应用内的 TypeScript 或 SDK。

## 从目录安装及更新

在本仓库 checkout 执行：

```sh
npm ci --ignore-scripts
npm run typecheck
paseo plugin install .
paseo plugin ls
paseo plugin logs antigravity-resilient-provider
```

要求状态为 running，创建 agent 时选择 antigravity-resilient 和 full-access。
后者传入 --dangerously-skip-permissions，驱动中的 CLI 无法交互询问权限。

拉取已审阅的更新后：

```sh
npm ci --ignore-scripts
npm run typecheck
paseo plugin reload antigravity-resilient-provider
paseo plugin ls
```

通常无需为源码更新重启 daemon；reload 会影响使用该插件的会话，应先安排好
正在运行的工作。每台目标主机需分别安装、登录并确认实际插件来源目录。

## 从 Git 安装

从已验收的 Git tag 安装：

```sh
paseo plugin install github:akiiwa-games/paseo-antigravity-resilient --ref v0.2.1
```

托管的 Git 安装使用 `paseo plugin update antigravity-resilient-provider` 更新。
本地目录安装和托管 Git 安装的更新方式不同。npm 包标记为 private；支持本地
pack 不表示已有 npm registry 发布。

## 不调用模型的检查

```sh
npm test
npm run verify:install
```

verify:install 将源文件快照保存在 checkout 之外，执行干净 npm ci、类型检查、
实际 npm pack、离线消费者安装及真实 Paseo SDK 入口链接。可在命令末尾传入
新的绝对证据目录；打印路径保存完整日志、快照、包文件和 summary.json。
它不安装/reload daemon 插件，不读凭据，不启动 agy。

源码类型检查包含本地 SDK 声明，单测使用独立 SDK shim；两者均不能替代真实
daemon 协议和模型行为验收。Node 最低版本和跨操作系统支持也需分别验收。

## 可选 live 检查

此检查消耗模型额度并实际执行 fixture 内的命令，需 daemon PATH 有 Python：

```sh
node scripts/verify-live.mjs --model <available-model-id> --output <new-evidence-directory>
```

检查进度、流式最终文本、reasoning、续接、回放和中断；完整事件保存在输出
目录，测试 agent 由脚本清理。默认 fixture 路径在多次运行间固定；使用
`--fixture <existing-test-directory> --workspace <existing-workspace-id>` 显式复用
已有测试 workspace。`--output` 仅改变证据目录。仅准备好 reload 时加 --reload。
不要将某次探测成功视为所有主机和现有会话均通过验收。

## 可选部署工具

scripts 下的部署工具独立于插件运行时。使用前需 npm ci，并提供自己的
目标连接和路径配置。远端部署工具读取 AGENTCOMPASS_REMOTE_ENDPOINT（已有
connection-offer 文件路径）、AGENTCOMPASS_REMOTE_ROOT 和可选的
AGENTCOMPASS_REMOTE_PASEO_HOME；兼容旧 ROUTE_MANAGER_REMOTE_* 名称。这些
变量名不构成 AgentCompass 运行依赖，也不包含连接凭据。

当前同步脚本要求远端分支 main，执行前必须核实远端分支与工作区状态。
连接文件、登录、真实日志与验收证据应保存在私有外部目录。

## 数据存放与许可证

- 提示和工具结果通过本机 `agy` 发送给 Antigravity 服务。
- 聊天回放数据保存在 `$PASEO_HOME/antigravity-resilient/conversations`（未设置
  `PASEO_HOME` 时为 `~/.paseo`），可用 `providerOptions.storeDir` 修改。写入前会
  过滤已知的凭据字段，但不能保证自由文本里的敏感信息都被去掉。
- 额度查询会请求 `cloudcode-pa.googleapis.com`。

上游代码来自 [getpaseo/paseo](https://github.com/getpaseo/paseo)，采用 Apache-2.0，
原文见 [LICENSE.paseo](../LICENSE.paseo)。本仓库修改部分的许可证尚未确定，
公开仓库本身不代表授予新的开源许可。详见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

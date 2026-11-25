# 安装与验证

功能说明见 [README](../README.md)，上游基线与模块对照见 [UPSTREAM.md](UPSTREAM.md)。当前版本为 `0.3.0`。

## 安装条件

- 目标主机运行 Paseo `>=0.17.3`（推荐 `0.17.4`），并已启用插件支持。
- 同一 daemon 用户已安装并登录 `agy >=1.5.15`（`1.5.14` 起支持逐模型独立 `thought_level` 与 SSH 登录隔离，`1.5.15` 起保证 `session/load` 在返回前完成完整历史回放）。
  - 在 Windows 上，若 daemon 进程的 `PATH` 未包含 `agy`，插件会自动回退到 `%LOCALAPPDATA%\agy\bin\agy.exe`，无需额外修改 `~/.paseo/config.json` 的 `env.PATH`。
- 源码开发与本地检查需要 Node `>=22.15.0` 和 `npm`。
- 插件运行时仅导入 Node 内置模块及 Paseo 宿主提供的 `@getpaseo/plugin` / `zod`，无 npm 运行时依赖，无需构建产物目录。

## 从目录安装及更新

在本仓库 checkout 执行：

```sh
npm ci --ignore-scripts
npm run check
paseo plugin install .
paseo plugin ls
paseo plugin logs antigravity-resilient-provider
```

确认状态为 `running`。新建 agent 时选择 `antigravity-resilient`，默认模式为 `full-access`（自动批准工具权限请求，也可按需切换 `default` / `accept-edits` / `plan`）。

拉取更新后重载插件：

```sh
npm ci --ignore-scripts
npm run check
paseo plugin reload antigravity-resilient-provider
paseo plugin ls
```

重载插件会重启当前正在运行的所有 `antigravity-resilient` 会话进程（重开时通过 `agy acp` `session/load` 自动恢复会话历史），请在活跃任务空闲时执行，且不要从正在使用 `antigravity-resilient` 的会话内部直接触发自身插件 reload。

## 从 Git 安装

从已验收的 Git tag 安装：

```sh
paseo plugin install github:akiiwa-games/paseo-antigravity-resilient --ref v0.3.0
```

托管 Git 安装使用 `paseo plugin update antigravity-resilient-provider` 更新。`package.json` 标记为 `private: true`，支持本地 `npm pack` 验收，不发布到公共 npm registry。

## 本地离线检查（不消耗模型额度）

```sh
npm run check
npm run verify:install -- E:/path/to/new-install-evidence
```

- `npm run check` 执行 TypeScript 严格类型检查（针对真实 `@getpaseo/plugin@0.17.4` 类型定义）与全部 `node --test` 单元及 ACP 协议测试。
- `npm run verify:install` 将源码复制到独立目录，依次验证干净 `npm ci --ignore-scripts`、`npm run typecheck`、`npm pack`、离线消费者安装以及真实 Paseo SDK 入口链接，不访问 daemon、凭据或本机 `agy`。

## 可选 Live 验收（消耗少量模型额度）

针对已运行新版本插件的本地 Paseo daemon 执行端到端验证：

```sh
node scripts/verify-live.mjs --model gemini-3.8-flash --output E:/path/to/new-live-evidence
```

验证流式回复、思考分块、规范化工具调用（`shell` / `write` / `edit` / `read`）、多轮续接、`refreshAgent` 历史回放以及取消回合时的子进程树回收。测试结束后自动归档并删除临时测试 agent，保留 `--output` 下的完整证据日志。

## 数据存放与许可证

- 会话历史由本机 `agy` 原生保存在 `~/.gemini/antigravity-cli/conversations/`（或 `ANTIGRAVITY_HOME`）。
- 旧版 `stream-json` 分支遗留的 `~/.paseo/antigravity-resilient/conversations/` 数据原样保留不作修改或删除；重开旧会话时仅只读查询其中的 `session-keys/` 映射文件。
- 额度查询仅执行本机 `agy -p /usage --output-format json`，插件自身不读取系统凭据库，也不直接请求外部 HTTP 配额接口。默认仅在 `antigravity-resilient` 会话内发现额度账号以避免与内置 `antigravity` 插件在全局额度视图重复渲染；若已禁用内置插件，可通过环境变量 `PASEO_ANTIGRAVITY_RESILIENT_GLOBAL_USAGE=1` 开启全局额度卡片。

上游代码来自 [getpaseo/paseo](https://github.com/getpaseo/paseo)，采用 Apache-2.0，全文见 [LICENSE.paseo](../LICENSE.paseo)。许可证与第三方说明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

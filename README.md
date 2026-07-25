# Codex Feishu NSX

`codex-feishu-nsx` 是一个只支持飞书（Feishu/Lark）的 Codex 本地会话桥接 skill。
它把本机 Codex 会话连接到飞书机器人，使用户可以通过手机发送任务、查看工具进度、接收文本和文件结果，并在本地工作区内继续使用 Codex 的代码能力。

## 功能

- 飞书 WebSocket 长连接接收消息，支持私聊和可选的群聊 @ 机器人。
- 支持文本、图片、文件、音频和视频输入；支持生成图片和文件回传。
- Feishu CardKit 流式卡片、工具调用进度、Typing 反应和 Markdown 渲染。
- `code`、`plan`、`ask` 三种模式，以及 `/new`、`/bind`、`/cwd`、`/mode`、`/status`、`/retry`、`/stop`、`/perm` 等命令。
- 入站消息、Codex 结果、附件和失败投递使用本地持久化数据保存，进程重启后可以恢复未完成的投递。
- 文本分片、Feishu UUID 幂等、单实例锁、指数退避、速率限制和重复消息去重。
- 权限卡支持 Allow、Allow Session、Deny；原生 Codex 审批在桥接进程重启后不会自动恢复，会提示重新执行任务。
- Windows 后台进程管理，以及 macOS LaunchAgent 和 Linux systemd 用户服务脚本。
- doctor 诊断、日志脱敏与轮转、WebSocket 健康状态、数据容量检查和统一 release 构建流程。

## 目录

- `codex-feishu-nsx/`：完整、可独立安装的 Codex skill。
- `codex-feishu-nsx/src/core/`：内置的飞书适配、消息投递、权限、恢复和安全模块；它不是另一个 skill。

## 使用方式

### 环境要求

- Node.js 20 或更高版本。
- 已完成本地 Codex 登录，或准备使用 Codex API 配置。
- 已创建飞书应用，并开启机器人消息、资源、卡片和长连接相关权限。

### 安装依赖与构建

```powershell
cd codex-feishu-nsx
npm install
npm run release
```

`npm run release` 会依次执行统一类型检查、全部单元测试和 daemon bundle 构建。项目不依赖仓库外的本地 `file:` 包，因此该目录可以单独复制或安装。

### 配置

复制 `codex-feishu-nsx/config.env.example` 到用户数据目录：

- Windows：`%USERPROFILE%\.codex-feishu-nsx\config.env`
- macOS/Linux：`~/.codex-feishu-nsx/config.env`

至少填写：

```env
CFN_DEFAULT_WORKDIR=/absolute/path/to/workspace
CFN_DEFAULT_MODE=code
CFN_FEISHU_APP_ID=your-app-id
CFN_FEISHU_APP_SECRET=your-app-secret
CFN_FEISHU_DOMAIN=https://open.feishu.cn
```

不要把真实 `config.env`、日志、会话数据或飞书凭据提交到 Git 仓库。

### 启动与诊断

Windows：

```powershell
powershell -File codex-feishu-nsx\scripts\daemon.ps1 start
powershell -File codex-feishu-nsx\scripts\daemon.ps1 status
powershell -File codex-feishu-nsx\scripts\doctor.ps1
```

macOS/Linux：

```bash
sh codex-feishu-nsx/scripts/daemon.sh start
sh codex-feishu-nsx/scripts/daemon.sh status
node codex-feishu-nsx/scripts/doctor.mjs
```

需要后台服务时，可使用 `install-service` 安装当前用户的 LaunchAgent 或 systemd 用户服务。Linux 服务默认在用户登录后启动；开机即启动需要系统启用 user lingering。

## 安全边界

- 凭据只放在用户数据目录的 `config.env` 中，日志会脱敏。
- 默认 Codex `code` 模式使用 `workspace-write`，`plan` 和 `ask` 使用只读沙箱。
- 工作目录必须是绝对路径，并会拒绝明显的路径穿越和危险命令输入。
- 飞书允许用户可以通过 `CFN_FEISHU_ALLOWED_USERS` 限制。
- Codex 原生审批请求不能通过飞书跨进程暂停并恢复；桥接进程重启后需重新发送任务。

## 测试

当前版本已验证：77 项测试、统一 TypeScript 类型检查和 release 构建全部通过。Windows + Feishu WebSocket 已做线上运行检查；macOS/Linux 服务脚本仍建议在对应主机上做一次安装验证。

## 源码致谢

本项目基于 [op7418/Claude-to-IM-skill](https://github.com/op7418/Claude-to-IM-skill) 的源码和设计进行裁剪与重构，形成只支持 Codex 和飞书的独立版本。感谢原作者 [op7418](https://github.com/op7418) 及上游社区贡献者提供的 IM bridge、会话路由、消息适配、Markdown 渲染和权限交互等基础实现。

根据上游项目说明，`Claude-to-IM-skill` 的 IM bridge 模块来源于 [op7418/CodePilot](https://github.com/op7418/CodePilot)。本项目保留上游 MIT License 和 `Copyright (c) 2024-2025 op7418` 版权声明；本仓库后续针对 Codex、飞书、文件传输、任务恢复和跨平台运行所做的改造不改变上游代码的署名与许可要求。

运行时依赖和相关工作还包括：

- OpenAI Codex SDK：本地 Codex 会话与流式事件。
- Feishu/Lark 官方 Node SDK：WebSocket 事件、消息、卡片和资源 API。
- `markdown-it`：Markdown 解析支持。
- Node.js 官方测试运行器和 TypeScript 工具链。

第三方依赖的许可证和版权信息以各自包内的 LICENSE 文件为准；skill 目录中的 MIT License 应与源码一并保留。

## 许可证

MIT License，详见 `codex-feishu-nsx/LICENSE`。

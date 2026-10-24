# dsh-connections

通过 SSH 在另一台电脑上持续运行 DeepSeek Harness，并在本地应用内使用远端的原生项目、会话和文件树。

- 从已有 SSH 配置选择主机，或手动添加；保存连接并在启动时自动重连。
- 首次连接安装独立的远端 Harness 服务；关闭本地应用不停止远端服务。
- 本机和远端项目统一放在 Workspaces；点击会话在同一窗口切换，复用原生聊天和文件侧栏。
- 手动指定版本更新远端；保留连接已有 Harness 服务的方式。

## 安装

本地需要 Harness `0.2.1-rc.2`、Node.js ≥22.12 和支持 ControlMaster 的 OpenSSH。后台托管目前要求远端 Linux、Node.js 22.19+ 或 ≥24、npm、systemd 用户服务和 linger。当前实机验证平台为 Linux。

```sh
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add /absolute/path/to/dsh-connections
```

重启本地 Harness，在 **设置 → 连接** 添加 SSH 主机，选择 **在后台持续运行**，然后连接。SSH 沿用本地 Harness 主机的配置、密钥代理和 `known_hosts`；先在终端确认 `ssh <主机>` 可用。

在运行本地 Harness 的同一台电脑上，通过 HTTP 浏览器打开远端工作区。模型账号在远端 Harness 中配置，不从本机复制。托管模式自动安装远端内容插件；已有服务需安装随包提供的远端插件包，见使用文档。

[使用与边界](docs/usage.md) · [依赖与设计](docs/design.md) · [后续路线](docs/roadmap.md) · [开发与验证](docs/development.md)

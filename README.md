# dsh-connections

通过 SSH 在另一台电脑上持续运行 DeepSeek Harness，并在本地应用内使用远端的原生项目、会话和文件树。

- 从已有 SSH 配置选择主机，或手动添加；保存连接并在启动时自动重连。
- 首次连接安装独立的远端 Harness 服务；关闭本地应用不停止远端服务。
- 本机和远端项目统一放在 Workspaces；点击会话在同一窗口切换，顶部 New Session 按钮与快捷键跟随当前主机。
- 复用原生聊天、文件和侧栏外壳；打开远端时保留加载反馈，直到原生目录选择器出现或会话切换完成。
- 设置页可选择本地或远端，分别管理模型、API 凭据和插件。
- 手动指定已验证版本更新远端；保留连接已有 Harness 服务的方式。

## 安装

本地需要 Harness `0.2.1-rc.3`、Node.js ≥22.12 和支持 ControlMaster 的 OpenSSH。后台托管目前要求远端 Linux、Node.js 22.19+ 或 ≥24、npm、systemd 用户服务和 linger。当前实机验证平台为 Linux。仍使用本地 rc.2 的用户请安装 `@xunz03/dsh-connections@0.1.0`。

```sh
dsh plugin --profile web add @xunz03/dsh-connections
```

重启本地 Harness，在 **设置 → 连接** 添加 SSH 主机，选择 **在后台持续运行**，然后连接。SSH 沿用本地 Harness 主机的配置、密钥代理和 `known_hosts`；先在终端确认 `ssh <主机>` 可用。

在运行本地 Harness 的同一台电脑上，通过 HTTP 浏览器打开远端工作区。在设置页选择本地或某个远端，管理该电脑的模型账号；API 凭据与插件均不自动共享，详见[设置与插件归属](docs/host-settings.md)。托管模式自动安装远端内容插件；已有服务需安装随包提供的远端插件包，见使用文档。

远端内容加载阶段超过 30 秒未就绪时，可重试或取消返回本机。原生桌面应用的远端工作区入口暂未开放。插件通过公开组合接口复用 Harness 原生侧栏；停用整个 Connections 插件包会撤销其补丁并恢复原生侧栏。

[使用与边界](docs/usage.md) · [依赖与设计](docs/design.md) · [后续路线](docs/roadmap.md) · [开发与验证](docs/development.md) · [评审核验与取舍](docs/review-findings.md) · [发布流程](docs/releasing.md)

# dsh-connections

通过 SSH 在另一台电脑上持续运行 DeepSeek Harness，并在本地应用内使用远端的原生项目、会话和文件树。

- 从已有 SSH 配置多选添加主机，或手动连接已有服务；开关启用后立即连接，并随启动恢复。
- 保存前可单独测试 SSH；连接时显示当前准备、隧道和验证阶段。
- 首次连接安装独立的远端 Harness 服务；关闭本地应用不停止远端服务。
- 本机和远端项目统一放在 Workspaces；列表内 New Session 和快捷键跟随当前主机，原生顶部 New Session 保留本机语义并返回本机。
- 保留独立部署的原生侧栏，插件加载失败或停用不会移除本机导航；聊天与文件继续使用远端原生内容。
- 设置页可选择本地或远端，分别管理模型、API 凭据和插件。
- 提供可选 `connections` Agent 工具，与 UI 共用 Host 业务操作；连接变更和远端写入经原生审批，凭据录入与损坏记录清理仍由用户操作。
- 更新默认采用最新兼容版本，无需手填版本号；保留连接已有 Harness 服务的方式。

## 安装

本地需要 Harness `0.2.1-rc.5`、Node.js ≥22.12 和系统 OpenSSH。Linux 使用 ControlMaster；Windows 使用原生 SSH 标准输入输出转发。Windows Desktop 曾做过隔离验证，本轮修复的验收范围见[开发文档](docs/development.md)。后台托管要求远端 Linux、Node.js 22.19+ 或 ≥24、npm、systemd 用户服务和 linger。远端工作区与设置可在原生 Desktop 或本机 HTTP 浏览器中使用。仍使用本地 rc.3 的用户请安装 `@xunz03/dsh-connections@0.1.7`；本地 rc.2 用户请安装 `@xunz03/dsh-connections@0.1.0`。

```sh
dsh plugin --profile web add @xunz03/dsh-connections
```

启用插件后，在 **设置 → 连接** 添加 SSH 主机；默认使用托管模式，保存后立即连接。SSH 沿用本地 Harness 主机的配置、密钥代理和 `known_hosts`；先在终端确认 `ssh <主机>` 可用。

在运行本地 Harness 的同一台电脑上，通过原生 Desktop 或 HTTP 浏览器打开远端工作区。在设置页选择本地或某个远端，管理该电脑的模型账号；API 凭据与插件均不自动共享，详见[设置与插件归属](docs/host-settings.md)。托管模式自动安装远端内容插件；已有服务需安装随包提供的远端插件包，见使用文档。

0.1.8 适配 Harness rc.5，远端保留 rc.2/rc.3 并新增 rc.5。详见[兼容性说明](docs/harness-compatibility.md)。

0.1.7 捕获 Windows SSH 子进程启动异常，避免因此终止 Host；同时改善通道隔离、连接清理、归档确认和轮询稳定性。详见[版本说明](docs/releasing.md#017)。

远端内容加载阶段超过 30 秒未就绪时，可重试或取消返回本机。本次评审后源码不再禁用或内联原生侧栏，停用单个 Connections entry 或整个 bundle 均保留本机导航；目录与设置头遇到优先级竞争时主动让出。浏览器产物不再 runtime import Harness Client 控件或 store，Account 不再复制整套工厂；仍保留经版本校验的 Settings 构造和私有 shortcut 边界。内容契约不匹配只禁用远端内容，不关闭健康 SSH 或本机设置。详见[本轮修复与剩余边界](<docs/review-followup.md>)。

0.1.6 已保留原生快捷键服务，修复首次启用时替换服务引发的白屏。从正在运行的 0.1.5 升级，或从旧的侧栏替换补丁迁移时，原生部署恢复仍可能需要一次界面重载；请先保存草稿，插件不会自动重载。详见[兼容性说明](<docs/harness-compatibility.md#updating-an-open-rc3-desktop>)。

[使用与边界](docs/usage.md) · [依赖与设计](docs/design.md) · [参考插件对比](docs/reference-comparison.md) · [后续路线](docs/roadmap.md) · [开发与验证](docs/development.md) · [评审核验与取舍](docs/review-findings.md) · [性能与剩余成本](docs/performance.md) · [发布流程](docs/releasing.md)

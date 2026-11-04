# dsh-connections

通过 SSH 在远端电脑上持续运行 DeepSeek Harness，在本地应用中使用它的项目、会话和文件。

- 在同一 Workspaces 列表切换本机和远端项目，聊天与文件使用各自主机的原生界面。
- 从 SSH 配置批量添加主机，保存前可测试连接；启用的连接随应用启动恢复。
- 托管模式自动安装独立的远端服务，关闭本地应用后远端仍可继续运行；也可连接已有服务。
- 在设置中选择主机，分别管理模型、账号和插件。

## 安装

本地需要 **Harness `0.2.1-rc.5`、Node.js ≥22.12 和系统 OpenSSH**。

```sh
dsh plugin --profile web add @xunz03/dsh-connections
```

1. 在运行本地 Harness 的电脑上，先确认 `ssh <主机>` 可以通过密钥或 SSH agent 连接。
2. 启用插件，打开 **设置 → 连接**，选择 SSH 主机或手动添加，保存后立即连接。
3. 在 **Workspaces → Add workspace** 选择远端电脑，打开项目或会话。

默认托管模式要求远端 **Linux、Node.js 22.19+ 或 ≥24、npm、systemd 用户服务及 linger**。已有服务的接入方法见[使用指南](docs/usage.md#connect-an-existing-service)。

## 使用边界

- 远端内容需通过本机原生 Desktop，或同机的 HTTP `localhost` / `127.0.0.1` 浏览器访问；暂不提供手机、公网入口或设备配对。
- 列表内 **New Session** 和对应快捷键跟随所选主机；原生顶部 **New Session** 返回本机。
- 会话、文件、模型凭据和插件归各自主机所有，不自动同步。断开连接不停止远端服务。
- 远端支持 Harness rc.2、rc.3、rc.5；升级远端 Harness 需显式操作。旧版本迁移及平台验证范围见[兼容性](docs/harness-compatibility.md)。

## 文档

- [使用指南与排障](docs/usage.md)
- [设置、模型与插件归属](docs/host-settings.md)
- [架构设计](docs/design.md) · [统一工作区](docs/unified-workspaces.md)
- [开发与验证](docs/development.md) · [性能与测量边界](docs/performance.md)
- [已知限制与路线](docs/roadmap.md)
- [版本记录](docs/changelog.md) · [发布流程](docs/releasing.md)

## 许可证

[MIT](LICENSE)。上游适配代码与许可说明见 [NOTICE](NOTICE)。

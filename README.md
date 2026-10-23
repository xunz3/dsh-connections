# dsh-connections

通过 SSH 连接另一台电脑上的 DeepSeek Harness，在原生界面中使用远端会话、文件、终端和插件。

首版支持保存连接、连接 / 断开 / 重连、打开远端 Harness。远端需已运行 `dsh web`；断开只关闭隧道。

## 安装

需要 Harness `0.2.1-rc.2`、Node.js ≥22.12，以及支持 ControlMaster 的系统 OpenSSH。当前验证平台为 Linux；macOS 使用同一路径但尚未实机验证，Windows 暂不支持。

```sh
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile web add /absolute/path/to/dsh-connections
```

重启本地 Harness。在 **设置 → 连接** 中添加 SSH 主机和远端 `dsh web --host 127.0.0.1 --no-open` 显示的启动地址，然后连接并打开。

SSH 使用本地 Harness 主机的配置、密钥代理和 `known_hosts`。先在终端确认 `ssh <主机>` 可用。打开连接的浏览器必须与本地 Harness 在同一台电脑上。

[使用与边界](docs/usage.md) · [依赖与设计分析](docs/design.md) · [后续路线](docs/roadmap.md) · [开发与验证](docs/development.md)

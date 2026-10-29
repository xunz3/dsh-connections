# SSH 远程插件对比与改进

分析日期：2026-10-29。以用户克隆到 `examples/` 的源码快照为依据，与 Connections 0.1.4 工作树比较；没有运行这三个第三方项目或验证其宣传中的性能数据。参考项目保持原样，本轮仅借鉴设计思路，没有复制其实现。

## 三个项目分别解决什么问题

| 项目与快照 | 目标 | 核心实现 | 数据与执行归属 |
| --- | --- | --- | --- |
| [dsh-ssh 0.1.3](https://github.com/dsh-ssh/dsh-ssh/tree/17764146e474b44222d12a95c585b5de782f9daa) | 远端仅装 sshd，把远端目录当作本地 Harness 工作区使用 | ssh2 连接池；本地占位目录编码远端路径；`agent/created` 钩子覆盖七种原生工具；SFTP 与 exec 文件传输；远端后台任务适配本地 jobs controller | Agent、模型、skills、MCP 仍在本地；指定的 shell、文件和搜索工具在远端 |
| [dsh-remote 0.8.54](https://github.com/flymysql/dsh-remote/tree/ca22999ba851a798ddd5deb73a5175213f0bc1ce) | 本地 Agent 操作远程机器，也可部署并打开完整远端 Harness | ssh2/OpenSSH 双 backend；22 个 `rw_*` 工具；本地 mirror、同步及 cwd 绑定；另有部署探测、任务阶段、Web attach 和通用端口转发 | 工具路径由本地 Agent 管理；Web attach 路径连接独立远端 Host |
| [dsh-full-remote 0.5.0](https://github.com/JUANWANG-BUAA/dsh-full-remote/tree/0c24350d264b0f40ff851fb32b5005691a656e75) | 从手机、局域网或公网访问一台完整 Harness | HTTP/HTTPS 认证反代，转发 SSE/WebSocket；独立设备 Cookie、邀请和撤销；cloudflared 隧道；移动任务面板；连接池与静态缓存 | 同一台 Harness 保有全部会话和执行状态；插件负责外部访问认证 |
| Connections 0.1.4 | 从本地 Harness 管理并切换多台 SSH 主机的原生工作区 | 系统 OpenSSH；远端完整 Harness；托管 systemd 服务；统一原生侧栏、内容和设置；明确的安装、升级与回滚 | 会话、模型、插件、文件、审批和工具均属于各自 Host |

`dsh-ssh` 的主要入口是 [agent 钩子](https://github.com/dsh-ssh/dsh-ssh/blob/17764146e474b44222d12a95c585b5de782f9daa/packages/dsh-ssh/index.js#L194)、[cwd 路由](https://github.com/dsh-ssh/dsh-ssh/blob/17764146e474b44222d12a95c585b5de782f9daa/packages/dsh-ssh/src/router.js#L16)和 [SSH/SFTP](https://github.com/dsh-ssh/dsh-ssh/blob/17764146e474b44222d12a95c585b5de782f9daa/packages/dsh-ssh/src/ssh-core.js#L419)。它通过提示词说明本地与远端能力归属，还需要自行适配搜索及后台任务的原生结果格式。

`dsh-remote` 的 [binding](https://github.com/flymysql/dsh-remote/blob/ca22999ba851a798ddd5deb73a5175213f0bc1ce/lib/binding.js#L25) 从本地 mirror 反查目标；[同步实现](https://github.com/flymysql/dsh-remote/blob/ca22999ba851a798ddd5deb73a5175213f0bc1ce/lib/sync.js#L39) 比较大小和秒级 mtime。其 [Web 部署诊断](https://github.com/flymysql/dsh-remote/blob/ca22999ba851a798ddd5deb73a5175213f0bc1ce/lib/web-deploy.js#L391)、[任务阶段](https://github.com/flymysql/dsh-remote/blob/ca22999ba851a798ddd5deb73a5175213f0bc1ce/lib/deploy-tasks.js#L23)和 [端口转发](https://github.com/flymysql/dsh-remote/blob/ca22999ba851a798ddd5deb73a5175213f0bc1ce/lib/forwards.js#L1)是值得独立评估的功能。

`dsh-full-remote` 的 [proxy](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/0c24350d264b0f40ff851fb32b5005691a656e75/src/proxy.ts#L85) 将外部设备认证转换为 Host 内部认证，并重写相关请求头。它的 [设备会话](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/0c24350d264b0f40ff851fb32b5005691a656e75/src/sessions.ts#L64)、[一次性邀请](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/0c24350d264b0f40ff851fb32b5005691a656e75/src/invites.ts#L9)和 [cloudflared 管理](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/0c24350d264b0f40ff851fb32b5005691a656e75/src/tunnel.ts#L23)服务于公网入口，和我们的 SSH 连接管理有不同的权限边界。

## 实际差距及取舍

| 能力 | 参考项目 | Connections 原有状态 | 本轮决定 |
| --- | --- | --- | --- |
| 保存前测试连接 | dsh-ssh 独立测试；dsh-remote 有完整环境体检 | 只能先保存，再连接；托管连接可能开始安装 | 增加独立 SSH 检查，仅确认认证与远端命令执行；完整 Node/systemd/linger 体检仍待补充 |
| 可操作的错误原因 | 连接测试、部署 findings 与修复建议 | 已区分认证、主机密钥、超时；DNS/拒绝/网络不可达较笼统 | 统一 SSH 分类，增加三类原因；面向表单返回白名单代码与中英文提示 |
| 连接阶段 | dsh-remote 展示部署步骤 | manager 内部记录阶段，UI 只有连接中/更新中 | 展示准备 Host、建立隧道、验证访问三个真实阶段；暂不细分 npm 进度 |
| 轮询及 HTTP 成本 | dsh-full-remote 暂停后台轮询、使用 keep-alive | 工作区已有可见性控制和退避；Connections 设置页缺少暂停，workspace HTTP 每次新建连接 | 补齐设置页；每条 SSH transport 持有有上限的 HTTP Agent；断开即销毁 |
| 多主机启动 | 多主机状态与任务管理 | 自动恢复四台一批，批内慢主机阻挡下一批 | 改为四个持续补位的 worker，保留手动断开、编辑和删除优先级 |
| 无远端 Harness 安装 | dsh-ssh 工具远程执行；dsh-remote SFTP | 完整远端 Host 需要运行环境 | 属于不同执行模式；不增加重复工具或 mirror。若需要本地会话远程执行，优先评估 Harness 官方 SSH providers |
| 远端 OS 覆盖 | 工具/SFTP 可触达更多 OS | 托管模式限定 Linux/systemd；已有服务模式保留 | launchd/Windows service 需要独立适配与真机验收，本轮不宣称已覆盖 |
| 密码、交互式认证和图形化信任 | dsh-ssh/dsh-remote 自行提供相关 UI | 复用 OpenSSH agent、config、known_hosts；要求非交互认证 | 保留系统认证边界；独立检查提供失败指引，不引入密钥/密码存储 |
| 任意应用端口转发 | dsh-remote 本地/反向转发 | 仅转发 Harness 的 loopback 服务 | 有实际价值，列为后续；需要独立 listener 生命周期、冲突恢复和授权语义 |
| 手机、公网访问与设备配对 | dsh-full-remote | 当前本地内容表面要求同机 Desktop 或 HTTP 浏览器 | 有实际覆盖差距；应复用成熟私网/入口和目标侧授权，不能直接复制代理并宣称支持 |
| 意外断线后自动重连 | 参考项目有不同程度的恢复 | 显式重连及启动自动连接；不重放业务请求 | 本轮优化启动恢复，不将“启动时自动连接”暗中变成永久重试策略 |

我们的 systemd 所有权校验、维护锁、更新快照与回滚，以及原生 workspace/session/settings 归属已经覆盖另一组重要能力。参考项目的工具数、mirror 或提示词补偿不构成我们需要增加同等模块的理由。

## 实现落点与验收条件

- `src/host/ssh-check.ts`：固定只读 SSH 命令，有界输出、超时及进程清理；遵守现有 SSH 配置与严格主机密钥验证，关闭自动 host-key 更新。经 owner-only Typert RPC 调用，不保存记录、不安装 Harness、不启动或重启远端服务。
- `src/host/ssh-common.ts` 与 `lifecycle.ts`：共用错误分类，只返回固定消息。表单检查使用经过 codec 过滤的结果，进程输出、路径、token 不进入结果。
- `src/client/ConnectionForm.tsx`：测试当前未保存的 target；目标变化、表单关闭及服务替换使旧结果失效。SSH 成功明确不等于 Harness 已就绪。
- `src/host/manager.ts` 与 `harness-http.ts`：每 transport 独立的有界 keep-alive Agent。启动认证仍使用一次性 HTTP；SSH transport 关闭、重连和卸载时销毁池，临时 workspace HTTP 失败保留健康 transport。同端口新 transport 不继承旧连接；请求结果不明确时不重试写操作。
- `src/client/Panel.tsx` 与 `connection-polling.ts`：隐藏暂停、恢复刷新、请求串行、卸载抑制晚回调；用户操作后的新状态不会被旧列表覆盖。
- 连接阶段只在 connecting/updating 中出现，成功、失败、取消后不残留。启动恢复最多四台并发，腾出一个位置即处理下一台；不推翻期间的用户操作。

验收关注实际 HTTP socket 数、并发上限、取消和重连后的资源释放，以及表单/列表的可见行为；没有真实 Windows 延迟测量前，不宣称具体百分比提升。完整当前结果见 [开发与验证](development.md)。

## 不应继承的实现代价

- dsh-ssh 的 [policy](https://github.com/dsh-ssh/dsh-ssh/blob/17764146e474b44222d12a95c585b5de782f9daa/packages/dsh-ssh/src/policy.js#L1)明确是词法路径限制，不是远端 OS sandbox；[settings](https://github.com/dsh-ssh/dsh-ssh/blob/17764146e474b44222d12a95c585b5de782f9daa/packages/dsh-ssh/src/settings.js#L29)注明密码明文持久化，secret 展示不等于加密存储。其写入 fallback 会先删目标再 rename，不具备完整原子替换保证。
- dsh-remote 的 mirror 同步以 size/mtime 判断变化，不能证明内容相同；动态指令、文件引用和工具过滤增加宿主语义适配成本。其 [sandbox](https://github.com/flymysql/dsh-remote/blob/ca22999ba851a798ddd5deb73a5175213f0bc1ce/lib/remote-sandbox.js#L19)同样不提供任意命令的 OS 隔离。
- dsh-full-remote 的 [page bootstrap](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/0c24350d264b0f40ff851fb32b5005691a656e75/src/page-bootstrap.ts#L7)包装 ModuleLoader 并改写 loopback 判断，依赖宿主内部时序；[self-check](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/0c24350d264b0f40ff851fb32b5005691a656e75/src/self-check.ts#L67)接受部分非 403 状态，不能单凭其成功证明完整应用可用。

这些观察用于区分实现保证与文档描述，不表示已经对参考项目完成全面安全审计。

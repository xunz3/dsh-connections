# 评审后修复与能力边界

本记录对应 0.1.8 基线之后的源码修订，**不是一次已发布的新版本声明**。原始审查结论保留在评审文档；本页与[使用说明](<usage.md>)描述修改后的行为，历史验收记录不能替代本次验证。

## 产品与信任边界

这一轮继续做 **单用户、owner 等价访问的 SSH 远程窗口**：远端 Host 是会话、任务、审批、凭据和插件的唯一事实源。本机仅保存连接、目录缓存和来源选择，不镜像会话日志。没有新增公网 relay、设备配对、controller scope 或第二套命令协议，也不宣称多用户或最小权限。

## 2026-11-03 主题收尾与性能基线

2026-11-04 补充了真实 Windows 打包 Desktop rc.5 验收：当前候选的亮暗主题、
真实窄窗口、强制颜色模拟共 6/6 通过，标题栏收起/恢复通过；Windows 系统
OpenSSH → 隔离 WSL Host 的真实 webview 目录选择、文件预览和远端原生
Settings 通过。使用 `connectOverCDP(..., { noDefaults: true })` 排除自动化焦点
模拟后，真实最小化使父页与 guest 均进入 hidden，稳定后的 10.004 秒观察到
0 次 Connections API 请求，恢复后保留文件预览。一次重新打开远端的呈现
超时仍未找到根因，不计为关闭稳定性问题。详情见[开发记录](<development.md>)。

workspace review 新发现的两个 P2 已修复：主按钮悬停采用原生 primary
fill/hover/foreground 配色；连接状态与管理按钮 hover 改用 rc.5 实际存在的
token。P3 的旧控件复用描述已同步。新增 Chromium 主题验收 6/6 通过，覆盖
亮暗主题、强制颜色、窄窗口与 200% CSS zoom；这不替代系统高对比度、文本
缩放、屏幕阅读器及打包 Desktop 验收。

新增隔离双 Host 的当前版本资源采样工具和记录，测量小目录下的 CPU、采样
RSS、浏览器网络量与导航延迟，不把单次基线称为优化前后收益。原生五项验收
首轮 4/5 通过，工作区用例出现测试读取授权失败后单独重跑通过；该不稳定性
仍需保留。命令、结果和边界见[开发记录](<development.md>)与[性能记录](<performance.md>)。

## 2026-11-01 rc.5 原生验证与依赖收敛

本节晚于下方 SSH 收尾记录。WSL 已升级为 rc.5，但当前 Web profile 仍安装旧 embedded 内容包；本次不把它切换为本地管理器，也不重启现有会话或用户远端服务。原生验收使用独立 homes、测试密钥/sshd、真实 rc.5 双 Host 与安装后的归档，结果见[最新验证记录](<development.md>)。

| 依赖 | 本次处理 | 仍需诚实保留的边界 |
| --- | --- | --- |
| runtime native Client imports | Menu/Modal/Tooltip/图标/状态与相对时间改为插件自有控件；snapshot store 自有；两层产物拒绝 Harness Client runtime imports。 | type-only 开发输入、公开 Service/Slot 契约仍按精确版本核验，零 runtime import 不等于零平台依赖。 |
| 模态与菜单 | 主题 alias、自有前景/焦点/IME/Tab 协调；原生 Close resolver 优先查询有所有权复核的自有层能力；每个 View 边界一份样式，不按每行复制。 | 没有加入原生私有 WeakMap，也不承诺其它插件直接调用私有 closeTopModal 能关闭自有层；真实原生 Modal/Menu 对照及原生 Settings 路径分别验收。 |
| Account 工厂 | 删除整包 AST 派生、复制 CSS 和重部署；保留独立原生 Account 插件，通过公开 Slot inject 委托与插件自有登录呈现桥接 open/copy。 | 账号流、凭据、profile/balance/bonus/sign-out 和授权尝试仍由远端原生实现；没有做真实账号登录或发送模型请求。 |
| Settings 工厂 | 仅保留一个受控 ConfigForms 构造适配，显式注入自有 snapshot-store；执行设置继续使用原生 schema/mirror/有序写队列。 | rc.5 没有正式 form-override seam。运行时包裹已缓存 form 不能唤醒旧订阅；Host patch 的 isolate 不进入 Client boot graph。拒绝伪造 mirror revision 或全局改 provider，不能谎称 Settings 工厂已全部删除。 |
| 私有 shortcut | 包裹范围限于 content namespace 与 settings.open；无关、第三方及冻结的 application command 不被改写。保留原生 provider、绑定、菜单/重复/冲突与清理语义。 | rc.5 公开 Service 无 resolver middleware，仍有一处经构建和运行时检查的 registry.commands 边界；失败撤销远端入口，不重建键盘 provider。 |
| Settings 图标 | 删除依赖 native nav 顺序和 DOM 结构的 CSS mask；原生导航保留自己的图标，原创 SVG 仅用于插件表面和显示资源。 | 不再为该视觉细节保留私有 DOM 依赖。 |

原生双 Host 验收还捕获并修复了 rc.5 冷启动竞争：自动恢复本机 blank session 也会调用 beginNavigation，旧观察器因此关闭远端并删掉选择。修复使用公开 first-main/workspace baseline，只对自动恢复延迟面板提交，目录读取并行；30 秒回退不是伪造启动成功。首次绑定后仍捕获同 blank 的主动 New Session。冷启动尚无 view 时，可信本机输入保守取消自动恢复，不拦截或转发原生事件。实际发布模块的双顺序组合回归与安装后的刷新/本机 Host 重启验收均覆盖该路径。

内容契约的 Settings/Account revision 更新为 2，旧内容包须更新后重新打开；这不是扩宽 Harness engines 或宣称未来版本自动兼容。本轮保留一个 Settings 构造边界与一个私有 shortcut 边界，属于实际缩小依赖面，不是“所有私有 API 已清零”。

## 2026-10-31 SSH 收尾：Agent Team 与独立复核（前一轮）

在保留上一轮全部未提交修改的基础上，两个独立只读 subagents 与 Host/Client teammates 交叉复现了跨模块遗漏；本轮不以旧评审的关闭数量代替验收。

| 新发现 | 当前修复与验收边界 |
| --- | --- |
| SSH 认证缓存跨代次 | 新 transport 与旧 transport 关闭均撤销 cookie/authenticating 引用；旧刷新迟到成功/失败都不能给新传输提供认证结论。 |
| managed Host 重启后内容“重新连接”无效 | Workspace/Settings 的实际错误按钮调用真正 reconnect，重新 prepare 取得地址/凭据并保留原导航目标；目录普通重试仍是 refresh/retry。已有服务仍须由用户更新 launch URL。 |
| 旧目录写入落到替换 Host | catalog 和每页读取绑定当时的 transportId，保留旧目录时不从新 list 补领身份；五种业务写入必须携带该身份，Host 在串行 lease 内核对，陈旧/缺失返回 CONFLICT 且不向新 Host 发写请求。这个字段只在本机 RPC envelope，不改变远端内容协议。 |
| 旧交互在新目录上重新领取身份 | 相同 target/port/native IDs 的新目录发布后，ViewModel 撤销旧来源的 rename/forget/archive 及 pending UI completion；迟到 SESSION_ACTIVE 不得重新打开确认。Rename 按 authority 重建，菜单同步检查 opened authority 与最新 ref；旧 onSelect/onClose 不能写入或关闭新来源菜单。同一 authority 的刷新与本机编辑继续保留草稿。 |
| 工具审批期间更换目标 | 连接级操作在审批前捕获 Host-only destination revision，审批显示名称/SSH target/模式/版本；manager 在串行变更边界复核。revision 不进入工具输入、结果或审批日志；不宣称跨进程 CAS 或凭据存储事务。 |
| enabled 被误当 active | receipt/reconcile 必须观察精确 entry 的 fiberPhase=active；pending/loading 有界只读等待，失败不续写成功 receipt、不自动重启 Host、不重放未知写入。fixture 现在显式建模挂载阶段。 |
| Settings 隐藏仍轮询/误超时 | watchdog、菜单握手使用可见时间预算；隐藏前的晚回不能发下一段 RPC、阻塞恢复检查或关闭新导航。viewClientId 的 pagehide/pageshow 监听随各自 Cordis owner 撤销。 |
| hero directoryFlow 仍强接管 | 改最小 -1 shadow；负优先级竞争、不可安全委托的带 children provider、alias/wrapper 注册异常均保留原生入口。 |
| 管理 stdout 限额后继续积累 | 按 16 KiB 字节限额先检查再解码，失败/结算后丢弃后续 chunks，而不是在终止宽限期间不断拼接。 |
| 普通 RPC 假定 Gateway 会清洗错误 | 新共享 Host operations 只输出已声明数据与固定 domain failure；未知 credentials/provider/I/O 文本不进入 RPC 或工具。保留 workspace 的固定错误 envelope，不依赖 Gateway 的普通 Error.message 行为。 |

### 一个业务实现、两类调用者

本地 Host 只创建一个 manager/store/lifetime；`connectionOperations` 提供校验后的业务操作。owner-only RPC 与可选 `connections` Agent 工具都使用它，不伪造 Remote owner invocation、不另建连接管理器。工具提供有界 list/ssh_hosts/check_ssh/catalog，以及 rename/connect/reconnect/disconnect/forget/update 和五种 workspace mutation。连接变更和 workspace 写入在工具执行体内调用原生 approval；重排的 pre-execute listener 不能绕过该门。缺 Agent/approval/Host snapshot 能力时拒绝执行。

新增目标、launch credential 录入和损坏记录维护确认仍是 user-only UI；工具没有 save/open/diagnostic-delete、任意 RPC、view channel 或凭据参数。停止/归档活动需显式动作并经过审批。取消不回滚已提交操作；已启动的共享操作必须结算，不重放未知结果，也不因单次工具取消中断另一个 UI 调用者。

### 仍不能称为完全公共契约

本轮按已加载的插件开发/agent-experience skills 与 Inspect 契约实施，没有改当前会话 preset 或用户 profile。本节验证时运行 GUI 是 rc.3 的 embedded artifact；随后 WSL 升级 rc.5，见上节。源码本地准入仍精确 rc.5，源码验证不代表已替换当前 GUI。工具 SDK rc.5 仅新增为精确开发依赖并作 type-only 消费，没有增加必需的生产依赖。

前一轮仍保留 Settings/Account 工厂与 runtime Client 控件依赖；随后 Account 工厂、runtime imports 和图标 DOM seam 已按上节收敛。Settings 构造、shortcut registry、layout/provider、launch 日志/浏览器 cookie、Plugin Manager envelope 仍是版本绑定边界。没有伪造上游 issue/PR 或自动兼容承诺。

最终命令、实际结果及真机/现有 profile 的验收边界见[开发与验证](<development.md>)。

## 对照 review 的处理结果

| 条目 | 当前结果与边界 |
| --- | --- |
| P1-2 / C1 | 采用过渡方案 A：本地 patch 只插入 Connections，不再禁用、内联或重新部署原生 sidebar，不再使用 uiWorkspace Proxy。整个客户端工厂失败、entry 停用与 bundle 停用均不需要恢复一个已被移除的原生壳层。 |
| New Session 取舍 | 原生顶部/收起侧栏 leading 按钮保持**本机**语义；列表内来源动作与已验证的原生快捷键适配仍跟随当前来源。原生显式导航关闭远端内容并取消待恢复的远端选择；插件内部面板切换有独立导航所有权边界。不能再宣传“顶部按钮跟随远端”。 |
| R2 / HR-10 部分 | stdio 建立后真正的认证/主机密钥错误升级为连接级错误，撤销所有流并保留可操作诊断，不自动重认证。网络、转发、子进程启动失败仍隔离在单流；转发目标的 Permission denied 不当作认证失败。Windows spawn UNKNOWN 根因与完整 Desktop 验收仍未关闭。 |
| R3 / C6 | 一轮目录刷新复用已取得的连接列表做 view 健康检查，只发一次 list；列表取得前捕获导航代次，慢目录不能用旧 transport 样本误伤新 view。独立显式 check 仍重新采样 authority，不扩大 RPC 缓存 TTL。 |
| R4 / C2 | 列表和 Settings header 使用最小 -1 shadow；负优先级竞争者、不可组合的原生 header 或注册失败时撤销自己的 alias/占位并保留原生内容。失去 header 时关闭依赖的远端 Settings lease。平台仍会先拒绝后来同为 -1 的冲突注册，不宣称有通用 replacement/arbitration 原语。 |
| R5 / C10 | 主行 roving tabindex、Up/Down/Home/End、搜索 Enter 跳转、行/菜单/对话框移除后的焦点恢复。输入、IME、菜单自己的方向键不被截获。 |
| R6 | POSIX ControlPath 按 UTF-8 字节计长并预留 OpenSSH 临时后缀/NUL；超限使用短 /tmp 私有目录，失败给固定安全诊断。已补边界与多字节用例；没有把 Linux fixture 当作 macOS 真机验收。 |
| R7 部分 | 新 worker 的持锁原子写入使用可辨认的 .tmp-locked-UUID；只清理私有 root 已知名称，并校验 uid、类型、权限和硬链接数，unlink 不递归、不跟随目标。历史 worker-only transaction/result/current 临时项可清理。**历史锁外 environment/request 通用临时项保留**，因为无法证明旧客户端已崩溃；混合新旧版本回归保证不会删除旧 bootstrap 正在提交的文件。旧客户端自身的锁外写入顺序不能被新 worker 单侧改写。 |
| R1 部分 | supervisor ready ack 与启动失败分类，CONTROL_PATH/SUPERVISOR typed tag 只映射固定安全文案，不放行原始 Error.message。已增加单连接 Linux supervisor 资源基线；多连接开销与打包 Electron execPath 仍需专门验收。 |
| HR-08 | owner-only 主动诊断 current/legacy exact key，损坏记录可见；下载脱敏报告后显式维护确认，再按 receipt、有效期、重读 invalid 与完整记录 digest 清理 exact key。未知 scope/畸形 ID 不认领。见下方不可恢复及并发限制。 |
| C7 | shell.leading 有实际渲染位置。没有父端桥的 sidebar toggle 不注册为可用命令，直接调用明确返回 NAVIGATION_UNAVAILABLE，不再静默空操作。没有新增 postMessage 命令权限。 |
| C11 / P1-7 部分 | surface 父同步、子快照、动作等待、embedded poll/report、Desktop Settings relay 隐藏暂停、恢复对账，瞬时失败有封顶退避；呈现 watchdog 同步使用可见时间预算。完成副作用的 tombstone 有界保留，未知结果不重放副作用。没有删除必要的目录对账轮询。 |
| C12 / C13 部分 | 显式 mirrored palette 与 resolved light/dark preference；不伪造未观察到的另一套主题。核心 chrome 去除颜色字面量/固定字体 fallback。2026-11-03 修复 primary hover 与无效 token，实际 rc.5 主题的 Chromium 亮暗、强制颜色、窄窗口、200% CSS zoom 验收通过。仍不声明独立双 palette、全部系统高对比/文本缩放与真机视觉验收完成。 |
| P1-6 部分 | 增加复制原生 session ID（含离线目录行）与中英成功/失败提示。fork、服务端全量搜索、拖拽排序、第三方 row 扩展、原生 hover card、事件注意力与 subagent 聚合仍不支持；当前搜索仅覆盖已接收的目录。 |
| R8 | 保留并精确固定 Schemastery 3.18.5。它提供实际运行时 Config/Standard Schema 与隐藏常量校验，不仅是 TS 类型；未为了删一项依赖退回无运行时校验配置。正常安装解析该依赖，无须用户另外配置。 |
| P1-1 / R9 部分 | 新增[构建契约清单](<../dist/contracts.json>)，与[原生输入清单](<../dist/native-inputs.json>)绑定摘要，两层包均校验。openView 在分配/替换 lease 前复核所需远端契约，父端在获取 launch URL/导航前再次确认。内容不兼容不关闭健康 SSH 或本机管理。精确版本准入仍保留。 |
| P1-4 部分 | 构建清单标记 Connections embedded artifact 的 owner/kind/contract，便于识别；这不等同已完成 profile 持久化管理标记、第三方 shell/provider doctor 或全组合兼容验收。远端 layout/Settings 构造适配仍存在，Account 已改为独立原生部署与公开槽位委托。 |

## 诊断导出不是凭据备份

在 Settings → Connections 主动打开损坏记录诊断，刷新只读该插件认可的精确 key，不调用具有迁移副作用的正常连接读取。下载只包含合法 ID、scope、固定问题类型与并发能力说明；不含原始 payload、token、URL、Host 内 digest 或可复用的清理 receipt。

**脱敏 JSON 不可恢复凭据**。删除会永久丢弃所选损坏记录。无法完整、安全地计算摘要（过大、循环、getter 或非普通原生数据）时只能查看/导出，不允许清理。提供者异常不会伪装成损坏记录，删除结果不确定时消费 receipt，要求重新诊断而不是自动重试。

原生 credentials 没有 compare-and-delete。队列只覆盖**同一进程、同一 provider 对象、经 Connections 执行的操作**；其他实例、调用者或进程仍可能在重读与删除之间写入。UI 要求先停止其他写入者并显式确认此限制。需要无条件在线原子清理时，仍依赖上游 conditional delete/维护独占能力；不能把本次诊断称为跨进程事务。

## 契约清单不等于未来版本自动兼容

清单区分构建输入、插件自有契约、CI 实测版本。sidebarAdapter=0 表示本地不再复制原生工厂；remoteEventProtocol=0 表示本插件没有事件/控制面。输入 digest 用于溯源，不要求兼容两端有完全相同的构建摘要，也不是平台承诺的 capability 版本。

内容只比较 schema、workspace、surface、settings/account 必需契约；本地 shortcut/sidebar 与尚未消费的事件能力不作为远端内容门槛。每次新 lease 握手，不按端口或 SSH generation 永久缓存兼容结论。旧内容包拒绝新字段、缺少或不匹配广告时显示更新指引。

本地 engines 仍精确 rc.5，远端 native factory 仍只选已核验 rc.2/rc.3/rc.5。rc.6 即使自报相同插件契约也不因此被接纳。先有 fail-open，不代表已取得上游公共 module/shortcut/settings/provider 契约；自动新版本准入仍未完成。

## 不直接上线“只读 $events 徽标”的原因

核对已安装 rc.3 与项目依赖 rc.5 的原生实现后发现：

- API Peer 的 /connect 是独立 v2 API cookie/302 Mux 入口，不是当前浏览器 launch 交换的 v1 cookie/303。物理 socket 释放会 dispose Peer，下一代需重新握手；不能复用旧 API cookie 假装恢复。
- 原生整条 $events 流要求 interactions=answer。审批/提问是 waterfall，不是普通 emit；一个只记徽标然后 return undefined 的 listener 可能被当成 result，结束 pending 并取消其他作答界面。缺 adapter 的自动 next 也不是永远无副作用的 observer。
- 不能宣称全部写操作有原生业务幂等键。prompt 有 requestId；fork/cancel/updateQueue 没有同等通用键。userQuestions.answer 也不能替代所有 foreground/timed waterfall 作答。

因此本轮保留目录快照与远端文档内审批/提问/控制，不新造命令通道、不镜像日志、不删除轮询。下一步应独立使用官方 Node Remote/Peer 客户端，验证作答仲裁、取消、两端同时在线、掉线重交付和未知写入结果不重放，再接本地注意力/控制面。这不是“平台没有 API”，而是尚未完成集成与验收。

## 上游依赖与仍未完成项

- P0-1 配对/跨设备与 P0-2 controller 身份、scope、撤销、审计：没有实现，产品决策与非 owner 准入仍是前置条件。
- P0-3 事件/控制面：没有实现，以上原生仲裁风险须单独验收。
- P1-3 私有 shortcut registry、launch 日志解析、浏览器 cookie/boot 形状、远端 Settings constructor、layout provider 替换仍需上游公共接口；Account factory 和设置图标 DOM seam 已移除。没有新增 DOM/日志/通用 RPC 适配面；也没有在本次会话中替用户创建上游 issue/PR，不能伪造链接或宣称这些契约已公共化。
- P1-7 已有小目录、单连接的真实 Host/renderer CPU、采样 RSS、浏览器 HTTP 字节与导航 p95 基线；另已验证真实 Windows 最小化后的短窗口 Connections 请求暂停。peak heap、完整 SSH wire bytes、隐藏状态 CPU/RSS、多目录规模、优化前后对比与事件替轮询仍未完成。方法和限制见[性能记录](<performance.md>)。
- 原始 Win32 spawn UNKNOWN 根因、Windows/macOS/Electron 完整安装/崩溃恢复、真实跨版本 systemd 更新回滚、账号/模型请求和第三方 profile 组合仍需授权环境验收。

## 验证方式

使用独立 write scopes 的 agents team 实现 Host、原生壳、surface、列表和凭据诊断；只读 subagents 复核契约、性能与最终跨模块路径。独立复核发现的转发 EACCES 误分类、跨版本临时文件清理、呈现 watchdog 与共享导航边界均纳入回归，而非仅记录为“已检查”。

本次不更新或重启用户的当前 DSH GUI、profile 或任何已保存远端服务。浏览器测试使用独立 fixture 服务；Desktop-contract 用例本身仍是 Chromium 模拟，2026-11-04 另有上述独立打包 Electron 实测。可复核命令与各轮实际结果已记录在[开发与验证](<development.md>)；历史全量测试与本次定向验收分别记录，不合并成一次新的全量通过声明。

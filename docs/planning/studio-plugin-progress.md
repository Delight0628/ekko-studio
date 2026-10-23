# Studio 插件体系实施记录

更新：2026-10-24。分支：`feat/studio-plugin-context`。基线：`8f215f59d`。

本文件记录实际实现；[架构总案](studio-plugin-architecture.md)、[契约](studio-plugin-contracts.md)和[实施计划](studio-plugin-execution.md)仍定义完整交付范围。当前为迁移开发状态，尚未完成全量插件化；旧聊天 HTTP 入口已去掉本机 Socket 回环，运行引擎和存储仍使用原实现。

## 已实现的代码

| 范围 | 当前实现 |
| --- | --- |
| 公共 SDK | 独立 TypeScript 包、JSON DTO、manifest、Agent 工厂、作用域、输出事件、错误码、注册/通知回调/清理入口；SDK/RPC 版本检查 |
| 上下文 | 宿主签发不可变身份与 profile；当前有 `sessions.get/remove`、`agents.list`、`runs.start/get/output`，每次调用重新授权并校验取消状态；RPC 使用宿主句柄。启动目前仅支持未绑定 session/workspace/Run 的独立实例执行 |
| 注册 | profile 隔离、内置/插件提供方联合类型、激活阶段暂存、完整声明及冲突校验、事务发布、generation 资源释放 |
| 插件宿主 | 本地目录校验、摘要工件、独立子进程、有限 RPC 并发、请求超时、输出背压、进程树清理、配置 revision、运行时租约 |
| 安装策略 | 14 个系统插件 ID 已保留；用户安装不能覆盖，删除在接触工件/worker 前返回 `SYSTEM_PLUGIN_PROTECTED`；profile 选择不会被重复系统登记覆盖 |
| 事件 | `ctx.on` / `ctx.once`、profile/owner 授权、每分区有序通知、队列及超时上限；仅把明确允许的旧业务事件字段投影到公共事件表 |
| Agent API 执行 | 实例、接受请求、幂等、启动、流输出、完成屏障、取消、终态与事件事务落库；崩溃恢复标记 interrupted，不自动重放输入 |
| 协议抽取 | 标准 ACP 连接及事件转换移入独立 `studio-agent-drivers`；旧调用通过兼容入口复用，原有协议测试继续通过 |
| 旧聊天启动 | 准入已迁为共用服务，HTTP 直接调用；直调入口已绑定宿主 ExecutionScope、复制输入与身份并区分准入前取消和准入后排队；SDK 旧聊天启动仍待迁移 |
| 工程接入 | bootstrap、鉴权 API、生成式 OpenAPI、runner 构建、插件私有导入边界检查、独立 Echo 样例 |

安装策略测试中的 14 条 fixture 只验证保护和幂等规则。**当前没有把这 14 个 Agent 注册成已安装系统插件**，也没有用空壳包代替厂商迁移。旧 Coding Agent 仍使用原执行和管理路径。Hermes/Ekko 仍是原内置模块。

## 当前开发接口

所有接口使用已有认证；需要 profile 的接口使用现有 profile 中间件。不得把身份、权限或 owner 放进请求体自行选择。

| 方法及路径 | 作用 |
| --- | --- |
| `GET /api/studio/plugins` | 已安装插件与宿主决定的安装策略；超级管理员 |
| `POST /api/studio/plugins` | 从服务器本地目录安装；超级管理员；不自动启用 |
| `GET /api/studio/plugins/:id/profile` | 读取 profile 配置及 revision；超级管理员 |
| `PUT /api/studio/plugins/:id/profile` | 配置、授予声明的能力、启停；超级管理员；活动租约阻止切换 |
| `DELETE /api/studio/plugins/:id` | 卸载用户插件；超级管理员；保留配置及运行历史 |
| `GET /api/studio/agent-types` | 当前已激活插件提供的目录；尚未合并旧内置目录 |
| `GET /api/studio/agent-instances` | 当前用户、当前 profile 的实例 |
| `POST /api/studio/agent-instances` | 按已注册类型的 schema 创建实例 |
| `POST /api/studio/agent-instances/:id/runs` | 接受文本执行及幂等键 |
| `GET /api/studio/agent-runs/:id` | 读取自身 Run 状态 |
| `GET /api/studio/agent-runs/:id/output` | 按 `after` 序号读取自身 Run 输出 |
| `POST /api/studio/agent-runs/:id/cancel` | 请求取消自身 Run |

运行记录与旧聊天会话目前分别存储。该入口用于迁移开发验证，不能据此宣称五类运行入口已经统一。安装记录、profile 配置、实例、Run、输出及公共事件使用新增 SQLite 表，没有改写旧历史记录。

## 尚未完成的交付范围

| 任务 | 状态与缺口 |
| --- | --- |
| T00 | 已完成源码清单及部分原测试基线；真实 CLI/平台矩阵、协议录制、数据副本和性能基线尚未齐全 |
| T01 | SDK 和边界检查已有实现；仍需与完整契约对齐，包括交互、管理、可靠消费等 |
| T02 | 会话单删/批删和 Agent 实例启动已分别与 SDK 共用领域服务；已覆盖作用域、幂等与真实 worker RPC。旧聊天准入与 HTTP 直调已完成本阶段迁出；旧聊天 SDK 接入、工作流及其余领域仍未完成 |
| T03 | 进程、RPC、注册回滚和资源回收已有实现；服务依赖图及完整诊断尚未完成 |
| T04 | 通知与持久化事件已有实现；可靠消费者、重试/死信、保留期、hooks 和旧投影的事务统一未完成 |
| T05 | ACP 驱动已抽取；受管进程/MCP/模型、其他协议驱动仍需迁移 |
| T06 | 文本 API 有协调器；多轮租约、交互响应、usage 聚合、checkpoint 恢复及原聊天统一写入未完成 |
| T07 | 新注册表与实例开放 ID；旧枚举、历史别名及客户端目录尚未迁移 |
| T08–T10 | 厂商插件独立化和 Hermes/Ekko 统一运行接入未完成；禁止用定义搬迁替代功能验收 |
| T11 | 新 HTTP 入口已接入；聊天/Socket、群聊、工作流、全局任务及客户端管理未完成 |
| T12 | 本地用户包和系统删除保护已有实现；14 个随包工件、默认安装、排空升级/回滚、分发验收未完成 |
| T13–T14 | 真实迁移演练、跨平台验收、临时路径清理与最终发布验收未完成 |

## T02 进展：会话删除共用领域服务

本项验收范围为现有会话删除用例的迁出，以及插件 ctx 接入；不代表 T02 整体完成。

- [x] 单删和批删的原生检查/清理、运行停止、本地删除及通知集中到 `services/sessions/removal.ts`；controller 只适配请求、旧响应格式和批量统计。
- [x] SDK 与 worker 支持 `ctx.sessions.remove(id)`；manifest 必须声明并获授 `sessions.remove`，worker 每次调用校验能力；身份、profile、绑定会话和取消信号来自宿主，RPC 不接受调用方指定它们。
- [x] 本地会话、消息、任务和工作区差异在一个 SQLite 事务内删除；同 ID 删除串行化，成功提交后才发布原有删除通知。归档通知不会误投影为 `session.deleted`。
- [x] 核验 HTTP/SDK 返回语义、native-only 历史、同 ID 不同 profile、取消/权限撤销、删除期间 profile 变化、数据库回滚、并发及真实 worker 授权。

| 入口 | 身份与范围 | 实现与结果 |
| --- | --- | --- |
| 现有 HTTP 单删/批删 | 保留认证中间件的用户或服务令牌身份；领域调用前和原生检查后重新检查目标 profile 权限 | 都调用 `removeStudioSession`；响应中的 `hermes`、批量计数和失败列表保持兼容 |
| `ctx.sessions.remove(id)` | 当前 execution scope 的主体与 profile；有绑定会话时只能操作该 ID；重新检查用户状态和 profile 访问权 | 同一领域服务；返回 `{ deleted, native: { attempted, deleted, profileId, error? } }`，失败使用公共错误码 |

副作用顺序为：读取目标 → 授权 → 只读原生检查 → 再次授权和取消检查 → 既有 Coding Agent 停止/原生删除 → 本地事务 → 删除通知。显式指定 profile 时，不停止或删除其他 profile 下同 ID 的本地会话。原生检查期间目标本地会话发生迁移时返回 `REVISION_CONFLICT`。

取消发生在首个副作用前时拒绝操作；开始变更后完成本地清理并报告实际结果，避免已删除却返回“取消成功”。原生状态和 Studio 数据库无法构成共同事务，保留既有策略：原生失败作为结果中的诊断，本地删除继续；本地失败回滚并返回 `INTERNAL`，不会发出成功通知。native-only 删除没有本地 owner，沿用旧入口不发送本地会话删除通知的行为。

本项未实现统一运行租约下的活动 Run 拒绝/取消选项，仍使用既有 Coding Agent 停止端口；Hermes/Ekko 统一运行适配由 T06/T10 负责。事务 outbox、可靠事件投递与删除 hook 仍属 T04，原生删除的跨系统恢复仍需后续迁移验收。当前通知是提交后的进程内发布，不能宣称已经具备崩溃后可靠投递。

本次专项：9 个文件、196 项通过（包含删除/事务、原 controller、分享会话权限、真实 worker、内核、事件、压缩记录与任务回归）；`npm run build`、`npm run harness:check` 和 `git diff --check` 均通过。该增量未重跑全量 coverage/浏览器矩阵，下文保留基础实现的历史验证结果。

## T02 进展：Agent 实例启动共用领域服务

本项实现新 Agent API 的启动端口和 `ctx.runs.start`。这不是旧聊天启动迁出完成，也不代表 T02 或 T06 整体完成。

- [x] `POST /api/studio/agent-instances/:id/runs` 和 `ctx.runs.start({ instanceId, input, idempotencyKey })` 共用执行上下文和 `services/agents/start.ts`；没有本地 HTTP/Socket 回连或假 Koa/Socket 对象。
- [x] SDK/runner/宿主完整支持 `runs.start`；manifest 声明且当前 profile 授予此能力后，真实 worker 才能调用。身份和 profile 来自宿主句柄，输入不能携带 owner、principal、provider 或 scope。
- [x] 授权等待前复制请求；协调器在接收前重新检查主体、profile 和实例 owner。暂不支持已有 session/workspace/Run 绑定的上下文启动新 Run，明确返回 `CAPABILITY_UNSUPPORTED`，不会丢弃绑定后扩大范围。
- [x] 相同 owner/profile 下的幂等键关联实例及完整输入；HTTP/SDK 并发重试只创建一次。不同输入返回 `REVISION_CONFLICT`；已接收请求在提供方移除后仍可查询，权限撤销后不能靠重试读取结果。
- [x] 接收前取消不落库、不执行；接收落库后返回实际 Run 回执，调用方上下文结束不撤销已接受的独立执行。后续通过现有 Run 读取/输出/取消 HTTP 入口管理；SDK 取消方法尚未实现。

| 边界 | 当前行为 |
| --- | --- |
| 身份与资源 | HTTP 使用认证中间件创建的 scope；事件上下文使用订阅 owner；两者都只能启动相同 owner/profile 的已创建实例 |
| 校验与提交 | JSON/字段/长度校验与请求快照 → 当前授权和取消检查 → 实例归属、输入和能力校验 → 持久化 accepted → 协调器执行 |
| 持久化与通知 | 复用现有 Run 唯一键、输出存储及终态/事件事务；启动服务不增加第二个输出或完成事件生产者 |
| 失败与恢复 | 不自动重试 RPC 写入；响应丢失可使用相同幂等键取回已有记录。重启仍将未结束 Run 标记 interrupted，不重放输入 |

专项覆盖 HTTP/SDK 一致性、并发幂等、owner/profile 隔离、伪造字段、取消与撤权、输入快照，以及真实事件回调 worker 的启动、重复调用和能力撤销。Node 24.22.1 下的本增量验证结果：

- 插件、启动、协调器与会话删除专项：9 个文件、78 项通过。
- `npm run test:coverage -- --maxWorkers=2 --testTimeout=20000 --hookTimeout=20000`：885 个文件通过、12 个跳过；8,986 项通过、32 项跳过。仅本地命令使用 20 秒时限，未改仓库默认配置。
- `npm run test:e2e -- --workers=2 --reporter=line`：1,024 项首轮全部通过。
- `NODE_ENV=production npm run build`、`npm run harness:check` 和 `git diff --check`：通过。

上述检查验证本增量及既有功能回归，不替代真实厂商 CLI、系统插件迁移或发布工件验收。

## T02 进展：旧聊天启动准入服务

本增量迁出原 Socket `run` 处理器的准入与调度规则，保留原有执行器。该阶段尚未完成 HTTP 直调；后续进展见下节。旧聊天 SDK 接入仍未完成，T02 不整体完成。

- [x] `services/chat-run/start.ts` 接收认证后的 caller scope、请求和执行/事件端口；无需 Koa ctx、Socket 对象或本机网络连接即可直接测试准入行为。
- [x] profile/session 授权、Ekko 历史身份归一、附件归属登记、分类校验、三类命令选择、推送设备绑定、排队和启动失败清理集中到该服务。Socket 入口只组合原命令执行器、运行执行器与事件发送。
- [x] 运行族判断和队列消息投影迁为共用函数，排队/恢复/内部调度保持同一规则；不修改消息与 Run 存储格式，也不增加新的输出写入者。
- [x] 复制请求顶层后再做身份归一和取出推送快照，原请求不会被这些操作修改；这不是插件公共输入校验或完整不可变请求快照。

| 边界 | 当前行为 |
| --- | --- |
| 身份来源 | 原认证与分享会话 packet middleware 继续负责身份和分享输入限制；用户、当前 profile、来源 ID、排队重授权回调由入口注入，不取自客户端 payload |
| 读取与校验 | 先解析可访问 profile、规范化执行族；普通附件输入校验已有会话的 profile，并在运行启动前登记归属；新会话可预登记附件 |
| 命令与排队 | 命令先于设备绑定与排队执行；共享会话不登记上传、不绑定接收者设备，排队项保留原始来源与撤权检查；工作流/群聊的 Ekko 斜杠任务继续交给运行时 |
| 副作用与事件 | 设备绑定完成才启动或排队；绑定失败返回原 `run.failed`。队列通知及 webhook 格式不变，推送秘密不传入运行执行端口 |
| 失败与恢复 | 保留旧行为：执行异常只释放尚无运行句柄/中止控制器/活动标记的预留，已有运行状态不被误清；队列仍是进程内状态，不宣称持久化恢复 |

新增无传输对象的服务测试覆盖 profile 拒绝、附件、命令分流、共享队列撤权、设备绑定、启动失败及请求不变性；既有 Socket/HTTP 测试继续作为行为对照。Node 24.22.1 下：

- 专项共 7 个文件、152 项通过（原 6 文件 139 项，以及 reasoning/API mode 回归文件 13 项）；新增服务用例 23 项。
- 覆盖率首轮 885 个文件、9,008 项通过，1 项旧源码路径断言失败；已将队列入参断言移至新服务，并通过专项复测。最终 `npm run test:coverage -- --maxWorkers=2 --testTimeout=20000 --hookTimeout=20000` 全量复验 886 个文件通过、12 个跳过；9,009 项通过、32 项跳过（394.98 秒）。本地时限参数不改变仓库配置。
- 浏览器全量 `npm run test:e2e -- --workers=4 --reporter=line`：1,023 项通过、1 项侧栏测试失败。trace 显示从聊天切换到历史页时，侧栏尺寸读取返回空值；未修改侧栏实现/测试，`sidebar-resize.spec.ts --workers=1` 单独复测 6 项全部通过。这不是首轮浏览器全绿。
- 生产构建、harness 与差异检查通过。真实厂商 CLI、系统插件迁移及发布工件仍未验收。

## T02 进展：旧聊天 HTTP 直接调用

本增量完成旧聊天 HTTP 的进程内调用和等待结果接口。`runOnce` 不再创建 `socket.io-client`，也不构造假 Socket。执行仍由原 `ChatRunSocket` 宿主组合原引擎；这不是统一协调器迁移或 SDK 接入完成。

- [x] controller 只映射输入输出；`services/chat-run/http.ts` 保留输入/显式模型身份校验、认证和分享约束，再调用内部 `DirectChatRunPort`。HTTP 与 Socket 复用 `startChatRun`。
- [x] `ChatRunCaller` 分离身份、会话观察、单独回复和其他客户端广播；旧引擎通过过渡适配支持真实 Socket 与直接调用者。HTTP 入口不经过 Socket 握手、虚构连接或 `runAndWait`。
- [x] `wait.ts` 保留完成 200、失败 500、待确认 409、超时 504、服务/认证错误 503，以及输出、推理和最多 1000 条事件的响应形状；工具事件使用原发送投影。等待服务将共享撤权作为 403 失败处理并清空已收集的私有内容；生产共享 HTTP 中间件仍保留撤权时主动断开连接的保护。
- [x] 排队输入携带进程内可信调用者，普通排队与展开命令均保留原身份；只有真正开始执行才监听原生运行事件，避免把前一轮完成当成本请求结果。队列消息序列化不包含调用者、身份或凭据。
- [x] 超时/待确认只释放观察者，已接收的执行继续；共享撤权移除该调用者尚未执行的输入，延迟派发再次检查权限。手机确认事件按会话和原设备转发；服务关闭与会话删除结束相关等待。

| 边界 | 当前行为 |
| --- | --- |
| 身份与资源 | 保留原回环握手的用户、profile、App 设备撤销及分享 owner 检查；分享输入仍由服务端会话派生配置；不读取 payload 中的调用者身份 |
| 排队与生命周期 | 观察只覆盖自身执行阶段；HTTP 观察者结束不清除已接受任务的身份。队列仍在内存，不提供持久化恢复 |
| 副作用与兼容 | 沿用原消息、Run、usage、推送与 webhook 写入者；Web/App 的 Socket 事件和 HTTP 请求/响应字段无需迁移 |
| 暂存边界 | 旧宿主仍负责引擎组合和广播；`ChatRunCallerTarget` 是内部过渡类型，不能作为插件 SDK 参数 |

Node 24.22.1 下验证：

- 专项 10 个文件、217 项通过，覆盖三类运行的调用边界、并行 Web 观察者、原生队列归属、超时、撤权、设备隔离、服务关闭和原 HTTP 响应契约；随后补充原生 compact 和真实分享 HTTP 撤权清理验证。
- 最终全量 coverage：888 个文件通过、12 个跳过；9,036 项通过、32 项跳过（267.36 秒，`--maxWorkers=2 --testTimeout=20000 --hookTimeout=20000`，未修改仓库默认时限）。首轮仅一项共享会话集成测试因旧回环 fixture 未注册运行宿主失败；已按生产 bootstrap 注册直调宿主，相关专项 51 项通过后完成上述全量复验。
- 生产构建、harness 与差异检查通过。
- 浏览器全量 `npm run test:e2e -- --workers=4 --reporter=line`：1,024 项首轮全部通过（18.3 分钟）。本次按 coverage、生产构建、harness、浏览器矩阵顺序执行；未修改客户端实现或测试配置。

下一步把旧聊天启动接入**宿主签发的统一上下文**：约束绑定会话/profile/owner、输入快照、取消与结果句柄，并完成真实 worker RPC 的权限和生命周期测试。现有 `ctx.runs.start` 仍只接受独立 Agent 实例。旧 `runAndWait` 仍供工作流/群聊内部编排使用，不能把其假 Socket 暴露为公共 SDK 实现。随后推进工作流执行用例；多轮/父子 Run 租约、hook、usage、checkpoint 和可靠事件仍按 T04/T06 处理。

## T02 进展：直调入口的宿主作用域与输入快照

本增量是旧聊天统一上下文的前置接入，**没有新增 SDK/RPC 聊天方法**，没有把内部 DTO 或调用者端口暴露给插件。

- [x] 直调宿主通过 `createChatRunInvocation` 创建或收窄 `ExecutionScope`，固定主体、profile、会话与 trace。已提供上下文与认证用户、请求 profile 或绑定会话不一致时拒绝；已有 Run/workspace 绑定仍明确返回不支持，避免丢弃约束。
- [x] HTTP 在首次异步认证前复制嵌套输入和响应选项；直调宿主在微任务调度前再次复制请求、用户和设备。修改调用方原对象不会改变排队输入或执行身份。分享输入归一仍保留原来的超时和事件响应选项。
- [x] 宿主信号在首次准入授权前后检查；此时取消不会登记附件、绑定设备、入队或执行。准入授权通过后即进入旧服务可能产生副作用的阶段，调用作用域结束和观察者释放不撤销该工作；延迟派发仍执行原授权回调，分享撤权照常拒绝。
- [x] 排队调用者携带冻结的作用域，最终运行继续使用原主体和输入。该对象只留在进程内，不加入 Web/App 事件或队列序列化。

原 HTTP/分享授权与会话访问策略保持不变。此处主体绑定证明调用参数不能替换宿主身份，**不等于已经实现插件的 session owner 授权**。无登录模式保留内部 service 主体和原有运行归属；该主体不能作为插件权限来源。旧聊天仍使用原执行器、内存队列与结果等待端口，不具备统一协调器的持久化接收、幂等结果句柄或父子租约。

Node 24.22.1 下验证：

- 6 个专项文件、137 项通过，覆盖身份/输入快照、绑定冲突、准入取消、排队期间作用域结束、分享撤权及原 HTTP 契约。
- 最终 coverage：889 个文件通过、12 个跳过；9,051 项通过、32 项跳过，260.03 秒。命令为 `npm run test:coverage -- --maxWorkers=2`，保留默认 5 秒测试时限。此前按本机默认并发运行时，旧 STT 路由测试一项超时；最终按 CI runner 的并发规模全量复验通过，未改 STT 实现或测试。
- 生产构建、harness、规划文档链接与差异检查通过。
- 登录/认证界面、流式聊天、多标签会话和协议文本浏览器回归：5 个文件、32 项首轮全部通过（38.7 秒）；完整浏览器矩阵由本次推送后的 GitHub Playwright 检查继续验证。

下一项仍是 SDK 旧聊天启动：定义公共输入/结果句柄、校验当前用户及 session owner、处理已接收运行生命周期，再做真实 worker RPC 的权限和取消验收。工作流、完整运行协调器和厂商插件迁移继续保持未完成。

## CI 修复：JEV harness 重复解析

`272794bb9` 的 GitHub Build 在 coverage 阶段失败：`jev-harness.test.ts` 的 runtime 注册用例超过默认 5 秒，生产构建尚未开始。检查器在一次扫描中重复解析相同源码、runtime 配置和语言文件；现按**单次检查**复用 AST 和 usage 分析，不跨检查缓存，因此源码/manifest 变更和缺失文件仍立即可见。

36 项 JEV 专项在默认时限下全部通过；本地同一 Node 下专项测试耗时从约 14.9 秒降到 6.4 秒，原失败用例约 0.6 秒。未跳过检查，未增加测试时限。`f38f2fcec` 的 [GitHub Build](https://github.com/EKKOLearnAI/ekko-studio/actions/runs/39999727673) 已通过：888 个文件、9,040 项测试通过，14 个文件/36 项跳过，随后生产构建通过；原超时用例在 CI 为约 1.2 秒。

## 已有验证证据

- 新内核、真实 worker、注册失败回滚、profile/owner 隔离、删除保护、运行协调、HTTP 和依赖边界有专项自动测试。
- ACP 原测试覆盖图片、Unicode/分片、MCP、恢复时去重、模型配置、权限、取消和协议失败。
- 完整应用构建已通过；新增 runner 输出在 `dist/server/plugin-runner.cjs`。
- 真实 CLI 和三种发布形式尚未验证；mock/fixture 结果不等于厂商实际兼容性签收。

基础实现提交 `8a5eda0be` 的验证记录（本次 T02 增量结果见上节）：

| 检查 | 结果与限制 |
| --- | --- |
| 插件、协调器及 ACP 专项 | 8 个测试文件、50 项通过；最后的 profile 通配符保护另重跑内核 9 项通过 |
| `npm run build` | 当前源码完整构建通过，包括 SDK/driver/runner 类型检查、前端及服务端产物 |
| `npm run build:plugins` | SDK 声明、独立驱动及 runner 构建通过 |
| 独立 SDK 工件 | 本地 npm 打包后在临时目录加载成功；未发布到 npm |
| `npm run harness:check` / `git diff --check` | 通过，包含新增私有导入边界检查；规划本地链接检查通过 |
| 全量 coverage 首轮 | 874 个文件通过、7 个失败、12 个跳过；8,892 项通过、20 项超时，另有一次测试 worker RPC 超时；该次 coverage 命令未通过 |
| 超时用例重跑 | 7 个失败文件重新运行；其中 3 个按默认时限通过，剩余 4 个在单进程、20 秒时限下全部 80 项通过。未修改仓库默认时限，也未将此结果冒充全量 coverage 一次通过 |
| 浏览器全量回归 | 首轮 984 项通过、9 项失败、28 项因串行组失败未执行；9 项失败单进程重跑全部通过；剩余位置补跑 29 项全部通过（包含一个已重跑用例） |

上述测试验证当前实现，不覆盖尚未迁移的完整新体系。A01–A34 不能整体标记完成。

## 本地开发与核验

```sh
npm run build:plugins
npx vitest run tests/server/studio-plugin-*.test.ts tests/server/studio-agent-coordinator.test.ts tests/server/native-acp-turn.test.ts
npx vitest run tests/server/studio-session-removal.test.ts tests/server/sessions-controller.test.ts tests/server/session-share-access.test.ts
npx vitest run tests/server/studio-agent-run-start.test.ts tests/server/studio-plugin-host.test.ts tests/server/studio-agent-coordinator.test.ts
npm run harness:check
```

从桌面运行环境启动测试时，按仓库 runbook 在子进程清除 `HERMES_*`、`EKKO_*`、`ELECTRON_*`、`AUTH_TOKEN` 和 `PORT`，避免测试继承真实用户状态。

独立开发示例见 [Echo 插件](../../plugins/example-echo/README.md)。worker 提供故障隔离和宿主能力检查，仍属于受信任的本地代码执行环境，不是操作系统沙箱。

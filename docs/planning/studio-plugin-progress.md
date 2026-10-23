# Studio 插件体系实施记录

更新：2026-10-23。分支：`feat/studio-plugin-context`。基线：`8f215f59d`。

本文件记录实际实现；[架构总案](studio-plugin-architecture.md)、[契约](studio-plugin-contracts.md)和[实施计划](studio-plugin-execution.md)仍定义完整交付范围。当前为迁移开发状态，尚未完成全量插件化，也未切换现有聊天执行链。

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
| T02 | 会话单删/批删和 Agent 实例启动已分别与 SDK 共用领域服务；已覆盖作用域、幂等与真实 worker RPC。旧聊天启动、工作流及其余领域迁出仍未完成 |
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

下一步继续 T02 的**旧聊天启动领域迁出**：将现有 `chat-run` 的认证后 profile/session 解析、命令/排队规则、附件和推送绑定及启动调度拆入 transport 无关的服务端口，让现有 HTTP/Socket 与统一上下文共用。保留原有行为对照测试；不能把旧 `runAndWait` 的假 Socket 当作公共 SDK 实现。之后推进工作流执行用例。多轮/父子 Run 租约、hook、usage、checkpoint 和可靠事件仍按 T04/T06 处理。

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

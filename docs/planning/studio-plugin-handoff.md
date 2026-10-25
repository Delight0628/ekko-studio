# Studio 插件迁移：新窗口交接

交接日期：2026-10-25。用户要求继续自主推进全部需求；本轮因用户准备换窗口而交接，不表示完整目标完成。

## 0. 2026-10-25 接续进展

原工作区改动已保留并完成首批验证，Kimi、共享 ACP 和依赖构建已提交并推送 `15a6371a1`；下文第 3 节是接续前快照，已被本节结果覆盖。

- 最终生产构建、harness 通过；服务端专项 10 文件 103 项通过、1 项按原条件跳过。
- SDK/driver 新增独立 tarball 打包和仓库外 npm 安装、严格 TypeScript 编译及运行验证，全部通过；主应用发布工件移除开发 workspaces 元数据，实际 tarball 回归通过。未执行 npm publish。
- 生产浏览器 4 文件 33 项通过（4 workers、无重试），包括 Kimi 移动端授权启用、实例创建与登录检查。首轮两项断言错误已修复，无跳过或放宽功能要求。
- Kimi 实际 CLI 2.1.1 本轮再次完成 14 轮聊天、19 次本地模型请求、5 次 Studio MCP 调用；没有真实账号或远程付费服务验收。
- 日志 `/tmp/studio-kimi-final-{build,harness,focused,native}.log`、`/tmp/studio-kimi-final-browser-v2.log`、`/tmp/studio-kimi-external-packages.log`。
- QA 已移除原 node_modules 符号链接并完成自身 `npm ci --ignore-scripts`/PTY rebuild/build；冻结 `15a6371a1` 的完整 coverage/browser 回归正在运行，不能切换该副本 checkout。完整验收仍为 **0/14**。
- 新增第四个 Qoder 独立插件，固定 CLI 1.1.78；5 文件 49 项服务端专项、10 项管理页生产浏览器、实际受管 CLI 元数据检查已通过。保留 global-only 模式，真实账号/远程推理未验收；其余 10 个 Agent 待迁移。详细证据见 progress。
- 三平台 CI 暴露两处旧 worker fixture 缺少 SDK source alias，已修复并在移开 SDK dist 后通过 16 项。CI 后续结果待确认，不能沿用旧 HEAD 的 13 项通过声明。

## 1. 从这里继续

- 仓库：`/Users/ekko/Desktop/git/hermes-studio/studio`。上级工作目录为 `/Users/ekko/Desktop/git/hermes-studio`，实际 Git/package 根是前者。
- 分支：`feat/studio-plugin-context`。
- 已推送 HEAD：`ead6a4c3f8557c7e8fdb09beba73b8b988ec0312`。
- 草稿 PR：<https://github.com/EKKOLearnAI/ekko-studio/pull/3513>。交接核实时 CI **13 项通过、0 运行、0 失败**。保持草稿，不合并、不自动转 ready。
- **工作区不干净，包含未提交的 Kimi/ACP/依赖构建改动。先阅读 diff，保留这些改动，禁止 reset/clean 覆盖。** 本交接文件自身也未提交。
- 实施记录：`docs/planning/studio-plugin-progress.md`；需求和验收真源还包括 `studio-plugin-architecture.md`、`studio-plugin-contracts.md`、`studio-plugin-execution.md`。
- 完整验收仍为 **0/14**。当前是 2 个独立插件已推送、Kimi 第 3 个在本地，另外 11 个尚未独立插件化，不能将 fixture/目录/单项运行计为完整迁移。
- 交接前查询未发现仍在运行的 Vitest/build 子进程。被用户中断的旧 exec session ID 不可继续依赖。

## 2. 已推送并验证的成果，不要重复构建

相对用户睡前 `8113d6013`，已推送 25 个提交。最近四个实现提交：

| 提交 | 交付 |
| --- | --- |
| `ead6a4c3f` | 插件声明固定包版本；实例私有 CLI 显式安装、实际版本探针、原子选择、失败保留旧版本、可取消重连的只读日志 |
| `22c61331e` | Skills 完整 ZIP/文件夹导入与目录 etag 确认删除，保留脚本、隐藏文件、二进制资产 |
| `1149e64c8` | 运行期原生命令目录，Qwen `/compress`、Codex `/compact` 真实完成及失败/取消语义 |
| `c6a7d0ec5` | 命令通过 SDK 启动聊天 Run，采用原命令输入行，canonical 消息只写一次 |

此前同一 PR 已实现：实例配置表单及显式授权启用；受管 PTY 与原生交互登录终端；MCP resources/prompts；每轮原生 Studio MCP 注入与凭据绑定；按聊天隔离原生历史；实例创建聊天入口；图片上传/恢复、审批恢复；canonical 历史权限、用量与删除屏障；兼容配置续聊；SDK 聊天回执与完成请求回放隔离。

已推送安装版本：Qwen **0.25.0**、Codex **0.163.0**。历史某些全量联调使用 Qwen 0.24.7，不能混写为同一次验证。CLI 安装与账号认证分别处理，没有真实账号登录或付费提供商验收。

冻结 `ead6a4c3f` 已完成：

- 构建、类型、harness/公共 API 文档通过。
- coverage **940 文件 / 9,802 项通过**，12 文件 / 33 项按原条件跳过；Node 24.22.1、2 workers、默认时限，430.88 秒；三个实际 Electron 探针均执行。
- 完整生产浏览器 **967 项通过**，4 workers、无重试，10.5 分钟。
- 原有实际 CLI：28 轮聊天、4 次原生压缩、91 次本地模型请求、10 次 Studio MCP 调用。
- 实际官方 npm 安装：两款 CLI 各 global/scoped，共 4 次安装与版本探针、14 轮聊天、4 次压缩、56 次本地模型请求、10 次 Studio MCP 调用。
- 日志：`/tmp/studio-managed-cli-qa-{build,harness,coverage,browser,native,install}.log`；coverage 报告目录 `/tmp/studio-managed-cli-qa-coverage`。

PR 正文已更新上述冻结结果，临时正文文件 `/tmp/studio-plugin-pr-3513-body.md`。

## 3. 当前未提交改动：先收尾这批

### Kimi 独立插件

目录 `plugins/kimi/`：公共 SDK/驱动依赖，插件 ID `studio.agent-kimi`，Agent 类型 `kimi`。包含：

- 固定 `@moonshot-ai/kimi-code@2.1.1` 的显式安装计划、版本检查、原生 `kimi login` 终端准备、ACP 元数据检查。
- global/scoped ACP 运行、恢复、审批、图片、动态原生命令和 Studio MCP。
- Kimi 自有配置/MCP/AGENTS.md 与多来源 Skills 位置声明。
- scoped 使用 `KIMI_MODEL_*` 内存覆盖，临时 token 不写进 TOML；Windows Git Bash 检查、拒绝 WSL、取消和五秒版本探针期限。
- 已加入实际构建清单及显式启用目录；**还没有默认安装全部 14 个插件**。

已修复真实联调发现的问题：`KIMI_MODEL_NAME` 合成临时内存模型，ACP 的 `session/set_config_option` 模型选择器却只接受 TOML alias。Kimi scoped 及相同临时 env 模型不再重复发持久模型选择；普通 global 原生 alias 仍正常选择。保留专门回归，不要删除此区别。

### 共享 ACP 与本地包依赖

- 新增 `packages/studio-agent-drivers/src/acp/runtime.ts`、`commands.ts`；Qwen 改用共享 ACP 生命周期/命令目录。Qwen 特有压缩错误解释仍在 Qwen 插件内，没有把厂商分支搬入宿主。
- ACP 原生错误新增可选 `method` 诊断字段，不暴露请求参数。
- root 新增 SDK/driver 两个 npm workspaces；driver 显式依赖 SDK 0.1.0；package-lock 已更新，已离线安装两个本地链接。
- Vitest、server build、实际 CLI 验证使用本地 SDK source alias，避免加载源码和 dist 两份 SDK 错误类。
- **最后补改了 `typecheck:plugins`：先构建 SDK，再检查 driver。** 原命令只对 SDK `--noEmit`，干净安装没有 SDK dist 时 driver 的公开包类型无法解析。SDK dist 曾移出做干净检查，已重新生成；交接补查见下方。
- `scripts/verify-agent-plugin-native.mjs` 新增 `STUDIO_AGENT_VENDORS=kimi`、`STUDIO_NATIVE_DIAGNOSTICS=1`；默认仍验证 Qwen/Codex。支持仅本地 fixture 的 `STUDIO_NATIVE_KEEP_FIXTURE=1` 诊断。

### 当前验证及下一步

- 7 文件 **77 项专项通过**：Kimi、Windows 环境检查、Qwen、ACP、受管进程、边界及随包目录；日志 `/tmp/studio-kimi-focused-resumed.log`。
- 生产构建通过：`/tmp/studio-kimi-build-resumed.log`。**该次构建早于最后的 typecheck 脚本修正**，提交前重新验证最终状态。
- 最新类型补查已通过（退出码 0，SDK 声明文件存在）：`/tmp/studio-kimi-clean-typecheck-handoff.log`；上一干净检查日志 `/tmp/studio-kimi-clean-typecheck.log`。
- 实际 Kimi 2.1.1：**14 轮聊天、19 次本地模型请求、5 次 Studio MCP 调用通过**；global/scoped、图片、指令和 Skills、配置变更、协调器重启、提供方重新激活、协议转换和直通/转换跨轮切换均跑过。日志 `/tmp/studio-kimi-real-cli-v2.log`。没有真实账号认证。
- Kimi 仍未提交，未做它的冻结全量回归。前面的 9,802/967 是已推送安装提交的数据，**不能冒充 Kimi 的全量结果**。

立即接续顺序：

1. 检查 `git diff` 和 Kimi 新文件；重新跑最终 build/harness 与必要专项，确认最后的脚本修正。
2. 验证 SDK/driver 的 npm tarball 在仓库外安装和加载；这项尚未执行。新 workspaces 属于开发元数据，审查 `scripts/pack-npm-releases.mjs` 是否需要在发布主应用包时移除无对应目录的 workspaces 字段；不要直接执行 npm publish。
3. 如新增打包逻辑，扩充现有 `tests/server/dual-npm-packages.test.ts` 的实际工件断言。独立发布 SDK/driver 的脚本尚未构建。
4. 补 Kimi 管理页/目录的生产浏览器验收、必要边界与 native 命令测试；不要只凭注册成功关闭完整迁移。
5. 记录实施文档、提交并推送原草稿 PR；然后对冻结提交做全量回归并更新 PR。
6. 继续下面全部剩余范围。

## 4. 七大剩余交付范围

| 范围 | 必须继续完成 |
| --- | --- |
| 统一运行 | 受管实例单聊已有新链路；旧单聊/历史接管、群聊、工作流、全局任务仍需完整统一协调器；父子 Run、共享取消/预算/计量归属、唯一写入与完成屏障 |
| SDK 与宿主 | 按契约补齐完整 ctx、其余原生协议、完整事件/诊断/限额与故障验收；已完成的 PTY、MCP resources/prompts、Studio MCP 不应再写成待开发 |
| Web/Desktop/App 管理 | App 新聊天/命令/管理协议；动态 Agent 目录替代旧固定枚举；真实登录授权、登出与凭据过期处理、完整原生管理矩阵；既有 Skills 导入删除已完成，继续验证各 Agent 原生兼容 |
| 14 个 Coding Agent | Qwen/Codex 尚需完整功能矩阵和真实服务验收；Kimi 本地收尾；另外 11 个独立插件化，逐项运行/管理/原生命令/恢复/用量/聊天验收 |
| Hermes/Ekko | 保留 builtin 身份接入同一 Agent 契约及协调器；兼容原历史、后台任务和原生管理；去除重复写入，插件宿主故障不影响内置引擎 |
| 安装升级与分发 | 全部 14 个系统插件工件随包默认安装与不可卸载；版本锁定、排空升级、迁移/回滚、历史保留；Desktop/npm/Docker 工件与 SDK/driver 发布准备；私有 CLI 旧版本清理/回滚仍未实现 |
| 最终验收与清理 | 跨工作区/模式/版本历史迁移；真实账号与远程服务、真实数据副本恢复、跨平台性能；图片工件回收、Skill 整目录删除的主机故障恢复；达到功能对等后删除旧厂商分支和重复链路 |

另外 11 个：**codebuddy、qoder、copilot、zcode、antigravity、claude-code、pi、grok、opencode、dsh、cursor**。

这些实现已有旧厂商代码和原测试，入口清单见 `packages/server/src/modules/coding-agents/services/registry/definitions.ts` 与 `native-agents.ts`。优先抽公共协议/进程工具，厂商业务保留在各独立包；禁止新建按厂商 ID 分支的万能运行器，禁止独立包导入 server/client 私有源码。不能为凑 14/14 只交付空 manifest 或类型定义。

## 5. 验证环境和注意事项

- 读仓库 `AGENTS.md`、`DEVELOPMENT.md`、`ARCHITECTURE.md` 和 harness/review 规则。保持薄 controller、领域服务边界、12 种语言及主题/移动端适配。
- Node 24.22.1：`/tmp/node-v24.22.1-darwin-arm64/bin/node`。
- 构建/测试子进程移除 `HERMES_*`、`EKKO_*`、`ELECTRON_*`、`AUTH_TOKEN`、`PORT`、`NODE_OPTIONS`；独立包验证也移除 `NODE_PATH`。设置 `NODE_ENV=test`。
- PATH 首位 Node 24.22.1，随后 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`，保留 Homebrew ffmpeg。实际全局 CLI 联调另外加入 `/Users/ekko/.nvm/versions/node/v24.16.0/bin`。
- 全量 `npm run test:coverage -- --maxWorkers=2`，保持默认时限；不要通过加超时、删断言、跳过失败来做绿。
- 完整 Electron 探针须在清理环境后显式设置 `EKKO_TEST_ELECTRON_EXECUTABLE=/Users/ekko/Desktop/git/hermes-studio/studio/packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`。
- 全量 QA clone：`/Users/ekko/.cache/studio-plugin-chat-foundation-qa`，目前冻结在 `ead6a4c3f`。**它原来共享 root node_modules；新增 workspaces 后下次冻结验收应使用自身 npm ci/正确指向 QA 源码的 workspace 链接，避免裸包解析到主工作区。** 不要在测试进行中切换其 checkout。
- 浏览器 root 使用 `PLAYWRIGHT_PORT=4173`，QA 使用 4183；并发构建服务不能共用端口及客户端缓存目录。
- CLI 联调用生产插件、临时 Home 和本地模型服务；不读取真实用户账号，不将本地模拟推理当作远程提供商验收。
- Studio 交互工具在前一轮曾 Unauthorized，最新轮已恢复。新窗口先读取自己的 session tasks，并使用**新输入提供的 context_id**；不要复用旧 context/session 或 exec session ID。
- 完整用户目标保持 open。用户已授权自主决定普通实现问题；无需反复询问是否继续。PR 保持草稿，准确报告未提交代码、条件跳过和未验收范围。

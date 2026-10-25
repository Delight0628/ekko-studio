# Studio 插件迁移交接

更新：2026-10-25。用户授权继续自主推进全部迁移；本文件记录实际进展，不表示总目标完成。

## 当前状态

- 仓库 `/Users/ekko/Desktop/git/hermes-studio/studio`，分支 `feat/studio-plugin-context`。
- PR #3513 保持草稿：<https://github.com/EKKOLearnAI/ekko-studio/pull/3513>。不合并，不自动转 ready。
- 本轮提交：`15a6371a1` Kimi/共享 ACP/独立公共包；`d45ce0454` 干净 worker fixture 的 SDK 别名修复；`198d198ca` Qoder；`900e7aa22` Chat Completions 网关；`01114c99f` CodeBuddy；`68fa9cc1b` 主题浏览器用例等待页面就绪。Copilot 实现和证据随本文件所在提交一并交付；以当前 `git log`/`git status` 核对最新 HEAD 和后续工作区。
- 原工作区 Kimi、共享 ACP、依赖构建改动全部保留并提交。不能 reset/clean 后续未提交工作。
- 已有 **6 个独立插件实现**：Qwen、Codex、Kimi、Qoder、CodeBuddy、Copilot；完整迁移验收仍为 **0/14**。实现数量不代表完整验收。
- 需求真源：`studio-plugin-architecture.md`、`studio-plugin-contracts.md`、`studio-plugin-execution.md`。实际证据：`studio-plugin-progress.md`。

## 已验证的增量

### Kimi 与公共包

Kimi 固定 CLI 2.1.1，global/scoped、图片、审批、恢复、原生命令和 Studio MCP 已有真实联调。临时 `KIMI_MODEL_NAME` 模型不调用只接受 TOML alias 的持久模型选择器；普通 native alias 保留选择行为。

SDK/driver 为两个 npm workspaces，driver 显式依赖 SDK 0.1.0。类型检查先生成 SDK 声明；宿主/测试构建使用源码别名，避免错误类出现两份。`pack:plugins` 构建独立 SDK/driver tarball，`verify:plugins:packages` 在仓库外实际安装、严格 TypeScript 编译及加载。主应用 tarball 去掉不随包发布的 workspace 元数据。没有执行 npm publish。

最初遗漏了 `studio-plugin-processes.test.ts` 中两处直接 esbuild 调用的 SDK alias，三平台 CI 发现后已修复；移开 SDK dist 后该文件 16 项通过。`900e7aa22` 的三平台 Coding agent platforms 与 Build 已通过；其余 CI 当时仍运行，不能沿用旧 HEAD 的 13 项通过声明。

冻结 `15a6371a1` 的独立 QA 回归：自己的 npm ci/PTY rebuild/生产 build，coverage **942 文件 / 9,821 项通过**，12 文件 / 33 项按原条件跳过，2 workers、默认时限，469.15 秒；生产浏览器 **968 项通过**，4 workers、无重试，10.8 分钟。日志 `/tmp/studio-kimi-qa-{install,rebuild,build,coverage,browser}.log`，报告 `/tmp/studio-kimi-qa-coverage`。

### Qoder

固定 CLI 1.1.78，保留 global-only 与 Windows ARM64 限制。真实受管 CLI 版本/ACP metadata/登录计划/资源检查通过；inspect 仅发送 initialize，不创建原生会话，不推断已登录。真实 worker fixture 验证运行、resume、命令、审批、取消、崩溃和撤权。管理页生产浏览器通过；真实账号/远程推理未验收。重现：`STUDIO_QODER_COMMAND=/absolute/path/to/qodercli.js npm run verify:plugins:qoder`。

### Chat Completions 与 CodeBuddy

公共网关新增 Chat Completions 原生直通和到 Responses/Anthropic 的转换，三种协议六个转换方向齐全；Run 鉴权/取消/计量归属不变。Chat 的 finish_reason、迟到 usage 和 `[DONE]` 一起等待计量提交；缺失计量保持 unknown，截断失败。网关/适配专项 68 项通过，连同三个 ACP 插件共 108 项通过，包外消费验证通过。

CodeBuddy 固定 CLI 2.175.0；原生 ACP 服务保留 watcher，使用通用 `managed-stop` 策略确认关闭。真实 fixture 通过 ToolSearch/DeferExecuteTool 发现并调用延迟 MCP。最终真实 CLI **14 轮聊天、47 次本地模型请求、5 次 Studio MCP 请求通过**，含 global/scoped、图片、Skills/指令、配置、恢复、协调器/提供方重启、两种转换及跨轮切换。日志 `/tmp/studio-codebuddy-real-native-final.log`。

CodeBuddy 最终构建/harness/类型/公共包外消费验证通过；服务端专项 55 项及协议/进程专项 105 项通过；管理页生产浏览器 11 项通过。三平台 CI 新增 Kimi、Qoder、CodeBuddy 的 worker 和环境专项。日志 `/tmp/studio-codebuddy-{focused,final-focused,browser,final-build,final-harness,types,packages}.log`。本地模型 fixture 不等于真实账号或远程付费服务。

### Copilot

固定 CLI 1.0.91；标准 ACP 加插件自己的原生配置/Windows PowerShell 检查。Claude scoped 用 Anthropic canonical ID，其他模型用 Chat Completions；Anthropic 基址去除末尾 `/v1`，真实 CLI 已验证路径为租约下 `/v1/messages`。临时模型 token 不写文件。原生 MCP 采用 `--additional-mcp-config @file`，按 runtime 租约生成、进程清理后删除。global 获得宿主辅助目录但不覆盖原生账号 Home。

inspect 使用 ACP metadata 和 Content-Length JSON-RPC SDK `auth.getStatus`/`models.list`；未认证模型目录是 `authentication_required`，不创建会话或 Run，丢弃账号标识及私有字段。公共 transport 新增有界 framing，默认 JSONL 不变。

最终真实 CLI 14 轮、19 次本地模型请求、5 次 Studio MCP 通过，含 global/scoped、图片/资源、重启恢复、三种协议及跨轮切换；OpenAI 与 Claude 两种模型选择各有通过证据。服务端专项 95 项、其他插件/上下文/目录/网关专项 120 项、生产管理浏览器 12 项通过；完整构建、harness 和包外 SDK/driver 验证通过。日志 `/tmp/studio-copilot-{final-focused,regressions,browser,final-build,final-harness,packages,real-final}.log`。未验收真实账号。

### 最新冻结回归

`01114c99f` 独立 QA build/coverage 通过：944 文件 / 9,853 项，12 文件 / 33 项条件跳过，2 workers、默认时限，413.00 秒。生产浏览器首轮 969 通过 / 1 失败；主题编辑器已有 inert，测试 fill 绕过加载锁定，`68fa9cc1b` 修复测试等待，原断言/期限未改、产品源码未改。专项 light/dark 通过；冻结 `68fa9cc1b` 完整重跑为 968 通过/2 失败，11.1 分钟；APNG/版本预览两项单独复测通过，两轮全量均不记为全绿。日志 `/tmp/studio-five-plugins-qa-browser-v2.log`；不要把首轮记为全绿。

页面就绪修复：APNG 测试等待现有 inert 锁；版本预览刷新等待状态/标签两请求 settle 后再解除初始化，并报告错误。新增延迟请求单测与 PageLoading 共 6 项、原失败浏览器 2 项、相关完整浏览器文件 42 项、client 类型/harness 通过。Copilot 的 macOS/Linux native CI 通过，Windows 既有 Codex 审批等待在默认 vi.waitFor 阶段出现一次 starting/等待状态不符；未修改期限或预热测试，继续跟踪下一提交。

## 继续顺序

1. 核对 Copilot 提交/推送及 CI；收尾冻结 `68fa9cc1b` 的完整浏览器，再对下一冻结提交做验证，更新原草稿 PR。QA 副本使用自己的 node_modules；不要在测试中切 checkout。
2. 迁移余下 8 个独立插件：**zcode、antigravity、claude-code、pi、grok、opencode、dsh、cursor**。保留已有能力和真实管理语义；协议/进程代码可抽公共驱动，厂商配置保留在各插件。禁止插件导入 server/client 私有源码，禁止宿主万能厂商 runner。OpenCode 1.19.4 已开始临时安装/原生 ACP 调研，尚未实现，目录 `/tmp/studio-opencode-native-qa`。
3. 统一旧单聊/历史接管、群聊、工作流、全局任务及 API 的运行协调器；父子 Run、共享取消/预算、计量归属、唯一写入和完成屏障。
4. 补齐 SDK 完整 ctx、事件/限额/诊断，Web/Desktop/App 动态目录和管理/聊天协议。已有 PTY、MCP resources/prompts、Studio MCP、Skills 包导入删除不应再列为待开发。
5. Hermes/Ekko 保持 builtin 身份接入相同 Agent 契约；插件宿主故障不能影响内置引擎，避免重复写入。
6. 全部 14 个系统插件随包默认安装且不可卸载；版本锁定、排空升级、迁移/回滚、历史保留、Desktop/npm/Docker 和 SDK/driver 分发准备。私有 CLI 旧版本清理/回滚仍未实现。
7. 真实数据副本迁移、真实账号/远程服务、跨平台恢复与性能，图片/Skill 删除故障恢复；功能对等后清理旧链路。

完整迁移每项只按真实交付证据关闭。单项 fixture、目录注册或独立包数量不能替代最终验收。

## 验证环境

- Node 24.22.1：`/tmp/node-v24.22.1-darwin-arm64/bin/node`。
- 构建/测试清理 HERMES_、EKKO_、ELECTRON_、AUTH_TOKEN、PORT、NODE_OPTIONS；外部包验证另清理 NODE_PATH；NODE_ENV=test。
- PATH 首位 Node 24.22.1，再 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`，保留 Homebrew ffmpeg。
- 当前辅助运行器 `/tmp/studio-plugin-run-clean.py` 接收日志路径和命令；全量 `npm run test:coverage -- --maxWorkers=2` 保持默认时限，不加超时/删断言/跳过失败。
- 完整 Electron 探针在清理环境后设置 `EKKO_TEST_ELECTRON_EXECUTABLE=/Users/ekko/Desktop/git/hermes-studio/studio/packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`；辅助运行器使用 `STUDIO_QA_ELECTRON=1`。
- QA：`/Users/ekko/.cache/studio-plugin-chat-foundation-qa`，自身 npm ci 已完成；禁止重新共享主工作区 node_modules 或跨工作区的 SDK 链接。浏览器 root 4173、QA 4183，独立客户端缓存。
- 实际 CLI 路径：Kimi `/Users/ekko/.nvm/versions/node/v24.16.0/bin/kimi`；Qoder `/tmp/studio-qoder-native-qa/node_modules/@qoder-ai/qodercli/bundle/qodercli.js`；CodeBuddy `/tmp/studio-codebuddy-native-qa/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy`；Copilot `/Users/ekko/.nvm/versions/node/v24.16.0/bin/copilot`。均用临时 Home 和本地模型，不读真实用户账号。
- 原已推送 `ead6a4c3f` 的 9,802/967 只是旧冻结结果；不能冒充本轮或后续提交结果。
- 每轮读取自己的 session tasks，使用最新输入的 context_id，不复用旧 context/session。完整用户目标保持 open，PR 保持 draft。
- 长轮次中 interaction 同步曾返回 Unauthorized，默认、default、tester 均未恢复；没有复制 token 或绕过认证。已有 durable goal 保持 open；后续恢复后按实际证据更新，期间以本文件保存进度。

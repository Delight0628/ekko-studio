# #3506 Windows 手工验收

## 适用版本与安全边界
必须运行本仓库 pr/3506 加本地补丁的服务端和前端，不能在已安装的旧版 Studio 上宣称本补丁通过。
不要切换其他分支覆盖未提交改动；始终使用当前唯一仓库，不新建 clone/worktree。
本地测试 MCP 不访问网络、不读写文件、不收集秘密；测试使用新建验收会话，不使用真实 OAuth、Cookie、生产权限或机密。

## 1. 准备
在仓库根目录用 PowerShell 运行：

```powershell
npm.cmd ci --ignore-scripts --include=dev
$env:NODE_ENV='test'
npm.cmd run test -- tests/server/codex-app-server-turn.test.ts tests/server/codex-app-server-process.test.ts tests/server/coding-agent-run-manager-windows.test.ts tests/server/native-agent-usage.test.ts tests/client/global-pending-actions.test.ts tests/server/codex-mcp-namespace.test.ts tests/server/native-scoped-proxy.test.ts tests/server/codex-interaction-fixture.test.ts
npm.cmd run harness:check
Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
npm.cmd run build
```

Desktop 托管终端先在测试子进程清除继承的 HERMES_*、EKKO_*、ELECTRON_*、AUTH_TOKEN、PORT；不要改变运行中的应用。构建不应使用 NODE_ENV=test；构建前移除该变量。
完整检出是构建和 harness 的前提，若出现缺失文件先检查 sparse checkout，不能算代码测试失败。

## 2. 运行修复版，不干扰现用服务
可使用源码版 Studio Web UI 验收此服务端/前端交互；此问题本身不要求重新打包 Electron。
先完成 npm run build，在一个新 PowerShell 窗口中设置独立应用数据目录和未占用端口，然后运行：

```powershell
# 先清理本窗口继承的应用变量，避免连接现有数据目录/端口
Get-ChildItem Env: | Where-Object { $_.Name -match '^(HERMES_|EKKO_|ELECTRON_)' -or $_.Name -in @('AUTH_TOKEN','PORT') } | ForEach-Object { Remove-Item -LiteralPath ('Env:'+$_.Name) }
$env:HERMES_WEB_UI_HOME = Join-Path $PWD '.acceptance/3506/ui-state'
$env:HERMES_WEBUI_STATE_DIR = $env:HERMES_WEB_UI_HOME
$env:PORT = '18647'
$env:BIND_HOST = '127.0.0.1'
$env:NODE_ENV = 'production'
node dist/server/index.js
```

确认日志监听 18647，浏览器访问 http://127.0.0.1:18647，按首次启动流程配置测试 provider。不要把旧服务 URL 当作新实例。
如果这里启动失败，不要直接切换到旧版验收：保留启动日志，先解决缺失依赖/配置。
Codex provider 使用与实际使用相同的 Chat Completions 配置，以覆盖本次 namespace 修复；凭据只在应用设置中输入，不放进测试 fixture。

## 3. 配置合成 MCP
在该测试实例的 Codex MCP 配置界面添加 stdio 服务 acceptance3506：
- command：node.exe 的绝对路径（PowerShell 执行 `(Get-Command node.exe).Source` 查询）。
- args：仅一个参数，当前仓库 `tests/fixtures/codex-interaction/server.mjs` 的绝对路径。
- 不添加 shell 包装、网络地址、额外权限或秘密环境变量。

标准 MCP JSON（替换路径，JSON 中 Windows 路径建议使用正斜杠）：

```json
{
  "mcpServers": {
    "acceptance3506": {
      "command": "C:/nvm4w/nodejs/node.exe",
      "args": ["C:/Users/wtj/.hermes-web-ui/coding-agent/workspace/default/custom_apimes/ekko-studio/tests/fixtures/codex-interaction/server.mjs"]
    }
  }
}
```

若界面只接收单服务配置，填写 command/args 的内层对象，不要贴 mcpServers 外壳。配置测试应列出 acceptance_form、acceptance_url、acceptance_unsupported 三个工具。新建 Codex 验收会话以加载配置。

## 4. 正常表单（必须通过）
对模型发送：

> 调用 acceptance3506 的 acceptance_form 工具一次。这是本地合成验收，不用其他工具。请等待我在 Studio 界面完成确认和表单，再原样返回工具结果。

可能先出现“Allow ... MCP server to run tool”执行前确认：schema 是空对象时提交 `{}`（不得自动批量批准其他请求）。
然后业务表单要求 label 和 count。提交：

```json
{"label":"WIN11_OK","count":7}
```

通过标准：请求在工具真正返回前出现；答复后工具返回 action=accept 和完全相同 content；模型继续回复；待处理提示消失；回合结束且不会重复输出。不得出现 -32601 Unsupported Codex client method 或 unsupported call: acceptance_form。

## 5. 必测负例
| 场景 | 操作 | 通过标准 |
|---|---|---|
| 错误 JSON/字段类型 | 表单先提交无效 JSON，或 count="7"，或缺 label | 不得返回 accept，错误后可更正或取消，不得卡死 |
| 取消表单 | 新回合调用 acceptance_form，业务表单用取消/拒绝入口（协议为空答复） | 工具收到 cancel，提示移除，不默认为接受；若 UI 无取消入口则验收不通过 |
| URL 拒绝 | 调用 acceptance_url，选择 deny | 仅 once/deny，无 session/always；URL 不自动打开；工具收到 decline |
| 不支持 schema | 调用 acceptance_unsupported，尝试提交嵌套对象 | 不得接受；允许取消，不得静默丢弃约束后接受 |
| 停止清理 | 等业务表单出现后停止会话 | 提示清理，不能再答复旧请求，进程不长期驻留 |
| 跨会话 | A 出提示，切到 B 聊天 | 全局提示标明所属会话，回复只作用于 A，不能错发 B |
| 重复提交 | 对一个提示重复点击提交 | 原生请求只完成一次，不产生双份结果 |
| 超时 | 保持请求超过 5 分钟 | 拒绝/取消并移除提示，不自动批准 |
| 连续请求 | 同一会话再调用一次 form | 新提示能正常完成，旧提示不能复用 |

同一回合多个请求和审批混合并发也需验证：不能覆盖第一个提示导致 RPC 永久等待；当前实现可对额外不支持的并发请求 fail closed，而不是隐式同意。

## 6. 仍需专门验证的原生交互
requestUserInput 和 item/permissions/requestApproval 不是 MCP 工具；本 fixture 不伪称能产生它们。
使用支持这些功能的真实 Codex 工作流验证：单题/多题匹配、秘密问题不采集、权限只授予原请求且 scope=turn，取消/过期不授权。现有协议单测只能证明桥接逻辑，不替代 UI 实测。
URL fixture 只验证拒绝，不代表真实 OAuth 登录通过；真实 OAuth 必须由用户自行完成后明确接受。

## 7. 合并条件
- 本地修复提交并推送到 #3506 后，验证的是确切的新提交 SHA，而不是旧 head。
- 上述必测项都有实际截图或日志和预期结果。
- 构建、harness、针对性回归及新提交对应 CI 通过，完成审查后再解除 Draft。
- 本指南编写/自动测试通过不代表人工验收已经执行。不得只凭模型最后说“成功”判定通过。




## Windows 数据目录长度注意事项
本机最终验收使用真实短数据目录 C:/ekko-pr3506-state/desktop-state 和 C:/ekko-pr3506-state/hermes-home。仓库仍在原位置，仅测试数据副本在此目录。
不要只用 SUBST 缩短 Codex 数据目录：Codex 恢复历史时会解析回真实长路径，SQLite WAL 打开仍可能失败。
本地启动脚本 .acceptance/3506/start-desktop.ps1 已指向短数据目录；原长目录数据保留作备份。
测试旧会话时必须确认没有创建新的 native thread：同一 Studio 会话重启后继续询问此前 label/count，核对正确答复及 run.completed。

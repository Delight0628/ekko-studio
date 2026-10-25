# 剩余 Agent 插件并行迁移

用户在 2026-10-25 要求每个剩余 Agent 由一个专属子 agent 实施。主线程负责共享 SDK/driver、构建与随包注册、UI/CI、集成验证和提交。并发额度为主线程加三个子 agent，按空闲槽位滚动启动；不把排队任务记为已启动。

| Agent | 专属子 agent | 当前交付状态 |
| --- | --- | --- |
| Pi | `/root/pi` | 本批插件实现和 28 项 worker、真实 compact/Skill/私有 CLI 安装已交付；主线程集成中 |
| Claude Code | `/root/claude_code` | 原生双向 stream-json 协议、固定版本工件和独立实现验证中 |
| DSH | `/root/dsh` | 原生 Web profile/ACP 组合、资源和扩展语义迁移中 |
| ZCode | 待空闲槽位后启动专属 agent | 排队 |
| Antigravity | `/root/antigravity` | 原生 stream-json、隔离配置、Gemini→Responses 桥及图片适配验证中 |
| Grok | 待空闲槽位后启动专属 agent | 排队 |
| Cursor | 待空闲槽位后启动专属 agent | 排队 |

子 agent 独占各自 `plugins/<agent>/`、专属 worker 测试、fixture/验证脚本及证据文件；共享文件由主线程修改，避免覆盖。子 agent 不提交、不推送、不调用 Studio 会话或交互工具，也不继续转派。

每项交付必须包含原生能力清单、global/scoped 配置与账号边界、成功/失败/取消和恢复、图片/MCP/Skills/命令的实际支持、管理/资源语义以及验证日志。插件只使用公共 SDK/driver，不调用旧宿主厂商 runner。模拟 worker、本地模型、真实 CLI 和真实账号验收分别记录；已有独立包和通过测试不能替代完整迁移验收，当前仍为 **0/14**。

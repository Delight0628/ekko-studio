# Qwen Code runtime increment

The bundled `studio.agent-qwen` package registers the reserved `qwen` Agent type
through the public SDK. Build it with `node scripts/build-agent-plugins.mjs` from
the repository root; the independently loadable artifact is `dist/plugins/qwen-code`.
The bundle includes the SDK and ACP driver and does not import server code.

This increment supports global-mode text turns, streamed text/reasoning/tools,
host-mediated approvals, native session restoration, cancellation and confirmed
process cleanup. Configuration requires an absolute `cwd`; optional `command`,
`args`, `env`, `model`, `reasoningEffort`, `systemPrompt` and explicit `mcpServers`
configure the native CLI. `--acp` is appended to the configured launch arguments.
Credentials are not inferred from the Studio profile. Native Qwen authentication
continues to use the CLI's configured home, including an explicitly supplied
`QWEN_HOME`. No CLI is downloaded or login performed by activation.

`management.inspect` starts a short-lived ACP connection and performs only the
v1 initialize handshake. It returns native name/version and authentication method
labels, omitting private extension fields. Current authentication remains `unknown`;
model discovery is `unsupported` without creating a session. Inspection creates
no chat history and does not authenticate or change configuration.

The artifact is not installed automatically and does not replace the existing
chat path. Scoped provider configuration, host MCP/Skills injection, image artifact
resolution, native management/login integration, usage reconciliation and real CLI
acceptance remain required before complete migration. Missing usage stays unknown.
Fixture subprocess tests do not establish compatibility with an installed vendor CLI.

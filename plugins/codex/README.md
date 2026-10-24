# Codex app-server runtime increment

`studio.agent-codex` registers the reserved `codex` type through the public SDK.
The independent bundle uses the native stdio app-server protocol, with a process
owned by the Studio runtime lease. It initializes once, starts/resumes the exact
native thread, and filters all output and approval requests by thread and turn.
Text snapshots replace streamed text; tool completion is deduplicated. Cancellation
requests native interruption and waits for confirmed process cleanup. The public
configuration schema preserves native defaults unless a setting is supplied.

This increment supports global text execution, command/file approvals, native
thread restoration and persistent turns. It is not automatically installed and
does not replace legacy chat or management. Scoped provider setup, login/configuration
management, images, clarification/MCP elicitation, compaction, native usage ledger
reconciliation and the full real CLI acceptance matrix remain incomplete. Native
cumulative counters are not represented as fabricated per-call usage records.

Protocol reference: [official app-server documentation](https://learn.chatgpt.com/docs/app-server).
The initial schema was also checked against locally generated Codex 0.163.0 types.

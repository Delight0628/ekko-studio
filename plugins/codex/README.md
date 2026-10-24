# Codex app-server runtime increment

`studio.agent-codex` registers the reserved `codex` type through the public SDK.
The independent bundle uses the native stdio app-server protocol, with a process
owned by the Studio runtime lease. It initializes once, starts/resumes the exact
native thread, and filters all output and approval requests by thread and turn.
Text snapshots replace streamed text; tool completion is deduplicated. Cancellation
requests native interruption and waits for confirmed process cleanup. The public
configuration schema preserves native defaults unless a setting is supplied.

This increment supports global text execution, command/file approvals, multi-question
native clarification, thread restoration and persistent turns. Choices retain their
descriptions; only questions that allow other answers accept free text. Native
request resolution withdraws unanswered Studio interactions and suppresses late
replies. Cancellation never invents an answer. Secret questions are rejected before
any prompt is persisted, pending a dedicated credential interaction channel.
It is not automatically installed and
does not replace legacy chat or management. Scoped provider setup, login/configuration
management, images, MCP elicitation, compaction, native usage ledger
reconciliation and the full real CLI acceptance matrix remain incomplete. Native
cumulative counters are not represented as fabricated per-call usage records.

Protocol reference: [official app-server documentation](https://learn.chatgpt.com/docs/app-server).
The initial schema was also checked against locally generated Codex 0.163.0 types.

The optional `management.inspect` adapter uses a separate short-lived app-server
to read account state without refreshing credentials and enumerate native models
with bounded pagination. It returns no email, account identifier, native home,
configuration or token. Inspection does not start a thread or prompt, log in,
or mutate configuration. Host cancellation/grant revocation reaps its resources.

`npm run verify:plugins:native` builds both native plugin artifacts and runs two
real CLI turns against local model fixtures in temporary homes. Set
`STUDIO_CODEX_COMMAND` and `STUDIO_QWEN_COMMAND` when the installed CLIs are not on
PATH. This verifies native inspection, text streaming and session reuse without account login
or remote model calls; it does not cover the complete vendor acceptance matrix.

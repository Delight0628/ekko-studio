# Codex command approvals

Studio chat turns use `codex app-server --stdio` and JSON-RPC instead of
`codex exec --json`. The latter closes stdin after the prompt and cannot
receive a later user decision.

Threads start or resume with `approvalPolicy: "on-request"` and
`approvalsReviewer: "user"`. The filesystem sandbox remains
`danger-full-access`, matching the previous chat runtime. This does not
automatically approve commands: Codex's built-in dangerous-command classifier
can still request approval. In Codex 0.163.0, `approval_policy = "never"`
rejects those commands before creating the shell process, even with the
sandbox disabled.

The adapter translates `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval` into Studio's existing `approval.requested`
event. Only the owning Studio session can resolve the generated approval ID:

| Studio decision | Codex response |
| --- | --- |
| `once` | `accept` |
| `deny` | `decline` |
| Any other choice | Rejected without resolving the request |

No session-wide approval or exec-policy amendment is submitted. The adapter
tracks JSON-RPC request IDs separately from item IDs because one item can
have several independent approval callbacks. Requests for other threads or
turns are declined. Requests arriving before the `turn/start` response are
queued until their turn ID can be checked.

After five minutes, an unanswered request is declined and the pending
interaction is removed. Turn completion, process failure and session
cancellation also clear pending approvals. Unknown server-to-client request
methods return a JSON-RPC error rather than receiving an implicit grant.

Model selection, managed prompt files, native thread IDs and provider
configuration continue to use the existing launch configuration. Prompt text
and image paths travel over JSON-RPC stdin. Historical turns returned by
`thread/resume` are not replayed into Studio.

A `turn/start` response only acknowledges dispatch. A turn succeeds after a
matching `turn/completed` notification with status `completed`, followed by
process close and existing native usage reconciliation. A premature process
close is a failure even with exit code zero. The adapter closes stdin at the
terminal notification and bounds process shutdown so a hanging MCP shutdown
cannot leave the foreground turn active indefinitely.

Validation must include protocol correlation, cross-session rejection,
single-use decisions, timeout and cancellation, UTF-8 streaming, images,
native resume, Windows npm shims, and the existing approval UI. Protocol
fixtures do not establish live model/provider compatibility; use an isolated
profile and disposable files for deployment acceptance.

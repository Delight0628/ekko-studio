# Session task list and chat turn navigation

- Scope: responsive Studio Web UI and Desktop, with a companion native App list.
- Extends: `2026-10-22-session-task-summaries.md`.

The task entry in the shared navigation opens `/hermes/tasks`. This route uses a
minimal layout with no navigation rail, contextual sidebar, page heading, count
cards or banner. Search, status filtering and update-time sorting live in the
list header, alongside a compact return control. On narrow screens, the session moves below the task and the update
time below its status. Search and pagination stay in the URL when opening chat
and returning with browser Back. The page refreshes on visibility/focus and every
30 seconds while visible; it does not create tasks or change their status.

`GET /api/studio/session-tasks` returns tasks, total and has_more. The controller
validates filters/pagination and resolves existing profiles permitted to the
account. SQL applies that scope and pending-deletion exclusions before counting
or paging. Run credentials remain profile-bound. The list includes archived
single-chat sessions; group/workflow/global-agent sessions are excluded.

Each row links to `/hermes/session/:id?profile=...&message=...`. An open task
uses its recorded request anchor; a completed task uses its completion anchor.
Hidden tool anchors are resolved to the preceding visible user message so the
link lands at the beginning of the associated turn. The persisted ledger still
has the original write-boundary semantics: recovered older tasks are anchored
to the request that recorded them, not retroactively inferred messages. There
is no invented history of per-task progress events.

ChatView carries the explicit message into the existing chat store selection.
The existing history pagination and virtual-list alignment load and highlight
old messages, including messages outside the normal live-chat history cap.
Direct links and reloads use the same flow. Sessions outside the sidebar page,
including archived sessions, are fetched through the existing authorized session
read and then resumed. Missing/deleted message targets fall back to the session
with a warning instead of claiming a successful highlight.

No database schema, model/MCP tools, task-plan lifecycle or group/workflow runtime
changes are introduced. The companion App uses the same list endpoint through its
authenticated relay and passes message_id into its existing matched-message
navigation. Task lists expose only the session goals already maintained by the
primary conversational model.

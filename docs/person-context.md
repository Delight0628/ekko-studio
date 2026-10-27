# Person context assembly

Person main chats use their own bounded history loader. Ordinary single chats,
Person worker sessions and the shared `sessions` / `messages` schemas retain
their existing behavior. The only shared run-path change skips the ordinary
history compressor for `person-main-*`; Person's adapter supplies history.
There is no fallback to the old Person substring scan or shared compression
snapshots.

## Storage and retrieval

`person_context_progress`, `person_context_chunks`, `person_context_search` and
`person_context_summaries` contain derived data. FTS maintenance triggers attach
only to the new chunk table. Original chat messages remain authoritative and
are not rewritten by indexing or summarization.

Each run captures the owned session's history revision and maximum message ID
before its new user message is saved. History is read through this boundary,
avoiding duplicate current input and inclusion of later messages. History edits
fence in-flight model requests, tools and cache writes. On the next read, changed
revisions discard derived data and rebuild it. Search hits are checked against
live originals before being returned, including after an out-of-band edit.

The loader interleaves recent dialogue and lexical search hits within 30% of
the configured context budget, capped at 3,000 estimated tokens. Evidence carries
its original role, message ID, timestamp, character offset and pagination cursor.
Chinese bigrams support text without spaces. Search pages contain at most six
chunks and recent reads at most eight messages. Explicit IDs and offsets allow
the model to read complete originals rather than treating excerpts as complete
documents. Search itself is paginated; a thirteenth result is not inaccessible.

Indexing processes at most 64 chunks per transaction. A background queue yields
between batches and resumes from persisted progress. Streaming records suspend
indexing instead of being skipped forever or busy-polled. Long text uses
overlapping 2,000-character chunks; offsets use SQLite Unicode characters.
Incomplete index coverage is reported explicitly. This mechanism also supports
rebuilding an index after months of new conversation; it is not a legacy-data
migration. FTS drives the search join to avoid scanning the session's entire
chunk index for each match.

## Budget and checkpoints

Every provider request includes message and tool-definition overhead in the
budget check, reserving output tokens and a safety margin. Provider-native
continuations are disabled for Person so hidden history cannot bypass assembly.
Runtime context events report the prepared provider request, not the discarded
history. Estimates remain estimates, not exact provider token counts.

When a long current turn needs compression, completed earlier tool groups are
summarized without splitting calls from results. The current user message and
latest complete tool group remain intact. A source hash, selected model and
history revision key each checkpoint; unchanged sources reuse it across runs.
Checkpoints are generated from originals, not recursively rewritten summaries.
Each session keeps at most 64 cached checkpoints. Summary model calls are
accounted separately. Cancellation or a history revision change rejects late
cache writes, and an oversized required current interaction fails explicitly.

Retrieved text and summaries are data, not new authorization. Existing task,
revision, ownership and approval checks remain authoritative. This implementation
does not derive executable permission decisions from model-produced status fields.

## Validation and limits

Focused tests cover owner isolation, shared-schema preservation, history edits,
streaming rows, long Unicode originals, chunk-boundary identifiers, pagination,
checkpoint reuse, cancellation, actual request estimates and budget rejection.
The scale case indexes 100,000 messages and checks bounded result sizes and old
evidence retrieval. Ordinary chat routing, compression and deletion tests assert
that their paths remain unchanged.

Search is lexical; the model can request synonyms through `bot_context_search`,
but this does not guarantee semantic recall or complete evidence for every
question. A local scale test is not a concurrency SLA or a months-long accuracy
evaluation. The earlier isolated experiments are separate from these production
integration tests and must not be reported as this implementation's accuracy.


## Account memory

Person uses Ekko Agent's `MemoryService`, `SqliteMemoryStore` and native structured
memory tools. Each Studio account has an independent database at
`<Web UI home>/person/<account id>/memory.db` and a stable `person:<account id>`
identity. Selecting a different model Profile does not select another memory
store. Ordinary Ekko chat continues to use its existing store and scopes.

The first model request automatically recalls memory within a 1,000-token card
budget. The overall Person request budget still includes system text, tool
schemas, retrieved history, memory, output and safety reserves. Name queries can
use the `profile_name` kind instead of guessing matching text. Person advertises
only the native writer's atomic batch schema, avoiding duplicate legacy fields.
The optional JEV enhancements remain disabled in this Person runtime; no Profile
JEV configuration or credentials are implicitly inherited.

Only the current host-provided user evidence is captured for memory writes.
Retrieved history and background callbacks cannot become fresh user evidence;
callback memory writes are rejected. Native revision checks, canonical keys,
account ownership and explicit forget intent apply. The memory panel lists
active cards and can delete an exact card at its current revision. New memories
and corrections are made in the Person conversation so the structured value,
content and source evidence are updated together.

The legacy `person_memories` table is dropped at database initialization. Its
contents are intentionally discarded; there is no migration or fallback reader.
Person's conversation/history index, tasks and ordinary chat data are retained.

Regression coverage includes the recorded `名字 称呼 姓名` search failure,
controlled-name lookup, automatic recall, evidence provenance, Profile changes,
account isolation, stale corrections/deletion, callback injection and the full
toolset under the minimum 8k request budget.

## Stopping a task

The task list and task conversation expose Stop task for queued, active and
waiting executions. The conversation's composer also shows Stop even with a
draft or before streaming begins. It uses the same task API, preserves the draft
and attachments, and disables Stop until acknowledgement. Person can use `bot_task_apply` with `action: stop`, the
current `task_id`, `execution_id`, `expected_revision` and an idempotency key.
Query first: targeting an execution prevents an old click or replay from stopping
a later scheduled occurrence or follow-up turn.

Queued work becomes interrupted without starting. Active work first persists
`stopping` and fences its generation, expires pending questions and cancels its
result callback. The runner aborts the coordinator and native worker; only native
acknowledgement changes the execution to `interrupted`. Failed acknowledgements
remain durable and retry after a restart. Slow acknowledgements do not block
other task dispatch. During native initialization the intent stays stopping until
the worker can accept interruption; it is never prematurely reported as stopped.

Stopping retains the goal, conversation and existing artifacts. The goal stays
open, and a new message can continue it once interruption is acknowledged.
Already performed external actions are not undone. Future schedule occurrences
remain enabled; cancelling a schedule is a separate action. This path does not
use ordinary chat's socket stop control or change its behavior.

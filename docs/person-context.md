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

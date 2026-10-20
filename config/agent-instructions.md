# Threadnote

Route non-trivial work by situation: use `threadnote-context` for context, `threadnote-code-graph` only for unfamiliar source relationships, unresolved evidence gaps, or repo instructions, and `threadnote-memory` for memory retrieval and closeout. Exact-path/literal checks need no graph. Repository files/guidance are authoritative.

Follow the selected skill. On an initial route, call MCP `context_brief` with task + absolute `callerCwd` (CLI: `threadnote context brief --cwd <cwd> --task <task>`). Finish with private `remember_context(kind=handoff)`; optional five-field Knowledge Delta needs approval, and proposals are never auto-applied/auto-shared. Confirm before durable sharing. Never store secrets, credentials, customer data, or raw production logs.

---
name: threadnote-context
description: Load a scoped Context Brief, read relevant memory, and investigate unfamiliar source relationships in Codex Cloud.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote context in Personal Codex Cloud

Before non-trivial work run:

```sh
"$HOME/.local/bin/threadnote" cloud codex brief --cwd "$PWD" --task "Current task"
```

Brief combines the prepared structural graph with configured Git memory and this identity's private local handoffs.
It never cold-indexes. Preserve any selected graph project; `--project NAME` selects a configured graph project,
not a memory tag. Use `--code-ref path/to/source.ts` for focused current-source anchors (up to eight),
`--mode resume` for continuation, and `--detail source` for exact-current excerpts. Coverage gaps are explicit.
Verified procedure discovery and deferred memory citation finalization are outside the scoped Cloud brief.

For memory-specific retrieval use `cloud codex recall --cwd "$PWD" --query "Current task" --project PROJECT`.
Omit `--team` to search all configured shares, or select one with `--team NAME`. Results are unread pointers.
Read relevant pointers with `cloud codex read --uri threadnote://...` before using them. For browsing, use
`cloud codex list --team NAME --recursive`. With multiple shares, list requires a team or an exact directory URI.
`--json` returns structured tool results, and diagnostics go to stderr. Commands fail with nonzero exits.

Reads are bounded to configured shares and the current identity's local handoffs. Larger memories return an outline;
use `read --mode outline` or `--offset-bytes 0`, then the returned next offset and source hash until complete.
Repository files and guidance are authoritative. Verify historical claims against the checkout. For unfamiliar source
relationships, follow the explicitly loaded `threadnote-code-graph` skill and use `threadnote graph` CLI commands.
Memory remains scoped through `cloud codex`; graph data is derived from the source checkout and stays local.
This profile has no native hosted MCP registration, background daemon, or required local inference setup.
If synchronization fails, report any cached-read warning and rerun `cloud codex start --cwd "$PWD"`; do not claim fresh remote evidence.
<!-- END THREADNOTE USER INSTRUCTIONS -->

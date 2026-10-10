---
name: threadnote-code-graph
description: Investigate unfamiliar source relationships through the local structural code graph in Codex Cloud.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

# Threadnote code graph in Personal Codex Cloud

Use the graph for unfamiliar source relationships, unresolved evidence gaps, or repository instructions.
Exact paths and literal checks go directly to source. Enter the task's source checkout and use its absolute path:

```sh
"$HOME/.local/bin/threadnote" cloud codex start --cwd "$PWD"
"$HOME/.local/bin/threadnote" graph query --cwd "$PWD" --query "Current source relationship"
"$HOME/.local/bin/threadnote" graph explain --cwd "$PWD" --symbol SYMBOL
"$HOME/.local/bin/threadnote" graph neighbors --cwd "$PWD" --node-id cgs_ID --direction incoming
"$HOME/.local/bin/threadnote" graph analyze --cwd "$PWD" --view stats
```

Startup incrementally prepares a structural snapshot without vectors. To refresh source evidence without syncing
memory, use `threadnote graph index --cwd "$PWD" --no-vectors`. Do not force a full rebuild on every task.
Use `graph status --cwd "$PWD" --json` to inspect snapshot identity, freshness, and coverage. To verify both memory
and the graph without indexing, use `cloud codex verify --cwd "$PWD" --json`.

Preserve selected graph projects with `--project NAME` on graph commands; a memory `--project` is a separate namespace.
Query, node, neighbors, and explain may return compatible stale discovery evidence. Verify exact source before relying
on it. Path, impact, and exact-current claims require current evidence; use `--freshness current` and follow bounded
retry guidance. Never treat a selected project graph as proof of repository-wide absence or silently widen its scope.
Use `graph --help` and each subcommand's help for supported selectors and bounded output options.

Graph caches are disposable local data. Do not commit them to the private memory Git share. No model downloads or
native hosted MCP registration are required for this workflow. Report graph errors and stale/deferred states explicitly;
keep making bounded progress through exact source verification when appropriate.
<!-- END THREADNOTE USER INSTRUCTIONS -->

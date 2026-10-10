# Threadnote in Personal Codex Cloud

Use the installed `threadnote-context`, `threadnote-memory`, and `threadnote-code-graph` skills for non-trivial work.
At task startup enter the source checkout and run `$HOME/.local/bin/threadnote cloud codex start --cwd "$PWD"`, then
explicitly read `$HOME/.agents/skills/threadnote-context/SKILL.md`, `$HOME/.agents/skills/threadnote-memory/SKILL.md`,
and `$HOME/.agents/skills/threadnote-code-graph/SKILL.md`.
Use `threadnote cloud codex` CLI commands for memory. Read relevant `threadnote://` pointers before treating them as evidence.
Begin with `cloud codex brief --cwd "$PWD" --task "Current task"`. At closeout, present an optional five-field
Knowledge Delta and wait for approve/defer/reject before applying durable proposals through scoped `remember`.
Use `threadnote graph` CLI commands for unfamiliar source relationships. Graph caches stay local to this environment;
startup prepares a current structural snapshot incrementally without materializing vectors or installing models.
Repository guidance and current source are authoritative. Durable memory is committed and pushed to a configured private
Git share; handoffs remain task-local. Never silently fall back to an unconfigured share or local durable storage.
Never store credentials, secrets, customer data or raw production logs. Confirm before durable sharing unless the user
has already authorized it. End meaningful work with a local `remember --kind handoff`.

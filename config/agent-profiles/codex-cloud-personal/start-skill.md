---
name: threadnote-start
description: Refresh personal Threadnote Git memory, prepare the checkout code graph, and load skills at task startup.
---

<!-- BEGIN THREADNOTE USER INSTRUCTIONS -->

Enter the task's source checkout and read its current repository guidance. Run
`$HOME/.local/bin/threadnote cloud codex start --cwd "$PWD"`. This restores managed guidance and skill files from
the saved Cloud profile, refreshes memory shares without pushing local changes, incrementally prepares the structural
code graph without vectors, and verifies readiness. Preserve the task's `HOME` and `CODEX_HOME`; managed runtime
files can be absent in a fresh task even when installation succeeded before publication. If startup fails, report the
diagnostic and repair the environment;
do not claim memory or graph readiness or fall back to unrelated storage. For a task without a Git checkout, omit
`--cwd` and report that graph readiness was not requested.

Explicitly read `$HOME/.agents/skills/threadnote-context/SKILL.md` and
`$HOME/.agents/skills/threadnote-memory/SKILL.md` and `$HOME/.agents/skills/threadnote-code-graph/SKILL.md`, then
follow those instructions during this task.
This explicit loading is required even if hosted skill discovery does not expose these files automatically.
<!-- END THREADNOTE USER INSTRUCTIONS -->

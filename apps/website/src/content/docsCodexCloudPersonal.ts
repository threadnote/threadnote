import type {DocsArticle} from './docsTypes.js';

export const codexCloudPersonalDocsArticle: DocsArticle = {
  id: 'personal-codex-cloud',
  title: 'Personal Codex Cloud setup',
  summary:
    'Publish a Codex Cloud environment with scoped Context Briefs, local structural graphs, three skills, and private Git memory.',
  keywords: [
    'Codex Cloud',
    'published environment',
    'Install script',
    'Start skill',
    'personal memory',
    'codex-cloud-personal',
    'multiple shares',
  ],
  body: [
    {
      type: 'note',
      text: 'Set up Threadnote 5.2.0 in a [Codex Cloud published environment](https://learn.chatgpt.com/docs/environments/cloud-environments): prepare the filesystem with an Install script and run startup guidance through a Start skill. This profile provides scoped Context Briefs, structural code graphs, and private Git memory through CLI commands and three explicitly loaded skills.',
    },
    {type: 'heading', text: '1. Prepare private Git memory access'},
    {
      type: 'paragraph',
      text: 'Create a private Git repository dedicated to reviewed memory, separate from application source. Connect it through the environment’s Git connection or credential provider with clone and push permissions. Access to the source repository alone does not grant access to this second repository. Use credential-free HTTPS or SSH remotes; never embed tokens, passwords, or credentials in URLs, scripts, skills, or memory.',
    },
    {
      type: 'paragraph',
      text: 'Allow network access to the installer and release downloads (raw.githubusercontent.com and github.com, including download redirects), and to your memory Git host during installation and task execution. Configure the environment’s network permissions and credential provider according to [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments). Bootstrap, startup refresh, and durable pushes need working authentication in their respective phases. A “Repository not found” error usually means a wrong URL, missing repository, or insufficient Git access.',
    },
    {type: 'heading', text: '2. Add the Install script'},
    {
      type: 'paragraph',
      text: 'Create a Codex Cloud environment for your source repository. Paste this into its Install script, replacing the example private repository URL. The installer selects Threadnote 5.2.0; bootstrap configures memory, installs the skills, and prepares the source graph before verification.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `set -eu

curl -fsSL https://raw.githubusercontent.com/threadnote/threadnote/main/scripts/install.sh | \\
  THREADNOTE_VERSION=5.2.0 sh -s -- --no-start

"$HOME/.local/bin/threadnote" cloud codex bootstrap \\
  --remote https://github.com/you/threadnote-memory.git \\
  --team personal \\
  --user codex-cloud \\
  --agent-id codex-cloud \\
  --cwd "$PWD"

"$HOME/.local/bin/threadnote" cloud codex verify --cwd "$PWD" --json`,
    },
    {
      type: 'paragraph',
      text: 'Bootstrap creates a writable Git share, refreshes it, and installs global Codex guidance, `threadnote-context`, `threadnote-memory`, `threadnote-code-graph`, and a Start skill template. With `--cwd`, it incrementally prepares a local structural graph without vectors or model downloads. Graph caches stay outside the Git memory share. Its CLI-only receipt lets `threadnote doctor`, `threadnote repair`, and integration removal manage these files without registering MCP. Managed markers preserve unrelated guidance and reject unowned file conflicts. Do not use the desktop Codex setup command for this environment.',
    },
    {
      type: 'paragraph',
      text: 'The selected account, user, agent ID, and sorted share set live in `~/.threadnote/codex-cloud/profile.json`. Fresh CLI processes inherit them. User, agent ID, and the default share are `codex-cloud`; choose explicit stable identities when reusing an existing memory repository. Keep them constant across published environments and tasks. A conflicting Cursor or Codex identity in one Threadnote home is rejected; use a separate `THREADNOTE_HOME` for another identity.',
    },
    {type: 'heading', text: '3. Set the Start skill and publish'},
    {
      type: 'paragraph',
      text: 'Use the installed template at `~/.codex/threadnote-start-skill.md` (or `$CODEX_HOME/threadnote-start-skill.md`) as the environment’s Start skill. Paste its contents into the Start skill editor if the environment expects inline text. The skill explicitly loads all three installed files; this setup does not assume hosted discovery finds user-level files automatically. See [Build skills](https://learn.chatgpt.com/docs/build-skills).',
    },
    {
      type: 'code',
      language: 'md',
      code: `---
name: threadnote-start
description: Refresh Threadnote memory and structural graphs, then load its skills.
---

Enter the source checkout and run \`$HOME/.local/bin/threadnote cloud codex start --cwd "$PWD"\`.
Startup restores managed files from the saved profile, refreshes memory without pushing,
prepares the structural graph, and verifies readiness. Preserve HOME and CODEX_HOME.
If it fails, report the diagnostic and repair the environment.

Explicitly read \`$HOME/.agents/skills/threadnote-context/SKILL.md\`,
\`$HOME/.agents/skills/threadnote-memory/SKILL.md\`, and
\`$HOME/.agents/skills/threadnote-code-graph/SKILL.md\`, then follow them during this task.`,
    },
    {
      type: 'paragraph',
      text: 'Run the Install script successfully, save the Start skill, and publish the environment. New tasks start from the prepared published filesystem, but runtime-scoped files under `$CODEX_HOME` can be absent. At every new task, the Start skill must run `cloud codex start --cwd "$PWD"`: it restores managed guidance and skills from the saved identity and share set, pulls and ingests the configured shares without committing or pushing local changes, refreshes the structural graph, and verifies readiness. Keep `HOME` and `CODEX_HOME` unchanged. Unowned file conflicts still fail without overwriting user content. Refreshing a repository is not evidence that installation or startup ran again. After changing the install script, identity, share set, or skills, rerun preparation and republish.',
    },
    {type: 'heading', text: '4. Verify in a fresh task'},
    {
      type: 'code',
      language: 'sh',
      code: `"$HOME/.local/bin/threadnote" cloud codex start --cwd "$PWD" --json
"$HOME/.local/bin/threadnote" cloud codex verify --cwd "$PWD" --json
"$HOME/.local/bin/threadnote" cloud codex brief --cwd "$PWD" --task "Relevant decisions and source relationships" --json
"$HOME/.local/bin/threadnote" cloud codex recall \\
  --cwd "$PWD" --project my-project --query "Relevant decisions" --json`,
    },
    {
      type: 'paragraph',
      text: 'Verification reports runtime version and platform, identity, CLI installation, managed artifacts, each selected share’s readiness, and graph snapshot identity, freshness, and coverage when `--cwd` is supplied. Omitting `--cwd` preserves memory-only operation; verification does not index. Failed checks exit nonzero. It checks local readiness; it does not prove a published environment ran its Start skill or that a future task can authenticate. For live verification, confirm startup actually loads all three skill files, write a harmless authorized durable smoke record, then open a second fresh task and recall/read it there. Inspect the commit in the intended private Git repository. Until that cross-task smoke passes, describe verification as local or fixture-based.',
    },
    {type: 'heading', text: 'CLI transport'},
    {
      type: 'paragraph',
      text: 'This Codex Cloud profile uses CLI commands for briefs, graphs, recall, reads, and the Knowledge Delta workflow. The installed skills invoke these commands directly, and verification reports `transport: cli`. The profile does not register an MCP server; no MCP configuration is required for this setup.',
    },
    {type: 'heading', text: 'Context Brief and Knowledge Delta'},
    {
      type: 'paragraph',
      text: 'Begin non-trivial work with `cloud codex brief --cwd "$PWD" --task "Current task"`. It combines the prepared structural graph with memory restricted to configured shares and this identity’s private local handoffs. It reports coverage gaps and never cold-indexes. Add `--code-ref path/to/source.ts` for focused anchors; `--project` selects a configured graph project, while recall uses a memory project tag. Verified procedure discovery and deferred citation finalization are excluded from this scoped brief.',
    },
    {
      type: 'paragraph',
      text: 'At closeout, write a private handoff first. If reusable knowledge exists, the memory skill presents a five-field Knowledge Delta in chat: decisions plus rationale, constraints, verificationPerformed, knowledgeInvalidated, and unresolvedRisks. Include the proposed text, evidence, selected share, and replacement URI. Wait for explicit approve, defer, or reject; only approval permits the scoped durable remember command. This CLI workflow does not use the desktop MCP candidate-review store. Proposals are never automatically applied or shared.',
    },
    {type: 'heading', text: 'Recall, read, and write'},
    {
      type: 'code',
      language: 'sh',
      code: `"$HOME/.local/bin/threadnote" cloud codex recall \\
  --cwd "$PWD" --project my-project --query "API compatibility" --team personal

# Replace URI with a pointer returned by recall or remember.
"$HOME/.local/bin/threadnote" cloud codex read --uri threadnote://user/codex-cloud/memories/shared/personal/durable/projects/my-project/api-contract.md
"$HOME/.local/bin/threadnote" cloud codex list --team personal --recursive

# Durable sharing must already be authorized.
"$HOME/.local/bin/threadnote" cloud codex remember --kind durable \\
  --team personal --project my-project --topic api-contract \\
  --text "Reviewed API compatibility decision and its reason." --json

"$HOME/.local/bin/threadnote" cloud codex remember --kind handoff \\
  --project my-project --topic api-task \\
  --text "Task; decisions; checks; blockers; next step."`,
    },
    {
      type: 'paragraph',
      text: 'Durable writes commit and push directly to the selected share; they never silently fall back to local memory. Existing sensitive-content checks and Git conflict handling apply. Handoffs remain task-local and can be read by the current identity, but they are not pushed or transferred to fresh tasks. Use an authorized, sanitized durable record for information the next task needs. `--json` returns structured tool results; diagnostics use stderr and failures exit nonzero.',
    },
    {type: 'heading', text: 'Multiple shares and updates'},
    {
      type: 'code',
      language: 'sh',
      code: `"$HOME/.local/bin/threadnote" cloud codex bootstrap \\
  --remote https://github.com/you/threadnote-docs-memory.git --team docs

"$HOME/.local/bin/threadnote" cloud codex bootstrap \\
  --remote https://github.com/you/threadnote-docs-memory.git --team docs --dry-run

"$HOME/.local/bin/threadnote" cloud codex remember --kind durable \\
  --replace-uri threadnote://user/codex-cloud/memories/shared/personal/durable/projects/my-project/api-contract.md \\
  --project my-project --topic api-contract --text "Updated reviewed decision."`,
    },
    {
      type: 'paragraph',
      text: 'Run one bootstrap per share in the Install script and republish. Repeating the same share and remote is idempotent. The explicit set is sorted, deduplicated, and capped at 16; conflicting remotes, access modes, or identities fail with an actionable error. Recall searches all configured shares unless `--team` narrows it. Listing several shares requires a team or exact directory URI. New durable writes with several shares require `--team`; replacements retain their established share. Reads, references, relations, and replacements enforce share boundaries, including identity aliases and relocated URIs.',
    },
    {
      type: 'warning',
      text: 'If startup fails, repair authentication, network permissions, missing artifacts, or conflicting share configuration and rerun it. Use `threadnote share conflicts --team NAME` for existing conflict handling. A cached read warning does not prove remote freshness, and a rejected push is a failed durable write. Never suppress those failures in the Install script or Start skill.',
    },
  ],
};

import type {DocsArticle, DocsSection} from './docsTypes.js';

export const threadnote5JourneyDocsArticle: DocsArticle = {
  id: 'threadnote-5-journey',
  title: 'Quick-start',
  summary: 'Connect your agent, work on your repo, and carry useful context into the next session.',
  keywords: ['quick start', 'installation', 'MCP', 'graph scope', 'manager', 'team sharing', 'continuity'],
  body: [
    {
      type: 'paragraph',
      text: 'Start with one repository and your usual coding agent. Work a small task, inspect what Threadnote remembers, then reuse that context in a fresh session.',
    },
    {type: 'heading', text: '1. Install Threadnote'},
    {type: 'paragraph', text: 'On macOS or Linux, run:'},
    {
      type: 'code',
      language: 'sh',
      code: 'curl -fsSL https://raw.githubusercontent.com/threadnote/threadnote/main/scripts/install.sh | sh',
    },
    {type: 'paragraph', text: 'On Windows, use PowerShell:'},
    {
      type: 'code',
      language: 'powershell',
      code: 'irm https://raw.githubusercontent.com/threadnote/threadnote/main/scripts/install.ps1 | iex',
    },
    {
      type: 'paragraph',
      text: 'Run `threadnote doctor` to check the installation. If your terminal cannot find the command, follow the PATH instructions printed by the installer. See [installation details](/docs/installation/) if needed.',
    },
    {type: 'heading', text: '2. Connect your agent through MCP'},
    {
      type: 'paragraph',
      text: 'Open a terminal in your repository. List the supported agents, then preview and apply the connection. This example uses Codex; replace `codex` with your agent’s ID from the list.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `cd /path/to/your/repo
threadnote agents list
threadnote agents install codex
threadnote agents install codex --apply`,
    },
    {
      type: 'paragraph',
      text: 'This installs the managed MCP connection, Threadnote instructions, and skills. Restart your coding agent so it loads them, and check that Threadnote appears in its MCP tools. See [Connect a coding agent](/docs/connect-an-agent/) for other environments and setup options.',
    },
    {type: 'heading', text: '3. Index your repository’s code graph'},
    {
      type: 'paragraph',
      text: 'The graph maps symbols, imports, and dependencies so your agent can find related code and check whether saved decisions still match the source. Build it once from your repository before starting work:',
    },
    {
      type: 'note',
      text: 'Working in a large monorepo? Choose a [graph scope](/docs/graph-monorepos/) before indexing. A scope selects the app or library roots you work on and includes their declared dependencies. This keeps unrelated packages out, reducing indexing work and irrelevant results. Without a scope, Threadnote indexes the full repository.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote graph index
threadnote graph status`,
    },
    {
      type: 'paragraph',
      text: 'Wait for indexing to finish and check that status reports a ready graph. If you configured several project scopes, select the intended one with `--project <name>`.',
    },
    {type: 'heading', text: '4. Work as usual'},
    {
      type: 'paragraph',
      text: 'Give your agent a normal task, such as “Fix the checkout retry bug and run the relevant tests.” Its installed guidance loads relevant memories and code context before non-trivial work. On the first task, there may be no memories yet; those build up as you work.',
    },
    {
      type: 'paragraph',
      text: 'When you finish, let the agent close out the task before ending the session. It saves a private handoff with the status, checks, and next step. If it proposes a reusable decision or lesson, review and approve what you want to keep.',
    },
    {type: 'heading', text: '5. See what was remembered in Manager'},
    {type: 'code', language: 'sh', code: 'threadnote manage'},
    {
      type: 'paragraph',
      text: 'Manager opens in your browser. Find the memories from your repository and open the handoff from the task you just completed. Check its result, tests, and next step; inspect any durable decisions you approved too. You can see exactly what a future session will be able to retrieve.',
    },
    {type: 'heading', text: '6. Connect a team'},
    {
      type: 'paragraph',
      text: 'To reuse decisions with teammates, connect a Git repository dedicated to shared memories. Create one on your Git host or use your team’s existing memory repository. Replace the example URL with a repository you can access:',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote share init git@github.com:your-org/team-memories.git
threadnote share status`,
    },
    {
      type: 'paragraph',
      text: 'Teammates connect the same repository to receive shared context, even if they use another coding agent. See [Configure a team](/docs/sharing-setup/) for more options. You can also continue using Threadnote on your own without a team.',
    },
    {type: 'heading', text: '7. Share one useful memory'},
    {
      type: 'paragraph',
      text: 'Choose a durable decision you approved in step 4 and copy its Threadnote URI from Manager. Ask your agent to preview sharing that memory with your team, review the exact content and destination, then confirm publication. Or use the CLI, replacing `<memory-uri>` with that URI:',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote share publish <memory-uri> --preview
# After reviewing the preview:
threadnote share publish <memory-uri>`,
    },
    {
      type: 'paragraph',
      text: 'Only active durable memories can be shared; handoffs stay private. If the task produced only a handoff, keep it for the next session and try sharing after a task produces a reusable decision. See [Publish a memory](/docs/publish-memory/).',
    },
    {type: 'heading', text: '8. Start a new session and see the continuity'},
    {
      type: 'paragraph',
      text: 'Open a fresh chat in the same repository and ask: “Continue the checkout retry work. Load the previous handoff and relevant decisions, summarize where we left off, and take the next step.” The agent should retrieve saved context through Threadnote. Check that it names the previous result and next step without you pasting the old conversation.',
    },
    {
      type: 'paragraph',
      text: 'After sharing, ask a teammate connected to the same memory repository to start a related task. Their agent can retrieve the shared decision; your private handoff stays with you.',
    },
    {type: 'heading', text: 'For larger tasks: spec → plan → cycle'},
    {
      type: 'paragraph',
      text: 'Standard setup installs the built-in development skills on supported agents. Use `dev-spec` to agree on behavior and acceptance criteria, `dev-plan` to turn that into implementation phases grounded in your code, and `dev-cycle` to implement, review, and verify those phases. Choose them in your agent’s skill picker; in Codex, invoke `$dev-spec`, `$dev-plan`, then `$dev-cycle`. See [Development workflows](/docs/development-workflows/) for supported environments and `watch-pr` for CI and review follow-up.',
    },
  ],
};

export const contextLifecycleConceptDocsArticle: DocsArticle = {
  id: 'context-lifecycle',
  title: 'The context lifecycle',
  summary:
    'Keep source, reviewed knowledge, task state, procedures, and suggestions distinct from capture to retirement.',
  keywords: ['context lifecycle', 'authority', 'knowledge delta', 'context brief', 'provenance', 'freshness'],
  body: [
    {
      type: 'paragraph',
      text: 'Threadnote is a source-verifiable context lifecycle, not a transcript archive or a second code portal. It compiles a bounded task view from several evidence types while preserving what each one can legitimately claim.',
    },
    {
      type: 'table',
      headers: ['Evidence', 'What it contributes', 'Authority'],
      rows: [
        ['Repository and worktree', 'Current implementation, tests, and local changes', 'Exact local files win'],
        [
          'Imported guidance',
          'Repository instructions and ADRs proposed for review',
          'Never durable knowledge until reviewed',
        ],
        [
          'Guidance projection',
          'Approved knowledge rendered into catalog-declared agent instructions',
          'Repository guidance remains authoritative',
        ],
        [
          'Durable memory',
          'Reviewed decisions, rationale, contracts, and constraints',
          'Canonical Markdown or reviewed team Git',
        ],
        ['Handoff', 'Current task state, checks, blockers, and next step', 'Local and temporary; never team-published'],
        [
          'Verified procedure',
          'A reviewed workflow with compatibility and a current verification receipt',
          'Exact Git-backed artifact and receipt',
        ],
        [
          'Candidate or repair proposal',
          'A suggested knowledge change',
          'Not authoritative until explicitly reviewed and applied',
        ],
        [
          'Git proposal',
          'An approved Knowledge Delta prepared for normal team review',
          'Not shared until its Git review is accepted',
        ],
        [
          'Health finding',
          'Evidence that saved context may be stale, conflicting, expired, or disconnected',
          'A review prompt, never a silent mutation',
        ],
        [
          'Derived index or graph',
          'Fast retrieval and current-source relationships',
          'Disposable evidence with snapshot and coverage receipts',
        ],
        [
          'Local value evidence',
          'Content-free activation, review, reuse, feedback, and repair counts',
          'Private aggregate signals, not source or memory content',
        ],
      ],
    },
    {
      type: 'heading',
      text: 'Start with a Context Brief',
    },
    {
      type: 'paragraph',
      text: 'A Context Brief is the bounded starting package for one task. The installed agent guidance compiles it automatically for non-trivial work, selecting only relevant graph evidence, decisions, handoffs, freshness results, and compatible verified procedures. Gaps and incomplete evidence remain visible; Threadnote does not turn unavailable evidence into a clean result.',
    },
    {
      type: 'heading',
      text: 'Finish with a Knowledge Delta',
    },
    {
      type: 'paragraph',
      text: 'A Knowledge Delta is a reviewable summary of what the task learned: decisions and rationale, constraints, verification performed, knowledge invalidated, and unresolved risks. At meaningful closeout the installed agent guidance prepares it, when there is reusable knowledge, alongside a separate private handoff. It is deliberately smaller than the transcript. You review changes before applying them, then cross the personal-to-team boundary separately.',
    },
    {
      type: 'heading',
      text: 'Maintenance is part of retrieval',
    },
    {
      type: 'paragraph',
      text: 'Owners, review dates, expiry, code citations, relations, guidance projections, and contradiction evidence let health checks distinguish current, changed, missing, unknown, overdue, expired, duplicated, contradictory, drifted, and broken states. Repair, supersession, and retirement preserve history and require review; durable knowledge is never silently deleted.',
    },
  ],
};

export const memorySchemaV5DocsArticle: DocsArticle = {
  id: 'memory-schema-v5',
  title: 'Memory schema v5 compatibility',
  summary: 'Use ownership and review metadata without changing the authority of existing memory.',
  keywords: ['memory schema v5', 'owner', 'review after', 'valid to', 'maintenance metadata', 'compatibility'],
  body: [
    {
      type: 'paragraph',
      text: 'Schema v5 is the compatibility foundation for the Threadnote 5 lifecycle. It adds optional maintenance metadata and safe lifecycle transitions while preserving stable memory identity, code citations, relations, and existing v4 content. It is not a new authority model: adding an owner or review date does not make a claim true.',
    },
    {
      type: 'table',
      headers: ['Field', 'Meaning', 'Behavior'],
      rows: [
        ['owner', 'Opaque person or team label responsible for review', 'Optional; not an organization identity'],
        [
          'review_after',
          'ISO calendar date or canonical ISO instant after which review is due',
          'Overdue becomes visible; Threadnote does not renew it',
        ],
        [
          'valid_to',
          'Explicit canonical ISO validity instant',
          'Expired becomes visible; Threadnote does not delete it',
        ],
        [
          'status',
          'Active, archived, superseded, or expired lifecycle state',
          'History and stable identity are preserved',
        ],
      ],
    },
    {
      type: 'paragraph',
      text: 'Existing v4 documents remain readable. Deterministic migration updates the schema header without inventing owner, review, or expiry values. Use the preview-first metadata workflow to change maintenance fields without rewriting the memory body or unrelated provenance.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote context metadata preview \
  --uri <threadnote-uri> \
  --owner platform-team \
  --review-after 2026-12-31

# Copy content_hash, proposal_id, and revision from the preview.
# Apply repeats the exact target and patch so Threadnote can recheck them.
threadnote context metadata apply \
  --uri <threadnote-uri> \
  --owner platform-team \
  --review-after 2026-12-31 \
  --content-hash <content-hash> \
  --proposal-id <proposal-id> \
  --revision <revision> \
  --approved`,
    },
  ],
};

export const contextLifecycleDocsSection: DocsSection = {
  id: 'context-lifecycle-workflows',
  title: 'Context lifecycle workflows',
  description: 'Start with verified context, review what changed, share it through Git, and keep it healthy.',
  articles: [
    {
      id: 'context-brief-workflow',
      title: 'Start with a Context Brief',
      summary: 'Give an agent the smallest useful set of reviewed decisions and current code evidence.',
      keywords: ['context brief', 'bounded context', 'code evidence', 'freshness', 'verified procedures'],
      body: [
        {
          type: 'paragraph',
          text: 'Installed Threadnote guidance tells the agent to compile a Context Brief automatically at the start of non-trivial work. It combines ready graph evidence, relevant durable decisions, active handoffs, freshness results, and compatible verified procedures inside an 800–1,500 estimated-token budget. It returns provenance and coverage so the agent knows what was established and what still needs exact local inspection. The CLI below is the manual equivalent for scripting or troubleshooting.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote context brief \
  --task "Change checkout retries without breaking order submission" \
  --project commerce \
  --code-ref apps/checkout/src/retry.ts \
  --budget-tokens 1250`,
        },
        {
          type: 'list',
          items: [
            'Use `mode locate` to find implementation surfaces, `trace` for relationships, `impact` for downstream effects, and `explain` for concise rationale.',
            'Pass up to eight graph-indexed repository-relative paths or exact `cgs_` IDs to move from current code to memories that cite it.',
            'Read recalled `threadnote://` pointers before relying on them; ranking is discovery, not evidence.',
            'Verify consequential current-source claims in the worktree. Stale or partial graph evidence can guide bounded discovery but cannot prove an exact path, impact, or absence.',
            'Specify a catalog surface when procedure compatibility must be evaluated for a different managed agent surface.',
          ],
        },
      ],
    },
    {
      id: 'knowledge-delta',
      title: 'Review a Knowledge Delta',
      summary: 'Turn task closeout into a small, editable change set instead of storing the conversation.',
      keywords: ['knowledge delta', 'structured closeout', 'review session context', 'candidate review'],
      body: [
        {
          type: 'paragraph',
          text: 'At meaningful closeout, installed Threadnote guidance tells the agent to write the required private handoff and, when the task produced reusable knowledge, prepare it for review. The optional Knowledge Delta contains at most three proposed changes and shows source evidence, comparison state, confidence, destination, recommendation, and the exact mutation preview. You decide what, if anything, is applied.',
        },
        {
          type: 'list',
          items: [
            'Decisions and rationale explain what the task established and why.',
            'Constraints record boundaries the next engineer must preserve.',
            'Verification names the checks that actually ran and their outcome.',
            'Invalidated knowledge identifies what is no longer safe to reuse.',
            'Unresolved risks remain explicit instead of being converted into facts.',
          ],
        },
        {
          type: 'paragraph',
          text: 'The installed agent skill creates the candidate review with `review_session_context`; call it manually only for scripting or troubleshooting. The required inputs are the task, outcome, a stable project or absolute callerCwd, and at least one evidence pointer when proposing reusable knowledge. Add the five closeout fields when they apply: decisions, constraints, verification performed, knowledge invalidated, and unresolved risks.',
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "tool": "review_session_context",
  "arguments": {
    "task": "Change checkout retries without breaking order submission",
    "outcome": "Preserved idempotency keys and added bounded retry verification.",
    "project": "commerce",
    "evidence": ["apps/checkout/src/retry.ts", "focused retry tests passed"],
    "decisions": ["Keep the original idempotency key across retries."],
    "constraints": ["Do not retry non-idempotent submissions."],
    "verificationPerformed": ["Focused checkout retry tests passed."],
    "knowledgeInvalidated": ["The old fixed-delay retry note is obsolete."],
    "unresolvedRisks": ["Canary verification remains outstanding."]
  }
}`,
        },
        {
          type: 'paragraph',
          text: 'The tool returns the review ID, revision, and up to three candidates. Use those exact values with `threadnote closeout preview` and `threadnote closeout apply`, or decide the candidate directly with `apply_memory_candidates`.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote closeout preview --review-id <review-id>
threadnote closeout apply \
  --review-id <review-id> \
  --revision <revision> \
  --candidate-id <candidate-id> \
  --action approve \
  --operation create \
  --approved`,
        },
        {
          type: 'note',
          text: 'Approve, edit, defer, or reject each candidate at the reviewed revision. Applying a candidate changes personal canonical memory; it does not publish it to a team.',
        },
      ],
    },
    {
      id: 'context-git-review',
      title: 'Share through Git review',
      summary: 'Publish one approved decision directly or materialize a provider-neutral proposal for team review.',
      keywords: ['context PR', 'Git proposal', 'share propose', 'share materialize', 'CODEOWNERS'],
      body: [
        {
          type: 'paragraph',
          text: 'The personal-to-team boundary is separate from Knowledge Delta approval. A small team can preview and publish one approved durable memory directly. A team that requires normal branch review can export a content-addressed proposal and materialize it as a local branch and commit.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote share propose \
  --review-id <review-id> \
  --revision <revision> \
  --candidate-id <candidate-id> \
  --approved \
  --output ./knowledge-delta-proposal.json

threadnote share materialize --proposal ./knowledge-delta-proposal.json
threadnote share materialize --proposal ./knowledge-delta-proposal.json --apply`,
        },
        {
          type: 'paragraph',
          text: 'Preview is read-only. Apply rechecks the configured team, repository identity, exact base commit, proposal hash, and target preconditions before creating the deterministic local branch and commit. It does not switch or dirty the current checkout, run Git hooks, push, or open a provider pull request. Those remain explicit team actions.',
        },
      ],
    },
    {
      id: 'continuous-context-health',
      title: 'Keep context healthy',
      summary: 'Find decay, review repairs, and aggregate local and Git-team health without silent mutation.',
      keywords: ['context health', 'repair', 'supersede', 'retire', 'schedule', 'aggregate'],
      body: [
        {
          type: 'paragraph',
          text: 'Health is a normal part of the lifecycle. Reports distinguish current, changed, missing, unknown, overdue, expired, duplicated, contradictory, drifted, and broken-relation states. Incomplete evidence is unknown, never clean.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote context health --project commerce
threadnote context health aggregate --project commerce --team platform --json
threadnote context health schedule --project commerce --cadence-minutes 1440 --json`,
        },
        {
          type: 'paragraph',
          text: 'Aggregate reads configured local Git-team snapshots without fetching, syncing, or writing. Schedule renders a provider-neutral, read-only, network-disabled invocation contract; it does not install a scheduler.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote context repair preview --project commerce --json
threadnote context repair apply \
  --project commerce \
  --proposal-id <proposal-id> \
  --revision <revision> \
  --approved`,
        },
        {
          type: 'warning',
          text: 'Personal lifecycle-safe repairs still require explicit apply. Shared, citation, guidance, ambiguous, and semantic changes remain review-only. Contradictions do not imply which record is stale; a person must bind that direction before supersession can be proposed.',
        },
      ],
    },
    {
      id: 'context-ci',
      title: 'Run Context CI',
      summary: 'Fail a change when reviewed context is affected—or when the evidence needed to decide is unavailable.',
      keywords: ['context CI', 'context check', 'SARIF', 'graph impact', 'capture advisory'],
      body: [
        {
          type: 'paragraph',
          text: 'Context Check is a provider-neutral, read-only gate. It compares the checkout with a Git base and combines direct citation changes, exact-current reverse graph impact, active conflicts, cited-document gaps, and bounded capture advisories.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote context check --project commerce --base origin/main --format text
threadnote context check --project commerce --base origin/main --format json
threadnote context check --project commerce --base origin/main --format sarif > threadnote-context.sarif`,
        },
        {
          type: 'table',
          headers: ['Exit', 'Meaning'],
          rows: [
            ['0', 'Evidence is complete and no actionable finding exists.'],
            ['1', 'At least one affected citation, graph impact, conflict, document gap, or capture advisory exists.'],
            ['2', 'Invocation is invalid or required Git, graph, citation, or health evidence is unavailable.'],
          ],
        },
        {
          type: 'note',
          text: 'Treat exit 2 as a failed gate, never as clean. Context Check never prepares a graph, writes memory, materializes a proposal, pushes, or contacts a provider. The checked-in GitHub Actions example is one provider adapter; the report contract is not GitHub-specific.',
        },
      ],
    },
    {
      id: 'verified-procedures',
      title: 'Use verified procedures',
      summary:
        'Reuse reviewed workflows only when their exact bytes, dependencies, and agent compatibility are current.',
      keywords: ['verified procedures', 'procedure verify', 'procedure publish', 'rollout', 'compatibility'],
      body: [
        {
          type: 'paragraph',
          text: 'A verified procedure is a reviewed Git-backed workflow, not a transcript or an automatically executed download. Its manifest declares stable identity and version, ownership and review date, dependencies, compatible catalog capabilities and surfaces, task keywords, rollout policy, and the exact artifact and fixtures to verify.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote procedure verify ./procedure.json
threadnote procedure verify ./procedure.json \
  --apply \
  --artifact ./SKILL.md \
  --fixture smoke=./fixtures/smoke

threadnote procedure status ./procedure.json \
  --artifact ./SKILL.md \
  --receipt ./verification-receipt.json`,
        },
        {
          type: 'paragraph',
          text: 'Verification preview never executes. Apply runs only the manifest’s explicit local commands with the current user’s permissions and emits a receipt only if the manifest, artifact, fixtures, and post-command bytes remain exact. Publication is separately previewed and approved. Context Brief admits only task-relevant, compatible, rollout-eligible procedures with a current exact dependency closure, and never includes executable bodies or commands.',
        },
      ],
    },
    {
      id: 'visible-value',
      title: 'Inspect local value',
      summary: 'Measure reuse and health outcomes with content-free local counts and consent-based export.',
      keywords: ['value report', 'applied feedback', 'second agent reuse', 'local metrics', 'redacted export'],
      body: [
        {
          type: 'paragraph',
          text: 'Feedback closes the loop. Use `useful` when a result looks relevant, `wrong` when it misleads, `pin` or `dismiss` to shape project recall, and `applied` only when the context materially informed a plan or change. The local report separates applied reuse from superficial relevance.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote recall-feedback <threadnote-uri> \
  --query '<original query>' \
  --action applied \
  --project commerce

threadnote value report --project commerce --period 14
threadnote value report export --project commerce --period 14`,
        },
        {
          type: 'paragraph',
          text: 'The report covers activation, time to first evidence, second-surface reuse, Knowledge Delta outcomes, feedback, and health resolution. It stores bounded counts and query fingerprints—not query text, memory bodies, source code, paths, repository names, or stable user IDs. Export is a redacted preview by default and writes a private bundle only with explicit apply.',
        },
      ],
    },
  ],
};

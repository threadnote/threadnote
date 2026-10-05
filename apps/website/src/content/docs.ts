import {cursorCloudPersonalDocsSection} from './docsCursorCloudPersonal.js';
import {agentIntegrationDocsSection} from './docsAgentIntegrations.js';
import {graphCheckpointsDocsArticle, graphCliCommand} from './docsGraphCheckpoints.js';
import {codeGraphReadinessDocsArticle} from './docsCodeGraphReadiness.js';
import {
  contextBriefMcpTool,
  finalizeCodeRefsMcpTool,
  handoffMemoryCitationCliExamples,
  rememberContextMcpTool,
  rememberMemoryCitationCliExamples,
  reviewSessionContextMcpTool,
  typedMemoryRelationsDocsArticle,
} from './docsMemoryCitationReference.js';
import {memoryWorkflowsDocsSection} from './docsMemoryWorkflows.js';
import {optionalImageProjectionCliCommand, optionalImageProjectionDocsArticle} from './docsImageProjection.js';
import {connectAgentDocsArticle, firstWorkflowDocsArticle, installationDocsArticle} from './docsGettingStarted.js';
import {projectGuidanceDocsArticle} from './docsGuidance.js';
import {
  contextLifecycleConceptDocsArticle,
  contextLifecycleDocsSection,
  memorySchemaV5DocsArticle,
  threadnote5JourneyDocsArticle,
} from './docsLifecycle.js';
import {
  activationCliCommands,
  activationMcpTools,
  lifecycleCliCommands,
  lifecycleMcpTools,
} from './docsLifecycleReference.js';
import {localAiDocsArticle} from './docsLocalAi.js';
import {jevConfigurationBlocks, jevConfigurationRows} from './docsJev.js';
import {optionalAnonymousTelemetryCliCommand, optionalAnonymousTelemetryDocsArticle} from './docsTelemetry.js';
import type {CliCommandReference, DocsSection, McpToolReference} from './docsTypes.js';
import {upgradeFromThreadnote4DocsArticle} from './docsUpgradeV5.js';
export type {
  CliCommandReference,
  DocsArticle,
  DocsBlock,
  DocsCodeBlock,
  DocsHeadingBlock,
  DocsListBlock,
  DocsSection,
  DocsTableBlock,
  DocsTextBlock,
  DocsVisualBlock,
  McpToolReference,
} from './docsTypes.js';
export const defaultDocId = 'threadnote-5-journey';
export const cliCommands: CliCommandReference[] = [
  ...activationCliCommands,
  {
    command: 'install',
    summary: 'Initialize the data home and maintain the shared standalone installation and user integrations.',
    examples: ['threadnote install', 'threadnote install --with-hooks'],
  },
  {
    command: 'mcp-install',
    summary: 'Preview or install one host-specific MCP configuration, compact bootstrap, and Threadnote skill bundle.',
    examples: ['threadnote mcp-install codex --apply', 'threadnote mcp-install claude --toolset full --apply'],
  },
  {
    command: 'guidance import / project / status / remove',
    summary:
      'Review existing project guidance and project explicitly selected durable knowledge into native agent instructions.',
    examples: [
      'threadnote guidance import <surface> --project <name>',
      'threadnote guidance project <surface> --project <name> --memory <uri> --apply',
      'threadnote guidance status <surface> --project <name> --json',
      'threadnote guidance remove <surface> --project <name> --apply',
    ],
  },
  {
    command: 'recall',
    summary: 'Search personal, shared, and seeded context with hybrid lexical and local semantic ranking.',
    examples: [
      'threadnote recall --query "mobile auth rollout" --caller-cwd "$PWD"',
      'threadnote recall --query "checkout contract" --workset commerce',
    ],
  },
  {
    command: 'read / list',
    summary: 'Read a returned threadnote:// file or browse a canonical URI directory.',
    examples: [
      'threadnote read threadnote://user/me/memories/durable/projects/mobile/auth.md',
      'threadnote list threadnote://user/me/memories --recursive',
    ],
  },
  {
    command: 'remember',
    summary: 'Store a lifecycle-aware memory with a stable project and topic identity.',
    examples: rememberMemoryCitationCliExamples,
  },
  {
    command: 'handoff',
    summary: 'Capture current status, checks, blockers, references, and next step for another session or agent.',
    examples: handoffMemoryCitationCliExamples,
  },
  {
    command: 'share',
    summary: 'Configure, synchronize, publish to, and resolve conflicts in Git-backed team memory repositories.',
    examples: [
      'threadnote share init git@github.com:org/team-memories.git',
      'threadnote share init git@github.com:org/team-memories.git --read-only',
      'threadnote share set-access --mode read-only',
      'threadnote share publish threadnote://user/me/memories/durable/projects/mobile/auth.md',
      'threadnote share sync',
    ],
  },
  graphCliCommand,
  {
    command: 'seed / workset',
    summary: 'Import curated guidance, prepare named repository sets, and inspect their published graph coverage.',
    examples: [
      'threadnote init-manifest --repo "$PWD"',
      'threadnote seed --dry-run',
      'threadnote seed',
      'threadnote workset show commerce',
      'threadnote workset status commerce',
      'threadnote workset prepare commerce --concurrency 4',
    ],
  },
  ...lifecycleCliCommands,
  {
    command: 'models / index',
    summary: 'Inspect pinned local model state and rebuild or verify the selected vector generation.',
    examples: [
      'threadnote models list',
      'threadnote models runtime',
      'threadnote index status',
      'threadnote index verify',
    ],
  },
  optionalAnonymousTelemetryCliCommand,
  optionalImageProjectionCliCommand,
  {
    command: 'manage',
    summary: 'Open the loopback-only Manager for diagnostics, memories, shares, and graph visualizations.',
    examples: ['threadnote manage', 'threadnote manage --no-open'],
  },
  {
    command: 'version / logs / report-issue',
    summary: 'Inspect release state and preview privacy-safe diagnostics or a public support report.',
    examples: [
      'threadnote version',
      'threadnote logs',
      'threadnote report-issue --title "Recall failed" --body "Steps and expected behavior"',
    ],
  },
  {
    command: 'source / projection / inbox',
    summary: 'Configure the zero-plugin Obsidian bridge, publish selected views, and form reviewed Inbox candidates.',
    examples: [
      'threadnote source status engineering',
      'threadnote projection status engineering-memory',
      'threadnote inbox scan --source engineering',
    ],
  },
  {
    command: 'compact / archive / forget',
    summary: 'Preview scoped memory hygiene, preserve old records as provenance, or remove canonical local context.',
    examples: [
      'threadnote compact --project mobile --dry-run',
      'threadnote archive <threadnote-uri>',
      'threadnote forget <threadnote-uri> --dry-run',
    ],
  },
  {
    command: 'migrate',
    summary:
      'Preview and apply the non-destructive legacy-home migration; specialized migration commands normalize older memory layouts.',
    examples: [
      'threadnote migrate',
      'threadnote migrate --apply',
      'threadnote migrate-memories --dry-run',
      'threadnote migrate-lifecycle --dry-run',
      'threadnote migrate-projects --dry-run',
    ],
  },
  {
    command: 'seed-skills / enrich-memories',
    summary: 'Seed searchable local agent artifacts or add local-model retrieval keywords to existing memories.',
    examples: ['threadnote seed-skills --help', 'threadnote enrich-memories --help'],
  },
  {
    command: 'export-pack / import-pack',
    summary: 'Move an explicitly selected portable context archive between Threadnote installations.',
    examples: ['threadnote export-pack --help', 'threadnote import-pack --help'],
  },
  {
    command: 'start / stop',
    summary: 'Verify on-demand runtime readiness or invoke the compatibility no-op; no service is started or stopped.',
    examples: ['threadnote start', 'threadnote stop'],
  },
  {
    command: 'uninstall',
    summary:
      'Remove Threadnote integrations and installation state, with explicit options controlling owned data removal.',
    examples: ['threadnote uninstall --help'],
  },
  {
    command: 'doctor / repair',
    summary: 'Diagnose the owned home and safely repair integrations or disposable derived state.',
    examples: [
      'threadnote doctor --dry-run',
      'threadnote doctor --strict',
      'threadnote repair --dry-run',
      'threadnote repair',
    ],
  },
  {
    command: 'update',
    summary:
      'Install a verified standalone release and repair Threadnote-owned integrations while preserving owned data; Cursor Marketplace state remains Cursor-owned.',
    examples: ['threadnote update', 'threadnote update --beta', 'threadnote update --stable'],
  },
  {
    command: 'local-ai',
    summary: 'Deprecated compatibility aliases for the models surface; use threadnote models in new automation.',
    examples: ['threadnote models list'],
  },
];
export const mcpTools: McpToolReference[] = [
  {
    name: 'threadnote_guide',
    toolset: 'core',
    summary: 'Return a state-aware capability tour when a user asks what Threadnote can do or how to begin.',
    keyInputs: [],
  },
  {
    name: 'recall_context',
    toolset: 'core',
    summary: 'Search historical memory, returning an unread queue of ranked threadnote:// pointers.',
    keyInputs: ['query', 'project', 'callerCwd', 'budgetTokens', 'responseFormat (local MCP)', 'explain', 'threshold'],
  },
  {
    name: 'read_context',
    toolset: 'core',
    summary: 'Read one or more canonical threadnote:// file URIs so their content can be used as evidence.',
    keyInputs: [
      'uri or uris',
      'mode or section',
      'responseFormat (local MCP)',
      'offsetBytes and sourceHash for explicit pages',
    ],
  },
  {
    name: 'list_context',
    toolset: 'core',
    summary: 'Browse a canonical threadnote:// directory without loading unrelated records.',
    keyInputs: ['uri', 'recursive', 'all', 'nodeLimit'],
  },
  rememberContextMcpTool,
  finalizeCodeRefsMcpTool,
  {
    name: 'inspect_code_graph',
    toolset: 'core',
    summary:
      'Inspect current source or a published workset through bounded query, drill-down, path, impact, and topology operations.',
    keyInputs: [
      'operation: query | node | neighbors | explain | path | impact | topology',
      'callerCwd',
      'query or symbol',
      'nodeId and direction for exact node drill-down',
      'from and to',
      'base',
      'workset',
      'budgetTokens and cursor for workset query',
      'responseFormat (local MCP)',
      'nodeLimit',
      'edgeLimit',
    ],
  },
  contextBriefMcpTool,
  {
    name: 'analyze_code_graph',
    toolset: 'core',
    summary:
      'Analyze whole-repository topology with stable communities, structural groups, confidence, hubs, and surprising links.',
    keyInputs: [
      'operation: stats | communities | community | groups | hubs | surprises | confidence | full',
      'callerCwd and responseFormat (local MCP)',
      'communityId and memberLimit for community drill-down',
    ],
  },
  reviewSessionContextMcpTool,
  {
    name: 'apply_memory_candidates',
    toolset: 'core',
    summary:
      'Apply an explicit approve, defer, or reject decision to one pending candidate using its current revision.',
    keyInputs: ['reviewId', 'candidateId', 'revision', 'action', 'approved', 'operation', 'replaceUri', 'editedText'],
  },
  {
    name: 'share_publish',
    toolset: 'core',
    summary: 'Preview and, after confirmation, publish an active durable personal memory to a configured team.',
    keyInputs: ['uri', 'preview', 'team', 'redact', 'push', 'message'],
  },
  ...activationMcpTools,
  {
    name: 'obsidian_publish',
    toolset: 'core',
    summary: 'Preview or publish explicitly selected memory URIs into a configured Obsidian projection.',
    keyInputs: ['projection', 'uri or uris', 'apply', 'force'],
  },
  {
    name: 'compact_context',
    toolset: 'full',
    summary: 'Plan or apply lifecycle hygiene and read-only cross-share merge review.',
    keyInputs: ['project', 'topic', 'kind', 'apply'],
  },
  {
    name: 'recall_feedback',
    toolset: 'full',
    summary: 'Record bounded useful, wrong, pin, dismiss, or applied feedback without storing the full query.',
    keyInputs: ['query', 'uri', 'action', 'project'],
  },
  ...lifecycleMcpTools,
  {
    name: 'health',
    toolset: 'full',
    summary: 'Check the self-contained runtime and owned home from an MCP client.',
    keyInputs: [],
  },
  {
    name: 'search / read / list / store',
    toolset: 'full',
    summary: 'Compatibility aliases for recall_context, read_context, list_context, and remember_context.',
    keyInputs: ['same inputs as the corresponding core tool'],
  },
  {
    name: 'archive_context / archive',
    toolset: 'full',
    summary: 'Archive a memory as provenance before the original active URI is removed.',
    keyInputs: ['uri', 'kind', 'project', 'topic'],
  },
  {
    name: 'forget',
    toolset: 'full',
    summary: 'Remove a canonical resource or, when explicitly requested, a directory subtree.',
    keyInputs: ['uri', 'recursive'],
  },
  {
    name: 'add_resource',
    toolset: 'full',
    summary: 'Copy a local text file or directory into canonical Threadnote resources.',
    keyInputs: ['sourcePath or path', 'to', 'description', 'wait', 'watchInterval'],
  },
  {
    name: 'grep / glob',
    toolset: 'full',
    summary: 'Run exact-text or filename-pattern searches inside canonical Threadnote storage.',
    keyInputs: ['pattern', 'uri', 'nodeLimit'],
  },
  {
    name: 'share_conflicts / share_conflict_show / share_conflict_resolve',
    toolset: 'full',
    summary: 'List, inspect, and explicitly resolve pending local-vs-team memory conflicts.',
    keyInputs: ['id', 'team', 'take', 'mergedContent', 'dryRun', 'push'],
  },
  {
    name: 'share_skill / share_bundle',
    toolset: 'full',
    summary: 'Preview and publish a reusable agent artifact or declared multi-skill bundle to a team.',
    keyInputs: ['path', 'team', 'preview', 'redact', 'force', 'push'],
  },
  {
    name: 'list_shared_skills / install_shared_skill',
    toolset: 'full',
    summary: 'Discover team artifact catalogs and preview or install one selected skill, command, or pack.',
    keyInputs: ['name', 'agent', 'kind', 'team', 'dryRun', 'force'],
  },
];
export const docsSections: DocsSection[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    description:
      'Start one task with local setup, a cited brief, exact code, and a reviewed closeout. Team reuse is optional.',
    articles: [
      threadnote5JourneyDocsArticle,
      {
        id: 'what-is-threadnote',
        title: 'What is Threadnote?',
        summary: 'Help coding agents start with the decisions and current code they need, then review what they learn.',
        keywords: [
          'code search',
          'polyglot code graph',
          'current worktree',
          'dependency graph',
          'impact analysis',
          'agent memory',
        ],
        body: [
          {
            type: 'paragraph',
            text: 'Threadnote gives [supported coding-agent environments](/agents/) a shared source of project context. A coding-agent environment is the editor, CLI, or hosted integration where an agent works; the catalog calls that declared integration a surface. Before a task, Threadnote finds the reviewed decisions, unfinished work, and current code that matter. After the task, it asks which new lessons are worth keeping. Private work and code indexes stay local; Git-backed team reuse is optional.',
          },
          {
            type: 'list',
            items: [
              'A Context Brief is the short, cited briefing an agent gets before a task.',
              'A Knowledge Delta is the reviewable list of useful decisions, checks, outdated notes, and open risks learned during the task.',
              'Git-backed sharing lets another supported agent reuse approved decisions without copying private chats.',
              'Health checks show when saved context may be outdated, conflicting, expired, or disconnected from the code.',
              'Private local reports show whether the workflow helps without collecting your code, saved context, repository name, or identity.',
            ],
          },
          {
            type: 'note',
            text: 'Your repository remains the source of truth for current code. Your team’s Git repository remains the source of truth for shared decisions. Threadnote brings the relevant pieces together and saves only what a person reviews.',
          },
          {
            type: 'heading',
            text: 'Saved decisions and current code stay separate',
          },
          {
            type: 'paragraph',
            text: 'Agents use `recall_context` for historical knowledge, `inspect_code_graph` for focused current-source questions such as query, node, neighbors, explain, path, and impact, and `analyze_code_graph` for repository-wide topology. The graph binds committed Git objects to an isolated staged, unstaged, renamed, deleted, and eligible-untracked overlay for the active worktree, so an answer reflects the checkout the agent is editing rather than a stale shared index.',
          },
          {
            type: 'heading',
            text: 'Local and self-contained',
          },
          {
            type: 'paragraph',
            text: 'Threadnote 5 is a standalone executable with an embedded Bun runtime. It owns canonical content, models, SQLite indexes, locks, logs, migration receipts, and share metadata below ~/.threadnote. The complete local and Git-team workflow needs no Python, OpenViking service, separately installed Node or Bun runtime, database server, hosted organization account, or background daemon.',
          },
        ],
      },
      installationDocsArticle,
      connectAgentDocsArticle,
      firstWorkflowDocsArticle,
      projectGuidanceDocsArticle,
      {
        id: 'agent-instructions-and-hooks',
        title: 'Agent instructions and hooks',
        summary:
          'Teach agents when to compile a brief, inspect the graph, write a handoff, and propose reviewed knowledge.',
        body: [
          {
            type: 'paragraph',
            text: 'Core install does not modify any agent host. Each applied mcp-install writes a compact bootstrap and progressively loaded Threadnote skills only for the selected [supported agent surface](/agents/). Checked-in AGENTS.md, CLAUDE.md, and equivalent repository guidance remain authoritative and take precedence.',
          },
          {
            type: 'list',
            items: [
              'Start non-trivial work with Context Brief using the task and absolute callerCwd; use recall_context plus read_context as the memory-only alternative.',
              'Ordinary Context Brief, recall, local repository graph analysis, and inspection reads default to compact agent text; read_context defaults to text plus non-duplicated metadata. Request responseFormat=dual when canonical structured content is required. Named Worksets default to lossless text until their agent projection exists.',
              'Use context_brief codeRefs to round-trip from current code to citing memories and from memory citations back to verified current code.',
              'Use inspect_code_graph separately, before broad text search, for current source relationships.',
              'Use analyze_code_graph for repository-wide statistics, structural communities, hubs, and surprising links.',
              'Write the required private handoff at meaningful closeout and propose the optional five-field Knowledge Delta for review; never apply it automatically.',
              'Ask before publishing durable memory; never publish handoffs or preferences.',
              'If Threadnote fails, show a privacy-safe issue preview and create it only after explicit approval.',
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: `threadnote install-hooks codex --dry-run
threadnote install-hooks codex --apply
threadnote install-hooks claude --dry-run
threadnote install-hooks claude --apply
threadnote install-hooks cursor --dry-run
threadnote install-hooks cursor --apply
threadnote install-hooks cursor --target cloud --project . --apply
threadnote install-hooks cursor --target cloud --project . --remove --apply
# Or install home, instructions, and Claude hooks together:
threadnote install --with-hooks`,
          },
          {
            type: 'paragraph',
            text: 'Codex supports a managed UserPromptSubmit hook in ~/.codex/hooks.json. Threadnote uses it to preload one bounded, source-current continuation before the first eligible turn in a session, then suppresses repeats while repository evidence is unchanged. Partial, stale, unknown, or missing handoffs are never injected, and THREADNOTE_CODEX_RESUME_PRELOAD=off disables the preload for controlled evaluations. Claude Code supports managed SessionStart and PreCompact hooks. Cursor desktop supports managed sessionStart and preCompact hooks in ~/.cursor/hooks.json, or in a repository with --project. Cursor hosted Cloud uses --target cloud --project: only the preCompact command hook is installed. Commit .cursor/hooks.json and provision threadnote on the Cloud VM PATH. Local user hooks do not carry into Cloud VMs; sessionStart, sessionEnd, and workspaceOpen are unavailable there, and hooks begin only once the environment is writable. Cloud session recall remains instruction-driven. Cursor snapshots are state-only; its transcript format is not parsed. Desktop session recall uses additional_context, with the first workspace_roots entry selecting the repository in multi-root workspaces. Installation is explicit and preserves unrelated hooks; --remove removes only Threadnote entries. See the [Codex hook reference](https://learn.chatgpt.com/docs/hooks) and [Cursor hook reference](https://cursor.com/docs/hooks) for provider capabilities. Every supported host uses its native user-level instruction and skill surfaces. The optional Cursor Marketplace plugin can provide Cursor instructions instead. Threadnote never injects a Cursor plugin under ~/.cursor/plugins/local. Hooks do not replace agent judgment or start a Threadnote daemon.',
          },
        ],
      },
      {
        id: 'cursor-marketplace-plugin',
        title: 'Cursor Marketplace plugin',
        summary: 'Use the optional Marketplace-managed Cursor rule without local-plugin injection.',
        keywords: [
          'Cursor plugin',
          'Cursor Marketplace',
          'team marketplace',
          'enterprise Cursor',
          'always-applied MDC rule',
          'publish Cursor plugin',
        ],
        body: [
          {
            type: 'paragraph',
            text: 'The normal Cursor setup is `threadnote mcp-install cursor --apply`, which installs the user-specific MCP entry, a compact user rule, and Threadnote skills. The Marketplace plugin is an optional alternative instruction provider for centrally managed environments. It intentionally has no `mcp.json`, so it cannot duplicate or replace the configuration owned by the Threadnote CLI.',
          },
          {
            type: 'heading',
            text: 'Install and verify',
          },
          {
            type: 'code',
            language: 'sh',
            code: 'threadnote mcp-install cursor --apply',
          },
          {
            type: 'list',
            items: [
              'Reload Cursor after mcp-install; no Marketplace plugin is required.',
              "Optionally find **Threadnote** in Cursor's Marketplace or run `/add-plugin threadnote` in a Cursor agent chat.",
              'On Teams or Enterprise, ask an administrator to allow the public plugin or add the Threadnote repository to a team marketplace. The administrator can make installation opt-in, default-on, or required.',
              'When the plugin is detected, Threadnote keeps it as the instruction provider, installs the user-level skills, and removes only a duplicate Threadnote-managed user-rule block.',
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: 'threadnote doctor',
          },
          {
            type: 'note',
            text: 'The optional plugin is not a global doctor prerequisite. Install, update, repair, and uninstall never create, refresh, or remove either `~/.cursor/plugins/local` or Cursor-managed Marketplace state.',
          },
          {
            type: 'warning',
            text: 'If an older Threadnote doctor or a dedicated plugin-package check reports `~/.cursor/plugins/local/threadnote`, fully quit Cursor and move only that legacy local copy aside before installing through the Marketplace. The withdrawn local injection coincided with a managed Cursor installation losing access to every model; an administrator restriction is plausible but is not a proven root cause. Threadnote reports the condition and never deletes it automatically.',
          },
          {
            type: 'heading',
            text: 'Publisher checklist',
          },
          {
            type: 'list',
            items: [
              'Keep `.cursor-plugin/marketplace.json`, `cursor-plugin/.cursor-plugin/plugin.json`, the `.mdc` rule, README, changelog, logo reference, and MIT license together on the public default branch.',
              "Test that exact default-branch source through an administrator-controlled team marketplace. Do not copy it into Cursor's local-plugin directory.",
              "Have an authorized publisher submit the public repository at [Cursor's publishing form](https://cursor.com/marketplace/publish) and review the [Marketplace Publisher Terms](https://cursor.com/marketplace-publisher-terms).",
              'After approval, verify public discovery, `/add-plugin threadnote`, a fresh agent chat, and `threadnote doctor` on both unmanaged and administrator-managed Cursor accounts.',
              'For updates, increment the plugin manifest version, add a matching changelog entry, merge the source, and request a re-index through Cursor. A Threadnote release does not publish the plugin.',
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: `bun run cursor-plugin:check
bun run build
bun run check:self-contained`,
          },
          {
            type: 'note',
            text: 'Cursor requires Marketplace plugins to use a permissive open-source license. The distributable plugin paths are MIT-licensed; the Threadnote runtime and the rest of the repository remain AGPL-3.0-or-later.',
          },
        ],
      },
      upgradeFromThreadnote4DocsArticle,
      {
        id: 'upgrade-from-3',
        title: 'Migrate from 3.x',
        summary: 'Move a legacy OpenViking home directly into Threadnote 5 without deleting the rollback source.',
        body: [
          {
            type: 'paragraph',
            text: 'The stable `/docs/upgrade-from-3/` route remains the migration guide for existing links. Threadnote 3 cannot cross the standalone-runtime boundary with `threadnote update`; install Threadnote 5 with the bootstrap installer, then run the one-time, non-destructive migration from the legacy ~/.openviking home. Users already on Threadnote 4 should follow [Upgrade from Threadnote 4](upgrade-from-4/) instead.',
          },
          {
            type: 'code',
            language: 'sh',
            code: `threadnote migrate
threadnote migrate --apply
threadnote doctor
threadnote index status`,
          },
          {
            type: 'paragraph',
            text: 'Migration inventories, stages, hashes, validates, and atomically promotes canonical content into ~/.threadnote. Existing v4 memories remain readable; schema v5 migration does not invent ownership, review, or expiry metadata. A completed matching receipt makes reruns idempotent, and derived indexes rebuild from canonical content rather than being treated as migration authority.',
          },
          {
            type: 'warning',
            text: 'The legacy source is never deleted automatically. Keep ~/.openviking until you have verified memories, resources, shares, models, recall, and rollback expectations on the new machine.',
          },
        ],
      },
    ],
  },
  {
    id: 'concepts',
    title: 'Core concepts',
    description: 'Understand the context lifecycle, authority, review, freshness, stable identity, and local evidence.',
    articles: [
      contextLifecycleConceptDocsArticle,
      {
        id: 'authority-and-storage',
        title: 'Authority and storage',
        summary: 'Canonical Markdown and Git are authoritative; every index is disposable.',
        body: [
          {
            type: 'paragraph',
            text: 'Threadnote stores canonical resources as ordinary files below ~/.threadnote/data/<account> and addresses them with stable threadnote:// URIs. The URI is the durable pointer; internal filesystem layout and derived index formats may evolve independently.',
          },
          {
            type: 'paragraph',
            text: 'MCP clients can read one canonical threadnote:// URI or bounded threadnote://memory/tn_ identity selector through the standard resources/read protocol without enumerating private memories. Identity selectors resolve only inside the authorized active corpus and are checked against the live document memory_id. Protocol reads are UTF-8 text capped at 65,536 bytes; use read_context with mode=outline or section for larger evidence, or explicitly page one URI with offsetBytes=0 and continue with nextOffsetBytes plus sourceHash until complete=true.',
          },
          {
            type: 'paragraph',
            text: 'On the local Threadnote MCP server, read_context defaults to keeping the complete memory in the first text content block and only read metadata in structuredContent. This avoids transmitting the same memory twice. Explicit responseFormat=dual restores the complete memory in both channels for structured consumers. Remote Threadnote tools do not accept responseFormat. The format choice does not change canonical memory or paging semantics.',
          },
          {
            type: 'table',
            headers: ['Data', 'Role', 'Authority'],
            rows: [
              ['Personal and ingested memories', '~/.threadnote/data/<account>', 'Authoritative'],
              ['Shared team Git repository', '~/.threadnote/share', 'Authoritative transport and history'],
              ['Lexical/vector indexes', '~/.threadnote/indexes', 'Derived and disposable'],
              ['GGUF models', '~/.threadnote/models', 'Verified, immutable, re-downloadable'],
              ['Locks, logs, migration state', '~/.threadnote/{locks,logs,migration}', 'Operational'],
            ],
          },
          {
            type: 'note',
            text: 'Deleting a corrupt derived index must never delete a memory. Repair rebuilds derived state from canonical files.',
          },
        ],
      },
      {
        id: 'memory-lifecycle',
        title: 'Memory lifecycle',
        summary: 'Use the kind that matches how the knowledge should age, move, and be shared.',
        body: [
          {
            type: 'table',
            headers: ['Kind', 'Use for', 'Typical lifecycle'],
            rows: [
              [
                'durable',
                'Decisions, contracts, invariants, workflows, reusable feature knowledge',
                'Active until replaced, superseded, or archived',
              ],
              [
                'handoff',
                'Current status, tests, blockers, branch state, next steps',
                'Active while work continues, then archived',
              ],
              [
                'incident',
                'Operational case history and resolution context',
                'Scoped history; sanitize before storing',
              ],
              ['preference', 'Explicit user working preferences', 'Personal; never team-published'],
              ['smoke', 'Installation and test probes', 'Disposable validation state'],
            ],
          },
          {
            type: 'paragraph',
            text: 'Active, archived, and superseded status makes currentness explicit. Normal recall excludes archived memories unless requested. Use stable project and topic values so a current fact has one identity.',
          },
          {
            type: 'warning',
            text: 'Never store secrets, credentials, customer data, or raw production logs. Handoffs and preferences are intentionally not publishable to a team.',
          },
        ],
      },
      memorySchemaV5DocsArticle,
      {
        id: 'stable-uris',
        title: 'Stable URIs and replacement',
        summary: 'Update one current project/topic memory instead of accumulating timestamped copies.',
        body: [
          {
            type: 'paragraph',
            text: 'Recall returns compact ranking evidence and threadnote:// pointers. Read the selected pointer, then pass replaceUri in MCP—or --replace in the CLI—when updating the same current knowledge.',
          },
          {
            type: 'code',
            language: 'json',
            code: `{
  "kind": "durable",
  "project": "mobile",
  "topic": "auth-contract",
  "replaceUri": "threadnote://user/me/memories/durable/projects/mobile/auth-contract.md",
  "text": "The current contract and bounded evidence..."
}`,
          },
          {
            type: 'paragraph',
            text: 'A personal replacement stores the new record safely before removing the previous one. Shared-memory replacement updates the shared record in place through the team workflow. Replacement and publication record an identity-fenced relocation so an old pointer resolves to its canonical URI. A pointer moved by an older version may predate that receipt; read_context then returns a machine-usable recall-canonical-uri recovery instead of guessing across namespaces: recall globally by stable topic and read the canonical URI returned. The recovery omits a project filter because an older path slug may differ from the canonical memory’s human-readable project name. One-way references can link prior context without copying its full body into the new record. For cited memory, provide codeRefs or --code-ref again to recapture evidence for the edited prose; omitting them deliberately clears the old citations and reports how many were removed.',
          },
        ],
      },
      typedMemoryRelationsDocsArticle,
      {
        id: 'hybrid-recall',
        title: 'Hybrid recall',
        summary:
          'Lexical, semantic, scope, lifecycle, authority, graph, time, and feedback signals produce explainable ranking.',
        body: [
          {
            type: 'paragraph',
            text: 'Recall first auto-syncs clean shared repositories and refreshes enabled external sources. SQLite returns bounded lexical candidates; the local embedding worker supplies semantic similarity; the ranker combines those signals with exact terms, fields, inferred project/branch scope, lifecycle, authority, currentness, graph links, and bounded feedback.',
          },
          {
            type: 'list',
            items: [
              'Confidence and no-answer gates prevent weak semantic-only results from being presented as answers.',
              'The default MCP response is a budgeted unread pointer queue. Set explain=true to include full ranking reasons, signals, and warnings.',
              'The lexical path remains available if local inference is temporarily unavailable.',
              'Concurrent refreshes are generation-fenced. If the corpus keeps changing during semantic scoring, Threadnote retries with a fresh lexical snapshot and can return lexical-only results instead of mixing generations.',
              'Recall returns pointers, so an agent loads selected records instead of replaying all history.',
            ],
          },
          {
            type: 'code',
            language: 'sh',
            code: `threadnote recall --query "checkout retry contract" --caller-cwd "$PWD"
# Broaden a sparse search deliberately:
threadnote recall --query "checkout retry contract" --threshold 0.3 --caller-cwd "$PWD"`,
          },
          {
            type: 'note',
            text: 'Pass the absolute caller workspace path. It lets Threadnote resolve current repo and branch scope without guessing from the MCP process directory.',
          },
        ],
      },
      localAiDocsArticle,
      {
        id: 'memory-vs-code',
        title: 'Memory vs current code',
        summary: 'Use recall for history and the graph for the current repository snapshot.',
        body: [
          {
            type: 'table',
            headers: ['Question', 'Use', 'Example'],
            rows: [
              [
                'What did we decide, learn, or leave unfinished?',
                'recall_context',
                '“Why is refresh rotation disabled on iOS?”',
              ],
              [
                'Where is this implemented and what calls it now?',
                'inspect_code_graph',
                'query or explain RefreshSession',
              ],
              ['How are two concepts connected?', 'inspect_code_graph path', 'LoginScreen → TokenStore'],
              ['What might this branch change affect?', 'inspect_code_graph impact', 'base origin/main'],
            ],
          },
          {
            type: 'paragraph',
            text: 'The tools are deliberately separate. Graph indexing never runs as a side effect of memory recall, and graph evidence cannot convert a memory no-answer into an answer. A memory may carry immutable file or symbol citations, but Context Brief validates those citations only against an already-ready exact-current graph and never starts a cold build. For large repositories, store-now/anchor-later can persist personal memory before graph preparation; a later successful graph/Workset preparation or local code-linked Context Brief automatically retries a bounded matching batch. Pending anchors are never evidence, and explicit finalization remains the repair fallback. Use recall and the graph together when a task needs historical rationale and current source evidence.',
          },
        ],
      },
      {
        id: 'concurrent-agents',
        title: 'Concurrent agents and linked worktrees',
        summary: 'Run several agents against one repository without sharing dirty source state between worktrees.',
        body: [
          {
            type: 'paragraph',
            text: 'Threadnote supports Conductor-style orchestrators and other workflows that run multiple agents in linked Git worktrees. Sessions using the same Threadnote home—~/.threadnote by default—share canonical memory, while graph state is scoped more narrowly: each linked worktree has its own dirty overlay and active pointer. One agent can recall the same durable decision without seeing another worktree’s uncommitted source as current-code evidence.',
          },
          {
            type: 'list',
            items: [
              'Always pass the absolute callerCwd for the agent’s own worktree so repository, branch, and graph scope are unambiguous.',
              'Use distinct handoff topics for independent tasks. Reuse a project/topic identity only when the agents intentionally update the same current record.',
              'Linked worktrees may extract graph facts concurrently; Threadnote serializes the short publication step and prevents a stale waiter from replacing a newer active generation.',
              'Graph maintenance and parser-cache cleanup wait for active linked-worktree builders before changing shared derived state.',
            ],
          },
          {
            type: 'note',
            text: 'Concurrent sessions share the local memory home, not a chat transcript. Repository files remain authoritative, and every graph answer still identifies the worktree snapshot it used. During a refresh, use the [code graph readiness](#graph-readiness) guidance: stale cards support bounded discovery, while strict relationship claims wait for current evidence.',
          },
        ],
      },
    ],
  },
  contextLifecycleDocsSection,
  memoryWorkflowsDocsSection,
  cursorCloudPersonalDocsSection,
  {
    id: 'team-sharing',
    title: 'Team sharing',
    description: 'Move only reviewed, reusable knowledge between teammates and agents through Git.',
    articles: [
      {
        id: 'sharing-setup',
        title: 'Configure a team',
        summary: 'Connect a user-provided Git repository and inspect its clean synchronization state.',
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote share init git@github.com:org/team-memories.git
threadnote share list
threadnote share status
threadnote share sync`,
          },
          {
            type: 'paragraph',
            text: 'Threadnote keeps shared canonical resources under ~/.threadnote/data and isolates Git metadata and worktrees under ~/.threadnote/share. Recall and read auto-sync incoming changes only when the team worktree is clean.',
          },
          {
            type: 'note',
            text: 'A team may use different coding agents. The shared contract is the Git-backed memory, not a vendor-specific chat transcript.',
          },
        ],
      },
      {
        id: 'read-only-teams',
        title: 'Use a read-only team',
        summary: 'Consume shared context without granting Threadnote permission to publish or push.',
        keywords: ['read-only sharing', 'consumer team', 'shared memory access', 'share permissions'],
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote share init git@github.com:org/team-memories.git --read-only
threadnote share set-access --mode read-only
threadnote share status
threadnote share sync

# Restore publishing only when this installation should contribute changes.
threadnote share set-access --mode read-write`,
          },
          {
            type: 'paragraph',
            text: 'Read-only access is persistent. Threadnote may fetch, rebase a clean team worktree, ingest shared memories, recall them, report status, and install reviewed shared artifacts, but it cannot publish, unpublish, commit, or push. Sync refuses dirty team files or local commits ahead of upstream instead of silently writing them.',
          },
          {
            type: 'note',
            text: 'Read-only is a Threadnote capability boundary, not a substitute for Git hosting permissions. Keep the remote read-only too when the installation must never push through another Git client.',
          },
        ],
      },
      {
        id: 'publish-memory',
        title: 'Publish a memory',
        summary: 'Preview and publish one active durable memory after user confirmation.',
        keywords: ['share memory', 'team memory', 'publish durable memory', 'memory sharing'],
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote share publish threadnote://user/me/memories/durable/projects/app/cache.md --preview
# Review the exact bytes and destination, then publish:
threadnote share publish threadnote://user/me/memories/durable/projects/app/cache.md`,
          },
          {
            type: 'paragraph',
            text: 'Preview re-reads, validates, and scans the personal source, then returns the exact shared bytes and destination without writing. Publishing repeats those checks, writes and verifies the shared canonical copy, commits and pushes the team worktree, verifies that the personal source did not change, then removes the personal copy. A failure before completion preserves the personal memory.',
          },
          {
            type: 'list',
            items: [
              'Only active durable memories are publishable.',
              'Credential and customer-like secret matches block publishing.',
              'Supported machine-local path leaks may be replaced with placeholders only when --redact is selected; preview again after redaction.',
              'Code citations must come from clean committed source and a portable remote repository identity; dirty, local-only, or malformed citation metadata blocks publishing.',
              'Handoffs and preferences always stay personal.',
            ],
          },
          {
            type: 'warning',
            text: 'Before an agent publishes, it must show or describe the safe durable memory and get user confirmation. Never publish a handoff, preference, secret, customer data, or raw incident log.',
          },
        ],
      },
      {
        id: 'share-conflicts',
        title: 'Synchronize and resolve conflicts',
        summary: 'Keep dirty or divergent team state explicit; never silently overwrite one side.',
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote share sync
threadnote share conflicts
threadnote share conflict show <id>
threadnote share conflict resolve <id> --take shared`,
          },
          {
            type: 'paragraph',
            text: 'Clean tracked files follow the remote team repository. Dirty state, divergent canonical content, or a failed replay becomes a pending conflict with a stable ID. Inspect both sides before choosing shared, local, or an explicit merged file.',
          },
          {
            type: 'note',
            text: 'Conflict resolution writes a local backup before mutation. Choosing local republishes reviewed local content; choosing shared accepts the Git copy into canonical storage.',
          },
        ],
      },
      {
        id: 'shared-artifacts',
        title: 'Share agent artifacts',
        summary:
          'Publish reusable Codex, Claude, or Cursor skills, commands, and multi-skill bundles with the full MCP toolset.',
        body: [
          {
            type: 'paragraph',
            text: 'The full toolset can preview and publish Codex, Claude, or Cursor skills, Claude command Markdown, and declared multi-skill bundles. Companion scripts, references, and assets can travel with a skill. Manifests describe names, agents, included paths, external dependencies, and portable path rewrites.',
          },
          {
            type: 'list',
            items: [
              'The memory-share scrubber does not run on skills, commands, or packs; redact is ignored.',
              'Unsafe traversal, reserved tokens, binary files without opt-in, embedded binary credentials, machine-local paths in binaries, and locally modified installs are blocked.',
              'Preview the exact bundle before commit and push.',
              'List shared artifacts before installing so agent, kind, and name are unambiguous.',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'code-graph',
    title: 'Polyglot code graph',
    description:
      'Inspect and analyze the current Git snapshot and dirty worktree across code, schemas, documentation, and local project artifacts.',
    articles: [
      codeGraphReadinessDocsArticle,
      {
        id: 'graph-operations',
        title: 'Query, exact nodes, neighbors, path, and impact',
        summary: 'Choose the graph operation that matches the source question.',
        keywords: ['code graph search', 'graph impact', 'inspect code graph', 'dependency path', 'symbol neighbors'],
        body: [
          {
            type: 'table',
            headers: ['Operation', 'Use it for', 'CLI'],
            rows: [
              [
                'query',
                'Find definitions, concepts, files, and a bounded relationship neighborhood',
                'threadnote graph query --query "session refresh"',
              ],
              [
                'query --workset',
                'Globally route and rank one task against a published ready-snapshot catalog, then admit bounded one-hop contract neighbors',
                'threadnote graph query --workset checkout --query "payment retry contract" --budget-tokens 1250',
              ],
              [
                'node',
                'Round-trip one exact stable cgs_ node ID from an earlier result',
                'threadnote graph node --node-id cgs_…',
              ],
              [
                'neighbors',
                'Walk bounded incoming, outgoing, or bidirectional relationships from an exact node',
                'threadnote graph neighbors --node-id cgs_… --direction incoming',
              ],
              [
                'explain',
                'Inspect one symbol with declaration and relationship evidence',
                'threadnote graph explain --symbol RefreshSession',
              ],
              [
                'path',
                'Find an authoritative bounded path locally, or cross repositories through exact workset bridges',
                'threadnote graph path --workset checkout --from cgr_… --to cgr_…',
              ],
              [
                'impact',
                'Trace local changes or reverse dependencies across a prepared workset',
                'threadnote graph impact --workset checkout --query cgr_…',
              ],
              [
                'topology --workset',
                'Summarize generation-bound declared bridges at repository and npm package-component granularity',
                'threadnote graph topology --workset checkout --json',
              ],
            ],
          },
          {
            type: 'paragraph',
            text: 'Single-repository query results expose stable cgs_ node IDs; workset evidence cards expose repository-qualified cgr_ handles. Feed either supported ID to node or neighbors, or use cgr_ handles as workset path and impact endpoints. Neighbor traversal honors direction, depth, node, edge, and provenance bounds. Every relationship reports evidence and provenance: declared, resolved, syntactic, heuristic, or model-derived. Heuristic and model associations are opt-in; they are never promoted to authoritative source edges or cross-repository bridges.',
          },
          {
            type: 'note',
            text: 'For non-trivial source investigation, agents should use inspect_code_graph before broad text search. Use analyze_code_graph when the question is about whole-repository topology. Use rg or grep afterward for exact literals, unsupported files, verification, or an explicitly reported graph failure. See [code graph readiness](#graph-readiness) for stale cards and bounded retry guidance.',
          },
        ],
      },
      {
        id: 'graph-analysis',
        title: 'Statistics, communities, groups, confidence, hubs, and surprises',
        summary:
          'Analyze whole-repository topology deterministically without loading one repository-sized graph document.',
        keywords: [
          'architecture analysis',
          'repository architecture',
          'whole graph analysis',
          'code graph communities',
          'structural analysis',
        ],
        body: [
          {
            type: 'table',
            headers: ['View', 'Use it for', 'CLI'],
            rows: [
              [
                'stats',
                'Composition, connectivity, degree, provenance, and relationship counts',
                'threadnote graph stats',
              ],
              [
                'communities',
                'Stable structural communities and weak connected components',
                'threadnote graph communities',
              ],
              [
                'community',
                'Inspect bounded members of one stable community ID',
                'threadnote graph community --community-id cgc_…',
              ],
              ['groups', 'Find bounded deterministic n-ary fan-in and fan-out groups', 'threadnote graph groups'],
              [
                'confidence',
                'Audit provenance, confidence bands, endpoints, and review findings',
                'threadnote graph confidence',
              ],
              ['hubs', 'High-degree hubs and graph-wide god nodes', 'threadnote graph hubs'],
              [
                'surprises',
                'Unusual, high-signal relationships that cross structural communities',
                'threadnote graph surprises',
              ],
              ['full', 'A compact combined analysis', 'threadnote graph analyze --view full'],
            ],
          },
          {
            type: 'paragraph',
            text: 'Community IDs, membership, structural groups, component, hub, confidence, and surprising-link algorithms are deterministic for the same snapshot and selected provenance tiers. Results include bounded suggested questions. Rationale comments and ADR/RFC references become first-class evidence nodes, so a report can connect a non-obvious constraint to the source it documents.',
          },
          {
            type: 'code',
            language: 'sh',
            code: `threadnote graph report --output architecture-report.md
# Existing output files are never overwritten.`,
          },
          {
            type: 'paragraph',
            text: 'The analyzer pages nodes and relationships from SQLite instead of hydrating the entire graph in memory. Repository size is not admission-capped. Elapsed-time and response-output budgets return an explicit partial-coverage warning rather than presenting an incomplete result as complete.',
          },
          {
            type: 'note',
            text: 'MCP keeps scoped inspection and whole-graph analysis separate: inspect_code_graph supports query, node, neighbors, explain, path, impact, and workset topology; analyze_code_graph supports repository-local stats, communities, community, groups, hubs, surprises, confidence, and full.',
          },
          {
            type: 'paragraph',
            text: 'Ordinary local repository inspect_code_graph reads default to the schema-aware, text-only TN-GRAPH/1 projection; budgetTokens is applied after final formatting and semantic truncation. analyze_code_graph also defaults to its bounded text view. Named Worksets default to lossless JSON in one text block. Request responseFormat=dual for canonical structured compatibility, and inspect the advertised schema when using older servers. Indexing, timeout, and error responses keep their existing status format.',
          },
        ],
      },
      {
        id: 'graph-indexing',
        title: 'Indexing and freshness',
        summary: 'Lazy, transactional snapshots scale to large monorepos without repository-size admission limits.',
        body: [
          {
            type: 'paragraph',
            text: 'A cold repository has no ready graph snapshot: ordinary query, node, neighbors, and explain reads return state=unavailable with reason=no-ready-snapshot and do not start indexing. Run `threadnote graph index` explicitly to build the per-checkout SQLite snapshot below ~/.threadnote/indexes/code-graph. Committed source comes from bounded Git object reads; staged, unstaged, renamed, deleted, and eligible untracked files form the current worktree overlay.',
          },
          {
            type: 'paragraph',
            text: 'Graph query, node, neighbors, and explain read the latest compatible ready snapshot by default, so ordinary semantic lookup can continue while a durable refresh is active, queued, or deferred. Verify exact literals in source, and retry only before strict current or relationship claims or when no usable cards survive. Select --freshness current for a bounded current-worktree refresh, --freshness allow-stale to guarantee no indexing, and --read-timeout-ms to override the default 25-second foreground budget. Graph path, impact, and whole-graph analysis remain current-only.',
          },
          {
            type: 'code',
            language: 'sh',
            code: `threadnote graph status
threadnote graph diagnostics --analyze
# Repair the current repository by default.
threadnote graph repair --dry-run
# Target another exact repository or checkout without blocking unrelated graph work.
threadnote graph repair --cwd ~/src/another-repository --dry-run
threadnote graph repair --checkout-id <checkout-id> --dry-run
# Home-wide maintenance remains explicit.
threadnote graph repair --all --dry-run
threadnote graph index
threadnote graph index --full
threadnote graph watch
threadnote graph compact --dry-run

# Preview removal of one exact indexed view; add --apply only after review.
threadnote graph remove-view \\
  --checkout-id <checkout-id> \\
  --worktree-id <worktree-id> \\
  --snapshot-id <snapshot-id>

# Expert-only physical deletion: preview, then repeat with the exact approval.
threadnote graph purge \\
  --checkout-id <checkout-id> \\
  --snapshot-id <snapshot-id> \\
  --json
threadnote graph purge \\
  --checkout-id <checkout-id> \\
  --snapshot-id <snapshot-id> \\
  --apply \\
  --approval <sha256-digest>`,
          },
          {
            type: 'paragraph',
            text: 'Repositories are not rejected by aggregate byte, file, project, symbol, edge, lexical-term, or vector admission caps. Content parsing and SQLite activation run in bounded batches, and completed parser batches, content-addressed file shards, and immutable commit snapshots are reusable after interruption. A pathological single-file fact payload degrades deterministically at the reviewed persistence ceiling, retains higher-value topology first, and reports omitted lower-priority facts explicitly. Individual query responses remain intentionally bounded by their node, edge, and result limits.',
          },
          {
            type: 'paragraph',
            text: 'Interactive CLI, Manager, and benchmark artifacts retain detailed indexing diagnostics. MCP keeps code-graph evidence small: inspection defaults to 20 nodes and 40 relationships, strips parser/index-only fields and repository-local activity paths, caps structured graph evidence at 24 KiB, and returns stable cgs_ IDs for focused follow-up calls. That graph-only response budget never truncates canonical memories returned by read_context.',
          },
          {
            type: 'paragraph',
            text: 'When an orchestrator creates a linked worktree from a newer commit, Threadnote first looks for reusable graph content in the shared checkout store. A commit that changes no eligible graph input aliases the existing ready content immediately. A compatible clean commit reuses a full anchor and materializes changed, renamed, and deleted paths plus a conservative resolution closure. Extractor, workspace, manifest, or unbounded resolution changes fall back to a full build; delta chains stay bounded.',
          },
          {
            type: 'paragraph',
            text: 'If the new worktree is already dirty, Threadnote can build its effective base-plus-overlay graph directly instead of first materializing an unused clean snapshot. Each linked worktree still owns an isolated dirty overlay and active pointer. Extraction can proceed concurrently, only short shared publication windows are serialized, and maintenance waits for active builders before compacting shared facts. A watcher also prewarms at most two likely local main or upstream ref tips for recently active checkouts.',
          },
          {
            type: 'paragraph',
            text: 'graph status and Manager distinguish the physical SQLite file plus sidecars from pages in use and freelist bytes already reusable inside the database. A large physical file therefore does not imply the same amount of live graph data. Automatic eligibility is deliberately freelist-only: once freelist bytes are both at least 512 MiB and 20% of the database, a running Manager compacts one eligible database at a time when builders and maintenance locks are idle and verified disk headroom is sufficient. Persisted per-database cooldowns prevent repeated attempts after successful, low-yield, deferred, or failed outcomes. SQLite VACUUM can require more than twice the database size as temporary free space, so Manager withholds compaction when that conservative headroom cannot be proved. Automatic compaction runs in an isolated child process so Manager remains responsive, and the UI shows the latest check, deferral, failure, or reclaimed bytes. Structural-fragmentation analysis can scan live SQLite pages, so it is never scheduled automatically. The storage boundary revalidates the active snapshot before and after the transactional rewrite, and interruption preserves the original database. graph compact --dry-run remains the explicit preview for additional fragmentation opportunities and manual timing control; --force is the expert override below the automatic threshold.',
          },
          {
            type: 'paragraph',
            text: 'Manager presents repository names, branches labeled by their observation boundary, and trusted local folders as the primary graph-view labels. Opaque checkout and worktree identities remain available only as last-resort diagnostics and exact CLI selectors.',
          },
          {
            type: 'paragraph',
            text: 'graph diagnostics is home-wide and does not depend on the current directory. It reports every local graph database, readable snapshot, indexed view, build, waiter, storage total, health issue, and obsolete store. Add --analyze for bounded structural statistics per indexed view, --deep for full SQLite integrity checks, or --json for the versioned diagnostic document. graph repair targets the current repository by default; --cwd and --checkout-id select another exact target, while --all requests home-wide maintenance. Targeted repair does not take the home-wide maintenance gate, so unrelated indexing can continue. The default pass is quick, --deep opts into a full scan and recovery only for state proven disposable, and SIGTERM cancels deep diagnostics and releases owned locks. Every repair mode supports --dry-run.',
          },
          {
            type: 'paragraph',
            text: 'Upgrading from 4.0.10 does not require purging existing graphs. Threadnote keeps a verified ready snapshot queryable while additive lease, reconciliation, and retention tables migrate in the background. Doctor, repair, graph status, and Manager describe that state as usable and migration-pending rather than incompatible, and a failed refresh continues serving the last good snapshot.',
          },
          {
            type: 'paragraph',
            text: 'Trusted local diagnostics associate each indexed view with its worktree folder when Threadnote can verify the repository, checkout, and worktree identity. Human output and JSON v2 distinguish verified, missing, stale, invalid, and legacy-unknown associations: missing is reserved for a previously validated folder that is now absent, while legacy-unknown means no private association has been recorded yet. Every graph action revalidates the complete identity before using a saved folder.',
          },
          {
            type: 'paragraph',
            text: 'graph remove-view targets the exact checkout, worktree, and selected snapshot identity; it previews by default and requires --apply for the compare-and-swap removal. The worktree folder does not need to exist. Threadnote refuses a stale target or busy build, preserves shared snapshots and required bases, lets existing leased readers finish, and removes only derived pointers and private provenance that still match the approved target. Repeating an applied removal is idempotent.',
          },
          {
            type: 'paragraph',
            text: 'graph purge --snapshot-id is the expert follow-up for an already isolated ready or retired snapshot. It previews by default and emits an approval digest bound to the exact graph and vector evidence; --apply also requires --approval with that digest. Threadnote rechecks the evidence under zero-wait maintenance, build, vector-writer, and graph-writer gates, and refuses active views, live leases, required bases, aliases, build owners, pending cleanup, active vector pointers, unsafe sidecars, or any state change. It never implicitly removes a view, tombstone, provenance record, source, or worktree. Foreground physical cleanup advances only one bounded page and reports whether retirement cleanup remains.',
          },
          {
            type: 'note',
            text: 'Folder associations are local-only operational data. The authenticated loopback Manager may display them, but MCP responses, production logs, issue-report diagnostics, and portable graph output remain path-free.',
          },
          {
            type: 'paragraph',
            text: 'Strict path and impact reads, or an explicit current-freshness request, can start a bounded scoped refresh and return state=indexing with a phase and retryAfterMilliseconds while it continues. Agents cannot query partial rows from an unpromoted snapshot; retry the same inspect_code_graph call after the requested delay. Ordinary query, node, neighbors, and explain reads do not start a cold build; once a consistent snapshot is ready they can use it, and during a source refresh they may disclose the previous ready snapshot as stale; optional vector enrichment and whole-graph summaries continue in the background. Path and impact wait for current state.',
          },
          {
            type: 'paragraph',
            text: 'If a long-lived MCP process observes graph storage upgraded by a newer installed Threadnote runtime, it returns the path-free state reconnect-required before starting a background builder. Reconnect the Threadnote MCP server, then retry the same graph request; the exact-current CLI and doctor continue to read the ready graph normally.',
          },
          {
            type: 'note',
            text: 'Ordinary MCP graph reads do not start a watcher or background build for a cold worktree. Use `threadnote graph index` for an explicit build, or use strict path, impact, or current-freshness reads when a bounded refresh is required. `graph watch` explicitly starts a watcher for that worktree, debounces filesystem events, and performs a full Git reconciliation every five minutes.',
          },
        ],
      },
      {
        id: 'graph-languages',
        title: 'Languages and evidence',
        summary:
          'A compiler-backed TypeScript extractor, bundled structural AST packs, and deterministic schema and corpus packs.',
        body: [
          {
            type: 'table',
            headers: ['Language', 'Extractor', 'Workspace evidence'],
            rows: [
              [
                'TypeScript / JavaScript',
                'Pinned TypeScript compiler',
                'npm workspaces, package and tsconfig metadata',
              ],
              ['Java', 'Bundled checksum-verified Tree-sitter WASM', 'Maven and Gradle project metadata'],
              [
                'Kotlin',
                'Bundled checksum-verified Tree-sitter WASM',
                'Gradle, Android, Kotlin Multiplatform source sets',
              ],
              ['Swift', 'Bundled checksum-verified Tree-sitter WASM', 'SwiftPM and conservative Xcode metadata'],
              [
                'Python, Go, Rust, C/C++, C#, Ruby, PHP, Bash, HCL',
                'Bundled checksum-verified structural AST packs',
                'Definitions, references, imports, calls, and conservative language-specific relationships',
              ],
              [
                'Dart, Elixir, Julia, Lua, Objective-C, PowerShell, Scala, Solidity, Zig',
                'Bundled checksum-verified structural AST packs',
                'Definitions, references, imports, calls, and conservative language-specific relationships',
              ],
              [
                'Verilog / SystemVerilog',
                'Bundled checksum-verified structural AST pack',
                'Modules, interfaces, programs, packages, classes, functions, tasks, instances, and inheritance',
              ],
              [
                'Svelte / Vue',
                'Bundled checksum-verified structural AST packs',
                'Component-markup structure and references; embedded script is not presented as full JavaScript/TypeScript semantics',
              ],
              [
                'Fortran, Apex, Razor',
                'Bounded deterministic text-structural extractors',
                'Explicit definitions and references without an external compiler, Python process, or false AST claim',
              ],
              [
                'SQL, GraphQL, Protobuf, JSON/YAML/TOML/INI, MSBuild/XAML/solutions, Dockerfiles',
                'Deterministic schema and configuration extractors',
                'Declarations, dependencies, imports, and project metadata where declared',
              ],
              ['Markdown / manifests', 'Built-in data extractors', 'Documentation and declared dependency facts'],
            ],
          },
          {
            type: 'paragraph',
            text: 'Repository build scripts are never executed during indexing. Structural depth is reported honestly: a portable AST pack is not presented as equivalent to TypeScript compiler resolution. The generated language-pack catalog owns file classification, parser identity, verified assets, capabilities, workspace discovery, and resolution domains, so another first-party language can be added without redesigning inventory, storage, query, CLI, or MCP.',
          },
        ],
      },
      {
        id: 'graph-corpus-and-exports',
        title: 'Documents, diagrams, media assets, and exports',
        summary: 'Bring deterministic local project artifacts into the graph and export a pinned snapshot explicitly.',
        body: [
          {
            type: 'list',
            items: [
              'Markdown, plain-text and rich-text formats, HTML/XML, CSV/TSV, notebooks, URL pointers, and TeX are indexed as searchable document structure.',
              'PDF text and links are extracted locally. OpenXML, OpenDocument, and EPUB archives contribute bounded local text sections.',
              'Mermaid, PlantUML, DOT, draw.io, GraphML, and SVG files are indexed as project artifacts and can contribute text and references.',
              'Image, audio, and video assets are searchable by filename, format, size, and deterministic image dimensions when available. Threadnote does not claim OCR, pixel understanding, or transcription.',
            ],
          },
          {
            type: 'note',
            text: 'Corpus parsing has a 64 MiB per-artifact source budget. Larger eligible files are still admitted to the graph as searchable metadata-only assets. Archive extraction separately bounds each selected entry and total expanded text to prevent decompression blowups. These are per-artifact extraction safety budgets, not repository or graph-size admission caps.',
          },
          {
            type: 'code',
            language: 'sh',
            code: `threadnote graph export --format json --output code-graph.json
threadnote graph export --format graphml --output code-graph.graphml
threadnote graph export --format html --output code-graph.html
threadnote graph export --format svg --output code-graph.svg`,
          },
          {
            type: 'paragraph',
            text: 'Exports pin one ready snapshot and page it from SQLite. JSON and GraphML support complete portable exports without a fixed graph-size cap. HTML and SVG are explicit visualization artifacts and accept caller-selected node and edge bounds, including all where the format and consumer can handle it. Existing output files are never overwritten.',
          },
          {
            type: 'warning',
            text: 'Repository-derived document text, asset names, paths, and graph labels remain untrusted evidence. Export only to an intended local destination and review an artifact before sharing it.',
          },
        ],
      },
      graphCheckpointsDocsArticle,
      {
        id: 'graph-monorepos',
        title: 'Monorepos and nested workspaces',
        summary: 'Keep a dependency-closed app graph small in a monorepo, while retaining the full-repository default.',
        keywords: [
          'monorepo graph scope',
          'dependency closure',
          'graph scope preview',
          'outside project graph',
          'worktree graph scope',
        ],
        body: [
          {
            type: 'paragraph',
            text: 'Use a project graph scope when one agent works on one app in a large monorepo and needs that app plus the workspace libraries it depends on. It is a positive selection: choose repository-relative app roots, Threadnote follows declared forward dependencies, and you can add exceptional repository-relative include paths. A project without a graph block continues to index and query the full repository.',
          },
          {
            type: 'table',
            headers: ['Need', 'Use'],
            rows: [
              [
                'One app and its declared workspace dependencies',
                'A project graph scope. It keeps unrelated apps out of that project graph without turning them into ignored files.',
              ],
              [
                'Generated, private, or otherwise unwanted files everywhere',
                'Ignore rules. They are traversal policy, not a dependency-aware partition of a monorepo.',
              ],
              [
                'A bounded task across configured repositories or projects',
                'A Workset. It composes member project graphs; it does not define their roots or dependency closure.',
              ],
            ],
          },
          {
            type: 'heading',
            text: 'Configure, preview, then use the normal graph commands',
          },
          {
            type: 'code',
            language: 'sh',
            code: `# Run this from the monorepo checkout. The project is created if needed.
threadnote graph scope set storefront \\
  --root apps/storefront \\
  --include tools/storefront-generated
threadnote graph scope preview storefront

# From a cwd that resolves to this one configured project:
threadnote graph index
threadnote graph query --query "checkout session"`,
          },
          {
            type: 'paragraph',
            text: 'A Threadnote project is a named local configuration that connects its memory identity, repository root, guidance seeds, and optional graph scope; it is not a package manifest such as package.json. The preview is read-only. It lists the resolved root and dependency components, explicit includes, required control files, included and excluded file/byte counts, completeness, and diagnostics. Review it before indexing, especially after changing workspace manifests. Manager exposes the same roots, dependency-closure explanation, includes, coverage state, and preview-before-save flow. Remove the block with `threadnote graph scope clear storefront --confirm` to return that project to full-repository behavior.',
          },
          {
            type: 'paragraph',
            text: 'A scoped result always says which project, roots, component counts, completeness, source commit, observed worktree commit, and any equivalent-snapshot reuse it covers. A direct path outside the selected graph returns `outside-project-graph`, rather than claiming the path is absent; choose a project that includes it or use a full-repository project. Textual misses are likewise only evidence about the selected graph. If dependency discovery is partial, Threadnote makes that explicit and never treats a negative result as authoritative.',
          },
          {
            type: 'paragraph',
            text: 'Commands select a scoped project automatically only when the current directory belongs to exactly one configured graph project. If more than one applies, Threadnote reports the available project names instead of silently choosing a partial graph. Keep the same manifest definition with linked worktrees: compatible graph-equivalent commit content can be reused, but dirty overlays, active views, and observations remain worktree-local so uncommitted changes do not cross branches.',
          },
          {
            type: 'paragraph',
            text: 'The project that names task context and the project that supplies a graph are not required to be the same label. An agent can keep its handoff and durable knowledge with the application it is changing while Threadnote routes code evidence to the one configured scope that contains that application. From a repository root, choose the scope explicitly when several scopes could apply; Threadnote never guesses between overlapping boundaries.',
          },
          {
            type: 'list',
            items: [
              'Forward dependencies are included; reverse dependents and unrelated workspace packages are not pulled in merely because they share a repository.',
              'An edit or newly discovered package outside the selected graph does not make that scoped graph stale or take an indexing builder slot. An in-scope dependency or control-file change does.',
              'Nested Git repositories and submodules keep separate graph identities and are not traversed from the parent checkout.',
              'Worksets preserve each member project’s graph definition and detect scope drift when a member definition changes.',
              'Scoped graphs are local-only in this release. They are not an organization-hosted scope feature.',
            ],
          },
          {
            type: 'warning',
            text: 'Portable checkpoint v1 exports only a full-repository graph. Exporting a scoped graph fails closed until checkpoint transport carries a verified scope receipt. To move a graph today, clear the scope and create a full graph checkpoint, or rebuild the scoped graph locally on the receiving checkout.',
          },
          {
            type: 'paragraph',
            text: 'The [Performance page](../performance/) documents the bounded indexing architecture and binds its current headline claims to one exact-release large-repository artifact. Narrow historical studies remain checked-in engineering records instead of being presented as current product results.',
          },
        ],
      },
    ],
  },
  {
    id: 'surfaces',
    title: 'Manager and integrations',
    description: 'Inspect local state visually and bridge selected knowledge to Obsidian.',
    articles: [
      {
        id: 'manager',
        title: 'Manager',
        summary: 'A foreground, loopback-only web UI for graphs, Worksets, memories, processes, and health.',
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote manage
# Start without opening the browser:
threadnote manage --no-open`,
          },
          {
            type: 'paragraph',
            text: 'Manager starts a temporary local HTTP server only for the foreground session, binds to loopback, and uses a per-process bearer token. It is not a daemon and never exposes a model or memory server.',
          },
          {
            type: 'paragraph',
            text: 'Manager chooses a free ephemeral loopback port by default. Pass --ui-port 0 to request one explicitly, or --ui-port <port> to require a fixed local port; the printed URL always contains the selected port. Manager never falls back to a wildcard interface.',
          },
          {
            type: 'list',
            items: [
              'Doctor: installation, integration, model, index, and storage health.',
              'Memory: browse lifecycle-aware canonical records and pending candidates.',
              'Knowledge graph: explore current symbols and relationships, request topology signals, and preview or remove one exact indexed view without requiring its local folder. Storage with neither a verified folder nor a ready snapshot is labeled unassociated and offers explicit index-or-purge guidance.',
              'Worksets: create and maintain manifest projects and named cross-repository definitions, publish a ready generation explicitly, then search or traverse its bounded evidence.',
              'Processes: inspect safe role, parent, operation, age, memory, and version metadata without exposing arguments, environment, paths, prompts, or private registration data. Confirmed termination revalidates the exact opaque registration and OS start identity before every signal; stale targets fail closed and the current Manager is protected.',
              'Shares: inspect configured teams, synchronization, and conflicts.',
              'Tools: discover operational surfaces without memorizing every command.',
            ],
          },
        ],
      },
      {
        id: 'manager-worksets',
        title: 'Manage cross-repository Worksets',
        summary: 'Create authoritative repository sets, prepare published evidence, and operate them from Manager.',
        keywords: [
          'Manager Worksets',
          'Manager projects',
          'manifest project create edit rename delete',
          'empty manifest first project',
          'unresolved Workset project reference',
          'workset definition editor',
          'workset create edit delete',
          'workset query continuation',
          'context brief workset',
        ],
        body: [
          {
            type: 'paragraph',
            text: 'Open threadnote manage and choose Worksets, then switch between Projects and Worksets. Manager is the visual editor for the authoritative seed manifest, preserving unrelated keys and supported YAML comments. For a CLI-first lifecycle, use workset create/list/show/update/delete; use --confirm for delete and --json for automation.',
          },
          {
            type: 'code',
            language: 'sh',
            code: `threadnote workset create commerce --project api --project billing \\
  --description "Checkout and billing services"
threadnote workset list --json
threadnote workset show commerce --json
threadnote workset update commerce --name commerce-platform --project api --project billing --json
threadnote workset show commerce-platform --json
threadnote workset prepare commerce-platform --json
threadnote workset status commerce-platform --json

# Optional cleanup after the retained workflow is no longer needed.
threadnote workset delete commerce-platform --confirm --json`,
          },
          {type: 'visual', visual: 'manager-onboarding'},
          {
            type: 'code',
            language: 'yaml',
            code: `version: 1
projects:
  - name: api
    path: ~/src/api
    uri: threadnote://resources/repos/api
    seed: []
  - name: billing
    path: ~/src/billing
    uri: threadnote://resources/repos/billing
    seed: []
worksets:
  - name: commerce-platform
    description: Checkout and billing services
    projects: [api, billing]`,
          },
          {
            type: 'heading',
            text: 'Create and maintain projects',
          },
          {
            type: 'list',
            items: [
              'Choose Projects, then + or Add first project. Enter a unique project name, repository path, threadnote://resources URI, and optional repository-relative seed paths or globs.',
              'Project cards show the observed branch, local folder, full path, seed count, and number of referencing Worksets. Edit can rename the project or change its path, URI, and seed patterns.',
              'Renaming a project updates its case-insensitive Workset member references atomically. Changes that affect graph identity retire only the exact affected published Workset generations; seed-only edits retain them.',
              'Deleting a project leaves its name visible as an unresolved member in every referencing Workset. It never deletes canonical resources or repository graphs, and Manager explains that boundary before confirmation.',
            ],
          },
          {
            type: 'heading',
            text: 'Create and maintain Worksets',
          },
          {
            type: 'list',
            items: [
              'Choose + to create a Workset, enter a unique name and optional description, select at least one manifest project, then save.',
              'Choose Edit to rename the Workset, change its description, or add and remove members. Search and selected-only pagination keep all 4,096 supported projects manageable.',
              'Existing unresolved member names remain visible so they can be preserved or removed; a new member must match a configured manifest project.',
              'Choose Delete and confirm the destructive definition change. Repository graphs are derived data and are not deleted by this action.',
            ],
          },
          {
            type: 'paragraph',
            text: 'Every project or Workset save carries the SHA-256 revision of the raw manifest that Manager loaded. Threadnote re-reads that revision under the graph-prepare lock and a dedicated manifest lock, validates the complete candidate, writes a private same-directory temporary file, rechecks the revision immediately before promotion, and atomically renames it. A concurrent edit returns revision-conflict without writing; Manager refreshes the inventory and preserves an open draft for deliberate review and retry. Description-only Workset and seed-only project changes do not stale a graph publication. Identity or membership changes retire only the exact old published generation after the manifest commit; a bounded cleanup warning never rolls the authoritative manifest back.',
          },
          {type: 'visual', visual: 'manager-project-lifecycle'},
          {
            type: 'warning',
            text: 'Manager editing is deliberately read-only at the affected boundary when the manifest is a symbolic link or mutable project or Workset YAML uses aliases, anchors, or unsupported node shapes. Unsupported project shapes disable project editing without unnecessarily disabling ordinary Workset edits. Unsupported Workset shapes disable Workset edits and only block a project rename when referenced member scalars must also change; other project fields remain repairable. Ordinary maps and scalar sequences preserve comments. Project, member, and Workset names must already be normalized non-empty text without surrounding or repeated whitespace and must fit the 256-byte runtime bound; Manager fails closed instead of trimming or presenting a different identity.',
          },
          {
            type: 'heading',
            text: 'Prepare and inspect readiness',
          },
          {
            type: 'paragraph',
            text: 'Definitions do not build graphs. Choose Prepare to start an explicit background Manager job that indexes the selected repositories, builds exact routing and bridge projections, and atomically publishes one generation. The live job shows the active member, bounded retry attempt, repository-index phase and counters, completed-member count, elapsed time, and later catalog/bridge/publication phases before showing typed terminal receipts. Incomplete published coverage is a visible warning rather than a silent success. The tab remains usable while the job runs, supports Stop preparation, and polls only the lightweight job record. Stopping is interruption-safe, but an atomic publication may have completed just before interruption; the selected readiness view is refreshed and remains authoritative.',
          },
          {type: 'visual', visual: 'manager-prepare-query'},
          {
            type: 'list',
            items: [
              'Reloading the same Manager page rediscovers active and recent jobs. The bounded list retains 32 summaries and fetches one selected job result on demand.',
              'Closing Manager interrupts its active prepare and waits for staging cleanup. Jobs are session state, not a persistent queue or daemon.',
              'Readiness is loaded only for the selected Workset. It reports current, stale, missing, failed, excluded, deferred, and uncatalogued members plus exact-bridge coverage and recovery guidance. Uncatalogued explicitly means that a ready repository snapshot is absent from the published generation.',
              'Status and every read operation use only ready published state and never trigger a cold repository build. Prepare is the only Worksets action that builds.',
            ],
          },
          {
            type: 'heading',
            text: 'Search, continue, traverse, and compile a brief',
          },
          {
            type: 'table',
            headers: ['Manager action', 'How to use it', 'What it returns'],
            rows: [
              [
                'Query',
                'Enter an ordinary engineering task or symbol; no Workset query language is required. Set a token budget and optionally include non-authoritative heuristic or model support.',
                'Generation-bound evidence cards, human repository labels, reasons, relationship authority and provenance, coverage, warnings, and truncation.',
              ],
              [
                'Continue',
                'Choose Continue when the latest result supplies a cgwc_ cursor.',
                'The next stable page from the same published generation. A definition change or successful reprepare clears old cards and cursors.',
              ],
              [
                'Exact path',
                'On a query card choose Use as From or Use as To, then run the path action with two cgr_ references.',
                'A bounded authoritative path through repository-local edges and exact cross-repository bridges, with stop and coverage receipts.',
              ],
              [
                'Reverse impact',
                'Choose Trace impact on a card, or paste its cgr_ reference as the starting point.',
                'Bounded reverse dependencies with relationship provenance and traversal coverage.',
              ],
              [
                'Topology',
                'Load the selected published Workset topology.',
                'Human-labeled repositories, package components, exact bridge edges, evidence counts, and completeness warnings.',
              ],
              [
                'Context brief',
                'Enter a task, choose brief, locate, explain, trace, or impact, and set a token budget.',
                'Projected graph cards and contracts, durable decisions, active handoffs, scope coverage, conflicts, and recommended follow-ups.',
              ],
            ],
          },
          {
            type: 'note',
            text: 'Manager prefers the manifest project name, an explicitly labeled observed branch, and the trusted local folder and path. Detached, missing, and deferred branch observations are shown as such. Opaque repository or checkout IDs appear only as shortened fallback diagnostics; graph references remain available as advanced copy/use values.',
          },
          {
            type: 'table',
            headers: ['Boundary', 'Limit or behavior'],
            rows: [
              [
                'Definitions, manifest projects, and members per Workset',
                '4,096 each; project picker pages contain 250 rows',
              ],
              ['Names', '1–256 UTF-8 bytes, normalized, unique case-insensitively, and free of control characters'],
              ['Descriptions, tasks, query text, and graph selectors', 'At most 4,096 UTF-8 bytes'],
              ['Response budget', 'Workset query: 1–1,500; Context Brief: 800–1,500 estimated tokens'],
              ['Prepare concurrency', 'Manager uses 2; the authenticated API accepts 1–8'],
              [
                'Branch labels',
                'One bounded Git symbolic-ref observation per admitted project; catalog observation is capped at 128 projects',
              ],
              [
                'Graph maintenance',
                'Definitions and job list/detail/cancel stay available; readiness, prepare, query, continuation, path, impact, topology, and Context Brief return maintenance-busy and must be retried',
              ],
            ],
          },
        ],
      },
      {
        id: 'obsidian-source',
        title: 'Obsidian as a recall source',
        summary: 'Import only allowlisted vault notes as untrusted external context.',
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote source add --type obsidian --id engineering \\
  --vault "/path/to/Engineering Vault" \\
  --include "Engineering/**" \\
  --exclude "Engineering/Private/**"

# Review the normalized configuration, then persist it.
threadnote source add --type obsidian --id engineering \\
  --vault "/path/to/Engineering Vault" \\
  --include "Engineering/**" \\
  --exclude "Engineering/Private/**" \\
  --apply`,
          },
          {
            type: 'paragraph',
            text: 'Every applied CLI recall and MCP recall_context refreshes enabled sources incrementally before ranking. A failed refresh warns and recall continues with the last successful snapshot. The vault is never modified by a source sync.',
          },
          {
            type: 'warning',
            text: 'Imported notes always have external authority and untrusted trust, regardless of frontmatter. Source traversal rejects symlinks and boundary escapes, excludes Obsidian internals, configured Inbox folders, and managed projections, and secret-scans the sanitized copy.',
          },
        ],
      },
      {
        id: 'obsidian-projection',
        title: 'Project memories into Obsidian',
        summary: 'Publish explicitly selected Threadnote memories as deterministic, drift-protected Markdown.',
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote projection add --type obsidian --id engineering-memory \\
  --vault "/path/to/Engineering Vault" \\
  --folder Threadnote \\
  --apply

threadnote projection publish engineering-memory \\
  --uri threadnote://user/me/memories/durable/projects/mobile/auth.md \\
  --apply

threadnote open threadnote://user/me/memories/durable/projects/mobile/auth.md`,
          },
          {
            type: 'paragraph',
            text: 'A new projection selects no memories. Publish adds only the supplied canonical URIs; sync later refreshes only that selection. Generated notes contain a managed marker, stable ID, canonical URI, lifecycle metadata, evidence, and relation links.',
          },
          {
            type: 'paragraph',
            text: 'Threadnote never overwrites an unmanaged file. If a generated note was edited, status reports drift and preserves it; force applies only to a path already recorded as managed. Editing a projected note never updates canonical memory.',
          },
        ],
      },
      {
        id: 'obsidian-inbox',
        title: 'Obsidian Inbox candidates',
        summary: 'Turn explicitly marked vault notes into review candidates, never silent memories.',
        body: [
          {
            type: 'code',
            language: 'yaml',
            code: `---
threadnote_candidate: true
kind: durable
project: mobile
topic: auth-contract
---
The proposed memory body.`,
          },
          {
            type: 'code',
            language: 'sh',
            code: `threadnote inbox scan --source engineering
threadnote inbox scan --source engineering --apply`,
          },
          {
            type: 'paragraph',
            text: 'Inbox scanning reads only direct Markdown children of the configured Inbox. Apply creates candidate reviews visible to the agent workflow and Manager Candidate Inbox; it does not create or replace active durable memory. Unchanged notes are idempotent.',
          },
        ],
      },
    ],
  },
  {
    id: 'operations',
    title: 'Operations',
    description: 'Diagnose, repair, update, secure, and support a standalone Threadnote installation.',
    articles: [
      {
        id: 'doctor-and-repair',
        title: 'Doctor and repair',
        summary: 'Diagnose first, then repair only owned integrations or disposable derived state.',
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote doctor --dry-run
threadnote doctor --strict
threadnote repair --dry-run
threadnote repair`,
          },
          {
            type: 'paragraph',
            text: 'Doctor checks the self-contained home, canonical layout, core model, recall indexes, readable code-graph snapshots and pending maintenance, plus MCP, instructions, and skills for registered [supported agent surfaces](/agents/) only. Merely installing an unrelated host does not create a warning. A supported older graph that is still queryable is reported as migrating or maintenance-pending, not corrupt or incompatible. Strict mode exits non-zero when a check fails.',
          },
          {
            type: 'paragraph',
            text: 'Repair can reassert storage layout, provision the core embedding model, rebuild derived lexical/vector state, schedule additive code-graph migrations, clean state proven corrupt or abandoned, and repair registered hooks or agent integrations. During upgrade it infers registrations from existing Threadnote MCP entries, migrates their host bundles, and removes only orphaned Threadnote-managed legacy instructions. It preserves readable older graphs during migration, never manages Cursor Marketplace state, and does not modify repositories or delete canonical memories.',
          },
          {
            type: 'note',
            text: 'Threadnote has no daemon to restart. start verifies on-demand readiness; stop is a compatibility no-op.',
          },
        ],
      },
      {
        id: 'models-and-indexes',
        title: 'Models and recall indexes',
        summary: 'Verify the pinned core model, manage vector generations, and repair all derived recall state safely.',
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote models list
threadnote models runtime
threadnote models verify bge-small-en-v1.5-q8
threadnote index status
threadnote index verify
threadnote index rebuild
# Validate or rebuild lexical and vector state together:
threadnote repair --dry-run
threadnote repair`,
          },
          {
            type: 'paragraph',
            text: 'The bundled core model is installed without a network request. Downloads for additional models are resumable, and a partial or checksum-mismatched artifact is never selected. A verified existing model is preserved across reinstall and update.',
          },
          {
            type: 'paragraph',
            text: 'The index commands above manage the selected vector generation only. Vector rebuild creates a complete generation and switches the active mapping transactionally only after every required row is ready; content-addressed vectors already verified on disk are reused after interruption. Use threadnote repair when lexical and vector derived state both need validation or rebuilding.',
          },
          {
            type: 'warning',
            text: 'index purge removes disposable vector data, not canonical resources. If you are uncertain which state is safe to rebuild, run doctor --dry-run and repair --dry-run first.',
          },
        ],
      },
      {
        id: 'updates',
        title: 'Updates and channels',
        summary: 'Stay on stable or beta intentionally while preserving models, memory, and integration state.',
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote update
threadnote update --beta
threadnote update --stable
threadnote update --check`,
          },
          {
            type: 'paragraph',
            text: "The beta channel is an inclusive preview channel: it selects the newest immutable Threadnote release across stable and prerelease builds, so an invoked update can graduate an older beta to a fresher stable without --stable. After that graduation, ordinary updates follow stable; use --beta to re-enter preview selection. Use --stable to request stable explicitly, even when it is numerically lower than an installed prerelease. Add --json to --check for a versioned machine-readable result. Updates verify immutable release assets, promote atomically, preserve ~/.threadnote data and verified model files, then repair Threadnote-owned integrations. Cursor Marketplace plugin updates remain owned by Cursor and the organization's policy. Existing 4.x users can follow the focused [Threadnote 5 upgrade guide](upgrade-from-4/).",
          },
          {
            type: 'paragraph',
            text: 'The standalone installer removes only verified obsolete Threadnote runtimes, such as old global npm packages and Threadnote-owned legacy tooling. It never deletes the legacy ~/.openviking data source.',
          },
        ],
      },
      {
        id: 'security-and-privacy',
        title: 'Security and privacy',
        summary: 'Local transport, safe canonical writes, explicit publishing, and bounded diagnostics.',
        body: [
          {
            type: 'list',
            items: [
              'Canonical URI parsing rejects traversal, ambiguous encodings, escaping links, and unsupported file types.',
              'Writes use bounded locks, same-directory temporary files, durable close, atomic rename, and compare-and-swap where replacement requires it.',
              'MCP uses local stdio. Manager binds to loopback with a per-process bearer token. No daemon or storage port listens in the background.',
              'Model files and release archives are pinned and SHA-256 verified before atomic promotion; native compilation and implicit downloads are disabled.',
              'Team publishing and Obsidian boundaries secret-scan content and preserve the source when validation or promotion fails.',
            ],
          },
          {
            type: 'warning',
            text: 'Do not store credentials, customer data, private production payloads, or raw logs. Review every team publish and external projection for the intended audience.',
          },
        ],
      },
      optionalAnonymousTelemetryDocsArticle,
      optionalImageProjectionDocsArticle,
      {
        id: 'logs-and-support',
        title: 'Logs and support reports',
        summary: 'Preview privacy-safe diagnostics and require exact approval before creating a public issue.',
        body: [
          {
            type: 'code',
            language: 'sh',
            code: `threadnote logs
threadnote report-issue \\
  --title "Short failure summary" \\
  --body "What happened, what was expected, and how to reproduce it"`,
          },
          {
            type: 'paragraph',
            text: 'Rotating JSON Lines logs live below ~/.threadnote/logs. They contain version, embedded Bun version, platform, command or MCP tool name, duration, outcome, and typed failure name. They never record arguments, environment values, memory content, recall queries or results, MCP payloads, or exception messages.',
          },
          {
            type: 'paragraph',
            text: 'report-issue previews the exact public body and prints an approval digest. Create the issue only after reviewing that preview and explicitly rerunning with --apply --approval <digest>. Include bounded allowlisted logs only with a separate --include-logs choice.',
          },
        ],
      },
    ],
  },
  {
    id: 'reference',
    title: 'Reference',
    description: 'CLI, MCP, configuration, storage, and architecture contracts for Threadnote 5.',
    articles: [
      {
        id: 'cli-reference',
        title: 'CLI reference',
        summary:
          'The complete execution surface; every mutating integration command supports an explicit preview or dry-run contract where applicable.',
        body: [
          {
            type: 'paragraph',
            text: 'Run threadnote <command> --help for the installed version’s exact flags. The groups below cover the stable Threadnote 5 operator surface.',
          },
          {
            type: 'table',
            headers: ['Group', 'Commands'],
            rows: cliCommands.map(item => [item.command, item.summary]),
          },
          {
            type: 'note',
            text: 'Global overrides include --home, --manifest, --log-level, shell completions, and --wizard. --home selects the data home; it does not relocate shared standalone installation state. Prefer explicit --query and absolute --caller-cwd in scripts.',
          },
        ],
      },
      {
        id: 'mcp-reference',
        title: 'MCP reference',
        summary: 'Focused core tools for daily agent work, with a larger explicit maintenance toolset.',
        body: [
          {
            type: 'paragraph',
            text: 'The local MCP adapter exposes the core toolset by default. Compatibility aliases and maintenance, conflict, artifact, feedback, and direct-storage tools require --toolset full.',
          },
          {
            type: 'table',
            headers: ['Tool', 'Toolset', 'Purpose'],
            rows: mcpTools.map(item => [item.name, item.toolset, item.summary]),
          },
          {
            type: 'note',
            text: 'All graph calls require an absolute callerCwd. recall_context should also receive callerCwd for current repo and branch resolution. Read returned threadnote:// pointers instead of asking recall to inline the entire corpus.',
          },
        ],
      },
      {
        id: 'configuration',
        title: 'Configuration',
        summary: 'Use the owned defaults; override paths and behavior only for managed or test environments.',
        body: [
          {
            type: 'table',
            headers: ['Setting', 'Purpose', 'Default'],
            rows: [
              ['THREADNOTE_HOME / --home', 'Relocate data state, not standalone installation state', '~/.threadnote'],
              [
                'THREADNOTE_INSTALL_ROOT',
                'Relocate shared install state for managed/test installs',
                'Platform data root',
              ],
              ['THREADNOTE_MANIFEST / --manifest', 'Select the seed manifest', '~/.threadnote/seed-manifest.yaml'],
              ['THREADNOTE_RECALL_THRESHOLD', 'Default topical relevanceScore floor', '0.3'],
              ['THREADNOTE_CALLER_CWD', 'Fallback workspace for CLI scope resolution', 'Current process directory'],
              ['THREADNOTE_MCP_TOOLSET', 'Select core or full MCP tools', 'core'],
              ['THREADNOTE_CANDIDATE_POLICY', 'Session candidate mode: suggest, handoff-only, or off', 'suggest'],
              ['THREADNOTE_AUTO_UPDATE', 'Set to 1 to enable hook-driven update checks', 'unset'],
              ['THREADNOTE_NO_SPINNER', 'Disable interactive progress spinners', 'unset'],
              ...jevConfigurationRows,
            ],
          },
          ...jevConfigurationBlocks,
          {
            type: 'warning',
            text: 'THREADNOTE_INSTALL_ROOT is an advanced managed-install and test-isolation boundary, not a per-agent data-home setting. Other internal build, worker, release-source, parser-asset, and command-limit variables are implementation or test controls. Do not copy them into agent configs.',
          },
        ],
      },
      {
        id: 'storage-layout',
        title: 'Storage layout',
        summary: 'Know which paths are authoritative, disposable, or operational.',
        body: [
          {
            type: 'table',
            headers: ['Path', 'Contents', 'Recovery'],
            rows: [
              [
                '~/.threadnote/data/<account>',
                'Canonical resources and personal/ingested shared memories',
                'Back up; never purge as an index',
              ],
              [
                '~/.threadnote/models',
                'Verified immutable GGUF files and role selections',
                'Preserved on update; re-downloadable',
              ],
              [
                '~/.threadnote/indexes/lexical',
                'SQLite BM25/postings and exact-search data',
                'Disposable; repair/rebuild',
              ],
              ['~/.threadnote/indexes/vectors', 'Paged content-addressed recall vectors', 'Disposable; repair/rebuild'],
              [
                '~/.threadnote/indexes/code-graph',
                'Per-checkout source snapshots and symbol vectors',
                'Disposable; next query rebuilds',
              ],
              [
                '~/.threadnote/share',
                'Team configuration, isolated Git worktrees and gitdirs',
                'Operational; resolve dirty state explicitly',
              ],
              ['~/.threadnote/migration', 'Checksummed migration receipts', 'Preserve for idempotence and diagnosis'],
              [
                '~/.threadnote/locks, logs, tmp',
                'Coordination, bounded diagnostics, staging',
                'Operational; repair owns cleanup',
              ],
            ],
          },
          {
            type: 'note',
            text: 'A 4.0 runtime never writes current owned state to ~/.openviking. That directory is only an untouched legacy migration and rollback source.',
          },
        ],
      },
      {
        id: 'architecture',
        title: 'Architecture',
        summary:
          'One foreground Effect runtime, canonical files, SQLite-derived search, and an isolated local-model worker.',
        body: [
          {
            type: 'heading',
            text: 'Runtime',
          },
          {
            type: 'paragraph',
            text: 'Each CLI, MCP, or Manager process owns one root Effect runtime and scope. Raw filesystem, process, HTTP, digest, SQLite, and native-addon access stays behind capability adapters. Domain services depend on Threadnote-owned ports so unstable Effect APIs and node-llama-cpp remain localized.',
          },
          {
            type: 'heading',
            text: 'Storage and retrieval',
          },
          {
            type: 'paragraph',
            text: 'ResourceStore owns safe canonical files. SQLite owns normalized lexical postings, paged vectors, and per-repository code-graph snapshots as derived state. Recall combines deterministic and local-model signals; scoped graph inspection and whole-graph topology analysis remain separate snapshot-aware services that page from the same ready graph generation.',
          },
          {
            type: 'heading',
            text: 'Local inference',
          },
          {
            type: 'paragraph',
            text: 'A supervised worker process owns the prebuilt node-llama-cpp adapter and keeps scoped models warm. Transport or native failure causes bounded disposal and one retry with a fresh worker; repeated failure becomes a typed error while recall can fall open to lexical results.',
          },
          {
            type: 'heading',
            text: 'Sharing and surfaces',
          },
          {
            type: 'paragraph',
            text: 'Git is the explicit cross-team transport. MCP is local stdio. Manager is a temporary loopback UI. Obsidian sources and projections are capability-scoped bridges that preserve Threadnote identity, trust, provenance, and lifecycle boundaries.',
          },
        ],
      },
    ],
  },
  agentIntegrationDocsSection,
];

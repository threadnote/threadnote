import type {DocsArticle} from './docsTypes.js';

export const upgradeFromThreadnote4DocsArticle: DocsArticle = {
  id: 'upgrade-from-4',
  title: 'Upgrade from Threadnote 4',
  summary:
    'Update in place, keep your existing data and agent connection, and adopt the 5.0 workflow at your own pace.',
  keywords: ['upgrade from 4', 'Threadnote 4.x', 'upgrade to 5', 'existing users', 'migration', 'workflow changes'],
  body: [
    {
      type: 'paragraph',
      text: 'Threadnote 5 is an in-place upgrade for 4.x users. Your memories, resources, team shares, verified models, and registered agent connections stay in `~/.threadnote`. You do not need to start over or recreate your MCP configuration.',
    },
    {
      type: 'heading',
      text: 'The short version',
    },
    {
      type: 'code',
      language: 'sh',
      code: `# Check what is available without installing it:
threadnote update --check

# Install the latest stable release:
threadnote update

# Confirm that local data and integrations are healthy:
threadnote doctor`,
    },
    {
      type: 'paragraph',
      text: 'The update verifies the release, activates it atomically, runs only the post-update actions that apply to your installation, and repairs Threadnote-owned agent integrations. If no migration is needed, it does not invent one.',
    },
    {
      type: 'note',
      text: 'Read any post-update prompt before accepting it. Threadnote explains the detected work and prints the command you can run later if you choose not to apply it immediately.',
    },
    {
      type: 'heading',
      text: 'What the update handles for you',
    },
    {
      type: 'list',
      items: [
        'Keeps the canonical files under `~/.threadnote`, including personal memory, resources, configured Git shares, and verified model files.',
        'Repairs registered MCP connections, Threadnote instructions, skills, and supported hooks without replacing unrelated agent settings.',
        'Validates derived recall and code-graph data. Disposable indexes can be repaired or rebuilt from canonical files and current repository source.',
        'Keeps existing v4 memories readable. Schema v5 adds optional maintenance fields, but the upgrade does not invent an owner, review date, or expiry date.',
        'Moves brokered MCP sessions to the new version on their next request. If an older direct-server connection needs one host restart, the update tells you.',
      ],
    },
    {
      type: 'heading',
      text: 'What you should not do',
    },
    {
      type: 'list',
      items: [
        'Do not delete or rename `~/.threadnote`. It contains your canonical data and upgrade receipts.',
        'Do not run `threadnote migrate` just because you moved from 4.x to 5. That command is for the old 3.x `~/.openviking` home and specific unfinished early-beta migrations. Run it only when Threadnote detects that work and asks you to.',
        'Do not manually reinstall the MCP connection unless doctor or the update output reports a problem. The normal update repairs registered integrations.',
        'Do not purge indexes as a routine upgrade step. They are derived and repairable, but there is no reason to discard healthy ones.',
        'Do not rewrite every memory to add schema-v5 fields. Existing v4 documents remain valid, and maintenance metadata is optional.',
      ],
    },
    {
      type: 'heading',
      text: 'Setup is optional for existing users',
    },
    {
      type: 'paragraph',
      text: '`threadnote setup` is not the 4.x-to-5.0 migration command. Use it inside a repository when you want Threadnote 5 to check the complete new-user path for that project: repository registration and guidance, the selected agent integration, the code graph, health checks, and a real Context Brief.',
    },
    {
      type: 'code',
      language: 'sh',
      code: `threadnote agents list
# From the repository, preview the plan first:
threadnote setup <surface>
# Apply it only when the preview looks right:
threadnote setup <surface> --apply`,
    },
    {
      type: 'paragraph',
      text: 'Setup is resumable and safe to rerun. If your current agent and repository are already prepared, you can keep working without it. Use setup when you want the new end-to-end verification or when adding a new repository or agent surface.',
    },
    {
      type: 'heading',
      text: 'How the everyday workflow changes',
    },
    {
      type: 'paragraph',
      text: 'Threadnote 5 keeps the familiar recall, read, remember, handoff, sharing, and code-graph tools. The main change is a clearer lifecycle around them: start with focused evidence, finish with a review, and check saved knowledge as the code changes.',
    },
    {
      type: 'table',
      headers: ['If you did this in 4.x', 'Recommended 5.0 workflow'],
      rows: [
        [
          'Search memory after the agent gets stuck',
          'The installed agent guidance automatically starts non-trivial work with a Context Brief: a short, cited briefing with relevant decisions, task state, and current-code evidence.',
        ],
        [
          'Save useful notes directly after a task',
          'Review a Knowledge Delta: a proposed list of decisions, constraints, checks, outdated knowledge, and open risks. Approve, edit, defer, or reject each change.',
        ],
        [
          'Treat all saved notes as equally current',
          'Use context health and Context Check to find stale citations, conflicts, broken links, overdue reviews, and missing evidence.',
        ],
        [
          'Copy the same guidance into several agents',
          'Keep one reviewed decision and explicitly project or share it to supported agents. Repository guidance remains authoritative.',
        ],
        [
          'Use a handoff as long-term documentation',
          'Keep handoffs for current task status. Promote only reusable, reviewed lessons to durable memory.',
        ],
      ],
    },
    {
      type: 'heading',
      text: 'A good first task after upgrading',
    },
    {
      type: 'list',
      items: [
        'Open a fresh agent chat so refreshed instructions and skills are easy to see.',
        'Give the agent one real task. Its refreshed instructions and skills automatically compile the Context Brief; current repository files still win over remembered context.',
        'Work normally with your existing recall and code-graph tools.',
        'At meaningful closeout, review the Knowledge Delta the agent presents and keep only the lessons that will help a later task.',
        'Run context health later when you want to review older saved knowledge; it is not required before your first task.',
      ],
    },
    {
      type: 'note',
      text: 'The optional two-agent journey is still optional. It is a proof that one supported agent can reuse an approved decision from another, not a required migration step. See [Quick-start](threadnote-5-journey/) for the normal one-agent path.',
    },
  ],
};

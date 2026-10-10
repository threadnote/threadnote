import {codexCloudPersonalDocsArticle} from './docsCodexCloudPersonal.js';
import type {DocsSection} from './docsTypes.js';

export const cursorCloudPersonalDocsSection: DocsSection = {
  id: 'personal-cloud-agents',
  title: 'Personal cloud agents',
  description: 'Give personal Cursor and Codex Cloud agents durable Git-backed memory.',
  articles: [
    codexCloudPersonalDocsArticle,
    {
      id: 'personal-cursor-cloud',
      title: 'Personal Cursor Cloud setup',
      summary:
        'Create a personal Cursor environment, bootstrap one or more private Git memory shares, register one stdio MCP, and bake Threadnote skills into every Cloud Agent Build.',
      keywords: [
        'Personal Cursor Cloud',
        'personal environment',
        'personal MCP',
        'multiple shares',
        'Git memory share',
        'Cursor Agent Skills',
        'cursor-cloud-personal',
      ],
      body: [
        {
          type: 'note',
          text: 'This setup is for one Cursor user who does not operate Threadnote’s organization remote-memory service. It registers one personal stdio MCP. That single server can expose up to 16 explicitly configured private Git memory shares; it never exposes other local or shared Threadnote namespaces.',
        },
        {type: 'heading', text: 'How the personal setup fits together'},
        {
          type: 'table',
          headers: ['Part', 'Purpose'],
          rows: [
            [
              'Personal saved environment',
              'Builds the Threadnote binary, Git share checkouts, Cursor rule, and two Agent Skills into the Cloud Agent VM image.',
            ],
            [
              'One personal MCP',
              'Starts `threadnote-mcp-server` over stdio and bounds every memory operation to the configured share set.',
            ],
            [
              'One or more private Git repositories',
              'Persist durable memories across disposable VMs. Each repository is one named Threadnote share.',
            ],
            [
              'Current repository checkout',
              'Supplies current source for verification. This personal memory profile does not prepare code graphs.',
            ],
          ],
        },
        {type: 'heading', text: '1. Create the private memory repositories'},
        {
          type: 'paragraph',
          text: 'Create at least one private Git repository under an account the Git identity connected to Cursor can read and write. Initialize its default `main` branch with a README. A repository may be dedicated to personal memory, a product area, or a client boundary. Do not reuse an application source repository, and do not put access tokens in its URL.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `# Example repositories created in your Git provider:
https://github.com/you/threadnote-memory.git
https://github.com/you/threadnote-docs-memory.git`,
        },
        {
          type: 'warning',
          text: 'The Cursor Cloud Git identity must be able to clone and push every memory repository. “Repository not found” during bootstrap means that identity cannot see the repository, the URL is wrong, or the repository has not been created. A Threadnote share name such as `personal` or `docs` is only a local alias; it is not a Cursor team and does not grant repository access.',
        },
        {type: 'heading', text: '2. Create a personal Cursor Cloud environment'},
        {
          type: 'paragraph',
          text: 'Open the [Cursor Cloud Agents dashboard](https://cursor.com/agents), create a new environment, connect the Git provider, and select the source repository or repository group where you want Threadnote. Save it as your personal environment. Cursor resolves `.cursor/environment.json` before a personal saved environment and a team saved environment after it, so inspect any checked-in environment file if your personal install command does not run. See [Cloud Environment Setup](https://cursor.com/docs/cloud-agent/setup).',
        },
        {
          type: 'paragraph',
          text: 'Use this idempotent environment `install` command. Run one bootstrap command per Git repository. The example creates the `personal` and `docs` shares. Remove the second command if you need only one share.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `set -eu

curl -fsSL https://raw.githubusercontent.com/threadnote/threadnote/main/scripts/install.sh | \\
  sh -s -- --no-start

"$HOME/.local/bin/threadnote" cloud cursor bootstrap \\
  --remote https://github.com/you/threadnote-memory.git \\
  --team personal \\
  --user cursor-cloud \\
  --agent-id cursor-cloud

"$HOME/.local/bin/threadnote" cloud cursor bootstrap \\
  --remote https://github.com/you/threadnote-docs-memory.git \\
  --team docs \\
  --user cursor-cloud \\
  --agent-id cursor-cloud

test -x "$HOME/.local/bin/threadnote-mcp-server"
test -f "$HOME/.cursor/rules/threadnote.mdc"
test -f "$HOME/.cursor/skills/threadnote-context/SKILL.md"
test -f "$HOME/.cursor/skills/threadnote-memory/SKILL.md"`,
        },
        {
          type: 'paragraph',
          text: 'Trigger a Build, inspect its install log, and make the successful Build active. The first non-dry-run bootstrap persists the selected account, user, and agent identity in `~/.threadnote/cursor-cloud/profile.json` before cloning the share. Later CLI commands and an MCP process without explicit identity variables inherit that profile instead of the Cloud VM’s generic `ubuntu` user. Use the same `--user` and `--agent-id` for every share in one Threadnote home. Bootstrap is safe to rerun when a share already points at the same credential-free remote with read-write access. Cursor’s install command runs during the Build and the resulting disk state is saved for later agents.',
        },
        {type: 'heading', text: 'Why bootstrap installs skills'},
        {
          type: 'paragraph',
          text: 'Cursor 4.6 discovers user-level skills under `~/.cursor/skills`, but it does not copy the skills from your laptop into Cloud Agents. Personal bootstrap therefore writes a Cloud-safe always-on rule plus `threadnote-context` and `threadnote-memory` into the VM during the Build. The skills describe the actual personal toolset: multiple bounded shares, explicit write selection and VM-local handoffs. See [Cursor Agent Skills](https://cursor.com/docs/skills).',
        },
        {
          type: 'warning',
          text: 'Do not run `threadnote mcp-install cursor --apply` in this environment. That command manages the local Cursor desktop MCP file. Personal Cloud MCP registration belongs in the Cloud Agent UI; bootstrap installs only the in-VM runtime, rule, and skills.',
        },
        {type: 'heading', text: '3. Generate one personal MCP configuration'},
        {
          type: 'paragraph',
          text: 'Run the configuration command from any trusted Threadnote installation. Repeat `--team` in exactly the set the environment bootstrapped. Ordering and duplicates are normalized, so the same set produces the same configuration.',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote cloud cursor config \\
  --team personal \\
  --team docs \\
  --user cursor-cloud \\
  --agent-id cursor-cloud`,
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "type": "stdio",
  "command": "/bin/sh",
  "args": ["-lc", "exec \\"$HOME/.local/bin/threadnote-mcp-server\\""],
  "env": {
    "THREADNOTE_ACCOUNT": "local",
    "THREADNOTE_AGENT_ID": "cursor-cloud",
    "THREADNOTE_CURSOR_CLOUD_TEAM": "docs",
    "THREADNOTE_CURSOR_CLOUD_TEAMS": "[\\"docs\\",\\"personal\\"]",
    "THREADNOTE_MCP_TOOLSET": "cursor-cloud-personal",
    "THREADNOTE_USER": "cursor-cloud"
  }
}`,
        },
        {
          type: 'paragraph',
          text: 'In [cursor.com/agents](https://cursor.com/agents), open the MCP dropdown, add a personal MCP server named `threadnote`, paste the generated stdio configuration, save it, and enable it for the agent. Register exactly one Threadnote personal MCP even when it exposes several shares. Cursor starts stdio servers inside the Cloud Agent VM, so the active Build must already contain the binary and share state. See [Cursor Cloud Agent capabilities](https://cursor.com/docs/cloud-agent/capabilities).',
        },
        {type: 'heading', text: '4. Verify from a fresh Cloud Agent'},
        {
          type: 'code',
          language: 'sh',
          code: `threadnote cloud cursor verify \\
  --team personal \\
  --team docs \\
  --user cursor-cloud \\
  --agent-id cursor-cloud \\
  --cwd "$PWD" \\
  --json

threadnote doctor --dry-run`,
        },
        {
          type: 'list',
          items: [
            'The verification receipt must report status `ok`, version `2`, and both `teams` and `memoryRoots`.',
            'The MCP tool list must include `recall_context`, `read_context`, `list_context`, `remember_context`. Graph tools are unavailable in this memory-only profile.',
            'Ask the agent to recall a harmless test phrase, store one durable smoke memory with an explicit `team`, read the returned URI, and confirm that commit appears only in the selected Git repository.',
            'Delete or archive the smoke memory through the normal reviewed workflow; never use credentials or production data as a test value.',
          ],
        },
        {type: 'heading', text: 'Using multiple shares'},
        {
          type: 'table',
          headers: ['Operation', 'Selection rule'],
          rows: [
            ['`recall_context`', 'Omit `team` to search every configured share, or pass `team` to narrow recall.'],
            [
              '`read_context`',
              'Read returned URIs from any configured share; all other memory namespaces are rejected.',
            ],
            [
              '`list_context`',
              'With several shares, pass `team` or an exact in-scope `uri`; there is no ambiguous default listing.',
            ],
            [
              '`remember_context` durable',
              'Pass `team` when several shares are configured. References, relations, replacement, commit, and push stay inside that one share.',
            ],
            [
              '`remember_context` handoff',
              'Stays VM-local and may disappear when the Cloud Agent is replaced; use a sanitized durable record when the next session must receive it.',
            ],
          ],
        },
        {type: 'heading', text: 'Troubleshooting'},
        {
          type: 'table',
          headers: ['Symptom', 'Fix'],
          rows: [
            [
              '`team … is not configured` or MCP discovery fails',
              'On current releases MCP discovery remains available while bootstrap is still cloning shares, and recall reports a temporary readiness warning. Wait for the Build to finish and retry. If the warning remains, rerun bootstrap for that exact `--team`, rebuild the environment, then regenerate the one MCP configuration with the same repeated team set.',
            ],
            [
              '`0 canonical documents` or `Resource user scope does not match`',
              'The share was ingested under one Threadnote user but this process selected another. Rerun each bootstrap with the original stable `--user` and `--agent-id`, then regenerate the MCP configuration with those same values. Bootstrap persists that identity so later CLI, index, doctor, and MCP processes do not fall back to `ubuntu`.',
            ],
            [
              '`repository not found`',
              'Confirm the remote exists and the Git identity connected to this personal Cursor environment has read-write access. The share alias cannot grant access.',
            ],
            [
              '`remember_context requires team`',
              'More than one share is active. Choose the intended configured share explicitly instead of relying on a default.',
            ],
            [
              'MCP tools are missing but the CLI works',
              'Open the Cloud Agent MCP dropdown, enable the personal `threadnote` server, and start a new agent on the latest successful Build. Do not add a second Threadnote server.',
            ],
            [
              'Skills are missing',
              'Check the Build install log and the five `test -f`/`test -x` checks. Local laptop skills are not copied to Cloud Agents.',
            ],
          ],
        },
      ],
    },
  ],
};

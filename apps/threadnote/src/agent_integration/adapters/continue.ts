import {defineJsonAgentAdapter} from '../surfaces.js';

export const continueAdapter = defineJsonAgentAdapter(
  'continue-project',
  {
    root: '.continue',
    defaultScope: 'project',
    mcpFile: 'mcpServers/threadnote.json',
    container: 'mcpServers',
    instructionFile: 'rules/threadnote.md',
    instructionPrefix: '---\nname: Threadnote\nalwaysApply: true\n---\n\n',
    instructionContent:
      'Route by situation: fresh/lost -> MCP `context_brief` task + absolute `callerCwd` (CLI: `threadnote context brief --cwd <cwd> --task <task>`); handoff/new session -> `mode=resume`; warm sufficient -> no bootstrap. Memory -> `recall_context` then `read_context`; unfamiliar relationships/evidence gaps/repo instructions -> `inspect_code_graph`/`analyze_code_graph`; exact paths/literals -> source. Verify exact source; repo guidance authoritative. End private `remember_context(kind=handoff)`. `review_session_context` optional five-field Knowledge Delta -> `apply_memory_candidates` only after `approve` (`editedText` optional), `defer`, or `reject`; never auto-apply/share, confirm durable sharing. Never store secrets, credentials, customer data, or raw production logs.',
    skillRoot: 'none',
  },
  {
    importDirectories: [{extensions: ['.md'], relativePath: '.continue/rules'}],
    importPaths: ['.continue/rules/threadnote-guidance.md', '.continue/rules/threadnote.md'],
    importWrappers: [
      {prefix: '---\nname: Threadnote guidance\nalwaysApply: true\n---\n\n', suffix: ''},
      {prefix: '---\nname: Threadnote\nalwaysApply: true\n---\n\n', suffix: ''},
    ],
    projection: {
      relativePath: '.continue/rules/threadnote-guidance.md',
      wrapper: {
        prefix: '---\nname: Threadnote guidance\nalwaysApply: true\n---\n\n',
        required: true,
        suffix: '',
      },
    },
  },
);

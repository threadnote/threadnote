import {defineJsonAgentAdapter} from '../surfaces.js';

/** Zeno 1.0.10 isolates OpenCode's XDG roots and migrates v1 documents at load. */
export const zenoAdapter = defineJsonAgentAdapter(
  'zeno-desktop',
  {
    root: 'Library/Application Support/ai.zeno.desktop/config/opencode',
    rootEnvironment: 'OPENCODE_CONFIG_DIR',
    mcpFile: 'opencode.json',
    mcpFileAlternatives: ['opencode.jsonc'],
    codec: 'jsonc',
    container: ['mcp', 'servers'],
    enablement: 'disabled',
    legacySchema: {
      // Keep this aligned with the bundled ConfigMigrateV1.isV1 discriminator.
      keys: [
        'logLevel',
        'server',
        'command',
        'reference',
        'snapshot',
        'plugin',
        'autoshare',
        'disabled_providers',
        'enabled_providers',
        'small_model',
        'mode',
        'agent',
        'provider',
        'permission',
        'tools',
        'attachment',
        'layout',
      ],
      container: 'mcp',
      enablement: 'enabled',
      emptyDocument: {tools: {}},
    },
    commandArray: true,
    entryType: 'local',
    instructionFile: 'AGENTS.md',
    skillRoot: 'native',
  },
  {
    importMode: 'first-existing',
    importPaths: ['AGENTS.md', 'CLAUDE.md'],
    projection: {relativePath: 'AGENTS.md'},
  },
);

import {defineJsonAgentAdapter} from '../surfaces.js';

/** OpenCode's documented flat MCP schema, also consumed by Zeno. */
export const opencodeAdapter = defineJsonAgentAdapter(
  'opencode',
  {
    root: 'opencode',
    rootEnvironment: 'OPENCODE_CONFIG_DIR',
    xdg: true,
    projectRoot: '',
    mcpFile: 'opencode.json',
    mcpFileAlternatives: ['opencode.jsonc'],
    codec: 'jsonc',
    container: 'mcp',
    commandArray: true,
    entryType: 'local',
    instructionFile: 'AGENTS.md',
    skillRoot: 'native',
    projectSkillRoot: '.opencode/skills',
  },
  {
    importMode: 'first-existing',
    importPaths: ['AGENTS.md', 'CLAUDE.md'],
    projection: {relativePath: 'AGENTS.md'},
  },
);

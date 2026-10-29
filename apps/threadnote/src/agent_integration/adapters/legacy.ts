import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {runMcpInstall} from '../../mcp/install.js';
import type {AgentClient} from '../../types.js';
import {readAgentIntegrationRegistry} from '../registry.js';
import {AgentAdapterActionError, type AgentAdapterActionOptions, type AgentAdapterDefinition} from './contract.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export {LEGACY_ARTIFACT_TARGETS} from './legacy_targets.js';

const guidanceByAdapter: Readonly<Record<string, NonNullable<AgentAdapterDefinition['guidance']>>> = {
  'codex-cli': {importPaths: ['AGENTS.md'], projection: {relativePath: 'AGENTS.md'}},
  'claude-code': {
    importMode: 'first-existing',
    importPaths: ['CLAUDE.md', '.claude/CLAUDE.md'],
    projection: {relativePath: 'CLAUDE.md'},
  },
  'cursor-desktop': {
    importDirectories: [{extensions: ['.md', '.mdc'], relativePath: '.cursor/rules'}],
    importPaths: ['.cursor/rules/threadnote.mdc', '.cursorrules'],
    importWrappers: [
      {
        prefix:
          '---\ndescription: Route non-trivial work through installed Threadnote skills\nglobs:\nalwaysApply: true\n---\n\n',
        suffix: '',
      },
    ],
    projection: {
      relativePath: '.cursor/rules/threadnote.mdc',
      wrapper: {
        prefix: '---\ndescription: Threadnote project guidance\nalwaysApply: true\n---\n\n',
        required: true,
        suffix: '',
      },
    },
  },
  'copilot-vscode': {
    importDirectories: [{extensions: ['.instructions.md'], relativePath: '.github/instructions'}],
    importPaths: ['.github/copilot-instructions.md', '.github/instructions/threadnote.instructions.md'],
    importWrappers: [
      {
        prefix:
          '---\nname: Threadnote\ndescription: Route non-trivial work through installed Threadnote skills\napplyTo: "**"\n---\n\n',
        suffix: '',
      },
    ],
    projection: {
      relativePath: '.github/instructions/threadnote.instructions.md',
      wrapper: {prefix: '---\napplyTo: "**"\n---\n\n', required: true, suffix: ''},
    },
  },
  'omp-agent': {
    importMode: 'first-existing',
    importPaths: ['.omp/AGENTS.md', 'AGENTS.md'],
    projection: {relativePath: '.omp/AGENTS.md'},
  },
};

function defineLegacyAgentAdapter(id: string, legacyClient: AgentClient): AgentAdapterDefinition {
  const receipt = (options: AgentAdapterActionOptions) => options.registry?.hosts[legacyClient] ?? undefined;
  const install = (config: Parameters<AgentAdapterDefinition['actions']['install']>[0]) =>
    runMcpInstall(config, legacyClient, {apply: false});
  const repair: AgentAdapterDefinition['actions']['repair'] = (config, adapter, options) =>
    Effect.gen(function* () {
      const current = receipt(options) ?? (yield* readAgentIntegrationRegistry(config))?.hosts[legacyClient];
      if (!current)
        return yield* AgentAdapterActionError.make({
          message: `No receipt for ${adapter.catalog.id}; use agents install.`,
        });
      yield* runMcpInstall(config, legacyClient, {
        apply: options.apply,
        name: current.mcp.name,
        hostRoot: current.mcp.hostRoot,
        cwd: current.mcp.cwd,
        project: current.mcp.cwd,
        scope: current.mcp.scope,
        setupLockHeld: options.setupLockHeld,
        toolset: current.mcp.toolset,
      });
    });
  return {
    actions: {
      install: (config, _adapter, options) =>
        options.apply
          ? runMcpInstall(config, legacyClient, {apply: true, setupLockHeld: options.setupLockHeld})
          : install(config),
      remove: (_config, _adapter, _options) =>
        AgentAdapterActionError.make({
          message: 'Compatibility surfaces use threadnote uninstall for removal; per-surface removal is not available.',
        }),
      repair,
      status: (_config, _adapter, context) => {
        const current = context.registry?.hosts[legacyClient];
        if (!current) return Effect.succeed({state: 'absent' as const, detail: 'No managed receipt.'});
        const checks = [...context.legacyChecks, ...context.mcpChecks];
        return Effect.succeed({
          state:
            current.status === 'current' &&
            EffectArray.every(
              EffectArray.filter(checks, check =>
                Effect2.pipe(check.name, EffectString.startsWith(`${legacyClient} `)),
              ),
              check => check.status === 'ok',
            )
              ? ('current' as const)
              : ('stale' as const),
          detail: 'Compatibility adapter; see threadnote doctor for detailed checks.',
        });
      },
    },
    adapterVersion: 1,
    hooks: {client: legacyClient, kind: 'legacy-client'},
    guidance: guidanceByAdapter[id],
    id,
    kind: 'legacy',
    legacyClient,
  };
}

export const legacyAdapterDefinitions: readonly AgentAdapterDefinition[] = [
  defineLegacyAgentAdapter('codex-cli', 'codex'),
  defineLegacyAgentAdapter('claude-code', 'claude'),
  defineLegacyAgentAdapter('cursor-desktop', 'cursor'),
  defineLegacyAgentAdapter('copilot-vscode', 'copilot'),
  defineLegacyAgentAdapter('omp-agent', 'omp'),
];

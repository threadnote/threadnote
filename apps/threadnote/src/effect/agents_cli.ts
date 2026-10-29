import {Array as EffectArray} from 'effect';
import {composeWorkflowSetup, setupWorkflowSelector} from '../setup/workflows.js';
import {Clock, Console, DateTime, Effect} from 'effect';
import {Argument, Command} from 'effect/cli';
import {AGENT_ADAPTERS, getAgentAdapter} from '../agent_integration/adapters.js';
import {agentAdapterStatuses, runAgentAdapterAction} from '../agent_integration/adapter_actions.js';
import type {AgentAdapter, AgentAdapterAction} from '../agent_integration/adapters/contract.js';
import {AGENT_CATALOG} from '@threadnote/integrations/catalog';
import {isAgentSetupCompletion} from '../agent_integration/registry.js';
import {AgentSurfaceError} from '../agent_integration/surfaces.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {CliRuntimeRunner} from './cli.js';
import {recordSetupCompletionValueEvent} from '../value_report/events.js';
import {boolean, optionalChoice} from './cli/flags.js';

export const agentsCommandMetadata = {
  productionLog: {
    subcommands: {
      list: 'never',
      status: 'never',
      install: 'requires-apply',
      repair: 'requires-apply',
      remove: 'requires-apply',
    },
  },
} as const;

export const runAgentCliAction = Effect.fn('agents.cliAction')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
  action: AgentAdapterAction,
  apply: boolean,
  scope?: 'user' | 'project' | 'local',
  noDevSkills = false,
) {
  const result = yield* action === 'install'
    ? composeWorkflowSetup(
        config,
        setupWorkflowSelector(adapter.catalog.id, scope),
        {apply, noDevSkills, key: `agents:${adapter.catalog.id}`},
        lease => runAgentAdapterAction(config, adapter, action, apply, scope, undefined, lease !== undefined),
      )
    : runAgentAdapterAction(config, adapter, action, apply, scope);
  if (action === 'install' && apply && isAgentSetupCompletion(result)) {
    const timestamp = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* recordSetupCompletionValueEvent(config.agentContextHome, {
      supportedAgentReuse: result.supportedAgentReuse,
      timestamp,
    }).pipe(Effect.ignore);
  }
  return result;
});

export function makeAgentsCommand(withRuntime: CliRuntimeRunner) {
  const catalog = AGENT_CATALOG;
  const list = Command.make('list', {json: boolean('json', 'Print the canonical support catalog as JSON')}, ({json}) =>
    Console.log(
      json
        ? JSON.stringify({version: 1, agents: catalog}, undefined, 2)
        : EffectArray.join(
            EffectArray.map(
              catalog,
              entry =>
                `${entry.id}\t${entry.tier}\t${entry.displayName}\n  ${EffectArray.join(entry.setup, ' ')}\n  Project guidance: ${
                  entry.projectGuidance.status === 'managed'
                    ? entry.projectGuidance.targetPath
                    : entry.projectGuidance.reason
                }`,
            ),
            '\n',
          ),
    ),
  );
  const status = Command.make('status', {json: boolean('json', 'Print installed surface status as JSON')}, ({json}) =>
    withRuntime(
      Effect.fn(function* (config: RuntimeConfig) {
        const agents = yield* agentAdapterStatuses(config, AGENT_ADAPTERS);
        yield* Console.log(
          json
            ? JSON.stringify({version: 1, agents}, undefined, 2)
            : EffectArray.join(
                EffectArray.map(agents, agent => `${agent.id}\t${agent.state}\t${agent.detail}`),
                '\n',
              ),
        );
      }),
    ),
  );
  const actions = EffectArray.map(['install', 'repair', 'remove'] as const, action =>
    Command.make(
      action,
      {
        surface: Argument.String('surface'),
        apply: boolean('apply', 'Apply the plan; otherwise only preview paths'),
        noDevSkills: boolean('no-dev-skills', 'Persist disabled workflow enrollment during installation'),
        scope: optionalChoice(
          'scope',
          ['user', 'project', 'local'],
          'Installation scope; repair and removal use the receipt',
        ),
      },
      ({surface, apply, scope, noDevSkills}) =>
        withRuntime(
          Effect.fn(function* (config: RuntimeConfig) {
            const adapter = getAgentAdapter(surface);
            if (!adapter)
              return yield* AgentSurfaceError.make({
                message: `Unknown surface ${surface}; run threadnote agents list.`,
              });
            if (scope && (adapter.legacyClient || action !== 'install'))
              return yield* AgentSurfaceError.make({
                message:
                  '--scope is supported only by managed surface installation; repair and removal use the receipt.',
              });
            yield* runAgentCliAction(config, adapter, action, apply, scope, noDevSkills);
          }),
        ),
    ),
  );
  return Command.make('agents').pipe(
    Command.withDescription('Inspect the support catalog and manage concrete agent surfaces'),
    Command.withSubcommands([list, status, ...actions]),
  );
}

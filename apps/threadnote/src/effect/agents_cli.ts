import {Clock, Console, DateTime, Effect} from 'effect';
import {Argument, Command} from 'effect/cli';
import {AGENT_ADAPTERS, getAgentAdapter} from '../agent_integration/adapters.js';
import {agentAdapterStatuses, runAgentAdapterAction} from '../agent_integration/adapter_actions.js';
import type {AgentAdapter, AgentAdapterAction} from '../agent_integration/adapters/contract.js';
import {AGENT_CATALOG} from '@threadnote/integrations/catalog';
import {isAgentSetupCompletion} from '../agent_integration/registry.js';
import {AgentSurfaceError} from '../agent_integration/surfaces.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
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
) {
  const result = yield* runAgentAdapterAction(config, adapter, action, apply, scope);
  if (action === 'install' && apply && isAgentSetupCompletion(result)) {
    const timestamp = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* recordSetupCompletionValueEvent(config.agentContextHome, {
      supportedAgentReuse: result.supportedAgentReuse,
      timestamp,
    }).pipe(Effect.ignore);
  }
  return result;
});

export function makeAgentsCommand(
  withRuntime: <E, R>(body: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  const catalog = AGENT_CATALOG;
  const list = Command.make('list', {json: boolean('json', 'Print the canonical support catalog as JSON')}, ({json}) =>
    Console.log(
      json
        ? JSON.stringify({version: 1, agents: catalog}, undefined, 2)
        : catalog
            .map(
              entry =>
                `${entry.id}\t${entry.tier}\t${entry.displayName}\n  ${entry.setup.join(' ')}\n  Project guidance: ${
                  entry.projectGuidance.status === 'managed'
                    ? entry.projectGuidance.targetPath
                    : entry.projectGuidance.reason
                }`,
            )
            .join('\n'),
    ),
  );
  const status = Command.make('status', {json: boolean('json', 'Print installed surface status as JSON')}, ({json}) =>
    withRuntime(
      Effect.fn(function* (config: RuntimeConfig) {
        const agents = yield* agentAdapterStatuses(config, AGENT_ADAPTERS);
        yield* Console.log(
          json
            ? JSON.stringify({version: 1, agents}, undefined, 2)
            : agents.map(agent => `${agent.id}\t${agent.state}\t${agent.detail}`).join('\n'),
        );
      }),
    ),
  );
  const actions = (['install', 'repair', 'remove'] as const).map(action =>
    Command.make(
      action,
      {
        surface: Argument.String('surface'),
        apply: boolean('apply', 'Apply the plan; otherwise only preview paths'),
        scope: optionalChoice(
          'scope',
          ['user', 'project', 'local'],
          'Installation scope; repair and removal use the receipt',
        ),
      },
      ({surface, apply, scope}) =>
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
            yield* runAgentCliAction(config, adapter, action, apply, scope);
          }),
        ),
    ),
  );
  return Command.make('agents').pipe(
    Command.withDescription('Inspect the support catalog and manage concrete agent surfaces'),
    Command.withSubcommands([list, status, ...actions]),
  );
}

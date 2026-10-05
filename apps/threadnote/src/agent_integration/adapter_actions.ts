import {Effect} from 'effect';
import {mcpConfigurationChecks} from '../mcp/install.js';
import {withSetupMutationLock} from '../setup/lock.js';
import type {AgentClient, DoctorCheck} from '../types.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {AGENT_ADAPTERS, getAgentAdapter} from './adapters.js';
import type {AgentAdapter, AgentAdapterAction, AgentAdapterStatusContext} from './adapters/contract.js';
import {agentIntegrationDoctorChecks} from './index.js';
import {
  isAgentSetupCompletion,
  readAgentIntegrationRegistry,
  type AgentIntegrationRegistry,
  type AgentSetupCompletion,
} from './registry.js';

const makeStatusContext = Effect.fn('agentAdapters.statusContext')(function* (
  config: RuntimeConfig,
  inferredClients: readonly AgentClient[] = [],
  includeMcpChecks = true,
) {
  const registry = yield* readAgentIntegrationRegistry(config);
  const legacyChecks = yield* agentIntegrationDoctorChecks(config, inferredClients);
  const mcpChecks = includeMcpChecks ? yield* mcpConfigurationChecks(config, inferredClients) : [];
  return {registry, legacyChecks, mcpChecks} satisfies AgentAdapterStatusContext;
});

export function runAgentAdapterAction(
  config: RuntimeConfig,
  adapter: AgentAdapter,
  action: AgentAdapterAction,
  apply: boolean,
  scope?: 'user' | 'project' | 'local',
  cwd?: string,
  setupLockHeld = false,
) {
  const operation = adapter.actions[action](config, adapter, {
    apply,
    cwd,
    scope,
    setupLockHeld: apply,
  });
  return !apply || setupLockHeld ? operation : withSetupMutationLock(config.agentContextHome, operation);
}

export const agentAdapterStatuses = Effect.fn('agentAdapters.statuses')(function* (
  config: RuntimeConfig,
  adapters: readonly AgentAdapter[] = AGENT_ADAPTERS,
) {
  const context = yield* makeStatusContext(config);
  const statuses = [];
  for (const adapter of adapters) {
    statuses.push({id: adapter.catalog.id, ...(yield* adapter.actions.status(config, adapter, context))});
  }
  return statuses;
});

export const agentAdapterStatus = Effect.fn('agentAdapters.status')(function* (
  config: RuntimeConfig,
  adapter: AgentAdapter,
) {
  const context = yield* makeStatusContext(config);
  return yield* adapter.actions.status(config, adapter, context);
});

export const repairRegisteredAgentAdapters = Effect.fn('agentAdapters.repairRegistered')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
) {
  const operation = Effect.gen(function* () {
    const registry = yield* readAgentIntegrationRegistry(config);
    for (const id of Object.keys(registry?.surfaces ?? {})) {
      const adapter = getAgentAdapter(id);
      if (adapter)
        yield* adapter.actions.repair(config, adapter, {
          apply: !dryRun,
          registry,
          setupLockHeld: !dryRun,
        });
    }
  });
  yield* dryRun ? operation : withSetupMutationLock(config.agentContextHome, operation);
});

export const removeRegisteredAgentAdaptersInTransaction = Effect.fn('agentAdapters.removeRegistered')(function* (
  config: RuntimeConfig,
  dryRun: boolean,
  removeLegacyConsumers = false,
) {
  let registry = yield* readAgentIntegrationRegistry(config);
  if (!registry) return;
  const excludedConsumers = new Set(removeLegacyConsumers ? Object.keys(registry.hosts).map(id => `legacy:${id}`) : []);
  for (const id of Object.keys(registry.surfaces ?? {})) {
    const adapter = getAgentAdapter(id);
    if (!adapter) continue;
    const next: AgentIntegrationRegistry | AgentSetupCompletion | void = yield* adapter.actions.remove(
      config,
      adapter,
      {
        apply: !dryRun,
        excludedConsumers,
        inTransaction: true,
        registry,
        setupLockHeld: !dryRun,
      },
    );
    if (next && !isAgentSetupCompletion(next)) registry = next;
  }
});

export const agentAdapterDoctorChecks = Effect.fn('agentAdapters.doctor')(function* (
  config: RuntimeConfig,
  inferredClients: readonly AgentClient[] = [],
  options: {readonly includeRetainedUnsupported?: boolean} = {},
) {
  const context = yield* makeStatusContext(config, inferredClients, false);
  const checks: DoctorCheck[] = [...context.legacyChecks];
  for (const id of Object.keys(context.registry?.surfaces ?? {})) {
    const adapter = getAgentAdapter(id);
    if (!adapter && options.includeRetainedUnsupported === false) continue;
    const result = adapter
      ? yield* adapter.actions.status(config, adapter, context)
      : {state: 'unsupported', detail: 'Adapter no longer registered; receipt retained.'};
    checks.push({
      name: `${id} agent surface`,
      status: result.state === 'current' ? 'ok' : 'warn',
      detail: `${result.state}: ${result.detail}`,
    });
  }
  return checks;
});

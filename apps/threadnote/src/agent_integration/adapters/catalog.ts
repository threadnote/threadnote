import {Effect} from 'effect';
import {AgentAdapterActionError, type AgentAdapterDefinition, type AgentAdapterMutation} from './contract.js';
import {Array as EffectArray} from 'effect';

const unsupported: AgentAdapterMutation = (_config, adapter) =>
  AgentAdapterActionError.make({
    message: `${adapter.catalog.id} is catalog-only; review its capability reasons and setup guidance.`,
  });

export function defineCatalogAgentAdapter(id: string): AgentAdapterDefinition {
  return {
    actions: {
      install: unsupported,
      remove: unsupported,
      repair: unsupported,
      status: (_config, adapter) =>
        Effect.succeed({
          state: adapter.catalog.tier === 'manual' ? 'manual' : 'unsupported',
          detail: EffectArray.join(adapter.catalog.caveats, ' '),
        }),
    },
    adapterVersion: 1,
    id,
    kind: 'catalog',
  };
}

import {Array as EffectArray, Option as EffectOption} from 'effect';
import {AGENT_CATALOG, findAgentSurface} from '@threadnote/integrations/catalog';
import {defineCatalogAgentAdapter} from './adapters/catalog.js';
import {
  LEGACY_ARTIFACT_TARGETS,
  managedAgentAdapterDefinitions,
  type AgentAdapter,
  type AgentAdapterDefinition,
  type JsonAgentStrategy,
} from './adapters/index.js';

const definitions = new Map(EffectArray.map(managedAgentAdapterDefinitions, definition => [definition.id, definition]));

export const AGENT_ADAPTERS: readonly AgentAdapter[] = EffectArray.map(AGENT_CATALOG, catalog => {
  const definition: AgentAdapterDefinition = definitions.get(catalog.id) ?? defineCatalogAgentAdapter(catalog.id);
  return {...definition, catalog};
});

export {LEGACY_ARTIFACT_TARGETS};
export type {AgentAdapter, JsonAgentStrategy};

export function getAgentAdapter(selector: string): AgentAdapter | undefined {
  const entry = findAgentSurface(selector);
  return EffectOption.getOrUndefined(
    EffectArray.findFirst(AGENT_ADAPTERS, adapter => adapter.catalog.id === entry?.id),
  );
}

export {jsonServerDisabled} from './json_config.js';

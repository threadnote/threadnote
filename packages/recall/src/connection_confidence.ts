import type {RecallConfidence} from './rank.js';
import type {RecallMemoryConnectionsResult} from './memory/connections.js';
import {Array as EffectArray} from 'effect';

export const EXPLICIT_MEMORY_CONNECTION_CONFIDENCE_BASIS = 'explicit-memory-connection' as const;

export function explicitMemoryConnectionNavigationConfidence(): RecallConfidence {
  return {
    level: 'high',
    margin: 1,
    reason: 'Verified one-hop relation; confidence covers navigation only, not entailment.',
    score: 1,
  };
}

export function actionableMemoryConnectionUris(
  memoryConnections: Pick<RecallMemoryConnectionsResult, 'connections' | 'premises'> | undefined,
  allowedUris?: ReadonlySet<string>,
): readonly string[] {
  if (memoryConnections === undefined) return [];
  const actionablePremiseOrdinals = new Set(
    EffectArray.flatMap(memoryConnections.premises, premise =>
      premise.state === 'current' || premise.state === 'historical' ? [premise.requestedOrdinal] : [],
    ),
  );
  const selected = new Set<string>();
  for (const connection of memoryConnections.connections) {
    const uri = connection.neighborUri;
    if (
      connection.resolution !== 'resolved' ||
      (connection.currentness !== 'current' && connection.currentness !== 'historical') ||
      !actionablePremiseOrdinals.has(connection.requestedOrdinal) ||
      uri === undefined ||
      (allowedUris !== undefined && !allowedUris.has(uri))
    ) {
      continue;
    }
    selected.add(uri);
  }
  return [...selected];
}

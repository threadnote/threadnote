import {Array as EffectArray} from 'effect';
import {isExternalResourceUri} from '@threadnote/store/external-resource';
import type {RecallLexicalRefreshOutcome, RecallLexicalRefreshReason} from '../diagnostics.js';
import {
  recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh,
  recallInventoryPolicyIsCurrent,
} from './freshness.js';
import {recallIndexMetadataIsCurrent} from './identity.js';
import type {RecallStaleMarker} from './stale_marker.js';

const reasonIf = (condition: boolean, reason: RecallLexicalRefreshReason) => (condition ? [reason] : []);

/** Any reason reindexes every source. */
export const recallRefreshForceReasons = (requested: boolean, metadata: ReadonlyMap<string, string>) => [
  ...reasonIf(requested, 'requested'),
  ...reasonIf(!recallIndexMetadataIsCurrent(metadata), 'integrity'),
  ...reasonIf(!recallInventoryPolicyIsCurrent(metadata), 'inventory-policy'),
];

/** An empty result admits a touched refresh limited to the marker's invalidated URIs. */
export function recallIncrementalRefreshBlockers(input: {
  readonly forceReasons: readonly RecallLexicalRefreshReason[];
  readonly scopeCurrent: boolean;
  readonly sourcePolicyCurrent: boolean;
  readonly externalDocuments: boolean;
  readonly marker: RecallStaleMarker | undefined;
  readonly metadata: ReadonlyMap<string, string>;
  readonly observedCanonicalMutationGeneration: string;
}): readonly RecallLexicalRefreshReason[] {
  const {marker, metadata} = input;
  const uris = new Set(marker?.invalidatedUris ?? []);
  return [
    ...input.forceReasons,
    ...reasonIf(!input.scopeCurrent, 'logical-scope'),
    ...reasonIf(!input.sourcePolicyCurrent, 'source-policy'),
    ...reasonIf(input.externalDocuments || EffectArray.some([...uris], isExternalResourceUri), 'external-resources'),
    ...reasonIf(marker?.forceRefresh === true, 'marker-forced'),
    ...(marker === undefined || marker.generation === metadata.get('stale_generation') || uris.size === 0
      ? ['no-invalidations' as const]
      : reasonIf(uris.size > 1024, 'invalidations-overflow')),
    ...reasonIf(
      !recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh({
        markerCurrentGeneration: marker?.canonicalMutationGeneration,
        markerPreviousGeneration: marker?.previousCanonicalMutationGeneration,
        observedGeneration: input.observedCanonicalMutationGeneration,
        persistedGeneration: metadata.get('canonical_mutation_generation') ?? '',
      }),
      'canonical-discontinuity',
    ),
  ];
}

export function recallPublishedRefreshOutcome(
  blockers: readonly RecallLexicalRefreshReason[],
  recovery: boolean,
  marker: RecallStaleMarker | undefined,
  prepared: {
    readonly forceAllSources: boolean;
    readonly refreshCounts: {readonly changedSourceCount: number; readonly removedSourceCount: number};
    readonly sourceScan: {readonly forceAllSources: boolean; readonly mode: 'full' | 'touched'};
  },
  documentCount: number,
): RecallLexicalRefreshOutcome {
  return {
    decision: prepared.sourceScan.mode === 'touched' ? 'incremental' : prepared.forceAllSources ? 'forced' : 'full',
    reasons: [
      ...blockers,
      ...reasonIf(recovery, 'recovery'),
      ...reasonIf(prepared.sourceScan.forceAllSources, 'touched-fallback'),
    ],
    invalidatedUriCount: marker?.invalidatedUris.length ?? 0,
    changedSourceCount: prepared.refreshCounts.changedSourceCount,
    removedSourceCount: prepared.refreshCounts.removedSourceCount,
    documentCount,
  };
}

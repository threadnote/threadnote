import {Effect} from 'effect';
import {
  refreshRecallDerivedIndexesFromSelection,
  type DerivedIndexRefreshOutcome,
} from '@threadnote/recall/mcp/refresh';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {finalizeDeferredCodeAnchors, type DeferredCodeAnchorFinalizationReceiptV1} from './code_anchor.js';
import {Array as EffectArray} from 'effect';

export interface DeferredCodeAnchorExplicitFinalizationReceipt extends DeferredCodeAnchorFinalizationReceiptV1 {
  readonly derivedIndexes?: DerivedIndexRefreshOutcome;
}

export function finalizedDeferredCodeAnchorUris(
  items: readonly DeferredCodeAnchorFinalizationReceiptV1['items'][number][],
): readonly string[] {
  return [
    ...new Set(
      EffectArray.flatMap(items, item => (item.state === 'finalized' && item.memoryUri ? [item.memoryUri] : [])),
    ),
  ];
}

/** One post-batch repair preserves citation finality while reporting index readiness honestly. */
export const finalizeDeferredCodeAnchorsWithDerivedIndexes = Effect.fn('memoryCodeAnchor.finalizeWithDerivedIndexes')(
  function* (config: RuntimeConfig, options: {readonly limit?: number; readonly uris?: readonly string[]} = {}) {
    const receipt = yield* finalizeDeferredCodeAnchors(config, options);
    const finalizedUris = finalizedDeferredCodeAnchorUris(receipt.items);
    if (finalizedUris.length === 0) {
      return {...receipt, derivedIndexes: undefined} satisfies DeferredCodeAnchorExplicitFinalizationReceipt;
    }
    const derivedIndexes = yield* refreshRecallDerivedIndexesFromSelection(config, finalizedUris).pipe(
      Effect.catchCause(() =>
        Effect.succeed({repair: 'Run `threadnote repair` to retry derived-index refresh.', state: 'deferred' as const}),
      ),
    );
    return {...receipt, derivedIndexes} satisfies DeferredCodeAnchorExplicitFinalizationReceipt;
  },
);

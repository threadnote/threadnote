import {Effect} from 'effect';

import type {SourceAutoSyncResult} from '@threadnote/integration-core/source-sync';
export type {SourceAutoSyncResult} from '@threadnote/integration-core/source-sync';

export function syncRegisteredSources<E, R>(syncs: readonly Effect.Effect<SourceAutoSyncResult, E, R>[]) {
  return Effect.gen(function* () {
    const syncedSources: string[] = [];
    const warnings: string[] = [];
    for (const sync of syncs) {
      const result = yield* sync;
      syncedSources.push(...result.syncedSources);
      warnings.push(...result.warnings);
    }
    return {syncedSources, warnings};
  });
}

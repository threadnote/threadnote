import {Context, Effect} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';

export interface SourceAutoSyncResult {
  readonly syncedSources: readonly string[];
  readonly warnings: readonly string[];
}

export class SourceSync extends Context.Service<
  SourceSync,
  {readonly beforeRecall: (config: RuntimeConfig) => Effect.Effect<SourceAutoSyncResult, unknown>}
>()('@threadnote/integration-core/source-sync/SourceSync') {}

export const syncSourcesBeforeRecall = Effect.fn('source.syncBeforeRecall')(function* (config: RuntimeConfig) {
  return yield* (yield* SourceSync).beforeRecall(config);
});

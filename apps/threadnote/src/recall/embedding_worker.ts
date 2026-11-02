import {vectorIndexStatus, VectorIndexCorrupt} from '@threadnote/recall/vector-index';
import {lexicalRefreshDisposition} from '@threadnote/recall/mcp/refresh';
import {loadRecallIndexData, recallIndexStatus, RecallIndexCorrupt} from '@threadnote/recall/index';
import {Effect, Schema} from 'effect';
import {BackgroundInferenceAdmission, BackgroundInferenceDeferred} from '@threadnote/inference/background/admission';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {
  completeRecallEmbeddingDemand,
  readRecallEmbeddingDemand,
  type RecallEmbeddingScope,
} from '@threadnote/recall/background/demand';
import {RecallVectorSourceChanged, stepRecallVectorPreparation} from '@threadnote/recall/background/vector-step';

/** No automatic launch until the graph adapter uses the same home-wide gate. */
export const runRecallEmbeddingWorker = Effect.fn('recall.embeddingWorker')(function* (scope: RecallEmbeddingScope) {
  const admission = yield* BackgroundInferenceAdmission;
  const catalog = yield* LocalModelCatalog;
  const store = yield* LocalModelStore;
  let failures = 0;
  let verifiedModel: string | undefined;
  for (;;) {
    const demand = yield* readRecallEmbeddingDemand(scope);
    if (!demand?.desired) return {state: 'complete' as const};
    const desired = demand.desired;
    const config = {...scope, manifestPath: desired.manifestPath};
    // Re-resolve selection and corpus on every admitted unit; enqueue hints never select a generation.
    const selection = yield* readModelSelection(scope.agentContextHome);
    const modelId = selection.roles.embedding;
    if (!modelId) return {state: 'blocked' as const, reason: 'embedding-model-unselected'};
    const manifest = yield* catalog.get(modelId);
    if (manifest.role !== 'embedding' || !(yield* store.status(scope.agentContextHome, manifest)).installed)
      return {state: 'blocked' as const, reason: 'embedding-model-unavailable'};
    const current = readRecallEmbeddingDemand(scope).pipe(
      Effect.map(latest => latest?.desired?.token === desired.token),
    );
    const outcome = yield* admission
      .runBatch(
        scope.agentContextHome,
        'recall',
        Effect.gen(function* () {
          const identity = manifest.id + ':' + manifest.sha256 + ':' + String(manifest.dimensions);
          if (verifiedModel !== identity) {
            const vectors = yield* vectorIndexStatus(scope.agentContextHome, manifest);
            if (!vectors.ready && vectors.reason !== 'not built')
              return yield* VectorIndexCorrupt.make({
                modelId: manifest.id,
                message: 'Existing vector storage requires explicit index rebuild.',
              });
            verifiedModel = identity;
          }
          const lexical = yield* recallIndexStatus(config, false);
          if (lexicalRefreshDisposition(lexical) === 'unsafe')
            return yield* RecallIndexCorrupt.make({
              message: 'Lexical storage requires explicit repair before background embeddings.',
            });
          if (!lexical.ready) yield* loadRecallIndexData(config, {includeInactive: false, memoryIds: []});
          return yield* stepRecallVectorPreparation(config, manifest, current);
        }),
      )
      .pipe(Effect.result);
    if (outcome._tag === 'Success') {
      failures = 0;
      if (outcome.success.state === 'completed' && outcome.success.value.state === 'current')
        yield* completeRecallEmbeddingDemand(scope, desired.token);
      // Release both the batch and domain unit before sleeping for idle or another turn.
      yield* Effect.sleep(
        outcome.success.state === 'deferred' ? (outcome.success.reason === 'cpu-unknown' ? 500 : 2000) : 50,
      );
    } else {
      if (Schema.is(VectorIndexCorrupt)(outcome.failure) || Schema.is(RecallIndexCorrupt)(outcome.failure))
        return {state: 'blocked' as const, reason: 'index-storage-requires-repair'};
      const deferred = Schema.is(BackgroundInferenceDeferred)(outcome.failure);
      if (!deferred) {
        if (
          Schema.is(RecallVectorSourceChanged)(outcome.failure) ||
          (yield* readRecallEmbeddingDemand(scope))?.desired?.token !== desired.token
        ) {
          failures = 0;
          yield* Effect.sleep(50);
          continue;
        }
        failures += 1;
      }
      if (failures >= 8) return {state: 'blocked' as const, reason: 'embedding-preparation-failed'};
      yield* Effect.sleep(deferred ? 2000 : Math.min(30_000, 1000 * 2 ** failures));
    }
  }
});

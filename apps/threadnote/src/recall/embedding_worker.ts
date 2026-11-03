import {RecallReadMaintenancePort} from './read_maintenance.js';
import {SecureRandom} from 'effect/crypto';
import {vectorIndexStatus, VectorIndexCorrupt} from '@threadnote/recall/vector-index';
import {lexicalRefreshDisposition} from '@threadnote/recall/mcp/refresh';
import {loadRecallIndexData, recallIndexStatus, RecallIndexCorrupt} from '@threadnote/recall/index';
import {Array as EffectArray, Clock, Context, Effect, FileSystem, Path, Schema} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {BackgroundInferenceAdmission, BackgroundInferenceDeferred} from '@threadnote/inference/background/admission';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {
  completeRecallEmbeddingDemand,
  observeRecallEmbeddingDemand,
  readRecallEmbeddingDemand,
  type RecallEmbeddingObservation,
  type RecallEmbeddingScope,
} from '@threadnote/recall/background/demand';
import {RecallVectorSourceChanged, runRecallVectorPreparationBatch} from '@threadnote/recall/background/vector-step';

import {
  readRecallLexicalDemand,
  completeRecallLexicalRefresh,
  failRecallLexicalRefresh,
  deferRecallLexicalRefresh,
  requestRecallLexicalRefresh,
  type RecallLexicalScope,
} from '@threadnote/recall/background/lexical-demand';

/** Lexical maintenance does not depend on model selection or native inference admission. */
export const runRecallLexicalWorkerUnit = Effect.fn('recall.lexicalWorkerUnit')(function* (scope: RecallLexicalScope) {
  const demand = yield* readRecallLexicalDemand(scope);
  if (!demand?.revision || demand.failures >= 8) return {state: 'complete' as const, delay: 0};
  if (demand.notBefore !== undefined && demand.notBefore > (yield* Clock.currentTimeMillis))
    return {state: 'deferred' as const, reason: 'retry-backoff', delay: 1000};
  const revision = demand.revision;
  scope = {...scope, work: demand.work};
  if (scope.work) {
    const port = yield* RecallReadMaintenancePort;
    if (!port) return {state: 'blocked' as const, reason: 'read-maintenance-unavailable', delay: 0};
    const result = yield* port(scope).pipe(Effect.result);
    if (result._tag === 'Failure') {
      yield* failRecallLexicalRefresh(scope, revision);
      return {state: 'deferred' as const, reason: 'read-maintenance-failed', delay: 1000};
    }
    if (result.success === 'pending') {
      yield* deferRecallLexicalRefresh(scope, revision, 5000);
      return {state: 'deferred' as const, reason: 'read-maintenance-pending', delay: 5000};
    }
    if (!(yield* recallIndexStatus(scope, scope.includeInactive)).ready)
      yield* requestRecallLexicalRefresh({...scope, work: undefined});
    return (yield* completeRecallLexicalRefresh(scope, revision))
      ? {state: 'complete' as const, delay: 0}
      : {state: 'checkpointed' as const, reason: 'newer-demand', delay: 50};
  }
  const status = yield* recallIndexStatus(scope, scope.includeInactive);
  if (lexicalRefreshDisposition(status) === 'unsafe') {
    yield* failRecallLexicalRefresh(scope, revision, true);
    return {state: 'blocked' as const, reason: 'lexical-storage-requires-repair', delay: 0};
  }
  const result = yield* loadRecallIndexData(scope, {includeInactive: scope.includeInactive, memoryIds: []}).pipe(
    Effect.result,
  );
  if (result._tag === 'Failure') {
    yield* failRecallLexicalRefresh(scope, revision);
    return {state: 'deferred' as const, reason: 'lexical-maintenance-failed', delay: 1000};
  }
  // A concurrent canonical mutation retains demand for another pass.
  if (!(yield* recallIndexStatus(scope, scope.includeInactive)).ready)
    return {state: 'checkpointed' as const, reason: 'source-changed', delay: 50};
  return (yield* completeRecallLexicalRefresh(scope, revision))
    ? {state: 'complete' as const, delay: 0}
    : {state: 'checkpointed' as const, reason: 'newer-demand', delay: 50};
});

export interface RecallEmbeddingWorkerUnitResult {
  readonly state: 'complete' | 'checkpointed' | 'deferred' | 'blocked';
  readonly reason?: string;
  readonly delay: number;
}

export class RecallEmbeddingWorkerControlUnavailable extends Schema.TaggedError<
  RecallEmbeddingWorkerControlUnavailable,
  {readonly brand: unique symbol}
>()('RecallEmbeddingWorkerControlUnavailable', {message: Schema.String}) {}
const controlUnavailable = () =>
  RecallEmbeddingWorkerControlUnavailable.make({message: 'Recall embedding retry control could not be persisted.'});

/** Shared bounded metadata cache; each scope gets at most one admitted unit per turn. */
export const makeRecallEmbeddingWorker = Effect.fn('recall.makeEmbeddingWorker')(function* () {
  const admission = yield* BackgroundInferenceAdmission;
  const catalog = yield* LocalModelCatalog;
  const store = yield* LocalModelStore;
  const runtime = yield* LocalModelRuntime;
  const system = yield* SystemInfo;
  const identity = yield* system.processStartIdentity(system.processId);
  const owner = identity ? {processId: system.processId, processStartIdentity: identity} : undefined;
  const platform = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | SystemInfo | SecureRandom.SecureRandom
  >().pipe(Effect.map(Context.pick(FileSystem.FileSystem, Path.Path, SystemInfo, SecureRandom.SecureRandom)));
  const verifiedModels = new Set<string>();
  return Effect.fn('recall.embeddingWorkerUnit')(function* (
    scope: RecallEmbeddingScope,
  ): Effect.fn.Return<
    RecallEmbeddingWorkerUnitResult,
    unknown,
    FileSystem.FileSystem | Path.Path | SystemInfo | SecureRandom.SecureRandom
  > {
    const demand = yield* readRecallEmbeddingDemand(scope);
    if (!demand?.desired) return {state: 'complete', delay: 0};
    const desired = demand.desired;
    const config = {...scope, manifestPath: desired.manifestPath};
    const selection = yield* readModelSelection(scope.agentContextHome);
    const modelId = selection.roles.embedding;
    const manifest = modelId ? yield* catalog.get(modelId).pipe(Effect.option) : undefined;
    const selected = manifest?._tag === 'Some' ? manifest.value : undefined;
    const model = selected ? selected.id + ':' + selected.sha256 + ':' + String(selected.dimensions) : undefined;
    const previous =
      demand.observation?.revision === desired.revision && demand.observation.model === model
        ? demand.observation
        : undefined;
    const failures = previous?.failures ?? 0;
    let progress = previous?.progress;
    const persistObservation = (
      state: RecallEmbeddingObservation['state'],
      reason?: string,
      failed = failures,
      notBefore?: number,
    ) =>
      observeRecallEmbeddingDemand(scope, desired, {
        state,
        failures: failed,
        ...(model === undefined ? {} : {model}),
        ...(owner === undefined ? {} : {owner}),
        ...(reason === undefined ? {} : {reason}),
        ...(notBefore === undefined ? {} : {notBefore}),
        ...(progress === undefined ? {} : {progress}),
      }).pipe(Effect.provide(platform), Effect.mapError(controlUnavailable));
    const observe = (...args: Parameters<typeof persistObservation>) =>
      persistObservation(...args).pipe(Effect.orElseSucceed(() => false));
    if (
      !selected ||
      selected.role !== 'embedding' ||
      !selected.dimensions ||
      !(yield* store.status(scope.agentContextHome, selected)).installed
    ) {
      yield* persistObservation('blocked', 'embedding-model-unavailable');
      return {state: 'blocked', reason: 'embedding-model-unavailable', delay: 0};
    }
    const sameObserver =
      owner !== undefined &&
      previous?.owner?.processId === owner.processId &&
      previous.owner.processStartIdentity === owner.processStartIdentity;
    if (
      (previous?.state === 'blocked' && previous.reason !== 'embedding-model-unavailable') ||
      (previous?.state === 'corrupt' && sameObserver)
    )
      return {state: 'blocked', reason: previous.reason, delay: 0};
    const now = yield* Clock.currentTimeMillis;
    if (previous?.notBefore !== undefined && previous.notBefore > now)
      return {state: 'deferred', reason: 'retry-backoff', delay: Math.min(2000, previous.notBefore - now)};
    const current = readRecallEmbeddingDemand(scope).pipe(
      Effect.map(latest => latest?.desired?.token === desired.token && latest.desired.revision === desired.revision),
    );
    const observedRuntime = LocalModelRuntime.of({
      ...runtime,
      embedMany: request => observe('running').pipe(Effect.andThen(runtime.embedMany(request))),
    });
    const outcome = yield* admission
      .runBatch(
        scope.agentContextHome,
        'recall',
        Effect.gen(function* () {
          yield* observe('preparing');
          if (!verifiedModels.has(model!)) {
            const vectors = yield* vectorIndexStatus(scope.agentContextHome, selected);
            if (!vectors.ready && vectors.reason !== 'not built')
              return yield* VectorIndexCorrupt.make({
                modelId: selected.id,
                message: 'Existing vector storage requires explicit index rebuild.',
              });
            if (verifiedModels.size >= 4) verifiedModels.delete(EffectArray.fromIterable(verifiedModels)[0]);
            verifiedModels.add(model!);
          }
          const lexical = yield* recallIndexStatus(config, false);
          if (lexicalRefreshDisposition(lexical) === 'unsafe')
            return yield* RecallIndexCorrupt.make({
              message: 'Lexical storage requires explicit repair before background embeddings.',
            });
          if (!lexical.ready) yield* loadRecallIndexData(config, {includeInactive: false, memoryIds: []});
          const result = yield* runRecallVectorPreparationBatch(config, selected, current).pipe(
            Effect.provideService(LocalModelRuntime, observedRuntime),
            Effect.provideService(LocalModelCatalog, catalog),
            Effect.provideService(LocalModelStore, store),
          );
          progress = result.progress;
          return result;
        }),
      )
      .pipe(Effect.result);
    if (outcome._tag === 'Success') {
      if (outcome.success.state === 'deferred') {
        const reason = outcome.success.reason;
        yield* observe(
          reason === 'cpu-busy' || reason === 'cpu-unknown'
            ? 'deferred-cpu'
            : reason === 'foreground' || reason === 'foreground-quiet'
              ? 'deferred-foreground'
              : 'queued',
          reason,
        );
        return {state: 'deferred', reason, delay: reason === 'cpu-unknown' ? 500 : 2000};
      }
      if (
        outcome.success.value.state === 'current' &&
        (yield* completeRecallEmbeddingDemand(scope, desired.token, desired.revision).pipe(
          Effect.mapError(controlUnavailable),
        ))
      )
        return {state: 'complete', delay: 0};
      yield* observe('queued', 'checkpoint', 0);
      return {state: 'checkpointed', delay: 50};
    }
    const error = outcome.failure;
    if (Schema.is(VectorIndexCorrupt)(error) || Schema.is(RecallIndexCorrupt)(error)) {
      yield* persistObservation('corrupt', 'index-storage-requires-repair');
      return {state: 'blocked', reason: 'index-storage-requires-repair', delay: 0};
    }
    if (Schema.is(BackgroundInferenceDeferred)(error)) {
      yield* observe('deferred-foreground', 'native-authority-deferred');
      return {state: 'deferred', reason: 'native-authority-deferred', delay: 2000};
    }
    if (
      Schema.is(RecallVectorSourceChanged)(error) ||
      (yield* readRecallEmbeddingDemand(scope))?.desired?.revision !== desired.revision
    ) {
      yield* observe('queued', 'source-changed', 0);
      return {state: 'checkpointed', reason: 'source-changed', delay: 50};
    }
    const failed = failures + 1;
    if (failed >= 8) {
      yield* persistObservation('blocked', 'embedding-preparation-failed', 8);
      return {state: 'blocked', reason: 'embedding-preparation-failed', delay: 0};
    }
    const delay = Math.min(30_000, 1000 * 2 ** failed);
    yield* persistObservation('queued', 'retry-backoff', failed, (yield* Clock.currentTimeMillis) + delay);
    return {state: 'deferred', reason: 'retry-backoff', delay};
  });
});

/** Compatibility wrapper for a single explicit scope; the home process round-robins units. */
export const runRecallEmbeddingWorker = Effect.fn('recall.embeddingWorker')(function* (scope: RecallEmbeddingScope) {
  const unit = yield* makeRecallEmbeddingWorker();
  for (;;) {
    const result = yield* unit(scope);
    if (result.state === 'complete') return {state: 'complete' as const};
    if (result.state === 'blocked') return {state: 'blocked' as const, reason: result.reason};
    yield* Effect.sleep(result.delay);
  }
});

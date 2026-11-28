import {readModelSelection, selectedEmbeddingModelId} from '@threadnote/inference/models/selection';
import type {RecallVectorRefreshRecord} from '@threadnote/recall/diagnostics';
import type {RecallSemanticReadState} from '@threadnote/recall/semantic_scores';
import {succeedUndefined} from '@threadnote/platform/optional';
import {readLastRecallVectorRefresh} from '@threadnote/recall/vector-index';
import {Cause, Effect} from 'effect';
import {
  recordAnonymousTelemetryFieldsFrom,
  telemetryQuantityBucket,
  type AnonymousTelemetryFields,
} from '../effect/telemetry.js';

type RecallReadCounts = Readonly<Record<RecallSemanticReadState, number>>;
type LastRefreshDurations = Pick<RecallVectorRefreshRecord, 'durationMilliseconds' | 'staleDurationMilliseconds'>;

/** Project only four state counts and two durations. Do not copy input fields. */
export function recallVectorRefreshTelemetryFields(
  counts: RecallReadCounts,
  refresh?: LastRefreshDurations,
): AnonymousTelemetryFields {
  const build = refresh === undefined ? undefined : telemetryQuantityBucket(refresh.durationMilliseconds);
  const stale =
    refresh?.staleDurationMilliseconds === undefined
      ? undefined
      : telemetryQuantityBucket(refresh.staleDurationMilliseconds);
  return {
    recallReadCompactionBucket: telemetryQuantityBucket(counts.compaction),
    recallReadCurrentBucket: telemetryQuantityBucket(counts.current),
    recallReadRefreshableBucket: telemetryQuantityBucket(counts.refreshable),
    recallReadServingOlderBucket: telemetryQuantityBucket(counts['serving-older']),
    ...(build === undefined ? {} : {recallRefreshBuildMillisecondsBucket: build}),
    ...(build === undefined || stale === undefined ? {} : {recallRefreshStaleMillisecondsBucket: stale}),
  };
}

/** Send per-call count deltas so later calls never repeat an earlier state's count. */
export function recordRecallVectorRefreshAnonymousTelemetry(home: string, state: RecallSemanticReadState | undefined) {
  if (state === undefined) return Effect.void;
  return recordAnonymousTelemetryFieldsFrom(
    Effect.gen(function* () {
      const refresh = yield* readModelSelection(home).pipe(
        Effect.flatMap(selection => {
          const modelId = selectedEmbeddingModelId(selection, 'recall');
          return modelId === undefined ? succeedUndefined : readLastRecallVectorRefresh(home, {id: modelId});
        }),
        Effect.timeoutOrElse({duration: '50 millis', orElse: () => succeedUndefined}),
        Effect.orElseSucceed(() => undefined),
        Effect.catchCauseIf(
          cause => !Cause.hasInterrupts(cause),
          () => succeedUndefined,
        ),
      );
      return recallVectorRefreshTelemetryFields(
        {
          compaction: state === 'compaction' ? 1 : 0,
          current: state === 'current' ? 1 : 0,
          refreshable: state === 'refreshable' ? 1 : 0,
          'serving-older': state === 'serving-older' ? 1 : 0,
        },
        refresh,
      );
    }),
  );
}

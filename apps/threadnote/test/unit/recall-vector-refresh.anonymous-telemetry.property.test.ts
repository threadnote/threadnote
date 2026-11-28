import {it as effectIt} from '@effect/vitest';
import {SystemInfo} from '@threadnote/platform/system';
import fc from 'fast-check';
import {Effect, Exit, Layer, Record as EffectRecord, Tracer} from 'effect';
import {describe, expect, it} from 'vitest';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {
  anonymousTelemetryTestLayer,
  recordAnonymousTelemetryFieldsFrom,
  withAnonymousTelemetry,
} from '@threadnote/threadnote/effect/telemetry';
import {recallVectorRefreshTelemetryFields} from '../../src/telemetry/recall_vector_refresh.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('recall vector refresh anonymous telemetry', () => {
  it('projects only the closed state and duration buckets', () => {
    const quantity = fc.integer({min: 0, max: Number.MAX_SAFE_INTEGER});
    const bucket = (value: number) => (value === 0 ? '0' : '2^' + (BigInt(value).toString(2).length - 1));
    fc.assert(
      fc.property(
        fc.tuple(quantity, quantity, quantity, quantity, quantity, fc.option(quantity, {nil: undefined})),
        fc.string(),
        ([current, older, refreshable, compaction, build, stale], privateText) => {
          const counts = {compaction, current, refreshable, 'serving-older': older, query: privateText};
          const refresh = {durationMilliseconds: build, staleDurationMilliseconds: stale, uri: privateText};
          expect(recallVectorRefreshTelemetryFields(counts, refresh)).toEqual({
            recallReadCompactionBucket: bucket(compaction),
            recallReadCurrentBucket: bucket(current),
            recallReadRefreshableBucket: bucket(refreshable),
            recallReadServingOlderBucket: bucket(older),
            recallRefreshBuildMillisecondsBucket: bucket(build),
            ...(stale === undefined ? {} : {recallRefreshStaleMillisecondsBucket: bucket(stale)}),
          });
        },
      ),
    );
  });

  for (const enabled of [true, false]) {
    effectIt.effect(
      enabled ? 'exports the buckets once on recall completion' : 'does not observe data or export it when disabled',
      () => {
        const spans: Tracer.NativeSpan[] = [];
        const tracer = Tracer.make({
          span(options) {
            return new (class extends Tracer.NativeSpan {
              override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
                super.end(endTime, exit);
                spans.push(this);
              }
            })(options);
          },
        });
        const telemetry = Layer.unwrap(
          Effect.map(SystemInfo, system =>
            anonymousTelemetryTestLayer({system, tracer, isEnabled: Effect.succeed(enabled)}),
          ),
        ).pipe(Layer.provide(TestSystemInfoLayer));
        return Effect.gen(function* () {
          let observed = 0;
          yield* withAnonymousTelemetry(
            {component: 'mcp', operation: 'recall_context'},
            recordAnonymousTelemetryFieldsFrom(
              Effect.sync(() => {
                observed += 1;
                return recallVectorRefreshTelemetryFields(
                  {compaction: 0, current: 0, refreshable: 0, 'serving-older': 1},
                  {durationMilliseconds: 40000, staleDurationMilliseconds: 66000},
                );
              }),
            ),
          );
          expect(observed).toBe(enabled ? 1 : 0);
          expect(spans).toHaveLength(enabled ? 1 : 0);
          if (!enabled) return;
          expect(EffectRecord.fromEntries(spans[0].attributes)).toMatchObject({
            'threadnote.event': 'completion',
            'threadnote.recall.read_compaction_bucket': '0',
            'threadnote.recall.read_current_bucket': '0',
            'threadnote.recall.read_refreshable_bucket': '0',
            'threadnote.recall.read_serving_older_bucket': '2^0',
            'threadnote.recall.refresh_build_ms_bucket': '2^15',
            'threadnote.recall.refresh_stale_ms_bucket': '2^16',
          });
        }).pipe(provideTestLayer(telemetry));
      },
    );
  }
});

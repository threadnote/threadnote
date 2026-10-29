import {Array as EffectArray} from 'effect';
import type {OtlpTracer} from 'effect/observability';
import fc from 'fast-check';
import {expect, it} from 'vitest';
import {normalizeAnonymousTelemetryTraceData} from '../../src/telemetry/otlp_serialization.js';

it('preserves the frozen resource/scope envelope, span batches and input bytes under exporter metadata changes', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.string(), fc.string()), {maxLength: 8}),
      fc.string(),
      fc.integer({min: 1, max: 4}),
      (metadata, version, scopeCount) => {
        const allowed = [
          'service.name',
          'service.version',
          'session.id',
          'threadnote.session.scope',
          'threadnote.telemetry.schema_version',
        ];
        const resource = EffectArray.map(allowed, key => ({key, value: {stringValue: key}}));
        const input: OtlpTracer.TraceData = {
          resourceSpans: [
            {
              resource: {
                attributes: [
                  ...resource,
                  ...EffectArray.map(
                    EffectArray.filter(metadata, ([key]) => !allowed.includes(key)),
                    ([key, stringValue]) => ({key, value: {stringValue}}),
                  ),
                ],
                droppedAttributesCount: 0,
              },
              scopeSpans: Array.from({length: scopeCount}, () => ({scope: {name: 'effect', version}, spans: []})),
            },
          ],
        };
        const bytes = JSON.stringify(input);
        const normalized = normalizeAnonymousTelemetryTraceData(input);
        expect(normalized.resourceSpans[0].resource.attributes).toEqual(resource);
        for (const [index, scope] of normalized.resourceSpans[0].scopeSpans.entries()) {
          expect(scope.scope).toEqual({name: 'threadnote'});
          expect(scope.spans).toBe(input.resourceSpans[0].scopeSpans[index].spans);
        }
        expect(normalizeAnonymousTelemetryTraceData(normalized)).toEqual(normalized);
        expect(JSON.stringify(input)).toBe(bytes);
      },
    ),
    {numRuns: 80},
  );
});

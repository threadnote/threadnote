import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Effect, Layer} from 'effect';
import {OtlpSerialization, type OtlpTracer} from 'effect/observability';

const RESOURCE_ATTRIBUTES = new Set([
  'service.name',
  'service.version',
  'session.id',
  'threadnote.session.scope',
  'threadnote.telemetry.schema_version',
]);

export function normalizeAnonymousTelemetryTraceData(data: OtlpTracer.TraceData): OtlpTracer.TraceData {
  return {
    resourceSpans: EffectArray.map(data.resourceSpans, group => ({
      ...group,
      resource: {
        ...group.resource,
        attributes: EffectArrayPipe(group.resource.attributes, __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (attribute, __effectArrayIndex) =>
              __effectArrayIndex in __effectArrayValues && RESOURCE_ATTRIBUTES.has(attribute.key),
          ),
        ),
      },
      scopeSpans: EffectArray.map(group.scopeSpans, scope => ({...scope, scope: {name: 'threadnote'}})),
    })),
  };
}

/** Preserve the consented gateway envelope independently of exporter SDK metadata defaults. */
export const anonymousTelemetrySerializationLayer = Layer.effect(
  OtlpSerialization.OtlpSerialization,
  Effect.map(OtlpSerialization.OtlpSerialization, serialization => ({
    ...serialization,
    traces: data => serialization.traces(normalizeAnonymousTelemetryTraceData(data)),
  })),
).pipe(Layer.provide(OtlpSerialization.layerProtobuf));

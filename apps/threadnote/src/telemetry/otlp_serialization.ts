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
    resourceSpans: data.resourceSpans.map(group => ({
      ...group,
      resource: {
        ...group.resource,
        attributes: group.resource.attributes.filter(attribute => RESOURCE_ATTRIBUTES.has(attribute.key)),
      },
      scopeSpans: group.scopeSpans.map(scope => ({...scope, scope: {name: 'threadnote'}})),
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

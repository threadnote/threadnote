import {runtimeEntrypointLayer} from '@threadnote/threadnote/effect/runtime-entrypoint';
import {Effect, Layer, Schema} from 'effect';
import {telemetryChildEnvironmentPolicyLayer} from '@threadnote/threadnote/telemetry/session';

/** Typed failure used at executable-script Effect boundaries. */
export class ScriptError extends Schema.TaggedError<ScriptError, {readonly brand: unique symbol}>()('ScriptError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export function scriptError(cause: unknown, fallback = 'Threadnote script operation failed.'): ScriptError {
  if (Schema.is(ScriptError)(cause)) return cause;
  return ScriptError.make({cause, message: cause instanceof Error ? cause.message : fallback});
}

/** Build a script's terminal service graph with one scoped lifetime boundary. */
export function provideScriptLayer<A, E, R, Services, LayerError, LayerRequirements>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<Services, LayerError, LayerRequirements>,
) {
  const runtimePorts = Layer.merge(telemetryChildEnvironmentPolicyLayer, runtimeEntrypointLayer);
  const completeLayer = Layer.merge(layer.pipe(Layer.provide(runtimePorts)), runtimePorts);
  return Effect.scoped(
    Layer.build(completeLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}

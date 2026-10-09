import {runtimeEntrypointLayer} from '@threadnote/threadnote/effect/runtime-entrypoint';
import {codeGraphRuntimeAdapters} from '@threadnote/threadnote/code_graph/runtime_adapters';
import {Effect, Layer} from 'effect';
import {telemetryChildEnvironmentPolicyLayer} from '@threadnote/threadnote/telemetry/session';
import {SourceSync} from '@threadnote/integration-core/source-sync';
import {Option} from 'effect';

/**
 * Builds a test layer at the call site and keeps its resources scoped to the
 * returned Effect. This preserves per-example lifecycle and the precedence of
 * nested pipe operators while avoiding application-entrypoint provisioning.
 */
export function provideTestLayer<Services, LayerError, LayerRequirements>(
  layer: Layer.Layer<Services, LayerError, LayerRequirements>,
) {
  const runtimePorts = Layer.mergeAll(
    telemetryChildEnvironmentPolicyLayer,
    runtimeEntrypointLayer,
    codeGraphRuntimeAdapters,
  );
  const completeLayer = Layer.merge(layer.pipe(Layer.provide(runtimePorts)), runtimePorts);
  const sourceSyncLayer = Layer.effect(
    SourceSync,
    Effect.serviceOption(SourceSync).pipe(
      Effect.map(existing =>
        Option.getOrElse(existing, () =>
          SourceSync.of({
            beforeRecall: () => Effect.succeed({syncedSources: [], warnings: []}),
          }),
        ),
      ),
    ),
  ).pipe(Layer.provide(completeLayer));
  const testLayer = Layer.merge(completeLayer, sourceSyncLayer);
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(Layer.build(testLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}

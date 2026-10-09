import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';
import {TestConsole} from 'effect/testing';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {makeSourceConfigurationRegistry, sourceConfigurationStoreLayer} from '@threadnote/integration-runtime/config';
import {externalSourcePolicyLayer} from '@threadnote/integration-runtime/access-policy';
import {linearSourceCodec} from '../src/config.js';
import {linearExternalSourcePolicy} from '../src/access-policy.js';
const configurationLayer = sourceConfigurationStoreLayer(
  makeSourceConfigurationRegistry({sources: [linearSourceCodec], projections: []}),
);
const baseServices = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'linear-source.test.ts'}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: env => ({...env}),
          sanitizeExternal: env => ({...env}),
        }),
      ),
    ),
  ),
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const base = Layer.merge(baseServices, configurationLayer.pipe(Layer.provide(baseServices)));
const dependencies = Layer.merge(
  base,
  externalSourcePolicyLayer([linearExternalSourcePolicy]).pipe(Layer.provide(base)),
);
const layer = Layer.merge(dependencies, ResourceStore.layer.pipe(Layer.provide(dependencies)));
export const provideLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Layer.build(Layer.merge(layer, TestConsole.layer)).pipe(
      Effect.flatMap(context => effect.pipe(Effect.provide(context))),
    ),
  );

import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {superhumanExternalSourcePolicyLayer} from '../../superhuman/access-policy.js';
const base = Layer.mergeAll(
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
const dependencies = Layer.merge(base, superhumanExternalSourcePolicyLayer.pipe(Layer.provide(base)));
const layer = Layer.merge(dependencies, ResourceStore.layer.pipe(Layer.provide(dependencies)));
export const provideLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));

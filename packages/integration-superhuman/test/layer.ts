import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer} from 'effect';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';

const runtimeDependencies = Layer.mergeAll(
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'integration-superhuman.test.ts'}),
  Layer.succeed(ChildEnvironmentPolicy, {
    preserveIntendedChild: environment => ({...environment}),
    sanitizeExternal: environment => ({...environment}),
  }),
);
export const superhumanTestLayer = Layer.merge(
  BunServices.layer,
  SystemInfo.layer.pipe(Layer.provide(runtimeDependencies)),
);

export function provideSuperhumanTestLayer<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Layer.build(superhumanTestLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
}

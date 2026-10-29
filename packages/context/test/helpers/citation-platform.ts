import * as BunServices from '@effect/platform-bun/BunServices';
import {Layer} from 'effect';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';

const policy = Layer.mergeAll(
  Layer.succeed(ChildEnvironmentPolicy, {
    preserveIntendedChild: environment => environment,
    sanitizeExternal: environment => environment,
  }),
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: '/test/threadnote.ts'}),
);
export const citationSystemInfoLayer = SystemInfo.layer.pipe(Layer.provide(policy));
export const citationPlatformLayer = Layer.mergeAll(
  citationSystemInfoLayer,
  CommandExecutor.layer.pipe(Layer.provideMerge(citationSystemInfoLayer), Layer.provide(policy)),
).pipe(Layer.provideMerge(BunServices.layer));

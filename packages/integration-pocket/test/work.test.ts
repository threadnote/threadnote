import {ResourceStore} from '@threadnote/store/resource-store';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Schema} from 'effect';
import {describe, expect} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {SourceConfigurationStore} from '@threadnote/integration-core/config';
import {SourceCoordinator, SourceCoordinatorError} from '@threadnote/integration-core/source-coordinator';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {PocketSourceConfig} from '../src/config.js';
import {pocketSourceWork, runPocketSourceSync} from '../src/source.js';

const source: PocketSourceConfig = {
  type: 'pocket',
  id: 'source-one',
  enabled: true,
  credentialEnv: 'SYNTHETIC_WORK_KEY',
  project: 'test',
  refreshIntervalMinutes: 15,
  maxStaleHours: 24,
};
const base = Layer.merge(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'pocket-work.test.ts'}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: value => ({...value}),
          sanitizeExternal: value => ({...value}),
        }),
      ),
    ),
  ),
);
const services = Layer.merge(base, Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}));
const layer = Layer.merge(services, ResourceStore.layer.pipe(Layer.provide(services)));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const withSources = <A, E, R>(effect: Effect.Effect<A, E, R>, sources: readonly PocketSourceConfig[]) =>
  effect.pipe(
    Effect.provideService(SourceConfigurationStore, {
      read: () => Effect.succeed({version: 2, sources, projections: []}),
      write: () => Effect.succeed('unused'),
      mutate: () => Effect.succeed('unused'),
    }),
  );

describe('Pocket coordinator boundary', () => {
  effectIt.effect('explicit sync delegates once and preserves its provider result without a network call', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = {
        agentContextHome: yield* fs.makeTempDirectoryScoped(),
        account: 'local',
        user: 'tester',
      } as RuntimeConfig;
      const value = {sourceId: source.id, syncedDocuments: ['document'], warnings: []};
      let calls = 0;
      const result = yield* withSources(
        runPocketSourceSync(config, {
          id: source.id,
          apply: true,
          clientOptions: {fetch: () => Promise.reject(new Error('must use coordinator'))},
        }),
        [source],
      ).pipe(
        Effect.provideService(SourceCoordinator, {
          requestRefresh: () => Effect.void,
          sync: (requestedConfig, id) =>
            Effect.sync(() => {
              expect(requestedConfig).toBe(config);
              expect(id).toBe(source.id);
              calls++;
              return {...value, value};
            }),
        }),
      );
      expect(calls).toBe(1);
      expect(result).toBe(value);
      const expired = yield* withSources(runPocketSourceSync(config, {id: source.id, apply: true}), [source]).pipe(
        Effect.provideService(SourceCoordinator, {
          requestRefresh: () => Effect.void,
          sync: () => Effect.succeed({...value}),
        }),
        Effect.result,
      );
      expect(expired).toMatchObject({_tag: 'Failure', failure: expect.any(SourceCoordinatorError)});
    }).pipe(provide),
  );

  effectIt.effect.prop(
    'credential-equivalent sources share opaque quota identity while rotations change it',
    {suffix: Schema.Int.check(Schema.isBetween({minimum: 100, maximum: 10000}))},
    ({suffix}) =>
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        const config = {agentContextHome: '/unused', account: 'local', user: 'tester'} as RuntimeConfig;
        const token = 'pk_synthetic_work_key_' + suffix;
        const sources = [source, {...source, id: 'source-two'}, {...source, id: 'disabled', enabled: false}];
        const list = (credential: string) =>
          withSources(pocketSourceWork.list(config), sources).pipe(
            Effect.provideService(SystemInfo, {...system, environment: () => ({SYNTHETIC_WORK_KEY: credential})}),
          );
        const descriptors = yield* list(token);
        expect(descriptors).toHaveLength(2);
        expect(descriptors[0].accountKey).toBe(descriptors[1].accountKey);
        expect(descriptors[0].accountKey).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(descriptors)).not.toContain(token);
        expect((yield* list(token + '_rotated'))[0].accountKey).not.toBe(descriptors[0].accountKey);
      }).pipe(provide),
    {arbitrary: {runs: 10}},
  );
});

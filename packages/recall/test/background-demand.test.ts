import * as EffectString from 'effect/String';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {expect, describe} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {
  completeRecallEmbeddingDemand,
  readRecallEmbeddingDemand,
  requestRecallEmbeddings,
  repairRecallEmbeddingDemand,
} from '../src/background/demand.js';
const policy = Layer.mergeAll(
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
  Layer.succeed(ChildEnvironmentPolicy, {
    preserveIntendedChild: environment => environment,
    sanitizeExternal: environment => environment,
  }),
);
const platform = Layer.mergeAll(BunServices.layer, SystemInfo.layer.pipe(Layer.provide(policy)));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-demand-'});
  return {fs, scope: {account: 'local', agentContextHome: home, user: 'test'}};
});
describe('durable recall embedding demand', () => {
  effectIt.effect('survives independent callers and does not lose a later write to an obsolete completion', () =>
    Effect.gen(function* () {
      const {scope} = yield* fixture;
      const first = yield* requestRecallEmbeddings(scope);
      const second = yield* requestRecallEmbeddings({...scope, manifestPath: '/current/catalog.json'});
      expect(first).not.toBe(second);
      expect(yield* completeRecallEmbeddingDemand(scope, first)).toBe(false);
      expect((yield* readRecallEmbeddingDemand(scope))?.desired).toEqual({
        token: second,
        manifestPath: '/current/catalog.json',
      });
      expect(yield* completeRecallEmbeddingDemand(scope, second)).toBe(true);
      expect((yield* readRecallEmbeddingDemand(scope))?.desired).toBeUndefined();
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('coalesces equal configuration but supersedes a changed manifest without losing newer demand', () =>
    Effect.gen(function* () {
      const {scope} = yield* fixture;
      const first = yield* requestRecallEmbeddings({...scope, manifestPath: '/old/manifest.json'});
      expect(yield* requestRecallEmbeddings({...scope, manifestPath: '/old/manifest.json'}, true)).toBe(first);
      const changed = yield* requestRecallEmbeddings({...scope, manifestPath: '/new/manifest.json'}, true);
      expect(changed).not.toBe(first);
      expect(yield* completeRecallEmbeddingDemand(scope, first)).toBe(false);
      expect((yield* readRecallEmbeddingDemand(scope))?.desired).toEqual({
        token: changed,
        manifestPath: '/new/manifest.json',
      });
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('never recreates a removed home', () =>
    Effect.gen(function* () {
      const {scope, fs} = yield* fixture;
      yield* fs.remove(scope.agentContextHome, {recursive: true});
      expect((yield* Effect.result(requestRecallEmbeddings(scope)))._tag).toBe('Failure');
      expect(yield* fs.exists(scope.agentContextHome)).toBe(false);
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('keeps malformed existing state blocked instead of overwriting it', () =>
    Effect.gen(function* () {
      const {scope, fs} = yield* fixture;
      yield* requestRecallEmbeddings(scope);
      const path = yield* Path.Path;
      const directory = path.join(scope.agentContextHome, 'recall', 'embedding-demand-v1');
      const filename = Option.getOrThrow(
        EffectArray.findFirst(yield* fs.readDirectory(directory), name => EffectString.endsWith('.json')(name)),
      );
      yield* fs.writeFileString(path.join(directory, filename), '{"version":999}');
      expect((yield* Effect.result(requestRecallEmbeddings(scope)))._tag).toBe('Failure');
      expect(yield* fs.readFileString(path.join(directory, filename))).toBe('{"version":999}');
      const repaired = yield* repairRecallEmbeddingDemand(scope);
      expect((yield* readRecallEmbeddingDemand(scope))?.desired?.token).toBe(repaired);
      expect((yield* fs.readDirectory(directory)).length).toBe(2);
    }).pipe(provideFixtureLayer(platform)),
  );
  fcEffectProp(
    effectIt,
    'only the latest token can clear demand regardless of earlier completion order',
    {
      count: fc.integer({min: 1, max: 10}),
      order: fc.array(fc.nat(30), {maxLength: 15}),
    },
    ({count, order}) =>
      Effect.gen(function* () {
        const {scope} = yield* fixture;
        const tokens: string[] = [];
        for (let index = 0; index < count; index++) tokens.push(yield* requestRecallEmbeddings(scope));
        let pending = true;
        for (const value of order) {
          const index = value % count;
          const expected = pending && index === count - 1;
          expect(yield* completeRecallEmbeddingDemand(scope, tokens[index])).toBe(expected);
          if (expected) pending = false;
          expect(Boolean((yield* readRecallEmbeddingDemand(scope))?.desired)).toBe(pending);
        }
      }).pipe(provideFixtureLayer(platform)),
    {fastCheck: {numRuns: 16}},
  );
});

function provideFixtureLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(program: Effect.Effect<A, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))));
}

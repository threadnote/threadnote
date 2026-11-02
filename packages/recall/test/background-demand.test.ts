import * as EffectString from 'effect/String';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {expect, describe, vi} from 'vitest';
import * as SystemBoundary from '@threadnote/platform/system';
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
  for (const boundary of ['replacement', 'churn', 'unsafe'] as const)
    effectIt.effect(`reads coherent demand through ${boundary} without unbounded retries or unsafe fallback`, () =>
      Effect.gen(function* () {
        const {scope} = yield* fixture;
        const token = yield* requestRecallEmbeddings(scope);
        const original = SystemBoundary.runtimeReadBoundedStableRegularFile;
        let calls = 0;
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi
              .spyOn(SystemBoundary, 'runtimeReadBoundedStableRegularFile')
              .mockImplementation(async (filename, bound) => {
                calls++;
                if (boundary !== 'replacement' || calls === 1)
                  throw Object.assign(
                    new Error(
                      boundary === 'unsafe'
                        ? 'Target is not a bounded stable regular file.'
                        : 'Target changed during bounded read.',
                    ),
                    {
                      _tag: 'SystemOperationError',
                    },
                  );
                return original(filename, bound);
              }),
          ),
          () =>
            Effect.gen(function* () {
              const result = yield* readRecallEmbeddingDemand(scope).pipe(Effect.result);
              expect(result._tag).toBe(boundary === 'replacement' ? 'Success' : 'Failure');
              if (result._tag === 'Success') expect(result.success?.desired?.token).toBe(token);
              expect(calls).toBe(boundary === 'replacement' ? 2 : boundary === 'churn' ? 3 : 1);
            }),
          spy => Effect.sync(() => spy.mockRestore()),
        );
        expect((yield* readRecallEmbeddingDemand(scope))?.desired?.token).toBe(token);
      }).pipe(provideFixtureLayer(platform)),
    );
  effectIt.effect('survives independent callers and does not lose a later write to an obsolete completion', () =>
    Effect.gen(function* () {
      const {scope} = yield* fixture;
      const first = yield* requestRecallEmbeddings(scope);
      const firstRevision = (yield* readRecallEmbeddingDemand(scope))!.desired!.revision;
      const second = yield* requestRecallEmbeddings({...scope, manifestPath: '/current/catalog.json'});
      expect(first).not.toBe(second);
      expect(yield* completeRecallEmbeddingDemand(scope, first, firstRevision)).toBe(false);
      expect((yield* readRecallEmbeddingDemand(scope))?.desired).toEqual({
        token: second,
        revision: expect.any(String),
        manifestPath: '/current/catalog.json',
      });
      expect(
        yield* completeRecallEmbeddingDemand(
          scope,
          second,
          (yield* readRecallEmbeddingDemand(scope))!.desired!.revision,
        ),
      ).toBe(true);
      expect((yield* readRecallEmbeddingDemand(scope))?.desired).toBeUndefined();
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('coalesces equal configuration but supersedes a changed manifest without losing newer demand', () =>
    Effect.gen(function* () {
      const {scope} = yield* fixture;
      const first = yield* requestRecallEmbeddings({...scope, manifestPath: '/old/manifest.json'});
      const firstRevision = (yield* readRecallEmbeddingDemand(scope))!.desired!.revision;
      expect(yield* requestRecallEmbeddings({...scope, manifestPath: '/old/manifest.json'}, true)).toBe(first);
      const changed = yield* requestRecallEmbeddings({...scope, manifestPath: '/new/manifest.json'}, true);
      expect(changed).not.toBe(first);
      expect(yield* completeRecallEmbeddingDemand(scope, first, firstRevision)).toBe(false);
      expect((yield* readRecallEmbeddingDemand(scope))?.desired).toEqual({
        token: changed,
        revision: expect.any(String),
        manifestPath: '/new/manifest.json',
      });
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('fences every coalesced enqueue by event revision without trusting generation hints', () =>
    Effect.gen(function* () {
      const {scope} = yield* fixture;
      const token = yield* requestRecallEmbeddings(scope, true);
      const before = (yield* readRecallEmbeddingDemand(scope))!.desired!;
      expect(yield* requestRecallEmbeddings(scope, true)).toBe(token);
      const after = (yield* readRecallEmbeddingDemand(scope))!.desired!;
      expect(after.revision).not.toBe(before.revision);
      expect(yield* completeRecallEmbeddingDemand(scope, token, before.revision)).toBe(false);
      expect((yield* readRecallEmbeddingDemand(scope))!.desired).toEqual(after);
      expect(yield* completeRecallEmbeddingDemand(scope, token, after.revision)).toBe(true);
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('preserves legacy pending demand on read and atomically upgrades before a new event', () =>
    Effect.gen(function* () {
      const {scope, fs} = yield* fixture;
      const path = yield* Path.Path;
      const token = yield* requestRecallEmbeddings(scope);
      const directory = path.join(scope.agentContextHome, 'recall', 'embedding-demand-v1');
      const filename = Option.getOrThrow(
        EffectArray.findFirst(yield* fs.readDirectory(directory), name => EffectString.endsWith('.json')(name)),
      );
      const location = path.join(directory, filename);
      const legacy = JSON.stringify({version: 1, account: scope.account, user: scope.user, desired: {token}});
      yield* fs.writeFileString(location, legacy);
      expect((yield* readRecallEmbeddingDemand(scope))!.desired).toEqual({token, revision: token});
      expect(yield* fs.readFileString(location)).toBe(legacy);
      expect(yield* requestRecallEmbeddings(scope, true)).toBe(token);
      const current = (yield* readRecallEmbeddingDemand(scope))!.desired!;
      expect(current.revision).not.toBe(token);
      expect(yield* completeRecallEmbeddingDemand(scope, token, token)).toBe(false);
      expect(JSON.parse(yield* fs.readFileString(location)).version).toBe(2);
      expect(yield* completeRecallEmbeddingDemand(scope, token, current.revision)).toBe(true);
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
        const events: {token: string; revision: string}[] = [];
        for (let index = 0; index < count; index++) {
          yield* requestRecallEmbeddings(scope);
          events.push((yield* readRecallEmbeddingDemand(scope))!.desired!);
        }
        let pending = true;
        for (const value of order) {
          const index = value % count;
          const expected = pending && index === count - 1;
          expect(yield* completeRecallEmbeddingDemand(scope, events[index].token, events[index].revision)).toBe(
            expected,
          );
          if (expected) pending = false;
          expect(Boolean((yield* readRecallEmbeddingDemand(scope))?.desired)).toBe(pending);
        }
      }).pipe(provideFixtureLayer(platform)),
    {fastCheck: {numRuns: 16}},
  );
  fcEffectProp(
    effectIt,
    'an older observed event never clears a newer coalesced generation',
    {
      commands: fc.array(
        fc.record({kind: fc.constantFrom('publish', 'repeat', 'observe', 'complete'), slot: fc.nat(15)}),
        {minLength: 1, maxLength: 16},
      ),
    },
    ({commands}) =>
      Effect.gen(function* () {
        const {scope} = yield* fixture;
        let event = 0;
        let pending = false;
        const observed: {event: number; token: string; revision: string}[] = [];
        for (const command of commands) {
          if (command.kind === 'publish' || command.kind === 'repeat') {
            event++;
            yield* requestRecallEmbeddings(scope, true);
            pending = true;
          } else if (command.kind === 'observe') {
            const demand = (yield* readRecallEmbeddingDemand(scope))?.desired;
            if (demand) observed.push({event, token: demand.token, revision: demand.revision});
          } else if (observed.length > 0) {
            const candidate = observed[command.slot % observed.length];
            const expected = pending && candidate.event === event;
            expect(yield* completeRecallEmbeddingDemand(scope, candidate.token, candidate.revision)).toBe(expected);
            if (expected) pending = false;
          }
          expect(Boolean((yield* readRecallEmbeddingDemand(scope))?.desired)).toBe(pending);
        }
      }).pipe(provideFixtureLayer(platform)),
    {fastCheck: {numRuns: 24}},
  );
});

function provideFixtureLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(program: Effect.Effect<A, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))));
}

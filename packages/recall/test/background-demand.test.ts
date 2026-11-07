import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {scheduleMcpRecallBackgroundRefresh} from '../src/mcp/refresh.js';
import {cryptoLayer} from '@threadnote/platform/crypto';
import * as EffectString from 'effect/String';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Schema} from 'effect';
import {expect, describe, vi} from 'vitest';
import * as SystemBoundary from '@threadnote/platform/system';
import * as LockBoundary from '@threadnote/platform/file/lock';
import * as PlatformError from 'effect/PlatformError';
import {TestClock} from 'effect/testing';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import {SystemInfo} from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {
  completeRecallEmbeddingDemand,
  readRecallEmbeddingDemand,
  requestRecallEmbeddings,
  requestRecallEmbeddingsReceipt,
  recallEmbeddingDemandKey,
  RecallEmbeddingDemandUnavailable,
  repairRecallEmbeddingDemand,
} from '../src/background/demand.js';
const policy = Layer.mergeAll(
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
  Layer.succeed(ChildEnvironmentPolicy, {
    preserveIntendedChild: environment => environment,
    sanitizeExternal: environment => environment,
  }),
);
const platform = Layer.mergeAll(
  Layer.merge(BunServices.layer, cryptoLayer),
  SystemInfo.layer.pipe(Layer.provide(policy)),
);
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
              else {
                expect(result.failure.stage).toBe('read');
                expect(result.failure.reason).toBe(boundary === 'churn' ? 'state-changed' : 'invalid-file');
                expect(result.failure.message).toContain(
                  `[recall-demand:${result.failure.stage}/${result.failure.reason}]`,
                );
                expect(result.failure.message).not.toContain(scope.agentContextHome);
                expect(Buffer.byteLength(result.failure.message)).toBeLessThan(256);
              }
              expect(calls).toBe(boundary === 'replacement' ? 2 : boundary === 'churn' ? 3 : 1);
            }),
          spy => Effect.sync(() => spy.mockRestore()),
        );
        expect((yield* readRecallEmbeddingDemand(scope))?.desired?.token).toBe(token);
      }).pipe(provideFixtureLayer(platform)),
    );
  for (const changed of [false, true])
    effectIt.effect(
      `acknowledges each guarded event without an outside read when configuration ${changed ? 'changes' : 'coalesces'}`,
      () =>
        Effect.gen(function* () {
          const {scope, fs} = yield* fixture;
          const path = yield* Path.Path;
          const statePath = path.join(
            scope.agentContextHome,
            'recall/embedding-demand-v1',
            recallEmbeddingDemandKey(scope) + '.json',
          );
          const publishEntered = yield* Deferred.make<void, RecallEmbeddingDemandUnavailable>();
          const releasePublish = yield* Deferred.make<void>();
          const contended = yield* Deferred.make<void, RecallEmbeddingDemandUnavailable>();
          let guarded = false;
          let reads = 0;
          let first = true;
          const originalLock = LockBoundary.withExclusiveFileLock;
          const originalRead = SystemBoundary.runtimeReadBoundedStableRegularFile;
          const observedLock: typeof LockBoundary.withExclusiveFileLock = (fileSystem, lockPath, options, effect) =>
            originalLock(
              fileSystem,
              lockPath,
              {
                ...options,
                onAcquired: location =>
                  Effect.sync(() => {
                    guarded = true;
                  }).pipe(Effect.andThen(options.onAcquired?.(location) ?? Effect.void)),
                onCompleted: location =>
                  (options.onCompleted?.(location) ?? Effect.void).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        guarded = false;
                      }),
                    ),
                  ),
                onContention: location =>
                  Deferred.succeed(contended, undefined).pipe(
                    Effect.andThen(options.onContention?.(location) ?? Effect.void),
                  ),
              },
              effect,
            );
          const observedFs = FileSystem.FileSystem.of({
            ...fs,
            rename: (from, to) =>
              Effect.gen(function* () {
                if (first && to === statePath) {
                  first = false;
                  yield* Deferred.succeed(publishEntered, undefined);
                  yield* Deferred.await(releasePublish);
                }
                return yield* fs.rename(from, to);
              }),
          });
          const receipts = yield* Effect.acquireUseRelease(
            Effect.sync(() => ({
              lock: vi.spyOn(LockBoundary, 'withExclusiveFileLock').mockImplementation(observedLock),
              read: vi
                .spyOn(SystemBoundary, 'runtimeReadBoundedStableRegularFile')
                .mockImplementation(async (filename, bound) => {
                  if (filename === statePath) {
                    expect(guarded).toBe(true);
                    reads++;
                  }
                  return originalRead(filename, bound);
                }),
            })),
            () =>
              Effect.gen(function* () {
                const firstRequest = yield* requestRecallEmbeddingsReceipt(scope, true).pipe(
                  Effect.provideService(FileSystem.FileSystem, observedFs),
                  Effect.tapError(error => Deferred.fail(publishEntered, error)),
                  Effect.forkScoped,
                );
                yield* Deferred.await(publishEntered);
                const secondRequest = yield* requestRecallEmbeddingsReceipt(
                  {...scope, ...(changed ? {manifestPath: '/new/manifest.json'} : {})},
                  true,
                ).pipe(
                  Effect.tapError(error => Deferred.fail(contended, error)),
                  Effect.forkScoped,
                );
                yield* Deferred.await(contended);
                yield* Deferred.succeed(releasePublish, undefined);
                const a = yield* Fiber.join(firstRequest);
                yield* TestClock.adjust(10);
                const b = yield* Fiber.join(secondRequest);
                return {a, b};
              }).pipe(Effect.ensuring(Deferred.succeed(releasePublish, undefined))),
            spies =>
              Effect.sync(() => {
                spies.read.mockRestore();
                spies.lock.mockRestore();
              }),
          );
          expect(reads).toBe(1);
          expect(receipts.a.disposition).toBe('scheduled');
          expect(receipts.b.disposition).toBe('coalesced');
          expect(receipts.b.revision).not.toBe(receipts.a.revision);
          expect(receipts.b.token === receipts.a.token).toBe(!changed);
          expect((yield* readRecallEmbeddingDemand(scope))?.desired).toMatchObject({
            token: receipts.b.token,
            revision: receipts.b.revision,
          });
          expect(yield* completeRecallEmbeddingDemand(scope, receipts.a.token, receipts.a.revision)).toBe(false);
          expect((yield* readRecallEmbeddingDemand(scope))?.desired?.revision).toBe(receipts.b.revision);
        }).pipe(provideFixtureLayer(platform)),
      {timeout: 5000},
    );

  effectIt.effect('the MCP schedule derives its label from the single guarded demand read', () =>
    Effect.gen(function* () {
      const {scope} = yield* fixture;
      const initial = yield* requestRecallEmbeddingsReceipt(scope, true);
      const manifest = Option.getOrThrow(
        EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-small-en-v1.5-q8'),
      );
      const path = yield* Path.Path;
      const filename = path.join(
        scope.agentContextHome,
        'recall/embedding-demand-v1',
        recallEmbeddingDemandKey(scope) + '.json',
      );
      const original = SystemBoundary.runtimeReadBoundedStableRegularFile;
      let reads = 0;
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(SystemBoundary, 'runtimeReadBoundedStableRegularFile').mockImplementation(async (target, bound) => {
            if (target === filename) reads++;
            return original(target, bound);
          }),
        ),
        () =>
          scheduleMcpRecallBackgroundRefresh(scope, manifest).pipe(
            Effect.tap(label => Effect.sync(() => expect(label).toBe('coalesced'))),
          ),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      expect(reads).toBe(1);
      expect((yield* readRecallEmbeddingDemand(scope))?.desired?.revision).not.toBe(initial.revision);
    }).pipe(provideFixtureLayer(platform)),
  );

  for (const invalid of ['utf8', 'scope'] as const)
    effectIt.effect(`keeps ${invalid} state failure classified and blocked`, () =>
      Effect.gen(function* () {
        const {scope, fs} = yield* fixture;
        yield* requestRecallEmbeddings(scope);
        const path = yield* Path.Path;
        const filename = path.join(
          scope.agentContextHome,
          'recall/embedding-demand-v1',
          recallEmbeddingDemandKey(scope) + '.json',
        );
        const rejected =
          invalid === 'utf8'
            ? new Uint8Array([255])
            : new TextEncoder().encode(JSON.stringify({version: 2, account: 'different', user: scope.user}));
        yield* fs.writeFile(filename, rejected);
        const result = yield* requestRecallEmbeddingsReceipt(scope).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure')
          expect({stage: result.failure.stage, reason: result.failure.reason}).toEqual({
            stage: 'validate',
            reason: invalid === 'utf8' ? 'invalid-utf8' : 'scope-mismatch',
          });
        expect(new Uint8Array(yield* fs.readFile(filename))).toEqual(rejected);
      }).pipe(provideFixtureLayer(platform)),
    );

  effectIt.effect('reports the unchanged guard timeout without a queued receipt or owner recovery', () =>
    Effect.gen(function* () {
      const {scope, fs} = yield* fixture;
      const before = yield* requestRecallEmbeddingsReceipt(scope);
      const path = yield* Path.Path;
      const guard = path.join(
        scope.agentContextHome,
        'recall/embedding-demand-v1',
        recallEmbeddingDemandKey(scope) + '.lock',
      );
      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const contention = yield* Deferred.make<void>();
      const holder = yield* LockBoundary.withExclusiveFileLock(
        fs,
        guard,
        {
          createParentDirectory: false,
          retryIntervalMilliseconds: 10,
          staleAfterMilliseconds: 5000,
          waitTimeoutMilliseconds: 1000,
          useCanonicalProcessStartIdentity: true,
          onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
        },
        Deferred.await(release),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(acquired);
      const original = LockBoundary.withExclusiveFileLock;
      const observed: typeof LockBoundary.withExclusiveFileLock = (fileSystem, lockPath, options, effect) => {
        expect(options.waitTimeoutMilliseconds).toBe(1000);
        expect(options.retryIntervalMilliseconds).toBe(10);
        expect(options.staleAfterMilliseconds).toBe(5000);
        return original(
          fileSystem,
          lockPath,
          {...options, onContention: () => Deferred.succeed(contention, undefined).pipe(Effect.asVoid)},
          effect,
        );
      };
      yield* Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(LockBoundary, 'withExclusiveFileLock').mockImplementation(observed)),
        () =>
          Effect.gen(function* () {
            const caller = yield* requestRecallEmbeddingsReceipt(scope, true).pipe(Effect.result, Effect.forkScoped);
            yield* Deferred.await(contention);
            yield* TestClock.adjust(1000);
            const result = yield* Fiber.join(caller);
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure')
              expect({stage: result.failure.stage, reason: result.failure.reason}).toEqual({
                stage: 'guard',
                reason: 'guard-timeout',
              });
            if (result._tag === 'Failure') {
              expect(result.failure.message).toContain('[recall-demand:guard/guard-timeout]');
              expect(result.failure.message).not.toContain(scope.agentContextHome);
              expect(Buffer.byteLength(result.failure.message)).toBeLessThan(256);
            }
            expect(yield* fs.exists(guard)).toBe(true);
            expect((yield* readRecallEmbeddingDemand(scope))?.desired?.revision).toBe(before.revision);
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      yield* Fiber.join(holder);
    }).pipe(provideFixtureLayer(platform)),
  );

  fcEffectProp(
    effectIt,
    'typed publish failures retain only closed diagnostics and never acknowledge or expose input',
    {
      operation: fc.constantFrom('write', 'sync', 'rename'),
      text: fc.string({minLength: 1, maxLength: 100}),
    },
    ({operation, text}) =>
      Effect.gen(function* () {
        const {scope, fs} = yield* fixture;
        const before = yield* requestRecallEmbeddingsReceipt(scope);
        const failure = PlatformError.systemError({
          _tag: 'PermissionDenied',
          module: 'FileSystem',
          method: operation,
          description: text,
          pathOrDescriptor: text,
          cause: {private: text},
        });
        const observed = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (...args) =>
            operation === 'write' && EffectString.endsWith('.tmp')(args[0])
              ? Effect.fail(failure)
              : fs.writeFileString(...args),
          rename: (...args) =>
            operation === 'rename' && EffectString.endsWith('.tmp')(args[0])
              ? Effect.fail(failure)
              : fs.rename(...args),
          open: (...args) =>
            fs.open(...args).pipe(
              Effect.flatMap(file =>
                Effect.gen(function* () {
                  if (operation !== 'sync' || !EffectString.endsWith('.tmp')(args[0])) return file;
                  const spy = vi.spyOn(file, 'sync', 'get').mockReturnValue(Effect.fail(failure));
                  yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
                  return file;
                }),
              ),
            ),
        });
        const result = yield* requestRecallEmbeddingsReceipt(scope, true).pipe(
          Effect.provideService(FileSystem.FileSystem, observed),
          Effect.result,
        );
        expect(result._tag).toBe('Failure');
        if (result._tag !== 'Failure') return yield* Effect.die('Expected failed publish, not an acknowledgment');
        const checked = yield* Schema.decodeEffect(RecallEmbeddingDemandUnavailable)(result.failure);
        expect({message: checked.message, stage: checked.stage, reason: checked.reason}).toEqual({
          message: 'Recall embedding demand is unavailable [recall-demand:publish/io]; no queued receipt is implied.',
          stage: 'publish',
          reason: 'io',
        });
        expect('cause' in checked).toBe(false);
        expect((yield* readRecallEmbeddingDemand(scope))?.desired?.revision).toBe(before.revision);
      }).pipe(provideFixtureLayer(platform)),
    {fastCheck: {numRuns: 12}},
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

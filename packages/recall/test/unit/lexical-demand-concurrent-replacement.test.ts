import fc from 'fast-check';
import * as EffectString from 'effect/String';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Effect, Exit, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, vi} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import * as System from '@threadnote/platform/system';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {
  completeRecallLexicalRefresh,
  readRecallLexicalDemand,
  recallLexicalDemandKey,
  requestRecallLexicalRefresh,
} from '../../src/background/lexical-demand.js';

const system = System.SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
      Layer.succeed(ChildEnvironmentPolicy, {preserveIntendedChild: env => env, sanitizeExternal: env => env}),
    ),
  ),
);
const platform = Layer.mergeAll(BunServices.layer, cryptoLayer, system);
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(platform).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context))))).pipe(
    TestClock.withLive,
  );
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'lexical-demand-read-race-'});
  for (const child of ['home', 'repository', 'installationRoot']) yield* fs.makeDirectory(path.join(root, child));
  const scope = {account: 'local', user: 'reader', agentContextHome: path.join(root, 'home'), includeInactive: false};
  const revision = yield* requestRecallLexicalRefresh(scope);
  const state = path.join(
    scope.agentContextHome,
    'recall',
    'lexical-demand-v1',
    recallLexicalDemandKey(scope) + '.json',
  );
  return {fs, path, root, scope, revision, state};
});

effectIt.effect('reads the current valid revision through a legitimate atomic demand replacement', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const native = process.getBuiltinModule('fs').promises;
    const originalOpen = native.open.bind(native);
    const originalRead = System.runtimeReadBoundedRegularFileAttempt;
    // These Promise latches adapt the native fs Promise boundary; all Effect
    // lifecycle, writer, reader-fiber synchronization and assertions stay scoped.
    let entered!: () => void;
    const reached = new Promise<void>(resolve => {
      entered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    let paused = false;
    const outcomes: string[] = [];
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const readSpy = vi.spyOn(System, 'runtimeReadBoundedRegularFileAttempt').mockImplementation(async (...args) => {
          const result = await originalRead(...args);
          outcomes.push(result.status);
          return result;
        });
        const openSpy = vi.spyOn(native, 'open').mockImplementation(async (...args) => {
          if (args[0] === f.state && !paused) {
            paused = true;
            entered();
            await released;
          }
          return originalOpen(...args);
        });
        return {readSpy, openSpy};
      }),
      () =>
        Effect.gen(function* () {
          const reader = yield* Effect.forkScoped(readRecallLexicalDemand(f.scope).pipe(Effect.result));
          yield* Effect.promise(() => reached);
          // The stable reader already lstat'ed A; this real writer publishes B
          // using the unchanged exclusive update lock/fsync/atomic rename path.
          const newer = yield* requestRecallLexicalRefresh(f.scope);
          expect(newer).not.toBe(f.revision);
          const published = yield* f.fs.readFileString(f.state);
          yield* Effect.sync(release);
          const result = yield* Fiber.join(reader);
          expect(result._tag).toBe('Success');
          if (result._tag === 'Success') expect(result.success?.revision).toBe(newer);
          expect(outcomes).toContain('replaced');
          expect(yield* f.fs.readFileString(f.state)).toBe(published);
          expect((yield* readRecallLexicalDemand(f.scope))?.revision).toBe(newer);
          expect(yield* completeRecallLexicalRefresh(f.scope, f.revision)).toBe(false);
          expect(yield* f.fs.readFileString(f.state)).toBe(published);
        }),
      spies =>
        Effect.sync(() => {
          release();
          spies.openSpy.mockRestore();
          spies.readSpy.mockRestore();
        }),
    );
  }).pipe(provide),
);

effectIt.effect('retains symlink, nonregular, size, invalid-state and scope guards without reader mutation', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const original = yield* f.fs.readFileString(f.state);
    const assertUnavailable = Effect.gen(function* () {
      const result = yield* readRecallLexicalDemand(f.scope).pipe(Effect.result);
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') expect(result.failure).toMatchObject({_tag: 'RecallLexicalDemandUnavailable'});
    });
    const target = f.path.join(f.root, 'valid-target.json');
    yield* f.fs.writeFileString(target, original);
    yield* f.fs.remove(f.state);
    yield* f.fs.symlink(target, f.state);
    yield* assertUnavailable;
    expect(yield* f.fs.readLink(f.state)).toBe(target);
    expect(yield* f.fs.readFileString(target)).toBe(original);
    yield* f.fs.remove(f.state);
    yield* f.fs.makeDirectory(f.state);
    yield* assertUnavailable;
    expect((yield* f.fs.stat(f.state)).type).toBe('Directory');
    yield* f.fs.remove(f.state, {recursive: true});
    for (const text of [
      EffectString.repeat(8193)('x'),
      '{}',
      JSON.stringify({...JSON.parse(original), user: 'wrong-scope'}),
    ]) {
      yield* f.fs.writeFileString(f.state, text);
      yield* assertUnavailable;
      expect(yield* f.fs.readFileString(f.state)).toBe(text);
    }
  }).pipe(provide),
);

const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return {promise, release};
};

fcEffectProp(
  effectIt,
  'reads the modeled latest revision after arbitrary finite opening/read replacement churn',
  {count: fc.integer({min: 3, max: 7}), stage: fc.constantFrom('opening', 'read')},
  ({count, stage}) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = process.getBuiltinModule('fs').promises;
      const originalOpen = native.open.bind(native);
      const gates = Array.from({length: count}, () => ({entered: latch(), resume: latch()}));
      let index = 0;
      let writerRunning = false;
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(native, 'open').mockImplementation(async (...args) => {
            const gate = args[0] === f.state && !writerRunning ? gates[index++] : undefined;
            if (gate && stage === 'opening') {
              gate.entered.release();
              await gate.resume.promise;
            }
            const handle = await originalOpen(...args);
            if (gate && stage === 'read') {
              const originalRead = handle.read.bind(handle);
              let first = true;
              handle.read = async (...readArgs) => {
                const result = await Reflect.apply(originalRead, handle, readArgs);
                if (first) {
                  first = false;
                  gate.entered.release();
                  await gate.resume.promise;
                }
                return result;
              };
            }
            return handle;
          }),
        ),
        () =>
          Effect.gen(function* () {
            const reader = yield* Effect.forkScoped(readRecallLexicalDemand(f.scope));
            let latest = f.revision;
            for (const gate of gates) {
              yield* Effect.promise(() => gate.entered.promise);
              writerRunning = true;
              latest = yield* requestRecallLexicalRefresh(f.scope).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    writerRunning = false;
                  }),
                ),
              );
              gate.resume.release();
            }
            const before = yield* f.fs.readFileString(f.state);
            expect((yield* Fiber.join(reader))?.revision).toBe(latest);
            expect(yield* f.fs.readFileString(f.state)).toBe(before);
            expect(yield* completeRecallLexicalRefresh(f.scope, f.revision)).toBe(false);
          }),
        spy =>
          Effect.sync(() => {
            for (const gate of gates) gate.resume.release();
            spy.mockRestore();
          }),
      );
    }).pipe(provide),
  {fastCheck: {numRuns: 8}},
);

for (const stage of ['open', 'stat', 'read', 'close'] as const) {
  effectIt.effect(`awaits physical descriptor close on cancellation during ${stage}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = process.getBuiltinModule('fs').promises;
      const originalOpen = native.open.bind(native);
      const originalAttempt = System.runtimeReadBoundedRegularFileAttempt;
      const entered = latch(),
        resume = latch(),
        aborted = latch();
      let signal: AbortSignal | undefined;
      let closed = false;
      const afterAbort: string[] = [];
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const attempt = vi
            .spyOn(System, 'runtimeReadBoundedRegularFileAttempt')
            .mockImplementation((path, bound, options) => {
              signal = options?.signal;
              signal?.addEventListener('abort', aborted.release, {once: true});
              return originalAttempt(path, bound, options);
            });
          const open = vi.spyOn(native, 'open').mockImplementation(async (...args) => {
            const handle = await originalOpen(...args);
            if (args[0] !== f.state) return handle;
            const stat = handle.stat.bind(handle),
              read = handle.read.bind(handle),
              close = handle.close.bind(handle);
            let firstStat = true,
              firstRead = true;
            Object.defineProperty(handle, 'stat', {
              value: async (...statArgs: Parameters<typeof handle.stat>) => {
                if (signal?.aborted) afterAbort.push('stat');
                const value = await Reflect.apply(stat, handle, statArgs);
                if (stage === 'stat' && firstStat) {
                  firstStat = false;
                  entered.release();
                  await resume.promise;
                }
                return value;
              },
            });
            handle.read = async (...readArgs) => {
              if (signal?.aborted) afterAbort.push('read');
              const value = await Reflect.apply(read, handle, readArgs);
              if (stage === 'read' && firstRead) {
                firstRead = false;
                entered.release();
                await resume.promise;
              }
              return value;
            };
            handle.close = async () => {
              if (stage === 'close') {
                entered.release();
                await resume.promise;
              }
              await close();
              closed = true;
            };
            if (stage === 'open') {
              entered.release();
              await resume.promise;
            }
            return handle;
          });
          return {attempt, open};
        }),
        () =>
          Effect.gen(function* () {
            const reader = yield* Effect.forkScoped(readRecallLexicalDemand(f.scope));
            yield* Effect.promise(() => entered.promise);
            let interrupted = false;
            const interrupt = yield* Effect.forkScoped(
              Fiber.interrupt(reader).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ),
            );
            yield* Effect.promise(() => aborted.promise);
            expect(closed).toBe(false);
            expect(interrupted).toBe(false);
            resume.release();
            yield* Fiber.join(interrupt);
            expect(closed).toBe(true);
            expect(afterAbort).toEqual([]);
          }),
        spies =>
          Effect.sync(() => {
            resume.release();
            spies.open.mockRestore();
            spies.attempt.mockRestore();
          }),
      );
    }).pipe(provide),
  );
}

for (const failure of ['missing', 'permission', 'not-permitted', 'unknown', 'dangling-link'] as const) {
  effectIt.effect(`distinguishes genuine initial ${failure} without read-side writes`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.remove(f.state);
      if (failure === 'dangling-link') yield* f.fs.symlink(f.path.join(f.root, 'absent'), f.state);
      const native = process.getBuiltinModule('fs').promises;
      const original = native.lstat.bind(native);
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(native, 'lstat').mockImplementation((...args) => {
            if (
              args[0] === f.state &&
              (failure === 'permission' || failure === 'not-permitted' || failure === 'unknown')
            )
              return Promise.reject(
                Object.assign(new Error('private sentinel'), {
                  code: failure === 'permission' ? 'EACCES' : failure === 'not-permitted' ? 'EPERM' : 'EIO',
                }),
              );
            return original(...args);
          }),
        ),
        () =>
          Effect.gen(function* () {
            const before = yield* f.fs.readDirectory(f.path.dirname(f.state));
            const result = yield* readRecallLexicalDemand(f.scope).pipe(Effect.result);
            expect(result._tag).toBe(failure === 'missing' ? 'Success' : 'Failure');
            if (result._tag === 'Success') expect(result.success).toBeUndefined();
            expect(yield* f.fs.readDirectory(f.path.dirname(f.state))).toEqual(before);
          }),
        spy => Effect.sync(() => spy.mockRestore()),
      );
    }).pipe(provide),
  );
}

for (const work of [
  {kind: 'anchors' as const, callerCwd: '/repository', repositoryId: 'repo', worktreeId: 'tree', codeRefs: ['a.ts']},
  {kind: 'synchronize' as const, sources: false, teams: ['docs', 'engineering']},
]) {
  effectIt.effect(`retains stable ${work.kind} key equivalence across coalesced fields`, () =>
    Effect.gen(function* () {
      const {scope} = yield* fixture;
      const original = {...scope, work};
      const newer = {
        ...scope,
        work:
          work.kind === 'anchors'
            ? {...work, callerCwd: '/repository/next', codeRefs: ['b.ts']}
            : {...work, teams: ['engineering', 'docs']},
      };
      yield* requestRecallLexicalRefresh(original);
      const revision = yield* requestRecallLexicalRefresh(newer);
      expect((yield* readRecallLexicalDemand(original))?.revision).toBe(revision);
    }).pipe(provide),
  );
}

const assertChurnReaderPending = <A, E>(reader: Fiber.Fiber<A, E>, progress: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const observed = yield* Effect.race(
      progress.pipe(Effect.as('progress' as const)),
      Fiber.await(reader).pipe(Effect.as('terminated' as const)),
    );
    expect(observed).toBe('progress');
    expect(reader.pollUnsafe()).toBeUndefined();
  });

for (const stop of ['cancel', 'external-deadline'] as const) {
  effectIt.effect(`yields fairly during continuous proven replacement until ${stop}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const progress = latch(),
        resume = latch();
      let attempts = 0;
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi
            .spyOn(System, 'runtimeReadBoundedRegularFileAttempt')
            .mockImplementation(async (_path, _bound, options) => {
              attempts++;
              if (attempts === 2) {
                progress.release();
                const signal = options?.signal;
                signal?.addEventListener('abort', resume.release, {once: true});
                try {
                  if (!signal?.aborted) await resume.promise;
                } finally {
                  signal?.removeEventListener('abort', resume.release);
                }
              }
              return {status: 'replaced'};
            }),
        ),
        () =>
          Effect.gen(function* () {
            const work = readRecallLexicalDemand(f.scope);
            const reader = yield* Effect.forkScoped(
              stop === 'external-deadline' ? work.pipe(Effect.timeout('1 second')) : work,
            );
            // Reaching the second attempt proves the first replacement was processed
            // and the caller was scheduled. Any earlier child exit fails immediately.
            yield* assertChurnReaderPending(
              reader,
              Effect.promise(() => progress.promise),
            );
            expect(attempts).toBe(2);
            if (stop === 'cancel') yield* Fiber.interrupt(reader);
            else yield* TestClock.adjust('1 second');
            const exit = yield* Fiber.await(reader);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              if (stop === 'cancel') expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
              else {
                expect(exit.cause.reasons).toHaveLength(1);
                const reason = exit.cause.reasons[0];
                expect(reason !== undefined && Cause.isFailReason(reason) && Cause.isTimeoutError(reason.error)).toBe(
                  true,
                );
              }
            }
            const settled = attempts;
            yield* Effect.yieldNow;
            expect(attempts).toBe(settled);
          }),
        spy =>
          Effect.sync(() => {
            resume.release();
            spy.mockRestore();
          }),
      );
    }).pipe(effect =>
      Effect.scoped(Layer.build(platform).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context))))),
    ),
  );
}

for (const premature of ['success', 'typed-failure', 'defect'] as const) {
  effectIt.effect(`the churn pending assertion rejects premature ${premature}`, () =>
    Effect.gen(function* () {
      const work =
        premature === 'success'
          ? Effect.void
          : premature === 'typed-failure'
            ? Effect.fail('premature-typed-failure')
            : Effect.die('premature-defect');
      const reader = yield* Effect.forkScoped(work);
      const assertion = yield* assertChurnReaderPending(reader, Effect.never).pipe(Effect.exit);
      expect(Exit.isFailure(assertion)).toBe(true);
      if (Exit.isFailure(assertion)) expect(Cause.hasDies(assertion.cause)).toBe(true);
      const exit = yield* Fiber.await(reader);
      expect(Exit.isSuccess(exit)).toBe(premature === 'success');
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(premature === 'defect');
        expect(Cause.squash(exit.cause)).toBe(premature === 'defect' ? 'premature-defect' : 'premature-typed-failure');
      }
    }),
  );
}

for (const next of ['missing', 'invalid-utf8', 'wrong-account', 'wrong-user', 'wrong-manifest'] as const) {
  effectIt.effect(`never converts ${next} after replacement into successful absence or cached state`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const original = System.runtimeReadBoundedRegularFileAttempt;
      let attempts = 0;
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(System, 'runtimeReadBoundedRegularFileAttempt').mockImplementation(async (...args) => {
            attempts++;
            if (attempts === 1) return {status: 'replaced'};
            if (next === 'missing') return {status: 'missing'};
            if (next === 'invalid-utf8') return {status: 'read', bytes: new Uint8Array([255])};
            const result = await original(...args);
            if (result.status !== 'read') throw new Error('Expected stable fixture');
            const state = JSON.parse(new TextDecoder().decode(result.bytes));
            if (next === 'wrong-account') state.account = 'wrong';
            if (next === 'wrong-user') state.user = 'wrong';
            if (next === 'wrong-manifest') state.manifestPath = '/wrong/manifest';
            return {status: 'read', bytes: new TextEncoder().encode(JSON.stringify(state))};
          }),
        ),
        () =>
          Effect.gen(function* () {
            const before = yield* f.fs.readFileString(f.state);
            const result = yield* readRecallLexicalDemand(f.scope).pipe(Effect.result);
            expect(result._tag).toBe('Failure');
            expect(attempts).toBe(2);
            expect(yield* f.fs.readFileString(f.state)).toBe(before);
          }),
        spy => Effect.sync(() => spy.mockRestore()),
      );
    }).pipe(provide),
  );
}

effectIt.effect('keeps update previous-state reads strict inside the existing mutation lock', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const original = System.runtimeReadBoundedRegularFileAttempt;
    const modes: Array<string | undefined> = [];
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(System, 'runtimeReadBoundedRegularFileAttempt').mockImplementation(async (...args) => {
          modes.push(args[2]?.replacement);
          return original(...args);
        }),
      ),
      () =>
        Effect.gen(function* () {
          yield* requestRecallLexicalRefresh(f.scope);
          expect(modes).toEqual(['reject']);
          yield* readRecallLexicalDemand(f.scope);
          expect(modes).toEqual(['reject', 'classify']);
        }),
      spy => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(provide),
);

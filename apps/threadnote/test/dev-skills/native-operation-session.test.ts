import {it} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceStore} from '@threadnote/store/resource-store';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {resourceAccountMutationLockPath, resourceAccountMutationLockPolicy} from '@threadnote/store/resource/lock';
import {
  expireRecallIndexValidation,
  loadRecallMemoryIdentities,
  recallIndexDatabaseFilename,
} from '@threadnote/recall/index';
import {withNativeWorkflowMemorySession, runWorkflowMemory} from '../../src/workflow_memory/index.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

type Call = (
  input: unknown,
) => Effect.Effect<
  unknown,
  Effect.Error<ReturnType<typeof runWorkflowMemory>>,
  Effect.Services<ReturnType<typeof runWorkflowMemory>>
>;
const fixture = Effect.gen(function* () {
  const f = yield* nativeFixture();
  const system = yield* SystemInfo;
  const scopedSystem = {...system, currentDirectory: () => f.repo, environment: () => ({})};
  const initialized = yield* f.init();
  const written = yield* Schema.decodeUnknownEffect(
    Schema.Struct({artifact: Schema.Struct({uri: Schema.String, memoryId: Schema.String, revision: Schema.String})}),
  )(yield* f.call(f.write()));
  const read = {protocolVersion: 1, action: 'read', bindingId: initialized.bindingId, uri: written.artifact.uri};
  return {...f, bindingId: initialized.bindingId, artifact: written.artifact, scopedSystem, read};
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);

describe('native child lower-memory sessions', () => {
  for (const pinned of [false, true])
    it.effect(`preserves memory-busy through lexical admission with pinned evidence=${pinned}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const system = yield* SystemInfo;
        yield* loadRecallMemoryIdentities(f.config, {
          allowedUriScopes: [f.artifact.uri],
          memoryIds: [f.artifact.memoryId],
        });
        const lock = f.path.join(
          f.home,
          'threadnote',
          'memory-locks',
          sha256HexSync('threadnote-internal://deferred-code-anchor-mutations/local/tester') + '.lock',
        );
        yield* f.fs.writeFileString(
          lock,
          JSON.stringify({
            version: 1,
            processId: system.processId,
            processStartIdentity: 'holder-start',
            token: 'private-token',
          }),
        );
        const request = f.write({
          operationId: 'pinned-memory-busy',
          artifactKey: 'pinned-memory-busy',
          ...(pinned
            ? {evidenceRefs: [{uri: f.artifact.uri, memoryId: f.artifact.memoryId, revision: f.artifact.revision}]}
            : {}),
        });
        const outcome = yield* f.call(request).pipe(Effect.result, Effect.timeoutOption('5 seconds'));
        expect(outcome).toMatchObject({
          _tag: 'Some',
          value: {_tag: 'Failure', failure: {code: 'memory-busy', retryable: true}},
        });
        if (EffectOption.isNone(outcome) || !Result.isFailure(outcome.value)) throw new Error('Expected busy result');
        const message = outcome.value.failure.message;
        expect(message).toContain('memory lock is busy');
        expect(message).toContain(`Holder PID ${system.processId}`);
        expect(message).toMatch(/start [a-f0-9]{16}/);
        expect(message).toMatch(/Acquisition wait \d+ms here, \d+ms in this attempt/);
        for (const unsafe of [f.home, 'holder-start', 'private-token']) expect(message).not.toContain(unsafe);
        yield* f.fs.remove(lock);
        expect(yield* f.call({...f.base('recover'), operationId: 'pinned-memory-busy'})).toMatchObject({status: 'ok'});
      }).pipe(run),
    );

  for (const pinned of [false, true])
    it.effect(`shares real native acquisition waiting with pinned evidence=${pinned}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const system = yield* SystemInfo;
        const rawStart = 'private-holder-start /do-not-print';
        const rawToken = 'private-holder-token';
        const owner = JSON.stringify({
          version: 1,
          processId: system.processId,
          processStartIdentity: rawStart,
          token: rawToken,
        });
        const runPath = (yield* f.fs.realPath(f.statePath())) + '.lock';
        const journalPath = f.path.join(f.home, 'workflow-memory', f.bindingId + '.json.lock');
        const memoryPath = f.path.join(
          f.home,
          'threadnote',
          'memory-locks',
          sha256HexSync('threadnote-internal://deferred-code-anchor-mutations/local/tester') + '.lock',
        );
        const accountPath = resourceAccountMutationLockPath(f.path, f.home, f.config.account);
        yield* loadRecallMemoryIdentities(f.config, {
          allowedUriScopes: [f.artifact.uri],
          memoryIds: [f.artifact.memoryId],
        });
        const runBlocked = yield* Deferred.make<void>();
        const journalBlocked = yield* Deferred.make<void>();
        const memoryBlocked = yield* Deferred.make<void>();
        const barriers = [
          [runPath, runBlocked],
          [journalPath, journalBlocked],
          [memoryPath, memoryBlocked],
        ] as const;
        const targets = new Map(EffectArray.map(barriers, ([file, barrier]) => [f.path.basename(file), barrier]));
        const observedContention = new Set<string>();
        let accountHeld = false;
        const observed = FileSystem.FileSystem.of({
          ...f.fs,
          writeFileString: (file, content, options) =>
            f.fs.writeFileString(file, content, options).pipe(
              Effect.tapError(() => {
                const barrier = options?.flag === 'wx' ? targets.get(f.path.basename(file)) : undefined;
                if (!barrier) return Effect.void;
                observedContention.add(f.path.basename(file));
                return Deferred.succeed(barrier, undefined).pipe(Effect.asVoid);
              }),
              Effect.tap(() => {
                if (file !== memoryPath || options?.flag !== 'wx' || accountHeld) return Effect.void;
                accountHeld = true;
                return f.fs.writeFileString(accountPath, owner);
              }),
            ),
        });
        for (const [file] of barriers) yield* f.fs.writeFileString(file, owner);
        const releaser = yield* Effect.forEach(
          barriers,
          ([file, barrier]) =>
            Deferred.await(barrier).pipe(Effect.andThen(Effect.sleep(400)), Effect.andThen(f.fs.remove(file))),
          {concurrency: 'unbounded'},
        ).pipe(Effect.forkChild);
        const request = f.write({
          operationId: 'cumulative-native',
          artifactKey: 'cumulative-native',
          ...(pinned
            ? {evidenceRefs: [{uri: f.artifact.uri, memoryId: f.artifact.memoryId, revision: f.artifact.revision}]}
            : {}),
        });
        const outcome = yield* f
          .call(request)
          .pipe(
            Effect.provideService(FileSystem.FileSystem, observed),
            Effect.result,
            Effect.timeoutOption('5 seconds'),
          );
        yield* Fiber.interrupt(releaser);
        expect(outcome).toMatchObject({
          _tag: 'Some',
          value: {_tag: 'Failure', failure: {code: 'memory-busy', retryable: true}},
        });
        if (outcome._tag !== 'Some' || Result.isSuccess(outcome.value)) throw new Error('Expected native busy');
        const message = outcome.value.failure.message;
        expect(observedContention).toEqual(new Set(targets.keys()));
        expect(accountHeld).toBe(true);
        expect(message).toContain('canonical-account');
        expect(message).toContain(`PID ${system.processId}`);
        expect(message).toMatch(/start [a-f0-9]{16}/u);
        const waiting = /Acquisition wait ([0-9]+)ms here, ([0-9]+)ms in this attempt/u.exec(message);
        expect(waiting).not.toBeNull();
        expect(Number(waiting?.[1])).toBeLessThan(1900);
        expect(Number(waiting?.[2])).toBeGreaterThanOrEqual(2000);
        expect(Number(waiting?.[2])).toBeLessThan(2500);
        expect(message).not.toContain(f.home);
        expect(message).not.toContain(rawStart);
        expect(message).not.toContain(rawToken);
        expect(yield* f.fs.exists(runPath)).toBe(false);
        expect(yield* f.fs.exists(journalPath)).toBe(false);
        expect(yield* f.fs.readDirectory(f.path.dirname(memoryPath))).toEqual([]);
        yield* f.fs.remove(accountPath);
        expect(yield* f.call({...f.base('recover'), operationId: 'cumulative-native'})).toMatchObject({status: 'ok'});
      }).pipe(run),
    );

  for (const route of ['session', 'executor'] as const)
    it.effect(`returns busy during initial ${route} evidence preparation and resumes the same operation`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const evidenceRefs = [{uri: f.artifact.uri, memoryId: f.artifact.memoryId, revision: f.artifact.revision}];
        const operationId = 'initial-readiness';
        const body = 'Same intent after readiness contention.\n';
        const request = {
          protocolVersion: 1,
          action: 'create',
          bindingId: f.bindingId,
          operationId,
          artifactKey: 'initial-readiness',
          role: 'evidence',
          sourceRunId: 'native-run',
          storageKind: 'durable',
          body,
          bodySha256: sha256HexSync(body),
          expectedRevision: null,
          evidenceRefs,
        };
        const nativeRequest = f.write({operationId, artifactKey: 'initial-readiness', body, evidenceRefs});
        const session = (input: unknown) =>
          withNativeWorkflowMemorySession(f.config, f.bindingId, (_admission, call) => call(input)).pipe(
            Effect.provideService(SystemInfo, f.scopedSystem),
          );
        yield* loadRecallMemoryIdentities(f.config, {
          allowedUriScopes: [f.artifact.uri],
          memoryIds: [f.artifact.memoryId],
        });
        yield* expireRecallIndexValidation(f.home, false);
        let sharedAcquisitions = 0;
        const observed = FileSystem.FileSystem.of({
          ...f.fs,
          writeFileString: (file, content, options) => {
            if (
              EffectString.startsWith(f.path.join(f.home, 'threadnote', 'memory-locks'))(file) &&
              options?.flag === 'wx'
            )
              sharedAcquisitions++;
            return f.fs.writeFileString(file, content, options);
          },
        });
        const attempt = route === 'session' ? session(request) : f.call(nativeRequest);
        const outcome = yield* withExclusiveFileLock(
          f.fs,
          f.path.join(f.home, 'locks', 'indexes', 'lexical', recallIndexDatabaseFilename(false) + '.lock'),
          resourceAccountMutationLockPolicy,
          attempt.pipe(
            Effect.provideService(FileSystem.FileSystem, observed),
            Effect.result,
            Effect.timeoutOption(500),
          ),
        );
        expect(outcome).toMatchObject({
          _tag: 'Some',
          value: {
            _tag: 'Failure',
            failure:
              route === 'session' ? {_tag: 'RecallIdentityAdmissionBusy'} : {code: 'admission-busy', retryable: true},
          },
        });
        expect(sharedAcquisitions).toBe(0);
        const recovered = route === 'session' ? yield* session(request) : yield* f.call(nativeRequest);
        expect(recovered).toMatchObject({status: 'ok'});
        const replay =
          route === 'session'
            ? yield* session({protocolVersion: 1, action: 'recover', bindingId: f.bindingId, operationId})
            : yield* f.call({...f.base('recover'), operationId});
        expect(replay).toEqual(recovered);
        expect(yield* f.store.read(f.location, f.artifact.uri)).toContain('MEMORY');
      }).pipe(run),
    );

  it.effect('reloads actual writes without recursive locking and revokes escaped calls after return', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let escaped: Call | undefined;
      const observed = yield* withNativeWorkflowMemorySession(f.config, f.bindingId, (_admission, call) =>
        Effect.gen(function* () {
          escaped = call;
          const first = yield* call(f.read);
          expect(first).toMatchObject({canonicalUri: f.artifact.uri, revision: f.artifact.revision});
          const replaced = yield* call({
            protocolVersion: 1,
            action: 'replace',
            bindingId: f.bindingId,
            operationId: 'session-replace',
            artifactKey: 'plan-root',
            role: 'root',
            sourceRunId: 'native-run',
            uri: f.artifact.uri,
            expectedRevision: f.artifact.revision,
            storageKind: 'durable',
            body: 'Complete replacement.\n',
            bodySha256: sha256HexSync('Complete replacement.\n'),
          });
          expect(replaced).toMatchObject({canonicalUri: f.artifact.uri, body: 'Complete replacement.\n'});
          const stale = yield* call({
            protocolVersion: 1,
            action: 'replace',
            bindingId: f.bindingId,
            operationId: 'session-stale',
            artifactKey: 'plan-root',
            role: 'root',
            sourceRunId: 'native-run',
            uri: f.artifact.uri,
            expectedRevision: f.artifact.revision,
            storageKind: 'durable',
            body: 'Stale replacement.\n',
            bodySha256: sha256HexSync('Stale replacement.\n'),
          }).pipe(Effect.result);
          expect(Result.isFailure(stale)).toBe(true);
          return yield* call(f.read);
        }),
      ).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
      expect(observed).toMatchObject({body: 'Complete replacement.\n'});
      if (!escaped) throw new Error('Expected captured session call.');
      let reads = 0;
      const store = {
        ...f.store,
        read: (...args: Parameters<typeof f.store.read>) => {
          reads++;
          return f.store.read(...args);
        },
      };
      expect(
        Result.isFailure(yield* escaped(f.read).pipe(Effect.provideService(ResourceStore, store), Effect.result)),
      ).toBe(true);
      expect(reads).toBe(0);
    }).pipe(run),
  );

  it.effect('rejects another binding, forbidden actions, foreign fibers and reentrant use before IO', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const other = yield* f.init('other-run');
      let reads = 0;
      let callInside: Call | undefined;
      let reentered = false;
      const store = {
        ...f.store,
        read: (...args: Parameters<typeof f.store.read>) =>
          Effect.gen(function* () {
            reads++;
            if (args[1] === f.artifact.uri && callInside && !reentered) {
              reentered = true;
              const before = reads;
              expect(Result.isFailure(yield* callInside(f.read).pipe(Effect.result))).toBe(true);
              expect(reads).toBe(before);
            }
            return yield* f.store.read(...args);
          }),
      };
      yield* withNativeWorkflowMemorySession(f.config, f.bindingId, (_admission, call) =>
        Effect.gen(function* () {
          callInside = call;
          const before = reads;
          for (const request of [
            {...f.read, bindingId: other.bindingId},
            {...f.read, action: 'archive'},
            {...f.read, action: 'bind'},
            {
              ...f.read,
              action: 'preflight',
              mutation: 'archive',
              operationId: 'forbidden-archive',
              artifactKey: 'plan-root',
              role: 'root',
              sourceRunId: 'native-run',
              expectedRevision: f.artifact.revision,
            },
          ])
            expect(Result.isFailure(yield* call(request).pipe(Effect.result))).toBe(true);
          expect(reads).toBe(before);
          const child = yield* call(f.read).pipe(Effect.forkChild);
          expect(Result.isFailure(yield* Fiber.join(child).pipe(Effect.result))).toBe(true);
          expect(reads).toBe(before);
          expect(yield* call(f.read)).toMatchObject({revision: f.artifact.revision});
          expect(reentered).toBe(true);
        }),
      ).pipe(Effect.provideService(SystemInfo, f.scopedSystem), Effect.provideService(ResourceStore, store));
    }).pipe(run),
  );

  it.effect('revokes interrupted sessions and releases their journal lock', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      let escaped: Call | undefined;
      const child = yield* withNativeWorkflowMemorySession(f.config, f.bindingId, (_admission, call) =>
        Effect.gen(function* () {
          escaped = call;
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.provideService(SystemInfo, f.scopedSystem), Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(child);
      if (!escaped) throw new Error('Expected captured session call.');
      expect(Result.isFailure(yield* escaped(f.read).pipe(Effect.result))).toBe(true);
      const fresh = yield* withNativeWorkflowMemorySession(f.config, f.bindingId, (_admission, call) =>
        call(f.read),
      ).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
      expect(fresh).toMatchObject({revision: f.artifact.revision});
    }).pipe(run),
  );

  it.effect('freshly admits each native child and detects topology drift after an artifact write', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const git = f.path.join(f.repo, '.git');
      const hidden = f.path.join(f.repo, '.git-hidden');
      yield* f.fs.rename(git, hidden);
      expect(Result.isFailure(yield* f.call({...f.base('read'), uri: f.artifact.uri}).pipe(Effect.result))).toBe(true);
      yield* f.fs.rename(hidden, git);
      const before = yield* f.fs.readFileString(f.statePath());
      let drifted = false;
      const writeChecked: typeof f.store.writeChecked = (location, uri, content, options, check) =>
        f.store.writeChecked(location, uri, content, options, check).pipe(
          Effect.tap(() => {
            if (
              !drifted &&
              uri !== f.artifact.uri &&
              Effect2.pipe(content, EffectString.includes('Postwrite topology fixture'))
            ) {
              drifted = true;
              return f.fs.rename(git, hidden).pipe(Effect.orDie);
            }
            return Effect.void;
          }),
        );
      const store = {...f.store, writeChecked};
      const request = f.write({
        operationId: 'topology-write',
        artifactKey: 'topology-child',
        body: 'Postwrite topology fixture.\n',
      });
      const failed = yield* f.call(request).pipe(Effect.provideService(ResourceStore, store), Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      expect(drifted).toBe(true);
      const pending = yield* readNativeWorkflowState(f.config, 'native-run');
      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(pending?.state.operations), __effectArrayReceiver =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(
                __effectArrayReceiver,
                operation => operation.intent.operationId === 'topology-write',
              ),
            ),
          ),
        )?.status,
      ).toBe('prepared');
      expect(yield* f.fs.readFileString(f.statePath())).not.toBe(before);
      yield* f.fs.rename(hidden, git);
      expect(yield* f.call({...f.base('recover'), operationId: 'topology-write'})).toMatchObject({status: 'ok'});
      expect(
        EffectOption.getOrUndefined(
          EffectOption.map(
            EffectOption.fromNullishOr((yield* readNativeWorkflowState(f.config, 'native-run'))?.state.operations),
            __effectArrayReceiver =>
              EffectOption.getOrUndefined(
                EffectArray.findFirst(
                  __effectArrayReceiver,
                  operation => operation.intent.operationId === 'topology-write',
                ),
              ),
          ),
        )?.status,
      ).toBe('verified');
    }).pipe(run),
  );
});

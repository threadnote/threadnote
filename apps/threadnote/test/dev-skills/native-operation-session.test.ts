import {it} from '@effect/vitest';
import {Deferred, Effect, Fiber, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceStore} from '@threadnote/store/resource-store';
import {withNativeWorkflowMemorySession, runWorkflowMemory} from '../../src/workflow_memory/index.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

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
            if (!drifted && uri !== f.artifact.uri && content.includes('Postwrite topology fixture')) {
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
        pending?.state.operations.find(operation => operation.intent.operationId === 'topology-write')?.status,
      ).toBe('prepared');
      expect(yield* f.fs.readFileString(f.statePath())).not.toBe(before);
      yield* f.fs.rename(hidden, git);
      expect(yield* f.call({...f.base('recover'), operationId: 'topology-write'})).toMatchObject({status: 'ok'});
      expect(
        (yield* readNativeWorkflowState(f.config, 'native-run'))?.state.operations.find(
          operation => operation.intent.operationId === 'topology-write',
        )?.status,
      ).toBe('verified');
    }).pipe(run),
  );
});

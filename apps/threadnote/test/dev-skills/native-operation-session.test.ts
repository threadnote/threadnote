import {Database} from 'bun:sqlite';
import {it} from '@effect/vitest';
import {Deferred, Effect, Fiber, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceStore, assertResourceAccountCheck} from '@threadnote/store/resource-store';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {recallIndexDatabaseFilename} from '@threadnote/recall/index';
import {withNativeWorkflowMemorySession, runWorkflowMemory} from '../../src/workflow_memory/index.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {withWorkflowReadCache} from '../../src/workflow_memory/read_cache.js';
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

  it.effect(
    'uses the private identity projection at native preflight/prepare/CHECK and keeps standalone lexical selection',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const database = f.path.join(
          f.config.agentContextHome,
          'indexes',
          'lexical',
          recallIndexDatabaseFilename(false),
        );
        const metadata = () =>
          Effect.sync(() => {
            const db = new Database(database);
            try {
              return new Map(
                (db.query('SELECT key, value FROM metadata').all() as {key: string; value: string}[]).map(row => [
                  row.key,
                  row.value,
                ]),
              );
            } finally {
              db.close();
            }
          });
        const request = {
          protocolVersion: 1,
          action: 'preflight',
          mutation: 'create',
          bindingId: f.bindingId,
          operationId: 'native-identity-linked',
          artifactKey: 'linked-note',
          role: 'note',
          sourceRunId: 'native-run',
          storageKind: 'durable',
          body: 'Native identity lease integration.\n',
          bodySha256: sha256HexSync('Native identity lease integration.\n'),
          relations: [{type: 'references', uri: `threadnote://memory/${f.artifact.memoryId}`}],
        };
        const before = yield* metadata();
        yield* runWorkflowMemory(f.config, request).pipe(Effect.provideService(SystemInfo, f.scopedSystem));
        expect((yield* metadata()).get('identity_initialized')).toBe(before.get('identity_initialized'));
        let checked = false;
        const writeChecked: typeof f.store.writeChecked = (location, uri, content, options, check) =>
          Effect.gen(function* () {
            // Generation changes after preparation, immediately before the real store CHECK takes account ownership.
            yield* f.store.write(
              location,
              'threadnote://resources/unrelated-native-write.md',
              'unrelated canonical change',
              {mode: 'upsert'},
            );
            return yield* f.store.writeChecked(
              location,
              uri,
              content,
              options,
              check.pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    yield* assertResourceAccountCheck(location.home, location.account);
                    expect((yield* metadata()).get('identity_canonical_mutation_generation')).toBe(
                      yield* readCanonicalMutationGeneration(f.fs, f.path, location.home, location.account),
                    );
                    checked = true;
                  }).pipe(Effect.orDie),
                ),
              ),
            );
          });
        const store = {...f.store, writeChecked};
        yield* withNativeWorkflowMemorySession(f.config, f.bindingId, (_admission, call) =>
          Effect.gen(function* () {
            yield* call(request);
            expect((yield* metadata()).get('identity_initialized')).toBe('true');
            expect(Result.isFailure(yield* call({...request, engine: 'identity-projection'}).pipe(Effect.result))).toBe(
              true,
            );
            const {mutation: _mutation, ...create} = request;
            const result = yield* call({...create, action: 'create'});
            expect(result).toMatchObject({body: 'Native identity lease integration.\n'});
          }),
        ).pipe(Effect.provideService(SystemInfo, f.scopedSystem), Effect.provideService(ResourceStore, store));
        expect(checked).toBe(true);
      }).pipe(run),
  );

  it.effect(
    'writes an unlinked native artifact with an unavailable index while retaining CHECK, body and CAS guards',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const index = f.path.join(f.config.agentContextHome, 'indexes', 'lexical');
        const hidden = `${index}-unavailable`;
        let unavailable = false;
        const restore = Effect.suspend(() =>
          unavailable
            ? f.fs.remove(index).pipe(
                Effect.andThen(f.fs.rename(hidden, index)),
                Effect.tap(() =>
                  Effect.sync(() => {
                    unavailable = false;
                  }),
                ),
              )
            : Effect.void,
        );
        let checked = 0;
        const writeChecked: typeof f.store.writeChecked = (location, uri, content, options, check) =>
          f.store
            .writeChecked(
              location,
              uri,
              content,
              options,
              check.pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    yield* assertResourceAccountCheck(location.home, location.account);
                    expect((yield* f.fs.stat(index)).type).toBe('File');
                    expect(options.expectedFingerprint).toBe(f.artifact.revision);
                    checked++;
                  }).pipe(Effect.orDie),
                ),
              ),
            )
            .pipe(Effect.tap(() => restore.pipe(Effect.orDie)));
        const store = {...f.store, writeChecked};
        const body = 'Unlinked canonical replacement.\n';
        const request = {
          protocolVersion: 1,
          action: 'replace',
          bindingId: f.bindingId,
          operationId: 'unlinked-no-index',
          artifactKey: 'plan-root',
          role: 'root',
          sourceRunId: 'native-run',
          uri: f.artifact.uri,
          expectedRevision: f.artifact.revision,
          storageKind: 'durable',
          body,
          bodySha256: sha256HexSync(body),
        };
        yield* Effect.acquireUseRelease(
          f.fs.rename(index, hidden).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                unavailable = true;
              }),
            ),
            Effect.andThen(f.fs.writeFileString(index, 'Derived index unavailable during canonical CHECK.')),
          ),
          () =>
            withNativeWorkflowMemorySession(f.config, f.bindingId, (_admission, call) =>
              Effect.gen(function* () {
                expect(
                  Result.isFailure(
                    yield* call({...request, operationId: 'invalid-body-no-index', bodySha256: '0'.repeat(64)}).pipe(
                      Effect.result,
                    ),
                  ),
                ).toBe(true);
                expect(checked).toBe(0);
                expect(
                  yield* f.store.read(
                    {home: f.config.agentContextHome, account: f.config.account, user: f.config.user},
                    f.artifact.uri,
                  ),
                ).not.toContain(body.trim());
                expect(yield* call(request)).toMatchObject({canonicalUri: f.artifact.uri, body});
                expect(checked).toBe(1);
                expect(
                  Result.isFailure(yield* call({...request, operationId: 'stale-cas-no-index'}).pipe(Effect.result)),
                ).toBe(true);
                expect(checked).toBe(1);
                expect(yield* call(f.read)).toMatchObject({body});
              }),
            ).pipe(Effect.provideService(SystemInfo, f.scopedSystem), Effect.provideService(ResourceStore, store)),
          () => restore.pipe(Effect.orDie),
        );
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

  it.effect('compares the current mutable admission binding on every child with and without a read cache', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let reads = 0;
      const store = {
        ...f.store,
        read: (...args: Parameters<typeof f.store.read>) =>
          Effect.gen(function* () {
            reads++;
            return yield* f.store.read(...args);
          }),
      };
      for (const cached of [false, true]) {
        const session = withNativeWorkflowMemorySession(f.config, f.bindingId, (admission, call) =>
          Effect.gen(function* () {
            const mutableBinding = {...admission.state.binding};
            // A mutable internal admission must not become a captured canonical baseline.
            Object.defineProperty(admission, 'state', {value: {...admission.state, binding: mutableBinding}});
            expect(yield* call(f.read)).toMatchObject({revision: f.artifact.revision});
            Object.assign(mutableBinding, {featureId: 'changed-after-first-child'});
            const before = reads;
            const drifted = yield* call(f.read).pipe(Effect.result);
            expect(Result.isFailure(drifted)).toBe(true);
            if (Result.isFailure(drifted)) expect(drifted.failure).toMatchObject({code: 'binding-drift'});
            expect(reads).toBe(before);
          }),
        ).pipe(Effect.provideService(SystemInfo, f.scopedSystem), Effect.provideService(ResourceStore, store));
        yield* cached ? withWorkflowReadCache(session) : session;
      }
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

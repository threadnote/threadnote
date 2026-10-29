import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {execFileSync} from '@threadnote/testing/node-child-process';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Crypto, DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {
  captureCodeGraphLocalProvenanceCleanupEvidence,
  cleanupMissingCodeGraphLocalProvenance,
  readMissingCodeGraphWorktreeReconciliationEvidence,
  recordVerifiedCodeGraphLocalAssociation,
  withCodeGraphLocalProvenanceLock,
  type CodeGraphLocalProvenanceRecordV2,
} from '@threadnote/graph/local_provenance';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';

import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const WORKTREE_ID = Effect2.pipe('1', EffectString.repeat(64));
const NEIGHBOR_WORKTREE_ID = Effect2.pipe('2', EffectString.repeat(64));
const REPOSITORY_ID = Effect2.pipe('b', EffectString.repeat(64));
const ProvenanceCleanupTestLayer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

describe('code graph local provenance cleanup', () => {
  effectIt.layer(ProvenanceCleanupTestLayer)(layerIt => {
    layerIt.effect(
      'removes only an unchanged exact missing record and never touches source or neighboring sidecars',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* provenanceCleanupFixture;
            const beforeSource = yield* fixture.fs.readFileString(fixture.sourceSentinel);
            const expectedEvidence = yield* captureCodeGraphLocalProvenanceCleanupEvidence(fixture.home, {
              checkoutId: CHECKOUT_ID,
              worktreeId: WORKTREE_ID,
            });
            expect(expectedEvidence).toBeDefined();
            const result = yield* cleanupMissingCodeGraphLocalProvenance(fixture.home, {
              checkoutId: CHECKOUT_ID,
              worktreeId: WORKTREE_ID,
            });

            expect(result).toEqual({state: 'removed'});
            expect(yield* fixture.fs.exists(fixture.sidecar)).toBe(false);
            expect(yield* fixture.fs.exists(fixture.neighborSidecar)).toBe(true);
            expect(yield* fixture.fs.readFileString(fixture.sourceSentinel)).toBe(beforeSource);
            expect(
              yield* cleanupMissingCodeGraphLocalProvenance(
                fixture.home,
                {checkoutId: CHECKOUT_ID, worktreeId: WORKTREE_ID},
                {expectedEvidence: expectedEvidence!},
              ),
            ).toEqual({state: 'not-found'});
          }),
        ),
    );

    layerIt.effect('preserves a record when its worktree is restored before the final observation', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* provenanceCleanupFixture;
          const result = yield* cleanupMissingCodeGraphLocalProvenance(
            fixture.home,
            {checkoutId: CHECKOUT_ID, worktreeId: WORKTREE_ID},
            {beforeFinalObservation: () => fixture.fs.makeDirectory(fixture.missingWorktree, {mode: 0o700})},
          );

          // A restored non-Git directory is stale rather than verified, but it
          // still invalidates missing-path deletion authority.
          expect(result).toEqual({observedState: 'stale', state: 'preserved'});
          expect(yield* fixture.fs.exists(fixture.sidecar)).toBe(true);
        }),
      ),
    );

    layerIt.effect('preserves a replacement that does not match the exact pre-core cleanup token', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* provenanceCleanupFixture;
          const expectedEvidence = yield* captureCodeGraphLocalProvenanceCleanupEvidence(fixture.home, {
            checkoutId: CHECKOUT_ID,
            worktreeId: WORKTREE_ID,
          });
          expect(expectedEvidence).toBeDefined();
          const replacement = {
            ...fixture.record,
            observedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(fixture.record.observedAt) + 1)),
          };
          yield* fixture.fs.writeFileString(fixture.sidecar, `${JSON.stringify(replacement)}\n`, {
            flag: 'w',
            mode: 0o600,
          });

          const result = yield* cleanupMissingCodeGraphLocalProvenance(
            fixture.home,
            {checkoutId: CHECKOUT_ID, worktreeId: WORKTREE_ID},
            {expectedEvidence: expectedEvidence!},
          );

          expect(result).toEqual({observedState: 'stale', state: 'preserved'});
          expect(JSON.parse(yield* fixture.fs.readFileString(fixture.sidecar))).toEqual(replacement);
        }),
      ),
    );

    layerIt.effect('never returns missing authority when the worktree reappears before its final path check', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* provenanceCleanupFixture;
          yield* fixture.fs.writeFileString(
            fixture.sidecar,
            `${JSON.stringify({
              ...fixture.record,
              registration: {adminNameKeys: [Effect2.pipe('4', EffectString.repeat(64))], kind: 'linked'},
            })}\n`,
            {flag: 'w', mode: 0o600},
          );

          const evidence = yield* readMissingCodeGraphWorktreeReconciliationEvidence(
            fixture.home,
            {checkoutId: CHECKOUT_ID, repositoryId: REPOSITORY_ID, worktreeId: WORKTREE_ID},
            {beforeFinalMissingObservation: () => fixture.fs.makeDirectory(fixture.missingWorktree, {mode: 0o700})},
          );

          expect(evidence).toEqual({state: 'present'});
          expect(JSON.stringify(evidence)).not.toContain(fixture.missingWorktree);
        }),
      ),
    );

    layerIt.effect('preserves a dangling symlink created between the two exact missing-path observations', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* provenanceCleanupFixture;
          yield* fixture.fs.writeFileString(
            fixture.sidecar,
            `${JSON.stringify({
              ...fixture.record,
              registration: {adminNameKeys: [Effect2.pipe('4', EffectString.repeat(64))], kind: 'linked'},
            })}\n`,
            {flag: 'w', mode: 0o600},
          );

          const evidence = yield* readMissingCodeGraphWorktreeReconciliationEvidence(
            fixture.home,
            {checkoutId: CHECKOUT_ID, repositoryId: REPOSITORY_ID, worktreeId: WORKTREE_ID},
            {
              beforeFinalMissingObservation: () =>
                fixture.fs.symlink(`${fixture.missingWorktree}.dangling-target`, fixture.missingWorktree),
            },
          );

          expect(evidence).toEqual({state: 'present'});
          expect(yield* fixture.fs.readLink(fixture.missingWorktree)).toBe(
            `${fixture.missingWorktree}.dangling-target`,
          );
          expect(JSON.stringify(evidence)).not.toContain(fixture.missingWorktree);
        }),
      ),
    );

    layerIt.effect('preserves a replaced record and a symlink target without following either mutation', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* provenanceCleanupFixture;
          const replaced = yield* cleanupMissingCodeGraphLocalProvenance(
            fixture.home,
            {checkoutId: CHECKOUT_ID, worktreeId: WORKTREE_ID},
            {
              beforeRemove: () =>
                fixture.fs.writeFileString(
                  fixture.sidecar,
                  `${JSON.stringify({
                    ...fixture.record,
                    observedAt: new Date(Date.parse(fixture.record.observedAt) + 1).toISOString(),
                  })}\n`,
                  {flag: 'w', mode: 0o600},
                ),
            },
          );
          expect(replaced).toEqual({observedState: 'stale', state: 'preserved'});
          expect(yield* fixture.fs.exists(fixture.sidecar)).toBe(true);

          yield* fixture.fs.remove(fixture.sidecar);
          yield* fixture.fs.symlink(fixture.sourceSentinel, fixture.sidecar);
          const beforeSource = yield* fixture.fs.readFileString(fixture.sourceSentinel);
          const symlinked = yield* cleanupMissingCodeGraphLocalProvenance(fixture.home, {
            checkoutId: CHECKOUT_ID,
            worktreeId: WORKTREE_ID,
          });
          expect(symlinked).toEqual({observedState: 'invalid', state: 'preserved'});
          expect(yield* fixture.fs.readFileString(fixture.sourceSentinel)).toBe(beforeSource);
        }),
      ),
    );

    layerIt.effect('holds the shared provenance lock from final validation through removal', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* provenanceCleanupFixture;
          const crypto = yield* Crypto.Crypto;
          const system = yield* SystemInfo;
          const writerStarted = yield* Deferred.make<void>();
          const writerFiber = yield* Deferred.make<Fiber.Fiber<void, unknown>>();
          const replacement = {
            ...fixture.record,
            observedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(fixture.record.observedAt) + 1)),
          };
          const result = yield* cleanupMissingCodeGraphLocalProvenance(
            fixture.home,
            {checkoutId: CHECKOUT_ID, worktreeId: WORKTREE_ID},
            {
              afterFinalValidation: () =>
                Effect.gen(function* () {
                  const fiber = yield* Effect.gen(function* () {
                    yield* Deferred.succeed(writerStarted, undefined);
                    yield* withCodeGraphLocalProvenanceLock(
                      fixture.home,
                      CHECKOUT_ID,
                      WORKTREE_ID,
                      5_000,
                      fixture.fs.writeFileString(fixture.sidecar, `${JSON.stringify(replacement)}\n`, {
                        flag: 'w',
                        mode: 0o600,
                      }),
                    );
                  }).pipe(Effect.forkChild({startImmediately: true}));
                  yield* Deferred.succeed(writerFiber, fiber);
                  yield* Deferred.await(writerStarted);
                  yield* Effect.yieldNow;
                  expect(JSON.parse(yield* fixture.fs.readFileString(fixture.sidecar))).toEqual(fixture.record);
                }).pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(FileSystem.FileSystem, fixture.fs),
                  Effect.provideService(Path.Path, fixture.path),
                  Effect.provideService(SystemInfo, system),
                ),
            },
          );
          expect(result).toEqual({state: 'removed'});
          yield* Effect.yieldNow;
          yield* TestClock.adjust(20);
          yield* Fiber.join(yield* Deferred.await(writerFiber));
          expect(JSON.parse(yield* fixture.fs.readFileString(fixture.sidecar))).toEqual(replacement);
        }),
      ),
    );

    layerIt.effect('preserves legacy provenance without resolving the remembered worktree', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* provenanceCleanupFixture;
          const {registration: _registration, ...base} = fixture.record;
          yield* fixture.fs.writeFileString(fixture.sidecar, `${JSON.stringify({...base, schemaVersion: 1})}\n`, {
            flag: 'w',
            mode: 0o600,
          });

          expect(
            yield* cleanupMissingCodeGraphLocalProvenance(fixture.home, {
              checkoutId: CHECKOUT_ID,
              worktreeId: WORKTREE_ID,
            }),
          ).toEqual({observedState: 'legacy-unknown', state: 'preserved'});
          expect(yield* fixture.fs.exists(fixture.sidecar)).toBe(true);
        }),
      ),
    );

    layerIt.effect(
      'keeps a five-second held publisher lock supplemental and path-free',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-provenance-publisher-home-'});
            const repository = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-provenance-publisher-repo-'});
            yield* Effect.try({
              try: () => {
                execFileSync('git', ['-C', repository, 'init', '-q'], {stdio: 'pipe'});
                execFileSync(
                  'git',
                  [
                    '-C',
                    repository,
                    '-c',
                    'user.name=Threadnote Test',
                    '-c',
                    'user.email=test@threadnote.local',
                    'commit',
                    '--allow-empty',
                    '-qm',
                    'fixture',
                  ],
                  {stdio: 'pipe'},
                );
              },
              catch: cause => TestError.make({message: 'Could not create the provenance publisher fixture.', cause}),
            });
            const identity = yield* resolveRepositoryIdentity(yield* fs.realPath(repository));
            const acquired = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const owner = yield* withCodeGraphLocalProvenanceLock(
              home,
              identity.checkoutId,
              identity.worktreeId,
              5_000,
              Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ).pipe(Effect.forkChild({startImmediately: true}));
            yield* Deferred.await(acquired);

            const startedAt = yield* TestClock.withLive(Clock.currentTimeMillis);
            const association = yield* TestClock.withLive(recordVerifiedCodeGraphLocalAssociation(home, identity));
            const elapsed = (yield* TestClock.withLive(Clock.currentTimeMillis)) - startedAt;

            expect(association).toEqual({available: false, state: 'invalid'});
            expect(elapsed).toBeGreaterThanOrEqual(4_900);
            expect(elapsed).toBeLessThan(8_000);
            expect(JSON.stringify(association)).not.toContain(home);
            expect(JSON.stringify(association)).not.toContain(repository);
            expect(JSON.stringify(association)).not.toContain('FileLockTimeout');

            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(owner);
          }),
        ),
      12_000,
    );
  });
});

const provenanceCleanupFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-provenance-cleanup-'});
  const worktrees = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'local-context', 'worktrees');
  yield* fs.makeDirectory(worktrees, {recursive: true, mode: 0o700});
  if (process.platform !== 'win32') {
    yield* fs.chmod(path.dirname(worktrees), 0o700);
    yield* fs.chmod(worktrees, 0o700);
  }
  const missingWorktree = path.join(home, 'missing-worktree');
  const sidecar = path.join(worktrees, `${WORKTREE_ID}.json`);
  const neighborSidecar = path.join(worktrees, `${NEIGHBOR_WORKTREE_ID}.json`);
  const sourceSentinel = path.join(home, 'source-sentinel.ts');
  const record = provenanceRecord(missingWorktree, WORKTREE_ID);
  yield* fs.writeFileString(sidecar, `${JSON.stringify(record)}\n`, {mode: 0o600});
  yield* fs.writeFileString(
    neighborSidecar,
    `${JSON.stringify(provenanceRecord(path.join(home, 'other-missing-worktree'), NEIGHBOR_WORKTREE_ID))}\n`,
    {mode: 0o600},
  );
  yield* fs.writeFileString(sourceSentinel, 'export const sourceMustSurvive = true;\n', {mode: 0o600});
  return {fs, home, missingWorktree, neighborSidecar, path, record, sidecar, sourceSentinel};
});

function provenanceRecord(canonicalWorktreePath: string, worktreeId: string): CodeGraphLocalProvenanceRecordV2 {
  return {
    canonicalWorktreePath,
    checkoutId: CHECKOUT_ID,
    headCommit: Effect2.pipe('f', EffectString.repeat(40)),
    observedAt: new Date().toISOString(),
    registration: {kind: 'main'},
    repositoryId: REPOSITORY_ID,
    schemaVersion: 2,
    worktreeId,
  };
}

import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {
  recordVerifiedCodeGraphLocalAssociation,
  readCodeGraphLocalReconciliationEvidence,
} from '@threadnote/graph/local_provenance';
import {
  resolveCodeGraphCitationRepositoryRoutes,
  verifyCodeGraphCitationRepositoryAlias,
  revalidateCodeGraphCitationRecoveryRoute,
} from '@threadnote/graph/citation/recovery';

import {citationPlatformLayer as platform} from '../helpers/citation-platform.js';

const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-recovery-'});
  const home = path.join(root, 'home');
  const repository = path.join(root, 'repository');
  const worktree = path.join(root, 'worktree');
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(repository);
  yield* git(repository, ['init', '--quiet']);
  yield* git(repository, ['config', 'user.name', 'Test']);
  yield* git(repository, ['config', 'user.email', 'test@example.invalid']);
  yield* fs.writeFileString(path.join(repository, 'source.ts'), 'export const supported = true;\n');
  yield* git(repository, ['add', '.']);
  yield* git(repository, ['commit', '--quiet', '-m', 'fixture']);
  yield* git(repository, ['remote', 'add', 'origin', 'https://example.invalid/old/repository.git']);
  yield* git(repository, ['worktree', 'add', '--quiet', '--detach', worktree]);
  const previous = yield* resolveRepositoryIdentity(worktree);
  expect((yield* recordVerifiedCodeGraphLocalAssociation(home, previous)).state).toBe('verified');
  const prior = yield* readCodeGraphLocalReconciliationEvidence(home, previous);
  if (prior.state !== 'verified') return yield* Effect.die('Fixture provenance was not verified.');
  yield* git(repository, ['worktree', 'remove', '--force', worktree]);
  yield* git(repository, ['remote', 'set-url', 'origin', 'https://example.invalid/new/repository.git']);
  const current = yield* resolveRepositoryIdentity(repository);
  return {current, fs, home, path, prior, previous, repository, root, worktree};
});

describe('citation recovery checkout authority', () => {
  effectIt.layer(platform)(it => {
    it.effect(
      'abstains when surviving registrations expose different current histories without a selected caller',
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const data = yield* fixture;
            yield* git(data.repository, ['remote', 'set-url', 'origin', 'https://example.invalid/old/repository.git']);
            const main = yield* resolveRepositoryIdentity(data.repository);
            yield* recordVerifiedCodeGraphLocalAssociation(data.home, main);
            const sibling = data.path.join(data.root, 'sibling');
            yield* git(data.repository, ['worktree', 'add', '--quiet', '--detach', sibling]);
            yield* data.fs.writeFileString(data.path.join(sibling, 'source.ts'), 'export const supported = false;\n');
            yield* git(sibling, ['add', '.']);
            yield* git(sibling, ['commit', '--quiet', '-m', 'different current history']);
            const divergent = yield* resolveRepositoryIdentity(sibling);
            yield* recordVerifiedCodeGraphLocalAssociation(data.home, divergent);
            const layout = codeGraphLayout(data.path, data.home, main.checkoutId, main.worktreeId);
            yield* data.fs.writeFileString(layout.databasePath, '');
            const resolution = yield* resolveCodeGraphCitationRepositoryRoutes({
              repositoryId: main.repositoryId,
              sourceCommit: main.headCommit,
              threadnoteHome: data.home,
            });
            expect(resolution.ambiguous).toBe(true);
            expect(resolution.routes).toHaveLength(2);
          }),
        ),
    );
    it.effect('routes a removed worktree through its surviving checkout after a namespace change', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const data = yield* fixture;
          const resolution = yield* resolveCodeGraphCitationRepositoryRoutes({
            callerCwd: data.repository,
            repositoryId: data.previous.repositoryId,
            sourceCommit: data.previous.headCommit,
            threadnoteHome: data.home,
          });
          expect(resolution.ambiguous).toBe(false);
          expect(resolution.routes).toHaveLength(1);
          const route = resolution.routes[0];
          expect(route.aliasProof?.sourceRepositoryId).toBe(data.previous.repositoryId);
          expect(route.aliasProof?.targetRepositoryId).toBe(data.current.repositoryId);
          expect(yield* revalidateCodeGraphCitationRecoveryRoute(data.home, route)).toBe(true);
          expect(yield* data.fs.exists(data.worktree)).toBe(false);
        }),
      ),
    );

    it.effect('rejects a matching remote on an unrelated checkout and unknown history', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const data = yield* fixture;
          const clone = data.path.join(data.root, 'clone');
          yield* git(data.root, ['clone', '--quiet', data.repository, clone]);
          yield* git(clone, ['remote', 'set-url', 'origin', data.current.remoteIdentity!]);
          const unrelated = yield* resolveRepositoryIdentity(clone);
          expect(
            yield* verifyCodeGraphCitationRepositoryAlias(data.home, data.prior, unrelated, data.previous.headCommit),
          ).toBeUndefined();
          expect(
            yield* verifyCodeGraphCitationRepositoryAlias(data.home, data.prior, data.current, 'f'.repeat(40)),
          ).toBeUndefined();
        }),
      ),
    );

    it.effect('rejects a repointed remote or provenance record before the final fence', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const data = yield* fixture;
          expect(
            yield* verifyCodeGraphCitationRepositoryAlias(
              data.home,
              data.prior,
              data.current,
              data.previous.headCommit,
              () =>
                git(data.repository, [
                  'remote',
                  'set-url',
                  'origin',
                  'https://example.invalid/unrelated/repository.git',
                ]).pipe(Effect.asVoid),
            ),
          ).toBeUndefined();
          yield* git(data.repository, ['remote', 'set-url', 'origin', data.current.remoteIdentity!]);
          const layout = codeGraphLayout(data.path, data.home, data.prior.checkoutId, data.prior.worktreeId);
          const record = data.path.join(
            layout.repositoryRoot,
            'local-context',
            'worktrees',
            `${data.prior.worktreeId}.json`,
          );
          expect(
            yield* verifyCodeGraphCitationRepositoryAlias(
              data.home,
              data.prior,
              data.current,
              data.previous.headCommit,
              () => data.fs.writeFileString(record, '{}'),
            ),
          ).toBeUndefined();
        }),
      ),
    );
  });
});

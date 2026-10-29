import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from '@threadnote/testing/node-fs';
import {homedir, tmpdir} from '@threadnote/testing/node-os';
import {basename, dirname, join, sep} from '@threadnote/testing/node-path';
import {afterEach} from 'vitest';
import {describe, expect, it, it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Option, Path, PlatformError} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  parseCodeGraphLocalProvenanceRecordJson,
  privacySafeCodeGraphLocalAssociation,
  readCodeGraphLocalReconciliationEvidence,
  readPersistedCodeGraphLocalAssociation,
  recordVerifiedCodeGraphLocalAssociation,
  type CodeGraphLocalProvenanceRecord,
} from '@threadnote/graph/local_provenance';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {parseRepositoryIdentityMetadata, resolveRepositoryIdentity} from '@threadnote/graph/repository';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('code graph private local provenance', () => {
  it('atomically records a verified association with private modes and cadence-bounded refresh', async () => {
    const fixture = await provenanceFixture();

    const first = await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    const firstStat = statSync(fixture.sidecar);
    const firstRecord = readRecord(fixture.sidecar);
    let publicationValidationCount = 0;
    const repeated = await runEffect(
      recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity, {
        beforePublishValidation: () =>
          Effect.sync(() => {
            publicationValidationCount += 1;
          }),
      }),
    );
    const repeatedStat = statSync(fixture.sidecar);

    expect(first).toMatchObject({
      available: true,
      branch: fixture.identity.branch,
      path: fixture.root,
      state: 'verified',
    });
    expect(repeated).toMatchObject({
      available: true,
      branch: fixture.identity.branch,
      path: fixture.root,
      state: 'verified',
    });
    expect(firstStat.mode & 0o777).toBe(process.platform === 'win32' ? firstStat.mode & 0o777 : 0o600);
    if (process.platform !== 'win32') {
      expect(statSync(dirname(fixture.sidecar)).mode & 0o777).toBe(0o700);
      expect(statSync(dirname(dirname(fixture.sidecar))).mode & 0o777).toBe(0o700);
    }
    expect(repeatedStat.ino).toBe(firstStat.ino);
    expect(publicationValidationCount).toBe(0);
    expect(readRecord(fixture.sidecar)).toEqual(firstRecord);
    expect(firstRecord).toMatchObject({
      branch: fixture.identity.branch,
      registration: {kind: 'main'},
      schemaVersion: 2,
    });
    expect(
      EffectArray.filter(readdirSync(dirname(fixture.sidecar)), name =>
        Effect2.pipe(name, EffectString.endsWith('.tmp')),
      ),
    ).toEqual([]);

    git(fixture.root, ['branch', '-m', 'feature/manager-labels']);
    const renamedBranchIdentity = await runEffect(resolveRepositoryIdentity(fixture.root));
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, renamedBranchIdentity));
    const renamedBranchRecord = readRecord(fixture.sidecar);
    expect(renamedBranchIdentity.headCommit).toBe(fixture.identity.headCommit);
    expect(renamedBranchRecord.branch).toBe('feature/manager-labels');
    expect(statSync(fixture.sidecar).ino).not.toBe(firstStat.ino);

    git(fixture.root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '--allow-empty',
      '-qm',
      'refresh',
    ]);
    const refreshedIdentity = await runEffect(resolveRepositoryIdentity(fixture.root));
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, refreshedIdentity));
    const refreshedRecord = readRecord(fixture.sidecar);
    expect(refreshedRecord.headCommit).toBe(refreshedIdentity.headCommit);
    expect(refreshedRecord.headCommit).not.toBe(firstRecord.headCommit);
  });

  it('upgrades a fresh v1 display record before it can become reconciliation evidence', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    const current = readRecord(fixture.sidecar);
    expect(current.schemaVersion).toBe(2);
    if (current.schemaVersion !== 2) throw TestError.make({message: 'fixture did not publish v2 provenance'});
    const {registration: _registration, ...base} = current;
    writeFileSync(fixture.sidecar, `${JSON.stringify({...base, schemaVersion: 1})}\n`, {mode: 0o600});
    const legacyInode = statSync(fixture.sidecar).ino;

    expect(await runEffect(readCodeGraphLocalReconciliationEvidence(fixture.home, fixture.identity))).toEqual({
      state: 'legacy-unknown',
    });
    const association = await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    const upgraded = readRecord(fixture.sidecar);

    expect(association).toMatchObject({available: true, state: 'verified'});
    expect(upgraded).toMatchObject({registration: {kind: 'main'}, schemaVersion: 2});
    expect(statSync(fixture.sidecar).ino).not.toBe(legacyInode);
    expect(await runEffect(readCodeGraphLocalReconciliationEvidence(fixture.home, fixture.identity))).toMatchObject({
      checkoutId: fixture.identity.checkoutId,
      recordDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      recordIdentity: expect.stringMatching(/^[0-9a-f]{64}$/),
      registration: {kind: 'main'},
      state: 'verified',
      worktreeId: fixture.identity.worktreeId,
    });
  });

  it('reads v2 reconciliation evidence without probing an unavailable remembered worktree', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    let rememberedWorktreeProbeCount = 0;
    const observed = await runEffect(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const probesRememberedWorktree = (target: unknown) => {
          const candidate = String(target);
          if (candidate === fixture.root || Effect2.pipe(candidate, EffectString.startsWith(`${fixture.root}${sep}`))) {
            rememberedWorktreeProbeCount += 1;
          }
        };
        const guardedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          exists: target => {
            probesRememberedWorktree(target);
            return fileSystem.exists(target);
          },
          open: (target, options) => {
            probesRememberedWorktree(target);
            return fileSystem.open(target, options);
          },
          readLink: target => {
            probesRememberedWorktree(target);
            return fileSystem.readLink(target);
          },
          realPath: target => {
            probesRememberedWorktree(target);
            return fileSystem.realPath(target);
          },
          stat: target => {
            probesRememberedWorktree(target);
            return fileSystem.stat(target);
          },
        });
        return yield* readCodeGraphLocalReconciliationEvidence(fixture.home, fixture.identity).pipe(
          Effect.provideService(FileSystem.FileSystem, guardedFileSystem),
        );
      }),
    );
    rmSync(fixture.root, {force: true, recursive: true});
    const missing = await runEffect(readCodeGraphLocalReconciliationEvidence(fixture.home, fixture.identity));

    expect(observed).toMatchObject({registration: {kind: 'main'}, state: 'verified'});
    expect(missing).toMatchObject({registration: {kind: 'main'}, state: 'verified'});
    expect(rememberedWorktreeProbeCount).toBe(0);
    expect(JSON.stringify(observed)).not.toContain(fixture.root);
    expect(JSON.stringify(missing)).not.toContain(fixture.root);
  });

  it('rejects stale and fabricated complete Git identities before writing', async () => {
    const fixture = await provenanceFixture();
    const staleIdentity = fixture.identity;
    git(fixture.root, [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '--allow-empty',
      '-qm',
      'identity-drift',
    ]);

    expect(await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, staleIdentity))).toEqual({
      available: false,
      state: 'invalid',
    });
    expect(existsSync(fixture.sidecar)).toBe(false);

    const currentIdentity = await runEffect(resolveRepositoryIdentity(fixture.root));
    const otherRoot = localRepository();
    const otherIdentity = await runEffect(resolveRepositoryIdentity(otherRoot));
    const mismatchedGitCommon = {
      ...currentIdentity,
      checkoutId: otherIdentity.checkoutId,
      gitCommonDirectory: otherIdentity.gitCommonDirectory,
    };
    expect(await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, mismatchedGitCommon))).toEqual({
      available: false,
      state: 'invalid',
    });
  });

  it('revalidates the complete Git identity immediately before atomic publication', async () => {
    const fixture = await provenanceFixture();
    let interlockReached = false;

    const association = await runEffect(
      recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity, {
        beforePublishValidation: () =>
          Effect.sync(() => {
            interlockReached = true;
            git(fixture.root, ['remote', 'add', 'origin', 'https://example.com/rebound/repository.git']);
          }),
      }),
    );

    expect(interlockReached).toBe(true);
    expect(association).toEqual({available: false, state: 'invalid'});
    expect(existsSync(fixture.sidecar)).toBe(false);
    expect(
      EffectArray.filter(readdirSync(dirname(fixture.sidecar)), name =>
        Effect2.pipe(name, EffectString.endsWith('.tmp')),
      ),
    ).toEqual([]);
  });

  it('revalidates the linked admin registration immediately before atomic publication', async () => {
    const root = localRepository();
    git(root, ['branch', 'linked-registration']);
    const linkedParent = temporaryRoot();
    const linked = join(linkedParent, 'linked-registration');
    git(root, ['worktree', 'add', linked, 'linked-registration']);
    const identity = await runEffect(resolveRepositoryIdentity(linked));
    const home = temporaryRoot();
    const sidecar = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      identity.checkoutId,
      'local-context',
      'worktrees',
      `${identity.worktreeId}.json`,
    );
    let changed = false;

    const association = await runEffect(
      recordVerifiedCodeGraphLocalAssociation(home, identity, {
        beforePublishValidation: () =>
          Effect.sync(() => {
            const originalAdmin = Effect2.pipe(
              execFileSync('git', ['-C', linked, 'rev-parse', '--path-format=absolute', '--git-dir'], {
                encoding: 'utf8',
              }),
              EffectString.replace(/\n$/, ''),
            );
            const renamedAdmin = `${originalAdmin}-changed`;
            renameSync(originalAdmin, renamedAdmin);
            writeFileSync(join(linked, '.git'), `gitdir: ${renamedAdmin}\n`);
            changed = true;
          }),
      }),
    );

    expect(changed).toBe(true);
    expect(association).toEqual({available: false, state: 'invalid'});
    expect(existsSync(sidecar)).toBe(false);
  });

  it('home-abbreviates human display while preserving the canonical trusted-local path', async () => {
    const fixture = await provenanceFixture(homedir());

    const association = await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));

    expect('path' in association ? association.path : undefined).toBe(fixture.root);
    expect('displayPath' in association ? association.displayPath : undefined).toMatch(
      new RegExp(`^~${escapeRegularExpression(sep)}`),
    );
  });

  it('keeps a valid atomic record under bounded concurrent observations', async () => {
    const fixture = await provenanceFixture();

    const associations = await runEffect(
      Effect.all(
        Array.from({length: 32}, () => recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity)),
        {concurrency: 'unbounded'},
      ),
    );

    expect(associations).toHaveLength(32);
    expect(
      EffectRecord.fromEntries(
        EffectArray.map([...new Set(EffectArray.map(associations, association => association.state))], state => [
          state,
          EffectArray.filter(associations, association => association.state === state).length,
        ]),
      ),
    ).toEqual({verified: 32});
    expect(parseCodeGraphLocalProvenanceRecordJson(readFileSync(fixture.sidecar, 'utf8'))).toMatchObject({
      checkoutId: fixture.identity.checkoutId,
      repositoryId: fixture.identity.repositoryId,
      worktreeId: fixture.identity.worktreeId,
    });
    expect(
      EffectArray.filter(readdirSync(dirname(fixture.sidecar)), name =>
        Effect2.pipe(name, EffectString.endsWith('.tmp')),
      ),
    ).toEqual([]);
  });

  effectIt.effect('uses one complete Git resolution per concurrent cadence-hit status observation', () =>
    Effect.gen(function* () {
      const fixture = yield* effectProvenanceFixture();
      yield* recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity);
      const branch = Effect2.pipe(
        (yield* runCommandEffect('git', ['-C', fixture.root, 'symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout,
        EffectString.trim,
      );
      let gitInvocationCount = 0;
      let branchObservationCount = 0;
      let interlockCount = 0;
      const invocationCommands: string[] = [];

      const command = yield* CommandExecutor;
      const query = yield* CodeGraphQueryService;
      const executeBytes = command.executeBytes;
      if (executeBytes === undefined) return yield* TestError.make({message: 'binary command adapter is unavailable'});
      const execute = command.execute;
      const tracedCommand = {
        ...command,
        execute: (executable: string, args: readonly string[], options?: Parameters<typeof execute>[2]) => {
          if (executable === 'git') {
            gitInvocationCount += 1;
            invocationCommands.push(args[2]);
          }
          return execute(executable, args, options);
        },
        executeBytes: (executable: string, args: readonly string[], options?: Parameters<typeof executeBytes>[2]) => {
          if (executable === 'git') {
            gitInvocationCount += 1;
            invocationCommands.push(args[2]);
          }
          return executeBytes(executable, args, options).pipe(
            Effect.tap(result =>
              Effect.sync(() => {
                if (executable !== 'git' || !args.includes('--abbrev-ref=loose')) return;
                expect(args).toEqual([
                  '-C',
                  args[1],
                  'rev-parse',
                  '--path-format=absolute',
                  '--show-toplevel',
                  '--git-common-dir',
                  '--git-dir',
                  '--show-object-format',
                  'HEAD',
                  '--abbrev-ref=loose',
                  'HEAD',
                ]);
                expect(result.exitCode).toBe(0);
                const metadata = parseRepositoryIdentityMetadata(result.stdout);
                expect(metadata?.repoRoot).toBe(fixture.identity.repoRoot);
                expect(metadata?.branch).toEqual({state: 'current', branch});
                branchObservationCount += 1;
              }),
            ),
          );
        },
      };
      const statuses = yield* Effect.acquireUseRelease(
        Effect.sync(() => Object.assign(command, tracedCommand)),
        () =>
          Effect.all(
            Array.from({length: 16}, () =>
              query.status(fixture.home, fixture.root, {
                afterIdentityObserved: () =>
                  Effect.sync(() => {
                    interlockCount += 1;
                  }),
                observeWorktree: false,
              }),
            ),
            {concurrency: 'unbounded'},
          ),
        () => Effect.sync(() => Object.assign(command, {execute, executeBytes})),
      );

      expect(statuses).toHaveLength(16);
      expect(
        EffectArray.every(statuses, status => status.identity.repositoryId === fixture.identity.repositoryId),
      ).toBe(true);
      expect(EffectArray.every(statuses, status => status.identity.branch === branch)).toBe(true);
      expect(interlockCount).toBe(16);
      expect(branchObservationCount).toBe(16);
      expect(gitInvocationCount).toBe(16 * 3);
      expect(
        EffectRecord.fromEntries(
          EffectArray.map(['rev-parse', 'config', 'remote'], name => [
            name,
            EffectArray.filter(invocationCommands, command => command === name).length,
          ]),
        ),
      ).toEqual({'rev-parse': 16, config: 16, remote: 16});
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  it('distinguishes a legacy checkout, an absent exact record, and a moved worktree', async () => {
    const fixture = await provenanceFixture();
    const checkoutRoot = join(fixture.home, 'indexes', 'code-graph', 'repositories', fixture.identity.checkoutId);
    mkdirSync(checkoutRoot, {recursive: true});

    expect(await runEffect(readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity))).toEqual({
      available: false,
      state: 'legacy-unknown',
    });

    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    unlinkSync(fixture.sidecar);
    expect(await runEffect(readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity))).toEqual({
      available: false,
      state: 'legacy-unknown',
    });

    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    const beforeMove = readRecord(fixture.sidecar);
    const movedRoot = `${fixture.root}-moved`;
    renameSync(fixture.root, movedRoot);
    temporaryRoots.push(movedRoot);
    const moved = await runEffect(readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    expect(moved).toMatchObject({
      available: false,
      displayPath: fixture.root,
      observedAt: beforeMove.observedAt,
      path: fixture.root,
      state: 'missing',
    });
  });

  it('treats an exact sidecar disappearing before or during bounded open as legacy-unknown', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));

    for (const disappearance of ['initial-stat', 'bounded-open'] as const) {
      const association = await runEffect(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          let sidecarStatCount = 0;
          const disappearingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            stat: target => {
              if (basename(String(target)) !== `${fixture.identity.worktreeId}.json`) {
                return fileSystem.stat(target);
              }
              sidecarStatCount += 1;
              const disappearAt = disappearance === 'initial-stat' ? 1 : 2;
              return sidecarStatCount === disappearAt
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: 'NotFound',
                      description: 'injected atomic sidecar disappearance',
                      method: 'stat',
                      module: 'FileSystem',
                      pathOrDescriptor: String(target),
                    }),
                  )
                : fileSystem.stat(target);
            },
          });
          return yield* readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity).pipe(
            Effect.provideService(FileSystem.FileSystem, disappearingFileSystem),
          );
        }),
      );

      expect(association, disappearance).toEqual({available: false, state: 'legacy-unknown'});
    }
  });

  it('hides an existing path whose repository identity no longer matches the persisted tuple', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    writeFileSync(
      fixture.sidecar,
      `${JSON.stringify({...readRecord(fixture.sidecar), observedAt: '2020-01-01T00:00:00.000Z'})}\n`,
      {mode: 0o600},
    );
    git(fixture.root, ['remote', 'add', 'origin', 'https://example.com/replaced/repository.git']);

    const stale = await runEffect(readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity));

    expect(stale).toEqual({available: false, state: 'stale'});
    expect(JSON.stringify(stale)).not.toContain(fixture.root);
  });

  it('uses the fresh display cadence without Git while still requiring a canonical directory', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    let gitInvocationCount = 0;

    const read = () =>
      runEffect(
        Effect.gen(function* () {
          const command = yield* CommandExecutor;
          const execute = command.execute;
          return yield* Effect.acquireUseRelease(
            Effect.sync(() =>
              Object.assign(command, {
                execute: (executable: string, args: readonly string[], options?: Parameters<typeof execute>[2]) => {
                  if (executable === 'git') gitInvocationCount += 1;
                  return execute(executable, args, options);
                },
              }),
            ),
            () => readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity),
            () => Effect.sync(() => Object.assign(command, {execute})),
          );
        }),
      );

    expect(await read()).toMatchObject({available: true, path: fixture.root, state: 'verified'});
    expect(await read()).toMatchObject({available: true, path: fixture.root, state: 'verified'});
    expect(gitInvocationCount).toBe(0);

    const regularPath = join(temporaryRoot(), 'not-a-directory');
    writeFileSync(regularPath, 'not a worktree');
    writeFileSync(
      fixture.sidecar,
      `${JSON.stringify({...readRecord(fixture.sidecar), canonicalWorktreePath: realpathSync(regularPath)})}\n`,
      {mode: 0o600},
    );
    const notDirectory = await read();
    expect(notDirectory).toEqual({available: false, state: 'stale'});
    expect(JSON.stringify(notDirectory)).not.toContain(regularPath);
    expect(gitInvocationCount).toBe(0);
  });

  effectIt.effect('refreshes an expired display observation once and reuses the newly published cadence', () =>
    Effect.gen(function* () {
      const fixture = yield* effectProvenanceFixture();
      const fs = yield* FileSystem.FileSystem;
      yield* recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity);
      const expiredObservedAt = '2020-01-01T00:00:00.000Z';
      const record = parseValidRecord(yield* fs.readFileString(fixture.sidecar));
      yield* fs.writeFileString(fixture.sidecar, `${JSON.stringify({...record, observedAt: expiredObservedAt})}\n`, {
        mode: 0o600,
      });
      let identityResolutionCount = 0;

      const command = yield* CommandExecutor;
      const executeBytes = command.executeBytes;
      if (executeBytes === undefined) return yield* TestError.make({message: 'binary command adapter is unavailable'});
      const execute = command.execute;
      const tracedCommand = {
        ...command,
        execute: (executable: string, args: readonly string[], options?: Parameters<typeof execute>[2]) => {
          if (executable === 'git' && args.includes('rev-parse') && args.includes('--show-toplevel'))
            identityResolutionCount += 1;
          return execute(executable, args, options);
        },
        executeBytes: (executable: string, args: readonly string[], options?: Parameters<typeof executeBytes>[2]) => {
          if (executable === 'git' && args.includes('rev-parse') && args.includes('--show-toplevel'))
            identityResolutionCount += 1;
          return executeBytes(executable, args, options);
        },
      };
      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() => Object.assign(command, tracedCommand)),
        () =>
          Effect.gen(function* () {
            const first = yield* readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity);
            const afterFirstResolutionCount = identityResolutionCount;
            const second = yield* readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity);
            return {afterFirstResolutionCount, first, second};
          }),
        () => Effect.sync(() => Object.assign(command, {execute, executeBytes})),
      );

      expect(result.first).toMatchObject({available: true, path: fixture.root, state: 'verified'});
      expect(result.second).toMatchObject({available: true, path: fixture.root, state: 'verified'});
      expect('observedAt' in result.first ? result.first.observedAt : undefined).not.toBe(expiredObservedAt);
      expect(result.afterFirstResolutionCount).toBe(2);
      expect(identityResolutionCount).toBe(2);
    }).pipe(provideTestLayer(provenancePlatformLayer), TestClock.withLive),
  );

  it('rejects permissive, malformed, non-absolute, and mismatched records without displaying their paths', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    const valid = readRecord(fixture.sidecar);

    chmodSync(fixture.sidecar, 0o644);
    expect(await runEffect(readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity))).toEqual({
      available: false,
      state: 'invalid',
    });

    chmodSync(fixture.sidecar, 0o600);
    writeFileSync(fixture.sidecar, '{not-json}\n', {mode: 0o600});
    expect(await runEffect(readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity))).toEqual({
      available: false,
      state: 'invalid',
    });

    writeFileSync(fixture.sidecar, `${JSON.stringify({...valid, canonicalWorktreePath: 'relative/private'})}\n`, {
      mode: 0o600,
    });
    const nonAbsolute = await runEffect(readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    expect(nonAbsolute).toEqual({available: false, state: 'invalid'});
    expect(JSON.stringify(nonAbsolute)).not.toContain('relative/private');

    writeFileSync(
      fixture.sidecar,
      `${JSON.stringify({...valid, checkoutId: Effect2.pipe('f', EffectString.repeat(64))})}\n`,
      {mode: 0o600},
    );
    expect(await runEffect(readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity))).toEqual({
      available: false,
      state: 'invalid',
    });
  });

  it('rejects bounded invalid UTF-8 sidecars without displaying their recorded path', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    writeFileSync(fixture.sidecar, Uint8Array.of(0xc3, 0x28), {mode: 0o600});

    const association = await runEffect(readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity));

    expect(association).toEqual({available: false, state: 'invalid'});
    expect(JSON.stringify(association)).not.toContain(fixture.root);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked target without following or modifying its external record',
    async () => {
      const fixture = await provenanceFixture();
      await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
      const external = join(temporaryRoot(), 'external-record.json');
      const content = readFileSync(fixture.sidecar, 'utf8');
      writeFileSync(external, content, {mode: 0o600});
      unlinkSync(fixture.sidecar);
      symlinkSync(external, fixture.sidecar);

      expect(await runEffect(readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity))).toEqual({
        available: false,
        state: 'invalid',
      });
      expect(await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity))).toEqual({
        available: false,
        state: 'invalid',
      });
      expect(lstatSync(fixture.sidecar).isSymbolicLink()).toBe(true);
      expect(readFileSync(external, 'utf8')).toBe(content);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked sidecar ancestor before writing outside home',
    async () => {
      const fixture = await provenanceFixture();
      const external = temporaryRoot();
      symlinkSync(external, join(fixture.home, 'indexes'));

      const association = await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));

      expect(association).toEqual({available: false, state: 'invalid'});
      expect(existsSync(join(external, 'code-graph'))).toBe(false);
    },
  );

  it('fails closed without an unbounded read when a regular sidecar grows during a persisted read', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    let grew = false;
    let maximumBufferBytes = 0;

    const raced = await runEffect(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const adversarialFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (target, options) =>
            fileSystem.open(target, options).pipe(
              Effect.map(opened =>
                basename(String(target)) === `${fixture.identity.worktreeId}.json`
                  ? mapOpenedFile(opened, buffer => {
                      maximumBufferBytes = Math.max(maximumBufferBytes, buffer.byteLength);
                      return opened.read(buffer).pipe(
                        Effect.flatMap(count => {
                          if (Number(count) > 0 || grew) return Effect.succeed(count);
                          grew = true;
                          buffer.fill(
                            Effect2.pipe(
                              'x',
                              EffectString.charCodeAt(0),
                              Effect2.Option.getOrElse(() => NaN),
                            ),
                          );
                          return Effect.succeed(buffer.byteLength);
                        }),
                      );
                    })
                  : opened,
              ),
            ),
        });
        return yield* readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity).pipe(
          Effect.provideService(FileSystem.FileSystem, adversarialFileSystem),
        );
      }),
    );

    expect(grew).toBe(true);
    expect(maximumBufferBytes).toBeLessThanOrEqual(8 * 1_024 + 1);
    expect(raced).toEqual({available: false, state: 'invalid'});
  });

  it('fails closed when a regular sidecar is atomically replaced during a persisted read', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));
    const record = readRecord(fixture.sidecar);

    const raced = await runEffect(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        let replaced = false;
        const adversarialFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (target, options) =>
            fileSystem.open(target, options).pipe(
              Effect.map(opened =>
                basename(String(target)) === `${fixture.identity.worktreeId}.json`
                  ? mapOpenedFile(opened, buffer =>
                      opened.read(buffer).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            if (replaced) return;
                            replaced = true;
                            const replacement = join(dirname(fixture.sidecar), '.replacement.tmp');
                            const {headCommit: _headCommit, ...replacementRecord} = record;
                            writeFileSync(replacement, `${JSON.stringify(replacementRecord)}\n`, {mode: 0o600});
                            renameSync(replacement, fixture.sidecar);
                          }),
                        ),
                      ),
                    )
                  : opened,
              ),
            ),
        });
        return yield* readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity).pipe(
          Effect.provideService(FileSystem.FileSystem, adversarialFileSystem),
        );
      }),
    );

    expect(raced).toEqual({available: false, state: 'invalid'});
  });

  it('fails closed when a custom filesystem omits sidecar inode or modification time', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));

    for (const omitted of ['inode', 'mtime'] as const) {
      const association = await runEffect(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const withoutIdentity = (info: FileSystem.File.Info): FileSystem.File.Info => ({
            ...info,
            ...(omitted === 'inode' ? {ino: Option.none()} : {mtime: Option.none()}),
          });
          const isSidecar = (target: string) => basename(target) === `${fixture.identity.worktreeId}.json`;
          const customFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            open: (target, options) =>
              fileSystem
                .open(target, options)
                .pipe(
                  Effect.map(opened =>
                    isSidecar(String(target))
                      ? mapOpenedFile(opened, buffer => opened.read(buffer), withoutIdentity)
                      : opened,
                  ),
                ),
            stat: target =>
              fileSystem
                .stat(target)
                .pipe(Effect.map(info => (isSidecar(String(target)) ? withoutIdentity(info) : info))),
          });
          return yield* readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity).pipe(
            Effect.provideService(FileSystem.FileSystem, customFileSystem),
          );
        }),
      );

      expect(association, omitted).toEqual({available: false, state: 'invalid'});
    }
  });

  it('turns filesystem failures into path-free invalid state at the supplemental boundary', async () => {
    const fixture = await provenanceFixture();
    await runEffect(recordVerifiedCodeGraphLocalAssociation(fixture.home, fixture.identity));

    for (const method of ['exists', 'stat', 'stat-after-read', 'read', 'realPath'] as const) {
      const association = await readWithInjectedFileSystemFailure(fixture, method);
      expect(association, method).toEqual({available: false, state: 'invalid'});
      expect(JSON.stringify(association), method).not.toContain(fixture.root);
    }
  });

  fcProp(
    it,
    'round-trips bounded records and strips every local path from privacy-safe projections',
    {
      segment: FC.array(FC.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'), {maxLength: 32, minLength: 1}).map(
        characters => EffectArray.join(characters, ''),
      ),
    },
    ({segment}) => {
      const record = {
        branch: `feature/${segment}`,
        canonicalWorktreePath: `/private/tmp/${segment}`,
        checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
        headCommit: Effect2.pipe('b', EffectString.repeat(40)),
        observedAt: '2026-08-08T12:00:00.000Z',
        repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
        schemaVersion: 1,
        worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
      } satisfies CodeGraphLocalProvenanceRecord;
      expect(parseCodeGraphLocalProvenanceRecordJson(JSON.stringify(record))).toEqual(record);

      const safe = privacySafeCodeGraphLocalAssociation({
        available: true,
        branch: record.branch,
        displayPath: `~/${segment}`,
        observedAt: record.observedAt,
        path: record.canonicalWorktreePath,
        state: 'verified',
      });
      expect(safe).toEqual({available: true, state: 'verified'});
      expect(JSON.stringify(safe)).not.toContain(record.canonicalWorktreePath);
      expect(JSON.stringify(safe)).not.toContain(`~/${segment}`);
      expect(JSON.stringify(safe)).not.toContain(record.branch);
    },
    {fastCheck: {numRuns: 200}},
  );
});

const provenancePlatformLayer = Layer.mergeAll(
  TestSystemInfoLayer,
  TestCommandExecutorLayer.pipe(Layer.provide(TestSystemInfoLayer)),
).pipe(Layer.provideMerge(BunServices.layer));

const effectProvenanceFixture = Effect.fn('localProvenanceTest.effectFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* Effect.acquireRelease(
    fs.makeTempDirectory({prefix: 'threadnote-provenance-effect-'}),
    directory => fs.remove(directory, {recursive: true, force: true}).pipe(Effect.orDie),
  );
  const home = path.join(temporary, 'home');
  const repository = path.join(temporary, 'repository');
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(repository);
  yield* runCommandEffect('git', ['-C', repository, 'init', '-q', '-b', 'main']);
  yield* runCommandEffect('git', [
    '-C',
    repository,
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  const root = yield* fs.realPath(repository);
  const identity = yield* resolveRepositoryIdentity(root);
  return {
    home,
    identity,
    root,
    sidecar: path.join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      identity.checkoutId,
      'local-context',
      'worktrees',
      `${identity.worktreeId}.json`,
    ),
  };
});

async function provenanceFixture(parent?: string): Promise<{
  readonly home: string;
  readonly identity: RepositoryIdentity;
  readonly root: string;
  readonly sidecar: string;
}> {
  const home = temporaryRoot();
  const root = localRepository(parent);
  const identity = await runEffect(resolveRepositoryIdentity(root));
  return {
    home,
    identity,
    root,
    sidecar: join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      identity.checkoutId,
      'local-context',
      'worktrees',
      `${identity.worktreeId}.json`,
    ),
  };
}

function localRepository(parent = tmpdir()): string {
  const root = mkdtempSync(join(parent, '.threadnote-code-graph-provenance-'));
  temporaryRoots.push(root);
  git(root, ['init', '-q']);
  git(root, [
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  return realpathSync(root);
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-provenance-home-'));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

function readRecord(file: string): CodeGraphLocalProvenanceRecord {
  return parseValidRecord(readFileSync(file, 'utf8'));
}

function parseValidRecord(content: string): CodeGraphLocalProvenanceRecord {
  const record = parseCodeGraphLocalProvenanceRecordJson(content);
  if (record === undefined) throw new Error('Expected the fixture to contain a valid local provenance record.');
  return record;
}

function readWithInjectedFileSystemFailure(
  fixture: Awaited<ReturnType<typeof provenanceFixture>>,
  method: 'exists' | 'read' | 'realPath' | 'stat' | 'stat-after-read',
) {
  return runEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let sidecarStatCount = 0;
      const isSidecar = (target: string) => basename(target) === `${fixture.identity.worktreeId}.json`;
      const failure = (operation: string, target: string) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: 'PermissionDenied',
            description: 'injected local provenance failure',
            method: operation,
            module: 'FileSystem',
            pathOrDescriptor: target,
          }),
        );
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        exists: target =>
          method === 'exists' && target === fixture.root
            ? failure('exists', String(target))
            : fileSystem.exists(target),
        open: (target, options) =>
          fileSystem
            .open(target, options)
            .pipe(
              Effect.map(opened =>
                method === 'read' && isSidecar(String(target))
                  ? mapOpenedFile(opened, () => failure('read', String(target)))
                  : opened,
              ),
            ),
        realPath: target =>
          method === 'realPath' && target === fixture.root
            ? failure('realPath', String(target))
            : fileSystem.realPath(target),
        stat: target => {
          if (!isSidecar(String(target))) return fileSystem.stat(target);
          sidecarStatCount += 1;
          return method === 'stat' || (method === 'stat-after-read' && sidecarStatCount === 3)
            ? failure('stat', String(target))
            : fileSystem.stat(target);
        },
      });
      return yield* readPersistedCodeGraphLocalAssociation(fixture.home, fixture.identity).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
    }),
  );
}

function mapOpenedFile(
  opened: FileSystem.File,
  read: FileSystem.File['read'],
  mapInfo: (info: FileSystem.File.Info) => FileSystem.File.Info = info => info,
): FileSystem.File {
  const descriptor = (opened as FileSystem.File & {readonly fd?: unknown}).fd;
  return {
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    ...(typeof descriptor === 'number' ? {fd: descriptor} : {}),
    read,
    readAlloc: size => opened.readAlloc(size),
    seek: (offset, from) => opened.seek(offset, from),
    stat: opened.stat.pipe(Effect.map(mapInfo)),
    sync: opened.sync,
    truncate: length => opened.truncate(length),
    write: buffer => opened.write(buffer),
    writeAll: buffer => opened.writeAll(buffer),
  };
}

function escapeRegularExpression(value: string): string {
  return Effect2.pipe(value, EffectString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

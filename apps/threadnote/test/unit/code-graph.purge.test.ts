import {readFile, readlink, rename, rm as nodeRm, symlink} from '@threadnote/testing/node-fs-promises';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Option, Path} from 'effect';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {codeGraphRepositoryLockPath} from '@threadnote/graph/layout';
import {purgeCodeGraphIndex} from '@threadnote/graph/maintenance';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';

describe('targeted code graph purge', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('previews and removes only the selected checkout without a worktree path', async () => {
    const home = await mkdtemp('threadnote-targeted-graph-purge-');
    homes.push(home);
    const checkoutId = 'a'.repeat(64);
    const siblingCheckoutId = 'b'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const siblingRoot = join(home, 'indexes', 'code-graph', 'repositories', siblingCheckoutId);
    await mkdir(join(repositoryRoot, 'vectors'), {recursive: true});
    await mkdir(siblingRoot, {recursive: true});
    await writeFile(join(repositoryRoot, 'graph-v3.sqlite'), 'disposable graph\n');
    await writeFile(join(repositoryRoot, 'vectors', 'model.sqlite'), 'disposable vectors\n');
    await writeFile(join(siblingRoot, 'graph-v3.sqlite'), 'sibling must survive\n');

    await expect(runEffect(purgeCodeGraphIndex(home, checkoutId, {dryRun: true}))).resolves.toEqual({
      checkoutId,
      dryRun: true,
      existed: true,
    });
    await expect(Bun.file(join(repositoryRoot, 'graph-v3.sqlite')).exists()).resolves.toBe(true);

    await expect(runEffect(purgeCodeGraphIndex(home, checkoutId, {dryRun: false}))).resolves.toEqual({
      checkoutId,
      dryRun: false,
      existed: true,
    });
    await expect(Bun.file(join(repositoryRoot, 'graph-v3.sqlite')).exists()).resolves.toBe(false);
    await expect(readFile(join(siblingRoot, 'graph-v3.sqlite'), 'utf8')).resolves.toContain('must survive');

    await expect(runEffect(purgeCodeGraphIndex(home, checkoutId, {dryRun: false}))).resolves.toEqual({
      checkoutId,
      dryRun: false,
      existed: false,
    });
  });

  effectIt.effect('reports purge safety phases without removing sibling checkouts', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-targeted-graph-purge-progress-'));
      homes.push(home);
      const checkoutId = 'd'.repeat(64);
      const siblingCheckoutId = 'e'.repeat(64);
      const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const siblingRoot = join(home, 'indexes', 'code-graph', 'repositories', siblingCheckoutId);
      yield* Effect.promise(() => mkdir(join(repositoryRoot, 'vectors'), {recursive: true}));
      yield* Effect.promise(() => mkdir(siblingRoot, {recursive: true}));
      yield* Effect.promise(() => writeFile(join(repositoryRoot, 'graph-v3.sqlite'), 'disposable graph\n'));
      yield* Effect.promise(() => writeFile(join(siblingRoot, 'graph-v3.sqlite'), 'sibling must survive\n'));
      const phases: string[] = [];
      const summary = yield* purgeCodeGraphIndex(home, checkoutId, {
        dryRun: false,
        onProgress: progress => Effect.sync(() => void phases.push(progress.phase)),
      });

      expect(summary).toEqual({checkoutId, dryRun: false, existed: true});
      expect(phases).toEqual(['waiting-builders', 'verifying', 'quarantining', 'deleting', 'deleting']);
      expect(yield* Effect.promise(() => Bun.file(join(repositoryRoot, 'graph-v3.sqlite')).exists())).toBe(false);
      expect(yield* Effect.promise(() => readFile(join(siblingRoot, 'graph-v3.sqlite'), 'utf8'))).toContain(
        'must survive',
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recovers native checkout identity when Effect omits the inode', () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp('threadnote-targeted-graph-purge-native-inode-')),
      home =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const checkoutId = '9'.repeat(64);
          const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
          yield* Effect.promise(() => mkdir(repositoryRoot, {recursive: true}));
          yield* Effect.promise(() => writeFile(join(repositoryRoot, 'graph-v3.sqlite'), 'disposable graph\n'));
          const withoutInode = (info: FileSystem.File.Info): FileSystem.File.Info => ({
            ...info,
            ino: Option.none(),
          });
          const inodeOmittingFileSystem = FileSystem.FileSystem.of({
            ...fs,
            open: (target, options) =>
              fs.open(target, options).pipe(
                Effect.map(opened => {
                  const descriptor = (opened as FileSystem.File & {readonly fd?: unknown}).fd;
                  return {
                    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
                    ...(typeof descriptor === 'number' ? {fd: descriptor} : {}),
                    read: buffer => opened.read(buffer),
                    readAlloc: size => opened.readAlloc(size),
                    seek: (offset, from) => opened.seek(offset, from),
                    stat: opened.stat.pipe(Effect.map(withoutInode)),
                    sync: opened.sync,
                    truncate: length => opened.truncate(length),
                    write: buffer => opened.write(buffer),
                    writeAll: buffer => opened.writeAll(buffer),
                  };
                }),
              ),
            stat: target => fs.stat(target).pipe(Effect.map(withoutInode)),
          });

          expect(
            yield* purgeCodeGraphIndex(home, checkoutId, {dryRun: false}).pipe(
              Effect.provideService(FileSystem.FileSystem, inodeOmittingFileSystem),
            ),
          ).toEqual({checkoutId, dryRun: false, existed: true});
          expect(yield* Effect.promise(() => Bun.file(join(repositoryRoot, 'graph-v3.sqlite')).exists())).toBe(false);
        }),
      home => Effect.promise(() => rm(home, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves a checkout when native identity cannot cohere with Effect metadata', () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp('threadnote-targeted-graph-purge-incoherent-identity-')),
      home =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const checkoutId = '8'.repeat(64);
          const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
          const graph = join(repositoryRoot, 'graph-v3.sqlite');
          yield* Effect.promise(() => mkdir(repositoryRoot, {recursive: true}));
          yield* Effect.promise(() => writeFile(graph, 'must survive\n'));
          const incoherentFileSystem = FileSystem.FileSystem.of({
            ...fs,
            stat: target =>
              fs.stat(target).pipe(
                Effect.map(info => ({
                  ...info,
                  dev: info.dev + 1n,
                  ino: Option.none(),
                })),
              ),
          });

          const exit = yield* Effect.exit(
            purgeCodeGraphIndex(home, checkoutId, {dryRun: false}).pipe(
              Effect.provideService(FileSystem.FileSystem, incoherentFileSystem),
            ),
          );
          expect(exit._tag).toBe('Failure');
          expect(yield* Effect.promise(() => Bun.file(graph).exists())).toBe(true);
          expect(yield* Effect.promise(() => readFile(graph, 'utf8'))).toContain('must survive');
        }),
      home => Effect.promise(() => rm(home, {force: true, recursive: true})),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('rejects invalid checkout identities before inspecting storage', async () => {
    const home = await mkdtemp('threadnote-targeted-graph-purge-invalid-');
    homes.push(home);

    await fc.assert(
      fc.asyncProperty(
        fc.string().filter(value => !/^[0-9a-f]{64}$/.test(value)),
        async checkoutId => {
          await expect(runEffect(purgeCodeGraphIndex(home, checkoutId, {dryRun: false}))).rejects.toThrow(
            'Code graph checkout identity is invalid',
          );
        },
      ),
      {numRuns: 100},
    );
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symbolic-link checkout root and preserves its target',
    async () => {
      const home = await mkdtemp('threadnote-targeted-graph-purge-link-');
      homes.push(home);
      const checkoutId = 'c'.repeat(64);
      const repositories = join(home, 'indexes', 'code-graph', 'repositories');
      const repositoryRoot = join(repositories, checkoutId);
      const external = join(home, 'external-graph');
      await mkdir(repositories, {recursive: true});
      await mkdir(external, {recursive: true});
      await writeFile(join(external, 'keep.txt'), 'external target must survive\n');
      await symlink(external, repositoryRoot);

      await expect(runEffect(purgeCodeGraphIndex(home, checkoutId, {dryRun: false}))).rejects.toThrow(
        'symbolic-link checkout root',
      );
      await expect(readFile(join(external, 'keep.txt'), 'utf8')).resolves.toContain('must survive');
      await expect(readlink(repositoryRoot)).resolves.toBe(external);
    },
  );

  it('fails immediately while an active build owns the checkout lock', async () => {
    const home = await mkdtemp('threadnote-targeted-graph-purge-lock-');
    homes.push(home);
    const checkoutId = 'd'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    await mkdir(repositoryRoot, {recursive: true});
    await writeFile(join(repositoryRoot, 'graph-v3.sqlite'), 'locked graph\n');

    const result = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* Effect.forkChild(
          withExclusiveFileLock(
            fs,
            codeGraphRepositoryLockPath(path, home, checkoutId),
            {
              heartbeatIntervalMilliseconds: 20,
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 100,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ),
        );
        yield* Deferred.await(acquired);
        const purged = yield* purgeCodeGraphIndex(home, checkoutId, {dryRun: false}).pipe(
          Effect.match({
            onFailure: error => ({error, success: false as const}),
            onSuccess: summary => ({success: true as const, summary}),
          }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        return purged;
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatchObject({name: 'FileLockTimeout'});
    await expect(readFile(join(repositoryRoot, 'graph-v3.sqlite'), 'utf8')).resolves.toContain('locked');
  });

  it.skipIf(process.platform === 'win32')('revalidates the checkout root after planning', async () => {
    const home = await mkdtemp('threadnote-targeted-graph-purge-race-');
    homes.push(home);
    const checkoutId = 'e'.repeat(64);
    const repositories = join(home, 'indexes', 'code-graph', 'repositories');
    const repositoryRoot = join(repositories, checkoutId);
    const external = join(home, 'external-race-graph');
    await mkdir(repositoryRoot, {recursive: true});
    await mkdir(external, {recursive: true});
    await writeFile(join(repositoryRoot, 'graph-v3.sqlite'), 'initial graph\n');
    await writeFile(join(external, 'keep.txt'), 'external race target must survive\n');

    await expect(
      runEffect(
        purgeCodeGraphIndex(home, checkoutId, {
          dryRun: false,
          interlock: {
            beforeVerification: () =>
              Effect.promise(async () => {
                await nodeRm(repositoryRoot, {recursive: true});
                await symlink(external, repositoryRoot);
              }),
          },
        }),
      ),
    ).rejects.toThrow('symbolic-link checkout root');
    await expect(readFile(join(external, 'keep.txt'), 'utf8')).resolves.toContain('must survive');
    await expect(readlink(repositoryRoot)).resolves.toBe(external);
  });

  it('refuses a same-path directory replacement and preserves its contents', async () => {
    const home = await mkdtemp('threadnote-targeted-graph-purge-directory-race-');
    homes.push(home);
    const checkoutId = 'f'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const sentinel = join(repositoryRoot, 'replacement-must-survive.txt');
    await mkdir(repositoryRoot, {recursive: true});
    await writeFile(join(repositoryRoot, 'graph-v3.sqlite'), 'initial graph\n');

    await expect(
      runEffect(
        purgeCodeGraphIndex(home, checkoutId, {
          dryRun: false,
          interlock: {
            beforeVerification: () =>
              Effect.promise(async () => {
                await nodeRm(repositoryRoot, {recursive: true});
                await mkdir(repositoryRoot, {recursive: true});
                await writeFile(sentinel, 'replacement must survive\n');
              }),
          },
        }),
      ),
    ).rejects.toThrow('checkout target changed before purge');
    await expect(readFile(sentinel, 'utf8')).resolves.toContain('must survive');
  });

  it('quarantines atomically and restores a directory swapped after verification', async () => {
    const home = await mkdtemp('threadnote-targeted-graph-purge-removal-race-');
    homes.push(home);
    const checkoutId = '1'.repeat(64);
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const displacedRoot = join(home, 'displaced-original-graph');
    const sentinel = join(repositoryRoot, 'replacement-must-survive.txt');
    await mkdir(repositoryRoot, {recursive: true});
    await writeFile(join(repositoryRoot, 'graph-v3.sqlite'), 'initial graph\n');

    await expect(
      runEffect(
        purgeCodeGraphIndex(home, checkoutId, {
          dryRun: false,
          interlock: {
            beforeRemoval: () =>
              Effect.promise(async () => {
                await rename(repositoryRoot, displacedRoot);
                await mkdir(repositoryRoot, {recursive: true});
                await writeFile(sentinel, 'replacement must survive\n');
              }),
          },
        }),
      ),
    ).rejects.toThrow('checkout target changed before purge');
    await expect(readFile(sentinel, 'utf8')).resolves.toContain('must survive');
    await expect(readFile(join(displacedRoot, 'graph-v3.sqlite'), 'utf8')).resolves.toContain('initial graph');
  });
});

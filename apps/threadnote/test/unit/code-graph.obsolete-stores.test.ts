import {Array as EffectArray} from 'effect';
import {open, readFile, readlink, rm as nodeRm, symlink} from '@threadnote/testing/node-fs-promises';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  codeGraphDoctorCheck,
  inspectObsoleteCodeGraphStores,
  purgeObsoleteCodeGraphStores,
  repairCodeGraphIndexes,
} from '@threadnote/graph/maintenance';
import {codeGraphRepositoryLockPath} from '@threadnote/graph/layout';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CODE_GRAPH_SCHEMA_VERSION} from '@threadnote/graph/types';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('obsolete code graph stores', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  it('reports exact sparse v2 bytes and purges only verified obsolete SQLite artifacts', async () => {
    expect(CODE_GRAPH_SCHEMA_VERSION).toBeGreaterThan(2);
    const home = await mkdtemp('threadnote-obsolete-graph-');
    homes.push(home);
    const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    await mkdir(join(repositoryRoot, 'vectors'), {recursive: true});
    const databaseBytes = 25 * 1024 ** 3 + 123;
    const walBytes = 8 * 1024 ** 3 + 17;
    const shmBytes = 32_768;
    await sparseFile(join(repositoryRoot, 'graph-v2.sqlite'), databaseBytes);
    await sparseFile(join(repositoryRoot, 'graph-v2.sqlite-wal'), walBytes);
    await sparseFile(join(repositoryRoot, 'graph-v2.sqlite-shm'), shmBytes);
    const currentDatabase = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
    await createHealthyCurrentDatabase(currentDatabase);
    const futureDatabase = join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION + 1}.sqlite`);
    await writeFile(futureDatabase, 'future schema must survive\n');
    const vector = join(repositoryRoot, 'vectors', 'current.vector');
    await writeFile(vector, 'current vector must survive\n');
    const expectedBytes = databaseBytes + walBytes + shmBytes;

    const inventory = await runEffect(inspectObsoleteCodeGraphStores(home));
    expect(inventory).toMatchObject({bytes: expectedBytes, fileCount: 3, unsafeEntryCount: 0});
    expect(inventory.checkouts).toEqual([expect.objectContaining({bytes: expectedBytes, checkoutId, versions: [2]})]);
    expect(EffectArray.map(inventory.checkouts[0].files, file => [file.fileName, file.bytes])).toEqual([
      ['graph-v2.sqlite', databaseBytes],
      ['graph-v2.sqlite-shm', shmBytes],
      ['graph-v2.sqlite-wal', walBytes],
    ]);

    const doctor = await runEffect(codeGraphDoctorCheck(home));
    expect(doctor).toMatchObject({status: 'warn'});
    expect(doctor.detail).toContain(`3 obsolete store file(s), ${expectedBytes} byte(s), across 1 checkout(s)`);

    const repair = await runEffect(repairCodeGraphIndexes(home, true, undefined, undefined, {mode: 'quick'}));
    expect(repair).toMatchObject({
      obsoleteStoreBytes: expectedBytes,
      obsoleteStoreCheckouts: 1,
      obsoleteStoreFiles: 3,
      unsafeObsoleteEntries: 0,
    });

    const dryRun = await runEffect(purgeObsoleteCodeGraphStores(home, checkoutId, {dryRun: true}));
    expect(dryRun).toEqual({bytes: expectedBytes, checkoutId, dryRun: true, fileCount: 3, versions: [2]});
    await expect(Bun.file(join(repositoryRoot, 'graph-v2.sqlite')).exists()).resolves.toBe(true);

    const purged = await runEffect(purgeObsoleteCodeGraphStores(home, checkoutId, {dryRun: false}));
    expect(purged).toEqual({...dryRun, dryRun: false});
    await expect(Bun.file(join(repositoryRoot, 'graph-v2.sqlite')).exists()).resolves.toBe(false);
    await expect(Bun.file(join(repositoryRoot, 'graph-v2.sqlite-wal')).exists()).resolves.toBe(false);
    await expect(Bun.file(join(repositoryRoot, 'graph-v2.sqlite-shm')).exists()).resolves.toBe(false);
    await expect(Bun.file(currentDatabase).exists()).resolves.toBe(true);
    await expect(Bun.file(futureDatabase).text()).resolves.toContain('future schema must survive');
    await expect(Bun.file(vector).text()).resolves.toContain('current vector must survive');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses obsolete-shaped symbolic links and preserves their targets',
    async () => {
      const home = await mkdtemp('threadnote-obsolete-graph-link-');
      homes.push(home);
      const checkoutId = Effect2.pipe('b', EffectString.repeat(64));
      const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
      const external = join(home, 'external.sqlite');
      await mkdir(repositoryRoot, {recursive: true});
      await writeFile(external, 'external data must survive\n');
      const candidate = join(repositoryRoot, 'graph-v2.sqlite');
      await symlink(external, candidate);

      const inventory = await runEffect(inspectObsoleteCodeGraphStores(home, checkoutId));
      expect(inventory).toMatchObject({bytes: 0, fileCount: 0, unsafeEntryCount: 1});
      await expect(runEffect(purgeObsoleteCodeGraphStores(home, checkoutId, {dryRun: false}))).rejects.toThrow(
        /Refusing obsolete code graph cleanup/,
      );
      await expect(readFile(external, 'utf8')).resolves.toContain('must survive');
      await expect(readlink(candidate)).resolves.toBe(external);
    },
  );

  it('fails immediately while an active build owns the checkout lock', async () => {
    const home = await mkdtemp('threadnote-obsolete-graph-lock-');
    homes.push(home);
    const checkoutId = Effect2.pipe('c', EffectString.repeat(64));
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    await mkdir(repositoryRoot, {recursive: true});
    const obsolete = join(repositoryRoot, 'graph-v2.sqlite');
    await writeFile(obsolete, 'obsolete but locked\n');

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
        const purged = yield* purgeObsoleteCodeGraphStores(home, checkoutId, {dryRun: false}).pipe(
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
    await expect(Bun.file(obsolete).text()).resolves.toContain('locked');
  });

  it.skipIf(process.platform === 'win32')('revalidates after planning and refuses a symlink race', async () => {
    const home = await mkdtemp('threadnote-obsolete-graph-race-');
    homes.push(home);
    const checkoutId = Effect2.pipe('d', EffectString.repeat(64));
    const repositoryRoot = join(home, 'indexes', 'code-graph', 'repositories', checkoutId);
    const candidate = join(repositoryRoot, 'graph-v2.sqlite');
    const external = join(home, 'external-race.sqlite');
    await mkdir(repositoryRoot, {recursive: true});
    await writeFile(candidate, 'initial obsolete file\n');
    await writeFile(external, 'external race target must survive\n');

    await expect(
      runEffect(
        purgeObsoleteCodeGraphStores(home, checkoutId, {
          dryRun: false,
          interlock: {
            beforeVerification: () =>
              Effect.promise(async () => {
                await nodeRm(candidate);
                await symlink(external, candidate);
              }),
          },
        }),
      ),
    ).rejects.toThrow(/Refusing obsolete code graph cleanup/);
    await expect(readFile(external, 'utf8')).resolves.toContain('must survive');
    await expect(readlink(candidate)).resolves.toBe(external);
  });
});

async function sparseFile(path: string, bytes: number): Promise<void> {
  const handle = await open(path, 'w');
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}

async function createHealthyCurrentDatabase(path: string): Promise<void> {
  await runEffect(
    Effect.gen(function* () {
      const store = yield* CodeGraphStore;
      yield* store.initialize(path);
    }),
  );
}

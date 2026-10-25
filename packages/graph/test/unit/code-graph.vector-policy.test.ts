import {serializeCodeGraphStatusV5} from '@threadnote/graph/status/projection';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import * as TestClock from 'effect/testing/TestClock';
import {Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {CodeGraphEmbeddingWorkerProcess} from '@threadnote/graph/runtime_ports';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL} from '@threadnote/graph/vector/demand';
import {fcProp} from '@threadnote/testing/fast-check-property';
import * as FC from 'fast-check';
import {describe, expect, it} from '@effect/vitest';
import {codeGraphIndexVectorPolicy, resumeExistingCodeGraphEmbeddingDemand} from '@threadnote/graph/indexer';
import {codeGraphBuildRequestKey} from '@threadnote/graph/indexer/build';
import {codeGraphWatcherRefreshIndexRequest} from '@threadnote/graph/watcher';
import {codeGraphIsolatedBuilderSpawnPlan, isolatedBuilderRequestMatches} from '@threadnote/graph/isolated/builder';
import type {CodeGraphLanguagePackRegistryShape} from '@threadnote/graph/languages/registry';
import type {ObservedCodeGraphBuildStatus} from '@threadnote/graph/build_status';
import type {SystemInfoShape} from '@threadnote/platform/system';

const packs = {cacheIdentities: [], packs: []} as unknown as CodeGraphLanguagePackRegistryShape;
const identity = {
  checkoutId: 'a'.repeat(64),
  headCommit: 'b'.repeat(40),
  repositoryId: 'c'.repeat(64),
  worktreeId: 'd'.repeat(64),
};
const system = {
  executablePath: '/usr/local/bin/threadnote',
  processArguments: ['/usr/local/bin/threadnote', 'mcp-server'],
  environment: () => ({}),
  intendedChildEnvironment: () => ({}),
} as unknown as SystemInfoShape;

describe('graph vector completion policy', () => {
  it('retains bounded semantic state in the backwards-compatible CLI status JSON', () => {
    const semantic = {state: 'queued', snapshotId: `cgsn_${'e'.repeat(40)}`} as const;
    const serialized = serializeCodeGraphStatusV5({builds: [], waiters: []}, identity.worktreeId, 4, 4, {
      databasePath: '/graph.sqlite',
      identity: {
        ...identity,
        caseMode: 'sensitive',
        displayName: 'fixture',
        gitCommonDirectory: '/repo/.git',
        objectFormat: 'sha1',
        repoRoot: '/repo',
      },
      languagePacks: [],
      obsoleteStores: {bytes: 0, checkouts: [], fileCount: 0, unsafeEntryCount: 0},
      readySnapshot: null,
      semantic,
      stale: true,
      storage: {state: 'missing', checkoutId: identity.checkoutId, databasePath: '/graph.sqlite'},
    });
    expect(JSON.parse(serialized)).toMatchObject({type: 'code-graph-status', version: 5, semantic});
  });

  it('keeps explicit default wait and legacy opt-out authoritative', () => {
    expect(codeGraphIndexVectorPolicy({})).toBe('wait');
    expect(codeGraphIndexVectorPolicy({vectorPolicy: 'background'})).toBe('background');
    expect(codeGraphIndexVectorPolicy({vectorPolicy: 'background', ensureVectors: false})).toBe('off');
    expect(
      codeGraphIndexVectorPolicy(
        codeGraphWatcherRefreshIndexRequest({cwd: '/repo', key: 'worktree', threadnoteHome: '/home'}),
      ),
    ).toBe('background');
  });

  fcProp(
    it,
    'isolates every policy across dirty targets and active/completed receipts without mutating inputs',
    {
      dirty: FC.boolean(),
      fingerprint: FC.stringMatching(/^[0-9a-f]{32}$/),
    },
    ({dirty, fingerprint}) => {
      const overlay = Object.freeze({dirty, fingerprint});
      const keys = (['wait', 'background', 'off'] as const).map(policy =>
        codeGraphBuildRequestKey(identity, overlay, packs, undefined, policy, 'environment'),
      );
      expect(new Set(keys).size).toBe(3);
      for (const liveness of ['active', 'completed'] as const) {
        for (let receipt = 0; receipt < keys.length; receipt++) {
          const status = Object.freeze({
            observation: {liveness},
            request: {key: keys[receipt]},
          }) as ObservedCodeGraphBuildStatus;
          for (let requested = 0; requested < keys.length; requested++) {
            expect(isolatedBuilderRequestMatches(status, keys[requested])).toBe(requested === receipt);
          }
        }
      }
      expect(overlay).toEqual({dirty, fingerprint});
    },
    {fastCheck: {numRuns: 50}},
  );

  it('preserves legacy receipt keys and explicit off through a background child route', () => {
    const key = (policy: 'wait' | 'off' | boolean) =>
      codeGraphBuildRequestKey(identity, {dirty: false}, packs, undefined, policy, 'environment');
    expect(key(true)).toBe(key('wait'));
    expect(key(false)).toBe(key('off'));
    const plan = codeGraphIsolatedBuilderSpawnPlan(system, {
      cwd: '/repo',
      threadnoteHome: '/home',
      noVectors: true,
      vectorPolicy: 'background',
    });
    expect(plan.arguments).toContain('--no-vectors');
    expect(plan.arguments).not.toContain('--background-vectors');
  });

  it.each(['wait', 'background', 'off'] as const)('carries %s through scoped child arguments', vectorPolicy => {
    const plan = codeGraphIsolatedBuilderSpawnPlan(system, {
      cwd: '/linked/repo',
      threadnoteHome: '/home',
      vectorPolicy,
      project: 'graph-package',
      manifestPath: '/manifest.yaml',
      manifestRevision: 'revision',
      expectedScopeId: 'scope-key',
      scopeRoute: 'selected',
    });
    expect(plan.arguments.includes('--no-vectors')).toBe(vectorPolicy === 'off');
    expect(plan.arguments.includes('--background-vectors')).toBe(vectorPolicy === 'background');
    expect(plan.arguments).toContain('graph-package');
    expect(plan.environment.THREADNOTE_CODE_GRAPH_EXPECTED_MANIFEST_REVISION).toBe('revision');
    expect(plan.environment.THREADNOTE_CODE_GRAPH_EXPECTED_SCOPE_ID).toBe('scope-key');
  });
});

const startupFixture = (checkoutId: string, revision: number, queued: boolean, existingHome?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = existingHome ?? (yield* fs.makeTempDirectoryScoped({prefix: 'graph-startup-policy-'}));
    const layout = codeGraphLayout(path, home, checkoutId, 'b'.repeat(64));
    yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true});
    yield* Effect.sync(() => {
      const db = new Database(layout.databasePath);
      try {
        db.run('CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT)');
        db.run('INSERT INTO schema_metadata VALUES (?, ?)', ['persistent_extension_schema_revision', String(revision)]);
        if (revision === 19) {
          db.run(CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL);
          if (queued)
            db.run('INSERT INTO embedding_demand VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
              'b'.repeat(64),
              'full-repository',
              `cgsn_${'c'.repeat(40)}`,
              '2026-01-01T00:00:00.000Z',
              'queued',
              0,
              0,
              null,
              null,
              null,
            ]);
        }
      } finally {
        db.close();
      }
    });
    return {fs, home, layout};
  });

it.layer(BunServices.layer)(test => {
  test.effect('startup leaves old-schema no-demand catalogs unchanged and never wakes a worker', () =>
    Effect.gen(function* () {
      const fixture = yield* startupFixture('a'.repeat(64), 18, false);
      const before = yield* fixture.fs.readFile(fixture.layout.databasePath);
      let wakes = 0;
      const result = yield* resumeExistingCodeGraphEmbeddingDemand(fixture.home).pipe(
        Effect.provideService(CodeGraphEmbeddingWorkerProcess, {
          wake: () =>
            Effect.sync(() => {
              wakes++;
              return true;
            }),
        }),
      );
      expect(result).toBe(false);
      expect(wakes).toBe(0);
      expect(yield* fixture.fs.readFile(fixture.layout.databasePath)).toEqual(before);
      expect(yield* fixture.fs.readDirectory(fixture.layout.repositoryRoot)).toEqual([
        (yield* Path.Path).basename(fixture.layout.databasePath),
      ]);
    }),
  );

  test.effect('startup skips a blocked first catalog and wakes recorded demand in a later catalog', () =>
    Effect.gen(function* () {
      const first = yield* startupFixture('a'.repeat(64), 19, false);
      const next = yield* startupFixture('c'.repeat(64), 19, true, first.home);
      const entered = yield* Deferred.make<void>();
      let closes = 0;
      let wakes = 0;
      const fiber = yield* resumeExistingCodeGraphEmbeddingDemand(first.home, {
        beforeReadCatalog: databasePath =>
          databasePath === first.layout.databasePath
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        openDirectory: async () => ({
          readPage: async () => ({names: ['a'.repeat(64), 'c'.repeat(64)], done: true}),
          close: async () => {
            closes++;
          },
        }),
      }).pipe(
        Effect.provideService(CodeGraphEmbeddingWorkerProcess, {
          wake: home =>
            Effect.sync(() => {
              expect(home).toBe(next.home);
              wakes++;
              return true;
            }),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(201);
      expect(yield* Fiber.join(fiber)).toBe(true);
      expect(wakes).toBe(1);
      expect(closes).toBe(1);
    }),
  );

  test.effect('startup native SQLite lock wait is short and cannot hide later recorded demand', () =>
    Effect.gen(function* () {
      const first = yield* startupFixture('a'.repeat(64), 19, false);
      const next = yield* startupFixture('c'.repeat(64), 19, true, first.home);
      const before = yield* next.fs.readFile(next.layout.databasePath);
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn({
            cmd: [
              process.execPath,
              '--eval',
              [
                "import {Database} from 'bun:sqlite';",
                'const db = new Database(process.argv[1]);',
                "db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');",
                "process.stdout.write('locked\\n');",
                'setInterval(() => {}, 1000);',
              ].join('\n'),
              first.layout.databasePath,
            ],
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          }),
        ),
        child =>
          Effect.promise(async () => {
            if (child.exitCode === null) child.kill('SIGKILL');
            await child.exited;
          }),
      );
      const output = child.stdout.getReader();
      const acquired = yield* Effect.tryPromise(() => output.read());
      output.releaseLock();
      expect(new TextDecoder().decode(acquired.value)).toBe('locked\n');
      let closes = 0;
      let wakes = 0;
      const started = performance.now();
      const result = yield* resumeExistingCodeGraphEmbeddingDemand(first.home, {
        openDirectory: async () => ({
          readPage: async () => ({names: ['a'.repeat(64), 'c'.repeat(64)], done: true}),
          close: async () => {
            closes++;
          },
        }),
      }).pipe(
        Effect.provideService(CodeGraphEmbeddingWorkerProcess, {
          wake: home =>
            Effect.sync(() => {
              expect(home).toBe(next.home);
              wakes++;
              return true;
            }),
        }),
      );
      expect(result).toBe(true);
      expect(performance.now() - started).toBeLessThan(1500);
      expect(child.exitCode).toBeNull();
      expect(wakes).toBe(1);
      expect(closes).toBe(1);
      expect(yield* next.fs.readFile(next.layout.databasePath)).toEqual(before);
    }).pipe(TestClock.withLive),
  );

  for (const inaccessible of ['directory', 'invalid-sqlite'] as const) {
    test.effect(`startup skips an ${inaccessible} database path and closes its reader after later demand`, () =>
      Effect.gen(function* () {
        const first = yield* startupFixture('a'.repeat(64), 19, false);
        const next = yield* startupFixture('c'.repeat(64), 19, true, first.home);
        yield* first.fs.remove(first.layout.databasePath);
        if (inaccessible === 'directory') yield* first.fs.makeDirectory(first.layout.databasePath);
        else yield* first.fs.writeFileString(first.layout.databasePath, 'Invalid SQLite fixture.\n');
        const before = yield* next.fs.readFile(next.layout.databasePath);
        let closes = 0;
        let wakes = 0;
        const result = yield* resumeExistingCodeGraphEmbeddingDemand(first.home, {
          openDirectory: async () => ({
            readPage: async () => ({names: ['a'.repeat(64), 'c'.repeat(64)], done: true}),
            close: async () => {
              closes++;
            },
          }),
        }).pipe(
          Effect.provideService(CodeGraphEmbeddingWorkerProcess, {
            wake: home =>
              Effect.sync(() => {
                expect(home).toBe(next.home);
                wakes++;
                return true;
              }),
          }),
        );
        expect(result).toBe(true);
        expect(wakes).toBe(1);
        expect(closes).toBe(1);
        expect(yield* next.fs.readFile(next.layout.databasePath)).toEqual(before);
        if (inaccessible === 'directory') expect(yield* first.fs.readDirectory(first.layout.databasePath)).toEqual([]);
        else expect(yield* first.fs.readFileString(first.layout.databasePath)).toBe('Invalid SQLite fixture.\n');
      }),
    );
  }

  test.effect('runtime scope release interrupts startup discovery and closes its directory reader', () =>
    Effect.gen(function* () {
      const fixture = yield* startupFixture('a'.repeat(64), 19, false);
      const entered = yield* Deferred.make<void>();
      let closes = 0;
      let wakes = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* resumeExistingCodeGraphEmbeddingDemand(fixture.home, {
            beforeReadCatalog: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            openDirectory: async () => ({
              readPage: async () => ({names: ['a'.repeat(64)], done: true}),
              close: async () => {
                closes++;
              },
            }),
          }).pipe(
            Effect.provideService(CodeGraphEmbeddingWorkerProcess, {
              wake: () =>
                Effect.sync(() => {
                  wakes++;
                  return true;
                }),
            }),
            Effect.forkScoped,
          );
          yield* Deferred.await(entered);
        }),
      );
      expect(closes).toBe(1);
      expect(wakes).toBe(0);
    }),
  );
});

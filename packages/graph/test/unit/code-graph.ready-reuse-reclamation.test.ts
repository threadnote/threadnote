import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Option, Path} from 'effect';
import * as Crypto from 'effect/Crypto';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import type {CodeGraphEmbeddingIndexShape} from '@threadnote/graph/embedding';
import type {DirectPersistentCapacityProtection} from '@threadnote/graph/indexer/types';
import type {CodeGraphMaintenanceCoordinatorShape} from '@threadnote/graph/maintenance/coordinator';
import {buildOwnedCleanSnapshot} from '@threadnote/graph/indexer/build';
import {extractorSetIdentity, graphContentIdentity} from '@threadnote/graph/indexer/materialization';
import type {CodeGraphLanguagePackRegistryShape} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {retireIncompleteWorktreeSnapshots} from '@threadnote/graph/store/persistent_build';
import {initializeSchema} from '@threadnote/graph/store/schema/initialization';
import {useDatabaseDirect} from '@threadnote/graph/store/session';
import {CodeGraphStoreError, type CodeGraphSnapshot, type RepositoryIdentity} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const RETIRED_ID = 'retired-fixture';
const STOPPED = CodeGraphStoreError.of('stop at new snapshot boundary');
const unusedEmbedding: CodeGraphEmbeddingIndexShape = {
  check: () => Effect.succeed({modelId: 'fixture', reused: 0, state: 'ready'}),
  ensure: () => Effect.die('unexpected embedding ensure'),
  search: () => Effect.die('unexpected embedding search'),
};
const testSystem = SystemInfo.of({
  architecture: 'x64',
  availableDiskBytes: () => Effect.die('unexpected disk capacity query'),
  currentDirectory: () => process.cwd(),
  environment: () => process.env,
  developmentEntrypoint: '/test/threadnote.ts',
  intendedChildEnvironment: environment => environment,
  executablePath: process.execPath,
  homeDirectory: process.env.HOME ?? '/tmp',
  hardwareInfo: Effect.succeed({cpuModel: 'test', memoryBytes: 1, effectiveMemoryBytes: 1, operatingSystem: 'test'}),
  isProcessRunning: processId => processId === process.pid,
  memoryUsage: () => ({external: 0, heapUsed: 0, rss: 0}),
  processStartIdentity: () => Effect.as(Effect.void, undefined),
  runtimeVersion: Bun.version,
  pathDelimiter: process.platform === 'win32' ? ';' : ':',
  platform: process.platform,
  processId: process.pid,
  processArguments: process.argv,
  readLine: () => () => undefined,
  signalProcess: () => undefined,
  setExitCode: () => undefined,
  setEnvironmentVariable: () => undefined,
  stdinIsTTY: false,
  stdoutIsTTY: false,
  tempDirectory: '/tmp',
  userName: 'fixture',
});
const TestLayer = Layer.mergeAll(
  BunServices.layer,
  Layer.succeed(
    CommandExecutor,
    CommandExecutor.of({
      execute: () => Effect.die('unexpected command execution'),
      executeStreaming: () => Effect.die('unexpected command execution'),
    }),
  ),
  Layer.succeed(SystemInfo, testSystem),
);

describe('ready snapshot reuse reclamation', () => {
  effectIt.layer(TestLayer)(it => {
    for (const route of ['exact-ready', 'commit-ready'] as const) {
      it.effect(`reuses ${route} after one cleanup page without waiting for the retired payload`, () =>
        withFixture(15_001, fixture =>
          Effect.gen(function* () {
            const result = yield* buildOwnedCleanSnapshot(fixture.input(route));
            expect(result.materialization).toMatchObject({mode: 'reused-snapshot', stagedFiles: 0});
            expect(result.snapshot.id).toBe(fixture.ready.id);
            expect(fixture.cleanupModes).toEqual(['deferred']);
            expect(yield* fixture.remainingRows).toBe(10_001);
            expect(fixture.writes).toEqual([]);
          }),
        ),
      );
    }

    it.effect('stops ready promotion when bounded cleanup fails', () =>
      withFixture(15_001, fixture =>
        Effect.gen(function* () {
          const failure = yield* buildOwnedCleanSnapshot({
            ...fixture.input('exact-ready'),
            existing: undefined,
            reclaimSnapshots: () => Effect.fail(STOPPED),
          }).pipe(Effect.flip);
          expect(failure).toBe(STOPPED);
          expect(yield* fixture.remainingRows).toBe(15_001);
          expect(fixture.writes).toEqual([]);
        }),
      ),
    );

    it.effect('drains debt before looking up a graph-proportional clean alias or incremental candidate', () =>
      withFixture(15_001, fixture =>
        Effect.gen(function* () {
          const input = fixture.input('materialize');
          const failure = yield* buildOwnedCleanSnapshot({
            ...input,
            existing: {...fixture.ready, dirty: true, overlayFingerprint: 'dirty-root'},
            inventory: {
              ...input.inventory,
              workspace: {diagnostics: [], fingerprint: 'workspace', projects: [], workspaces: []},
            },
            store: {
              ...input.store,
              activateCleanSnapshotAlias: () => Effect.die('alias publication must follow the candidate guard'),
              reusableOverlayBase: () =>
                fixture.remainingRows.pipe(
                  Effect.mapError(() => CodeGraphStoreError.of('Unable to observe fixture cleanup rows.')),
                  Effect.tap(rows => Effect.sync(() => expect(rows).toBe(0))),
                  Effect.andThen(Effect.fail(STOPPED)),
                ),
            },
          }).pipe(Effect.flip);
          expect(failure).toBe(STOPPED);
          expect(fixture.cleanupModes).toEqual(['required']);
          expect(fixture.writes).toEqual([]);
        }),
      ),
    );

    fcEffectProp(
      it,
      'repeated ready reuse decreases finite debt and the next materialization drains the remainder',
      {rows: fc.integer({min: 5_001, max: 25_001}), reuses: fc.integer({min: 1, max: 3}), force: fc.boolean()},
      ({rows, reuses, force}) =>
        withFixture(rows, fixture =>
          Effect.gen(function* () {
            let remaining = rows;
            for (let index = 0; index < reuses; index += 1) {
              yield* buildOwnedCleanSnapshot(fixture.input('exact-ready'));
              const next = yield* fixture.remainingRows;
              expect(next).toBeLessThan(remaining || 1);
              expect(next).toBeGreaterThanOrEqual(Math.max(0, remaining - 5_000));
              remaining = next;
            }
            const failure = yield* buildOwnedCleanSnapshot({
              ...fixture.input('materialize'),
              force,
            }).pipe(Effect.flip);
            expect(failure).toBe(STOPPED);
            expect(yield* fixture.remainingRows).toBe(0);
            expect(fixture.cleanupModes).toEqual([...Array.from({length: reuses}, () => 'deferred'), 'required']);
            expect(fixture.writes).toEqual(['claim']);
          }),
        ),
      {fastCheck: {numRuns: 8}},
    );
  });
});

function withFixture<A, E, R>(rows: number, use: (fixture: Fixture) => Effect.Effect<A, E, R>) {
  return useDatabaseDirect(
    ':memory:',
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const crypto = yield* Crypto.Crypto;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ready-reclaim-'});
      const identity: RepositoryIdentity = {
        caseMode: 'sensitive',
        checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
        displayName: 'fixture',
        gitCommonDirectory: path.join(home, '.git'),
        headCommit: Effect2.pipe('b', EffectString.repeat(40)),
        objectFormat: 'sha1',
        repoRoot: home,
        repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
        worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
      };
      const languagePacks: CodeGraphLanguagePackRegistryShape = {
        activeCacheIdentities: () => [],
        activeDerivationIdentities: () => [],
        activePackProvenance: () => [],
        cacheIdentities: [],
        cacheIdentityForPath: () => Option.none(),
        discoverWorkspace: () =>
          Effect.succeed({diagnostics: [], fingerprint: 'workspace', projects: [], workspaces: []}),
        extractFile: () => Effect.die('unexpected language extraction'),
        extractRawFile: () => Effect.die('unexpected raw language extraction'),
        isResolutionContext: () => false,
        match: () => Option.none(),
        postprocessFile: (_file, facts) => facts,
        packs: [],
      };
      const extractorSet = extractorSetIdentity([], languagePacks);
      const ready: CodeGraphSnapshot = {
        commit: identity.headCommit,
        dirty: false,
        edgeCount: 1,
        extractorSet,
        fileCount: 1,
        graphContentId: graphContentIdentity(extractorSet, []),
        id: `cgsn_${Effect2.pipe('e', EffectString.repeat(40))}`,
        repositoryId: identity.repositoryId,
        state: 'ready',
        symbolCount: 2,
        worktreeId: identity.worktreeId,
      };
      yield* initializeSchema(sql);
      yield* sql.unsafe(
        "INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at) VALUES (?, 'fixture', 'sha1', '', '')",
        [identity.repositoryId],
      );
      yield* sql.unsafe(
        `INSERT INTO snapshots (id, repository_id, worktree_id, commit_id, extractor_set, dirty, state, file_count, symbol_count, edge_count, started_at)
        VALUES (?, ?, ?, 'commit', 'extractor', 0, 'retired', 0, 0, 0, '')`,
        [RETIRED_ID, identity.repositoryId, identity.worktreeId],
      );
      yield* sql.unsafe(
        `WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < ?)
        INSERT INTO snapshot_file_deletions (snapshot_id, path) SELECT ?, printf('file-%08d', n) FROM rows`,
        [rows, RETIRED_ID],
      );
      const remainingRows = sql
        .unsafe<{readonly count: number}>(
          'SELECT COUNT(*) AS count FROM snapshot_file_deletions WHERE snapshot_id = ?',
          [RETIRED_ID],
        )
        .pipe(Effect.map(result => result[0].count));
      const cleanupModes: string[] = [];
      const writes: string[] = [];
      const capacityProtection: DirectPersistentCapacityProtection = {
        availableDiskBytes: () => Effect.die('unexpected disk capacity query'),
        crypto,
        maintenance: {
          kickOrdinary: () => Effect.die('unexpected ordinary maintenance'),
          kickReconciliation: () => Effect.die('unexpected reconciliation maintenance'),
          kickResidual: () => Effect.die('unexpected residual maintenance'),
          request: () => Effect.die('unexpected maintenance request'),
          tick: () => Effect.die('unexpected maintenance tick'),
        } satisfies CodeGraphMaintenanceCoordinatorShape,
        path,
        system: testSystem,
        temporaryDirectory: '/tmp',
        walAutoCheckpointPages: 1,
      };
      const fixture = {
        ready,
        remainingRows,
        cleanupModes,
        writes,
        input: (route: 'exact-ready' | 'commit-ready' | 'materialize') => ({
          buildOwner: {buildId: 'fixture-build', processId: process.pid},
          capacityProtection,
          embedding: unusedEmbedding,
          ensureVectors: false,
          existing: ready,
          fallbackSnapshotId: `cgsn_${Effect2.pipe('f', EffectString.repeat(40))}`,
          force: false,
          fs,
          identity,
          inventory: {committedFiles: [], committedParsedFiles: 0, dirty: false, files: [], parsedFiles: 0, skipped: 0},
          languagePacks,
          layout: codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId),
          logicalSnapshotId: ready.id,
          reclaimSnapshots: (mode: 'deferred' | 'required') =>
            Effect.sync(() => {
              cleanupModes.push(mode);
            }).pipe(
              Effect.andThen(
                retireIncompleteWorktreeSnapshots(
                  identity.repositoryId,
                  identity.worktreeId,
                  new Set(),
                  undefined,
                  undefined,
                  mode,
                ),
              ),
              Effect.asVoid,
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          startedAt: 0,
          store: {
            currentLexicalReadySnapshotById: () => Effect.succeed(route === 'exact-ready' ? ready : undefined),
            readySnapshotForCommit: () => Effect.succeed(route === 'commit-ready' ? ready : undefined),
            resumableForcedBuild: () => Effect.void,
            claimPersistentBuild: () =>
              remainingRows.pipe(
                Effect.tap(remaining =>
                  Effect.sync(() => {
                    expect(remaining).toBe(0);
                    writes.push('claim');
                  }),
                ),
                Effect.andThen(Effect.fail(STOPPED)),
              ),
          },
          threadnoteHome: home,
        }),
      };
      // @ts-expect-error -- This fixture intentionally implements only the store calls consumed by these test paths.
      return yield* use(fixture);
    }),
  );
}

type Fixture = {
  readonly ready: CodeGraphSnapshot;
  readonly remainingRows: Effect.Effect<number, unknown>;
  readonly cleanupModes: string[];
  readonly writes: string[];
  readonly input: (
    route: 'exact-ready' | 'commit-ready' | 'materialize',
  ) => Parameters<typeof buildOwnedCleanSnapshot>[0];
};

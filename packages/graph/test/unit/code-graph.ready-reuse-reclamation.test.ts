import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import {buildOwnedCleanSnapshot} from '@threadnote/graph/indexer/build';
import {extractorSetIdentity, graphContentIdentity} from '@threadnote/graph/indexer/materialization';
import type {CodeGraphLanguagePackRegistryShape} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import type {CodeGraphStoreShape} from '@threadnote/graph/store';
import {retireIncompleteWorktreeSnapshots} from '@threadnote/graph/store/persistent_build';
import {initializeSchema} from '@threadnote/graph/store/schema/initialization';
import {useDatabaseDirect} from '@threadnote/graph/store/session';
import type {CodeGraphSnapshot, RepositoryIdentity} from '@threadnote/graph/types';

const RETIRED_ID = 'retired-fixture';
const STOPPED = new Error('stop at new snapshot boundary');
const TestLayer = Layer.mergeAll(
  BunServices.layer,
  Layer.succeed(CommandExecutor, {execute: () => Effect.die('unexpected command execution')} as never),
  Layer.succeed(SystemInfo, {
    processId: process.pid,
    processStartIdentity: () => Effect.void,
  } as never),
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
                  Effect.tap(rows => Effect.sync(() => expect(rows).toBe(0))),
                  Effect.andThen(Effect.fail(STOPPED)),
                ),
            } as unknown as CodeGraphStoreShape,
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
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ready-reclaim-'});
      const identity: RepositoryIdentity = {
        caseMode: 'sensitive',
        checkoutId: 'a'.repeat(64),
        displayName: 'fixture',
        gitCommonDirectory: path.join(home, '.git'),
        headCommit: 'b'.repeat(40),
        objectFormat: 'sha1',
        repoRoot: home,
        repositoryId: 'c'.repeat(64),
        worktreeId: 'd'.repeat(64),
      };
      const languagePacks = {
        activeCacheIdentities: () => [],
        activeDerivationIdentities: () => [],
        discoverWorkspace: () =>
          Effect.succeed({diagnostics: [], fingerprint: 'workspace', projects: [], workspaces: []}),
      } as unknown as CodeGraphLanguagePackRegistryShape;
      const extractorSet = extractorSetIdentity([], languagePacks);
      const ready: CodeGraphSnapshot = {
        commit: identity.headCommit,
        dirty: false,
        edgeCount: 1,
        extractorSet,
        fileCount: 1,
        graphContentId: graphContentIdentity(extractorSet, []),
        id: `cgsn_${'e'.repeat(40)}`,
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
      const fixture = {
        ready,
        remainingRows,
        cleanupModes,
        writes,
        input: (route: 'exact-ready' | 'commit-ready' | 'materialize') => ({
          buildOwner: {processId: process.pid} as never,
          capacityProtection: {} as never,
          embedding: {check: () => Effect.succeed({state: 'ready'})} as never,
          ensureVectors: false,
          existing: ready,
          fallbackSnapshotId: `cgsn_${'f'.repeat(40)}`,
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
          } as unknown as CodeGraphStoreShape,
          threadnoteHome: home,
        }),
      };
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

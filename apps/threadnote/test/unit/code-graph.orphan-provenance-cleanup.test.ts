import {TestError} from '@threadnote/testing/test-error';
import {Array as EffectArray, Predicate} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {Effect, FileSystem, Layer, Path, Ref} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {afterEach, describe, expect} from 'vitest';
import type {CodeGraphWorktreeReconciliationAuthorityObservation} from '@threadnote/graph/git/worktree/registration';
import {
  recordVerifiedCodeGraphLocalAssociation,
  type CodeGraphWorktreeReconciliationEvidenceCandidate,
} from '@threadnote/graph/local_provenance';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {
  makeCodeGraphLifecycleOpportunityRunner,
  type CodeGraphLifecycleOpportunityTarget,
} from '@threadnote/graph/lifecycle/opportunity';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {
  CODE_GRAPH_ORPHAN_PROVENANCE_CANDIDATE_LIMIT,
  CODE_GRAPH_ORPHAN_PROVENANCE_CURSOR_RECOVERY_DIAGNOSTIC,
  makeCodeGraphOrphanProvenanceCleaner,
  type CodeGraphOrphanProvenanceCleanupDependencies,
} from '@threadnote/graph/orphan_provenance_cleanup';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import {REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS} from '@threadnote/graph/store/schema/metadata';
import {CODE_GRAPH_EXTRACTOR_GENERATION, type RepositoryIdentity} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
const repositoryId = Effect2.pipe('b', EffectString.repeat(64));
const anchorWorktreeId = Effect2.pipe('c', EffectString.repeat(64));
const targetWorktreeId = Effect2.pipe('d', EffectString.repeat(64));
const registryRootIdentity = Effect2.pipe('e', EffectString.repeat(64));
const privateRoot = '/private/threadnote/orphan-provenance-test';
const temporaryRoots: string[] = [];
const storeLayer = CodeGraphStore.layer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);
const maintenanceLayer = CodeGraphMaintenanceCoordinator.layer.pipe(
  Layer.provideMerge(Layer.merge(CodeGraphStore.layer, TestCommandExecutorLayer)),
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

const anchor: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId,
  displayName: 'threadnote/orphan-provenance-test',
  gitCommonDirectory: `${privateRoot}/.git`,
  headCommit: Effect2.pipe('1', EffectString.repeat(40)),
  objectFormat: 'sha1',
  repositoryId,
  repoRoot: privateRoot,
  worktreeId: anchorWorktreeId,
};

const linkedEvidence: Extract<CodeGraphWorktreeReconciliationEvidenceCandidate, {readonly state: 'candidate'}> = {
  canonicalWorktreePath: `${privateRoot}/removed-linked-worktree`,
  checkoutId,
  evidenceToken: Effect2.pipe('2', EffectString.repeat(64)),
  recordDigest: Effect2.pipe('3', EffectString.repeat(64)),
  recordIdentity: Effect2.pipe('4', EffectString.repeat(64)),
  registration: {adminNameKeys: [Effect2.pipe('5', EffectString.repeat(64))], kind: 'linked'},
  repositoryId,
  state: 'candidate',
  worktreeId: targetWorktreeId,
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('automatic orphan provenance cleanup', () => {
  effectIt.effect('does not resolve a path anchor before bounded orphan admission finds a candidate', () =>
    Effect.gen(function* () {
      const cases = [
        {
          claimCandidates: () => Effect.die('claim should not run for an empty inventory'),
          inspectInventory: () => Effect.succeed({state: 'ready', worktreeIds: []} as const),
        },
        {
          claimCandidates: () => Effect.succeed({worktreeIds: []}),
          inspectInventory: () => Effect.succeed({state: 'ready', worktreeIds: [targetWorktreeId]} as const),
        },
      ] as const;

      for (const testCase of cases) {
        const anchorResolutions = yield* Ref.make(0);
        const dependencies = successfulDependencies({
          claimCandidates: testCase.claimCandidates,
          inspectInventory: testCase.inspectInventory,
          resolveAnchor: () => Ref.update(anchorResolutions, count => count + 1).pipe(Effect.as(anchor)),
        });
        const cleaner = yield* makeCodeGraphOrphanProvenanceCleaner(dependencies);
        const result = yield* cleaner.tick(pathAnchorTick());

        expect(result).toEqual({reason: 'no-candidates', state: 'preserved'});
        expect(yield* Ref.get(anchorResolutions)).toBe(0);
      }
    }),
  );

  fcEffectProp(
    effectIt,
    'removes only when every generated authority predicate remains exact and no active view exists',
    {
      activeView: fc.boolean(),
      anchorStable: fc.boolean(),
      evidenceStable: fc.boolean(),
      finalAbsent: fc.boolean(),
      initialAbsent: fc.boolean(),
      maintenanceInactive: fc.boolean(),
      missingPath: fc.boolean(),
      registryRootStable: fc.boolean(),
    },
    predicates =>
      Effect.gen(function* () {
        const cleanups = yield* Ref.make(0);
        let authorityReads = 0;
        let evidenceReads = 0;
        let anchorReads = 0;
        const dependencies = successfulDependencies({
          cleanupProvenance: () => Ref.update(cleanups, count => count + 1).pipe(Effect.as({state: 'removed'})),
          maintenanceIntentActive: () => Effect.succeed(!predicates.maintenanceInactive),
          observeAuthority: () =>
            Effect.sync(() => {
              authorityReads += 1;
              const initial = authorityReads === 1;
              return completeAuthority({
                missing: predicates.missingPath,
                registryAbsent: initial ? predicates.initialAbsent : predicates.finalAbsent,
                registryRootIdentity:
                  !initial && !predicates.registryRootStable
                    ? Effect2.pipe('f', EffectString.repeat(64))
                    : registryRootIdentity,
              });
            }),
          observeView: () =>
            Effect.succeed(
              predicates.activeView
                ? ({snapshotId: `cgsn_${Effect2.pipe('6', EffectString.repeat(40))}`, state: 'active'} as const)
                : ({state: 'absent'} as const),
            ),
          readEvidenceCandidate: () =>
            Effect.sync(() => {
              evidenceReads += 1;
              return evidenceReads > 1 && !predicates.evidenceStable
                ? {...linkedEvidence, recordDigest: Effect2.pipe('7', EffectString.repeat(64))}
                : linkedEvidence;
            }),
          resolveAnchor: () =>
            Effect.sync(() => {
              anchorReads += 1;
              return anchorReads > 1 && !predicates.anchorStable
                ? {...anchor, repositoryId: Effect2.pipe('8', EffectString.repeat(64))}
                : anchor;
            }),
        });

        const result = yield* (yield* makeCodeGraphOrphanProvenanceCleaner(dependencies)).tick(tick());
        const expectedRemoval =
          !predicates.activeView &&
          predicates.anchorStable &&
          predicates.evidenceStable &&
          predicates.finalAbsent &&
          predicates.initialAbsent &&
          predicates.maintenanceInactive &&
          predicates.missingPath &&
          predicates.registryRootStable;

        expect(result.state === 'removed').toBe(expectedRemoval);
        expect(yield* Ref.get(cleanups)).toBe(expectedRemoval ? 1 : 0);
      }),
  );

  effectIt.effect('keeps a durable bounded cursor and excludes an active view from sidecar candidates', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-orphan-provenance-cursor-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const worktreeIds = Array.from({length: 70}, (_, index) =>
          Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
        );
        const activeWorktreeId = worktreeIds.at(-1);
        if (activeWorktreeId === undefined) throw new Error('Expected the active fixture worktree.');
        yield* Effect.sync(() => seedActiveView(databasePath, activeWorktreeId));

        const pages = yield* Effect.all(
          Array.from({length: 3}, () =>
            store.claimOrphanProvenanceCandidates(
              databasePath,
              worktreeIds,
              CODE_GRAPH_ORPHAN_PROVENANCE_CANDIDATE_LIMIT,
              {waitTimeoutMilliseconds: 5_000},
            ),
          ),
          {concurrency: 1},
        );
        const claimed = new Set(EffectArray.flatMap(pages, page => page.worktreeIds));
        expect(EffectArray.map(pages, page => page.worktreeIds.length)).toEqual([32, 32, 32]);
        expect(claimed.size).toBe(69);
        expect(claimed.has(activeWorktreeId)).toBe(false);
        expect(yield* store.observeOrphanProvenanceView(databasePath, activeWorktreeId)).toMatchObject({
          state: 'active',
        });
        expect(yield* store.observeOrphanProvenanceView(databasePath, worktreeIds[0])).toEqual({state: 'absent'});

        const malformed = yield* Effect.sync(() => writeOrphanCursor(databasePath, 'malformed')).pipe(
          Effect.andThen(store.claimOrphanProvenanceCandidates(databasePath, worktreeIds, 1).pipe(Effect.exit)),
        );
        expect(malformed._tag).toBe('Success');
        if (malformed._tag === 'Success') {
          expect(malformed.value).toEqual({
            cursorRecovery: 'invalid-format',
            worktreeIds: [worktreeIds[0]],
          });
        }
        expect(readOrphanCursor(databasePath)).toBe(worktreeIds[0]);

        const resumed = yield* store.claimOrphanProvenanceCandidates(databasePath, worktreeIds, 1);
        expect(resumed).toEqual({worktreeIds: [worktreeIds[1]]});

        yield* Effect.sync(() => writeOrphanCursor(databasePath, Effect2.pipe('x', EffectString.repeat(65))));
        const structurallyInvalid = yield* store
          .claimOrphanProvenanceCandidates(databasePath, worktreeIds, 1)
          .pipe(Effect.exit);
        expect(structurallyInvalid._tag).toBe('Failure');
        expect(readOrphanCursor(databasePath)).toBe(Effect2.pipe('x', EffectString.repeat(65)));

        yield* Effect.sync(() => writeOrphanCursor(databasePath, 'malformed'));
        const allActive = yield* store.claimOrphanProvenanceCandidates(databasePath, [activeWorktreeId], 1);
        expect(allActive).toEqual({cursorRecovery: 'invalid-format', worktreeIds: []});
        expect(readOrphanCursor(databasePath)).toBeUndefined();

        const ambiguousBefore = yield* Effect.sync(() => {
          writeSchemaMetadata(databasePath, 'ORPHAN_PROVENANCE_CURSOR', 'malformed');
          return readSchemaMetadata(databasePath);
        });
        const ambiguous = yield* store.claimOrphanProvenanceCandidates(databasePath, worktreeIds, 1).pipe(Effect.exit);
        expect(ambiguous._tag).toBe('Failure');
        expect(readSchemaMetadata(databasePath)).toEqual(ambiguousBefore);
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  fcEffectProp(
    effectIt,
    'recovers every bounded noncanonical cursor without changing candidate membership',
    {
      // Keep 24 independently generated cursor values while amortizing schema setup
      // across three values whose cursor row is explicitly reset before each check.
      malformedCursors: fc.array(
        fc
          .string({maxLength: 64})
          .filter(value => new TextEncoder().encode(value).byteLength <= 64 && !/^[0-9a-f]{64}$/u.test(value)),
        {maxLength: 3, minLength: 3},
      ),
    },
    ({malformedCursors}) =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-orphan-cursor-property-'});
            const databasePath = join(root, 'repositories', checkoutId, 'graph-v3.sqlite');
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            const worktreeIds = Array.from({length: 4}, (_, index) =>
              Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
            );
            yield* Effect.sync(() => seedActiveView(databasePath, worktreeIds[3]));

            for (const malformedCursor of malformedCursors) {
              yield* Effect.sync(() => writeOrphanCursor(databasePath, malformedCursor));
              const recovered = yield* store.claimOrphanProvenanceCandidates(databasePath, worktreeIds, 2);
              expect(recovered).toEqual({
                cursorRecovery: 'invalid-format',
                worktreeIds: [worktreeIds[0], worktreeIds[1]],
              });
              expect(readOrphanCursor(databasePath)).toBe(worktreeIds[1]);

              const resumed = yield* store.claimOrphanProvenanceCandidates(databasePath, worktreeIds, 2);
              expect(resumed).toEqual({worktreeIds: [worktreeIds[2], worktreeIds[0]]});
              expect(new Set([...recovered.worktreeIds, ...resumed.worktreeIds])).toEqual(
                new Set(worktreeIds.slice(0, 3)),
              );
            }
          }),
        ).pipe(provideTestLayer(storeLayer)),
      ),
    {fastCheck: {numRuns: 8}},
  );

  effectIt.effect('fails closed before a missing cursor can exceed bounded metadata capacity', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        for (const withRemovedViewCursor of [false, true]) {
          const root = mkdtempSync(join(tmpdir(), 'threadnote-orphan-provenance-capacity-'));
          temporaryRoots.push(root);
          const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
          yield* store.initialize(databasePath);
          if (withRemovedViewCursor) {
            yield* Effect.sync(() =>
              upsertSchemaMetadata(
                databasePath,
                'removed_view_cleanup_admission_cursor',
                Effect2.pipe('f', EffectString.repeat(64)),
              ),
            );
          }
          const before = yield* Effect.sync(() => fillOrphanCursorMetadataCapacity(databasePath));

          const claimed = yield* store
            .claimOrphanProvenanceCandidates(databasePath, [Effect2.pipe('0', EffectString.repeat(64))], 1)
            .pipe(Effect.exit);

          expect(claimed._tag).toBe('Failure');
          expect(readSchemaMetadata(databasePath)).toEqual(before);
          expect(readOrphanCursor(databasePath)).toBeUndefined();
          expect(before).toHaveLength(
            withRemovedViewCursor
              ? REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS
              : REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - 1,
          );
        }
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('advances later-database orphan cleanup across fresh explicit diagnostics runners', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'threadnote-orphan-provenance-multi-')));
        temporaryRoots.push(root);
        const home = join(root, 'threadnote-home');
        const fixtures = yield* Effect.forEach(
          ['first', 'second'],
          name => createLiveOrphanRepositoryFixture(root, home, name),
          {concurrency: 1},
        );
        const [earlier, later] = [...fixtures].sort((left, right) =>
          Effect2.pipe(left.mainIdentity.checkoutId, EffectString.localeCompare(right.mainIdentity.checkoutId)),
        );
        expect(earlier).toBeDefined();
        expect(later).toBeDefined();
        yield* Effect.sync(() => {
          execFileSync('git', ['-C', later.main, 'worktree', 'remove', later.linked], {encoding: 'utf8'});
          writeOrphanCursor(later.databasePath, 'malformed-cursor');
        });
        const maintenance = yield* CodeGraphMaintenanceCoordinator;
        const targets: readonly CodeGraphLifecycleOpportunityTarget[] = EffectArray.map([earlier, later], fixture => ({
          anchorIdentity: fixture.mainIdentity,
          checkoutId: fixture.mainIdentity.checkoutId,
          databasePath: fixture.databasePath,
        }));

        const first = yield* makeCodeGraphLifecycleOpportunityRunner()({
          maintenance,
          opportunity: 'diagnostics',
          targets,
          threadnoteHome: home,
        });
        const second = yield* makeCodeGraphLifecycleOpportunityRunner()({
          maintenance,
          opportunity: 'diagnostics',
          targets,
          threadnoteHome: home,
        });
        const parsedCursor: unknown = JSON.parse(
          readFileSync(
            join(home, 'locks', 'indexes', 'code-graph', 'lifecycle-opportunities', 'diagnostics.cursor-v1.json'),
            'utf8',
          ),
        );
        if (!Predicate.isObject(parsedCursor)) throw new Error('Persisted lifecycle cursor must be an object.');
        const persistedCursor = parsedCursor;
        expect(persistedCursor).toMatchObject({
          checkoutId: later.mainIdentity.checkoutId,
          lane: 'reconciliation',
        });

        if (first.state === 'completed') {
          expect(first).toMatchObject({
            checkoutId: earlier.mainIdentity.checkoutId,
            result: {cleanup: 'none'},
          });
        } else {
          expect(first).toEqual({opportunity: 'diagnostics', reason: 'deadline', state: 'deferred'});
        }

        if (second.state === 'completed') {
          expect(second).toMatchObject({
            checkoutId: later.mainIdentity.checkoutId,
            result: {
              cleanup: 'orphan-provenance',
              diagnostics: [CODE_GRAPH_ORPHAN_PROVENANCE_CURSOR_RECOVERY_DIAGNOSTIC],
            },
          });
        } else {
          expect(second).toEqual({opportunity: 'diagnostics', reason: 'deadline', state: 'deferred'});
          if (existsSync(later.sidecar)) {
            // The foreground deadline is a valid production result. Finish the same live lane
            // directly so this test verifies cleanup correctness without stretching that guard.
            const cursorBeforeRetry = readOrphanCursor(later.databasePath);
            const completed = yield* maintenance.kickReconciliation({
              allowIndexPreparation: true,
              anchorIdentity: later.mainIdentity,
              automaticTail: false,
              checkoutId: later.mainIdentity.checkoutId,
              databasePath: later.databasePath,
              joinActive: false,
              threadnoteHome: home,
              writerLockPath: later.layout.databaseWriteLockPath,
            });
            expect(completed).toMatchObject({cleanup: 'orphan-provenance', state: 'completed'});
            if (cursorBeforeRetry === 'malformed-cursor') {
              expect(completed).toMatchObject({
                diagnostics: [CODE_GRAPH_ORPHAN_PROVENANCE_CURSOR_RECOVERY_DIAGNOSTIC],
              });
            }
          }
        }
        expect(existsSync(earlier.sidecar)).toBe(true);
        expect(existsSync(later.sidecar)).toBe(false);
        expect(readOrphanCursor(later.databasePath)).not.toBe('malformed-cursor');
        expect(readFileSync(later.mainFile, 'utf8')).toBe('main source\n');
        const serialized = JSON.stringify([first, second]);
        expect(serialized).not.toContain(root);
        expect(serialized).not.toContain('malformed-cursor');
      }).pipe(provideTestLayer(maintenanceLayer)),
    ),
  );

  effectIt.effect('removes a real deleted linked-worktree sidecar through routine maintenance', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* createLiveOrphanFixture;
        const maintenance = yield* CodeGraphMaintenanceCoordinator;
        expect(readGraphRowCounts(fixture.databasePath)).toEqual({
          activeSnapshots: 0,
          cleanupRows: 0,
          snapshots: 0,
        });

        yield* Effect.sync(() =>
          execFileSync('git', ['-C', fixture.main, 'worktree', 'remove', fixture.linked], {encoding: 'utf8'}),
        );
        const input = {
          anchorIdentity: fixture.mainIdentity,
          automaticTail: false as const,
          checkoutId: fixture.mainIdentity.checkoutId,
          databasePath: fixture.databasePath,
          threadnoteHome: fixture.home,
          writerLockPath: fixture.layout.databaseWriteLockPath,
        };
        const results = yield* Effect.forEach(Array.from({length: 3}), () => maintenance.tick(input), {
          concurrency: 1,
        });

        expect(results).toContainEqual({
          cleanup: 'orphan-provenance',
          expiredLeases: 0,
          remaining: true,
          retiredSnapshots: 0,
          rowsDeleted: 0,
          state: 'completed',
        });
        expect(existsSync(fixture.sidecar)).toBe(false);
        expect(readFileSync(fixture.mainFile, 'utf8')).toBe('main source\n');
        expect(readGraphRowCounts(fixture.databasePath)).toEqual({
          activeSnapshots: 0,
          cleanupRows: 0,
          snapshots: 0,
        });
        expect(JSON.stringify(results)).not.toContain(fixture.root);
      }).pipe(provideTestLayer(maintenanceLayer)),
    ),
  );
});

function successfulDependencies(
  overrides: Partial<CodeGraphOrphanProvenanceCleanupDependencies> = {},
): CodeGraphOrphanProvenanceCleanupDependencies {
  return {
    claimCandidates: () => Effect.succeed({worktreeIds: [targetWorktreeId]}),
    cleanupProvenance: () => Effect.succeed({state: 'removed'}),
    inspectInventory: () => Effect.succeed({state: 'ready', worktreeIds: [targetWorktreeId]}),
    maintenanceIntentActive: () => Effect.succeed(false),
    observeAuthority: () => Effect.succeed(completeAuthority()),
    observeView: () => Effect.succeed({state: 'absent'}),
    readEvidenceCandidate: () => Effect.succeed(linkedEvidence),
    resolveAnchor: () => Effect.succeed(anchor),
    withTargetLock: (_input, _worktreeId, effect) => effect,
    ...overrides,
  };
}

function completeAuthority(
  options: {readonly missing?: boolean; readonly registryAbsent?: boolean; readonly registryRootIdentity?: string} = {},
): Extract<CodeGraphWorktreeReconciliationAuthorityObservation, {readonly state: 'complete'}> {
  return {
    contentDigest: Effect2.pipe('9', EffectString.repeat(64)),
    entryCount: 0,
    pathStates: [options.missing === false ? 'present' : 'missing'],
    registryRootIdentity: options.registryRootIdentity ?? registryRootIdentity,
    registryRootKind: 'directory',
    registryStates: [options.registryAbsent === false ? 'present' : 'absent'],
    state: 'complete',
  };
}

function tick() {
  return {
    anchorIdentity: anchor,
    checkoutId,
    databasePath: '/derived/graph-v3.sqlite',
    threadnoteHome: '/derived/threadnote-home',
    writerLockPath: '/derived/database-writer.lock',
  } as const;
}

function pathAnchorTick() {
  return {
    anchorPath: anchor.repoRoot,
    checkoutId,
    databasePath: '/derived/graph-v3.sqlite',
    threadnoteHome: '/derived/threadnote-home',
    writerLockPath: '/derived/database-writer.lock',
  } as const;
}

function seedActiveView(databasePath: string, worktreeId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const snapshotId = `cgsn_${Effect2.pipe('a', EffectString.repeat(40))}`;
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'threadnote/orphan-provenance-cursor', 'sha1', ?, ?)`,
      )
      .run(repositoryId, new Date(0).toISOString(), new Date(0).toISOString());
    database
      .query(
        `INSERT INTO snapshots (
           id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
           dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
           failure_summary
         ) VALUES (?, ?, ?, ?, 'orphan-provenance-content', NULL, 'orphan-provenance-test',
                   0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
      )
      .run(
        snapshotId,
        repositoryId,
        worktreeId,
        Effect2.pipe('b', EffectString.repeat(40)),
        new Date(0).toISOString(),
        new Date(1).toISOString(),
      );
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
    database
      .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
      .run(worktreeId, snapshotId, new Date(2).toISOString());
  } finally {
    database.close(false);
  }
}

function writeOrphanCursor(databasePath: string, value: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO schema_metadata (key, value)
         VALUES ('orphan_provenance_cursor', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(value);
  } finally {
    database.close(false);
  }
}

function writeSchemaMetadata(databasePath: string, key: string, value: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query('INSERT INTO schema_metadata (key, value) VALUES (?, ?)').run(key, value);
  } finally {
    database.close(false);
  }
}

function upsertSchemaMetadata(databasePath: string, key: string, value: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO schema_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  } finally {
    database.close(false);
  }
}

function readOrphanCursor(databasePath: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<
        {
          value: string;
        } | null,
        SQLQueryBindings[]
      >("SELECT value FROM schema_metadata WHERE key = 'orphan_provenance_cursor'")
      .get()?.value;
  } finally {
    database.close(false);
  }
}

function readSchemaMetadata(databasePath: string): readonly {readonly key: string; readonly value: string}[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<
        {
          readonly key: string;
          readonly value: string;
        },
        SQLQueryBindings[]
      >('SELECT key, value FROM schema_metadata ORDER BY key')
      .all();
  } finally {
    database.close(false);
  }
}

function fillOrphanCursorMetadataCapacity(
  databasePath: string,
): readonly {readonly key: string; readonly value: string}[] {
  const database = new Database(databasePath, {strict: true});
  try {
    const admissionCursor = database
      .query("SELECT 1 FROM schema_metadata WHERE key = 'removed_view_cleanup_admission_cursor'")
      .get();
    const limit =
      admissionCursor === null
        ? REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - 1
        : REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS;
    let count = Number(
      requiredRow(
        database.query<{count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM schema_metadata').get(),
      ).count,
    );
    while (count < limit) {
      database.query('INSERT INTO schema_metadata (key, value) VALUES (?, ?)').run(`capacity-${count}`, 'bounded');
      count += 1;
    }
    return database
      .query<
        {
          readonly key: string;
          readonly value: string;
        },
        SQLQueryBindings[]
      >('SELECT key, value FROM schema_metadata ORDER BY key')
      .all();
  } finally {
    database.close(false);
  }
}

const createLiveOrphanFixture = Effect.gen(function* () {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'threadnote-orphan-provenance-live-')));
  temporaryRoots.push(root);
  const home = join(root, 'threadnote-home');
  return yield* createLiveOrphanRepositoryFixture(root, home, 'single');
});

const createLiveOrphanRepositoryFixture = (root: string, home: string, name: string) =>
  Effect.gen(function* () {
    const main = join(root, `${name}-main`);
    const linked = join(root, `${name}-linked`);
    const mainFile = join(main, 'main.txt');
    yield* Effect.sync(() => {
      mkdirSync(main, {recursive: true});
      execFileSync('git', ['init', '--initial-branch=main', main], {encoding: 'utf8'});
      execFileSync('git', ['-C', main, 'config', 'user.email', 'threadnote@example.invalid'], {encoding: 'utf8'});
      execFileSync('git', ['-C', main, 'config', 'user.name', 'Threadnote Test'], {encoding: 'utf8'});
      writeFileSync(mainFile, 'main source\n');
      execFileSync('git', ['-C', main, 'add', 'main.txt'], {encoding: 'utf8'});
      execFileSync('git', ['-C', main, 'commit', '-m', 'initial'], {encoding: 'utf8'});
      execFileSync('git', ['-C', main, 'worktree', 'add', '-b', `${name}-linked-test`, linked], {encoding: 'utf8'});
    });
    const mainIdentity = yield* resolveRepositoryIdentity(main);
    const linkedIdentity = yield* resolveRepositoryIdentity(linked);
    const association = yield* recordVerifiedCodeGraphLocalAssociation(home, linkedIdentity);
    expect(association.state).toBe('verified');
    const path = yield* Path.Path;
    const layout = codeGraphLayout(path, home, mainIdentity.checkoutId, mainIdentity.worktreeId);
    const store = yield* CodeGraphStore;
    yield* store.initialize(layout.databasePath);
    const sidecar = join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      mainIdentity.checkoutId,
      'local-context',
      'worktrees',
      `${linkedIdentity.worktreeId}.json`,
    );
    expect(existsSync(sidecar)).toBe(true);
    return {
      databasePath: layout.databasePath,
      home,
      layout,
      linked,
      linkedIdentity,
      main,
      mainFile,
      mainIdentity,
      root,
      sidecar,
    };
  });

function readGraphRowCounts(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      activeSnapshots: Number(
        requiredRow(
          database.query<{count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM active_snapshots').get(),
        ).count,
      ),
      cleanupRows: Number(
        requiredRow(
          database
            .query<{count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM removed_view_cleanup')
            .get(),
        ).count,
      ),
      snapshots: Number(
        requiredRow(
          database.query<{count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM snapshots').get(),
        ).count,
      ),
    };
  } finally {
    database.close(false);
  }
}

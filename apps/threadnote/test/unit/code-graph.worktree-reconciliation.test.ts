import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync, spawn} from '@threadnote/testing/node-child-process';
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
import {dirname, join} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {Clock, Deferred, Effect, Fiber, Layer, Path, Ref, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {afterEach, describe, expect} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
import {CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT} from '@threadnote/threadnote/worker_protocol';
import type {CodeGraphWorktreeReconciliationAuthorityObservation} from '@threadnote/graph/git/worktree/registration';
import {
  recordVerifiedCodeGraphLocalAssociation,
  type CodeGraphWorktreeReconciliationEvidenceCandidate,
} from '@threadnote/graph/local_provenance';
import {codeGraphLayout, type CodeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphMaintenanceActiveError, withCodeGraphTargetWorktreeLock} from '@threadnote/graph/maintenance/gate';
import {
  CodeGraphStore,
  codeGraphExactSnapshotRetirementStatement,
  codeGraphWorktreeReconciliationCandidatePageStatement,
  type CodeGraphViewRemovalResult,
} from '@threadnote/graph/store';

import {
  CODE_GRAPH_EXTRACTOR_GENERATION,
  CodeGraphStoreBusyError,
  CodeGraphStoreError,
  isCodeGraphStoreError,
  type CodeGraphSnapshot,
} from '@threadnote/graph/types';
import {REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS} from '@threadnote/graph/store/schema/metadata';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {
  CODE_GRAPH_WORKTREE_RECONCILIATION_CANDIDATE_LIMIT,
  makeCodeGraphWorktreeReconciler,
  makeLiveCodeGraphWorktreeReconciler,
  type CodeGraphWorktreeReconciliationCandidate,
  type CodeGraphWorktreeReconciliationDependencies,
  type CodeGraphWorktreeReconciliationResult,
} from '@threadnote/graph/worktree_reconciliation';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const provenanceRecordSchema = Schema.Struct({
  registration: Schema.optional(Schema.Struct({kind: Schema.String})),
  schemaVersion: Schema.optional(Schema.Finite),
});
const worktreeReconciliationResultSchema = Schema.Union([
  Schema.Struct({
    expectedSnapshotId: Schema.String,
    nextCursor: Schema.String,
    retiredSnapshots: Schema.Finite,
    state: Schema.Literal('removed'),
    worktreeId: Schema.String,
  }),
  Schema.Struct({
    nextCursor: Schema.optional(Schema.String),
    reason: Schema.Literals([
      'already-removed',
      'anchor-unavailable',
      'evidence-changed',
      'external-maintenance',
      'no-anchor',
      'no-candidates',
      'no-missing-candidates',
      'registered',
      'registry-changed',
      'stale-target',
    ]),
    state: Schema.Literal('preserved'),
  }),
  Schema.Struct({
    nextCursor: Schema.optional(Schema.String),
    reason: Schema.Literals(['catalog-unavailable', 'registry-unavailable', 'target-busy', 'writer-busy']),
    state: Schema.Literal('deferred'),
  }),
]);

function isCodeGraphWorktreeReconciliationResult(value: unknown): value is CodeGraphWorktreeReconciliationResult {
  return Schema.is(worktreeReconciliationResultSchema)(value);
}

const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
const repositoryId = Effect2.pipe('b', EffectString.repeat(64));
const anchorWorktreeId = Effect2.pipe('c', EffectString.repeat(64));
const targetWorktreeId = Effect2.pipe('d', EffectString.repeat(64));
const expectedSnapshotId = `cgsn_${Effect2.pipe('e', EffectString.repeat(40))}`;
const privateRoot = '/private/threadnote/repository';
const registryRootIdentity = Effect2.pipe('f', EffectString.repeat(64));
const boundedMalformedReconciliationCursor = fc
  .array(fc.constantFrom(...Effect2.pipe('0123456789abcdefxyz_-', EffectString.split(''))), {maxLength: 64})
  .map(characters => EffectArray.join(characters, ''))
  .filter(value => !/^[0-9a-f]{64}$/u.test(value));
const temporaryRoots: string[] = [];
const storeLayer = CodeGraphStore.layer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);
const liveLayer = Layer.merge(CodeGraphStore.layer, TestCommandExecutorLayer).pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

const anchor: RepositoryIdentity = {
  caseMode: 'sensitive',
  checkoutId,
  displayName: 'threadnote/reconciliation-test',
  gitCommonDirectory: `${privateRoot}/.git`,
  headCommit: Effect2.pipe('1', EffectString.repeat(40)),
  objectFormat: 'sha1',
  repositoryId,
  repoRoot: privateRoot,
  worktreeId: anchorWorktreeId,
};

const candidate: CodeGraphWorktreeReconciliationCandidate = {
  repositoryId,
  snapshotId: expectedSnapshotId,
  worktreeId: targetWorktreeId,
};

const linkedEvidence: Extract<CodeGraphWorktreeReconciliationEvidenceCandidate, {readonly state: 'candidate'}> = {
  canonicalWorktreePath: `${privateRoot}/removed-linked-worktree`,
  checkoutId,
  evidenceToken: Effect2.pipe('1', EffectString.repeat(64)),
  recordDigest: Effect2.pipe('2', EffectString.repeat(64)),
  recordIdentity: Effect2.pipe('3', EffectString.repeat(64)),
  registration: {adminNameKeys: [Effect2.pipe('4', EffectString.repeat(64))], kind: 'linked'},
  repositoryId,
  state: 'candidate',
  worktreeId: targetWorktreeId,
};

const absentBatch: CodeGraphWorktreeReconciliationAuthorityObservation = {
  contentDigest: Effect2.pipe('5', EffectString.repeat(64)),
  entryCount: 0,
  pathStates: ['missing'],
  registryRootIdentity,
  registryRootKind: 'directory',
  registryStates: ['absent'],
  state: 'complete',
};

const absentFinal = absentBatch;

describe('automatic missing-worktree reconciliation', () => {
  effectIt.effect('holds the target lock across the final proof and exact snapshot CAS', () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<string[]>([]);
      const anchorReads = yield* Ref.make(0);
      const authorityReads = yield* Ref.make(0);
      const evidenceReads = yield* Ref.make(0);
      const intentReads = yield* Ref.make(0);
      const removalEvidence = yield* Ref.make<unknown>(undefined);
      const dependencies = successfulDependencies({
        maintenanceIntentActive: () =>
          Ref.updateAndGet(intentReads, count => count + 1).pipe(
            Effect.flatMap(count => append(events, count === 1 ? 'initial-intent' : 'post-intent')),
            Effect.as(false),
          ),
        observeAuthority: () =>
          Ref.updateAndGet(authorityReads, count => count + 1).pipe(
            Effect.flatMap(count => append(events, count === 1 ? 'initial-authority' : 'final-authority')),
            Effect.as(absentBatch),
          ),
        readEvidenceCandidate: () =>
          Ref.updateAndGet(evidenceReads, count => count + 1).pipe(
            Effect.flatMap(count =>
              append(events, count === 1 ? 'initial-evidence' : count === 2 ? 'final-evidence' : 'post-evidence'),
            ),
            Effect.as(linkedEvidence),
          ),
        removeView: (_input, _candidate, cleanupEvidence) =>
          Ref.set(removalEvidence, cleanupEvidence).pipe(
            Effect.andThen(append(events, 'remove')),
            Effect.as(removedResult()),
          ),
        resolveAnchor: () =>
          Ref.updateAndGet(anchorReads, count => count + 1).pipe(
            Effect.flatMap(count =>
              append(events, count === 1 ? 'initial-anchor' : count === 2 ? 'final-anchor' : 'post-anchor'),
            ),
            Effect.as(anchor),
          ),
        withTargetLock: (_input, _worktreeId, effect) =>
          append(events, 'lock-enter').pipe(Effect.andThen(effect), Effect.ensuring(append(events, 'lock-exit'))),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result).toMatchObject({
        expectedSnapshotId,
        state: 'removed',
        worktreeId: targetWorktreeId,
      });
      expect(yield* Ref.get(events)).toEqual([
        'initial-evidence',
        'initial-anchor',
        'initial-authority',
        'lock-enter',
        'initial-intent',
        'final-evidence',
        'final-anchor',
        'final-authority',
        'post-anchor',
        'post-evidence',
        'post-intent',
        'remove',
        'lock-exit',
      ]);
      expect(yield* Ref.get(removalEvidence)).toEqual({
        recordDigest: linkedEvidence.recordDigest,
        recordIdentity: linkedEvidence.recordIdentity,
        repositoryId: linkedEvidence.repositoryId,
      });
    }),
  );

  effectIt.effect('preserves every ambiguous authority state without invoking the core mutation', () =>
    Effect.gen(function* () {
      const cases = [
        {
          name: 'main registration',
          overrides: {readEvidenceCandidate: () => Effect.succeed({state: 'main'} as const)},
        },
        {
          name: 'legacy evidence',
          overrides: {readEvidenceCandidate: () => Effect.succeed({state: 'legacy-unknown'} as const)},
        },
        {
          name: 'invalid evidence',
          overrides: {readEvidenceCandidate: () => Effect.succeed({state: 'invalid'} as const)},
        },
        {
          name: 'verified path',
          overrides: {
            observeAuthority: () => Effect.succeed({...absentBatch, pathStates: ['present'] as const}),
          },
        },
        {
          name: 'stale path',
          overrides: {
            observeAuthority: () => Effect.succeed({...absentBatch, pathStates: ['present'] as const}),
          },
        },
        {
          name: 'registered child',
          overrides: {
            observeAuthority: () => Effect.succeed({...absentBatch, registryStates: ['present'] as const}),
          },
        },
        {
          name: 'unknown initial registry',
          overrides: {
            observeAuthority: () => Effect.succeed({reason: 'ambiguous', state: 'unknown'} as const),
          },
        },
        {
          name: 'unknown final registry',
          overrides: {
            observeAuthority: authoritySequence(absentBatch, {reason: 'unavailable', state: 'unknown'} as const),
          },
        },
        {
          name: 'present final registry',
          overrides: {
            observeAuthority: authoritySequence(absentBatch, {
              ...absentFinal,
              registryStates: ['present'] as const,
            }),
          },
        },
        {
          name: 'replaced registry root',
          overrides: {
            observeAuthority: authoritySequence(absentBatch, {
              ...absentFinal,
              registryRootIdentity: Effect2.pipe('6', EffectString.repeat(64)),
            }),
          },
        },
        {
          name: 'active maintenance intent',
          overrides: {maintenanceIntentActive: () => Effect.succeed(true)},
        },
        {
          name: 'identity-mismatched anchor',
          overrides: {
            resolveAnchor: () => Effect.succeed({...anchor, repositoryId: Effect2.pipe('7', EffectString.repeat(64))}),
          },
        },
      ] as const;

      for (const testCase of cases) {
        const removals = yield* Ref.make(0);
        const dependencies = successfulDependencies({
          ...testCase.overrides,
          removeView: () => Ref.update(removals, count => count + 1).pipe(Effect.as(removedResult())),
        });
        const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());
        expect(yield* Ref.get(removals), testCase.name).toBe(0);
        expect(result.state, testCase.name).not.toBe('removed');
        expect(JSON.stringify(result), testCase.name).not.toContain(privateRoot);
      }
    }),
  );

  effectIt.effect('does no Git identity or registry work when the claimed page has no missing token', () =>
    Effect.gen(function* () {
      const anchorCalls = yield* Ref.make(0);
      const registryCalls = yield* Ref.make(0);
      const dependencies = successfulDependencies({
        listCandidates: () =>
          Effect.succeed(
            Array.from({length: CODE_GRAPH_WORKTREE_RECONCILIATION_CANDIDATE_LIMIT}, (_, index) => ({
              repositoryId,
              snapshotId: `cgsn_${Effect2.pipe(index.toString(16), EffectString.padStart(40, '0'))}`,
              worktreeId: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
            })),
          ),
        observeAuthority: () => Ref.update(registryCalls, count => count + 1).pipe(Effect.as(absentBatch)),
        readEvidenceCandidate: () => Effect.succeed({state: 'invalid'} as const),
        resolveAnchor: () => Ref.update(anchorCalls, count => count + 1).pipe(Effect.as(anchor)),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result).toMatchObject({reason: 'no-missing-candidates', state: 'preserved'});
      expect(yield* Ref.get(anchorCalls)).toBe(0);
      expect(yield* Ref.get(registryCalls)).toBe(0);
    }),
  );

  effectIt.effect('runs bounded scope-intent maintenance even when the active-view page is empty', () =>
    Effect.gen(function* () {
      const retirementCalls = yield* Ref.make(0);
      const dependencies = successfulDependencies({
        listCandidates: () => Effect.succeed([]),
        retireScopes: (_input, candidates) =>
          Ref.update(retirementCalls, count => count + 1).pipe(
            Effect.tap(() => Effect.sync(() => expect(candidates).toEqual([]))),
            Effect.as(undefined),
          ),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result).toEqual({reason: 'no-candidates', state: 'preserved'});
      expect(yield* Ref.get(retirementCalls)).toBe(1);
    }),
  );

  effectIt.effect('resolves a foreground anchor path only after a missing candidate is observed', () =>
    Effect.gen(function* () {
      const anchorCalls = yield* Ref.make(0);
      const dependencies = successfulDependencies({
        resolveAnchor: () => Ref.update(anchorCalls, count => count + 1).pipe(Effect.as(anchor)),
      });
      const {anchorIdentity: _anchorIdentity, ...withoutAnchor} = tick();

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick({
        ...withoutAnchor,
        anchorPath: anchor.repoRoot,
      });

      expect(result).toMatchObject({state: 'removed', worktreeId: targetWorktreeId});
      expect(yield* Ref.get(anchorCalls)).toBe(4);
    }),
  );

  effectIt.effect('requires the final missing record to be byte-for-byte the initially admitted evidence', () =>
    Effect.gen(function* () {
      const changedEvidence = [
        {...linkedEvidence, recordIdentity: Effect2.pipe('8', EffectString.repeat(64))},
        {
          ...linkedEvidence,
          registration: {adminNameKeys: [Effect2.pipe('9', EffectString.repeat(64))], kind: 'linked' as const},
        },
      ] as const;
      for (const changed of changedEvidence) {
        const reads = yield* Ref.make(0);
        const removals = yield* Ref.make(0);
        const dependencies = successfulDependencies({
          readEvidenceCandidate: () =>
            Ref.updateAndGet(reads, count => count + 1).pipe(
              Effect.map(count => (count === 1 ? linkedEvidence : changed)),
            ),
          removeView: () => Ref.update(removals, count => count + 1).pipe(Effect.as(removedResult())),
        });

        const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

        expect(result).toMatchObject({reason: 'evidence-changed', state: 'preserved'});
        expect(yield* Ref.get(reads)).toBe(2);
        expect(yield* Ref.get(removals)).toBe(0);
      }
    }),
  );

  effectIt.effect('does not remove when the post-authority evidence re-read changes', () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const removals = yield* Ref.make(0);
      const dependencies = successfulDependencies({
        readEvidenceCandidate: () =>
          Ref.updateAndGet(reads, count => count + 1).pipe(
            Effect.map(count =>
              count === 3
                ? {...linkedEvidence, recordDigest: Effect2.pipe('8', EffectString.repeat(64))}
                : linkedEvidence,
            ),
          ),
        removeView: () => Ref.update(removals, count => count + 1).pipe(Effect.as(removedResult())),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result).toMatchObject({reason: 'evidence-changed', state: 'preserved'});
      expect(yield* Ref.get(reads)).toBe(3);
      expect(yield* Ref.get(removals)).toBe(0);
    }),
  );

  effectIt.effect('preserves when maintenance begins during the final authority worker', () =>
    Effect.gen(function* () {
      const intentReads = yield* Ref.make(0);
      const removals = yield* Ref.make(0);
      const dependencies = successfulDependencies({
        maintenanceIntentActive: () =>
          Ref.updateAndGet(intentReads, count => count + 1).pipe(Effect.map(count => count > 1)),
        removeView: () => Ref.update(removals, count => count + 1).pipe(Effect.as(removedResult())),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result).toMatchObject({reason: 'external-maintenance', state: 'preserved'});
      expect(yield* Ref.get(intentReads)).toBe(2);
      expect(yield* Ref.get(removals)).toBe(0);
    }),
  );

  effectIt.effect('distinguishes a busy target gate from other lock-held catalog failures', () =>
    Effect.gen(function* () {
      const cases = [
        {
          expected: {reason: 'target-busy', state: 'deferred'},
          failure: CodeGraphStoreBusyError.of('Target gate is busy.'),
        },
        {
          expected: {reason: 'catalog-unavailable', state: 'deferred'},
          failure: CodeGraphStoreError.of('Target gate could not be inspected.', {
            code: 'permission',
            recovery: 'fix-permissions',
          }),
        },
      ] as const;
      for (const testCase of cases) {
        const dependencies = successfulDependencies({
          withTargetLock: () => Effect.fail(testCase.failure),
        });
        const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());
        expect(result).toMatchObject(testCase.expected);
        expect(JSON.stringify(result)).not.toContain(privateRoot);
      }
    }),
  );

  effectIt.effect('bounds a ten-thousand-view tick to one page and two registry scans', () =>
    Effect.gen(function* () {
      const candidates = Array.from({length: 10_000}, (_, index) => ({
        repositoryId,
        snapshotId: `snapshot-${index}`,
        worktreeId: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
      }));
      const listedLimits = yield* Ref.make<number[]>([]);
      const authorityScans = yield* Ref.make(0);
      const dependencies = successfulDependencies({
        listCandidates: (_input, limit) =>
          Ref.update(listedLimits, limits => [...limits, limit]).pipe(Effect.as(candidates.slice(0, limit))),
        observeAuthority: (_identity, targets) =>
          Ref.updateAndGet(authorityScans, count => count + 1).pipe(
            Effect.map(count => ({
              ...absentBatch,
              pathStates: EffectArray.map(targets, () => 'missing' as const),
              registryStates: EffectArray.map(targets, () => 'absent' as const),
              ...(count === 1 ? {} : {entryCount: 0}),
            })),
          ),
        readEvidenceCandidate: (_threadnoteHome, target) =>
          Effect.succeed({
            ...linkedEvidence,
            worktreeId: target.worktreeId,
          }),
      });

      const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());

      expect(result.state).toBe('removed');
      expect(yield* Ref.get(listedLimits)).toEqual([CODE_GRAPH_WORKTREE_RECONCILIATION_CANDIDATE_LIMIT]);
      expect(yield* Ref.get(authorityScans)).toBe(2);
    }),
  );

  effectIt.effect('repairs only bounded semantic cursor state and keeps authoritative state fail closed', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-cursor-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const worktreeIds = Array.from({length: 70}, (_, index) =>
          Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
        );
        yield* Effect.sync(() => seedCandidateViews(databasePath, worktreeIds));

        const pages = yield* Effect.all(
          Array.from({length: 3}, () =>
            store.claimWorktreeReconciliationCandidates(databasePath, 32, {waitTimeoutMilliseconds: 5_000}),
          ),
          {concurrency: 'unbounded'},
        );
        const claimed = new Set(EffectArray.flatMap(pages, page => EffectArray.map(page, entry => entry.worktreeId)));
        expect(EffectArray.map(pages, page => page.length).sort((left, right) => left - right)).toEqual([31, 32, 32]);
        expect(claimed.size).toBe(69);
        expect(claimed.has(worktreeIds.at(-1)!)).toBe(false);

        const cleanupCursor = Effect2.pipe('e', EffectString.repeat(64));
        const repaired = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database
              .query('INSERT INTO schema_metadata (key, value) VALUES (?, ?)')
              .run('removed_view_cleanup_admission_cursor', cleanupCursor);
            database
              .query('UPDATE schema_metadata SET value = ? WHERE key = ?')
              .run('malformed', 'worktree_reconciliation_cursor');
          } finally {
            database.close(false);
          }
        }).pipe(Effect.andThen(store.claimWorktreeReconciliationCandidates(databasePath, 32)));
        expect(repaired).toHaveLength(32);
        expect(readSchemaMetadataFamily(databasePath, 'worktree_reconciliation_cursor')).toEqual([
          {key: 'worktree_reconciliation_cursor', value: worktreeIds[31]},
        ]);
        expect(readSchemaMetadataValue(databasePath, 'removed_view_cleanup_admission_cursor')).toBe(cleanupCursor);

        const authoritative = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database
              .query('UPDATE schema_metadata SET value = ? WHERE key = ?')
              .run('malformed-authoritative', 'removed_view_cleanup_admission_cursor');
          } finally {
            database.close(false);
          }
        }).pipe(Effect.andThen(store.claimWorktreeReconciliationCandidates(databasePath, 32).pipe(Effect.exit)));
        expect(authoritative._tag).toBe('Failure');
        if (authoritative._tag === 'Failure') {
          expect(String(authoritative.cause)).not.toContain('malformed-authoritative');
          expect(String(authoritative.cause)).not.toContain(root);
        }
        expect(readSchemaMetadataValue(databasePath, 'removed_view_cleanup_admission_cursor')).toBe(
          'malformed-authoritative',
        );
        expect(readReconciliationCursor(databasePath)).toBe(worktreeIds[31]);
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database
              .query('UPDATE schema_metadata SET value = ? WHERE key = ?')
              .run(cleanupCursor, 'removed_view_cleanup_admission_cursor');
          } finally {
            database.close(false);
          }
        });

        const incompatibleVersion = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.query('DELETE FROM schema_metadata WHERE key = ?').run('worktree_reconciliation_cursor');
            database.query("UPDATE schema_metadata SET value = '999' WHERE key = 'schema_version'").run();
          } finally {
            database.close(false);
          }
        }).pipe(Effect.andThen(store.claimWorktreeReconciliationCandidates(databasePath, 32).pipe(Effect.exit)));
        expect(incompatibleVersion._tag).toBe('Failure');
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.query("UPDATE schema_metadata SET value = '3' WHERE key = 'schema_version'").run();
          } finally {
            database.close(false);
          }
        });

        const partial = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.query('DELETE FROM schema_metadata WHERE key = ?').run('worktree_reconciliation_cursor');
            database.run('DROP TABLE removed_views');
            database.run('CREATE TABLE removed_views (worktree_id TEXT PRIMARY KEY)');
          } finally {
            database.close(false);
          }
        }).pipe(Effect.andThen(store.claimWorktreeReconciliationCandidates(databasePath, 32).pipe(Effect.exit)));
        expect(partial._tag).toBe('Failure');

        const cascadingTombstone = yield* Effect.sync(() => {
          const database = new Database(databasePath, {strict: true});
          try {
            database.run('DROP TABLE removed_views');
            database.run(`CREATE TABLE removed_views (
              worktree_id TEXT PRIMARY KEY NOT NULL,
              expected_snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
              removed_at TEXT NOT NULL
            ) WITHOUT ROWID`);
          } finally {
            database.close(false);
          }
        }).pipe(Effect.andThen(store.claimWorktreeReconciliationCandidates(databasePath, 32).pipe(Effect.exit)));
        expect(cascadingTombstone._tag).toBe('Failure');
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('fails closed on structural cursor metadata with fixed path-free diagnostics', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const oversized = Effect2.pipe('private-cursor-content-', EffectString.repeat(4_096));
        const cases = [
          {
            entries: [['worktree_reconciliation_cursor', oversized]] as const,
            name: 'oversized exact key',
            privateValue: oversized,
          },
          {
            entries: [['WORKTREE_RECONCILIATION_CURSOR', 'private-wrong-case-cursor']] as const,
            name: 'wrong-case key',
            privateValue: 'private-wrong-case-cursor',
          },
          {
            entries: [
              ['worktree_reconciliation_cursor', Effect2.pipe('a', EffectString.repeat(64))],
              ['WORKTREE_RECONCILIATION_CURSOR', 'private-ambiguous-cursor'],
            ] as const,
            name: 'ambiguous key family',
            privateValue: 'private-ambiguous-cursor',
          },
        ];

        for (const testCase of cases) {
          const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-cursor-bounds-'));
          temporaryRoots.push(root);
          const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
          yield* store.initialize(databasePath);
          yield* Effect.sync(() => {
            seedCandidateViews(databasePath, [targetWorktreeId], false);
            for (const [key, value] of testCase.entries) insertSchemaMetadata(databasePath, key, value);
          });
          const before = readSchemaMetadataFamily(databasePath, 'worktree_reconciliation_cursor');

          const invalid = yield* Effect.flip(store.claimWorktreeReconciliationCandidates(databasePath, 1));

          expect(isCodeGraphStoreError(invalid), testCase.name).toBe(true);
          expect(invalid.message, testCase.name).toBe(
            'Code graph reconciliation cursor metadata is structurally invalid.',
          );
          expect(invalid.code, testCase.name).toBe('confirmed-corruption');
          expect(invalid.operation, testCase.name).toBe('claim code graph reconciliation candidates');
          expect(invalid.recovery, testCase.name).toBe('manual-rebuild');
          expect(JSON.stringify(invalid), testCase.name).not.toContain(
            Effect2.pipe(testCase.privateValue, EffectString.slice(0, 32)),
          );
          expect(JSON.stringify(invalid), testCase.name).not.toContain(root);
          expect(readSchemaMetadataFamily(databasePath, 'worktree_reconciliation_cursor'), testCase.name).toEqual(
            before,
          );
        }
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('preserves cursor capacity and next-call liveness at both authoritative metadata ceilings', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        for (const cleanupCursorRecorded of [false, true]) {
          const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-cursor-capacity-'));
          temporaryRoots.push(root);
          const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
          yield* store.initialize(databasePath);
          yield* Effect.sync(() => {
            seedCandidateViews(databasePath, [targetWorktreeId], false);
            if (cleanupCursorRecorded) {
              insertSchemaMetadata(
                databasePath,
                'removed_view_cleanup_admission_cursor',
                Effect2.pipe('e', EffectString.repeat(64)),
              );
            }
          });
          const maximumRows = REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - (cleanupCursorRecorded ? 0 : 1);
          const fillerKeys = yield* Effect.sync(() => fillSchemaMetadataToCount(databasePath, maximumRows));

          for (let call = 0; call < 2; call += 1) {
            const claimed = yield* store.claimWorktreeReconciliationCandidates(databasePath, 1);
            expect(EffectArray.map(claimed, entry => entry.worktreeId)).toEqual([targetWorktreeId]);
            expect(readSchemaMetadataCount(databasePath)).toBe(maximumRows);
            expect(readReconciliationCursor(databasePath)).toBeUndefined();
          }
          expect(readSchemaMetadataValue(databasePath, 'removed_view_cleanup_admission_cursor')).toBe(
            cleanupCursorRecorded ? Effect2.pipe('e', EffectString.repeat(64)) : undefined,
          );

          yield* Effect.sync(() => deleteSchemaMetadata(databasePath, fillerKeys.at(-1)!));
          const claimed = yield* store.claimWorktreeReconciliationCandidates(databasePath, 1);
          expect(EffectArray.map(claimed, entry => entry.worktreeId)).toEqual([targetWorktreeId]);
          expect(readSchemaMetadataCount(databasePath)).toBe(maximumRows);
          expect(readReconciliationCursor(databasePath)).toBe(targetWorktreeId);
        }
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('recovers only a unique exact bounded legacy overflow at the 66- and 67-row bounds', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        for (const cleanupCursorRecorded of [false, true]) {
          for (const legacyCursor of [Effect2.pipe('a', EffectString.repeat(64)), 'bounded-malformed-cursor']) {
            const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-cursor-legacy-overflow-'));
            temporaryRoots.push(root);
            const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
            yield* store.initialize(databasePath);
            yield* Effect.sync(() => {
              seedCandidateViews(databasePath, [targetWorktreeId], false);
              if (cleanupCursorRecorded) {
                insertSchemaMetadata(
                  databasePath,
                  'removed_view_cleanup_admission_cursor',
                  Effect2.pipe('e', EffectString.repeat(64)),
                );
              }
            });
            const maximumRows = REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - (cleanupCursorRecorded ? 0 : 1);
            const fillerKeys = yield* Effect.sync(() => fillSchemaMetadataToCount(databasePath, maximumRows));
            yield* Effect.sync(() =>
              insertSchemaMetadata(databasePath, 'worktree_reconciliation_cursor', legacyCursor),
            );
            expect(readSchemaMetadataCount(databasePath)).toBe(maximumRows + 1);

            for (let call = 0; call < 2; call += 1) {
              const claimed = yield* store.claimWorktreeReconciliationCandidates(databasePath, 1);
              expect(EffectArray.map(claimed, entry => entry.worktreeId)).toEqual([targetWorktreeId]);
              expect(readSchemaMetadataCount(databasePath)).toBe(maximumRows);
              expect(readReconciliationCursor(databasePath)).toBeUndefined();
            }
            expect(readSchemaMetadataValue(databasePath, 'removed_view_cleanup_admission_cursor')).toBe(
              cleanupCursorRecorded ? Effect2.pipe('e', EffectString.repeat(64)) : undefined,
            );

            yield* Effect.sync(() => deleteSchemaMetadata(databasePath, fillerKeys.at(-1)!));
            expect(yield* store.claimWorktreeReconciliationCandidates(databasePath, 1)).toHaveLength(1);
            expect(readSchemaMetadataCount(databasePath)).toBe(maximumRows);
            expect(readReconciliationCursor(databasePath)).toBe(targetWorktreeId);
          }
        }
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('does not recover structurally invalid legacy overflow cursor families', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const structuralCases = [
          {
            entries: [
              ['worktree_reconciliation_cursor', Effect2.pipe('private-oversized-cursor', EffectString.repeat(64))],
            ] as const,
            fillerRows: 66,
            name: 'oversized exact key',
          },
          {
            entries: [['WORKTREE_RECONCILIATION_CURSOR', 'private-wrong-case-cursor']] as const,
            fillerRows: 66,
            name: 'wrong-case key',
          },
          {
            entries: [
              ['worktree_reconciliation_cursor', Effect2.pipe('a', EffectString.repeat(64))],
              ['WORKTREE_RECONCILIATION_CURSOR', 'private-ambiguous-cursor'],
            ] as const,
            fillerRows: 65,
            name: 'ambiguous key family',
          },
        ];

        for (const testCase of structuralCases) {
          const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-cursor-legacy-structural-'));
          temporaryRoots.push(root);
          const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
          yield* store.initialize(databasePath);
          yield* Effect.sync(() => {
            seedCandidateViews(databasePath, [targetWorktreeId], false);
            insertSchemaMetadata(
              databasePath,
              'removed_view_cleanup_admission_cursor',
              Effect2.pipe('e', EffectString.repeat(64)),
            );
            fillSchemaMetadataToCount(databasePath, testCase.fillerRows);
            for (const [key, value] of testCase.entries) insertSchemaMetadata(databasePath, key, value);
          });
          const before = readSchemaMetadataFamily(databasePath, 'worktree_reconciliation_cursor');
          expect(readSchemaMetadataCount(databasePath), testCase.name).toBe(67);

          const invalid = yield* Effect.flip(store.claimWorktreeReconciliationCandidates(databasePath, 1));

          expect(invalid.message, testCase.name).toBe(
            'Code graph reconciliation cursor metadata is structurally invalid.',
          );
          expect(invalid.code, testCase.name).toBe('confirmed-corruption');
          expect(JSON.stringify(invalid), testCase.name).not.toContain(root);
          expect(readSchemaMetadataCount(databasePath), testCase.name).toBe(67);
          expect(readSchemaMetadataFamily(databasePath, 'worktree_reconciliation_cursor'), testCase.name).toEqual(
            before,
          );
          expect(readSchemaMetadataValue(databasePath, 'removed_view_cleanup_admission_cursor')).toBe(
            Effect2.pipe('e', EffectString.repeat(64)),
          );
        }
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  fcEffectProp(
    effectIt,
    'atomically replaces every bounded semantic-invalid cursor with the claimed page boundary',
    {malformedCursor: boundedMalformedReconciliationCursor},
    ({malformedCursor}) =>
      TestClock.withLive(
        Effect.gen(function* () {
          const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-cursor-property-'));
          temporaryRoots.push(root);
          const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
          const store = yield* CodeGraphStore;
          yield* store.initialize(databasePath);
          const worktreeIds = [
            Effect2.pipe('0', EffectString.repeat(64)),
            Effect2.pipe('1', EffectString.repeat(64)),
            Effect2.pipe('2', EffectString.repeat(64)),
          ];
          yield* Effect.sync(() => {
            seedCandidateViews(databasePath, worktreeIds, false);
            writeReconciliationCursor(databasePath, malformedCursor);
          });
          const beforeRows = readSchemaMetadataCount(databasePath);

          const claimed = yield* store.claimWorktreeReconciliationCandidates(databasePath, 2);

          expect(EffectArray.map(claimed, entry => entry.worktreeId)).toEqual(worktreeIds.slice(0, 2));
          expect(readReconciliationCursor(databasePath)).toBe(worktreeIds[1]);
          expect(readSchemaMetadataCount(databasePath)).toBe(beforeRows);
        }).pipe(provideTestLayer(storeLayer)),
      ),
    {fastCheck: {numRuns: 24}},
  );

  fcEffectProp(
    effectIt,
    'recovers bounded semantic legacy overflow without consuming either metadata reservation',
    {
      cleanupCursorRecorded: fc.boolean(),
      legacyCursor: fc.oneof(
        fc.constant(Effect2.pipe('a', EffectString.repeat(64))),
        boundedMalformedReconciliationCursor,
      ),
    },
    ({cleanupCursorRecorded, legacyCursor}) =>
      TestClock.withLive(
        Effect.gen(function* () {
          const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-cursor-legacy-property-'));
          temporaryRoots.push(root);
          const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
          const store = yield* CodeGraphStore;
          yield* store.initialize(databasePath);
          yield* Effect.sync(() => {
            seedCandidateViews(databasePath, [targetWorktreeId], false);
            if (cleanupCursorRecorded) {
              insertSchemaMetadata(
                databasePath,
                'removed_view_cleanup_admission_cursor',
                Effect2.pipe('e', EffectString.repeat(64)),
              );
            }
          });
          const maximumRows = REMOVED_VIEW_CLEANUP_CURRENT_MAXIMUM_METADATA_ROWS - (cleanupCursorRecorded ? 0 : 1);
          yield* Effect.sync(() => {
            fillSchemaMetadataToCount(databasePath, maximumRows);
            insertSchemaMetadata(databasePath, 'worktree_reconciliation_cursor', legacyCursor);
          });

          for (let call = 0; call < 2; call += 1) {
            expect(yield* store.claimWorktreeReconciliationCandidates(databasePath, 1)).toHaveLength(1);
            expect(readSchemaMetadataCount(databasePath)).toBe(maximumRows);
            expect(readReconciliationCursor(databasePath)).toBeUndefined();
          }
          expect(readSchemaMetadataValue(databasePath, 'removed_view_cleanup_admission_cursor')).toBe(
            cleanupCursorRecorded ? Effect2.pipe('e', EffectString.repeat(64)) : undefined,
          );
        }).pipe(provideTestLayer(storeLayer)),
      ),
    {fastCheck: {numRuns: 16}},
  );

  effectIt.effect('uses indexed cursor pages without a temporary sort across ten thousand real views', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-cursor-load-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const worktreeIds = Array.from({length: 10_000}, (_, index) =>
          Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
        );
        yield* Effect.sync(() => seedCandidateViews(databasePath, worktreeIds));

        const plans = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            return EffectArray.flatMap(['after', 'through'] as const, boundary => {
              const statement = codeGraphWorktreeReconciliationCandidatePageStatement(
                Effect2.pipe('7', EffectString.repeat(64)),
                boundary,
                32,
              );
              return database
                .query<
                  {
                    readonly detail: string;
                  },
                  SQLQueryBindings[]
                >(`EXPLAIN QUERY PLAN ${statement.text}`)
                .all(...statement.parameters);
            });
          } finally {
            database.close(false);
          }
        });
        expect(EffectArray.some(plans, plan => /active.*(?:INDEX|PRIMARY KEY)/iu.test(plan.detail))).toBe(true);
        expect(EffectArray.some(plans, plan => /USE TEMP B-TREE/iu.test(plan.detail))).toBe(false);

        yield* Effect.sync(() => tombstoneEveryActiveView(databasePath));
        const firstEmptyPage = yield* store.claimWorktreeReconciliationCandidates(databasePath, 32, {
          waitTimeoutMilliseconds: 0,
        });
        expect(firstEmptyPage).toEqual([]);
        expect(readReconciliationCursor(databasePath)).toBe(worktreeIds[31]);
        const secondEmptyPage = yield* store.claimWorktreeReconciliationCandidates(databasePath, 32, {
          waitTimeoutMilliseconds: 0,
        });
        expect(secondEmptyPage).toEqual([]);
        expect(readReconciliationCursor(databasePath)).toBe(worktreeIds[63]);

        yield* Effect.sync(() => removeViewTombstone(databasePath, worktreeIds[64]));
        const sparsePage = yield* store.claimWorktreeReconciliationCandidates(databasePath, 32, {
          waitTimeoutMilliseconds: 0,
        });
        expect(EffectArray.map(sparsePage, entry => entry.worktreeId)).toEqual([worktreeIds[64]]);
        expect(readReconciliationCursor(databasePath)).toBe(worktreeIds[95]);
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('retires only the selected snapshot in a high-cardinality catalog', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-exact-retirement-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const selectedSnapshotId = `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`;
        yield* Effect.sync(() => {
          seedCandidateViews(databasePath, [targetWorktreeId], false);
          seedReadyOrphanSnapshots(databasePath, 4_096, 1);
        });
        const now = yield* Clock.currentTimeMillis;
        const plan = yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true, strict: true});
          try {
            const statement = codeGraphExactSnapshotRetirementStatement([selectedSnapshotId], now);
            return database
              .query<
                {
                  readonly detail: string;
                },
                SQLQueryBindings[]
              >(`EXPLAIN QUERY PLAN ${statement.text}`)
              .all(...statement.parameters);
          } finally {
            database.close(false);
          }
        });
        expect(
          EffectArray.some(plan, row => Effect2.pipe(row.detail, EffectString.includes('snapshots_base_state_id'))),
        ).toBe(true);
        expect(
          EffectArray.some(plan, row =>
            Effect2.pipe(row.detail, EffectString.includes('active_snapshots_snapshot_worktree')),
          ),
        ).toBe(true);
        expect(
          EffectArray.some(plan, row =>
            Effect2.pipe(row.detail, EffectString.includes('snapshot_leases_snapshot_expiry')),
          ),
        ).toBe(true);
        expect(
          EffectArray.some(plan, row => /SCAN (?:active_snapshots|snapshot_leases|snapshots)\b/iu.test(row.detail)),
        ).toBe(false);

        const result = yield* store.removeView(databasePath, targetWorktreeId, selectedSnapshotId, {
          requireReconciliationSchema: true,
          waitTimeoutMilliseconds: 0,
        });
        const states = yield* Effect.sync(() => readExactRetirementState(databasePath, selectedSnapshotId));

        expect(result).toEqual({expectedSnapshotId: selectedSnapshotId, retiredSnapshots: 1, state: 'removed'});
        expect(states).toEqual({
          activeSnapshotId: undefined,
          readyOrphans: 4_096,
          removedSnapshotId: selectedSnapshotId,
          selectedState: 'retired',
        });
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('protects exact active and lease ancestry while allowing an expired-only target to retire', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-retirement-protection-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const worktreeIds = Array.from({length: 5}, (_, index) =>
          Effect2.pipe(String(index + 1), EffectString.repeat(64)),
        );
        const snapshotIds = Array.from(
          {length: 5},
          (_, index) => `cgsn_${Effect2.pipe(index.toString(16), EffectString.padStart(40, '0'))}`,
        );
        yield* Effect.sync(() => seedCandidateViews(databasePath, worktreeIds, false));
        const leaseToken = yield* store.acquireSnapshotLease(databasePath, snapshotIds[0], 60_000);
        // Lease acquisition legitimately prunes one existing retired page and
        // may schedule detached cleanup. Seed the retired ancestry afterward
        // so this authority test cannot race its own setup cleanup.
        yield* Effect.sync(() => seedRetirementProtectionGraph(databasePath, snapshotIds));

        const results = yield* Effect.forEach(
          worktreeIds,
          (worktreeId, index) =>
            store.removeView(databasePath, worktreeId, snapshotIds[index], {
              requireReconciliationSchema: true,
              // Each committed removal may schedule bounded detached cleanup.
              // This sequential authority test waits through that legitimate
              // writer handoff; dedicated contention tests retain zero-wait.
              waitTimeoutMilliseconds: 5_000,
            }),
          {concurrency: 1},
        );
        const states = yield* Effect.sync(() => readSnapshotStates(databasePath, snapshotIds));

        expect(
          EffectArray.map(results, result => ('retiredSnapshots' in result ? result.retiredSnapshots : undefined)),
        ).toEqual([0, 0, 0, 0, 1]);
        expect(EffectArray.every(results, result => result.state === 'removed')).toBe(true);
        expect(states).toEqual([
          {id: snapshotIds[0], state: 'ready'},
          {id: snapshotIds[1], state: 'ready'},
          {id: snapshotIds[2], state: 'ready'},
          {id: snapshotIds[3], state: 'ready'},
          {id: snapshotIds[4], state: 'retired'},
        ]);
        const childAfterRemoval = `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`;
        yield* Effect.sync(() => seedReadySnapshotChild(databasePath, snapshotIds[0], childAfterRemoval));
        yield* store.releaseSnapshotLease(databasePath, leaseToken);
        expect(yield* Effect.sync(() => readSnapshotStates(databasePath, [snapshotIds[0], childAfterRemoval]))).toEqual(
          [
            {id: snapshotIds[0], state: 'ready'},
            {id: childAfterRemoval, state: 'ready'},
          ],
        );
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('never retires a blocked candidate base through a released child candidate', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-retirement-chain-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const targetSnapshotId = `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`;
        const baseSnapshotId = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
        const blockingChildId = `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`;
        yield* Effect.sync(() => {
          seedCandidateViews(databasePath, [targetWorktreeId], false);
          seedLeaseReleaseCounterexample(databasePath, baseSnapshotId, targetSnapshotId, blockingChildId);
        });
        const leaseToken = yield* store.acquireSnapshotLease(databasePath, targetSnapshotId, 60_000);
        const removed = yield* store.removeView(databasePath, targetWorktreeId, targetSnapshotId, {
          requireReconciliationSchema: true,
          waitTimeoutMilliseconds: 0,
        });
        yield* store.releaseSnapshotLease(databasePath, leaseToken);

        expect(removed).toMatchObject({retiredSnapshots: 0, state: 'removed'});
        expect(
          yield* Effect.sync(() =>
            readSnapshotStates(databasePath, [baseSnapshotId, targetSnapshotId, blockingChildId]),
          ),
        ).toEqual([
          {id: baseSnapshotId, state: 'ready'},
          {id: targetSnapshotId, state: 'ready'},
          {id: blockingChildId, state: 'ready'},
        ]);
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('ignores only an exact tombstoned legacy pointer during lease-release retirement', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        for (const exactTombstone of [true, false]) {
          const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-legacy-republish-'));
          temporaryRoots.push(root);
          const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
          const store = yield* CodeGraphStore;
          yield* store.initialize(databasePath);
          const snapshotId = `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`;
          yield* Effect.sync(() => seedCandidateViews(databasePath, [targetWorktreeId], false));
          const lease = yield* store.acquireSnapshotLease(databasePath, snapshotId, 60_000);
          const removed = yield* store.removeView(databasePath, targetWorktreeId, snapshotId, {
            requireReconciliationSchema: true,
            waitTimeoutMilliseconds: 0,
          });
          yield* Effect.sync(() =>
            republishLegacyActivePointer(databasePath, targetWorktreeId, snapshotId, exactTombstone),
          );
          yield* store.releaseSnapshotLease(databasePath, lease);
          const state = yield* Effect.sync(() => readLegacyRepublishState(databasePath, targetWorktreeId, snapshotId));

          expect(removed).toMatchObject({retiredSnapshots: 0, state: 'removed'});
          if (exactTombstone) {
            expect(state).toEqual({
              activeSnapshotId: snapshotId,
              removedSnapshotId: snapshotId,
              snapshotState: 'retired',
            });
          } else {
            expect(state).toEqual({
              activeSnapshotId: snapshotId,
              removedSnapshotId: `cgsn_${Effect2.pipe('f', EffectString.repeat(40))}`,
              snapshotState: 'ready',
            });
          }
        }
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('stops exact retirement below an immediate blocker with ten thousand descendants', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-pruned-descendants-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const rootSnapshotId = `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`;
        const immediateBlockerId = `cgsn_${Effect2.pipe('1', EffectString.padStart(40, '0'))}`;
        const tailId = `cgsn_${Effect2.pipe((10_001).toString(16), EffectString.padStart(40, '0'))}`;
        yield* Effect.sync(() => {
          seedCandidateViews(databasePath, [targetWorktreeId], false);
          seedBlockedDescendantChain(databasePath, rootSnapshotId, 10_001);
        });
        const statement = codeGraphExactSnapshotRetirementStatement([rootSnapshotId], yield* Clock.currentTimeMillis);
        const plan = yield* Effect.sync(() => queryPlan(databasePath, statement));
        expect(
          EffectArray.some(plan, row => Effect2.pipe(row.detail, EffectString.includes('snapshots_base_state_id'))),
        ).toBe(true);
        expect(EffectArray.some(plan, row => /USE TEMP B-TREE|SCAN child/u.test(row.detail))).toBe(false);
        expect(statement.text).not.toMatch(/WITH RECURSIVE|descendant/iu);
        expect(statement.text).toMatch(/child\.base_snapshot_id = candidate\.id/u);

        const removed = yield* store.removeView(databasePath, targetWorktreeId, rootSnapshotId, {
          requireReconciliationSchema: true,
          waitTimeoutMilliseconds: 0,
        });

        expect(removed).toMatchObject({retiredSnapshots: 0, state: 'removed'});
        expect(
          yield* Effect.sync(() => readSnapshotStates(databasePath, [rootSnapshotId, immediateBlockerId, tailId])),
        ).toEqual([
          {id: rootSnapshotId, state: 'ready'},
          {id: immediateBlockerId, state: 'ready'},
          {id: tailId, state: 'ready'},
        ]);
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('keeps DELETE journal mode and files untouched for every incompatible strict API', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-delete-journal-'));
        temporaryRoots.push(root);
        const store = yield* CodeGraphStore;
        const operations = ['claim', 'prepare', 'remove'] as const;
        for (const operation of operations) {
          const databasePath = join(root, `${operation}.sqlite`);
          yield* Effect.sync(() => seedIncompatibleDeleteJournalDatabase(databasePath));
          if (operation === 'claim') {
            expect((yield* store.claimWorktreeReconciliationCandidates(databasePath, 1).pipe(Effect.exit))._tag).toBe(
              'Failure',
            );
          } else if (operation === 'prepare') {
            expect(yield* store.prepareWorktreeReconciliationIndexes(databasePath)).toEqual({
              reason: 'incompatible-schema',
              state: 'deferred',
            });
          } else {
            expect(
              (yield* store
                .removeView(databasePath, targetWorktreeId, expectedSnapshotId, {
                  requireReconciliationSchema: true,
                })
                .pipe(Effect.exit))._tag,
            ).toBe('Failure');
          }
          expect(readJournalMode(databasePath)).toBe('delete');
          expect(existsSync(`${databasePath}-wal`)).toBe(false);
          expect(existsSync(`${databasePath}-shm`)).toBe(false);
        }
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect(
    'rejects mixed lifecycle DDL, collations, generated columns, and firing triggers without mutation',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const mutations = [
            {
              name: 'generated column',
              setup: (databasePath: string) => {
                executeDatabaseSql(
                  databasePath,
                  'ALTER TABLE active_snapshots ADD COLUMN generated_extra TEXT GENERATED ALWAYS AS (worktree_id) VIRTUAL',
                );
              },
            },
            {
              name: 'snapshot self foreign key',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'snapshots', definition =>
                  Effect2.pipe(
                    definition,
                    EffectString.replace(
                      /\s*\)$/u,
                      ',\n      FOREIGN KEY (base_snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE\n    )',
                    ),
                  ),
                ),
            },
            {
              name: 'altered lifecycle state check',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'snapshots', definition =>
                  Effect2.pipe(
                    definition,
                    EffectString.replace(
                      "state IN ('building', 'ready', 'failed', 'retired')",
                      "state IN ('building', 'ready', 'failed')",
                    ),
                  ),
                ),
            },
            {
              name: 'uppercase lifecycle state literals',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'snapshots', definition =>
                  Effect2.pipe(
                    definition,
                    EffectString.replace(
                      "state IN ('building', 'ready', 'failed', 'retired')",
                      "state IN ('BUILDING', 'READY', 'FAILED', 'RETIRED')",
                    ),
                  ),
                ),
            },
            {
              name: 'case-folded schema metadata key',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'schema_metadata', definition =>
                  Effect2.pipe(
                    definition,
                    EffectString.replace(
                      'key TEXT PRIMARY KEY NOT NULL',
                      'key TEXT PRIMARY KEY NOT NULL COLLATE NOCASE',
                    ),
                  ),
                ),
            },
            {
              name: 'case-folded tombstone equality',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'removed_views', definition =>
                  Effect2.pipe(
                    definition,
                    EffectString.replace(
                      'expected_snapshot_id TEXT NOT NULL',
                      'expected_snapshot_id TEXT NOT NULL COLLATE NOCASE',
                    ),
                  ),
                ),
            },
            {
              name: 'case-folded required index',
              setup: (databasePath: string) =>
                executeDatabaseSql(
                  databasePath,
                  `DROP INDEX active_snapshots_snapshot_worktree;
                   CREATE INDEX active_snapshots_snapshot_worktree
                   ON active_snapshots(snapshot_id COLLATE NOCASE, worktree_id);`,
                ),
            },
            {
              name: 'case-folded lease capability key',
              setup: (databasePath: string) =>
                rebuildCanonicalTableDefinition(databasePath, 'snapshot_leases', definition =>
                  Effect2.pipe(
                    definition,
                    EffectString.replace(
                      'token TEXT PRIMARY KEY NOT NULL',
                      'token TEXT COLLATE NOCASE PRIMARY KEY NOT NULL',
                    ),
                  ),
                ),
            },
            {
              name: 'unexpected delete trigger',
              setup: (databasePath: string) => {
                executeDatabaseSql(
                  databasePath,
                  `CREATE TRIGGER reconciliation_delete_side_effect
                 AFTER DELETE ON active_snapshots BEGIN
                   UPDATE schema_metadata SET value = value WHERE key = 'schema_version';
                 END`,
                );
              },
            },
          ] as const;
          for (const mutation of mutations) {
            const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-mixed-schema-'));
            temporaryRoots.push(root);
            const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
            const store = yield* CodeGraphStore;
            const snapshotId = `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`;
            yield* store.initialize(databasePath);
            yield* Effect.sync(() => seedCandidateViews(databasePath, [targetWorktreeId], false));
            expect(yield* store.prepareWorktreeReconciliationIndexes(databasePath), `${mutation.name} control`).toEqual(
              {
                state: 'ready',
              },
            );
            yield* Effect.sync(() => mutation.setup(databasePath));
            const before = yield* Effect.sync(() => readExactRetirementState(databasePath, snapshotId));
            expect(
              (yield* store.claimWorktreeReconciliationCandidates(databasePath, 1).pipe(Effect.exit))._tag,
              mutation.name,
            ).toBe('Failure');
            expect(yield* store.prepareWorktreeReconciliationIndexes(databasePath), mutation.name).toEqual({
              reason: 'incompatible-schema',
              state: 'deferred',
            });
            expect(
              (yield* store
                .removeView(databasePath, targetWorktreeId, snapshotId, {requireReconciliationSchema: true})
                .pipe(Effect.exit))._tag,
              mutation.name,
            ).toBe('Failure');
            expect(yield* Effect.sync(() => readExactRetirementState(databasePath, snapshotId)), mutation.name).toEqual(
              before,
            );
          }
        }).pipe(provideTestLayer(storeLayer)),
      ),
  );

  effectIt.effect('preflights every required index before creating the first missing one', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-index-preflight-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => {
          executeDatabaseSql(databasePath, 'DROP INDEX active_snapshots_snapshot_worktree');
          executeDatabaseSql(databasePath, 'DROP INDEX snapshots_base_state_id');
          executeDatabaseSql(databasePath, 'CREATE INDEX snapshots_base_state_id ON snapshots(state, id)');
        });

        expect(yield* store.prepareWorktreeReconciliationIndexes(databasePath)).toEqual({
          reason: 'incompatible-schema',
          state: 'deferred',
        });
        expect(indexDefinition(databasePath, 'active_snapshots_snapshot_worktree')).toBeUndefined();
        expect(indexDefinition(databasePath, 'snapshots_base_state_id')).toContain('snapshots(state, id)');
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('strict removal never initializes or cleans unrelated incompatible extensions', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-extension-invariance-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const snapshotId = `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`;
        yield* Effect.sync(() => {
          seedCandidateViews(databasePath, [targetWorktreeId], false);
          executeDatabaseSql(databasePath, 'DROP TABLE snapshot_analysis_summary_receipts');
          executeDatabaseSql(
            databasePath,
            'CREATE TABLE snapshot_analysis_summary_receipts (sentinel TEXT PRIMARY KEY, payload TEXT NOT NULL)',
          );
          executeDatabaseSql(
            databasePath,
            "INSERT INTO snapshot_analysis_summary_receipts (sentinel, payload) VALUES ('keep', 'corrupt-extension')",
          );
        });
        const before = extensionDefinitionAndRows(databasePath);

        expect(
          yield* store.removeView(databasePath, targetWorktreeId, snapshotId, {
            requireReconciliationSchema: true,
            waitTimeoutMilliseconds: 0,
          }),
        ).toMatchObject({state: 'removed'});
        yield* Effect.sleep('100 millis');
        expect(extensionDefinitionAndRows(databasePath)).toEqual(before);
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('rechecks the exact reconciliation schema inside the final writer gate before mutation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-final-schema-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const selectedSnapshotId = `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`;
        yield* Effect.sync(() => seedCandidateViews(databasePath, [targetWorktreeId], false));
        expect(yield* store.claimWorktreeReconciliationCandidates(databasePath, 1)).toHaveLength(1);

        const result = yield* store
          .removeView(databasePath, targetWorktreeId, selectedSnapshotId, {
            beforeDatabaseOpen: () =>
              Effect.sync(() => {
                const database = new Database(databasePath, {strict: true});
                try {
                  database.query("UPDATE schema_metadata SET value = '999' WHERE key = 'schema_version'").run();
                } finally {
                  database.close(false);
                }
              }),
            requireReconciliationSchema: true,
            waitTimeoutMilliseconds: 0,
          })
          .pipe(Effect.exit);
        const state = yield* Effect.sync(() => readExactRetirementState(databasePath, selectedSnapshotId));

        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect(String(result.cause)).toContain('Code graph reconciliation schema is unavailable.');
          expect(String(result.cause)).not.toContain(root);
        }
        expect(state).toEqual({
          activeSnapshotId: selectedSnapshotId,
          readyOrphans: 0,
          removedSnapshotId: undefined,
          selectedState: 'ready',
        });
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('holds the checkout writer gate while the final candidate database proof runs', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-claim-proof-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        yield* Effect.sync(() => seedCandidateViews(databasePath, [targetWorktreeId], false));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const owner = yield* store
          .claimWorktreeReconciliationCandidates(databasePath, 1, {
            beforeDatabaseOpen: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            waitTimeoutMilliseconds: 5_000,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);

        const contender = yield* store
          .claimWorktreeReconciliationCandidates(databasePath, 1, {waitTimeoutMilliseconds: 0})
          .pipe(Effect.exit);
        expect(contender._tag).toBe('Failure');
        if (contender._tag === 'Failure') expect(String(contender.cause)).toContain('CodeGraphStoreBusyError');

        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(owner)).toHaveLength(1);
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('preserves the typed maintenance sentinel under each strict writer gate', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), 'threadnote-reconciliation-intent-writer-gate-'));
        temporaryRoots.push(root);
        const databasePath = join(root, 'indexes', 'code-graph', 'repositories', checkoutId, 'graph-v3.sqlite');
        const store = yield* CodeGraphStore;
        yield* store.initialize(databasePath);
        const snapshotId = `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`;
        yield* Effect.sync(() => seedCandidateViews(databasePath, [targetWorktreeId], false));
        const refuse = () => Effect.fail(CodeGraphMaintenanceActiveError.of());

        const claim = yield* store
          .claimWorktreeReconciliationCandidates(databasePath, 1, {beforeDatabaseOpen: refuse})
          .pipe(Effect.exit);
        const remove = yield* store
          .removeView(databasePath, targetWorktreeId, snapshotId, {
            beforeDatabaseOpen: refuse,
            requireReconciliationSchema: true,
          })
          .pipe(Effect.exit);
        yield* Effect.sync(() => executeDatabaseSql(databasePath, 'DROP INDEX active_snapshots_snapshot_worktree'));
        const prepare = yield* store
          .prepareWorktreeReconciliationIndexes(databasePath, {beforeDatabaseOpen: refuse})
          .pipe(Effect.exit);

        for (const exit of [claim, remove, prepare]) {
          expect(exit._tag).toBe('Failure');
          if (exit._tag === 'Failure') expect(String(exit.cause)).toContain('CodeGraphMaintenanceActiveError');
        }
        expect(yield* Effect.sync(() => readExactRetirementState(databasePath, snapshotId))).toEqual({
          activeSnapshotId: snapshotId,
          readyOrphans: 0,
          removedSnapshotId: undefined,
          selectedState: 'ready',
        });
        expect(indexDefinition(databasePath, 'active_snapshots_snapshot_worktree')).toBeUndefined();
      }).pipe(provideTestLayer(storeLayer)),
    ),
  );

  effectIt.effect('reconciles one real removed linked worktree with exactly two bounded registry workers', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* createLiveReconciliationFixture('threadnote-reconciliation-live-remove-');
        const observed = yield* observedLiveReconciler;
        const provenanceBefore = readFileSync(fixture.provenancePath, 'utf8');
        const record: unknown = JSON.parse(provenanceBefore);
        expect(Schema.is(provenanceRecordSchema)(record)).toBe(true);
        if (!Schema.is(provenanceRecordSchema)(record))
          throw TestError.make({message: 'Expected worktree provenance record.'});
        expect(record).toMatchObject({registration: {kind: 'linked'}, schemaVersion: 2});

        yield* Effect.sync(() => removeLiveLinkedWorktree(fixture));
        expect(existsSync(fixture.linked)).toBe(false);
        expect(existsSync(fixture.adminPath)).toBe(false);
        const result = yield* observed.reconciler.tick(liveTick(fixture));

        expect(result).toMatchObject({
          expectedSnapshotId: fixture.snapshotId,
          state: 'removed',
          worktreeId: fixture.linkedIdentity.worktreeId,
        });
        expect(yield* Ref.get(observed.workerCalls)).toBe(2);
        const view = readViewState(fixture);
        expect(view.activeSnapshotId).toBeUndefined();
        expect(view.removedSnapshotId).toBe(fixture.snapshotId);
        expect(['retired', undefined]).toContain(view.snapshotState);
        expect(readFileSync(fixture.provenancePath, 'utf8')).toBe(provenanceBefore);
        expect(readFileSync(fixture.mainFile, 'utf8')).toBe('main source\n');
        expect(existsSync(join(fixture.main, '.git'))).toBe(true);
        expect(JSON.stringify(result)).not.toContain(fixture.root);
      }).pipe(provideTestLayer(liveLayer)),
    ),
  );

  effectIt.effect(
    'removes full and scoped missing-worktree views under their exact locks and preserves sibling views',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fixture = yield* createLiveReconciliationFixture('threadnote-reconciliation-scopes-');
          const scopeId = `code-graph-scope:${Effect2.pipe('a', EffectString.repeat(64))}`;
          const scopedSnapshotId = `cgsn_${Effect2.pipe('8', EffectString.repeat(40))}`;
          yield* Effect.sync(() => {
            const database = new Database(fixture.layout.databasePath, {strict: true});
            try {
              database
                .query(
                  `INSERT INTO snapshots (id, repository_id, worktree_id, scope_id, commit_id, extractor_set,
              dirty, state, file_count, symbol_count, edge_count, started_at, completed_at)
              SELECT ?, repository_id, worktree_id, ?, commit_id, extractor_set, dirty, state,
                file_count, symbol_count, edge_count, started_at, completed_at FROM snapshots WHERE id = ?`,
                )
                .run(scopedSnapshotId, scopeId, fixture.snapshotId);
              database
                .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
                .run(scopedSnapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
              database
                .query(
                  'INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at) VALUES (?, ?, ?, ?)',
                )
                .run(fixture.linkedIdentity.worktreeId, scopeId, scopedSnapshotId, '2026-08-08T00:00:00.000Z');
              database
                .query(
                  'INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at) VALUES (?, ?, ?, ?)',
                )
                .run(fixture.mainIdentity.worktreeId, scopeId, scopedSnapshotId, '2026-08-08T00:00:00.000Z');
            } finally {
              database.close(false);
            }
          });
          yield* Effect.sync(() => removeLiveLinkedWorktree(fixture));
          const reconciler = yield* makeLiveCodeGraphWorktreeReconciler();
          yield* withCodeGraphTargetWorktreeLock(
            fixture.home,
            fixture.linkedIdentity.checkoutId,
            fixture.linkedIdentity.worktreeId,
            Effect.gen(function* () {
              const result = yield* reconciler.tick(liveTick(fixture));
              expect(result).toMatchObject({reason: 'target-busy', state: 'deferred'});
            }),
            scopeId,
          );
          const store = yield* CodeGraphStore;
          expect(yield* reconciler.tick(liveTick(fixture))).toMatchObject({state: 'removed'});
          yield* Effect.sync(() => {
            const database = new Database(fixture.layout.databasePath, {strict: true});
            try {
              database.query("UPDATE removed_view_cleanup SET phase = 'provenance'").run();
            } finally {
              database.close(false);
            }
          });
          const [cleanup] = yield* store.claimRemovedViewCleanupCandidates(
            fixture.layout.databasePath,
            yield* Clock.currentTimeMillis,
            1,
          );
          expect(cleanup).toMatchObject({phase: 'provenance', scopeId});
          expect(yield* store.authorizeRemovedViewCleanup(fixture.layout.databasePath, cleanup)).toMatchObject({
            observedSnapshotId: fixture.snapshotId,
            state: 'active-pointer-changed',
          });
          expect(existsSync(fixture.provenancePath)).toBe(true);
          for (let index = 0; index < 3; index++) yield* reconciler.tick(liveTick(fixture));
          expect(yield* store.authorizeRemovedViewCleanup(fixture.layout.databasePath, cleanup)).toMatchObject({
            state: 'authorized',
          });
          expect(
            yield* store.loadActiveViewFence(fixture.layout.databasePath, fixture.linkedIdentity.worktreeId),
          ).toBeUndefined();
          expect(
            yield* store.loadActiveViewFence(fixture.layout.databasePath, fixture.linkedIdentity.worktreeId, scopeId),
          ).toBeUndefined();
          expect(
            (yield* store.loadActiveViewFence(fixture.layout.databasePath, fixture.mainIdentity.worktreeId, scopeId))
              ?.snapshotId,
          ).toBe(scopedSnapshotId);
          for (let index = 0; index < 4; index++)
            yield* store.runRoutineMaintenance(fixture.layout.databasePath, {
              checkoutId: fixture.linkedIdentity.checkoutId,
              threadnoteHome: fixture.home,
              writerLockPath: fixture.layout.databaseWriteLockPath,
            });
          expect(
            (yield* store.loadActiveViewFence(fixture.layout.databasePath, fixture.mainIdentity.worktreeId, scopeId))
              ?.snapshotId,
          ).toBe(scopedSnapshotId);
        }).pipe(provideTestLayer(liveLayer)),
      ),
  );

  effectIt.effect('preserves a real graph view when the recorded worktree path reappears', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* createLiveReconciliationFixture('threadnote-reconciliation-live-path-');
        const observed = yield* observedLiveReconciler;
        yield* Effect.sync(() => {
          removeLiveLinkedWorktree(fixture);
          mkdirSync(fixture.linked, {mode: 0o700});
          writeFileSync(join(fixture.linked, 'reappeared.txt'), 'preserve me\n');
        });

        const result = yield* observed.reconciler.tick(liveTick(fixture));

        expect(result).toMatchObject({reason: 'no-missing-candidates', state: 'preserved'});
        expect(yield* Ref.get(observed.workerCalls)).toBe(1);
        expect(readViewState(fixture)).toEqual({
          activeSnapshotId: fixture.snapshotId,
          removedSnapshotId: undefined,
          snapshotState: 'ready',
        });
        expect(readFileSync(join(fixture.linked, 'reappeared.txt'), 'utf8')).toBe('preserve me\n');
        expect(readFileSync(fixture.mainFile, 'utf8')).toBe('main source\n');
      }).pipe(provideTestLayer(liveLayer)),
    ),
  );

  effectIt.effect('defers and preserves a real graph view when the linked admin child reappears as a raw file', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* createLiveReconciliationFixture('threadnote-reconciliation-live-admin-');
        const observed = yield* observedLiveReconciler;
        yield* Effect.sync(() => {
          removeLiveLinkedWorktree(fixture);
          mkdirSync(dirname(fixture.adminPath), {mode: 0o700, recursive: true});
          writeFileSync(fixture.adminPath, 'partial admin child\n');
        });

        const result = yield* observed.reconciler.tick(liveTick(fixture));

        expect(result).toMatchObject({reason: 'registry-unavailable', state: 'deferred'});
        expect(yield* Ref.get(observed.workerCalls)).toBe(1);
        expect(readViewState(fixture)).toEqual({
          activeSnapshotId: fixture.snapshotId,
          removedSnapshotId: undefined,
          snapshotState: 'ready',
        });
        expect(readFileSync(fixture.adminPath, 'utf8')).toBe('partial admin child\n');
        expect(readFileSync(fixture.mainFile, 'utf8')).toBe('main source\n');
        expect(JSON.stringify(result)).not.toContain(fixture.root);
      }).pipe(provideTestLayer(liveLayer)),
    ),
  );

  effectIt.effect('converges one exact tombstone under eight real Bun process contenders', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fixture = yield* createLiveReconciliationFixture('threadnote-reconciliation-process-load-');
        yield* Effect.sync(() => removeLiveLinkedWorktree(fixture));
        const outcomes = yield* Effect.promise(() => runLiveReconciliationContenders(fixture, 8));
        const removed = EffectArray.filter(outcomes, outcome => outcome.state === 'removed');

        expect(removed).toHaveLength(1);
        expect(
          EffectArray.every(outcomes, outcome => {
            if (outcome.state === 'removed') return true;
            if (outcome.state === 'preserved') {
              return ['already-removed', 'no-candidates', 'stale-target'].includes(outcome.reason);
            }
            return outcome.reason === 'target-busy' || outcome.reason === 'writer-busy';
          }),
        ).toBe(true);
        expect(
          EffectArray.every(
            outcomes,
            outcome => !Effect2.pipe(JSON.stringify(outcome), EffectString.includes(fixture.root)),
          ),
        ).toBe(true);
        const view = readViewState(fixture);
        expect(view.activeSnapshotId).toBeUndefined();
        expect(view.removedSnapshotId).toBe(fixture.snapshotId);
        expect(['retired', undefined]).toContain(view.snapshotState);
        expect(readFileSync(fixture.mainFile, 'utf8')).toBe('main source\n');
        expect(existsSync(fixture.provenancePath)).toBe(true);
      }).pipe(provideTestLayer(liveLayer)),
    ),
  );

  fcEffectProp(
    effectIt,
    'mutates through the real reconciler iff every generated authority predicate is exact',
    {
      anchorMatches: fc.boolean(),
      evidenceStable: fc.boolean(),
      finalAbsent: fc.boolean(),
      initialAbsent: fc.boolean(),
      linkedRegistration: fc.boolean(),
      maintenanceInactive: fc.boolean(),
      missingProvenance: fc.boolean(),
      registryRootStable: fc.boolean(),
    },
    predicates =>
      Effect.gen(function* () {
        const removals = yield* Ref.make(0);
        let evidenceReads = 0;
        let authorityReads = 0;
        const dependencies = successfulDependencies({
          maintenanceIntentActive: () => Effect.succeed(!predicates.maintenanceInactive),
          observeAuthority: () =>
            Effect.sync(() => {
              authorityReads += 1;
              if (authorityReads === 1) {
                return {
                  ...absentBatch,
                  pathStates: [predicates.missingProvenance ? ('missing' as const) : ('present' as const)],
                  registryStates: [predicates.initialAbsent ? ('absent' as const) : ('present' as const)],
                };
              }
              return {
                ...absentFinal,
                registryRootIdentity: predicates.registryRootStable
                  ? absentFinal.registryRootIdentity
                  : Effect2.pipe('6', EffectString.repeat(64)),
                registryStates: [predicates.finalAbsent ? ('absent' as const) : ('present' as const)],
              };
            }),
          readEvidenceCandidate: () =>
            Effect.sync(() => {
              evidenceReads += 1;
              if (!predicates.linkedRegistration) return {state: 'main'} as const;
              return !predicates.evidenceStable && evidenceReads > 1
                ? {...linkedEvidence, recordIdentity: Effect2.pipe('8', EffectString.repeat(64))}
                : linkedEvidence;
            }),
          removeView: () => Ref.update(removals, count => count + 1).pipe(Effect.as(removedResult())),
          resolveAnchor: () =>
            Effect.succeed(
              predicates.anchorMatches ? anchor : {...anchor, repositoryId: Effect2.pipe('7', EffectString.repeat(64))},
            ),
        });

        const result = yield* (yield* makeCodeGraphWorktreeReconciler(dependencies)).tick(tick());
        const expected =
          predicates.anchorMatches &&
          predicates.evidenceStable &&
          predicates.finalAbsent &&
          predicates.initialAbsent &&
          predicates.linkedRegistration &&
          predicates.maintenanceInactive &&
          predicates.missingProvenance &&
          predicates.registryRootStable;
        expect(result.state === 'removed').toBe(expected);
        expect(yield* Ref.get(removals)).toBe(expected ? 1 : 0);
      }),
  );
});

interface LiveReconciliationFixture {
  readonly adminPath: string;
  readonly home: string;
  readonly layout: CodeGraphLayout;
  readonly linked: string;
  readonly linkedIdentity: RepositoryIdentity;
  readonly main: string;
  readonly mainFile: string;
  readonly mainIdentity: RepositoryIdentity;
  readonly provenancePath: string;
  readonly root: string;
  readonly snapshotId: string;
}

const observedLiveReconciler = Effect.gen(function* () {
  const command = yield* CommandExecutor;
  const workerCalls = yield* Ref.make(0);
  const countingCommand = CommandExecutor.of({
    execute: command.execute,
    executeBytes: (executable, args, options) =>
      Ref.update(
        workerCalls,
        count => count + (args.includes(CODE_GRAPH_GIT_WORKTREE_REGISTRATION_WORKER_ARGUMENT) ? 1 : 0),
      ).pipe(Effect.andThen(command.executeBytes!(executable, args, options))),
    executeStreaming: command.executeStreaming,
  });
  const reconciler = yield* makeLiveCodeGraphWorktreeReconciler().pipe(
    Effect.provideService(CommandExecutor, countingCommand),
  );
  return {reconciler, workerCalls};
});

function createLiveReconciliationFixture(prefix: string) {
  return Effect.gen(function* () {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temporaryRoots.push(root);
    const home = join(root, 'home');
    const main = join(root, 'main');
    const linked = join(root, 'linked');
    const mainFile = join(main, 'main.txt');
    yield* Effect.sync(() => {
      mkdirSync(home, {mode: 0o700});
      mkdirSync(main, {mode: 0o700});
      runGit(main, ['init', '-q']);
      runGit(main, ['config', 'user.name', 'Threadnote Test']);
      runGit(main, ['config', 'user.email', 'threadnote-test@example.invalid']);
      writeFileSync(mainFile, 'main source\n');
      runGit(main, ['add', 'main.txt']);
      runGit(main, ['commit', '-qm', 'initial']);
      runGit(main, ['worktree', 'add', '-q', '-b', 'e4-linked', linked]);
    });
    const mainIdentity = yield* resolveRepositoryIdentity(main);
    const linkedIdentity = yield* resolveRepositoryIdentity(linked);
    const adminPath = yield* Effect.sync(() =>
      Effect2.pipe(
        execFileSync('git', ['-C', linked, 'rev-parse', '--path-format=absolute', '--git-dir'], {
          encoding: 'utf8',
        }),
        EffectString.trim,
      ),
    );
    const association = yield* recordVerifiedCodeGraphLocalAssociation(home, linkedIdentity);
    if (association.state !== 'verified') {
      return yield* TestError.make({message: 'Could not record the exact linked-worktree provenance fixture.'});
    }
    const path = yield* Path.Path;
    const layout = codeGraphLayout(path, home, linkedIdentity.checkoutId, linkedIdentity.worktreeId);
    const snapshotId = `cgsn_${Effect2.pipe('9', EffectString.repeat(40))}`;
    const snapshot = {
      commit: linkedIdentity.headCommit,
      completedAt: '2026-08-08T00:00:00.000Z',
      dirty: false,
      edgeCount: 0,
      extractorSet: 'worktree-reconciliation-live-test',
      fileCount: 0,
      id: snapshotId,
      repositoryId: linkedIdentity.repositoryId,
      state: 'ready',
      symbolCount: 0,
      worktreeId: linkedIdentity.worktreeId,
    } satisfies CodeGraphSnapshot;
    const store = yield* CodeGraphStore;
    yield* store.activate(layout.databasePath, linkedIdentity, snapshot, [], [], []);
    yield* store.promote(layout.databasePath, linkedIdentity, snapshotId);
    const provenancePath = join(
      layout.repositoryRoot,
      'local-context',
      'worktrees',
      `${linkedIdentity.worktreeId}.json`,
    );
    if (!existsSync(provenancePath)) {
      return yield* TestError.make({message: 'The exact linked-worktree provenance fixture is missing.'});
    }
    return {
      adminPath,
      home,
      layout,
      linked,
      linkedIdentity,
      main,
      mainFile,
      mainIdentity,
      provenancePath,
      root,
      snapshotId,
    } satisfies LiveReconciliationFixture;
  });
}

function liveTick(fixture: LiveReconciliationFixture) {
  return {
    anchorIdentity: fixture.mainIdentity,
    checkoutId: fixture.mainIdentity.checkoutId,
    databasePath: fixture.layout.databasePath,
    threadnoteHome: fixture.home,
    writerLockPath: fixture.layout.databaseWriteLockPath,
  } as const;
}

function removeLiveLinkedWorktree(fixture: LiveReconciliationFixture): void {
  runGit(fixture.main, ['worktree', 'remove', '--force', fixture.linked]);
}

function readViewState(fixture: LiveReconciliationFixture): {
  readonly activeSnapshotId?: string;
  readonly removedSnapshotId?: string;
  readonly snapshotState?: string;
} {
  const database = new Database(fixture.layout.databasePath, {readonly: true, strict: true});
  try {
    const active = database
      .query<{readonly snapshot_id: string} | null, SQLQueryBindings[]>(
        'SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?',
      )
      .get(fixture.linkedIdentity.worktreeId);
    const removed = database
      .query<{readonly expected_snapshot_id: string} | null, SQLQueryBindings[]>(
        'SELECT expected_snapshot_id FROM removed_views WHERE worktree_id = ?',
      )
      .get(fixture.linkedIdentity.worktreeId);
    const snapshot = database
      .query<
        {
          readonly state: string;
        } | null,
        SQLQueryBindings[]
      >('SELECT state FROM snapshots WHERE id = ?')
      .get(fixture.snapshotId);
    return {
      activeSnapshotId: active?.snapshot_id,
      removedSnapshotId: removed?.expected_snapshot_id,
      snapshotState: snapshot?.state,
    };
  } finally {
    database.close(false);
  }
}

function runGit(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

async function runLiveReconciliationContenders(
  fixture: LiveReconciliationFixture,
  count: number,
): Promise<readonly CodeGraphWorktreeReconciliationResult[]> {
  const barrier = join(fixture.root, 'contender-barrier');
  mkdirSync(barrier, {mode: 0o700});
  const contenders = Array.from({length: count}, (_, index) => runLiveReconciliationContender(fixture, barrier, index));
  const completed = Promise.all(contenders);
  await Promise.race([
    waitForContenderBarrier(barrier, count, 10_000),
    completed.then(() =>
      Promise.reject(TestError.make({message: 'E4 contenders exited before the shared barrier was released.'})),
    ),
  ]);
  writeFileSync(join(barrier, 'release'), 'go\n', {mode: 0o600});
  return await completed;
}

async function runLiveReconciliationContender(
  fixture: LiveReconciliationFixture,
  barrier: string,
  contender: number,
): Promise<CodeGraphWorktreeReconciliationResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--eval', LIVE_RECONCILIATION_CONTENDER_SOURCE], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        THREADNOTE_E4_CONTENDER_ANCHOR: fixture.main,
        THREADNOTE_E4_CONTENDER_BARRIER: barrier,
        THREADNOTE_E4_CONTENDER_ID: String(contender),
        THREADNOTE_E4_CONTENDER_HOME: fixture.home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const maximumOutputCharacters = 64 * 1_024;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout = Effect2.pipe(`${stdout}${String(chunk)}`, EffectString.slice(-maximumOutputCharacters));
    });
    child.stderr.on('data', chunk => {
      stderr = Effect2.pipe(`${stderr}${String(chunk)}`, EffectString.slice(-maximumOutputCharacters));
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      const resultLine = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          Effect2.pipe(stdout, EffectString.split(/\r?\n/u)),
          __effectArrayValue =>
            !!(line => Effect2.pipe(line, EffectString.startsWith('THREADNOTE_E4_RESULT=')))(__effectArrayValue),
        ),
      );
      if (code !== 0 || resultLine === undefined) {
        reject(TestError.make({message: `E4 contender exited ${String(code)}: ${stderr || stdout}`}));
        return;
      }
      try {
        const result: unknown = JSON.parse(
          Effect2.pipe(resultLine, EffectString.slice('THREADNOTE_E4_RESULT='.length)),
        );
        if (!isCodeGraphWorktreeReconciliationResult(result)) {
          throw TestError.make({message: 'E4 contender returned an invalid reconciliation result.'});
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function waitForContenderBarrier(barrier: string, count: number, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    if (
      EffectArray.every(
        Array.from({length: count}, (_, index) => existsSync(join(barrier, `${index}.ready`))),
        Boolean,
      )
    )
      return;
    if (Date.now() >= deadline)
      throw TestError.make({message: 'E4 contenders did not reach the shared barrier in time.'});
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const LIVE_RECONCILIATION_CONTENDER_SOURCE = String.raw`
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer, Path} from 'effect';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from './apps/threadnote/test/helpers/system-layer.ts';

import {codeGraphLayout} from './packages/graph/src/layout.ts';
import {resolveRepositoryIdentity} from './packages/graph/src/repository.ts';
import {CodeGraphStore} from './packages/graph/src/store.ts';
import {makeLiveCodeGraphWorktreeReconciler} from './packages/graph/src/worktree_reconciliation.ts';

const layer = Layer.merge(CodeGraphStore.layer, TestCommandExecutorLayer).pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const home = process.env.THREADNOTE_E4_CONTENDER_HOME;
    const anchorPath = process.env.THREADNOTE_E4_CONTENDER_ANCHOR;
    const barrier = process.env.THREADNOTE_E4_CONTENDER_BARRIER;
    const contender = process.env.THREADNOTE_E4_CONTENDER_ID;
    if (!home || !anchorPath || !barrier || !contender) {
      return yield* Error.make({message: 'E4 contender fixture is unavailable.'});
    }
    const anchor = yield* resolveRepositoryIdentity(anchorPath);
    const path = yield* Path.Path;
    const layout = codeGraphLayout(path, home, anchor.checkoutId, anchor.worktreeId);
    const reconciler = yield* makeLiveCodeGraphWorktreeReconciler();
    yield* Effect.promise(async () => {
      await Bun.write(barrier + '/' + contender + '.ready', 'ready\n');
      while (!(await Bun.file(barrier + '/release').exists())) await Bun.sleep(5);
    });
    return yield* reconciler.tick({
      anchorIdentity: anchor,
      checkoutId: anchor.checkoutId,
      databasePath: layout.databasePath,
      threadnoteHome: home,
      writerLockPath: layout.databaseWriteLockPath,
    });
  }).pipe(Effect.provide(layer)),
);
process.stdout.write('THREADNOTE_E4_RESULT=' + JSON.stringify(result) + '\n');
`;

function authoritySequence(
  initial: CodeGraphWorktreeReconciliationAuthorityObservation,
  final: CodeGraphWorktreeReconciliationAuthorityObservation,
): () => Effect.Effect<CodeGraphWorktreeReconciliationAuthorityObservation> {
  let calls = 0;
  return () =>
    Effect.sync(() => {
      calls += 1;
      return calls === 1 ? initial : final;
    });
}

function successfulDependencies(
  overrides: Partial<CodeGraphWorktreeReconciliationDependencies> = {},
): CodeGraphWorktreeReconciliationDependencies {
  return {
    listCandidates: () => Effect.succeed([candidate]),
    maintenanceIntentActive: () => Effect.succeed(false),
    observeAuthority: () => Effect.succeed(absentBatch),
    readEvidenceCandidate: () => Effect.succeed(linkedEvidence),
    removeView: () => Effect.succeed(removedResult()),
    resolveAnchor: () => Effect.succeed(anchor),
    withTargetLock: (_input, _worktreeId, effect) => effect,
    ...overrides,
  };
}

function removedResult(): CodeGraphViewRemovalResult {
  return {expectedSnapshotId, retiredSnapshots: 1, state: 'removed'};
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

function append(ref: Ref.Ref<string[]>, event: string) {
  return Ref.update(ref, events => [...events, event]);
}

function seedCandidateViews(databasePath: string, worktreeIds: readonly string[], tombstoneLast = true): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'threadnote/reconciliation-cursor', 'sha1', ?, ?)`,
      )
      .run(repositoryId, new Date(0).toISOString(), new Date(0).toISOString());
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, NULL, 'reconciliation-test', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    const insertGeneration = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    const insertView = database.prepare(
      'INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)',
    );
    database.transaction(() => {
      for (const [index, worktreeId] of worktreeIds.entries()) {
        const snapshotId = `cgsn_${Effect2.pipe(index.toString(16), EffectString.padStart(40, '0'))}`;
        insertSnapshot.run(
          snapshotId,
          repositoryId,
          worktreeId,
          Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
          `content-${index}`,
          new Date(index).toISOString(),
          new Date(index + 1).toISOString(),
        );
        insertGeneration.run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
        insertView.run(worktreeId, snapshotId, new Date(index + 100).toISOString());
      }
      if (tombstoneLast) {
        database
          .query('INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)')
          .run(
            worktreeIds.at(-1)!,
            `cgsn_${Effect2.pipe((worktreeIds.length - 1).toString(16), EffectString.padStart(40, '0'))}`,
            new Date().toISOString(),
          );
      }
    })();
  } finally {
    database.close(false);
  }
}

function tombstoneEveryActiveView(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run(`INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at)
      SELECT worktree_id, snapshot_id, '2026-08-08T00:00:00.000Z'
      FROM active_snapshots
      WHERE 1
      ON CONFLICT(worktree_id, scope_id) DO UPDATE SET expected_snapshot_id = excluded.expected_snapshot_id`);
  } finally {
    database.close(false);
  }
}

function removeViewTombstone(databasePath: string, worktreeId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query('DELETE FROM removed_views WHERE worktree_id = ?').run(worktreeId);
  } finally {
    database.close(false);
  }
}

function readReconciliationCursor(databasePath: string): string | undefined {
  return readSchemaMetadataValue(databasePath, 'worktree_reconciliation_cursor');
}

function readSchemaMetadataValue(databasePath: string, key: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query<
        {
          readonly value: string;
        } | null,
        SQLQueryBindings[]
      >('SELECT value FROM schema_metadata WHERE key = ? COLLATE BINARY')
      .get(key);
    return row?.value;
  } finally {
    database.close(false);
  }
}

function readSchemaMetadataFamily(
  databasePath: string,
  key: string,
): readonly {readonly key: string; readonly value: string}[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly key: string; readonly value: string}, SQLQueryBindings[]>(
        'SELECT key, value FROM schema_metadata WHERE key = ? COLLATE NOCASE ORDER BY key',
      )
      .all(key);
  } finally {
    database.close(false);
  }
}

function readSchemaMetadataCount(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = requiredRow(
      database
        .query<{readonly count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM schema_metadata')
        .get(),
    );
    return Number(row.count);
  } finally {
    database.close(false);
  }
}

function insertSchemaMetadata(databasePath: string, key: string, value: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query('INSERT INTO schema_metadata (key, value) VALUES (?, ?)').run(key, value);
  } finally {
    database.close(false);
  }
}

function writeReconciliationCursor(databasePath: string, value: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO schema_metadata (key, value) VALUES ('worktree_reconciliation_cursor', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(value);
  } finally {
    database.close(false);
  }
}

function fillSchemaMetadataToCount(databasePath: string, targetCount: number): readonly string[] {
  const database = new Database(databasePath, {strict: true});
  try {
    const current = Number(
      requiredRow(
        database.query<{count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM schema_metadata').get(),
      ).count,
    );
    const keys = Array.from(
      {length: Math.max(0, targetCount - current)},
      (_, index) =>
        `reconciliation_cursor_capacity_${Effect2.pipe((current + index).toString(), EffectString.padStart(2, '0'))}`,
    );
    const insert = database.prepare('INSERT INTO schema_metadata (key, value) VALUES (?, ?)');
    database.transaction(() => {
      for (const key of keys) insert.run(key, 'bounded-fixture');
    })();
    return keys;
  } finally {
    database.close(false);
  }
}

function deleteSchemaMetadata(databasePath: string, key: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query('DELETE FROM schema_metadata WHERE key = ? COLLATE BINARY').run(key);
  } finally {
    database.close(false);
  }
}

function republishLegacyActivePointer(
  databasePath: string,
  worktreeId: string,
  snapshotId: string,
  exactTombstone: boolean,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    if (!exactTombstone) {
      database
        .query('UPDATE removed_views SET expected_snapshot_id = ? WHERE worktree_id = ?')
        .run(`cgsn_${Effect2.pipe('f', EffectString.repeat(40))}`, worktreeId);
    }
    database
      .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
      .run(worktreeId, snapshotId, '2026-08-08T00:00:00.000Z');
  } finally {
    database.close(false);
  }
}

function readLegacyRepublishState(
  databasePath: string,
  worktreeId: string,
  snapshotId: string,
): {readonly activeSnapshotId?: string; readonly removedSnapshotId?: string; readonly snapshotState?: string} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const active = database
      .query<
        {
          readonly snapshot_id: string;
        } | null,
        SQLQueryBindings[]
      >('SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?')
      .get(worktreeId);
    const removed = database
      .query<{readonly expected_snapshot_id: string} | null, SQLQueryBindings[]>(
        'SELECT expected_snapshot_id FROM removed_views WHERE worktree_id = ?',
      )
      .get(worktreeId);
    const snapshot = database
      .query<
        {
          readonly state: string;
        } | null,
        SQLQueryBindings[]
      >('SELECT state FROM snapshots WHERE id = ?')
      .get(snapshotId);
    return {
      activeSnapshotId: active?.snapshot_id,
      removedSnapshotId: removed?.expected_snapshot_id,
      snapshotState: snapshot?.state,
    };
  } finally {
    database.close(false);
  }
}

function seedBlockedDescendantChain(databasePath: string, baseSnapshotId: string, count: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insert = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, ?, 'reconciliation-test', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    database.transaction(() => {
      let parent = baseSnapshotId;
      for (let index = 1; index <= count; index += 1) {
        const snapshotId = `cgsn_${Effect2.pipe(index.toString(16), EffectString.padStart(40, '0'))}`;
        insert.run(
          snapshotId,
          repositoryId,
          Effect2.pipe((index + 20_000).toString(16), EffectString.padStart(64, '0')),
          Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
          `descendant-content-${index}`,
          parent,
          new Date(index).toISOString(),
          new Date(index + 1).toISOString(),
        );
        parent = snapshotId;
      }
    })();
  } finally {
    database.close(false);
  }
}

function queryPlan(
  databasePath: string,
  statement: {readonly parameters: readonly (number | string)[]; readonly text: string},
): readonly {readonly detail: string}[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<
        {
          readonly detail: string;
        },
        SQLQueryBindings[]
      >(`EXPLAIN QUERY PLAN ${statement.text}`)
      .all(...statement.parameters);
  } finally {
    database.close(false);
  }
}

function seedIncompatibleDeleteJournalDatabase(databasePath: string): void {
  const database = new Database(databasePath, {create: true, strict: true});
  try {
    database.run('PRAGMA journal_mode = DELETE');
    database.run('CREATE TABLE schema_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
    database.query('INSERT INTO schema_metadata (key, value) VALUES (?, ?)').run('schema_version', '3');
  } finally {
    database.close(false);
  }
}

function readJournalMode(databasePath: string): string {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = requiredRow(
      database.query<{readonly journal_mode: string}, SQLQueryBindings[]>('PRAGMA journal_mode').get(),
    );
    return row.journal_mode;
  } finally {
    database.close(false);
  }
}

function executeDatabaseSql(databasePath: string, sql: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run(sql);
  } finally {
    database.close(false);
  }
}

function rebuildCanonicalTableDefinition(
  databasePath: string,
  tableName: string,
  mutate: (definition: string) => string,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const row = database
      .query<
        {
          readonly sql: string;
        } | null,
        SQLQueryBindings[]
      >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName);
    if (row === null) throw TestError.make({message: `missing canonical table ${tableName}`});
    const changed = mutate(row.sql);
    if (changed === row.sql) throw TestError.make({message: `canonical table mutation did not change ${tableName}`});
    const temporaryTable = `${tableName}_drift_fixture`;
    const temporaryDefinition = Effect2.pipe(
      changed,
      EffectString.replace(
        new RegExp(`^CREATE TABLE(?: IF NOT EXISTS)? "?${tableName}"?`, 'u'),
        `CREATE TABLE ${temporaryTable}`,
      ),
    );
    if (temporaryDefinition === changed)
      throw TestError.make({message: `cannot derive temporary table for ${tableName}`});
    const columns = EffectArray.join(
      EffectArray.map(
        EffectArray.filter(
          database
            .query<
              {
                readonly hidden: number;
                readonly name: string;
              },
              SQLQueryBindings[]
            >(`PRAGMA table_xinfo('${tableName}')`)
            .all(),
          column => column.hidden === 0,
        ),
        column => `"${Effect2.pipe(column.name, EffectString.replaceAll('"', '""'))}"`,
      ),
      ', ',
    );
    const dependentDefinitions = EffectArray.map(
      database
        .query<{readonly sql: string}, [string]>(
          `SELECT sql FROM sqlite_master
         WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
         ORDER BY type, name`,
        )
        .all(tableName),
      dependent => dependent.sql,
    );
    database.run('PRAGMA foreign_keys = OFF');
    database.run('PRAGMA ignore_check_constraints = ON');
    database.run('BEGIN IMMEDIATE');
    try {
      database.run(temporaryDefinition);
      database.run(`INSERT INTO "${temporaryTable}" (${columns}) SELECT ${columns} FROM "${tableName}"`);
      database.run(`DROP TABLE "${tableName}"`);
      database.run(changed);
      database.run(`INSERT INTO "${tableName}" (${columns}) SELECT ${columns} FROM "${temporaryTable}"`);
      database.run(`DROP TABLE "${temporaryTable}"`);
      for (const dependent of dependentDefinitions) database.run(dependent);
      database.run('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.run('ROLLBACK');
      throw error;
    } finally {
      database.run('PRAGMA ignore_check_constraints = OFF');
      database.run('PRAGMA foreign_keys = ON');
    }
  } finally {
    database.close(false);
  }
}

function indexDefinition(databasePath: string, index: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query<
        {
          readonly sql: string;
        } | null,
        SQLQueryBindings[]
      >("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(index);
    return row?.sql;
  } finally {
    database.close(false);
  }
}

function extensionDefinitionAndRows(databasePath: string): {
  readonly definition: string | undefined;
  readonly rows: readonly {readonly payload: string; readonly sentinel: string}[];
} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const definition = database
      .query<{readonly sql: string} | null, SQLQueryBindings[]>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'snapshot_analysis_summary_receipts'",
      )
      .get();
    const rows = database
      .query<{readonly payload: string; readonly sentinel: string}, SQLQueryBindings[]>(
        'SELECT sentinel, payload FROM snapshot_analysis_summary_receipts ORDER BY sentinel',
      )
      .all();
    return {definition: definition?.sql, rows};
  } finally {
    database.close(false);
  }
}

function seedReadyOrphanSnapshots(databasePath: string, count: number, startIndex: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, NULL, 'reconciliation-test', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    const insertGeneration = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    database.transaction(() => {
      for (let offset = 0; offset < count; offset += 1) {
        const index = startIndex + offset;
        const snapshotId = `cgsn_${Effect2.pipe(index.toString(16), EffectString.padStart(40, '0'))}`;
        insertSnapshot.run(
          snapshotId,
          repositoryId,
          Effect2.pipe((index + 10_000).toString(16), EffectString.padStart(64, '0')),
          Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
          `orphan-content-${index}`,
          new Date(index).toISOString(),
          new Date(index + 1).toISOString(),
        );
        insertGeneration.run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
      }
    })();
  } finally {
    database.close(false);
  }
}

function seedRetirementProtectionGraph(databasePath: string, snapshotIds: readonly string[]): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, ?, 'reconciliation-test', 0, NULL, ?, 0, 0, 0, ?, ?, NULL)`,
    );
    const insertGeneration = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    const insertActive = database.prepare(
      'INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)',
    );
    const insertDerived = (id: string, worktreeId: string, baseSnapshotId: string, state: 'ready' | 'retired') => {
      insertSnapshot.run(
        id,
        repositoryId,
        worktreeId,
        Effect2.pipe('f', EffectString.repeat(40)),
        `derived-${id}`,
        baseSnapshotId,
        state,
        new Date(20_000).toISOString(),
        new Date(20_001).toISOString(),
      );
      insertGeneration.run(id, CODE_GRAPH_EXTRACTOR_GENERATION);
    };
    database.transaction(() => {
      const warmChild = `cgsn_${Effect2.pipe('a', EffectString.repeat(40))}`;
      insertDerived(warmChild, Effect2.pipe('6', EffectString.repeat(64)), snapshotIds[1], 'ready');

      insertActive.run(Effect2.pipe('9', EffectString.repeat(64)), snapshotIds[2], new Date(30_000).toISOString());

      const retiredIntermediate = `cgsn_${Effect2.pipe('b', EffectString.repeat(40))}`;
      const activeGrandchild = `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}`;
      insertDerived(retiredIntermediate, Effect2.pipe('7', EffectString.repeat(64)), snapshotIds[3], 'retired');
      insertDerived(activeGrandchild, Effect2.pipe('8', EffectString.repeat(64)), retiredIntermediate, 'ready');
      insertActive.run(Effect2.pipe('8', EffectString.repeat(64)), activeGrandchild, new Date(30_001).toISOString());

      database
        .query(
          `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
           VALUES ('expired-only', ?, ?, 0)`,
        )
        .run(snapshotIds[4], Date.now() - 1);
    })();
  } finally {
    database.close(false);
  }
}

function seedReadySnapshotChild(databasePath: string, baseSnapshotId: string, childSnapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO snapshots (
           id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
           dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
           failure_summary
         ) SELECT ?, repository_id, ?, commit_id, ?, ?, extractor_set,
             dirty, overlay_fingerprint, 'ready', 0, 0, 0, started_at, completed_at, NULL
           FROM snapshots WHERE id = ?`,
      )
      .run(
        childSnapshotId,
        Effect2.pipe('e', EffectString.repeat(64)),
        `child-${childSnapshotId}`,
        baseSnapshotId,
        baseSnapshotId,
      );
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run(childSnapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
  } finally {
    database.close(false);
  }
}

function seedLeaseReleaseCounterexample(
  databasePath: string,
  baseSnapshotId: string,
  targetSnapshotId: string,
  blockingChildId: string,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const clone = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) SELECT ?, repository_id, ?, commit_id, ?, ?, extractor_set,
           dirty, overlay_fingerprint, 'ready', 0, 0, 0, started_at, completed_at, NULL
         FROM snapshots WHERE id = ?`,
    );
    const generation = database.prepare(
      'INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)',
    );
    database.transaction(() => {
      clone.run(
        baseSnapshotId,
        Effect2.pipe('3', EffectString.repeat(64)),
        `base-${baseSnapshotId}`,
        null,
        targetSnapshotId,
      );
      generation.run(baseSnapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
      database.query('UPDATE snapshots SET base_snapshot_id = ? WHERE id = ?').run(baseSnapshotId, targetSnapshotId);
      clone.run(
        blockingChildId,
        Effect2.pipe('4', EffectString.repeat(64)),
        `child-${blockingChildId}`,
        targetSnapshotId,
        targetSnapshotId,
      );
      generation.run(blockingChildId, CODE_GRAPH_EXTRACTOR_GENERATION);
    })();
  } finally {
    database.close(false);
  }
}

function readExactRetirementState(databasePath: string, selectedSnapshotId: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const active = database
      .query<{readonly snapshot_id: string} | null, SQLQueryBindings[]>(
        'SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ?',
      )
      .get(targetWorktreeId);
    const removed = database
      .query<{readonly expected_snapshot_id: string} | null, SQLQueryBindings[]>(
        'SELECT expected_snapshot_id FROM removed_views WHERE worktree_id = ?',
      )
      .get(targetWorktreeId);
    const selected = database
      .query<
        {
          readonly state: string;
        } | null,
        SQLQueryBindings[]
      >('SELECT state FROM snapshots WHERE id = ?')
      .get(selectedSnapshotId);
    const ready = requiredRow(
      database
        .query<{readonly count: number}, SQLQueryBindings[]>(
          "SELECT COUNT(*) AS count FROM snapshots WHERE id <> ? AND state = 'ready'",
        )
        .get(selectedSnapshotId),
    );
    return {
      activeSnapshotId: active?.snapshot_id,
      readyOrphans: Number(ready.count),
      removedSnapshotId: removed?.expected_snapshot_id,
      selectedState: selected?.state,
    };
  } finally {
    database.close(false);
  }
}

function readSnapshotStates(databasePath: string, snapshotIds: readonly string[]) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const rows = database
      .query<
        {
          readonly id: string;
          readonly state: string;
        },
        SQLQueryBindings[]
      >('SELECT id, state FROM snapshots')
      .all();
    const stateById = new Map(EffectArray.map(rows, row => [row.id, row.state]));
    return EffectArray.map(snapshotIds, id => ({id, state: stateById.get(id)}));
  } finally {
    database.close(false);
  }
}

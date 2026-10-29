import {Array as EffectArray} from 'effect';
import {systemRuntimeBoundaries} from '../helpers/system-runtime-boundaries.js';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Deferred, Duration, Effect, Fiber, FileSystem, Layer, Path, Ref, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  CODE_GRAPH_AUTOMATIC_COMPACTION_INPUT_BYTES_MAXIMUM,
  automaticCompactionWorkerEnvironment,
  claimCodeGraphAutomaticCompactionCandidate,
  codeGraphAutomaticCompactionCandidateAllowed,
  codeGraphAutomaticCompactionCheckoutWindow,
  codeGraphAutomaticCompactionWorkerInvocation,
  compactCodeGraphStorageIsolated,
  decodeAutomaticCompactionWorkerRequest,
  decodeAutomaticCompactionWorkerResponse,
  listCodeGraphAutomaticCompactionCheckoutIds,
  recordCodeGraphAutomaticCompactionAttempt,
  runCodeGraphAutomaticCompactionSchedulerWith,
  runCodeGraphAutomaticCompactionLoopWith,
  runCodeGraphAutomaticCompactionPassWith,
  selectCodeGraphAutomaticCompactionCandidate,
  type CodeGraphAutomaticCompactionCandidate,
  type CodeGraphAutomaticCompactionResult,
} from '@threadnote/graph/automatic/compaction';
import {codeGraphRepositoriesRoot, codeGraphRepositoryRoot} from '@threadnote/graph/layout';
import {managerGraphStorageStatusCheckoutIds, managerGraphStorageSummary} from '@threadnote/graph/manager/status';
import {compactCodeGraphStorage, type CodeGraphActiveStorage} from '@threadnote/graph/storage';
import {CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES} from '@threadnote/graph/store/session';
import {CODE_GRAPH_SCHEMA_VERSION} from '@threadnote/graph/types';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const GIB = 1024 * 1024 * 1024;
const AUTOMATIC_COMPACTION_RECEIPT_FILE = 'automatic-compaction-v1.json';
const AutomaticCompactionReceiptTestLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const AutomaticCompactionIsolatedTestLayer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

class AutomaticCompactionTestError extends Schema.TaggedError<
  AutomaticCompactionTestError,
  {readonly brand: unique symbol}
>()('AutomaticCompactionTestError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

function availableStorage(
  checkoutId: string,
  options: {
    readonly availableBytes?: number;
    readonly opportunityBytes: number;
    readonly journalBytes?: number;
    readonly reason?: 'freelist' | 'freelist-and-fragmentation';
    readonly reclaimableBytes?: number;
    readonly recommended?: boolean;
    readonly walBytes?: number;
  },
): CodeGraphActiveStorage {
  const databaseBytes = 4 * GIB;
  const reclaimableBytes = options.reclaimableBytes ?? options.opportunityBytes;
  const walBytes = options.walBytes ?? 0;
  const journalBytes = options.journalBytes ?? 0;
  return {
    ...(options.availableBytes === undefined ? {} : {availableBytes: options.availableBytes}),
    checkoutId,
    databaseBytes,
    databasePath: `/redacted/${checkoutId}`,
    filesystemBytes: databaseBytes + walBytes + journalBytes,
    journalBytes,
    pageStorage: {
      compactionOpportunityBytes: options.opportunityBytes,
      compactionOpportunityRatio: options.opportunityBytes / databaseBytes,
      freelistPages: reclaimableBytes / 4096,
      pageCount: databaseBytes / 4096,
      pageSize: 4096,
      reclaimableBytes,
      reclaimableRatio: reclaimableBytes / databaseBytes,
      state: 'available',
      threshold: {
        minimumReclaimableBytes: 512 * 1024 * 1024,
        minimumReclaimableRatio: 0.2,
        recommended: options.recommended ?? true,
        ...(options.recommended === false ? {} : {reason: options.reason ?? 'freelist'}),
      },
    },
    shmBytes: 0,
    state: 'available',
    temporaryBytes: 0,
    totalBytes: databaseBytes + walBytes + journalBytes,
    walBytes,
  };
}

function compactedSummary(checkoutId: string): CodeGraphAutomaticCompactionResult {
  return {
    action: 'compacted',
    checkoutId,
    reclaimedBytes: GIB,
  };
}

function compactionCandidate(checkoutId: string): CodeGraphAutomaticCompactionCandidate {
  return {
    checkoutId,
    opportunityBytes: GIB,
    opportunityRatio: 0.25,
  };
}

function makeCompactionReceiptFixture(checkoutId: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-automatic-compaction-receipt-'});
    const repositoryRoot = codeGraphRepositoryRoot(path, home, checkoutId);
    yield* fs.makeDirectory(repositoryRoot, {mode: 0o700, recursive: true});
    return {fs, home, path, repositoryRoot};
  });
}

describe('automatic code graph compaction', () => {
  it('reports physical, in-use, and reusable bytes without exposing a local path', () => {
    const storage = availableStorage(Effect2.pipe('a', EffectString.repeat(64)), {
      availableBytes: 16 * GIB,
      opportunityBytes: GIB,
    });
    const summary = managerGraphStorageSummary(storage);

    expect(summary).toMatchObject({
      databaseBytes: 4 * GIB,
      pageStorage: {
        allocatedBytes: 4 * GIB,
        automaticCompaction: 'eligible',
        inUseBytes: 3 * GIB,
        reusableBytes: GIB,
        state: 'available',
      },
      physicalBytes: 4 * GIB,
      state: 'available',
    });
    expect(JSON.stringify(summary)).not.toContain('/redacted/');
  });

  it('distinguishes unknown disk capacity from verified insufficient space', () => {
    const unknown = managerGraphStorageSummary(
      availableStorage(Effect2.pipe('a', EffectString.repeat(64)), {opportunityBytes: GIB}),
    );
    const insufficient = managerGraphStorageSummary(
      availableStorage(Effect2.pipe('b', EffectString.repeat(64)), {availableBytes: GIB, opportunityBytes: GIB}),
    );

    expect(unknown).toMatchObject({pageStorage: {automaticCompaction: 'space-unknown'}});
    expect(insufficient).toMatchObject({pageStorage: {automaticCompaction: 'waiting-for-space'}});
  });

  it('prioritizes an active repository beyond the bounded lexical prefix', () => {
    const statuses = Array.from({length: 10}, (_, index) => ({
      identity: {checkoutId: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0'))},
      state: index === 9 ? ('running' as const) : ('completed' as const),
      timestamps: {
        lastProgressAt: `2026-08-12T00:00:${Effect2.pipe(index.toString(), EffectString.padStart(2, '0'))}.000Z`,
      },
    }));
    const selected = managerGraphStorageStatusCheckoutIds(statuses);

    expect(selected).toHaveLength(8);
    expect(selected[0]).toBe(Effect2.pipe('9', EffectString.padStart(64, '0')));
  });

  effectIt.layer(AutomaticCompactionReceiptTestLayer)(it => {
    it.effect('fails explicitly instead of scanning an unbounded repository inventory', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-automatic-compaction-inventory-'});
        const repositories = codeGraphRepositoriesRoot(path, home);
        yield* fs.makeDirectory(repositories, {mode: 0o700, recursive: true});
        yield* Effect.forEach(
          Array.from({length: 129}, (_, index) => Effect2.pipe(index.toString(16), EffectString.padStart(64, '0'))),
          checkoutId => fs.makeDirectory(path.join(repositories, checkoutId), {mode: 0o700}),
          {concurrency: 8},
        );

        expect(yield* Effect.exit(listCodeGraphAutomaticCompactionCheckoutIds(home))).toMatchObject({
          _tag: 'Failure',
        });
      }),
    );

    it.effect('excludes a checkout symlink before automatic storage inspection', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkoutId = Effect2.pipe('f', EffectString.repeat(64));
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-automatic-compaction-list-link-'});
        const external = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-automatic-compaction-external-'});
        const repositories = codeGraphRepositoriesRoot(path, home);
        yield* fs.makeDirectory(repositories, {mode: 0o700, recursive: true});
        yield* fs.writeFileString(path.join(external, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`), '', {mode: 0o600});
        yield* fs.symlink(external, codeGraphRepositoryRoot(path, home, checkoutId));

        expect(yield* listCodeGraphAutomaticCompactionCheckoutIds(home)).toEqual([]);
      }),
    );

    it.effect('selects a sidecar checkpoint over structural-only VACUUM work without disk headroom', () =>
      Effect.gen(function* () {
        const checkoutId = Effect2.pipe('e', EffectString.repeat(64));
        const compacted = yield* Ref.make<readonly {readonly checkoutId: string; readonly operation: string}[]>([]);
        const result = yield* runCodeGraphAutomaticCompactionPassWith(
          {
            compact: (_home, candidate, options) =>
              Ref.update(compacted, current => [
                ...current,
                {checkoutId: candidate, operation: options?.operation ?? 'none'},
              ]).pipe(Effect.as(compactedSummary(candidate))),
            inspect: () =>
              Effect.succeed(
                availableStorage(checkoutId, {
                  availableBytes: 0,
                  opportunityBytes: GIB,
                  reason: 'freelist-and-fragmentation',
                  reclaimableBytes: 0,
                  walBytes: CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES + 1_024,
                }),
              ),
            listCheckoutIds: () => Effect.succeed([checkoutId]),
          },
          '/threadnote-home',
        );

        expect(result).toMatchObject({
          candidate: {checkoutId, operation: 'journal', opportunityBytes: 1_024},
          result: {action: 'compacted'},
          state: 'attempted',
        });
        expect(yield* Ref.get(compacted)).toEqual([{checkoutId, operation: 'journal'}]);
      }),
    );

    it.effect('does not select a rollback journal that checkpoint-only maintenance cannot shrink', () =>
      Effect.gen(function* () {
        const checkoutId = Effect2.pipe('f', EffectString.repeat(64));
        const compacted = yield* Ref.make(false);
        const result = yield* runCodeGraphAutomaticCompactionPassWith(
          {
            compact: () => Ref.set(compacted, true).pipe(Effect.as(compactedSummary(checkoutId))),
            inspect: () =>
              Effect.succeed(
                availableStorage(checkoutId, {
                  availableBytes: 0,
                  journalBytes: CODE_GRAPH_WAL_JOURNAL_SIZE_LIMIT_BYTES + 1_024,
                  opportunityBytes: 0,
                  recommended: false,
                }),
              ),
            listCheckoutIds: () => Effect.succeed([checkoutId]),
          },
          '/threadnote-home',
        );

        expect(result).toMatchObject({state: 'no-candidate'});
        expect(yield* Ref.get(compacted)).toBe(false);
      }),
    );

    it.effect('allows exactly one winner when two Managers concurrently claim the same repository', () =>
      Effect.gen(function* () {
        const checkoutId = Effect2.pipe('1', EffectString.repeat(64));
        const candidate = compactionCandidate(checkoutId);
        const {home} = yield* makeCompactionReceiptFixture(checkoutId);

        const claims = yield* Effect.all(
          [
            claimCodeGraphAutomaticCompactionCandidate(home, candidate),
            claimCodeGraphAutomaticCompactionCandidate(home, candidate),
          ],
          {concurrency: 'unbounded'},
        );

        expect(EffectArray.filter(claims, Boolean)).toHaveLength(1);
        expect(yield* codeGraphAutomaticCompactionCandidateAllowed(home, candidate)).toBe(false);
      }),
    );

    it.effect('persists low-yield success and failure cooldowns across fresh scheduler passes', () =>
      Effect.gen(function* () {
        const lowYieldId = Effect2.pipe('2', EffectString.repeat(64));
        const failedId = Effect2.pipe('3', EffectString.repeat(64));
        const lowYield = compactionCandidate(lowYieldId);
        const failed = compactionCandidate(failedId);
        const {fs, home, path} = yield* makeCompactionReceiptFixture(lowYieldId);
        yield* fs.makeDirectory(codeGraphRepositoryRoot(path, home, failedId), {mode: 0o700, recursive: true});
        yield* recordCodeGraphAutomaticCompactionAttempt(home, lowYield, {
          action: 'compacted',
          reclaimedBytes: 1,
        });
        yield* recordCodeGraphAutomaticCompactionAttempt(home, failed, undefined);
        const compacted = yield* Ref.make<string[]>([]);

        for (const candidate of [lowYield, failed]) {
          const outcome = yield* runCodeGraphAutomaticCompactionPassWith(
            {
              candidateAllowed: codeGraphAutomaticCompactionCandidateAllowed,
              claimCandidate: claimCodeGraphAutomaticCompactionCandidate,
              compact: (_threadnoteHome, checkoutId) =>
                Ref.update(compacted, current => [...current, checkoutId]).pipe(
                  Effect.as(compactedSummary(checkoutId)),
                ),
              inspect: () =>
                Effect.succeed(
                  availableStorage(candidate.checkoutId, {availableBytes: 16 * GIB, opportunityBytes: GIB}),
                ),
              listCheckoutIds: () => Effect.succeed([candidate.checkoutId]),
            },
            home,
          );

          expect(outcome).toMatchObject({state: 'no-candidate'});
          expect(yield* claimCodeGraphAutomaticCompactionCandidate(home, candidate)).toBe(false);
        }
        expect(yield* Ref.get(compacted)).toEqual([]);
      }),
    );

    it.effect('fails closed for malformed and oversized receipts', () =>
      Effect.gen(function* () {
        const malformedId = Effect2.pipe('4', EffectString.repeat(64));
        const oversizedId = Effect2.pipe('5', EffectString.repeat(64));
        const malformed = compactionCandidate(malformedId);
        const oversized = compactionCandidate(oversizedId);
        const {fs, home, path, repositoryRoot} = yield* makeCompactionReceiptFixture(malformedId);
        const oversizedRoot = codeGraphRepositoryRoot(path, home, oversizedId);
        yield* fs.makeDirectory(oversizedRoot, {mode: 0o700, recursive: true});
        yield* fs.writeFileString(path.join(repositoryRoot, AUTOMATIC_COMPACTION_RECEIPT_FILE), '{\n', {
          flag: 'wx',
          mode: 0o600,
        });
        yield* fs.writeFileString(
          path.join(oversizedRoot, AUTOMATIC_COMPACTION_RECEIPT_FILE),
          Effect2.pipe('x', EffectString.repeat(4_097)),
          {
            flag: 'wx',
            mode: 0o600,
          },
        );

        expect(yield* codeGraphAutomaticCompactionCandidateAllowed(home, malformed)).toBe(false);
        expect(yield* claimCodeGraphAutomaticCompactionCandidate(home, malformed)).toBe(false);
        expect(yield* codeGraphAutomaticCompactionCandidateAllowed(home, oversized)).toBe(false);
        expect(yield* claimCodeGraphAutomaticCompactionCandidate(home, oversized)).toBe(false);
      }),
    );

    it.effect('fails closed when either the checkout root or repositories parent is a symbolic link', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkoutLinkId = Effect2.pipe('6', EffectString.repeat(64));
        const parentLinkId = Effect2.pipe('7', EffectString.repeat(64));

        const checkoutLinkHome = yield* fs.makeTempDirectoryScoped({
          prefix: 'threadnote-automatic-compaction-checkout-link-',
        });
        const checkoutLinkTarget = yield* fs.makeTempDirectoryScoped({
          prefix: 'threadnote-automatic-compaction-checkout-target-',
        });
        const checkoutRepositoriesRoot = codeGraphRepositoriesRoot(path, checkoutLinkHome);
        yield* fs.makeDirectory(checkoutRepositoriesRoot, {mode: 0o700, recursive: true});
        yield* fs.symlink(checkoutLinkTarget, codeGraphRepositoryRoot(path, checkoutLinkHome, checkoutLinkId));

        const parentLinkHome = yield* fs.makeTempDirectoryScoped({
          prefix: 'threadnote-automatic-compaction-parent-link-',
        });
        const parentLinkTarget = yield* fs.makeTempDirectoryScoped({
          prefix: 'threadnote-automatic-compaction-parent-target-',
        });
        yield* fs.makeDirectory(path.dirname(codeGraphRepositoriesRoot(path, parentLinkHome)), {
          mode: 0o700,
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(parentLinkTarget, parentLinkId), {mode: 0o700});
        yield* fs.symlink(parentLinkTarget, codeGraphRepositoriesRoot(path, parentLinkHome));

        for (const [home, candidate, externalRoot] of [
          [checkoutLinkHome, compactionCandidate(checkoutLinkId), checkoutLinkTarget],
          [parentLinkHome, compactionCandidate(parentLinkId), path.join(parentLinkTarget, parentLinkId)],
        ] as const) {
          expect(yield* codeGraphAutomaticCompactionCandidateAllowed(home, candidate)).toBe(false);
          expect(yield* claimCodeGraphAutomaticCompactionCandidate(home, candidate)).toBe(false);
          expect(yield* fs.exists(path.join(externalRoot, AUTOMATIC_COMPACTION_RECEIPT_FILE))).toBe(false);
        }
      }),
    );

    it.effect('shares a recorded manual compaction outcome with the automatic candidate fence', () =>
      Effect.gen(function* () {
        const checkoutId = Effect2.pipe('8', EffectString.repeat(64));
        const {home} = yield* makeCompactionReceiptFixture(checkoutId);
        expect(yield* compactCodeGraphStorage(home, checkoutId, {dryRun: false})).toMatchObject({
          action: 'missing',
          checkoutId,
        });
        const compacted = yield* Ref.make(false);

        const outcome = yield* runCodeGraphAutomaticCompactionPassWith(
          {
            candidateAllowed: codeGraphAutomaticCompactionCandidateAllowed,
            claimCandidate: claimCodeGraphAutomaticCompactionCandidate,
            compact: () => Ref.set(compacted, true).pipe(Effect.as(compactedSummary(checkoutId))),
            inspect: () =>
              Effect.succeed(availableStorage(checkoutId, {availableBytes: 16 * GIB, opportunityBytes: GIB})),
            listCheckoutIds: () => Effect.succeed([checkoutId]),
          },
          home,
        );

        expect(outcome).toMatchObject({state: 'no-candidate'});
        expect(yield* Ref.get(compacted)).toBe(false);
      }),
    );

    it.effect('propagates an explicit force request across the isolated worker boundary', () =>
      Effect.gen(function* () {
        const checkoutId = Effect2.pipe('9', EffectString.repeat(64));
        const baseSystem = yield* SystemInfo;
        const system = SystemInfo.of({
          ...baseSystem,
          environment: () => ({
            ...baseSystem.environment(),
            ARBITRARY_PARENT_VALUE: 'omit-me',
            HOME: '/bootstrap-home',
            THREADNOTE_TEST_SECRET: 'omit-me-too',
          }),
        });
        const observed = yield* Ref.make<
          {readonly environment: NodeJS.ProcessEnv | undefined; readonly request: unknown} | undefined
        >(undefined);
        const command = CommandExecutor.of({
          execute: (_executable, _arguments, options) =>
            Ref.set(observed, {
              environment: options?.env,
              request: JSON.parse(new TextDecoder().decode(options?.input)) as unknown,
            }).pipe(
              Effect.as({
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                  ok: true,
                  protocol: 1,
                  result: compactedSummary(checkoutId),
                }),
              }),
            ),
          executeStreaming: () =>
            Effect.die(AutomaticCompactionTestError.make({message: 'unexpected streaming command'})),
        });

        expect(
          yield* compactCodeGraphStorageIsolated('/threadnote-home', checkoutId, {force: true}).pipe(
            Effect.provideService(CommandExecutor, command),
            Effect.provideService(SystemInfo, system),
          ),
        ).toEqual(compactedSummary(checkoutId));
        expect((yield* Ref.get(observed))?.request).toEqual({
          checkoutId,
          force: true,
          operation: 'compact',
          protocol: 1,
          threadnoteHome: '/threadnote-home',
        });
        expect((yield* Ref.get(observed))?.environment).toEqual(
          automaticCompactionWorkerEnvironment(system.environment(), '/threadnote-home'),
        );
        expect((yield* Ref.get(observed))?.environment).toMatchObject({
          HOME: '/bootstrap-home',
          THREADNOTE_CODE_GRAPH_COMPACTION_WORKER: '1',
          THREADNOTE_HOME: '/threadnote-home',
        });
        expect((yield* Ref.get(observed))?.environment).not.toHaveProperty('ARBITRARY_PARENT_VALUE');
        expect((yield* Ref.get(observed))?.environment).not.toHaveProperty('THREADNOTE_TEST_SECRET');

        yield* compactCodeGraphStorageIsolated('/threadnote-home', checkoutId, {operation: 'journal'}).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(SystemInfo, system),
        );
        expect((yield* Ref.get(observed))?.request).toMatchObject({force: false, operation: 'journal'});
      }),
    );
  });

  effectIt.layer(AutomaticCompactionIsolatedTestLayer)(it => {
    it.effect(
      'boots the real isolated worker with a bounded missing-checkout response',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-automatic-compaction-worker-'});
          const checkoutId = Effect2.pipe('a', EffectString.repeat(64));

          expect(
            yield* compactCodeGraphStorageIsolated(home, checkoutId).pipe(
              Effect.timeout('10 seconds'),
              TestClock.withLive,
            ),
          ).toEqual({action: 'missing', checkoutId, reclaimedBytes: 0});
        }),
      15_000,
    );
  });

  effectIt.effect('compacts only the largest eligible database in one pass', () =>
    Effect.gen(function* () {
      const first = Effect2.pipe('a', EffectString.repeat(64));
      const largest = Effect2.pipe('b', EffectString.repeat(64));
      const compacted: string[] = [];
      const result = yield* runCodeGraphAutomaticCompactionPassWith(
        {
          compact: (_home, checkoutId) =>
            Effect.sync(() => {
              compacted.push(checkoutId);
              return compactedSummary(checkoutId);
            }),
          inspect: (_home, checkoutId) =>
            Effect.succeed(
              availableStorage(checkoutId, {
                availableBytes: 16 * GIB,
                opportunityBytes: checkoutId === largest ? 3 * GIB : GIB,
              }),
            ),
          listCheckoutIds: () => Effect.succeed([largest, first, largest, 'not-a-checkout']),
        },
        '/threadnote-home',
      );

      expect(compacted).toEqual([largest]);
      expect(result).toMatchObject({
        candidate: {checkoutId: largest, opportunityBytes: 3 * GIB},
        result: {action: 'compacted', checkoutId: largest},
        state: 'attempted',
      });
    }),
  );

  effectIt.effect('waits when the reviewed threshold or disk-headroom gate is not satisfied', () =>
    Effect.gen(function* () {
      const lowSpace = Effect2.pipe('c', EffectString.repeat(64));
      const belowThreshold = Effect2.pipe('d', EffectString.repeat(64));
      const compacted: string[] = [];
      const result = yield* runCodeGraphAutomaticCompactionPassWith(
        {
          compact: (_home, checkoutId) =>
            Effect.sync(() => {
              compacted.push(checkoutId);
              return compactedSummary(checkoutId);
            }),
          inspect: (_home, checkoutId) =>
            Effect.succeed(
              availableStorage(checkoutId, {
                availableBytes: checkoutId === lowSpace ? GIB : 16 * GIB,
                opportunityBytes: GIB,
                recommended: checkoutId !== belowThreshold,
              }),
            ),
          listCheckoutIds: () => Effect.succeed([lowSpace, belowThreshold]),
        },
        '/threadnote-home',
      );

      expect(result).toEqual({
        inspected: 2,
        inspectionFailures: 0,
        nextOffset: 1,
        state: 'no-candidate',
      });
      expect(compacted).toEqual([]);
    }),
  );

  effectIt.effect('does not select a structural-slack-only recommendation for automatic compaction', () =>
    Effect.gen(function* () {
      const checkoutId = Effect2.pipe('c', EffectString.repeat(64));
      const compacted = yield* Ref.make(false);
      const result = yield* runCodeGraphAutomaticCompactionPassWith(
        {
          compact: () => Ref.set(compacted, true).pipe(Effect.as(compactedSummary(checkoutId))),
          inspect: () =>
            Effect.succeed(
              availableStorage(checkoutId, {
                availableBytes: 16 * GIB,
                opportunityBytes: GIB,
                reason: 'freelist-and-fragmentation',
                reclaimableBytes: 0,
              }),
            ),
          listCheckoutIds: () => Effect.succeed([checkoutId]),
        },
        '/threadnote-home',
      );

      expect(result).toMatchObject({state: 'no-candidate'});
      expect(yield* Ref.get(compacted)).toBe(false);
    }),
  );

  effectIt.effect('advances its bounded scan so large homes cannot starve later databases', () =>
    Effect.gen(function* () {
      const checkoutIds = Array.from({length: 130}, (_, index) =>
        Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
      );
      const target = checkoutIds.at(-1)!;
      const compacted: string[] = [];
      const dependencies = {
        compact: (_home: string, checkoutId: string) =>
          Effect.sync(() => {
            compacted.push(checkoutId);
            return compactedSummary(checkoutId);
          }),
        inspect: (_home: string, checkoutId: string) =>
          Effect.succeed(
            availableStorage(checkoutId, {
              availableBytes: 16 * GIB,
              opportunityBytes: GIB,
              recommended: checkoutId === target,
            }),
          ),
        listCheckoutIds: () => Effect.succeed(checkoutIds),
      };

      const first = yield* runCodeGraphAutomaticCompactionPassWith(dependencies, '/threadnote-home');
      expect(first).toEqual({
        inspected: 128,
        inspectionFailures: 0,
        nextOffset: 1,
        state: 'no-candidate',
      });
      const second = yield* runCodeGraphAutomaticCompactionPassWith(dependencies, '/threadnote-home', {
        offset: first.nextOffset,
      });
      expect(second).toMatchObject({nextOffset: 2, state: 'no-candidate'});
      const third = yield* runCodeGraphAutomaticCompactionPassWith(dependencies, '/threadnote-home', {
        offset: second.nextOffset,
      });
      expect(third).toMatchObject({candidate: {checkoutId: target}, nextOffset: 3, state: 'attempted'});
      expect(compacted).toEqual([target]);
    }),
  );

  it('selects the same largest opportunity for every enumeration order', () => {
    const candidate = fc.record({
      checkoutId: fc.stringMatching(/^[0-9a-f]{1,16}$/u),
      opportunityBytes: fc.integer({max: Number.MAX_SAFE_INTEGER, min: 0}),
      opportunityRatio: fc.double({max: 1, min: 0, noNaN: true}),
    });
    fc.assert(
      fc.property(fc.array(candidate, {maxLength: 64}), fc.array(fc.integer()), (candidates, ordering) => {
        const permuted = EffectArray.map(
          EffectArray.map(candidates, (value, index) => ({index, order: ordering[index] ?? 0, value})).sort(
            (left, right) => left.order - right.order || left.index - right.index,
          ),
          entry => entry.value,
        );
        expect(selectCodeGraphAutomaticCompactionCandidate(permuted)).toEqual(
          selectCodeGraphAutomaticCompactionCandidate(candidates),
        );
      }),
      {numRuns: 100},
    );
  });

  it('eventually starts the bounded inspection window with every database', () => {
    fc.assert(
      fc.property(fc.integer({max: 300, min: 1}), size => {
        const checkoutIds = Array.from({length: size}, (_, index) => String(index));
        const visited = new Set(
          Array.from(
            {length: size},
            (_, offset) => codeGraphAutomaticCompactionCheckoutWindow(checkoutIds, offset).checkoutIds[0],
          ),
        );
        expect(visited).toEqual(new Set(checkoutIds));
      }),
      {numRuns: 100},
    );
  });

  it('strictly validates the bounded worker protocol and target binding', () => {
    const checkoutId = Effect2.pipe('a', EffectString.repeat(64));
    const request = JSON.stringify({
      checkoutId,
      force: true,
      operation: 'compact',
      protocol: 1,
      threadnoteHome: '/threadnote-home',
    });
    expect(decodeAutomaticCompactionWorkerRequest(request)).toEqual({
      checkoutId,
      force: true,
      operation: 'compact',
      protocol: 1,
      threadnoteHome: '/threadnote-home',
    });
    expect(
      decodeAutomaticCompactionWorkerRequest(
        JSON.stringify({
          checkoutId,
          force: false,
          operation: 'journal',
          protocol: 1,
          threadnoteHome: '/threadnote-home',
        }),
      ),
    ).toMatchObject({operation: 'journal'});
    expect(decodeAutomaticCompactionWorkerRequest('{')).toBeUndefined();
    expect(
      decodeAutomaticCompactionWorkerRequest(
        JSON.stringify({checkoutId, force: false, operation: 'probe', protocol: 1, threadnoteHome: 'relative/home'}),
      ),
    ).toBeUndefined();
    expect(
      decodeAutomaticCompactionWorkerRequest(
        JSON.stringify({checkoutId, force: 'yes', operation: 'compact', protocol: 1, threadnoteHome: '/home'}),
      ),
    ).toBeUndefined();
    expect(
      decodeAutomaticCompactionWorkerRequest(
        JSON.stringify({
          checkoutId,
          force: false,
          operation: 'compact',
          protocol: 1,
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
          threadnoteHome: 'x'.repeat(CODE_GRAPH_AUTOMATIC_COMPACTION_INPUT_BYTES_MAXIMUM + 1),
        }),
      ),
    ).toBeUndefined();

    const response = JSON.stringify({
      ok: true,
      protocol: 1,
      result: {action: 'compacted', checkoutId, reclaimedBytes: GIB},
    });
    expect(decodeAutomaticCompactionWorkerResponse(response, checkoutId)).toMatchObject({
      ok: true,
      result: {action: 'compacted', checkoutId},
    });
    expect(
      decodeAutomaticCompactionWorkerResponse(response, Effect2.pipe('b', EffectString.repeat(64))),
    ).toBeUndefined();
    expect(
      decodeAutomaticCompactionWorkerResponse(
        JSON.stringify({
          ok: true,
          protocol: 1,
          result: {action: 'compacted', checkoutId, reason: 'active-build', reclaimedBytes: GIB},
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeAutomaticCompactionWorkerResponse(
        JSON.stringify({
          ok: true,
          protocol: 1,
          result: {action: 'unexpected', checkoutId, reclaimedBytes: 0},
        }),
      ),
    ).toBeUndefined();
  });

  it('launches the compiled binary directly and the development standalone through Bun', () => {
    expect(
      codeGraphAutomaticCompactionWorkerInvocation({
        ...systemRuntimeBoundaries,
        executablePath: '/opt/threadnote/bin/threadnote',
        processArguments: ['/opt/threadnote/bin/threadnote', 'manage'],
      }),
    ).toEqual({
      arguments: ['--threadnote-code-graph-compaction-worker'],
      executable: '/opt/threadnote/bin/threadnote',
    });
    expect(
      codeGraphAutomaticCompactionWorkerInvocation({
        ...systemRuntimeBoundaries,
        executablePath: '/opt/bun/bin/bun',
        processArguments: ['/opt/bun/bin/bun', '/workspace/apps/threadnote/src/standalone.ts', 'manage'],
      }),
    ).toEqual({
      arguments: ['/workspace/apps/threadnote/src/standalone.ts', '--threadnote-code-graph-compaction-worker'],
      executable: '/opt/bun/bin/bun',
    });
    expect(
      codeGraphAutomaticCompactionWorkerInvocation({
        ...systemRuntimeBoundaries,
        executablePath: '/opt/bun/bin/bun',
        processArguments: ['/opt/bun/bin/bun'],
      }),
    ).toEqual({
      arguments: [
        Bun.fileURLToPath(new URL('../../src/standalone.ts', import.meta.url)),
        '--threadnote-code-graph-compaction-worker',
      ],
      executable: '/opt/bun/bin/bun',
    });
  });

  it('uses the supplied development entrypoint independently of package placement', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'b', 'c', ' ', '-'), {minLength: 1, maxLength: 40}), segments => {
        const developmentEntrypoint = `/arbitrary/${EffectArray.join(segments, '')}/entry.ts`;
        const invocation = codeGraphAutomaticCompactionWorkerInvocation({
          developmentEntrypoint,
          executablePath: '/opt/bun/bin/bun',
          processArguments: ['/opt/bun/bin/bun', '/fixture/test-runner.ts'],
        });
        expect(invocation.arguments).toEqual([developmentEntrypoint, '--threadnote-code-graph-compaction-worker']);
      }),
      {numRuns: 50},
    );
  });

  effectIt.effect('publishes running status before a long compaction and interrupts it with Manager scope', () =>
    Effect.gen(function* () {
      const checkoutId = Effect2.pipe('e', EffectString.repeat(64));
      const running = yield* Deferred.make<void>();
      const cancelled = yield* Ref.make(false);
      const statuses = yield* Ref.make<string[]>([]);
      const fiber = yield* runCodeGraphAutomaticCompactionLoopWith(
        {
          compact: () => Effect.never.pipe(Effect.ensuring(Ref.set(cancelled, true))),
          inspect: () =>
            Effect.succeed(availableStorage(checkoutId, {availableBytes: 16 * GIB, opportunityBytes: 2 * GIB})),
          listCheckoutIds: () => Effect.succeed([checkoutId]),
        },
        '/threadnote-home',
        status =>
          Ref.update(statuses, current => [...current, status.state]).pipe(
            Effect.andThen(status.state === 'running' ? Deferred.succeed(running, undefined) : Effect.void),
          ),
        {initialDelayMilliseconds: 0},
      ).pipe(Effect.forkChild({startImmediately: true}));

      yield* Deferred.await(running);
      expect(yield* Ref.get(statuses)).toEqual(['inspecting', 'running']);
      yield* Fiber.interrupt(fiber);
      expect(yield* Ref.get(cancelled)).toBe(true);
    }),
  );

  effectIt.layer(AutomaticCompactionReceiptTestLayer)(it => {
    it.effect('elects one inventory leader and lets a waiting host take over after it exits', () =>
      Effect.gen(function* () {
        const checkoutId = Effect2.pipe('c', EffectString.repeat(64));
        const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: 'threadnote-automatic-compaction-scheduler-',
        });
        const inventories = yield* Ref.make<string[]>([]);
        const firstOwner = yield* Deferred.make<string>();
        const secondOwner = yield* Deferred.make<string>();
        const contenderSleepScheduled = yield* Deferred.make<void>();
        const owners = yield* Ref.make<string[]>([]);
        const dependencies = (owner: string) => ({
          compact: () =>
            Effect.gen(function* () {
              const observed = yield* Ref.updateAndGet(owners, current => [...current, owner]);
              yield* Deferred.succeed(observed.length === 1 ? firstOwner : secondOwner, owner);
              return yield* Effect.never;
            }),
          inspect: () =>
            Effect.succeed(availableStorage(checkoutId, {availableBytes: 16 * GIB, opportunityBytes: 2 * GIB})),
          listCheckoutIds: () => Ref.update(inventories, current => [...current, owner]).pipe(Effect.as([checkoutId])),
        });
        const timing = {initialDelayMilliseconds: 0, intervalMilliseconds: 1, leadershipRetryMilliseconds: 1};
        const nativeClock = yield* Clock.Clock;
        const contenderClock: Clock.Clock = {
          ...nativeClock,
          sleep: duration =>
            Duration.toMillis(duration) === timing.leadershipRetryMilliseconds
              ? Effect.gen(function* () {
                  const sleep = yield* nativeClock.sleep(duration).pipe(Effect.forkChild({startImmediately: true}));
                  yield* Deferred.succeed(contenderSleepScheduled, undefined);
                  return yield* Fiber.join(sleep);
                })
              : nativeClock.sleep(duration),
        };
        const first = yield* runCodeGraphAutomaticCompactionSchedulerWith(
          dependencies('first'),
          home,
          () => Effect.void,
          timing,
        ).pipe(Effect.forkChild({startImmediately: true}));
        const owner = yield* Deferred.await(firstOwner);
        expect(owner).toBe('first');
        expect(yield* Ref.get(inventories)).toEqual([owner]);
        const second = yield* runCodeGraphAutomaticCompactionSchedulerWith(
          dependencies('second'),
          home,
          () => Effect.void,
          timing,
        ).pipe(Effect.provideService(Clock.Clock, contenderClock), Effect.forkChild({startImmediately: true}));

        // The failed acquisition is asynchronous. Wait until its retry sleep
        // is registered before advancing TestClock past the retry deadline.
        yield* Deferred.await(contenderSleepScheduled);
        yield* Fiber.interrupt(first);
        yield* TestClock.adjust(1);
        expect(yield* Deferred.await(secondOwner)).toBe('second');
        expect(yield* Ref.get(inventories)).toHaveLength(2);
        yield* Fiber.interrupt(second);
      }),
    );

    it.effect('retries a deferred active build after its five-minute receipt cooldown', () =>
      Effect.gen(function* () {
        const checkoutId = Effect2.pipe('d', EffectString.repeat(64));
        const {home} = yield* makeCompactionReceiptFixture(checkoutId);
        const candidate = compactionCandidate(checkoutId);
        yield* recordCodeGraphAutomaticCompactionAttempt(home, candidate, {
          action: 'deferred',
          reclaimedBytes: 0,
        });
        const dependencies = {
          candidateAllowed: codeGraphAutomaticCompactionCandidateAllowed,
          claimCandidate: claimCodeGraphAutomaticCompactionCandidate,
          compact: () => Effect.succeed(compactedSummary(checkoutId)),
          inspect: () =>
            Effect.succeed(availableStorage(checkoutId, {availableBytes: 16 * GIB, opportunityBytes: 2 * GIB})),
          listCheckoutIds: () => Effect.succeed([checkoutId]),
          recordAttempt: recordCodeGraphAutomaticCompactionAttempt,
        };
        expect(yield* runCodeGraphAutomaticCompactionPassWith(dependencies, home)).toMatchObject({
          state: 'no-candidate',
        });
        yield* TestClock.adjust('5 minutes');
        expect(yield* runCodeGraphAutomaticCompactionPassWith(dependencies, home)).toMatchObject({
          result: {action: 'compacted', checkoutId},
          state: 'attempted',
        });
      }),
    );
  });

  effectIt.effect('retains the failed candidate so Manager can render a human repository label', () =>
    Effect.gen(function* () {
      const checkoutId = Effect2.pipe('d', EffectString.repeat(64));
      const failed = yield* Deferred.make<{readonly checkoutId?: string; readonly state: string}>();
      const fiber = yield* runCodeGraphAutomaticCompactionLoopWith(
        {
          compact: () => Effect.fail(AutomaticCompactionTestError.make({message: 'expected compaction failure'})),
          inspect: () =>
            Effect.succeed(availableStorage(checkoutId, {availableBytes: 16 * GIB, opportunityBytes: 2 * GIB})),
          listCheckoutIds: () => Effect.succeed([checkoutId]),
        },
        '/threadnote-home',
        status =>
          status.state === 'failed'
            ? Deferred.succeed(failed, {checkoutId: status.checkoutId, state: status.state})
            : Effect.void,
        {initialDelayMilliseconds: 0},
      ).pipe(Effect.forkChild({startImmediately: true}));

      expect(yield* Deferred.await(failed)).toEqual({checkoutId, state: 'failed'});
      yield* Fiber.interrupt(fiber);
    }),
  );
});

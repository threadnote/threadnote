import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Crypto, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Path, Ref, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  CodeGraphDiskCapacityObservationError,
  codeGraphDiskCapacityReservationProjection,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '@threadnote/graph/disk/capacity';
import {
  acquireCodeGraphDiskReservation,
  codeGraphDiskReservationFilesystemKey,
  parseCodeGraphDiskReservationReceipt,
  releaseCodeGraphDiskReservation,
  serializeCodeGraphDiskReservationReceipt,
  withCodeGraphDiskReservation,
  type CodeGraphDiskReservationLease,
  type CodeGraphDiskReservationObservation,
  type CodeGraphDiskReservationOptions,
} from '@threadnote/graph/disk/reservation';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {observeDirectPersistentCapacityForTest} from '@threadnote/graph/indexer/materialization';
import type {DirectPersistentCapacityProtection} from '@threadnote/graph/indexer/types';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {SystemInfo} from '@threadnote/platform/system';
import type {CodeGraphMaintenanceCoordinatorShape} from '@threadnote/graph/maintenance/coordinator';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const filesystemKey = Effect2.pipe('a', EffectString.repeat(64));
const boundary: CodeGraphDirectPersistentCapacityBoundary = {
  finalFactBytes: 1,
  operation: 'stage persistent code graph facts',
  rowCount: 1,
};
const healthyObservation: CodeGraphDiskReservationObservation = {
  demand: {
    calibrationIdentity: 'fixture-v1',
    mainHighWaterBytes: 10,
    recoveryFloorBytes: 10,
    state: 'measured',
    transientFilesystem: 'durable',
    transientHighWaterBytes: 10,
  },
  durableAvailableBytes: 100,
  durableFilesystemKey: filesystemKey,
  freelistBytes: 0,
  temporaryAvailableBytes: 100,
  temporaryFilesystemKey: filesystemKey,
};
const reservationLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);

interface LedgerFixture {
  readonly ledgerLockPath: string;
  readonly ledgerRoot: string;
}

interface ReservationChildOptions {
  readonly availableBytes: number;
  readonly barrier?: {
    readonly childId: string;
    readonly readyRoot: string;
    readonly releasePath: string;
  };
  readonly filesystemKey: string;
  readonly holdMilliseconds: number;
  readonly iterations: number;
  readonly mode: 'forever' | 'normal';
}

interface ReservationChildProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly kill: (signal?: NodeJS.Signals | number) => void;
}

interface ReservationChildWaitingEvent {
  readonly event: 'waiting';
  readonly processId: number;
}
interface ReservationChildAcquiredEvent {
  readonly acquisitionMilliseconds: number;
  readonly at: number;
  readonly event: 'acquired';
  readonly iteration: number;
  readonly mode: 'forever' | 'normal';
  readonly processId: number;
}
interface ReservationChildLeavingEvent {
  readonly at: number;
  readonly event: 'leaving';
  readonly iteration: number;
  readonly processId: number;
}
interface ReservationChildCompleteEvent {
  readonly at: number;
  readonly event: 'complete';
  readonly processId: number;
}
type ReservationChildEvent =
  | ReservationChildWaitingEvent
  | ReservationChildAcquiredEvent
  | ReservationChildCompleteEvent
  | ReservationChildLeavingEvent;

const reservationChildEventSchema = Schema.Struct({
  acquisitionMilliseconds: Schema.optional(Schema.Finite),
  at: Schema.optional(Schema.Finite),
  event: Schema.Union([
    Schema.Literal('acquired'),
    Schema.Literal('complete'),
    Schema.Literal('leaving'),
    Schema.Literal('waiting'),
  ]),
  iteration: Schema.optional(Schema.Finite),
  mode: Schema.optional(Schema.Union([Schema.Literal('forever'), Schema.Literal('normal')])),
  processId: Schema.Finite,
});

const parseReservationChildEvent = (input: unknown): ReservationChildEvent => {
  const value = Schema.decodeUnknownSync(reservationChildEventSchema)(input);
  switch (value.event) {
    case 'waiting':
      return {event: 'waiting', processId: value.processId};
    case 'acquired':
      if (
        value.acquisitionMilliseconds === undefined ||
        value.at === undefined ||
        value.iteration === undefined ||
        value.mode === undefined
      ) {
        throw new Error('Acquired child event omitted required fields.');
      }
      return {
        acquisitionMilliseconds: value.acquisitionMilliseconds,
        at: value.at,
        event: 'acquired',
        iteration: value.iteration,
        mode: value.mode,
        processId: value.processId,
      };
    case 'leaving':
      if (value.at === undefined || value.iteration === undefined) {
        throw new Error('Leaving child event omitted required fields.');
      }
      return {at: value.at, event: 'leaving', iteration: value.iteration, processId: value.processId};
    case 'complete':
      if (value.at === undefined) throw new Error('Complete child event omitted its timestamp.');
      return {at: value.at, event: 'complete', processId: value.processId};
  }
};

const unusedCapacityObservationMaintenance = {
  kickOrdinary: () => Effect.die(new Error('Capacity observation must not run maintenance.')),
  kickReconciliation: () => Effect.die(new Error('Capacity observation must not run maintenance.')),
  kickResidual: () => Effect.die(new Error('Capacity observation must not run maintenance.')),
  request: () => Effect.die(new Error('Capacity observation must not run maintenance.')),
  tick: () => Effect.die(new Error('Capacity observation must not run maintenance.')),
} satisfies CodeGraphMaintenanceCoordinatorShape;

describe('code graph disk reservation ledger', () => {
  effectIt.effect('observes a spool sort across durable and selected SQLite TEMP filesystems', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const system = yield* SystemInfo;
      const threadnoteHome = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-capacity-observation-home-'});
      const sqliteTemporaryDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: 'threadnote-capacity-observation-sqlite-tmp-',
      });
      const layout = codeGraphLayout(
        path,
        threadnoteHome,
        Effect2.pipe('c', EffectString.repeat(64)),
        Effect2.pipe('d', EffectString.repeat(64)),
      );
      const identity: RepositoryIdentity = {
        caseMode: 'sensitive',
        checkoutId: layout.checkoutId,
        displayName: 'capacity-observation-fixture',
        gitCommonDirectory: layout.repositoryRoot,
        headCommit: Effect2.pipe('1', EffectString.repeat(40)),
        objectFormat: 'sha1',
        repoRoot: layout.repositoryRoot,
        repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
        worktreeId: layout.worktreeId,
      };
      yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true});
      yield* Effect.sync(() => {
        const database = new Database(layout.databasePath, {strict: true});
        try {
          database.exec('CREATE TABLE capacity_observation_fixture (value TEXT NOT NULL)');
        } finally {
          database.close(true);
        }
      });

      const probePaths: string[] = [];
      const topologyFs: FileSystem.FileSystem = {
        ...fs,
        stat: target =>
          fs.stat(target).pipe(
            Effect.map(info => ({
              ...info,
              dev: target === layout.repositoryRoot ? 101n : target === sqliteTemporaryDirectory ? 202n : info.dev,
            })),
          ),
      };
      const protection = {
        availableDiskBytes: (target: string) =>
          Effect.sync(() => {
            probePaths.push(target);
            return target === layout.repositoryRoot ? 9_000_000 : 8_000_000;
          }),
        crypto,
        maintenance: unusedCapacityObservationMaintenance,
        path,
        system: {
          ...system,
          environment: () => ({...system.environment(), SQLITE_TMPDIR: sqliteTemporaryDirectory}),
        },
        temporaryDirectory: threadnoteHome,
        walAutoCheckpointPages: 16,
      } satisfies DirectPersistentCapacityProtection;
      const observation = yield* observeDirectPersistentCapacityForTest({
        boundary: {
          finalFactBytes: 1_000,
          mainSortPayloadBytes: 1_500,
          operation: 'sort persistent code graph materialization spool',
          rowCount: 10,
          transientFilesystem: 'temporary',
        },
        fs: topologyFs,
        identity,
        layout,
        protection,
        threadnoteHome,
      });
      const durableKey = codeGraphDiskReservationFilesystemKey(system.platform, 101);
      const temporaryKey = codeGraphDiskReservationFilesystemKey(system.platform, 202);
      expect(probePaths).toEqual(expect.arrayContaining([layout.repositoryRoot, sqliteTemporaryDirectory]));
      expect(observation.durableFilesystemKey).toBe(durableKey);
      expect(observation.temporaryFilesystemKey).toBe(temporaryKey);
      expect(observation.durableFilesystemKey).not.toBe(observation.temporaryFilesystemKey);
      expect(observation.freelistBytes).toBe(0);
      expect(observation.demand).toMatchObject({
        recoveryFilesystem: 'durable',
        state: 'measured',
        transientFilesystem: 'temporary',
      });
      const projection = codeGraphDiskCapacityReservationProjection({
        demand: observation.demand,
        durableFilesystemKey: observation.durableFilesystemKey,
        freelistBytes: observation.freelistBytes,
        temporaryFilesystemKey: observation.temporaryFilesystemKey,
      });
      expect(projection.state).toBe('measured');
      if (projection.state === 'measured') {
        expect(EffectArray.map(projection.filesystems, filesystem => filesystem.key)).toEqual([
          durableKey,
          temporaryKey,
        ]);
      }
    }).pipe(provideTestLayer(reservationLayer)),
  );

  effectIt.effect('creates private immutable receipts and releases only exact canonical ownership', () =>
    TestClock.withLive(
      withLedgerFixture(fixture =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const options = reservationOptions(fixture);
          const first = yield* acquireCodeGraphDiskReservation(options);
          const rootInfo = yield* fs.stat(fixture.ledgerRoot);
          const receiptInfo = yield* fs.stat(first.receiptPath);
          if (process.platform !== 'win32') {
            expect(rootInfo.mode & 0o777).toBe(0o700);
            expect(receiptInfo.mode & 0o777).toBe(0o600);
          }
          expect(yield* releaseCodeGraphDiskReservation(options, first)).toBe('released');
          expect(yield* releaseCodeGraphDiskReservation(options, first)).toBe('missing');

          const replacementLease = yield* acquireCodeGraphDiskReservation(options);
          const parsed = parseCodeGraphDiskReservationReceipt(
            `v1-${replacementLease.token}.json`,
            replacementLease.canonicalReceipt,
          );
          if (!parsed) return yield* TestError.make({message: 'Fixture receipt did not parse.'});
          expect(parsed.processStartIdentity).toMatch(
            process.platform === 'darwin' ? /^darwin-v2:/u : new RegExp(`^${process.platform}:`, 'u'),
          );
          const replacement = serializeCodeGraphDiskReservationReceipt({
            ...parsed,
            processStartIdentity: parsed.processStartIdentity === 'linux:1' ? 'win32:1' : 'linux:1',
          });
          yield* fs.remove(replacementLease.receiptPath);
          yield* fs.writeFileString(replacementLease.receiptPath, replacement, {flag: 'wx', mode: 0o600});

          expect(yield* releaseCodeGraphDiskReservation(options, replacementLease)).toBe('retained');
          expect(yield* fs.readFileString(replacementLease.receiptPath)).toBe(replacement);
        }),
      ).pipe(provideTestLayer(reservationLayer)),
    ),
  );

  effectIt.effect('releases after success, failure, defect, cancellation, and one transient release fault', () =>
    TestClock.withLive(
      withLedgerFixture(fixture =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const runAndAssertEmpty = <A, E>(transaction: Effect.Effect<A, E>) =>
            withCodeGraphDiskReservation(reservationOptions(fixture), transaction).pipe(
              Effect.exit,
              Effect.tap(() =>
                fs
                  .readDirectory(fixture.ledgerRoot)
                  .pipe(Effect.tap(entries => Effect.sync(() => expect(entries).toEqual([])))),
              ),
            );

          expect(Exit.isSuccess(yield* runAndAssertEmpty(Effect.succeed('ok')))).toBe(true);
          expect(
            Exit.isFailure(yield* runAndAssertEmpty(Effect.fail(TestError.make({message: 'expected failure'})))),
          ).toBe(true);
          expect(
            Exit.isFailure(yield* runAndAssertEmpty(Effect.die(TestError.make({message: 'expected defect'})))),
          ).toBe(true);

          const started = yield* Deferred.make<void>();
          const cancelled = yield* Effect.forkChild(
            withCodeGraphDiskReservation(
              reservationOptions(fixture),
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          );
          yield* Deferred.await(started);
          yield* Fiber.interrupt(cancelled);
          expect(yield* fs.readDirectory(fixture.ledgerRoot)).toEqual([]);

          const releaseAttempts = yield* Ref.make(0);
          const transientOptions = reservationOptions(fixture, {
            beforeReleaseAttempt: Ref.updateAndGet(releaseAttempts, count => count + 1).pipe(
              Effect.flatMap(attempt =>
                attempt === 1 ? Effect.fail(TestError.make({message: 'transient release fault'})) : Effect.void,
              ),
            ),
          });
          expect(
            Exit.isSuccess(yield* withCodeGraphDiskReservation(transientOptions, Effect.void).pipe(Effect.exit)),
          ).toBe(true);
          expect(yield* Ref.get(releaseAttempts)).toBe(2);
          expect(yield* fs.readDirectory(fixture.ledgerRoot)).toEqual([]);

          const exhaustedAttempts = yield* Ref.make(0);
          const diagnostics = yield* Ref.make(0);
          const exhausted = reservationOptions(fixture, {
            beforeReleaseAttempt: Ref.update(exhaustedAttempts, count => count + 1).pipe(
              Effect.andThen(Effect.fail(TestError.make({message: 'persistent release fault'}))),
            ),
            onDiagnostic: () => Ref.update(diagnostics, count => count + 1),
          });
          expect(Exit.isSuccess(yield* withCodeGraphDiskReservation(exhausted, Effect.void).pipe(Effect.exit))).toBe(
            true,
          );
          expect(yield* Ref.get(exhaustedAttempts)).toBe(3);
          expect(yield* Ref.get(diagnostics)).toBe(1);
          expect(
            EffectArray.filter(
              yield* fs.readDirectory(fixture.ledgerRoot),
              __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
            ),
          ).toHaveLength(1);

          // A later claim in this same live process reaps only the exact
          // canonical receipt whose exhausted finalizer recorded recovery
          // authority; changed replacements remain protected by the first test.
          yield* withCodeGraphDiskReservation(reservationOptions(fixture), Effect.void);
          expect(yield* fs.readDirectory(fixture.ledgerRoot)).toEqual([]);
        }),
      ).pipe(provideTestLayer(reservationLayer)),
    ),
  );

  effectIt.effect('waits without starting the protected writer, remains cancellable, and then progresses', () =>
    TestClock.withLive(
      withLedgerFixture(fixture =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const waiting = yield* Deferred.make<void>();
          const transactionStarted = yield* Deferred.make<void>();
          const waitingReports = yield* Ref.make(0);
          const constrained = reservationOptions(fixture, {
            observe: Effect.succeed({...healthyObservation, durableAvailableBytes: 59, temporaryAvailableBytes: 59}),
          });
          const holder = yield* acquireCodeGraphDiskReservation(constrained);
          const waiterOptions = reservationOptions(fixture, {
            observe: constrained.observe,
            onWaiting: Ref.updateAndGet(waitingReports, count => count + 1).pipe(
              Effect.tap(() => Deferred.succeed(waiting, undefined)),
              Effect.asVoid,
            ),
          });
          const waiter = yield* Effect.forkChild(
            withCodeGraphDiskReservation(
              waiterOptions,
              Deferred.succeed(transactionStarted, undefined).pipe(Effect.andThen(Effect.succeed('committed'))),
            ),
          );
          yield* Deferred.await(waiting);

          expect(Option.isNone(yield* Deferred.poll(transactionStarted))).toBe(true);
          expect(yield* Ref.get(waitingReports)).toBe(1);
          expect(
            EffectArray.filter(
              yield* fs.readDirectory(fixture.ledgerRoot),
              __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
            ),
          ).toHaveLength(1);
          yield* Fiber.interrupt(waiter);
          expect(
            EffectArray.filter(
              yield* fs.readDirectory(fixture.ledgerRoot),
              __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
            ),
          ).toHaveLength(1);

          const progressing = yield* Deferred.make<void>();
          const secondWaiting = yield* Deferred.make<void>();
          const second = yield* Effect.forkChild(
            withCodeGraphDiskReservation(
              reservationOptions(fixture, {
                observe: constrained.observe,
                onWaiting: Deferred.succeed(secondWaiting, undefined).pipe(Effect.asVoid),
              }),
              Deferred.succeed(progressing, undefined).pipe(Effect.andThen(Effect.succeed('committed'))),
            ),
          );
          yield* Deferred.await(secondWaiting);
          yield* releaseCodeGraphDiskReservation(constrained, holder);

          expect(yield* Fiber.join(second)).toBe('committed');
          expect(yield* Deferred.isDone(progressing)).toBe(true);
          expect(yield* fs.readDirectory(fixture.ledgerRoot)).toEqual([]);
        }),
      ).pipe(provideTestLayer(reservationLayer)),
    ),
  );

  effectIt.effect('runs one maintenance retry only for physical pressure and fails closed on unknown observation', () =>
    TestClock.withLive(
      withLedgerFixture(fixture =>
        Effect.gen(function* () {
          const available = yield* Ref.make(0);
          const maintenanceRuns = yield* Ref.make(0);
          const physical = reservationOptions(fixture, {
            maintenance: Ref.update(maintenanceRuns, count => count + 1).pipe(Effect.andThen(Ref.set(available, 100))),
            observe: Ref.get(available).pipe(
              Effect.map(bytes => ({
                ...healthyObservation,
                durableAvailableBytes: bytes,
                temporaryAvailableBytes: bytes,
              })),
            ),
          });
          const lease = yield* acquireCodeGraphDiskReservation(physical);
          expect(yield* Ref.get(maintenanceRuns)).toBe(1);
          yield* releaseCodeGraphDiskReservation(physical, lease);

          const persistentPressure = reservationOptions(fixture, {
            maintenance: Effect.void,
            observe: Effect.succeed({...healthyObservation, durableAvailableBytes: 0, temporaryAvailableBytes: 0}),
          });
          const pressure = yield* Effect.flip(acquireCodeGraphDiskReservation(persistentPressure));
          expect(pressure.evidence?.filesystems).toEqual([{availableBytes: 0, requiredBytes: 30, role: 'shared'}]);
          expect(pressure.evidence?.recovery).toBe('free-space');

          const unknownMaintenanceRuns = yield* Ref.make(0);
          const unknown = reservationOptions(fixture, {
            maintenance: Ref.update(unknownMaintenanceRuns, count => count + 1),
            observe: Effect.succeed({
              ...healthyObservation,
              demand: {
                calibrationIdentity: 'fixture-unknown',
                reason: 'page-storage-unknown',
                state: 'unknown',
              },
            }),
          });
          const failed = yield* Effect.flip(acquireCodeGraphDiskReservation(unknown));

          expect(failed).toBeInstanceOf(CodeGraphDiskCapacityObservationError);
          expect(failed.evidence?.reason).toBe('page-storage-unknown');
          expect(yield* Ref.get(unknownMaintenanceRuns)).toBe(0);
          expect(
            yield* FileSystem.FileSystem.pipe(Effect.flatMap(service => service.readDirectory(fixture.ledgerRoot))),
          ).toEqual([]);
        }),
      ).pipe(provideTestLayer(reservationLayer)),
    ),
  );

  effectIt.effect('bounds observation while holding the ledger and releases the lock after timeout', () =>
    withLedgerFixture(fixture =>
      Effect.gen(function* () {
        const observationStarted = yield* Deferred.make<void>();
        const blocked = yield* Effect.forkChild(
          acquireCodeGraphDiskReservation(
            reservationOptions(fixture, {
              observe: Deferred.succeed(observationStarted, undefined).pipe(Effect.andThen(Effect.never)),
            }),
          ).pipe(Effect.exit),
        );
        yield* Deferred.await(observationStarted);
        yield* TestClock.adjust(5_000);
        const timedOut = yield* Fiber.join(blocked);
        expect(Exit.isFailure(timedOut)).toBe(true);

        const lease = yield* acquireCodeGraphDiskReservation(reservationOptions(fixture));
        expect(yield* releaseCodeGraphDiskReservation(reservationOptions(fixture), lease)).toBe('released');
      }),
    ).pipe(provideTestLayer(reservationLayer)),
  );

  effectIt.effect('fails closed instead of falling back when the canonical owner channel is unavailable', () =>
    withLedgerFixture(fixture =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const {canonicalProcessStartIdentity: _canonicalProcessStartIdentity, ...legacySystem} = system;
        const attempted = yield* acquireCodeGraphDiskReservation(reservationOptions(fixture)).pipe(
          Effect.provideService(SystemInfo, SystemInfo.of(legacySystem)),
          Effect.exit,
        );

        expect(Exit.isFailure(attempted)).toBe(true);
        expect(yield* fs.exists(fixture.ledgerRoot)).toBe(false);
      }),
    ).pipe(provideTestLayer(reservationLayer)),
  );

  effectIt.effect('fails closed without mutating unknown ledger entries and recovers only exact orphan temps', () =>
    TestClock.withLive(
      withLedgerFixture(fixture =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const options = reservationOptions(fixture);
          yield* withCodeGraphDiskReservation(options, Effect.void);
          const expectRetained = (target: string) =>
            acquireCodeGraphDiskReservation(options).pipe(
              Effect.exit,
              Effect.tap(exit =>
                Effect.gen(function* () {
                  expect(Exit.isFailure(exit)).toBe(true);
                  expect(yield* fs.exists(target)).toBe(true);
                }),
              ),
              Effect.asVoid,
            );

          const unknown = path.join(fixture.ledgerRoot, 'unknown-entry');
          yield* fs.writeFileString(unknown, '', {flag: 'wx', mode: 0o600});
          yield* expectRetained(unknown);
          yield* fs.remove(unknown);

          const futureToken = Effect2.pipe('c', EffectString.repeat(64));
          const future = path.join(fixture.ledgerRoot, `v1-${futureToken}.json`);
          yield* fs.writeFileString(future, JSON.stringify({token: futureToken, version: 2}), {
            flag: 'wx',
            mode: 0o600,
          });
          yield* expectRetained(future);
          yield* fs.remove(future);

          const directory = path.join(fixture.ledgerRoot, `v1-${Effect2.pipe('d', EffectString.repeat(64))}.json`);
          yield* fs.makeDirectory(directory);
          yield* expectRetained(directory);
          yield* fs.remove(directory, {recursive: true});

          const oversized = path.join(fixture.ledgerRoot, `v1-${Effect2.pipe('e', EffectString.repeat(64))}.json`);
          yield* fs.writeFileString(oversized, Effect2.pipe('x', EffectString.repeat(4_097)), {
            flag: 'wx',
            mode: 0o600,
          });
          yield* expectRetained(oversized);
          yield* fs.remove(oversized);

          if (process.platform !== 'win32') {
            const external = path.join(path.dirname(fixture.ledgerRoot), 'external-receipt');
            const symbolic = path.join(fixture.ledgerRoot, `v1-${Effect2.pipe('f', EffectString.repeat(64))}.json`);
            yield* fs.writeFileString(external, 'external', {flag: 'wx', mode: 0o600});
            yield* fs.symlink(external, symbolic);
            yield* expectRetained(symbolic);
            expect(yield* fs.readFileString(external)).toBe('external');
            yield* fs.remove(symbolic);
            yield* fs.remove(external);
          }

          // This is the exact name emitted between wx creation and atomic
          // rename. A process crash must never turn its residue into an
          // unknown ledger entry that wedges every later claimant.
          const temporary = path.join(
            fixture.ledgerRoot,
            `.v1-${Effect2.pipe('1', EffectString.repeat(64))}.json.${Effect2.pipe('2', EffectString.repeat(64))}.tmp`,
          );
          yield* fs.writeFileString(temporary, 'interrupted', {flag: 'wx', mode: 0o600});
          yield* withCodeGraphDiskReservation(options, Effect.void);
          expect(yield* fs.exists(temporary)).toBe(false);
          expect(yield* fs.readDirectory(fixture.ledgerRoot)).toEqual([]);
        }),
      ).pipe(provideTestLayer(reservationLayer)),
    ),
  );

  effectIt.effect('binds same-process recovery authority to the exact ledger receipt path', () =>
    TestClock.withLive(
      withLedgerFixture(first =>
        withLedgerFixture(second =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const exhausted = reservationOptions(first, {
              beforeReleaseAttempt: Effect.fail(TestError.make({message: 'persistent release fault'})),
            });
            yield* withCodeGraphDiskReservation(exhausted, Effect.void);
            const firstNames = EffectArray.filter(
              yield* fs.readDirectory(first.ledgerRoot),
              __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
            );
            expect(firstNames).toHaveLength(1);
            const receiptName = firstNames[0];
            const token = /^v1-([0-9a-f]{64})\.json$/u.exec(receiptName)?.[1];
            if (!token) return yield* TestError.make({message: 'Fixture receipt name was invalid.'});
            const canonicalReceipt = yield* fs.readFileString(path.join(first.ledgerRoot, receiptName));
            const copiedReceiptPath = path.join(second.ledgerRoot, receiptName);
            yield* fs.makeDirectory(second.ledgerRoot, {recursive: true, mode: 0o700});
            yield* fs.writeFileString(copiedReceiptPath, canonicalReceipt, {flag: 'wx', mode: 0o600});

            const secondOptions = reservationOptions(second, {
              observe: Effect.succeed({
                ...healthyObservation,
                durableAvailableBytes: Number.MAX_SAFE_INTEGER,
                temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
              }),
            });
            const secondLease = yield* acquireCodeGraphDiskReservation(secondOptions);
            expect(yield* fs.exists(copiedReceiptPath)).toBe(true);
            expect(yield* releaseCodeGraphDiskReservation(secondOptions, secondLease)).toBe('released');
            expect(
              yield* releaseCodeGraphDiskReservation(secondOptions, {
                canonicalReceipt,
                receiptPath: copiedReceiptPath,
                token,
              }),
            ).toBe('released');

            yield* withCodeGraphDiskReservation(reservationOptions(first), Effect.void);
            expect(yield* fs.readDirectory(first.ledgerRoot)).toEqual([]);
          }),
        ),
      ).pipe(provideTestLayer(reservationLayer)),
    ),
  );

  effectIt.effect('stops at the 1,024-entry scan bound and performs no over-limit mutation', () =>
    TestClock.withLive(
      withLedgerFixture(fixture =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const options = reservationOptions(fixture);
          yield* withCodeGraphDiskReservation(options, Effect.void);
          const names = Array.from(
            {length: 1_025},
            (_, index) => `over-limit-${Effect2.pipe(String(index), EffectString.padStart(4, '0'))}`,
          );
          yield* Effect.forEach(
            names,
            name => fs.writeFileString(path.join(fixture.ledgerRoot, name), '', {flag: 'wx', mode: 0o600}),
            {concurrency: 32, discard: true},
          );

          expect(Exit.isFailure(yield* acquireCodeGraphDiskReservation(options).pipe(Effect.exit))).toBe(true);
          expect((yield* fs.readDirectory(fixture.ledgerRoot)).sort()).toEqual(names);
        }),
      ).pipe(provideTestLayer(reservationLayer)),
    ),
  );

  fcEffectProp(
    effectIt,
    'matches an independent claim-release state machine for every bounded action sequence',
    {actions: fc.array(fc.constantFrom('claim' as const, 'release' as const), {maxLength: 24})},
    ({actions}) =>
      TestClock.withLive(
        withLedgerFixture(fixture =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const options = reservationOptions(fixture, {
              observe: Effect.succeed({
                ...healthyObservation,
                durableAvailableBytes: Number.MAX_SAFE_INTEGER,
                temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
              }),
            });
            yield* Effect.acquireUseRelease(
              Effect.sync(() => [] as CodeGraphDiskReservationLease[]),
              leases =>
                Effect.gen(function* () {
                  for (const action of actions) {
                    if (action === 'claim') {
                      leases.push(yield* acquireCodeGraphDiskReservation(options));
                    } else {
                      const lease = leases.pop();
                      if (lease) expect(yield* releaseCodeGraphDiskReservation(options, lease)).toBe('released');
                    }
                    const receiptCount = (yield* fs.exists(fixture.ledgerRoot))
                      ? EffectArray.filter(
                          yield* fs.readDirectory(fixture.ledgerRoot),
                          __effectArrayValue =>
                            !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
                        ).length
                      : 0;
                    expect(receiptCount).toBe(leases.length);
                  }
                }),
              leases =>
                Effect.forEach(leases, lease => releaseCodeGraphDiskReservation(options, lease), {discard: true}).pipe(
                  Effect.ignore,
                ),
            );
          }),
        ).pipe(provideTestLayer(reservationLayer)),
      ),
    {fastCheck: {numRuns: 40}},
  );

  effectIt.effect('prevents overcommit while eight OS children repeatedly claim and release', () =>
    TestClock.withLive(
      withLedgerFixture(fixture =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const barrierRoot = path.join(path.dirname(fixture.ledgerRoot), 'eight-child-ready');
          const releasePath = path.join(barrierRoot, 'release');
          yield* fs.makeDirectory(barrierRoot, {recursive: true, mode: 0o700});
          const childOptions = Array.from({length: 8}, (_, index): ReservationChildOptions => ({
            availableBytes: 59,
            barrier: {
              childId: String(index),
              readyRoot: barrierRoot,
              releasePath,
            },
            filesystemKey,
            holdMilliseconds: 20,
            iterations: 4,
            mode: 'normal',
          }));
          const results = yield* Effect.acquireUseRelease(
            Effect.forEach(childOptions, options => startReservationChild(fixture, options), {concurrency: 8}),
            children =>
              Effect.gen(function* () {
                yield* waitForReservationChildrenReady(
                  EffectArray.map(childOptions, options =>
                    path.join(options.barrier!.readyRoot, `${options.barrier!.childId}.ready`),
                  ),
                );
                // Every process has reached the barrier before any process may
                // perform its first claim, so startup serialization cannot
                // turn this contention test into a false pass.
                yield* fs.writeFileString(releasePath, 'release', {flag: 'wx', mode: 0o600});
                return yield* Effect.forEach(children, collectReservationChild, {concurrency: 8});
              }),
            children => Effect.forEach(children, terminateReservationChild, {discard: true}),
          );
          const failures = EffectArray.filter(results, result => result.exitCode !== 0);
          if (failures[0]) {
            return yield* TestError.make({message: `Disk reservation child failed: ${failures[0].stderr}`});
          }
          const events = EffectArray.flatMap(results, result => result.events);
          const intervals = EffectArray.map(
            EffectArray.filter(
              events,
              (event): event is ReservationChildEvent & {readonly event: 'acquired'} => event.event === 'acquired',
            ),
            acquired => {
              const leaving = Option.getOrUndefined(
                EffectArray.findFirst(
                  events,
                  (event): event is Extract<ReservationChildEvent, {readonly event: 'leaving'}> =>
                    event.event === 'leaving' &&
                    event.processId === acquired.processId &&
                    event.iteration === acquired.iteration,
                ),
              );
              if (!leaving) throw TestError.make({message: 'Disk reservation child omitted its leaving marker.'});
              return {
                acquiredAt: acquired.at,
                acquisitionMilliseconds: acquired.acquisitionMilliseconds,
                leavingAt: leaving.at,
              };
            },
          ).sort((left, right) => left.acquiredAt - right.acquiredAt);
          expect(intervals).toHaveLength(32);
          for (let index = 1; index < intervals.length; index += 1) {
            expect(intervals[index].acquiredAt).toBeGreaterThanOrEqual(intervals[index - 1].leavingAt);
          }
          expect(
            EffectArray.every(
              results,
              result => EffectArray.filter(result.events, event => event.event === 'acquired').length === 4,
            ),
          ).toBe(true);
          const acquisitionMilliseconds = EffectArray.map(intervals, interval => interval.acquisitionMilliseconds).sort(
            (left, right) => left - right,
          );
          const percentile = (fraction: number) =>
            acquisitionMilliseconds[Math.min(acquisitionMilliseconds.length - 1, Math.floor(fraction * 31))];
          yield* Effect.logInfo(
            `Disk reservation eight-child contended wait p50=${percentile(0.5)}ms p95=${percentile(0.95)}ms`,
          );
          expect(yield* fs.readDirectory(fixture.ledgerRoot)).toEqual([]);
        }),
      ).pipe(provideTestLayer(reservationLayer)),
    ),
  );

  effectIt.effect('releases normal claims with sixteen live receipts and records latency telemetry', () =>
    TestClock.withLive(
      withLedgerFixture(fixture =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const options = reservationOptions(fixture, {
            observe: Effect.succeed({
              ...healthyObservation,
              durableAvailableBytes: Number.MAX_SAFE_INTEGER,
              temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
            }),
          });
          yield* Effect.acquireUseRelease(
            Effect.forEach(Array.from({length: 16}), () => acquireCodeGraphDiskReservation(options)),
            () =>
              Effect.gen(function* () {
                const samples: number[] = [];
                for (let index = 0; index < 64; index += 1) {
                  const startedAt = performance.now();
                  const lease = yield* acquireCodeGraphDiskReservation(options);
                  yield* releaseCodeGraphDiskReservation(options, lease);
                  samples.push(Math.max(0, performance.now() - startedAt));
                }
                samples.sort((left, right) => left - right);
                const p95 = samples[Math.floor(samples.length * 0.95)];
                const p99 = samples[Math.floor(samples.length * 0.99)];
                expect(samples).toHaveLength(64);
                expect(EffectArray.every(samples, sample => Number.isFinite(sample) && sample >= 0)).toBe(true);
                yield* Effect.logInfo(`Disk reservation native claim p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`);
              }),
            leases =>
              Effect.forEach(leases, lease => releaseCodeGraphDiskReservation(options, lease), {discard: true}).pipe(
                Effect.ignore,
              ),
          );
          expect(yield* fs.readDirectory(fixture.ledgerRoot)).toEqual([]);
        }),
      ).pipe(provideTestLayer(reservationLayer)),
    ),
  );

  effectIt.effect('allows separate device keys to overlap and reaps a SIGKILL holder by owner identity', () =>
    TestClock.withLive(
      withLedgerFixture(fixture =>
        Effect.gen(function* () {
          const successor = yield* Effect.acquireUseRelease(
            Effect.all(
              [
                startReservationChild(fixture, {
                  availableBytes: 59,
                  filesystemKey: Effect2.pipe('a', EffectString.repeat(64)),
                  holdMilliseconds: 0,
                  iterations: 1,
                  mode: 'forever',
                }),
                startReservationChild(fixture, {
                  availableBytes: 59,
                  filesystemKey: Effect2.pipe('b', EffectString.repeat(64)),
                  holdMilliseconds: 0,
                  iterations: 1,
                  mode: 'forever',
                }),
              ],
              {concurrency: 2},
            ),
            holders =>
              Effect.gen(function* () {
                const markers = yield* Effect.all(
                  EffectArray.map(holders, holder => readReservationChildMarker(holder.stdout)),
                  {concurrency: 2},
                );
                const modes = EffectArray.map(markers, marker => {
                  if (marker.event !== 'acquired') {
                    throw TestError.make({message: 'Disk reservation child omitted its acquisition marker.'});
                  }
                  return marker.mode;
                });
                expect(EffectArray.every(markers, marker => marker.event === 'acquired')).toBe(true);
                expect(modes).toEqual(['forever', 'forever']);
                expect(EffectArray.map(holders, holder => holder.exitCode)).toEqual([null, null]);
                const fs = yield* FileSystem.FileSystem;
                expect(
                  EffectArray.filter(
                    yield* fs.readDirectory(fixture.ledgerRoot),
                    __effectArrayValue =>
                      !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
                  ),
                ).toHaveLength(2);
                for (const holder of holders) holder.kill('SIGKILL');
                yield* Effect.forEach(holders, holder => Effect.promise(() => holder.exited), {discard: true});
                return yield* runReservationChild(fixture, {
                  availableBytes: 59,
                  filesystemKey,
                  holdMilliseconds: 1,
                  iterations: 1,
                  mode: 'normal',
                });
              }),
            holders => Effect.forEach(holders, terminateReservationChild, {discard: true}),
          );
          expect(successor.exitCode).toBe(0);
          expect(EffectArray.some(successor.events, event => event.event === 'acquired')).toBe(true);
          const fs = yield* FileSystem.FileSystem;
          expect(yield* fs.readDirectory(fixture.ledgerRoot)).toEqual([]);
        }),
      ).pipe(provideTestLayer(reservationLayer)),
    ),
  );
});

function reservationOptions<R = never>(
  fixture: LedgerFixture,
  overrides: Partial<CodeGraphDiskReservationOptions<R>> = {},
): CodeGraphDiskReservationOptions<R> {
  return {
    boundary,
    ledgerLockPath: fixture.ledgerLockPath,
    ledgerRoot: fixture.ledgerRoot,
    maintenance: Effect.void,
    observe: Effect.succeed(healthyObservation),
    ...overrides,
  };
}

function withLedgerFixture<A, E, R>(
  use: (fixture: LedgerFixture) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R | FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({prefix: 'threadnote-disk-reservation-'}),
      root =>
        use({
          ledgerLockPath: path.join(root, 'locks', 'disk-capacity-reservations.lock'),
          ledgerRoot: path.join(root, 'locks', 'disk-capacity-reservations'),
        }),
      root => fs.remove(root, {force: true, recursive: true}).pipe(Effect.ignore),
    );
  });
}

function startReservationChild(
  fixture: LedgerFixture,
  options: ReservationChildOptions,
): Effect.Effect<ReservationChildProcess, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return Bun.spawn({
      cmd: [
        process.execPath,
        'run',
        path.join(process.cwd(), 'apps', 'threadnote', 'test', 'helpers', 'code-graph-disk-reservation-child.ts'),
        fixture.ledgerRoot,
        fixture.ledgerLockPath,
        String(options.availableBytes),
        String(options.holdMilliseconds),
        options.filesystemKey,
        options.mode,
        String(options.iterations),
        options.barrier?.readyRoot ?? '-',
        options.barrier?.releasePath ?? '-',
        options.barrier?.childId ?? '-',
      ],
      stderr: 'pipe',
      stdout: 'pipe',
    });
  });
}

function runReservationChild(fixture: LedgerFixture, options: ReservationChildOptions) {
  return Effect.acquireUseRelease(
    startReservationChild(fixture, options),
    collectReservationChild,
    terminateReservationChild,
  );
}

function collectReservationChild(child: ReservationChildProcess) {
  return Effect.gen(function* () {
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        Effect.promise(() => child.exited),
        readBoundedReservationChildStream(child.stdout, 64 * 1_024),
        readBoundedReservationChildStream(child.stderr, 64 * 1_024),
      ] as const,
      {concurrency: 3},
    );
    const events = yield* Effect.try({
      try: () =>
        EffectArray.map(EffectArray.filter(Effect2.pipe(stdout, EffectString.split(/\r?\n/)), Boolean), line =>
          parseReservationChildEvent(JSON.parse(line)),
        ),
      catch: cause => TestError.make({message: 'Disk reservation child output was invalid.', cause}),
    });
    return {events, exitCode, stderr: Effect2.pipe(stderr, EffectString.trim)};
  });
}

function waitForReservationChildrenReady(readyPaths: readonly string[]) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const deadline = (yield* Clock.currentTimeMillis) + 10_000;
    while (true) {
      const ready = yield* Effect.forEach(readyPaths, target => fs.exists(target), {concurrency: 8});
      if (EffectArray.every(ready, Boolean)) return;
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* TestError.make({message: 'Disk reservation children missed the barrier.'});
      yield* Effect.sleep(10);
    }
  });
}

function terminateReservationChild(child: ReservationChildProcess): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (child.exitCode === null) child.kill('SIGKILL');
    yield* Effect.promise(() => child.exited);
  });
}

function readReservationChildMarker(stream: ReadableStream<Uint8Array>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    reader =>
      Effect.tryPromise({
        try: async () => {
          const decoder = new TextDecoder();
          let buffered = '';
          while (true) {
            const next = await reader.read();
            if (next.done) throw TestError.make({message: 'Disk reservation child exited before its marker.'});
            buffered += decoder.decode(next.value, {stream: true});
            if (new TextEncoder().encode(buffered).byteLength > 4_096) {
              throw TestError.make({message: 'Disk reservation child marker exceeded its byte bound.'});
            }
            const newline = Effect2.pipe(
              buffered,
              EffectString.indexOf('\n'),
              Effect2.Option.getOrElse(() => -1),
            );
            if (newline >= 0)
              return parseReservationChildEvent(JSON.parse(Effect2.pipe(buffered, EffectString.slice(0, newline))));
          }
        },
        catch: cause => TestError.make({message: 'Could not read disk reservation child marker.', cause}),
      }),
    reader => Effect.sync(() => reader.releaseLock()),
  );
}

function readBoundedReservationChildStream(stream: ReadableStream<Uint8Array>, maximumBytes: number) {
  return Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    reader =>
      Effect.tryPromise({
        try: async () => {
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            totalBytes += next.value.byteLength;
            if (totalBytes > maximumBytes)
              throw TestError.make({message: 'Disk reservation child output exceeded its byte bound.'});
            chunks.push(next.value);
          }
          const joined = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            joined.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return new TextDecoder('utf-8', {fatal: true}).decode(joined);
        },
        catch: cause => TestError.make({message: 'Could not read bounded disk reservation child output.', cause}),
      }),
    reader => Effect.promise(() => reader.cancel()),
  );
}

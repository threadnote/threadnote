import {SecureRandom} from 'effect/crypto';
import {
  codeGraphDirectPersistentCapacityProtector,
  observeDirectPersistentCapacityForTest,
} from '../../src/indexer/capacity_protection.js';
import {makeCandidatePreparationGates} from '../../src/indexer/candidate_resources.js';
import {
  makeCodeGraphBuildResourceCoordinator,
  EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE,
} from '../../src/build/resources.js';
import {CodeGraphMaintenanceCoordinator} from '../../src/maintenance/coordinator.js';
import {
  codeGraphLayout,
  codeGraphBuilderAdmissionRoot,
  codeGraphDiskReservationRoot,
  codeGraphDiskReservationLockPath,
} from '../../src/layout.js';
import {codeGraphDiskReservationFilesystemKey} from '../../src/disk/reservation.js';
import type {RepositoryIdentity} from '../../src/types.js';
import {
  candidateCapacityPlan,
  consumeCandidateCapacity,
  withCandidateCapacityWitness,
  assertCurrentCandidateCapacity,
} from '../../src/store/resolution/candidate_capacity.js';
import {CurrentCandidateStage} from '../../src/build/resources.js';
import {Database} from 'bun:sqlite';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  ensureResolutionCandidateIndexSchema,
  resolutionCandidateAuthorityToken,
} from '../../src/store/resolution/candidate_index.js';
import {
  finishResolutionCandidateIndex,
  stageResolutionCandidateIndex,
  candidateIndexWrite,
} from '../../src/store/resolution/candidate_index_write.js';
import {isDefaultCandidateSqliteClient, useDatabaseDirect, useExistingDatabase} from '../../src/store/session.js';
import {win32} from '@threadnote/testing/node-path';
import {codeGraphDiskCapacityReservationProjection} from '../../src/disk/capacity.js';
import {candidateSnapshotKey} from '../../src/store/resolution/candidate_page_store.js';
import {readCandidateFileProjection} from '../../src/store/resolution/candidate_page_read.js';
import type {CodeGraphReference} from '../../src/types.js';
import type {CodeGraphDirectPersistentCapacityProtector} from '../../src/store/models.js';
import {codeGraphBuilderAdmissionSlotPath} from '../../src/layout.js';
import {
  withCodeGraphBuilderAdmission,
  withCodeGraphCandidateStageSlot,
  codeGraphCandidateStageOwnership,
  currentCodeGraphBuilderSlotForTest,
  assertCodeGraphBuilderSlotForTest,
} from '../../src/builder/admission.js';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Cause, Clock, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {SystemInfo} from '@threadnote/platform/system';
import {
  withCodeGraphDiskReservation,
  tryWithCodeGraphDiskReservationLease,
  type CodeGraphDiskReservationOptions,
} from '../../src/disk/reservation.js';
import {withCodeGraphIndexTiming, type CodeGraphIndexTimingObserver} from '../../src/indexer/types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const platformServicesLayer = Layer.merge(BunServices.layer, cryptoLayer);

const stages = EffectArray.map(
  ['owner-identity', 'claim', 'use', 'release'],
  stage => `reference-reservation-${stage}`,
);
const completeEvents = ['owner', 'owner', 'claim', 'use', 'release', 'owner'];
const provideFixtureLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Layer.build(platformServicesLayer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  );
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-reference-reservation-timing-'});
  const events: string[] = [];
  const options = {
    boundary: {operation: 'resolve persistent code graph references', finalFactBytes: 1, rowCount: 1},
    ledgerLockPath: path.join(root, 'ledger.lock'),
    ledgerRoot: path.join(root, 'ledger'),
    maintenance: Effect.die('unexpected maintenance'),
    observe: Effect.sync(() => {
      events.push('claim');
      return {
        demand: {
          calibrationIdentity: 'fixture-v1',
          mainHighWaterBytes: 10,
          recoveryFloorBytes: 10,
          state: 'measured' as const,
          transientFilesystem: 'durable' as const,
          transientHighWaterBytes: 10,
        },
        durableAvailableBytes: 100,
        durableFilesystemKey: Effect2.pipe('a', EffectString.repeat(64)),
        freelistBytes: 0,
        temporaryAvailableBytes: 100,
        temporaryFilesystemKey: Effect2.pipe('a', EffectString.repeat(64)),
      };
    }),
    beforeReleaseAttempt: Effect.sync(() => {
      events.push('release');
    }),
  } satisfies CodeGraphDiskReservationOptions;
  const unexpected = () => {
    throw TestError.make({message: 'Unexpected system operation outside the synthetic reservation fixture'});
  };
  const system = SystemInfo.of({
    architecture: 'fixture',
    availableDiskBytes: unexpected,
    currentDirectory: () => root,
    environment: () => ({}),
    developmentEntrypoint: 'fixture',
    intendedChildEnvironment: unexpected,
    executablePath: 'fixture',
    homeDirectory: root,
    hardwareInfo: Effect.die('unexpected hardware observation'),
    memoryUsage: unexpected,
    runtimeVersion: 'fixture',
    pathDelimiter: ':',
    processArguments: [],
    readLine: unexpected,
    signalProcess: unexpected,
    setExitCode: unexpected,
    setEnvironmentVariable: unexpected,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    tempDirectory: root,
    userName: 'fixture',
    platform: 'linux',
    processId: 4242,
    isProcessRunning: () => false,
    canonicalProcessStartIdentity: () =>
      Effect.sync(() => {
        events.push('owner');
        return 'linux:123';
      }),
    processStartIdentity: () => Effect.succeed('linux:123'),
  });
  return {fs, options, events, system};
});

effectIt.effect('observes the original reference reservation owner, claim, use and release in order', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const observed: string[] = [];
    const options = {
      ...f.options,
      onTiming: (stage: string) =>
        Effect.sync(() => {
          observed.push(`start:${stage}`);
          return Effect.sync(() => {
            observed.push(`end:${stage}`);
          });
        }),
    };
    const result = yield* withCodeGraphDiskReservation(
      options,
      Effect.sync(() => {
        f.events.push('use');
        return 'value';
      }),
    ).pipe(Effect.provideService(SystemInfo, f.system));
    expect(result).toBe('value');
    expect(f.events).toEqual(completeEvents);
    expect(observed).toEqual(EffectArray.flatMap(stages, stage => [`start:${stage}`, `end:${stage}`]));
    expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
  }).pipe(TestClock.withLive, provideFixtureLayer),
);

effectIt.effect('keeps the original effect when timing is disabled and observes no other operation', () =>
  Effect.gen(function* () {
    const program = Effect.succeed('original');
    expect(withCodeGraphIndexTiming(undefined, 'reference-reservation-use', program)).toBe(program);
    const f = yield* fixture;
    const options = {
      ...f.options,
      boundary: {...f.options.boundary, operation: 'resolve persistent code graph reexport aliases' as const},
      onTiming: () => Effect.die('other operations must not invoke the observer'),
    };
    let observations = 0;
    const result = yield* withCodeGraphDiskReservation(
      {
        ...options,
        onTiming: () => {
          observations++;
          return options.onTiming();
        },
      },
      Effect.sync(() => {
        f.events.push('use');
        return 'original';
      }),
    ).pipe(Effect.provideService(SystemInfo, f.system));
    expect(result).toBe('original');
    expect(observations).toBe(0);
    expect(f.events).toEqual(completeEvents);
  }).pipe(TestClock.withLive, provideFixtureLayer),
);

effectIt.effect('a refused original acquisition never executes the transaction or release', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const observed: string[] = [];
    const exit = yield* withCodeGraphDiskReservation(
      {
        ...f.options,
        observe: Effect.fail(TestError.make({message: 'original observation unavailable'})),
        onTiming: stage =>
          Effect.sync(() => {
            observed.push(`start:${stage}`);
            return Effect.sync(() => {
              observed.push(`end:${stage}`);
            });
          }),
      },
      Effect.sync(() => {
        f.events.push('use');
      }),
    ).pipe(Effect.provideService(SystemInfo, f.system), Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(f.events).toEqual(['owner', 'owner']);
    expect(observed).toEqual(EffectArray.flatMap(stages.slice(0, 2), stage => [`start:${stage}`, `end:${stage}`]));
    expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
  }).pipe(TestClock.withLive, provideFixtureLayer),
);

const observerModes = ['normal', 'throw', 'start-failure', 'start-defect', 'end-failure', 'end-defect'] as const;
const observerFor =
  (mode: (typeof observerModes)[number]): CodeGraphIndexTimingObserver =>
  () => {
    const failure = TestError.make({message: 'observer-only failure'});
    if (mode === 'throw') throw failure;
    if (mode === 'start-failure') return Effect.fail(failure);
    if (mode === 'start-defect') return Effect.die(failure);
    if (mode === 'end-failure') return Effect.succeed(Effect.fail(failure));
    if (mode === 'end-defect') return Effect.succeed(Effect.die(failure));
    return Effect.succeed(Effect.void);
  };

effectIt.effect(
  'observer startup and completion failures or defects preserve original success, typed failures and defects',
  () =>
    Effect.gen(function* () {
      const failure = TestError.make({message: 'original program failure'});
      for (const mode of observerModes) {
        for (const outcome of ['success', 'failure', 'defect']) {
          const f = yield* fixture;
          const original =
            outcome === 'success'
              ? Effect.succeed('value')
              : outcome === 'failure'
                ? Effect.fail(failure)
                : Effect.die(failure);
          const program = Effect.sync(() => {
            f.events.push('use');
          }).pipe(Effect.andThen(original));
          const actual = yield* withCodeGraphDiskReservation({...f.options, onTiming: observerFor(mode)}, program).pipe(
            Effect.provideService(SystemInfo, f.system),
            Effect.exit,
          );
          const expected = yield* original.pipe(Effect.exit);
          expect(actual).toEqual(expected);
          expect(f.events).toEqual(completeEvents);
          expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
        }
      }
    }).pipe(TestClock.withLive, provideFixtureLayer),
);

effectIt.effect(
  'interruption preserves original transaction cleanup and reservation release despite observer defects',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      let cleaned = 0;
      const fiber = yield* withCodeGraphDiskReservation(
        {...f.options, onTiming: observerFor('end-defect')},
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              cleaned++;
            }),
          ),
        ),
      ).pipe(Effect.provideService(SystemInfo, f.system), Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(cleaned).toBe(1);
      expect(EffectArray.filter(f.events, event => event === 'release')).toHaveLength(1);
      expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
    }).pipe(TestClock.withLive, provideFixtureLayer),
);

fcEffectProp(
  effectIt,
  'optional reference timing preserves outcomes, exact work and immutable request fields',
  {
    enabled: fc.boolean(),
    otherOperation: fc.boolean(),
    mode: fc.constantFrom(...observerModes),
    outcome: fc.constantFrom('success', 'failure', 'defect'),
    value: fc.integer(),
  },
  input =>
    Effect.gen(function* () {
      const originalInput = {...input};
      const f = yield* fixture;
      const boundary = Object.freeze({
        ...f.options.boundary,
        ...(input.otherOperation ? {operation: 'stage persistent code graph facts' as const} : {}),
      });
      const beforeBoundary = {...boundary};
      let observerCalls = 0;
      const observer = observerFor(input.mode);
      const options = Object.freeze({
        ...f.options,
        boundary,
        ...(input.enabled
          ? {
              onTiming: (stage: Parameters<CodeGraphIndexTimingObserver>[0]) => {
                observerCalls++;
                expect(stages).toContain(stage);
                return observer(stage);
              },
            }
          : {}),
      });
      const failure = TestError.make({message: 'original property outcome'});
      const outcome =
        input.outcome === 'success'
          ? Effect.succeed(input.value)
          : input.outcome === 'failure'
            ? Effect.fail(failure)
            : Effect.die(failure);
      const actual = yield* withCodeGraphDiskReservation(
        options,
        Effect.sync(() => {
          f.events.push('use');
        }).pipe(Effect.andThen(outcome)),
      ).pipe(Effect.provideService(SystemInfo, f.system), Effect.exit);
      expect(actual).toEqual(yield* outcome.pipe(Effect.exit));
      expect(observerCalls).toBe(input.enabled && !input.otherOperation ? 4 : 0);
      expect(f.events).toEqual(completeEvents);
      expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
      expect(boundary).toEqual(beforeBoundary);
      expect(input).toEqual(originalInput);
    }).pipe(TestClock.withLive, provideFixtureLayer),
  {fastCheck: {numRuns: 20}},
);

effectIt.effect(
  'uses one actual outer candidate claim for multiple children and rejects nested, cloned and released authority',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const plan = candidateCapacityPlan({
        snapshotId: 'snapshot',
        files: [{path: 'file', contentHash: 'hash'}],
        references: [],
      });
      const binding = {
        databasePath: 'db',
        snapshotId: 'snapshot',
        authority: 'authority',
        sourceFingerprint: plan.sourceFingerprint,
      };
      const boundary = {operation: 'stage persistent code graph facts' as const, rowCount: 1, finalFactBytes: 1};
      let saved: Parameters<typeof consumeCandidateCapacity>[0] | undefined;
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new Database(':memory:')),
        database => Effect.sync(() => database.close()),
      );
      db.exec('CREATE TABLE commits(id INTEGER PRIMARY KEY)');
      let writes = 0;
      const failure = {exact: 'original'};
      const request = {
        ...f.options,
        boundary: {
          ...boundary,
          rowCount: plan.rows,
          finalFactBytes: plan.bytes,
          candidateWindow: {children: plan.children, rows: plan.rows, bytes: plan.bytes},
        },
        candidateWindow: {...binding, planCanonical: JSON.stringify(plan)},
      };
      const exit = yield* tryWithCodeGraphDiskReservationLease(request, lease =>
        Effect.gen(function* () {
          const neverUse = () =>
            Effect.sync(() => {
              writes++;
            });
          for (const rejected of [
            withCandidateCapacityWitness({...lease}, plan, binding, neverUse),
            withCandidateCapacityWitness(lease, {...plan, rows: plan.rows + 1}, binding, neverUse),
            withCandidateCapacityWitness(lease, plan, {...binding, authority: 'foreign'}, neverUse),
            withCandidateCapacityWitness(lease, plan, binding, neverUse).pipe(
              Effect.provideService(FileSystem.FileSystem, {...f.fs}),
            ),
          ])
            expect(Exit.isFailure(yield* rejected.pipe(Effect.exit))).toBe(true);
          const child = yield* withCandidateCapacityWitness(lease, plan, binding, neverUse).pipe(
            Effect.exit,
            Effect.forkChild,
          );
          expect(Exit.isFailure(yield* Fiber.join(child))).toBe(true);
          return yield* withCandidateCapacityWitness(lease, plan, binding, w =>
            Effect.gen(function* () {
              saved = w;
              expect(
                Exit.isFailure(yield* withCandidateCapacityWitness(lease, plan, binding, neverUse).pipe(Effect.exit)),
              ).toBe(true);
              expect(
                Exit.isFailure(
                  yield* consumeCandidateCapacity(
                    {...w},
                    binding,
                    boundary,
                    Effect.sync(() => {
                      writes++;
                    }),
                  ).pipe(Effect.exit),
                ),
              ).toBe(true);
              expect(
                Exit.isFailure(
                  yield* consumeCandidateCapacity(
                    w,
                    {...binding, snapshotId: 'foreign'},
                    boundary,
                    Effect.sync(() => {
                      writes++;
                    }),
                  ).pipe(Effect.exit),
                ),
              ).toBe(true);
              const nested = yield* withCodeGraphDiskReservation(f.options, Effect.die('nested must not enter')).pipe(
                Effect.exit,
              );
              expect(Exit.isFailure(nested)).toBe(true);
              yield* consumeCandidateCapacity(
                w,
                binding,
                boundary,
                Effect.sync(() => {
                  db.transaction(() => db.exec('INSERT INTO commits VALUES(1)'))();
                  writes++;
                }),
              );
              yield* consumeCandidateCapacity(
                w,
                binding,
                boundary,
                Effect.sync(() => {
                  db.transaction(() => db.exec('INSERT INTO commits VALUES(2)'))();
                  writes++;
                }),
              );
              return yield* consumeCandidateCapacity(w, binding, boundary, Effect.fail(failure));
            }),
          );
        }),
      ).pipe(Effect.provideService(SystemInfo, f.system), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(exit.cause).toMatchObject({reasons: [{error: failure}]});
      expect(writes).toBe(2);
      expect(db.query('SELECT id FROM commits ORDER BY id').all()).toEqual([{id: 1}, {id: 2}]);
      expect(EffectArray.filter(f.events, x => x === 'claim')).toHaveLength(1);
      expect(EffectArray.filter(f.events, x => x === 'release')).toHaveLength(1);
      expect(
        Exit.isFailure(
          yield* consumeCandidateCapacity(
            saved!,
            binding,
            boundary,
            Effect.sync(() => {
              writes++;
            }),
          ).pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(writes).toBe(2);
    }).pipe(provideFixtureLayer, TestClock.withLive),
);

effectIt.effect(
  'refuses a second home ticket before admission or filesystem work inside an owned candidate stage',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let entered = 0,
        filesystemCalls = 0,
        queued = 0,
        admitted = 0,
        resumed = 0,
        waiting = 0;
      const fs = new Proxy(f.fs, {
        get(target, key, receiver) {
          const member: unknown = Reflect.get(target, key, receiver);
          if (typeof member !== 'function') return member;
          return () => {
            filesystemCalls++;
            return Effect.die('Forbidden postsetup filesystem operation');
          };
        },
      });
      const exit = yield* withCodeGraphBuilderAdmission(
        {
          admissionClass: 'current-required',
          threadnoteHome: 'unused',
          onQueue: () =>
            Effect.sync(() => {
              queued++;
            }),
          onAdmitted: Effect.sync(() => {
            admitted++;
          }),
          onResumed: Effect.sync(() => {
            resumed++;
          }),
          onWaiting: Effect.sync(() => {
            waiting++;
          }),
        },
        Effect.sync(() => {
          entered++;
          return 'successful callback must remain unentered';
        }),
      ).pipe(
        Effect.provideService(CurrentCandidateStage, true),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(SystemInfo, f.system),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toHaveLength(1);
        const reason = exit.cause.reasons[0];
        expect(Cause.isFailReason(reason)).toBe(true);
        if (Cause.isFailReason(reason))
          expect(reason.error).toMatchObject({
            _tag: 'CodeGraphBuilderAdmissionError',
            message: 'Candidate stage cannot acquire another home ticket.',
          });
        expect(Cause.hasDies(exit.cause)).toBe(false);
      }
      expect({entered, filesystemCalls, queued, admitted, resumed, waiting}).toEqual({
        entered: 0,
        filesystemCalls: 0,
        queued: 0,
        admitted: 0,
        resumed: 0,
        waiting: 0,
      });
      expect(f.events).toEqual([]); // No owner observation, disk claim, protected use, release or wait.
    }).pipe(provideFixtureLayer),
);

effectIt.effect(
  'borrows only the actual same-fiber slot and rejects clone, foreign, child, changed and released ownership',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = yield* Path.Path;
      const system = SystemInfo.of({...f.system, isProcessRunning: pid => pid === f.system.processId});
      const home = path.dirname(f.options.ledgerRoot);
      const expected = {
        threadnoteHome: home,
        identity: {checkoutId: EffectString.repeat(64)('a'), worktreeId: EffectString.repeat(64)('b')},
      };
      let saved: Effect.Success<typeof currentCodeGraphBuilderSlotForTest>;
      let newAdmissions = 0,
        uses = 0;
      yield* withCodeGraphBuilderAdmission(
        {admissionClass: 'current-required', ...expected},
        Effect.gen(function* () {
          saved = yield* currentCodeGraphBuilderSlotForTest;
          expect(saved).toBeDefined();
          if (!saved) return yield* Effect.die('Missing actual owner');
          yield* withCodeGraphCandidateStageSlot(
            expected,
            effect => {
              newAdmissions++;
              return effect;
            },
            Effect.gen(function* () {
              expect(yield* codeGraphCandidateStageOwnership(expected)).toBe('borrowed');
              uses++;
            }),
          );
          expect(newAdmissions).toBe(0);
          expect(uses).toBe(1);
          expect(Exit.isFailure(yield* assertCodeGraphBuilderSlotForTest({...saved}, expected).pipe(Effect.exit))).toBe(
            true,
          );
          expect(
            Exit.isFailure(
              yield* assertCodeGraphBuilderSlotForTest(saved, {...expected, threadnoteHome: home + '-foreign'}).pipe(
                Effect.exit,
              ),
            ),
          ).toBe(true);
          expect(
            Exit.isFailure(
              yield* assertCodeGraphBuilderSlotForTest(saved, {
                ...expected,
                identity: {...expected.identity, checkoutId: EffectString.repeat(64)('c')},
              }).pipe(Effect.exit),
            ),
          ).toBe(true);
          const child = yield* assertCodeGraphBuilderSlotForTest(saved, expected).pipe(Effect.exit, Effect.forkChild);
          expect(Exit.isFailure(yield* Fiber.join(child))).toBe(true);
          const original = yield* f.fs.readFileString(codeGraphBuilderAdmissionSlotPath(path, home, 0) + '.owner.json');
          yield* f.fs.writeFileString(codeGraphBuilderAdmissionSlotPath(path, home, 0) + '.owner.json', original + ' ');
          expect(Exit.isFailure(yield* assertCodeGraphBuilderSlotForTest(saved, expected).pipe(Effect.exit))).toBe(
            true,
          );
        }),
      ).pipe(Effect.provideService(SystemInfo, system));
      if (!saved) return yield* Effect.die('Missing retained opaque observation');
      expect(
        Exit.isFailure(
          yield* assertCodeGraphBuilderSlotForTest(saved, expected).pipe(
            Effect.provideService(SystemInfo, system),
            Effect.exit,
          ),
        ),
      ).toBe(true);
    }).pipe(provideFixtureLayer, TestClock.withLive),
);

effectIt.effect(
  'refuses a new candidate claim under a live same-ledger scalar ancestor across a different ledger',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = yield* Path.Path;
      const other = {
        ...f.options,
        ledgerRoot: path.join(path.dirname(f.options.ledgerRoot), 'other'),
        ledgerLockPath: path.join(path.dirname(f.options.ledgerRoot), 'other.lock'),
      };
      let candidateUses = 0;
      yield* withCodeGraphDiskReservation(
        f.options,
        withCodeGraphDiskReservation(
          other,
          Effect.gen(function* () {
            const failure = yield* tryWithCodeGraphDiskReservationLease(f.options, () =>
              Effect.sync(() => {
                candidateUses++;
              }),
            ).pipe(Effect.exit);
            expect(Exit.isFailure(failure)).toBe(true);
          }),
        ),
      ).pipe(Effect.provideService(SystemInfo, f.system));
      expect(candidateUses).toBe(0);
      expect(EffectArray.filter(f.events, x => x === 'claim')).toHaveLength(2); // No third claim/observation or same-ledger wait.
    }).pipe(provideFixtureLayer, TestClock.withLive),
);

effectIt.effect('refuses same-token altered selected-ticket sidecars BEFORE actual slot mint', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const path = yield* Path.Path;
    const home = path.dirname(f.options.ledgerRoot);
    const system = SystemInfo.of({...f.system, isProcessRunning: pid => pid === f.system.processId});
    let mutations = 0,
      uses = 0;
    const fs = {
      ...f.fs,
      rename: (from: string, to: string) =>
        f.fs.rename(from, to).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              if (!EffectString.endsWith('.owner.json')(to)) return;
              const body = JSON.parse(yield* f.fs.readFileString(to));
              yield* f.fs.writeFileString(to, JSON.stringify({...body, createdAt: body.createdAt + 1}));
              mutations++;
            }),
          ),
        ),
    };
    const exit = yield* withCodeGraphBuilderAdmission(
      {
        admissionClass: 'current-required',
        threadnoteHome: home,
        identity: {checkoutId: EffectString.repeat(64)('a'), worktreeId: EffectString.repeat(64)('b')},
      },
      withCodeGraphDiskReservation(
        f.options,
        Effect.sync(() => {
          uses++;
        }),
      ),
    ).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(SystemInfo, system), Effect.exit);
    expect(mutations).toBe(1);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(uses).toBe(0);
    expect(EffectArray.filter(f.events, x => x === 'claim')).toHaveLength(0);
  }).pipe(provideFixtureLayer, TestClock.withLive),
);

effectIt.effect(
  'retains successful candidate A through B and refuses TRY(A) and scalar(A) before third observation',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const b = {
        ...f.options,
        ledgerRoot: f.options.ledgerRoot + '-b',
        ledgerLockPath: f.options.ledgerLockPath + '-b',
      };
      let uses = 0;
      yield* tryWithCodeGraphDiskReservationLease(f.options, () =>
        tryWithCodeGraphDiskReservationLease(b, () =>
          Effect.gen(function* () {
            for (const nested of [
              tryWithCodeGraphDiskReservationLease(f.options, () =>
                Effect.sync(() => {
                  uses++;
                }),
              ),
              withCodeGraphDiskReservation(
                f.options,
                Effect.sync(() => {
                  uses++;
                }),
              ),
            ])
              expect(Exit.isFailure(yield* nested.pipe(Effect.exit))).toBe(true);
          }),
        ),
      ).pipe(Effect.provideService(SystemInfo, f.system));
      expect(uses).toBe(0);
      expect(EffectArray.filter(f.events, x => x === 'claim')).toHaveLength(2);
      expect(EffectArray.filter(f.events, x => x === 'release')).toHaveLength(2);
      expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
      expect(yield* f.fs.readDirectory(b.ledgerRoot)).toEqual([]);
    }).pipe(provideFixtureLayer, TestClock.withLive),
);

effectIt.effect('refuses scalar callback receipts and candidate leases outside their actual callback', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = candidateCapacityPlan({snapshotId: 's', files: [], references: []});
    const binding = {databasePath: 'db', snapshotId: 's', authority: 'a', sourceFingerprint: plan.sourceFingerprint};
    let entered = 0;
    const scalar = yield* tryWithCodeGraphDiskReservationLease(f.options, lease =>
      withCandidateCapacityWitness(lease, plan, binding, () =>
        Effect.sync(() => {
          entered++;
        }),
      ).pipe(Effect.exit),
    ).pipe(Effect.provideService(SystemInfo, f.system));
    expect(scalar.state).toBe('completed');
    if (scalar.state === 'completed') expect(Exit.isFailure(scalar.value)).toBe(true);
    const request = {
      ...f.options,
      boundary: {
        operation: 'stage persistent code graph facts' as const,
        rowCount: plan.rows,
        finalFactBytes: plan.bytes,
        candidateWindow: {children: plan.children, rows: plan.rows, bytes: plan.bytes},
      },
      candidateWindow: {...binding, planCanonical: JSON.stringify(plan)},
    };
    const result = yield* tryWithCodeGraphDiskReservationLease(request, lease => Effect.succeed(lease)).pipe(
      Effect.provideService(SystemInfo, f.system),
    );
    if (result.state !== 'completed') return yield* Effect.die('Expected actual lease callback');
    expect(
      Exit.isFailure(
        yield* withCandidateCapacityWitness(result.value, plan, binding, () =>
          Effect.sync(() => {
            entered++;
          }),
        ).pipe(Effect.provideService(SystemInfo, f.system), Effect.exit),
      ),
    ).toBe(true);
    expect(entered).toBe(0);
  }).pipe(provideFixtureLayer, TestClock.withLive),
);

effectIt.effect('snapshots mutable candidate plans and bindings before asynchronous receipt validation', () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const original = candidateCapacityPlan({
      snapshotId: 'snapshot',
      files: [{path: 'file', contentHash: 'hash'}],
      references: [],
    });
    const plan = {...original, counts: {...original.counts}};
    const originalBinding = {
      databasePath: 'db',
      snapshotId: 'snapshot',
      authority: 'authority',
      sourceFingerprint: original.sourceFingerprint,
    };
    const binding = {...originalBinding};
    let receiptPath: string | undefined;
    let mutations = 0,
      receiptReads = 0,
      writes = 0;
    const rejectedOversized: boolean[] = [];
    let beforeOriginalCommits: unknown[] = [];
    const fs = {
      ...f.fs,
      open: (...args: Parameters<typeof f.fs.open>) =>
        f.fs.open(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (args[0] !== receiptPath) return;
              receiptReads++;
              if (mutations !== 0) return;
              // This is the actual issued receipt I/O AFTER mint checked the original canonical plan/envelope.
              plan.rows += 1000000;
              plan.bytes += 1000000;
              plan.children += 1000000;
              plan.counts.keys += 1000000;
              binding.authority = 'mutated-after-validation';
              mutations++;
            }),
          ),
        ),
    };
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(':memory:')),
      database => Effect.sync(() => database.close()),
    );
    db.exec('CREATE TABLE commits(id INTEGER PRIMARY KEY)');
    const child = {operation: 'stage persistent code graph facts' as const, rowCount: 1, finalFactBytes: 1};
    const request = {
      ...f.options,
      boundary: {
        ...child,
        rowCount: original.rows,
        finalFactBytes: original.bytes,
        candidateWindow: {children: original.children, rows: original.rows, bytes: original.bytes},
      },
      candidateWindow: {...originalBinding, planCanonical: JSON.stringify(original)},
    };
    let saved: Parameters<typeof consumeCandidateCapacity>[0] | undefined;
    const failure = {exact: 'original-after-two-commits'};
    const exit = yield* tryWithCodeGraphDiskReservationLease(request, lease => {
      receiptPath = lease.receiptPath;
      return withCandidateCapacityWitness(lease, plan, binding, witness =>
        Effect.gen(function* () {
          saved = witness;
          expect(mutations).toBe(1);
          expect(plan.rows).toBeGreaterThan(original.rows);
          expect(plan.bytes).toBeGreaterThan(original.bytes);
          expect(plan.children).toBeGreaterThan(original.children);
          expect(plan.counts.keys).toBeGreaterThan(original.counts.keys);
          const tooLarge = {...child, rowCount: original.rows + 1, finalFactBytes: original.bytes + 1};
          const forbiddenWrite = Effect.sync(() => {
            db.exec('INSERT INTO commits VALUES(99)');
            writes++;
          });
          // Before the fix, the now-widened budget and changed binding were copied AFTER this receipt read.
          rejectedOversized.push(
            Exit.isFailure(
              yield* consumeCandidateCapacity(witness, binding, tooLarge, forbiddenWrite).pipe(Effect.exit),
            ),
          );
          rejectedOversized.push(
            Exit.isFailure(
              yield* consumeCandidateCapacity(witness, originalBinding, tooLarge, forbiddenWrite).pipe(Effect.exit),
            ),
          );
          beforeOriginalCommits = db.query('SELECT id FROM commits').all();
          for (const id of [1, 2])
            yield* consumeCandidateCapacity(
              witness,
              originalBinding,
              child,
              Effect.sync(() => {
                db.transaction(() => db.exec(`INSERT INTO commits VALUES(${id})`))();
                writes++;
              }),
            );
          return yield* consumeCandidateCapacity(witness, originalBinding, child, Effect.fail(failure));
        }),
      );
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(SystemInfo, f.system), Effect.exit);
    expect(rejectedOversized).toEqual([true, true]);
    expect(beforeOriginalCommits).toEqual([]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause).toMatchObject({reasons: [{error: failure}]});
    expect(writes).toBe(2);
    expect(receiptReads).toBe(4); // One mint validation and three ORIGINAL bounded child validations.
    expect(db.query('SELECT id FROM commits ORDER BY id').all()).toEqual([{id: 1}, {id: 2}]);
    expect(EffectArray.filter(f.events, event => event === 'claim')).toHaveLength(1);
    expect(EffectArray.filter(f.events, event => event === 'release')).toHaveLength(1);
    expect(yield* f.fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
    expect(
      Exit.isFailure(
        yield* consumeCandidateCapacity(
          saved!,
          originalBinding,
          child,
          Effect.sync(() => {
            writes++;
          }),
        ).pipe(Effect.exit),
      ),
    ).toBe(true);
    expect(writes).toBe(2);
  }).pipe(provideFixtureLayer, TestClock.withLive),
);

const candidatePressureFixture = Effect.gen(function* () {
  const f = yield* fixture,
    path = yield* Path.Path,
    crypto = yield* SecureRandom.SecureRandom;
  const home = path.dirname(f.options.ledgerRoot);
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: EffectString.repeat(64)('a'),
    worktreeId: EffectString.repeat(64)('b'),
    repositoryId: EffectString.repeat(64)('c'),
    displayName: 'fixture',
    repoRoot: home,
    gitCommonDirectory: home,
    headCommit: EffectString.repeat(40)('d'),
    objectFormat: 'sha1',
  };
  const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
  yield* f.fs.makeDirectory(layout.repositoryRoot, {recursive: true});
  yield* Effect.sync(() => {
    const db = new Database(layout.databasePath);
    try {
      db.exec('PRAGMA page_size=4096;CREATE TABLE fixture(id INTEGER PRIMARY KEY)');
    } finally {
      db.close();
    }
  });
  const events: string[] = [];
  let homes = 0,
    claims = 0,
    releases = 0;
  const admissionRoot = codeGraphBuilderAdmissionRoot(path, home),
    diskRoot = codeGraphDiskReservationRoot(path, home);
  const fs = {
    ...f.fs,
    rename: (...args: Parameters<typeof f.fs.rename>) =>
      f.fs.rename(...args).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (EffectString.startsWith(admissionRoot + path.sep)(args[1]) && EffectString.endsWith('.json')(args[1])) {
              homes++;
              events.push('home-published');
            }
            if (EffectString.startsWith(diskRoot + path.sep)(args[1]) && EffectString.endsWith('.json')(args[1])) {
              claims++;
              events.push('disk-published');
            }
          }),
        ),
      ),
    remove: (...args: Parameters<typeof f.fs.remove>) =>
      f.fs.remove(...args).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (EffectString.startsWith(diskRoot + path.sep)(args[0]) && EffectString.endsWith('.json')(args[0])) {
              releases++;
              events.push('disk-released');
            }
          }),
        ),
      ),
  };
  const system = SystemInfo.of({
    ...f.system,
    isProcessRunning: pid => pid === f.system.processId,
    environment: () => ({SQLITE_TMPDIR: home}),
    availableDiskBytes: () => Effect.succeed(2 ** 40),
  });
  const provide = <A, E, R>(
    effect: Effect.Effect<A, E, R | SystemInfo | FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(SystemInfo, system),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SecureRandom.SecureRandom, crypto),
    );
  const resources = yield* makeCodeGraphBuildResourceCoordinator(resource =>
    Effect.sync(() => {
      events.push(`resource:${resource ?? 'none'}`);
    }),
  );
  const admit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    provide(
      withCodeGraphBuilderAdmission({admissionClass: 'current-required', threadnoteHome: home, identity}, effect),
    );
  const legacy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    admit(
      Effect.acquireUseRelease(
        resources.acquireLegacyBuilder,
        () => effect,
        () => resources.releaseLegacyBuilder,
      ),
    );
  const ordinaryPreparation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    admit(
      Effect.acquireUseRelease(
        resources.acquirePreparation,
        () => effect,
        () => resources.releasePreparation,
      ),
    );
  const gates = makeCandidatePreparationGates({
    admit,
    ordinaryPreparation,
    resources,
    fs,
    path,
    system,
    threadnoteHome: home,
    identity,
  });
  const plan = candidateCapacityPlan({snapshotId: 's', files: [{path: 'f', contentHash: 'h'}], references: []});
  const binding = {
    databasePath: layout.databasePath,
    snapshotId: 's',
    authority: 'fixture',
    sourceFingerprint: plan.sourceFingerprint,
  };
  // Independent fixed calibration for this SQLite4096/WAL1 shared-filesystem fixture, not a fit claim.
  const floor = plan.children * 4096,
    main = floor + 5 * plan.bytes + 256 * plan.rows,
    transient = floor + 3 * plan.bytes + 256 * plan.rows;
  const required =
    main + transient + (transient + plan.children * 4152) + (floor + Math.ceil((5 * plan.bytes) / 4) + 256 * plan.rows);
  const factory = (
    available: Effect.Effect<number>,
    maintenance: Effect.Effect<void, unknown>,
    waiting: Effect.Effect<void, unknown>,
  ) => {
    const unexpected = () => Effect.die('Unexpected maintenance lane');
    const coordinator = CodeGraphMaintenanceCoordinator.of({
      kickOrdinary: unexpected,
      kickResidual: unexpected,
      kickReconciliation: unexpected,
      request: unexpected,
      tick: () =>
        maintenance.pipe(Effect.orDie, Effect.as({state: 'deferred' as const, reason: 'writer-busy' as const})),
    });
    return codeGraphDirectPersistentCapacityProtector({
      fs,
      identity,
      layout,
      threadnoteHome: home,
      onProgress: () => waiting,
      capacityProtection: {
        crypto,
        path,
        system,
        temporaryDirectory: home,
        walAutoCheckpointPages: 1,
        availableDiskBytes: () => available,
        maintenance: coordinator,
      },
    });
  };
  const filesystemKey = codeGraphDiskReservationFilesystemKey(system.platform, (yield* fs.stat(home)).dev);
  if (!filesystemKey) return yield* Effect.die('Expected supported fixture filesystem');
  const contenderOptions = {
    ...f.options,
    ledgerRoot: diskRoot,
    ledgerLockPath: codeGraphDiskReservationLockPath(path, home),
    observe: Effect.succeed({
      demand: {
        calibrationIdentity: 'contender',
        mainHighWaterBytes: 10,
        transientHighWaterBytes: 10,
        recoveryFloorBytes: 10,
        transientFilesystem: 'durable' as const,
        state: 'measured' as const,
      },
      durableAvailableBytes: 2 ** 40,
      temporaryAvailableBytes: 2 ** 40,
      durableFilesystemKey: filesystemKey,
      temporaryFilesystemKey: filesystemKey,
      freelistBytes: 0,
    }),
  };
  const assertReleased = Effect.gen(function* () {
    expect(yield* resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
    for (const slot of [0, 1] as const) {
      expect(yield* fs.exists(codeGraphBuilderAdmissionSlotPath(path, home, slot))).toBe(false);
      expect(yield* fs.exists(codeGraphBuilderAdmissionSlotPath(path, home, slot) + '.owner.json')).toBe(false);
    }
    expect(yield* fs.readDirectory(admissionRoot)).toEqual([]);
    expect(yield* fs.readDirectory(diskRoot)).toEqual([]);
  });
  return {
    f,
    fs,
    path,
    home,
    identity,
    layout,
    events,
    resources,
    legacy,
    gates,
    plan,
    binding,
    required,
    factory,
    provide,
    contenderOptions,
    assertReleased,
    counts: () => ({homes, claims, releases}),
  };
});

effectIt.effect('binds default candidate SQLite provenance to the actual ordinary writable factory scope only', () =>
  Effect.gen(function* () {
    const f = yield* fixture,
      path = yield* Path.Path;
    const databasePath = path.join(path.dirname(f.options.ledgerRoot), 'factory.sqlite');
    let saved: SqlClient.SqlClient | undefined;
    yield* useDatabaseDirect(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        saved = sql;
        expect(isDefaultCandidateSqliteClient(sql, databasePath)).toBe(true);
        expect(isDefaultCandidateSqliteClient(sql, databasePath + '.other')).toBe(false);
        expect(isDefaultCandidateSqliteClient(new Proxy(sql, {}), databasePath)).toBe(false);
        const injected = yield* Layer.build(SqliteClient.layer({filename: databasePath}));
        yield* Effect.gen(function* () {
          expect(isDefaultCandidateSqliteClient(yield* SqlClient.SqlClient, databasePath)).toBe(false);
        }).pipe(Effect.provide(injected));
      }),
    );
    expect(isDefaultCandidateSqliteClient(saved, databasePath)).toBe(false);
    yield* useExistingDatabase(
      databasePath,
      Effect.gen(function* () {
        expect(isDefaultCandidateSqliteClient(yield* SqlClient.SqlClient, databasePath)).toBe(true);
      }),
    );
    yield* useDatabaseDirect(
      databasePath,
      Effect.gen(function* () {
        expect(isDefaultCandidateSqliteClient(yield* SqlClient.SqlClient, databasePath)).toBe(false);
      }),
      true,
    );
    for (const filename of [':memory:', 'file::memory:'])
      yield* useDatabaseDirect(
        filename,
        Effect.gen(function* () {
          expect(isDefaultCandidateSqliteClient(yield* SqlClient.SqlClient, filename)).toBe(false);
        }),
      );
  }).pipe(provideFixtureLayer, TestClock.withLive),
);

for (const change of ['receipt', 'writer', 'stable'] as const)
  effectIt.effect(`refreshes actual Windows candidate client and TEMP after ${change} continuations`, () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        path = yield* Path.Path;
      const databasePath = path.join(path.dirname(f.options.ledgerRoot), 'windows-owned.sqlite');
      const environment = {TMP: 'C:\\temp', TEMP: 'C:\\temp'};
      const windowsPath = {...path, isAbsolute: win32.isAbsolute, normalize: win32.normalize};
      const system = SystemInfo.of({
        ...f.system,
        platform: 'win32',
        runtimeVersion: '1.4.4',
        environment: () => environment,
        canonicalProcessStartIdentity: () => Effect.succeed('win32:123'),
        processStartIdentity: () => Effect.succeed('win32:123'),
      });
      let changed = false;
      const fs = {
        ...f.fs,
        open: (...args: Parameters<typeof f.fs.open>) => {
          if (change === 'receipt' && args[1]?.flag === 'r' && EffectString.endsWith('.json')(args[0]) && !changed) {
            changed = true;
            environment.TMP = 'D:\\changed';
            environment.TEMP = 'D:\\changed';
          }
          return f.fs.open(...args);
        },
      };
      yield* useDatabaseDirect(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE commits(id INTEGER PRIMARY KEY)`;
          const plan = candidateCapacityPlan({snapshotId: 's', files: [{path: 'f', contentHash: 'h'}], references: []});
          const binding = {
            sql,
            databasePath,
            snapshotId: 's',
            authority: 'a',
            sourceFingerprint: plan.sourceFingerprint,
          };
          const boundary = {operation: 'stage persistent code graph facts' as const, rowCount: 4, finalFactBytes: 1};
          const entered = yield* Deferred.make<void>(),
            resume = yield* Deferred.make<void>();
          let writes = 0,
            saved: Parameters<typeof consumeCandidateCapacity>[0] | undefined;
          const options = {
            ...f.options,
            candidateWindow: {...binding, planCanonical: JSON.stringify(plan)},
            boundary: {
              ...boundary,
              rowCount: plan.rows,
              finalFactBytes: plan.bytes,
              candidateWindow: {children: plan.children, rows: plan.rows, bytes: plan.bytes},
            },
            observe: f.options.observe.pipe(
              Effect.map(observation => ({...observation, candidateTemporaryDirectory: 'C:\\temp'})),
            ),
          };
          const writer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume)), Effect.andThen(effect));
          const owner = yield* tryWithCodeGraphDiskReservationLease(options, lease =>
            withCandidateCapacityWitness(lease, plan, binding, witness =>
              Effect.gen(function* () {
                saved = witness;
                expect(
                  Exit.isFailure(yield* assertCurrentCandidateCapacity(new Proxy(sql, {})).pipe(Effect.exit)),
                ).toBe(true);
                for (const id of [1, 2])
                  yield* consumeCandidateCapacity(
                    witness,
                    binding,
                    boundary,
                    candidateIndexWrite(sql, writer, undefined, 1, 1, sql`INSERT INTO commits VALUES(${id})`).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          writes++;
                        }),
                      ),
                    ),
                  );
              }),
            ),
          ).pipe(Effect.exit, Effect.forkChild);
          if (change !== 'receipt') {
            yield* Deferred.await(entered);
            if (change === 'writer') {
              environment.TMP = 'D:\\changed';
              environment.TEMP = 'D:\\changed';
            }
            yield* Deferred.succeed(resume, undefined);
          }
          const exit = yield* Fiber.join(owner);
          expect(Exit.isSuccess(exit)).toBe(change === 'stable');
          expect(writes).toBe(change === 'stable' ? 2 : 0);
          expect(yield* sql`SELECT id FROM commits ORDER BY id`).toEqual(change === 'stable' ? [{id: 1}, {id: 2}] : []);
          expect(EffectArray.filter(f.events, x => x === 'claim')).toHaveLength(1);
          expect(EffectArray.filter(f.events, x => x === 'release')).toHaveLength(1);
          expect(yield* fs.readDirectory(f.options.ledgerRoot)).toEqual([]);
          if (saved)
            expect(
              Exit.isFailure(
                yield* consumeCandidateCapacity(
                  saved,
                  binding,
                  boundary,
                  Effect.sync(() => {
                    writes++;
                  }),
                ).pipe(Effect.exit),
              ),
            ).toBe(true);
          expect(writes).toBe(change === 'stable' ? 2 : 0);
          // Outside the private live witness this read guard is inert for ordinary source readers.
          yield* assertCurrentCandidateCapacity(sql);
        }),
      ).pipe(
        Effect.provideService(SystemInfo, system),
        Effect.provideService(Path.Path, windowsPath),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
    }).pipe(provideFixtureLayer, TestClock.withLive),
  );

effectIt.effect(
  'refuses stale or injected Windows factory origin before directory probes and rechecks after observation yields',
  () =>
    Effect.gen(function* () {
      const f = yield* candidatePressureFixture;
      const crypto = yield* SecureRandom.SecureRandom;
      const environment = {TMP: 'C:\\temp', TEMP: 'C:\\temp'};
      const system = SystemInfo.of({
        ...f.f.system,
        platform: 'win32',
        runtimeVersion: '1.4.4',
        environment: () => environment,
      });
      const path = {...f.path, isAbsolute: win32.isAbsolute, normalize: win32.normalize};
      let temporaryProbes = 0,
        spaceProbes = 0,
        split = false,
        mutate = false;
      const fs = {
        ...f.fs,
        stat: (...args: Parameters<typeof f.fs.stat>) => {
          if (EffectString.startsWith('C:\\temp')(args[0])) {
            temporaryProbes++;
            return f.fs.stat(f.home).pipe(Effect.map(info => ({...info, dev: split ? info.dev + 1n : info.dev})));
          }
          return f.fs.stat(...args);
        },
        access: (...args: Parameters<typeof f.fs.access>) =>
          f.fs.access(args[0] === 'C:\\temp' ? f.home : args[0], args[1]),
      };
      const observe = (sql?: SqlClient.SqlClient) =>
        observeDirectPersistentCapacityForTest({
          boundary: {
            operation: 'stage persistent code graph facts',
            rowCount: f.plan.rows,
            finalFactBytes: f.plan.bytes,
            transientFilesystem: 'temporary',
            candidateWindow: {children: f.plan.children, rows: f.plan.rows, bytes: f.plan.bytes},
          },
          fs,
          identity: f.identity,
          layout: f.layout,
          threadnoteHome: f.home,
          candidateWindow: {...f.binding, sql, planCanonical: JSON.stringify(f.plan)},
          protection: {
            crypto,
            path,
            system,
            temporaryDirectory: 'captured-is-not-proof',
            walAutoCheckpointPages: 1,
            availableDiskBytes: () =>
              Effect.sync(() => {
                spaceProbes++;
                if (mutate) {
                  environment.TMP = 'D:\\changed';
                  environment.TEMP = 'D:\\changed';
                }
                return 2 ** 40;
              }),
            maintenance: CodeGraphMaintenanceCoordinator.of({
              kickOrdinary: () => Effect.die('unused'),
              kickResidual: () => Effect.die('unused'),
              kickReconciliation: () => Effect.die('unused'),
              request: () => Effect.die('unused'),
              tick: () => Effect.die('unused'),
            }),
          },
        }).pipe(f.provide);
      const unregistered = yield* observe();
      expect(unregistered.temporaryFilesystemKey).toBe('temporary-filesystem-unknown');
      expect(temporaryProbes).toBe(0);
      expect(spaceProbes).toBe(0);
      let savedClient: SqlClient.SqlClient | undefined;
      yield* useDatabaseDirect(
        f.layout.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          savedClient = sql;
          const injected = yield* observe(new Proxy(sql, {}));
          expect(injected.temporaryFilesystemKey).toBe('temporary-filesystem-unknown');
          expect(temporaryProbes).toBe(0);
          expect(spaceProbes).toBe(0);
          for (const separated of [false, true]) {
            split = separated;
            const spacesBefore = spaceProbes;
            const positive = yield* observe(sql);
            expect(positive.candidateTemporaryDirectory).toBe('C:\\temp');
            expect(positive.temporaryFilesystemKey === positive.durableFilesystemKey).toBe(!separated);
            expect(spaceProbes - spacesBefore).toBe(separated ? 2 : 1);
            const projection = codeGraphDiskCapacityReservationProjection({
              demand: positive.demand,
              durableFilesystemKey: positive.durableFilesystemKey,
              temporaryFilesystemKey: positive.temporaryFilesystemKey,
              freelistBytes: 999999999,
            });
            expect(projection.state).toBe('measured');
            if (projection.state === 'measured') {
              expect(projection.filesystems).toHaveLength(separated ? 2 : 1);
              expect(EffectArray.reduce(projection.filesystems, 0, (n, x) => n + x.bytes)).toBe(f.required);
            }
          }
          split = false;
          mutate = true;
          const temporariesBefore = temporaryProbes,
            spacesBefore = spaceProbes;
          const changed = yield* observe(sql);
          expect(temporaryProbes - temporariesBefore).toBe(3);
          expect(spaceProbes - spacesBefore).toBe(1);
          expect(changed.temporaryFilesystemKey).toBe('temporary-filesystem-unknown');
          expect(changed.temporaryAvailableBytes).toBeUndefined();
          expect(changed.candidateTemporaryDirectory).toBeUndefined();
        }),
      );
      const beforeExpired = temporaryProbes;
      const expired = yield* observe(savedClient);
      expect(expired.temporaryFilesystemKey).toBe('temporary-filesystem-unknown');
      expect(temporaryProbes).toBe(beforeExpired);
    }).pipe(provideFixtureLayer, TestClock.withLive),
);

effectIt.effect('bounds every mixed source, carry and finish child by independent full-value trace tables', () =>
  Effect.gen(function* () {
    const f = yield* candidatePressureFixture;
    const context = yield* Layer.build(SqliteClient.layer({filename: f.layout.databasePath}));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys=ON');
      yield* sql.unsafe(`CREATE TABLE snapshots (id TEXT PRIMARY KEY,base_snapshot_id TEXT,state TEXT,extractor_set TEXT,
        graph_content_id TEXT,file_count INTEGER,symbol_count INTEGER,edge_count INTEGER,dirty INTEGER)`);
      yield* sql.unsafe(`CREATE TABLE snapshot_files(snapshot_id TEXT,path TEXT,content_hash TEXT,
        PRIMARY KEY(snapshot_id,path)) WITHOUT ROWID`);
      yield* sql.unsafe(`CREATE TABLE snapshot_symbol_lookup(snapshot_id TEXT,lookup_key TEXT,symbol_id TEXT,
        resolution_domain TEXT,provenance TEXT,evidence_path TEXT,PRIMARY KEY(snapshot_id,lookup_key,symbol_id)) WITHOUT ROWID`);
      yield* sql.unsafe(`CREATE TABLE snapshot_file_deletions(snapshot_id TEXT,path TEXT,
        PRIMARY KEY(snapshot_id,path)) WITHOUT ROWID`);
      yield* sql.unsafe(`CREATE TABLE snapshot_reuse_receipts(snapshot_id TEXT PRIMARY KEY,workspace_fingerprint TEXT,
        file_set_fingerprint TEXT,format_version INTEGER,resolution_surface_version INTEGER,extractor_set TEXT)`);
      yield* ensureResolutionCandidateIndexSchema(sql);
      const literal = EffectString.repeat(70000)('x');
      const edgeId = '边"\\',
        alias = 'é"\\';
      const reference = (path: string, key: string): CodeGraphReference => ({
        edgeId: path,
        evidencePath: path,
        evidenceSpan: {line: 1, column: 1, endLine: 1, endColumn: 2},
        sourceName: path,
        targetName: key,
        relation: 'references',
        provenance: 'syntactic',
        resolutionDomain: 'd',
        lookupTiers: [[key]],
      });
      const refs = [
        {
          ...reference('m', 'n'),
          edgeId,
          relation: 'reexports' as const,
          lookupTiers: [['n', 'n'], ['u']],
          aliasLookupKeys: [alias],
        },
        reference('l', literal),
      ];
      expect(EffectArray.every(refs, ref => Buffer.byteLength(JSON.stringify(ref)) < 8 * 1048576)).toBe(true);
      // Independent full hyperedge: duplicate normal occurrences survive, while the canonical file pairs deduplicate.
      const hyperedge = JSON.stringify({
        sourcePath: 'm',
        aliases: [{key: alias, resolutionDomain: 'd'}],
        candidates: [
          {key: 'n', resolutionDomain: 'd'},
          {key: 'n', resolutionDomain: 'd'},
          {key: 'u', resolutionDomain: 'd'},
        ],
      });
      const edgeBytes = Buffer.byteLength(hyperedge);
      expect(Buffer.byteLength(edgeId)).toBe(5);
      expect(Buffer.byteLength(alias)).toBe(4);
      const finishInput = (snapshotId: string, inheritedSnapshotId?: string) => ({
        snapshotId,
        workspaceFingerprint: 'w',
        fileSetFingerprint: 'f',
        databasePath: f.layout.databasePath,
        preparationGate: f.gates.preparationGate,
        ...(inheritedSnapshotId === undefined ? {} : {inheritedSnapshotId}),
      });
      const receiptBytes = (id: string, inherited?: string) =>
        Buffer.byteLength(JSON.stringify(finishInput(id, inherited))) + 256;
      const emptyCounts = {files: 0, references: 0, keys: 0, aliases: 0, reexports: 0, pages: 0};
      const finishPlan = (id: string, inherited?: string) => ({
        preparationRows: 0,
        preparationBytes: 0,
        writeRows: 2,
        writeBytes: Buffer.byteLength(id) + 256 + receiptBytes(id, inherited),
        codecBytes: 0,
        writeChildren: 2,
        children: 2,
        rows: 8,
        bytes: Buffer.byteLength(id) + 256 + receiptBytes(id, inherited),
        counts: emptyCounts,
      });
      // Hand-derived source table: 3 identities(9B), 4 key occurrences(70015B),
      // two reference path/domain pairs(4B), and one4B alias => 70032B preparation.
      // q=6*3+4page-upper+4occurrences+1edge+2literal+1=30;
      // next-fit upper min(14operations,1+2*(1row-bin+1byte-bin+1codec-bin))=7.
      // Normal m frame is8+2*(8+1+1)=28B; codec may store any positive size<=28.
      const sourcePlan = {
        preparationRows: 10,
        preparationBytes: 70032,
        writeRows: 30,
        writeBytes: 144165,
        codecBytes: 70711,
        writeChildren: 7,
        children: 8,
        rows: 107,
        bytes: 214197,
        counts: {files: 3, references: 2, keys: 4, aliases: 1, reexports: 1, pages: 4},
      };
      // The longer target adds11B to EACH of m's two original tuples. Its fresh metadata plan
      // owns raw28 + stored(1..28) + original30 + hyperedge/target identity(edgeBytes+18).
      const carryPlan = {
        preparationRows: 4,
        writeRows: 11,
        writeBytes: 1492 + edgeBytes,
        codecBytes: 188,
        writeChildren: 5,
        children: 6,
        rows: 42,
        counts: {files: 1, references: 0, keys: 2, aliases: 0, reexports: 1, pages: 1},
      };
      const expected = [
        {
          id: 'r',
          plan: finishPlan('r'),
          children: [
            {rows: 4, bytes: 257},
            {rows: 4, bytes: receiptBytes('r')},
          ],
        },
        {
          id: 's',
          plan: sourcePlan,
          children: [
            {rows: 10, bytes: 70032},
            {rows: 4, bytes: 257},
            {rows: 64, bytes: 72648 + edgeBytes},
          ],
        },
        {id: 's', plan: finishPlan('s'), children: [{rows: 4, bytes: receiptBytes('s')}]},
        {
          id: 'carry-second',
          plan: carryPlan,
          children: [
            {rows: 4, bytes: 104 + edgeBytes},
            {rows: 4, bytes: 268},
            {rows: 25, bytes: 1196 + edgeBytes},
          ],
        },
        {
          id: 'carry-second',
          plan: finishPlan('carry-second', 's'),
          children: [{rows: 4, bytes: receiptBytes('carry-second', 's')}],
        },
      ];
      const traces: {snapshotId: string; children: {rows: number; bytes: number}[]}[] = [];
      const original = f.factory(
        Effect.succeed(2 ** 40),
        Effect.die('Unexpected maintenance'),
        Effect.die('Unexpected wait'),
      );
      const window: NonNullable<CodeGraphDirectPersistentCapacityProtector['candidateWindow']> = (
        plan,
        binding,
        gate,
        use,
      ) => {
        const oracle = expected[traces.length];
        expect(oracle).toBeDefined();
        expect(binding.databasePath).toBe(f.layout.databasePath);
        expect(binding.snapshotId).toBe(oracle.id);
        expect(binding.sourceFingerprint).toBe(plan.sourceFingerprint);
        expect(plan.version).toBe('candidate-stage-window-r1');
        expect(plan.snapshotId).toBe(oracle.id);
        expect(plan.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(plan).toMatchObject(oracle.plan);
        if (traces.length === 3) {
          expect(plan.preparationBytes).toBeGreaterThanOrEqual(77 + edgeBytes);
          expect(plan.preparationBytes).toBeLessThanOrEqual(104 + edgeBytes);
          expect(plan.bytes).toBeGreaterThanOrEqual(1569 + 2 * edgeBytes);
          expect(plan.bytes).toBeLessThanOrEqual(1596 + 2 * edgeBytes);
        }
        const trace = {snapshotId: plan.snapshotId, children: [] as {rows: number; bytes: number}[]};
        traces.push(trace);
        return original.candidateWindow!(plan, binding, gate, covered => {
          const observed: CodeGraphDirectPersistentCapacityProtector = (boundary, effect) => {
            const child = oracle.children[trace.children.length];
            expect(child).toBeDefined();
            expect(boundary.operation).toBe('stage persistent code graph facts');
            expect(boundary.rowCount).toBe(child.rows);
            expect(boundary.finalFactBytes).toBeGreaterThan(0);
            expect(boundary.finalFactBytes).toBeLessThanOrEqual(child.bytes);
            trace.children.push({rows: boundary.rowCount, bytes: boundary.finalFactBytes});
            const prefix = EffectArray.reduce(trace.children, {rows: 0, bytes: 0}, (n, x) => ({
              rows: n.rows + x.rows,
              bytes: n.bytes + x.bytes,
            }));
            const upper = EffectArray.reduce(
              oracle.children.slice(0, trace.children.length),
              {rows: 0, bytes: 0},
              (n, x) => ({rows: n.rows + x.rows, bytes: n.bytes + x.bytes}),
            );
            expect(prefix.rows).toBe(upper.rows);
            expect(prefix.bytes).toBeLessThanOrEqual(upper.bytes);
            expect(trace.children.length).toBeLessThanOrEqual(oracle.plan.children);
            expect(prefix.rows).toBeLessThanOrEqual(oracle.plan.rows);
            const byteUpper =
              'bytes' in oracle.plan && typeof oracle.plan.bytes === 'number'
                ? oracle.plan.bytes
                : 1596 + 2 * edgeBytes;
            expect(prefix.bytes).toBeLessThanOrEqual(byteUpper);
            return covered(boundary, effect);
          };
          return use(Object.assign(observed, covered)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                expect(trace.children).toHaveLength(oracle.children.length);
              }),
            ),
          );
        });
      };
      const observed = Object.assign(
        <A, E, R>(boundary: Parameters<typeof original>[0], effect: Effect.Effect<A, E, R>) =>
          original(boundary, effect),
        original,
        {candidateWindow: window},
      );
      const writer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          f.resources.acquireWriter,
          () => effect,
          () => f.resources.releaseWriter,
        );
      const create = (id: string, paths: readonly string[], root?: string) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO snapshots VALUES (${id},${root ?? null},'ready','extractor',${id},${paths.length},0,0,0)`;
          for (const path of paths) yield* sql`INSERT INTO snapshot_files VALUES (${id},${path},'h')`;
        });
      yield* create('r', []);
      expect(yield* finishResolutionCandidateIndex(sql, finishInput('r'), writer, observed)).toBe(true);
      yield* create('s', ['z', 'm', 'l'], 'r');
      yield* stageResolutionCandidateIndex(
        sql,
        {
          snapshotId: 's',
          files: EffectArray.map(['z', 'm', 'l'], path => ({path, contentHash: 'h'})),
          references: refs,
          databasePath: f.layout.databasePath,
          preparationGate: f.gates.preparationGate,
        },
        writer,
        observed,
      );
      expect(yield* finishResolutionCandidateIndex(sql, finishInput('s'), writer, observed)).toBe(true);
      yield* create('carry-second', ['m'], 'r');
      expect(yield* finishResolutionCandidateIndex(sql, finishInput('carry-second', 's'), writer, observed)).toBe(true);
      expect(EffectArray.map(traces, trace => trace.snapshotId)).toEqual([
        'r',
        's',
        's',
        'carry-second',
        'carry-second',
      ]);
      expect(EffectArray.map(traces, trace => trace.children.length)).toEqual([2, 3, 1, 3, 1]);
      const authority = yield* resolutionCandidateAuthorityToken(sql);
      if (!authority) return yield* Effect.die('Expected real current candidate authority.');
      for (const id of ['s', 'carry-second']) {
        const key = yield* candidateSnapshotKey(sql, id, authority);
        if (key === undefined) return yield* Effect.die('Expected real sealed candidate snapshot.');
        const files = yield* sql<{
          readonly file_key: number;
          readonly path: string;
          readonly association_count: number;
          readonly page_count: number;
          readonly canonical_sha: string;
          readonly original_tuple_bytes: number;
          readonly sealed: number;
        }>`
          SELECT file_key,path,association_count,page_count,canonical_sha,original_tuple_bytes,sealed
          FROM snapshot_candidate_synopsis_files WHERE snapshot_key=${key} ORDER BY path`;
        expect(EffectArray.map(files, file => file.path)).toEqual(id === 's' ? ['l', 'm', 'z'] : ['m']);
        for (const file of files) {
          expect(file.sealed).toBe(1);
          const pairs =
            file.path === 'z'
              ? []
              : file.path === 'm'
                ? [
                    ['d', 'n'],
                    ['d', 'u'],
                  ]
                : [['d', literal]];
          const projection = yield* readCandidateFileProjection(
            sql,
            key,
            file.file_key,
            file.path,
            file.association_count,
            file.page_count,
            file.canonical_sha,
          );
          expect(projection?.pairs).toEqual(pairs);
          expect(file.association_count).toBe(pairs.length);
          expect(file.page_count).toBe(file.path === 'z' ? 0 : 1);
          expect(file.original_tuple_bytes).toBe(
            file.path === 'z' ? 0 : file.path === 'm' ? (id === 's' ? 8 : 30) : 70003,
          );
          const pages = yield* sql<{readonly raw_bytes: number; readonly stored_bytes: number; readonly codec: string}>`
            SELECT raw_bytes,stored_bytes,codec FROM snapshot_candidate_synopsis_pages WHERE snapshot_key=${key} AND file_key=${file.file_key}`;
          if (file.path === 'm') {
            expect(pages[0].raw_bytes).toBe(28);
            expect(pages[0].stored_bytes).toBeGreaterThan(0);
            expect(pages[0].stored_bytes).toBeLessThanOrEqual(28);
          } else if (file.path === 'l')
            expect(pages).toEqual([{raw_bytes: 70017, stored_bytes: 70001, codec: 'literal-pair-v1'}]);
        }
        expect(
          yield* sql`SELECT edge_id,payload_json FROM snapshot_candidate_reexports WHERE snapshot_id=${id}`,
        ).toEqual([{edge_id: edgeId, payload_json: hyperedge}]);
      }
      expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      expect(f.counts()).toEqual({homes: 5, claims: 5, releases: 5});
      yield* f.assertReleased;
    }).pipe(Effect.provide(context), f.provide);
  }).pipe(provideFixtureLayer, TestClock.withLive),
);

for (const pressure of ['physical', 'reservation'] as const) {
  effectIt.effect(
    `releases a new actual candidate owner before ${pressure} outside work and a disk-to-home contender`,
    () =>
      Effect.gen(function* () {
        const f = yield* candidatePressureFixture;
        const outside = yield* Deferred.make<void>(),
          finished = yield* Deferred.make<void>();
        const diskHeld = yield* Deferred.make<void>(),
          tryHome = yield* Deferred.make<void>(),
          homeHeld = yield* Deferred.make<void>(),
          leaveHome = yield* Deferred.make<void>();
        let observations = 0,
          maintenance = 0,
          waits = 0,
          uses = 0;
        const pauseOutside = (kind: 'maintenance' | 'waiting') =>
          Effect.gen(function* () {
            f.events.push(`outside:${kind}`);
            expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
            expect(yield* f.fs.exists(codeGraphBuilderAdmissionSlotPath(f.path, f.home, 0))).toBe(false);
            if (kind === 'maintenance') maintenance++;
            else waits++;
            yield* Deferred.succeed(outside, undefined);
            yield* Deferred.await(finished);
          });
        const protector = f.factory(
          Effect.sync(() => {
            observations++;
            f.events.push(`candidate-observe:${observations}`);
            return observations === 1 ? (pressure === 'physical' ? 0 : f.required + 10) : 2 ** 40;
          }),
          pressure === 'physical'
            ? pauseOutside('maintenance')
            : Effect.die('Unexpected maintenance during reservation wait'),
          pressure === 'reservation' ? pauseOutside('waiting') : Effect.die('Unexpected wait during physical pressure'),
        );
        const contenderProgram = f.provide(
          withCodeGraphDiskReservation(
            f.contenderOptions,
            Deferred.succeed(diskHeld, undefined).pipe(
              Effect.andThen(Deferred.await(tryHome)),
              Effect.andThen(
                withCodeGraphBuilderAdmission(
                  {
                    admissionClass: 'current-required',
                    threadnoteHome: f.home,
                    identity: {...f.identity, worktreeId: EffectString.repeat(64)('e')},
                  },
                  Effect.sync(() => {
                    f.events.push('contender-home');
                  }).pipe(
                    Effect.andThen(Deferred.succeed(homeHeld, undefined)),
                    Effect.andThen(Deferred.await(leaveHome)),
                  ),
                ),
              ),
            ),
          ),
        );
        // Reservation pressure requires a real existing peer receipt; physical pressure does not.
        let contender = pressure === 'reservation' ? yield* contenderProgram.pipe(Effect.forkChild) : undefined;
        if (contender) yield* Deferred.await(diskHeld);
        const candidate = yield* protector.candidateWindow!(f.plan, f.binding, f.gates.preparationGate, covered =>
          covered(
            {operation: 'stage persistent code graph facts', rowCount: 1, finalFactBytes: 1},
            Effect.sync(() => {
              uses++;
              f.events.push('candidate-use');
              return 'done';
            }),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(outside);
        if (!contender) {
          contender = yield* contenderProgram.pipe(Effect.forkChild);
          yield* Deferred.await(diskHeld);
        }
        yield* Deferred.succeed(tryHome, undefined);
        yield* Deferred.await(homeHeld);
        expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
        expect(f.events.indexOf('resource:none')).toBeLessThan(
          f.events.indexOf(`outside:${pressure === 'physical' ? 'maintenance' : 'waiting'}`),
        );
        expect(f.events.indexOf(`outside:${pressure === 'physical' ? 'maintenance' : 'waiting'}`)).toBeLessThan(
          f.events.indexOf('contender-home'),
        );
        yield* Deferred.succeed(leaveHome, undefined);
        yield* Fiber.join(contender);
        yield* Deferred.succeed(finished, undefined);
        expect(yield* Fiber.join(candidate)).toBe('done');
        expect({observations, maintenance, waits, uses}).toEqual({
          observations: 2,
          maintenance: pressure === 'physical' ? 1 : 0,
          waits: pressure === 'reservation' ? 1 : 0,
          uses: 1,
        });
        expect(f.counts()).toEqual({homes: 3, claims: 2, releases: 2});
        yield* f.assertReleased;
      }).pipe(provideFixtureLayer, TestClock.withLive),
  );
}

effectIt.effect(
  'borrowed actual candidate owner propagates one TRY pressure through original outer finalizers without retry',
  () =>
    Effect.gen(function* () {
      const f = yield* candidatePressureFixture;
      let observations = 0,
        maintenance = 0,
        waits = 0,
        uses = 0,
        sleeps = 0;
      const protector = f.factory(
        Effect.sync(() => {
          observations++;
          return 0;
        }),
        Effect.sync(() => {
          maintenance++;
        }),
        Effect.sync(() => {
          waits++;
        }),
      );
      let originalCause: Cause.Cause<unknown> | undefined;
      const exit = yield* f
        .legacy(
          Effect.gen(function* () {
            const owner = yield* Effect.fiberId;
            const live = yield* Clock.Clock;
            const noOwnerSleep: Clock.Clock = {
              currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
              currentTimeMillis: live.currentTimeMillis,
              currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
              currentTimeNanos: live.currentTimeNanos,
              monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
              monotonicTimeNanos: live.monotonicTimeNanos,
              sleep: duration =>
                Effect.fiberId.pipe(
                  Effect.flatMap(fiber =>
                    fiber === owner
                      ? Effect.sync(() => {
                          sleeps++;
                        }).pipe(Effect.andThen(Effect.die('Borrowed owner must not sleep')))
                      : live.sleep(duration),
                  ),
                ),
            };
            return yield* protector.candidateWindow!(f.plan, f.binding, f.gates.preparationGate, () =>
              Effect.sync(() => {
                uses++;
              }),
            ).pipe(Effect.provideService(Clock.Clock, noOwnerSleep));
          }).pipe(
            Effect.catchCause(cause =>
              Effect.gen(function* () {
                originalCause = cause;
                expect((yield* f.resources.current).legacyBuilder).toBe(true);
                expect(yield* f.fs.exists(codeGraphBuilderAdmissionSlotPath(f.path, f.home, 0))).toBe(true);
                return yield* Effect.failCause(cause);
              }),
            ),
          ),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause).toEqual(originalCause);
        expect(exit.cause.reasons).toHaveLength(1);
        const reason = exit.cause.reasons[0];
        expect(Cause.isFailReason(reason)).toBe(true);
        if (Cause.isFailReason(reason))
          expect(reason.error).toMatchObject({
            _tag: 'CodeGraphDiskCapacityPressureError',
            code: 'no-space',
            operation: 'stage persistent code graph facts',
          });
      }
      expect({observations, maintenance, waits, uses, sleeps}).toEqual({
        observations: 1,
        maintenance: 0,
        waits: 0,
        uses: 0,
        sleeps: 0,
      });
      expect(f.counts()).toEqual({homes: 1, claims: 0, releases: 0});
      yield* f.assertReleased;
    }).pipe(provideFixtureLayer, TestClock.withLive),
);

effectIt.effect('never retries protected-use failure after a new actual candidate window claim', () =>
  Effect.gen(function* () {
    const f = yield* candidatePressureFixture;
    let observations = 0,
      maintenance = 0,
      waits = 0,
      uses = 0;
    const failure = {original: 'protected-use'};
    const protector = f.factory(
      Effect.sync(() => {
        observations++;
        return 2 ** 40;
      }),
      Effect.sync(() => {
        maintenance++;
      }),
      Effect.sync(() => {
        waits++;
      }),
    );
    const exit = yield* protector.candidateWindow!(f.plan, f.binding, f.gates.preparationGate, covered =>
      covered(
        {operation: 'stage persistent code graph facts', rowCount: 1, finalFactBytes: 1},
        Effect.sync(() => {
          uses++;
        }).pipe(Effect.andThen(Effect.fail(failure))),
      ),
    ).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0];
      expect(Cause.isFailReason(reason)).toBe(true);
      if (Cause.isFailReason(reason)) expect(reason.error).toBe(failure);
    }
    expect({observations, maintenance, waits, uses}).toEqual({observations: 1, maintenance: 0, waits: 0, uses: 1});
    expect(f.counts()).toEqual({homes: 1, claims: 1, releases: 1});
    yield* f.assertReleased;
  }).pipe(provideFixtureLayer, TestClock.withLive),
);

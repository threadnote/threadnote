import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Deferred, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as EffectRecord from 'effect/Record';
import {describe, expect, it} from 'vitest';
import {contextHealthCaseIdV2} from '@threadnote/context/health_maintenance';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {resourceAccountMutationGenerationPath} from '@threadnote/store/resource/lock';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  readRawState,
  runContextMaintenance,
  runContextMaintenanceScheduler,
  setContextMaintenancePaused,
  readContextMaintenanceControl,
  wakeContextMaintenance,
  writeState,
  type ContextMaintenanceCaseV2,
  type MaintenanceState,
} from '@threadnote/threadnote/memory/context/maintenance';
import {
  contextMaintenanceProgressFingerprint,
  contextMaintenanceWakeIntervalMs,
  nextContextMaintenanceWorkerQuiet,
  recordContextMaintenanceWorkerTick,
} from '../../src/memory/context/maintenance_backoff.js';
import {
  claimDraftWork,
  draftQueueObservationDirectory,
  enqueueDraftWork,
  finishDraftWork,
} from '../../src/memory/context/maintenance_draft_queue.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {CONTEXT_MAINTENANCE_WORKER_ARGUMENT} from '../../src/memory/context/maintenance_worker.js';

function fixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scheduler-'});
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'scheduler-test',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'tester',
    };
    return config;
  });
}

const unavailableCommand = () => Effect.die(new Error('Only detached maintenance is allowed in this test.'));

describe('context maintenance scheduler containment', () => {
  effectIt.effect('defaults a fresh installation to off and does not start detached maintenance', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      expect((yield* readContextMaintenanceControl(config)).paused).toBe(true);
      const command = CommandExecutor.of({
        execute: unavailableCommand,
        executeStreaming: unavailableCommand,
        spawnDetached: () => Effect.die('Automatic maintenance must remain off until enabled.'),
      });
      expect(yield* wakeContextMaintenance(config).pipe(Effect.provideService(CommandExecutor, command))).toBe(false);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('wakes the guarded worker immediately and every thirty seconds with the exact MCP owner', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      yield* setContextMaintenancePaused(config, false);
      const system = yield* SystemInfo;
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const calls: Array<{
        readonly args: readonly string[];
        readonly cwd?: string;
        readonly env?: NodeJS.ProcessEnv;
        readonly intendedChild?: string;
      }> = [];
      const command = CommandExecutor.of({
        execute: unavailableCommand,
        executeStreaming: unavailableCommand,
        spawnDetached: (_executable, args, options) =>
          Effect.gen(function* () {
            calls.push({args, cwd: options?.cwd, env: options?.env, intendedChild: options?.intendedChild});
            if (calls.length === 1) yield* Deferred.succeed(first, undefined);
            if (calls.length === 2) yield* Deferred.succeed(second, undefined);
            return true;
          }),
      });
      yield* runContextMaintenanceScheduler(config).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.forkScoped,
      );
      yield* Deferred.await(first);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({intendedChild: 'context-maintenance'});
      expect(calls[0].args.at(-2)).toBe(CONTEXT_MAINTENANCE_WORKER_ARGUMENT);
      expect(JSON.parse(calls[0].args.at(-1)!)).toEqual({
        config,
        owner: {
          processId: system.processId,
          startIdentity: yield* system.canonicalProcessStartIdentity!(system.processId),
        },
      });
      expect(calls[0].cwd).toBe(system.currentDirectory());
      expect(calls[0].env).toMatchObject({
        THREADNOTE_ACCOUNT: config.account,
        THREADNOTE_USER: config.user,
        THREADNOTE_AGENT_ID: config.agentId,
      });
      yield* TestClock.adjust('29 seconds');
      expect(calls).toHaveLength(1);
      yield* TestClock.adjust('1 second');
      yield* Deferred.await(second);
      expect(calls).toHaveLength(2);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('does not spawn while paused and coalesces concurrent wakes', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      let calls = 0;
      const command = CommandExecutor.of({
        execute: unavailableCommand,
        executeStreaming: unavailableCommand,
        spawnDetached: (_executable, args) =>
          Effect.sync(() => {
            expect(JSON.parse(args.at(-1)!)).toEqual({config});
            calls++;
            return true;
          }),
      });
      yield* setContextMaintenancePaused(config, true);
      expect(yield* wakeContextMaintenance(config).pipe(Effect.provideService(CommandExecutor, command))).toBe(false);
      expect(calls).toBe(0);
      yield* setContextMaintenancePaused(config, false);
      const results = yield* Effect.all([wakeContextMaintenance(config), wakeContextMaintenance(config)], {
        concurrency: 2,
      }).pipe(Effect.provideService(CommandExecutor, command), TestClock.withLive);
      expect(results.sort()).toEqual([false, true]);
      expect(calls).toBe(1);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('does not launch MCP work with an unknown owner identity', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      yield* setContextMaintenancePaused(config, false);
      const system = yield* SystemInfo;
      expect(
        yield* wakeContextMaintenance(config, {bindToParent: true}).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            canonicalProcessStartIdentity: () => succeedUndefined,
          }),
          Effect.provideService(
            CommandExecutor,
            CommandExecutor.of({
              execute: unavailableCommand,
              executeStreaming: unavailableCommand,
              spawnDetached: () => Effect.die('Unknown MCP owner must not start a worker.'),
            }),
          ),
        ),
      ).toBe(false);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );
});

const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-01T00:05:00.000Z';
const at = (milliseconds: number) => new Date(milliseconds).toISOString();
const quiet = (streak: number, canonicalGeneration = '') => ({fingerprint: 'quiet', canonicalGeneration, streak});

function maintenanceCase(
  slot: string,
  overrides: Partial<ContextMaintenanceCaseV2> = {},
  family = 'citation',
): ContextMaintenanceCaseV2 {
  const identity = {project: 'threadnote', memoryId: family === 'candidate' ? 'candidate' : 'tn_a', family, slot};
  return {
    ...identity,
    caseId: contextHealthCaseIdV2(identity),
    evidenceRevision: 'evidence-1',
    disposition: 'waiting-evidence',
    reason: 'citation-unknown',
    firstSeen: T0,
    lastSeen: T0,
    lastChecked: T0,
    attemptCount: 1,
    events: [],
    ...overrides,
  };
}

function maintenanceState(overrides: Partial<MaintenanceState> = {}): MaintenanceState {
  return {
    version: 2,
    paused: false,
    state: 'idle',
    generation: 'generation',
    projects: [],
    cases: [],
    receipts: [],
    checkpoints: {},
    ...overrides,
  };
}

describe('context maintenance wake backoff', () => {
  it('doubles the owner-bound interval after each quiet tick up to thirty minutes', () => {
    expect(
      EffectArray.map([0, 1, 2, 5, 6, 40, 2_000], streak =>
        contextMaintenanceWakeIntervalMs(maintenanceState({workerQuiet: quiet(streak)}), 0, ''),
      ),
    ).toEqual([30_000, 60_000, 120_000, 960_000, 1_800_000, 1_800_000, 1_800_000]);
    expect(contextMaintenanceWakeIntervalMs(maintenanceState(), 0, '')).toBe(30_000);
  });

  it('never waits past the earliest pending retry or below thirty seconds', () => {
    const lastWakeAt = Date.parse(T0);
    const state = maintenanceState({
      workerQuiet: quiet(10),
      cases: [
        maintenanceCase('pending', {nextAttemptAt: at(lastWakeAt + 300_000)}),
        maintenanceCase('closed', {disposition: 'resolved', nextAttemptAt: at(lastWakeAt + 60_000)}),
      ],
      checkpoints: {
        'tn_a:0': {revision: 'r', checkedAt: T0, retryAt: at(lastWakeAt - 1)},
        'tn_b:0': {revision: 'r', checkedAt: T0, retryAt: at(lastWakeAt + 600_000)},
      },
    });
    expect(contextMaintenanceWakeIntervalMs(state, lastWakeAt, '')).toBe(300_000);
    const retryAt = at(lastWakeAt + 120_000);
    expect(contextMaintenanceWakeIntervalMs({...state, workerQuiet: {...quiet(10), retryAt}}, lastWakeAt, '')).toBe(
      120_000,
    );
    expect(
      contextMaintenanceWakeIntervalMs(
        {...state, checkpoints: {'tn_c:0': {revision: 'r', checkedAt: T0, retryAt: at(lastWakeAt + 10_000)}}},
        lastWakeAt,
        '',
      ),
    ).toBe(30_000);
  });

  it('keeps thirty seconds while any pending deadline is overdue within the first quiet rotation', () => {
    const lastWakeAt = Date.parse(T0);
    const overdue = at(lastWakeAt - 1);
    const backedOff = maintenanceState({
      workerQuiet: quiet(3),
      cases: [maintenanceCase('closed', {disposition: 'resolved', nextAttemptAt: overdue})],
    });
    expect(contextMaintenanceWakeIntervalMs(backedOff, lastWakeAt, '')).toBe(240_000);
    for (const pending of [
      {checkpoints: {'tn_a:0': {revision: 'r', checkedAt: T0, retryAt: overdue}}},
      {cases: [maintenanceCase('pending', {nextAttemptAt: overdue})]},
      {workerQuiet: {...quiet(3), retryAt: overdue}},
    ])
      expect(contextMaintenanceWakeIntervalMs({...backedOff, ...pending}, lastWakeAt, '')).toBe(30_000);
  });

  it('backs off after one quiet rotation while a deadline stays overdue, without hiding a later retry', () => {
    let now = Date.parse(T0);
    const overdue = at(now - 1);
    const draftNextEligibleAt = now + 36_000_000;
    const requests = [{project: 'threadnote', cwd: '/repo', uris: ['a'], deferredUntil: {a: overdue}}];
    let state = maintenanceState({cases: [maintenanceCase('topic', {nextAttemptAt: overdue})]});
    const recorded = EffectArray.map(EffectArray.range(0, 6), () => {
      state = {...state, workerQuiet: nextContextMaintenanceWorkerQuiet(state, requests, '', now, draftNextEligibleAt)};
      const interval = contextMaintenanceWakeIntervalMs(state, now, '');
      now += interval;
      return [state.workerQuiet?.streak, interval, state.workerQuiet?.retryAt];
    });
    expect(recorded).toEqual([
      [0, 30_000, overdue],
      [1, 30_000, overdue],
      [2, 30_000, overdue],
      [3, 30_000, overdue],
      [4, 480_000, at(draftNextEligibleAt)],
      [5, 960_000, at(draftNextEligibleAt)],
      [6, 1_800_000, at(draftNextEligibleAt)],
    ]);
  });

  it('returns to thirty seconds when the canonical generation changed or is unreadable', () => {
    const state = maintenanceState({workerQuiet: quiet(10, 'v1:before')});
    expect(contextMaintenanceWakeIntervalMs(state, 0, 'v1:before')).toBe(1_800_000);
    expect(contextMaintenanceWakeIntervalMs(state, 0, 'v1:after')).toBe(30_000);
    expect(contextMaintenanceWakeIntervalMs(state, 0, undefined)).toBe(30_000);
  });

  it('ignores rotating cursors and timestamps but sees each progress signal', () => {
    const progress = {
      version: 2 as const,
      analyzerVersion: 2,
      generation: 'semantic',
      cursor: 1,
      totalBatches: 3,
      eligibleRecords: 2,
      records: [],
      comparison: {pairCursor: 1, claimCursor: 0, seenCaseIds: []},
      dirty: [],
      comparedClaimPairs: 1,
      churnCount: 0,
      outputOmittedFindings: 0,
    };
    const item = maintenanceCase('slot');
    const checkpoint = {revision: 'r', memoryHash: 'h', checkedAt: T0};
    const receipt = {
      receiptId: 'maintenance-receipt',
      project: 'threadnote',
      subjectUri: 'memory',
      postHash: 'post',
      timestamp: T0,
      state: 'applied' as const,
    };
    const discovery = {namesHash: 'names', scanned: 0, scopedPending: true};
    const base = maintenanceState({
      cases: [item],
      receipts: [receipt],
      checkpoints: {'tn_a:0': checkpoint},
      semanticProgress: {threadnote: progress},
      workSchedule: {nextPhase: 'records', requestDiscovery: discovery},
    });
    const fingerprint = contextMaintenanceProgressFingerprint(base, []);
    const rotated = maintenanceState({
      ...base,
      lastProgressAt: T1,
      lastWakeAt: T1,
      lastTaskByProject: {threadnote: 'tn_a:0'},
      cases: [{...item, lastChecked: T1, attemptCount: 2, nextAttemptAt: T1, events: [{at: T1, reason: 'x'}]}],
      checkpoints: {'tn_a:0': {...checkpoint, checkedAt: T1, retryAt: T1}},
      workSchedule: {
        nextPhase: 'topic',
        lastSemanticProject: 'threadnote',
        lastRequestedRoot: '/requested',
        requestDiscovery: {...discovery, scanned: 3, lastFile: 'request-3.json'},
      },
    });
    expect(contextMaintenanceProgressFingerprint(rotated, [])).toBe(fingerprint);
    for (const progressed of [
      {...base, cases: [item, maintenanceCase('review', {disposition: 'needs-decision'}, 'candidate')]},
      {...base, cases: [{...item, disposition: 'resolved' as const}]},
      {...base, cases: [{...item, reason: 'citation-changed'}]},
      {...base, cases: [{...item, evidenceRevision: 'evidence-2'}]},
      {...base, receipts: [{...receipt, state: 'undone' as const}]},
      {...base, workSchedule: {nextPhase: 'records' as const, requestDiscovery: {...discovery, namesHash: 'other'}}},
      {...base, semanticProgress: {threadnote: {...progress, comparison: {...progress.comparison, pairCursor: 2}}}},
      {...base, checkpoints: {'tn_a:0': {...checkpoint, revision: 'r2'}}},
      {...base, checkpoints: {'tn_a:0': {...checkpoint, memoryHash: 'h2'}}},
    ])
      expect(contextMaintenanceProgressFingerprint(progressed, [])).not.toBe(fingerprint);
  });

  it('counts each newly attempted evidence-request URI as progress and a repeated deferral as quiet', () => {
    const now = Date.parse(T0);
    const uris = ['a', 'b', 'c', 'd', 'e', 'f'];
    const deferred = (until: string, ...keys: string[]) =>
      EffectRecord.fromEntries(EffectArray.map(keys, uri => [uri, until] as const));
    // Each tick of the requested phase selects four eligible URIs from the cursor, then clears or defers each one.
    const ticks = [
      {uris},
      {uris, cursor: 'd', deferredUntil: deferred(T1, 'a', 'b', 'c', 'd')},
      {uris, cursor: 'f', deferredUntil: deferred(T1, 'a', 'b', 'c', 'd', 'e', 'f')},
      {
        uris,
        cursor: 'd',
        deferredUntil: {...deferred(T1, 'e', 'f'), ...deferred(at(now + 600_000), 'a', 'b', 'c', 'd')},
      },
      {uris: uris.slice(1), cursor: 'f', deferredUntil: deferred(at(now - 1), 'b', 'c', 'd', 'e', 'f')},
    ];
    let state = maintenanceState();
    const recorded = EffectArray.map(ticks, request => {
      state = {
        ...state,
        workerQuiet: nextContextMaintenanceWorkerQuiet(
          state,
          [{project: 'threadnote', cwd: '/repo', ...request}],
          '',
          now,
        ),
      };
      return [state.workerQuiet?.streak, state.workerQuiet?.retryAt];
    });
    expect(recorded).toEqual([
      [0, undefined],
      [0, T1],
      [0, T1],
      [1, T1],
      [0, at(now - 1)],
    ]);
  });

  effectIt.effect('records only a successful worker tick and never fails the worker on unreadable input', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* setContextMaintenancePaused(config, false);
      const streak = readRawState(config).pipe(Effect.map(state => state.workerQuiet?.streak));
      yield* recordContextMaintenanceWorkerTick(config, undefined);
      yield* recordContextMaintenanceWorkerTick(config, 0);
      expect(yield* streak).toBe(1);
      yield* recordContextMaintenanceWorkerTick(config, 1);
      expect(yield* streak).toBe(1);
      const generation = resourceAccountMutationGenerationPath(path, config.agentContextHome, config.account);
      yield* fs.makeDirectory(path.dirname(generation), {recursive: true});
      yield* fs.writeFileString(generation, 'malformed');
      yield* recordContextMaintenanceWorkerTick(config, undefined);
      expect(yield* streak).toBe(1);
      yield* fs.writeFileString(generation, 'v1:00000000-0000-4000-8000-000000000001');
      yield* recordContextMaintenanceWorkerTick(config, undefined);
      expect(yield* streak).toBe(0);
      // An unreadable inventory persists a failed state and still exits zero.
      const succeeded = yield* readRawState(config);
      yield* writeState(config, {...succeeded, state: 'failed'});
      yield* recordContextMaintenanceWorkerTick(config, 0);
      expect((yield* readRawState(config)).workerQuiet).toEqual({...succeeded.workerQuiet, streak: 1, failed: true});
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('restarts the streak when a successful tick follows failed ticks, so overdue work wakes again', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      yield* setContextMaintenancePaused(config, false);
      const quietState = readRawState(config).pipe(Effect.map(state => state.workerQuiet));
      const setState = (state: MaintenanceState['state']) =>
        readRawState(config).pipe(Effect.flatMap(current => writeState(config, {...current, state})));
      yield* recordContextMaintenanceWorkerTick(config, 0);
      yield* recordContextMaintenanceWorkerTick(config, 0);
      yield* setState('failed');
      for (const _ of EffectArray.range(1, 4)) yield* recordContextMaintenanceWorkerTick(config, 0);
      expect((yield* quietState)?.streak).toBe(5);
      yield* setState('idle');
      yield* recordContextMaintenanceWorkerTick(config, 0);
      const recovered = yield* readRawState(config);
      expect(recovered.workerQuiet?.streak).toBe(0);
      expect(recovered.workerQuiet).not.toHaveProperty('failed');
      const lastWakeAt = Date.parse(T0);
      const overdue = {cases: [maintenanceCase('pending', {nextAttemptAt: at(lastWakeAt - 1)})]};
      expect(
        contextMaintenanceWakeIntervalMs(
          {...recovered, ...overdue},
          lastWakeAt,
          recovered.workerQuiet?.canonicalGeneration,
        ),
      ).toBe(30_000);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('backs off a persistent failed state to five minutes and then follows the normal rules', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      yield* setContextMaintenancePaused(config, false);
      yield* writeState(config, {...(yield* readRawState(config)), state: 'failed'});
      const overdue = {cases: [maintenanceCase('pending', {nextAttemptAt: at(-1)})]};
      const intervals: number[] = [];
      for (const _ of EffectArray.range(1, 6)) {
        yield* recordContextMaintenanceWorkerTick(config, 0);
        const state = yield* readRawState(config);
        intervals.push(contextMaintenanceWakeIntervalMs({...state, ...overdue}, 0, 'v1:changed'));
      }
      expect(intervals).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
      yield* writeState(config, {...(yield* readRawState(config)), state: 'idle'});
      const streak = readRawState(config).pipe(Effect.map(state => state.workerQuiet?.streak));
      yield* recordContextMaintenanceWorkerTick(config, 0);
      expect(yield* streak).toBe(0);
      yield* recordContextMaintenanceWorkerTick(config, 0);
      expect(yield* streak).toBe(1);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('records the tick without a draft deadline when the draft queue is unreadable', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const root = yield* draftQueueObservationDirectory(config);
      yield* setContextMaintenancePaused(config, false);
      yield* fs.makeDirectory(root, {recursive: true});
      yield* fs.writeFileString((yield* Path.Path).join(root, 'queue.json'), '{');
      yield* recordContextMaintenanceWorkerTick(config, 0);
      const quietState = (yield* readRawState(config)).workerQuiet;
      expect(quietState?.streak).toBe(0);
      expect(quietState).not.toHaveProperty('retryAt');
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('bounds owner-bound wakes by the draft retry time it reads without creating the queue', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      yield* setContextMaintenancePaused(config, false);
      yield* recordContextMaintenanceWorkerTick(config, 0);
      expect(yield* (yield* FileSystem.FileSystem).exists(yield* draftQueueObservationDirectory(config))).toBe(false);
      expect((yield* readRawState(config)).workerQuiet).not.toHaveProperty('retryAt');
      yield* enqueueDraftWork(config, {
        identity: sha256HexSync('identity'),
        targetKey: sha256HexSync('target'),
        targetUri: 'threadnote://memory/target',
        materialRevision: sha256HexSync('material'),
        backend: 'local-ai',
        providerIdentity: sha256HexSync('provider'),
        modelId: 'model',
        purpose: 'automatic',
        foreground: true,
        expectedContentHash: sha256HexSync('content'),
      });
      const admitted = yield* claimDraftWork(config);
      if (admitted.state !== 'claimed') return yield* Effect.die('The queued draft work was not claimed.');
      yield* finishDraftWork(config, admitted.claim, {state: 'failed', transient: true});
      yield* recordContextMaintenanceWorkerTick(config, 0);
      const quietState = (yield* readRawState(config)).workerQuiet;
      expect(quietState?.retryAt).toBe(at(300_000));
      expect(
        contextMaintenanceWakeIntervalMs(maintenanceState({workerQuiet: {...quietState!, streak: 10}}), 0, ''),
      ).toBe(300_000);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('holds owner-bound wakes for the backoff while CLI wakes, mutations and resume do not wait', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* setContextMaintenancePaused(config, false);
      let calls = 0;
      const command = CommandExecutor.of({
        execute: unavailableCommand,
        executeStreaming: unavailableCommand,
        spawnDetached: () =>
          Effect.sync(() => {
            calls++;
            return true;
          }),
      });
      const owned = wakeContextMaintenance(config, {bindToParent: true}).pipe(
        Effect.provideService(CommandExecutor, command),
      );
      const cli = wakeContextMaintenance(config).pipe(Effect.provideService(CommandExecutor, command));
      const recordQuiet = (streak: number, generation = '') =>
        readRawState(config).pipe(
          Effect.flatMap(state => writeState(config, {...state, workerQuiet: quiet(streak, generation)})),
        );
      expect(yield* owned).toBe(true);
      yield* recordQuiet(2);
      yield* TestClock.adjust('119 seconds');
      expect(yield* owned).toBe(false);
      yield* TestClock.adjust('1 second');
      expect(yield* owned).toBe(true);
      yield* TestClock.adjust('30 seconds');
      expect(yield* cli).toBe(true);
      yield* TestClock.adjust('30 seconds');
      expect(yield* owned).toBe(false);
      const generation = resourceAccountMutationGenerationPath(path, config.agentContextHome, config.account);
      yield* fs.makeDirectory(path.dirname(generation), {recursive: true});
      yield* fs.writeFileString(generation, 'v1:00000000-0000-4000-8000-000000000001');
      expect(yield* owned).toBe(true);
      yield* recordQuiet(6, 'v1:00000000-0000-4000-8000-000000000001');
      yield* TestClock.adjust('30 seconds');
      expect(yield* owned).toBe(false);
      yield* setContextMaintenancePaused(config, false);
      expect((yield* readRawState(config)).workerQuiet).toBeUndefined();
      expect(yield* owned).toBe(true);
      yield* writeState(config, {...(yield* readRawState(config)), lastWakeAt: 'unreadable', workerQuiet: quiet(10)});
      expect(yield* owned).toBe(true);
      expect(calls).toBe(6);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('leaves the worker streak unchanged after a foreground maintenance run', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      yield* (yield* FileSystem.FileSystem).writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
      yield* setContextMaintenancePaused(config, false);
      yield* writeState(config, {...(yield* readRawState(config)), workerQuiet: quiet(3)});
      yield* runContextMaintenance(config, {cwd: config.agentContextHome});
      expect((yield* readRawState(config)).workerQuiet).toEqual(quiet(3));
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});

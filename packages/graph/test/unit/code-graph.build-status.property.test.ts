import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  type CodeGraphBuildState,
  type CodeGraphBuildStatus,
  codeGraphAbandonedBuildStatusRemovable,
  codeGraphBuildStatusError,
  observeCodeGraphBuildStatus,
  parseCodeGraphBuildStatus,
} from '@threadnote/graph/build_status';
import {CodeGraphDiskCapacityPressureError} from '@threadnote/graph/types';

import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const heartbeatAt = Date.parse('2026-07-31T12:00:00.000Z');

const observationCase = FC.record({
  ageMilliseconds: FC.integer({
    max: CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS * 2,
    min: -CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS,
  }),
  hasStartIdentity: FC.boolean(),
  isRunning: FC.boolean(),
  reusedProcessId: FC.boolean(),
  state: FC.constantFrom<CodeGraphBuildState>('completed', 'failed', 'queued', 'running'),
});

const materializationCase = FC.record({
  attributedFiles: FC.integer({max: 1_000_000, min: 0}),
  availableBytes: FC.integer({max: 1_000_000_000, min: 0}),
  batchCompleted: FC.integer({max: 100, min: 0}),
  cachedFactBytes: FC.integer({max: 1_000_000_000, min: 0}),
  edges: FC.integer({max: 1_000_000, min: 0}),
  exactGenerationShardFiles: FC.integer({max: 1_000_000, min: 0}),
  materializedShardReplayBytes: FC.integer({max: 1_000_000_000, min: 0}),
  rawFactReplayBytes: FC.integer({max: 1_000_000_000, min: 0}),
  sourceBytes: FC.integer({max: 1_000_000_000, min: 0}),
  stagingBytes: FC.integer({max: 1_000_000_000, min: 0}),
  symbols: FC.integer({max: 1_000_000, min: 0}),
  withAdvisoryModel: FC.boolean(),
});

const activationCase = FC.record({
  elapsedMilliseconds: FC.integer({max: 10_000_000, min: 0}),
  rows: FC.integer({max: 100_000_000, min: 0}),
  stage: FC.constantFrom(
    'checkpointing-snapshot' as const,
    'committing-snapshot' as const,
    'copying-edges' as const,
    'copying-files' as const,
    'copying-lookup-keys' as const,
    'copying-reexports' as const,
    'copying-symbols' as const,
    'copying-terms' as const,
    'copying-workspace' as const,
    'recording-completion' as const,
    'validating-input' as const,
  ),
  state: FC.constantFrom('completed' as const, 'progress' as const, 'started' as const),
  transactionMilliseconds: FC.integer({max: 100_000, min: 0}),
});

const resolutionTransactionCase = FC.record({
  preparingBatch: FC.integer({max: 100_000, min: 0}),
  retiringReferences: FC.integer({max: 100_000, min: 0}),
  updatingAnalysis: FC.integer({max: 100_000, min: 0}),
  writingAliases: FC.integer({max: 100_000, min: 0}),
  writingEdges: FC.integer({max: 100_000, min: 0}),
});

describe('code graph build-status properties', () => {
  it('round-trips bounded capacity evidence while retaining legacy summary-only failures', () => {
    const evidence = {
      activeReservations: [{bytes: 20, role: 'durable' as const}],
      calibrationIdentity: 'fixture-v1',
      decisionLayer: 'bounded-write-reservation' as const,
      estimateBasis: 'final-fact-bytes-and-row-count' as const,
      filesystems: [{availableBytes: 10, requiredBytes: 30, role: 'durable' as const}],
      modelVersion: 2,
      recovery: 'free-space' as const,
      retryable: false,
      scope: {checkoutId: Effect.pipe('b', EffectString.repeat(64))},
    };
    const error = codeGraphBuildStatusError(
      CodeGraphDiskCapacityPressureError.of('stage persistent code graph facts', evidence),
    );
    const failed = {...buildStatus('failed', true), error};

    expect(parseCodeGraphBuildStatus(JSON.parse(JSON.stringify(failed)))?.error).toEqual(error);
    for (const operation of [
      'sort persistent code graph materialization spool',
      'apply persistent code graph materialization spool',
      'publish persistent code graph materialization spool receipts',
      'restore persistent code graph query indexes',
    ] as const) {
      const reservationError = codeGraphBuildStatusError(CodeGraphDiskCapacityPressureError.of(operation, evidence));
      expect(reservationError.capacity?.operation).toBe(operation);
      expect(
        parseCodeGraphBuildStatus(JSON.parse(JSON.stringify({...failed, error: reservationError})))?.error,
      ).toEqual(reservationError);
    }
    expect(parseCodeGraphBuildStatus({...failed, error: {summary: 'Legacy capacity failure.'}})?.error).toEqual({
      summary: 'Legacy capacity failure.',
    });
    expect(
      parseCodeGraphBuildStatus({
        ...failed,
        error: {
          ...error,
          capacity: {...error.capacity, operation: '/private/repository/path'},
        },
      }),
    ).toBeUndefined();
  });

  fcProp(
    it,
    'classifies terminal, exited, reused, stale, and active owners in fail-closed precedence order',
    {observation: observationCase},
    ({observation}) => {
      const status = buildStatus(observation.state, observation.hasStartIdentity);
      const observed = observeCodeGraphBuildStatus(status, {
        isRunning: observation.isRunning,
        nowMilliseconds: heartbeatAt + observation.ageMilliseconds,
        ...(observation.hasStartIdentity
          ? {processStartIdentity: observation.reusedProcessId ? 'replacement-owner' : 'original-owner'}
          : {}),
      });

      expect(observed.observation.heartbeatAgeMilliseconds).toBe(Math.max(0, observation.ageMilliseconds));
      if (observation.state === 'completed' || observation.state === 'failed') {
        expect(observed.observation).toMatchObject({liveness: observation.state});
      } else if (!observation.isRunning) {
        expect(observed.observation).toMatchObject({liveness: 'abandoned', reason: 'owner-exited'});
      } else if (observation.hasStartIdentity && observation.reusedProcessId) {
        expect(observed.observation).toMatchObject({liveness: 'abandoned', reason: 'pid-reused'});
      } else if (observation.ageMilliseconds > CODE_GRAPH_BUILD_STALE_AFTER_MILLISECONDS) {
        expect(observed.observation).toMatchObject({liveness: 'stalled', reason: 'heartbeat-stale'});
      } else {
        expect(observed.observation).toMatchObject({liveness: 'active'});
      }
    },
    {fastCheck: {numRuns: 250}},
  );

  fcProp(
    it,
    'admits abandoned nonterminal cleanup only without an exact protected build or matching lock owner',
    {
      liveness: FC.constantFrom(
        'abandoned' as const,
        'active' as const,
        'completed' as const,
        'failed' as const,
        'stalled' as const,
      ),
      lock: FC.constantFrom('absent' as const, 'matching' as const, 'replacement' as const),
      protectedBuild: FC.boolean(),
      state: FC.constantFrom<CodeGraphBuildState>('completed', 'failed', 'queued', 'running'),
    },
    ({liveness, lock, protectedBuild, state}) => {
      const status = {
        ...buildStatus(state, true),
        observation: {heartbeatAgeMilliseconds: 60_000, liveness},
      };
      const lockOwner =
        lock === 'absent'
          ? undefined
          : {
              processId: status.owner.processId,
              processStartIdentity: lock === 'matching' ? 'original-owner' : 'replacement-owner',
              token: 'owner-token',
              version: 1 as const,
            };

      expect(
        codeGraphAbandonedBuildStatusRemovable(status, lockOwner, protectedBuild ? status.buildId : undefined),
      ).toBe(
        liveness === 'abandoned' &&
          state !== 'completed' &&
          state !== 'failed' &&
          !protectedBuild &&
          lock !== 'matching',
      );
    },
    {fastCheck: {numRuns: 250}},
  );

  it('round-trips a bounded repository display name without accepting local-path control characters', () => {
    const status = buildStatus('running', true);
    const named = {...status, identity: {...status.identity, displayName: 'example/repository'}};
    expect(parseCodeGraphBuildStatus(named)?.identity.displayName).toBe('example/repository');
    expect(
      parseCodeGraphBuildStatus({...named, identity: {...named.identity, displayName: 'example\nrepository'}}),
    ).toBeUndefined();
  });

  fcProp(
    it,
    'round-trips bounded cache-admission observations and rejects invalid counters',
    {
      elapsedMilliseconds: FC.integer({max: 10_000_000, min: 0}),
      generations: FC.integer({max: 100, min: 0}),
      keys: FC.integer({max: 10_000_000, min: 0}),
    },
    activity => {
      const status = buildStatus('running', true);
      const registering: CodeGraphBuildStatus = {
        ...status,
        phase: 'registering',
        registration: {activity: {...activity, stage: 'loading-cache'}},
      };
      expect(parseCodeGraphBuildStatus(JSON.parse(JSON.stringify(registering)))?.registration).toEqual(
        registering.registration,
      );
      expect(
        parseCodeGraphBuildStatus({
          ...registering,
          registration: {activity: {...registering.registration!.activity, keys: -1}},
        }),
      ).toBeUndefined();
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'never throws while validating arbitrary JSON values and only returns bounded schema-v1 records',
    {value: FC.jsonValue()},
    ({value}) => {
      const parsed = parseCodeGraphBuildStatus(value);
      if (!parsed) return;

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.buildId.length).toBeLessThanOrEqual(64);
      expect(parsed.owner.processId).toBeGreaterThan(0);
      expect(parsed.owner.runtime).toBe('bun');
      expect(parsed.owner.runtimeVersion.length).toBeLessThanOrEqual(64);
      expect(parsed.subphase?.length ?? 0).toBeLessThanOrEqual(64);
      expect(parsed.error?.summary.length ?? 0).toBeLessThanOrEqual(300);
      // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
      expect(EffectArray.every(Object.values(parsed.counters), value => typeof value === 'string' || value >= 0)).toBe(
        true,
      );
    },
    {fastCheck: {numRuns: 500}},
  );

  fcProp(
    it,
    'round-trips bounded materialization activity and keeps TEMP database high-water internally consistent',
    {sample: materializationCase},
    ({sample}) => {
      const status = buildStatus('running', true);
      const batchesTotal = sample.batchCompleted + 1;
      const stagingHighWaterBytes = sample.stagingBytes + 1_024;
      const materializing: CodeGraphBuildStatus = {
        ...status,
        materialization: {
          activity: {
            batchCompleted: sample.batchCompleted,
            batchTotal: batchesTotal,
            cachedFactBytes: sample.cachedFactBytes,
            rows: {
              deduplicatedEdges: sample.edges,
              deduplicatedReferences: sample.symbols,
              edges: sample.edges,
              symbols: sample.symbols,
            },
            sourceBytes: sample.sourceBytes,
            stage: 'writing-facts',
            startedAt: status.timestamps.phaseStartedAt,
          },
          metrics: {
            attributedFilesCompleted: sample.attributedFiles,
            batchesCompleted: sample.batchCompleted,
            batchesTotal,
            cachedFactBytesCompleted: sample.cachedFactBytes,
            cachedFactBytesTotal: sample.cachedFactBytes,
            cachedFactReplayBytesCompleted: sample.materializedShardReplayBytes + sample.rawFactReplayBytes,
            changedFactBytesCompleted: sample.cachedFactBytes,
            crossGenerationShardFilesCompleted: 0,
            exactGenerationShardFilesCompleted: sample.exactGenerationShardFiles,
            materializedShardCacheDeferredFilesCompleted: 0,
            materializedShardCacheDeferredRawFactBytesCompleted: 0,
            materializedShardReplayBytesCompleted: sample.materializedShardReplayBytes,
            rawFactReplayBytesCompleted: sample.rawFactReplayBytes,
            rows: {
              deduplicatedEdges: sample.edges,
              deduplicatedReferences: sample.symbols,
              edges: sample.edges,
              symbols: sample.symbols,
            },
            sourceBytesCompleted: sample.sourceBytes,
            sourceBytesTotal: sample.sourceBytes,
            subphaseMilliseconds: {
              attributionCompute: sample.batchCompleted,
              factBatchPreparation: sample.batchCompleted + 1,
              shardAssociation: sample.batchCompleted + 2,
              shardPersistence: sample.batchCompleted + 3,
              shardSerialization: sample.batchCompleted + 4,
            },
            storage: {
              ...(sample.withAdvisoryModel
                ? {decisionLayer: 'whole-build-heuristic' as const, enforcement: 'advisory' as const, modelVersion: 1}
                : {}),
              availableBytes: sample.availableBytes,
              durableAvailableBytes: sample.availableBytes,
              estimateBasis: 'cached-fact-bytes',
              estimatedConcurrentBuildBytes: sample.stagingBytes,
              estimatedDurableFilesystemRequiredBytes: sample.stagingBytes,
              estimatedDurableSnapshotBytes: sample.stagingBytes,
              estimatedJournalBytes: sample.stagingBytes,
              estimatedRequiredBytes: stagingHighWaterBytes,
              estimatedTemporaryFilesystemRequiredBytes: sample.stagingBytes,
              estimatedTemporaryDatabaseBytes: sample.stagingBytes,
              filesystemsShared: true,
              temporaryAvailableBytes: sample.availableBytes,
              temporaryDatabaseBytes: sample.stagingBytes,
              temporaryDatabaseHighWaterBytes: stagingHighWaterBytes,
            },
          },
        },
      };

      expect(parseCodeGraphBuildStatus(JSON.parse(JSON.stringify(materializing)))?.materialization).toEqual(
        materializing.materialization,
      );
      for (const invalid of [
        {decisionLayer: 'bounded-write-reservation'},
        {enforcement: 'enforced'},
        {modelVersion: 0},
        {modelVersion: -1},
        {modelVersion: 1.5},
        {modelVersion: Number.MAX_SAFE_INTEGER + 1},
      ]) {
        expect(
          parseCodeGraphBuildStatus({
            ...materializing,
            materialization: {
              ...materializing.materialization,
              metrics: {
                ...materializing.materialization!.metrics!,
                storage: {...materializing.materialization!.metrics!.storage!, ...invalid},
              },
            },
          }),
        ).toBeUndefined();
      }

      expect(
        parseCodeGraphBuildStatus({
          ...materializing,
          materialization: {
            ...materializing.materialization,
            metrics: {
              ...materializing.materialization!.metrics!,
              cachedFactReplayBytesCompleted:
                materializing.materialization!.metrics!.cachedFactReplayBytesCompleted! + 1,
            },
          },
        }),
      ).toBeUndefined();
      expect(
        parseCodeGraphBuildStatus({
          ...materializing,
          materialization: {
            ...materializing.materialization,
            metrics: {
              ...materializing.materialization!.metrics!,
              materializedShardCacheDeferredRawFactBytesCompleted:
                materializing.materialization!.metrics!.rawFactReplayBytesCompleted! + 1,
            },
          },
        }),
      ).toBeUndefined();
      expect(
        parseCodeGraphBuildStatus({
          ...materializing,
          materialization: {
            ...materializing.materialization,
            metrics: {
              ...materializing.materialization!.metrics!,
              subphaseMilliseconds: {
                ...materializing.materialization!.metrics!.subphaseMilliseconds!,
                shardPersistence: -1,
              },
            },
          },
        }),
      ).toBeUndefined();
      expect(
        parseCodeGraphBuildStatus({
          ...materializing,
          materialization: {
            metrics: {
              ...materializing.materialization!.metrics,
              storage: {
                temporaryDatabaseBytes: stagingHighWaterBytes + 1,
                temporaryDatabaseHighWaterBytes: stagingHighWaterBytes,
              },
            },
          },
        }),
      ).toBeUndefined();
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'round-trips bounded resolution transaction stages and rejects negative timings',
    {sample: resolutionTransactionCase},
    ({sample}) => {
      const status = buildStatus('running', true);
      const activity = {
        aliasesDiscovered: 0,
        elapsedMilliseconds: 500_000,
        longestTransactionMilliseconds: 75_000,
        matchingMilliseconds: 100_000,
        pageCompleted: 1,
        pageTotal: 2,
        pagesCompleted: 1,
        pass: 1,
        referencesCompleted: 5_000,
        referencesExamined: 5_000,
        referencesTotal: 10_000,
        resolved: 4_000,
        startedAt: status.timestamps.phaseStartedAt,
        transactionMilliseconds: 400_000,
        transactionStageMilliseconds: sample,
      };
      const resolving: CodeGraphBuildStatus = {...status, phase: 'resolving', resolution: {activity}};

      expect(parseCodeGraphBuildStatus(JSON.parse(JSON.stringify(resolving)))?.resolution).toEqual(
        resolving.resolution,
      );
      expect(
        parseCodeGraphBuildStatus({
          ...resolving,
          resolution: {
            activity: {
              ...activity,
              transactionStageMilliseconds: {...sample, writingEdges: -1},
            },
          },
        }),
      ).toBeUndefined();
      expect(
        parseCodeGraphBuildStatus({
          ...resolving,
          resolution: {activity: {...activity, longestTransactionMilliseconds: -1}},
        }),
      ).toBeUndefined();
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'round-trips bounded activation progress and rejects negative transaction timings',
    {sample: activationCase},
    ({sample}) => {
      const status = buildStatus('running', true);
      const activity = {
        elapsedMilliseconds: sample.elapsedMilliseconds,
        rows: sample.rows,
        stage: sample.stage,
        stageElapsedMilliseconds: Math.min(sample.elapsedMilliseconds, sample.transactionMilliseconds),
        startedAt: status.timestamps.phaseStartedAt,
        state: sample.state,
        transactionMilliseconds: sample.transactionMilliseconds,
      };
      const activating: CodeGraphBuildStatus = {...status, activation: {activity}, phase: 'activating'};

      expect(parseCodeGraphBuildStatus(JSON.parse(JSON.stringify(activating)))?.activation).toEqual(
        activating.activation,
      );
      expect(
        parseCodeGraphBuildStatus({
          ...activating,
          activation: {activity: {...activity, transactionMilliseconds: -1}},
        }),
      ).toBeUndefined();
    },
    {fastCheck: {numRuns: 150}},
  );
});

function buildStatus(state: CodeGraphBuildState, hasStartIdentity: boolean): CodeGraphBuildStatus {
  const timestamp = new Date(heartbeatAt).toISOString();
  return {
    buildId: Effect.pipe('a', EffectString.repeat(32)),
    counters: {},
    identity: {
      checkoutId: Effect.pipe('b', EffectString.repeat(64)),
      commit: Effect.pipe('c', EffectString.repeat(40)),
      repositoryId: Effect.pipe('d', EffectString.repeat(64)),
      worktreeId: Effect.pipe('e', EffectString.repeat(64)),
    },
    owner: {
      processId: 42,
      ...(hasStartIdentity ? {processStartIdentity: 'original-owner'} : {}),
      runtime: 'bun',
      runtimeVersion: '1.3.14',
    },
    phase: state === 'queued' ? 'waiting' : 'materializing',
    schemaVersion: 1,
    state,
    timestamps: {
      ...(state === 'completed' || state === 'failed' ? {completedAt: timestamp} : {}),
      heartbeatAt: timestamp,
      lastProgressAt: timestamp,
      phaseStartedAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

import {Array as EffectArray, Option as EffectOption} from 'effect';
import {readFileSync} from '@threadnote/testing/node-fs';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {parseReadyQueryBenchmarkArguments} from '../../../../scripts/benchmark-code-graph-ready-query.js';
import {
  READY_QUERY_CONTROLS,
  READY_QUERY_ENVIRONMENT_ATTESTATION,
  READY_QUERY_GITHUB_ENVIRONMENT,
  READY_QUERY_GITHUB_EVENT,
  READY_QUERY_GITHUB_JOB,
  READY_QUERY_GITHUB_REF,
  READY_QUERY_LEGACY_GITHUB_REPOSITORY,
  READY_QUERY_GITHUB_REPOSITORY,
  READY_QUERY_GITHUB_REPOSITORY_ID,
  READY_QUERY_GITHUB_WORKFLOW_REF,
  READY_QUERY_MINIMUM_FILES,
  READY_QUERY_REPOSITORY,
  READY_QUERY_REPOSITORY_COMMIT,
  READY_QUERY_REPOSITORY_TREE,
  parseReadyQueryEvidenceV1,
  readyQueryPercentile,
  type ReadyQueryEvidenceV1,
  type ReadyQueryStageSeriesV1,
  type ReadyQueryTimingSeriesV1,
} from '@threadnote/threadnote/evaluation/ready/query_evidence';
import {
  parseReadyQueryLinuxHostSample,
  readyQueryHostEvidence,
} from '@threadnote/threadnote/evaluation/ready/query_host';
import {CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const RESULT_DIGEST = Effect.pipe('a', EffectString.repeat(64));
const SNAPSHOT_DIGEST = Effect.pipe('b', EffectString.repeat(64));
const SAMPLES = 25;

describe('large ready-query evidence', () => {
  it('accepts the compact reviewed contract without depending on array order', () => {
    const artifact = validArtifact();
    artifact.controls.reverse();
    artifact.measurements.deferred.stages.reverse();
    artifact.measurements.exact.stages.reverse();

    expect(parseReadyQueryEvidenceV1(artifact)).toBe(artifact);
    expect(
      EffectOption.getOrUndefined(
        EffectArray.findFirst(READY_QUERY_CONTROLS, control => control.id === 'bazel-kotlinc-options'),
      )?.expectedLanguage,
    ).toBe('starlark');
  });

  it('accepts the legacy repository identity while preserving the immutable repository ID', () => {
    const artifact = validArtifact();
    artifact.source.github.repository = READY_QUERY_LEGACY_GITHUB_REPOSITORY;
    artifact.source.github.workflowRef =
      `${READY_QUERY_LEGACY_GITHUB_REPOSITORY}/.github/workflows/code-graph-ready-query-evidence.yml@refs/heads/main` as const;

    expect(parseReadyQueryEvidenceV1(artifact)).toBe(artifact);
  });

  it('rejects privacy-unsafe unknown fields at every retained boundary', () => {
    const artifact = validArtifact();
    expect(() => parseReadyQueryEvidenceV1({...artifact, privatePath: '/private/repository'})).toThrow(
      'artifact contains unknown or missing fields',
    );
    expect(() =>
      parseReadyQueryEvidenceV1({...artifact, fixture: {...artifact.fixture, privatePath: '/private/fixture'}}),
    ).toThrow('fixture provenance contains unknown or missing fields');
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        controls: [{...artifact.controls[0], query: 'private symbol'}, ...artifact.controls.slice(1)],
      }),
    ).toThrow('control java-progress-manager contains unknown or missing fields');
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        measurements: {
          ...artifact.measurements,
          deferred: {
            ...artifact.measurements.deferred,
            stages: [
              {...artifact.measurements.deferred.stages[0], repositoryId: 'private-id'},
              ...artifact.measurements.deferred.stages.slice(1),
            ],
          },
        },
      }),
    ).toThrow('stage graph.query.status/query-repository-identity contains unknown or missing fields');
  });

  it('rejects malformed contention evidence and empty serialized responses', () => {
    const artifact = validArtifact();
    expect(() => parseReadyQueryEvidenceV1({...artifact, host: {...artifact.host, reasons: ''}})).toThrow(
      'host contention reasons are invalid',
    );
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        controls: [{...artifact.controls[0], exactTextResponseBytes: 0}, ...artifact.controls.slice(1)],
      }),
    ).toThrow('response bytes is out of range');
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        measurements: {
          ...artifact.measurements,
          deferred: {
            ...artifact.measurements.deferred,
            structuredResponseBytes: [0, ...artifact.measurements.deferred.structuredResponseBytes.slice(1)],
          },
        },
      }),
    ).toThrow('structured response bytes is out of range');
  });

  it('uses the nearest-rank percentile for 25, 40, and 100 samples', () => {
    expect(readyQueryPercentile([...Array.from({length: 23}, () => 500), 501, 501], 0.95)).toBe(501);
    expect(readyQueryPercentile([...Array.from({length: 38}, () => 500), 501, 501], 0.95)).toBe(500);
    expect(
      readyQueryPercentile([...Array.from({length: 95}, () => 500), ...Array.from({length: 5}, () => 501)], 0.95),
    ).toBe(500);
  });

  it('rejects non-canonical workflow provenance and overstated isolation', () => {
    const artifact = validArtifact();
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        source: {...artifact.source, validationMode: 'managed-exact-head'},
      }),
    ).toThrow('source validation mode is invalid');
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        source: {...artifact.source, github: {...artifact.source.github, repository: 'fork/threadnote'}},
      }),
    ).toThrow('canonical protected GitHub workflow run');
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        source: {
          ...artifact.source,
          github: {...artifact.source.github, workflowSha: Effect.pipe('e', EffectString.repeat(40))},
        },
      }),
    ).toThrow('canonical protected GitHub workflow run');
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        source: {...artifact.source, github: {...artifact.source.github, runnerEnvironment: 'github-hosted'}},
      }),
    ).toThrow('canonical protected GitHub workflow run');
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        isolation: {...artifact.isolation, buildingSnapshotsAtExit: 1},
      }),
    ).toThrow('reviewed builder-exclusion boundary');
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        isolation: {...artifact.isolation, fullWriterIsolation: 'attested'},
      }),
    ).toThrow('reviewed builder-exclusion boundary');
    expect(() =>
      parseReadyQueryEvidenceV1({
        ...artifact,
        isolation: {...artifact.isolation, privateLockPath: '/private/lock'},
      }),
    ).toThrow('builder exclusion evidence contains unknown or missing fields');
  });

  it('keeps the runner rebuild-free and its evidence mode separate from the full-build harness', () => {
    const source = readFileSync('scripts/benchmark-code-graph-ready-query.ts', 'utf8');
    expect(source).toContain('requestMaintenance: false');
    expect(source).toContain('refresh: false');
    expect(source).not.toContain('CodeGraphIndexer');
    expect(source).not.toContain('.index({');
    expect(source).not.toContain('prepareCodeGraphFixture');
    expect(source).not.toContain('withCodeGraphDatabaseWriteLock');
    expect(source).toContain("kind: 'ready-query-preflight'");
    expect(source).toContain("provenance.mode !== 'github-actions-clean-source'");
    expect(source).toContain('atomicWrite(prepared.output');
    expect(source).not.toContain('atomicWrite(options.output');
    const exclusion = Effect.pipe(
      source,
      EffectString.slice(
        Effect.pipe(
          source,
          EffectString.indexOf('const withReadyQueryBuilderExclusion = Effect.fn'),
          Effect.Option.getOrElse(() => -1),
        ),
      ),
    );
    expect(
      Effect.pipe(
        exclusion,
        EffectString.indexOf('withCodeGraphMaintenanceRegistration('),
        Effect.Option.getOrElse(() => -1),
      ),
    ).toBeLessThan(
      Effect.pipe(
        exclusion,
        EffectString.indexOf('withCodeGraphMaintenanceIntent('),
        Effect.Option.getOrElse(() => -1),
      ),
    );
    expect(
      Effect.pipe(
        exclusion,
        EffectString.indexOf('withCodeGraphMaintenanceIntent('),
        Effect.Option.getOrElse(() => -1),
      ),
    ).toBeLessThan(
      Effect.pipe(
        exclusion,
        EffectString.indexOf('codeGraphRepositoryLockPath('),
        Effect.Option.getOrElse(() => -1),
      ),
    );
    expect(
      Effect.pipe(
        exclusion,
        EffectString.indexOf('codeGraphRepositoryLockPath('),
        Effect.Option.getOrElse(() => -1),
      ),
    ).toBeLessThan(
      Effect.pipe(
        exclusion,
        EffectString.indexOf('awaitCodeGraphWorktreeBuilds('),
        Effect.Option.getOrElse(() => -1),
      ),
    );
    expect(() =>
      parseReadyQueryEvidenceV1({
        contract: 'code-graph-ready-query-large',
        kind: 'ready-query-preflight',
        state: 'ready',
        version: 1,
      }),
    ).toThrow('artifact contains unknown or missing fields');
  });

  it('parses only the narrow preprovisioned-repository CLI surface', () => {
    expect(
      parseReadyQueryBenchmarkArguments([
        '--repository',
        '/fixture',
        '--home',
        '/ready-home',
        '--output',
        '/evidence.json',
        '--preflight',
      ]),
    ).toEqual({
      home: '/ready-home',
      output: '/evidence.json',
      preflight: true,
      quiet: false,
      repository: '/fixture',
    });
    expect(() => parseReadyQueryBenchmarkArguments(['--repository', '/fixture', '--home', '/ready-home'])).toThrow(
      'requires --repository, --home, and --output',
    );
    expect(() =>
      parseReadyQueryBenchmarkArguments([
        '--repository',
        '/fixture',
        '--home',
        '/ready-home',
        '--output',
        '/evidence.json',
        '--samples',
        '1',
      ]),
    ).toThrow('Unknown ready-query benchmark option');
  });

  it('parses Linux host counters and invalidates observed contention', () => {
    const first = parseReadyQueryLinuxHostSample({
      cpuPressure: 'some avg10=0.00 avg60=0.00 avg300=0.00 total=1000\n',
      ioPressure: 'some avg10=0.00 avg60=0.00 avg300=0.00 total=2000\n',
      load: '0.01 0.02 0.03 1/100 7\n',
      memoryPressure: 'some avg10=0.00 avg60=0.00 avg300=0.00 total=3000\n',
      observedAtMilliseconds: 1_000,
      stat: 'cpu  1 2 3 4 5 6 7 8 0 0\n',
      vmstat: 'pswpin 2\npswpout 3\n',
    });
    const quiet = {
      ...first,
      cpuPressureTotalMicroseconds: 1_500,
      ioPressureTotalMicroseconds: 2_500,
      memoryPressureTotalMicroseconds: 3_500,
      observedAtMilliseconds: 2_000,
    };
    expect(readyQueryHostEvidence([first, quiet], 8)).toMatchObject({contended: false, observations: 2});
    expect(() => readyQueryHostEvidence([first, {...quiet, stealTicks: 9}], 8)).toThrow('Host contention invalidates');
  });

  it('preserves CPU counters across horizontal separator runs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', '\t'), {minLength: 1, maxLength: 512}),
        fc.nat(1_000_000),
        (separators, stealTicks) => {
          const parsed = parseReadyQueryLinuxHostSample({
            cpuPressure: 'some avg10=0.00 avg60=0.00 avg300=0.00 total=1000\n',
            ioPressure: 'some avg10=0.00 avg60=0.00 avg300=0.00 total=2000\n',
            memoryPressure: 'some avg10=0.00 avg60=0.00 avg300=0.00 total=3000\n',
            load: '0.01 0.02 0.03 1/100 7\n',
            observedAtMilliseconds: 1_000,
            stat: 'cpu' + EffectArray.join(separators, '') + '1 2 3 4 5 6 7 ' + stealTicks + ' 0 0\n',
            vmstat: 'pswpin 2\npswpout 3\n',
          });
          expect(parsed.stealTicks).toBe(stealTicks);
          expect(parsed.runnableProcesses).toBe(1);
        },
      ),
      {numRuns: 50},
    );
    expect(() =>
      parseReadyQueryLinuxHostSample({
        cpuPressure: 'some total=1000\n',
        ioPressure: 'some total=2000\n',
        memoryPressure: 'some total=3000\n',
        load: '0.01 0.02 0.03 1/100 7\n',
        observedAtMilliseconds: 1_000,
        stat: 'cpu' + EffectString.repeat(32_768)('\t') + '\n',
        vmstat: 'pswpin 2\npswpout 3\n',
      }),
    ).toThrow('Linux host contention counters are unavailable or malformed.');
  });

  it('preserves PSI totals across horizontal separators and rejects an empty pressure line', () => {
    const input = {
      cpuPressure: 'some total=1000\n',
      ioPressure: 'some total=2000\n',
      memoryPressure: 'some total=3000\n',
      load: '0.01 0.02 0.03 1/100 7\n',
      observedAtMilliseconds: 1_000,
      stat: 'cpu 1 2 3 4 5 6 7 8 0 0\n',
      vmstat: 'pswpin 2\npswpout 3\n',
    };
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', '\t'), {minLength: 1, maxLength: 512}),
        fc.nat(1_000_000),
        (separators, total) => {
          const pressure =
            'some' + EffectArray.join(separators, '') + 'avg10=0.00 avg60=0.00 avg300=0.00 total=' + total + '\n';
          const parsed = parseReadyQueryLinuxHostSample({
            ...input,
            cpuPressure: pressure,
            ioPressure: pressure,
            memoryPressure: pressure,
          });
          expect(parsed.cpuPressureTotalMicroseconds).toBe(total);
          expect(parsed.ioPressureTotalMicroseconds).toBe(total);
          expect(parsed.memoryPressureTotalMicroseconds).toBe(total);
        },
      ),
      {numRuns: 50},
    );
    expect(() =>
      parseReadyQueryLinuxHostSample({
        ...input,
        cpuPressure: 'some' + EffectString.repeat(32_768)('\t') + '\n',
      }),
    ).toThrow('Linux host contention counters are unavailable or malformed.');
  });

  it('checks the exact 200k inventory boundary', () => {
    fc.assert(
      fc.property(fc.integer({min: READY_QUERY_MINIMUM_FILES - 3, max: READY_QUERY_MINIMUM_FILES + 3}), files => {
        const artifact = validArtifact();
        artifact.fixture.trackedFiles = files;
        artifact.snapshot.fileCount = files;
        if (files >= READY_QUERY_MINIMUM_FILES) expect(() => parseReadyQueryEvidenceV1(artifact)).not.toThrow();
        else expect(() => parseReadyQueryEvidenceV1(artifact)).toThrow(/files must be at least 200000/);
      }),
      {numRuns: 20},
    );
  });

  it('checks the deferred p95 boundary independent of sample order', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 3, max: 550}),
        fc.uniqueArray(fc.integer({min: 0, max: SAMPLES - 1}), {minLength: SAMPLES, maxLength: SAMPLES}),
        (latency, order) => {
          const artifact = validArtifact();
          const multiset = [...Array.from({length: SAMPLES - 2}, () => latency - 1), latency, latency];
          const values = EffectArray.map(order, index => multiset[index]);
          artifact.measurements.deferred = timingSeries('deferred', values);
          if (latency <= 500) expect(() => parseReadyQueryEvidenceV1(artifact)).not.toThrow();
          else expect(() => parseReadyQueryEvidenceV1(artifact)).toThrow('Deferred ready-query p95 exceeds 500 ms');
        },
      ),
      {numRuns: 30},
    );
  });

  it('accepts every control and stage permutation but rejects duplicate coverage', () => {
    fc.assert(
      fc.property(permutation(READY_QUERY_CONTROLS.length), permutation(4), (controlOrder, stageOrder) => {
        const artifact = validArtifact();
        artifact.controls = EffectArray.map(controlOrder, index => artifact.controls[index]);
        artifact.measurements.deferred.stages = EffectArray.map(
          stageOrder,
          index => artifact.measurements.deferred.stages[index],
        );
        artifact.measurements.exact.stages = EffectArray.map(
          stageOrder,
          index => artifact.measurements.exact.stages[index],
        );
        expect(() => parseReadyQueryEvidenceV1(artifact)).not.toThrow();

        artifact.controls = [...artifact.controls.slice(0, -1), artifact.controls[0]];
        expect(() => parseReadyQueryEvidenceV1(artifact)).toThrow('controls are incomplete');
      }),
      {numRuns: 20},
    );
  });
});

function permutation(length: number) {
  return fc.uniqueArray(fc.integer({min: 0, max: length - 1}), {minLength: length, maxLength: length});
}

function validArtifact(): MutableReadyQueryEvidence {
  return {
    controls: EffectArray.map(READY_QUERY_CONTROLS, control => ({
      deferredDigest: RESULT_DIGEST,
      deferredFreshness: 'deferred',
      deferredStructuredResponseBytes: 1_000,
      deferredTextResponseBytes: 2_000,
      exactDigest: RESULT_DIGEST,
      exactFreshness: 'current',
      exactStructuredResponseBytes: 1_000,
      exactTextResponseBytes: 2_000,
      expectedMatch: true,
      id: control.id,
      language: control.expectedLanguage,
    })),
    createdAt: '2026-08-20T00:00:00.000Z',
    fixture: {
      clean: true,
      commit: READY_QUERY_REPOSITORY_COMMIT,
      publicCommitProof: 'anonymous-https-exact-commit-fetch',
      repository: READY_QUERY_REPOSITORY,
      trackedFiles: READY_QUERY_MINIMUM_FILES,
      tree: READY_QUERY_REPOSITORY_TREE,
    },
    host: {
      available: true,
      contended: false,
      cpuPressurePercentMaximum: 0,
      ioPressurePercentMaximum: 0,
      logicalCpuCount: 8,
      maxRunnableProcesses: 1,
      memoryPressurePercentMaximum: 0,
      observations: SAMPLES * 2,
      policy: 'linux-proc-v1',
      reasons: [],
      stealTicksDelta: 0,
      swapInputPagesDelta: 0,
      swapOutputPagesDelta: 0,
    },
    isolation: {
      builderExclusion: 'maintenance-registration-intent-repository-lock-worktree-drain-v1',
      builderExclusionScope: 'inside-status-through-artifact-write',
      buildingSnapshotsAtEntry: 0,
      buildingSnapshotsAtExit: 0,
      databaseWriterLock: 'not-held',
      fullWriterIsolation: 'not-attested',
      storageCapacityIsolation: 'not-attested',
    },
    latencyBoundary: 'composed-status-inspect-serialization',
    measurements: {
      deferred: timingSeries(
        'deferred',
        Array.from({length: SAMPLES}, () => 100),
      ),
      exact: timingSeries(
        'exact',
        Array.from({length: SAMPLES}, () => 10),
      ),
    },
    requestProfile: {
      deferredTimeoutMilliseconds: 5_000,
      depth: 1,
      edgeLimit: 40,
      exactTimeoutMilliseconds: 30_000,
      includeHeuristic: false,
      includeModelAssociations: false,
      nodeLimit: 20,
      operation: 'query',
      semanticBudgetMilliseconds: 10_000,
      semanticPolicy: 'runtime-available-lexical-first',
      traversalBudgetMilliseconds: 2_000,
    },
    runner: 'dedicated-preprovisioned-linux-x64',
    runtime: {
      compatible: true,
      extractorSet: 'native-code-graph-14',
      persistentExtensionRevision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
      resultVersion: 1,
      schemaVersion: 3,
    },
    snapshot: {
      commit: READY_QUERY_REPOSITORY_COMMIT,
      dirty: false,
      edgeCount: 1,
      extractorSet: 'native-code-graph-14',
      fileCount: READY_QUERY_MINIMUM_FILES,
      idSha256: SNAPSHOT_DIGEST,
      state: 'ready',
      symbolCount: 1,
    },
    source: {
      clean: true,
      commit: Effect.pipe('d', EffectString.repeat(40)),
      github: {
        environment: READY_QUERY_GITHUB_ENVIRONMENT,
        environmentAttestation: READY_QUERY_ENVIRONMENT_ATTESTATION,
        eventName: READY_QUERY_GITHUB_EVENT,
        job: READY_QUERY_GITHUB_JOB,
        ref: READY_QUERY_GITHUB_REF,
        refProtected: true,
        repository: READY_QUERY_GITHUB_REPOSITORY,
        repositoryId: READY_QUERY_GITHUB_REPOSITORY_ID,
        repositoryEnablement: 'enabled',
        runnerArch: 'X64',
        runnerEnvironment: 'self-hosted',
        runnerOs: 'Linux',
        runAttempt: '1',
        runId: '123',
        sha: Effect.pipe('d', EffectString.repeat(40)),
        workflowRef: READY_QUERY_GITHUB_WORKFLOW_REF,
        workflowSha: Effect.pipe('d', EffectString.repeat(40)),
      },
      lockfileSha256: Effect.pipe('e', EffectString.repeat(64)),
      packageManifestSha256: Effect.pipe('f', EffectString.repeat(64)),
      validationMode: 'github-actions-clean-source',
    },
    suite: 'code-graph-ready-query-large',
    version: 1,
  };
}

function timingSeries(kind: 'deferred' | 'exact', values: readonly number[]): MutableTimingSeries {
  const exact = kind === 'exact';
  const stages: MutableStageSeries[] = [
    stage('graph.query.status', 'query-repository-identity', 'measured', values, 1),
    stage('graph.query.status', 'query-worktree-observation', exact ? 'measured' : 'skipped', values, exact ? 1 : 0),
    stage('graph.query.execute', 'query-strict-reobservation', 'skipped', values, 0),
    stage('graph.query.execute', 'query-serialization', 'measured', values, 1),
  ];
  const attributed = exact ? 3 : 2;
  return {
    endToEndMilliseconds: [...values],
    freshness: exact ? 'current' : 'deferred',
    ...(exact ? {} : {intervalMilliseconds: 1_000}),
    maxConcurrency: 1,
    mode: exact ? 'sequential' : 'fixed-rate',
    queueLatencyIncluded: true,
    queueLatencyMilliseconds: EffectArray.map(values, () => 0),
    resultDigests: EffectArray.map(values, () => RESULT_DIGEST),
    serviceMilliseconds: [...values],
    snapshotDigests: EffectArray.map(values, () => SNAPSHOT_DIGEST),
    stages,
    structuredResponseBytes: EffectArray.map(values, () => 1_000),
    textResponseBytes: EffectArray.map(values, () => 2_000),
    unattributedMilliseconds: EffectArray.map(values, value => value - attributed),
    warmups: 5,
  };
}

function stage(
  phase: ReadyQueryStageSeriesV1['phase'],
  name: ReadyQueryStageSeriesV1['stage'],
  disposition: ReadyQueryStageSeriesV1['disposition'],
  values: readonly number[],
  duration: number,
): MutableStageSeries {
  return {disposition, durationMilliseconds: EffectArray.map(values, () => duration), phase, stage: name};
}

type Mutable<T> = {-readonly [K in keyof T]: T[K] extends readonly (infer V)[] ? Mutable<V>[] : Mutable<T[K]>};
type MutableReadyQueryEvidence = Mutable<ReadyQueryEvidenceV1>;
type MutableTimingSeries = Mutable<ReadyQueryTimingSeriesV1>;
type MutableStageSeries = Mutable<ReadyQueryStageSeriesV1>;

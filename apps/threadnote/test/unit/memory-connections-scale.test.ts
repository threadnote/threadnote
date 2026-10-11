import {it as effectIt} from '@effect/vitest';
import * as BunCrypto from '@effect/platform-bun/BunCrypto';
import {Crypto, Effect} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {parseMemoryConnectionsScaleTargetArguments} from '../../../../scripts/benchmark-memory-connections-scale-target.js';
import {
  MAX_MEMORY_CONNECTIONS_SCALE_ARTIFACT_BYTES,
  parseVerifyMemoryConnectionsScaleArtifactArguments,
  readMemoryConnectionsScaleArtifact,
} from '../../../../scripts/verify-memory-connections-scale-artifact.js';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  evaluateMemoryConnectionsScaleCapture,
  memoryConnectionsScaleCandidateBinding,
  MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
  MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH,
  MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS,
  MEMORY_CONNECTIONS_SCALE_SCENARIOS,
  memoryConnectionsScaleExpectedIds,
  memoryConnectionsScaleFixtureHash,
  parseMemoryConnectionsScaleArtifactV1,
  type MemoryConnectionsScaleCandidateBinding,
  type MemoryConnectionsScaleConnectionReceiptEvidenceV1,
  type MemoryConnectionsScaleCaptureV1,
  type MemoryConnectionsScaleIdentityV1,
  type MemoryConnectionsScaleObservationV1,
} from '@threadnote/threadnote/evaluation/memory-connections-scale-contract';
import {runMemoryConnectionsScaleWorkload} from '@threadnote/threadnote/evaluation/memory-connections-scale';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('memory-connections one-hop scale contract', () => {
  it('pins the release corpus, sample shape, and smoke-only overrides', () => {
    expect(memoryConnectionsScaleFixtureHash()).toBe(MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH);
    expect(
      parseMemoryConnectionsScaleTargetArguments([
        '--candidate-commit',
        '1'.repeat(40),
        '--built-artifact-sha256',
        '2'.repeat(64),
      ]),
    ).toMatchObject({developmentSmoke: false, memoryCandidates: 100_000, samples: 25, warmups: 5});
    expect(() =>
      parseMemoryConnectionsScaleTargetArguments(['--candidate-commit', '1'.repeat(40), '--memory-candidates', '1000']),
    ).toThrow('require --development-smoke');
    expect(
      parseVerifyMemoryConnectionsScaleArtifactArguments([
        '--artifact',
        'artifact.json',
        '--candidate-commit',
        '1'.repeat(40),
      ]),
    ).toMatchObject({artifactPath: 'artifact.json', candidateCommit: '1'.repeat(40)});
  });

  it('derives a passing release gate from exact correctness and provenance', () => {
    const capture = releaseCapture();
    const artifact = evaluateMemoryConnectionsScaleCapture({
      budget: MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
      capture,
      createdAt: '2026-08-31T00:00:00.000Z',
      identity: releaseIdentity(),
      candidate: releaseCandidate(),
    });
    expect(artifact.evidenceClass).toBe('release-scale');
    expect(artifact.gate).toEqual({failures: [], passed: true});
    expect(artifact.metrics).toMatchObject({
      boundedResultAccuracy: 1,
      duplicateResultCount: 0,
      incorrectConnectionCurrentnessCount: 0,
      incorrectConnectionReceiptIdentityCount: 0,
      incorrectConnectionResolutionCount: 0,
      incorrectPremiseReceiptIdentityCount: 0,
      incorrectPremiseStateCount: 0,
      noAnswerAccuracy: 1,
      precision: 1,
      projectedConnectionCoverageAccuracy: 1,
      projectedOutputCompletenessAccuracy: 1,
      projectedReceiptAccountingAccuracy: 1,
      recall: 1,
      truncationAccuracy: 1,
      unexpectedReceiptIdentityCount: 0,
      unexpectedResultCount: 0,
    });

    const relabeled = evaluateMemoryConnectionsScaleCapture({
      budget: MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
      capture: {...capture, corpus: {...capture.corpus, materializedMemoryCount: 1_000}},
      createdAt: '2026-08-31T00:00:00.000Z',
      identity: {...artifact.identity, invocationMode: 'development-smoke'},
      candidate: releaseCandidate(),
    });
    expect(relabeled.evidenceClass).toBe('development-smoke');
    expect(relabeled.gate.passed).toBe(false);
  });

  it('strictly parses and independently replays a completed artifact', () => {
    const artifact = releaseArtifact(releaseCapture());
    expect(
      parseMemoryConnectionsScaleArtifactV1(
        JSON.parse(JSON.stringify(artifact)) as unknown,
        MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
        releaseCandidate(),
      ),
    ).toEqual(artifact);

    expect(() =>
      parseMemoryConnectionsScaleArtifactV1(
        {...artifact, extra: true},
        MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
        releaseCandidate(),
      ),
    ).toThrow(/unexpected keys/u);
    expect(() =>
      parseMemoryConnectionsScaleArtifactV1(
        {...artifact, metrics: {...artifact.metrics, recall: 0}},
        MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
        releaseCandidate(),
      ),
    ).toThrow(/metrics do not match/u);
    expect(() =>
      parseMemoryConnectionsScaleArtifactV1(
        {...artifact, gate: {failures: [], passed: false}},
        MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
        releaseCandidate(),
      ),
    ).toThrow(/gate does not match/u);
    const changedObservation = mapObservations(artifact.capture, (observation, index) =>
      index === 1 ? {...observation, milliseconds: observation.milliseconds + 1} : observation,
    );
    expect(() =>
      parseMemoryConnectionsScaleArtifactV1(
        {...artifact, capture: changedObservation},
        MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
        releaseCandidate(),
      ),
    ).toThrow(/metrics do not match/u);
    expect(() =>
      parseMemoryConnectionsScaleArtifactV1(
        {...artifact, identity: {...artifact.identity, githubActions: false}},
        MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
        releaseCandidate(),
      ),
    ).toThrow(/evidence class is not derived/u);
    expect(() =>
      parseMemoryConnectionsScaleArtifactV1(
        {
          ...artifact,
          capture: {
            ...artifact.capture,
            scenarios: artifact.capture.scenarios.map((scenario, index) =>
              index === 0 ? {...scenario, samples: [{...scenario.samples[0], milliseconds: Number.NaN}]} : scenario,
            ),
          },
        },
        MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
        releaseCandidate(),
      ),
    ).toThrow(/non-negative finite number/u);
  });

  it('fails closed when release environment or candidate provenance is relabeled', () => {
    const baseline = releaseIdentity();
    const keys = [
      'architecture',
      'candidateCommit',
      'cpu',
      'dirty',
      'gitStatusObserved',
      'githubActions',
      'observedCommit',
      'operatingSystem',
      'packageManager',
      'runnerArchitecture',
      'runnerClass',
      'runnerEnvironment',
      'runnerOperatingSystem',
      'runtime',
      'sourceVersion',
    ] as const satisfies readonly (keyof MemoryConnectionsScaleIdentityV1)[];
    for (const key of keys) {
      const identity = {
        ...baseline,
        [key]:
          key === 'dirty'
            ? true
            : key === 'gitStatusObserved' || key === 'githubActions'
              ? false
              : key === 'candidateCommit' || key === 'observedCommit'
                ? '3'.repeat(40)
                : 'invalid',
      } as MemoryConnectionsScaleIdentityV1;
      expect(
        evaluateMemoryConnectionsScaleCapture({
          budget: MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
          capture: releaseCapture(),
          createdAt: '2026-08-31T00:00:00.000Z',
          identity,
          candidate: releaseCandidate(),
        }).gate.passed,
        key,
      ).toBe(false);
    }
  });

  it('does not self-attest release provenance when the candidate binding is omitted', () => {
    const artifact = releaseArtifact(releaseCapture());
    const withoutCandidate = evaluateMemoryConnectionsScaleCapture({
      budget: MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
      capture: artifact.capture,
      createdAt: artifact.createdAt,
      identity: artifact.identity,
    });
    expect(withoutCandidate.evidenceClass).toBe('development-smoke');
    expect(withoutCandidate.gate).toMatchObject({passed: false});
    expect(withoutCandidate.gate.failures).toContain(
      'release evidence requires an independently derived candidate binding',
    );
    expect(() => parseMemoryConnectionsScaleArtifactV1(artifact, MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET)).toThrow(
      /evidence class is not derived/u,
    );
  });

  effectIt.effect('bounds retained artifact reads before JSON parsing', () =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const path = `${Bun.env.TMPDIR ?? '/tmp'}/memory-connections-scale-${yield* crypto.randomUUIDv4()}.json`;
        yield* Effect.tryPromise(() =>
          Bun.write(path, new Uint8Array(MAX_MEMORY_CONNECTIONS_SCALE_ARTIFACT_BYTES + 1)),
        );
        return path;
      }),
      path =>
        Effect.gen(function* () {
          const error = yield* readMemoryConnectionsScaleArtifact(path).pipe(Effect.flip);
          expect(error.message).toMatch(/exceeds/u);
        }),
      path => Effect.tryPromise(() => Bun.file(path).delete()).pipe(Effect.ignore),
    ).pipe(provideTestLayer(BunCrypto.layer)),
  );

  it('round-trips every valid bounded lookup latency without changing its verdict', () => {
    fc.assert(
      fc.property(fc.integer({min: 1, max: 250}), milliseconds => {
        const capture = mapObservations(releaseCapture(), observation => ({...observation, milliseconds}));
        const artifact = releaseArtifact(capture);
        const parsed = parseMemoryConnectionsScaleArtifactV1(
          JSON.parse(JSON.stringify(artifact)) as unknown,
          MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
          releaseCandidate(),
        );
        expect(parsed).toEqual(artifact);
        expect(parsed.gate).toEqual({failures: [], passed: true});
      }),
      {numRuns: 50},
    );
  });

  it('binds the release candidate to the exact package version and Bun runtime', () => {
    expect(
      memoryConnectionsScaleCandidateBinding('1'.repeat(40), {
        packageManager: 'bun@1.4.2',
        version: '5.0.0',
      }),
    ).toEqual({
      commit: '1'.repeat(40),
      packageManager: 'bun@1.4.2',
      runtime: 'bun/1.4.2',
      sourceVersion: 'threadnote-5.0.0',
    });
    expect(() =>
      memoryConnectionsScaleCandidateBinding('1'.repeat(40), {packageManager: 'bun@latest', version: '5.0.0'}),
    ).toThrow(/explicit Bun version/u);
  });

  it('rejects receipt disclosure, false currentness, and excessive selector work independently', () => {
    const baseline = releaseCapture();
    const mutateCold = (
      update: (value: MemoryConnectionsScaleObservationV1) => MemoryConnectionsScaleObservationV1,
      scenarioIndex = 0,
    ): MemoryConnectionsScaleCaptureV1 => ({
      ...baseline,
      scenarios: baseline.scenarios.map((scenario, index) =>
        index === scenarioIndex ? {...scenario, cold: update(scenario.cold)} : scenario,
      ),
    });
    const failures = (capture: MemoryConnectionsScaleCaptureV1) => releaseArtifact(capture).gate.failures;

    expect(
      failures(
        mutateCold(value => ({
          ...value,
          projectedConnections: value.projectedConnections.map((receipt, index) =>
            index === 0 ? {...receipt, neighborMemoryId: 'tn_foreign_hub'} : receipt,
          ),
        })),
      ),
    ).toContain('unexpected receipt identities must be zero');
    expect(
      failures(
        mutateCold(value => ({
          ...value,
          projectedConnections: value.projectedConnections.map((receipt, index) =>
            index === 0 ? {...receipt, currentness: 'historical'} : receipt,
          ),
        })),
      ),
    ).toContain('connection currentness must match the frozen current fixture');
    expect(
      failures(
        mutateCold(value => ({
          ...value,
          canonicalRereads: MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.maximumCanonicalRereadsPerLookup + 1,
        })),
      ),
    ).toContain('canonical rereads per lookup 323; maximum 322');
    expect(
      failures(
        mutateCold(value => ({
          ...value,
          rawLinkRows: MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET.maximumRawLinkRowsPerLookup + 1,
        })),
      ),
    ).toContain('raw link rows per lookup 258; maximum 257');

    const omitProjectedReceipt = (value: MemoryConnectionsScaleObservationV1) => ({
      ...value,
      omittedConnectionReceiptCount: 1,
      projectedConnections: value.projectedConnections.slice(0, -1),
      projectedCoverageConnectionCount: value.projectedConnections.length - 1,
      projectedCoverageResultCount: value.projectedCoverageResultCount - 1,
      projectedConnectionCoverageTruncated: true,
    });
    const honestlyTruncated = mutateCold(omitProjectedReceipt, 1);
    expect(releaseArtifact(honestlyTruncated).gate.passed).toBe(true);

    const missingCoverage = failures(
      mutateCold(value => ({...omitProjectedReceipt(value), projectedConnectionCoverageTruncated: false}), 1),
    );
    expect(missingCoverage.some(failure => failure.startsWith('projected connection coverage accuracy'))).toBe(true);

    const inflatedResultCoverage = failures(
      mutateCold(value => ({...value, projectedCoverageResultCount: value.projectedCoverageResultCount + 1}), 1),
    );
    expect(inflatedResultCoverage.some(failure => failure.startsWith('projected connection coverage accuracy'))).toBe(
      true,
    );

    const missingActionableBundle = failures(withProjectedReceiptPrefix(baseline, 1, 0, true));
    expect(missingActionableBundle.some(failure => failure.startsWith('projected connection coverage accuracy'))).toBe(
      true,
    );

    const missingAccounting = failures(
      mutateCold(
        value => ({
          ...omitProjectedReceipt(value),
          omittedConnectionReceiptCount: 0,
          projectedConnectionCoverageTruncated: false,
        }),
        1,
      ),
    );
    expect(missingAccounting.some(failure => failure.startsWith('projected receipt accounting accuracy'))).toBe(true);
  });

  it.each(['missing-neighbor', 'duplicate-row', 'substitute-allowed', 'misassign-roles', 'missing-source'] as const)(
    'rejects the retained connection regression %s',
    mutation => {
      const baseline = releaseCapture();
      const sparse = baseline.scenarios[1];
      const receipts = [...sparse.cold.projectedConnections];
      const first = receipts[0];
      const second = receipts[1];
      receipts[1] =
        mutation === 'missing-neighbor'
          ? {...second, neighborMemoryId: null}
          : mutation === 'duplicate-row'
            ? first
            : mutation === 'substitute-allowed'
              ? {...second, neighborMemoryId: first.neighborMemoryId}
              : mutation === 'misassign-roles'
                ? {...second, sourceMemoryId: second.targetMemoryId, targetMemoryId: second.sourceMemoryId}
                : {...second, sourceMemoryId: null};
      const capture = withColdObservation(baseline, 1, {...sparse.cold, projectedConnections: receipts});
      const artifact = releaseArtifact(capture);
      expect(artifact.metrics.incorrectConnectionReceiptIdentityCount).toBeGreaterThan(0);
      expect(artifact.gate.failures).toContain(
        'connection receipt identities and roles must match the frozen projected prefix',
      );
    },
  );

  it.each(['missing-memory', 'wrong-ordinal', 'historical-state'] as const)(
    'rejects the retained premise regression %s',
    mutation => {
      const baseline = releaseCapture();
      const scenario = baseline.scenarios[2];
      const premise = scenario.cold.projectedPremises[0];
      const mutated =
        mutation === 'missing-memory'
          ? {...premise, memoryId: null}
          : mutation === 'wrong-ordinal'
            ? {...premise, requestedOrdinal: 1}
            : {...premise, state: 'historical'};
      const capture = withColdObservation(baseline, 2, {...scenario.cold, projectedPremises: [mutated]});
      const artifact = releaseArtifact(capture);
      expect(artifact.gate.passed).toBe(false);
      expect(artifact.gate.failures).toContain(
        mutation === 'historical-state'
          ? 'premise currentness must match the frozen current fixture'
          : 'premise receipt identity and role must match the frozen fixture',
      );
    },
  );

  it('accepts every honest retained prefix and rejects arbitrary retained receipt corruption', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 0, max: MEMORY_CONNECTIONS_SCALE_SCENARIOS.length - 1}),
        fc.nat(100),
        fc.boolean(),
        (scenarioIndex, prefixSeed, retainPremise) => {
          const baseline = releaseCapture();
          const connectionCount = baseline.scenarios[scenarioIndex].cold.projectedConnections.length;
          const retainedConnectionCount = connectionCount === 0 ? 0 : 1 + (prefixSeed % connectionCount);
          const capture = withProjectedReceiptPrefix(
            baseline,
            scenarioIndex,
            retainedConnectionCount,
            connectionCount === 0 ? retainPremise : true,
          );
          expect(releaseArtifact(capture).gate).toEqual({failures: [], passed: true});
        },
      ),
      {numRuns: 100},
    );

    fc.assert(
      fc.property(
        fc.integer({min: 0, max: 1}),
        fc.nat(100),
        fc.nat(100),
        fc.constantFrom(
          'direction',
          'distance',
          'neighborMemoryId',
          'origin',
          'relationOrdinal',
          'relationType',
          'requestedOrdinal',
          'sourceMemoryId',
          'targetMemoryId',
        ),
        (scenarioIndex, prefixSeed, rowSeed, field) => {
          const baseline = releaseCapture();
          const connectionCount = baseline.scenarios[scenarioIndex].cold.projectedConnections.length;
          const retainedConnectionCount = 1 + (prefixSeed % connectionCount);
          const rowIndex = rowSeed % retainedConnectionCount;
          const valid = withProjectedReceiptPrefix(baseline, scenarioIndex, retainedConnectionCount, true);
          const scenario = valid.scenarios[scenarioIndex];
          const connections = [...scenario.cold.projectedConnections];
          connections[rowIndex] = corruptConnectionReceipt(connections[rowIndex], field);
          const capture = withColdObservation(valid, scenarioIndex, {
            ...scenario.cold,
            projectedConnections: connections,
          });
          const artifact = releaseArtifact(capture);
          expect(artifact.metrics.incorrectConnectionReceiptIdentityCount).toBeGreaterThan(0);
          expect(artifact.gate.failures).toContain(
            'connection receipt identities and roles must match the frozen projected prefix',
          );
        },
      ),
      {numRuns: 100},
    );

    fc.assert(
      fc.property(
        fc.integer({min: 0, max: MEMORY_CONNECTIONS_SCALE_SCENARIOS.length - 1}),
        fc.constantFrom('memoryId', 'requestedOrdinal', 'state'),
        (scenarioIndex, field) => {
          const baseline = releaseCapture();
          const scenario = baseline.scenarios[scenarioIndex];
          const premise = scenario.cold.projectedPremises[0];
          const mutated =
            field === 'memoryId'
              ? {...premise, memoryId: `${premise.memoryId}-corrupt`}
              : field === 'requestedOrdinal'
                ? {...premise, requestedOrdinal: premise.requestedOrdinal + 1}
                : {...premise, state: 'historical'};
          const capture = withColdObservation(baseline, scenarioIndex, {
            ...scenario.cold,
            projectedPremises: [mutated],
          });
          const artifact = releaseArtifact(capture);
          expect(artifact.gate.passed).toBe(false);
          expect(artifact.gate.failures).toContain(
            field === 'state'
              ? 'premise currentness must match the frozen current fixture'
              : 'premise receipt identity and role must match the frozen fixture',
          );
        },
      ),
      {numRuns: 100},
    );
  });

  effectIt.effect('executes a production-indexed development smoke', () =>
    Effect.gen(function* () {
      const capture = yield* runMemoryConnectionsScaleWorkload({memoryCandidates: 64, samples: 1, warmups: 0});
      expect(capture.corpus).toMatchObject({indexedMemoryCount: 64, materializedMemoryCount: 64});
      for (const scenario of capture.scenarios) {
        expect(scenario.cold.returnedMemoryIds).toEqual(scenario.expectedMemoryIds);
        expect(scenario.cold.retrievalTruncated).toBe(scenario.expectedTruncated);
        expect(scenario.cold.projectedConnectionCoverageTruncated).toBe(scenario.expectedTruncated);
        expect(scenario.cold.projectedOutputTruncated).toBe(false);
        expect(scenario.cold.projectedCoverageConnectionCount).toBe(scenario.cold.projectedConnections.length);
        expect(scenario.cold.projectedCoveragePremiseCount).toBe(scenario.cold.projectedPremises.length);
        expect(scenario.cold.projectedCoverageResultCount).toBe(projectedReceiptBackedResultCount(scenario.cold));
        if (scenario.cold.returnedMemoryIds.length > 0) {
          expect(hasActionableProjectedBundle(scenario.cold)).toBe(true);
        }
        expect(scenario.cold.projectedConnections.length + scenario.cold.omittedConnectionReceiptCount).toBe(
          scenario.expectedMemoryIds.length,
        );
        expect(scenario.cold.projectedPremises.length + scenario.cold.omittedPremiseReceiptCount).toBe(1);
        expect(scenario.cold.estimatedTokens).toBeLessThanOrEqual(1_500);
      }
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );
});

function releaseCapture(): MemoryConnectionsScaleCaptureV1 {
  return {
    corpus: {
      authorizedHubMemoryCount: 99_994,
      corpusBytes: 10_000_000,
      indexedMemoryCount: 100_000,
      materializedMemoryCount: 100_000,
    },
    fixtureHash: MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH,
    resources: {
      addedPeakRssBytes: 100_000_000,
      baselineRssBytes: 100_000_000,
      indexBuildMilliseconds: 1_000,
      materializationMilliseconds: 1_000,
      peakRssBytes: 200_000_000,
      recallDatabaseBytes: 10_000_000,
      recallStorageBytes: 10_000_000,
    },
    scenarios: MEMORY_CONNECTIONS_SCALE_SCENARIOS.map(id => {
      const expectedMemoryIds = memoryConnectionsScaleExpectedIds(id);
      const expectedTruncated = id === 'incoming-hub';
      const premiseMemoryId =
        id === 'incoming-hub' ? 'tn_scale_hub' : id === 'sparse-incoming' ? 'tn_scale_sparse' : 'tn_scale_empty';
      const value = observation(expectedMemoryIds, premiseMemoryId, expectedTruncated);
      return {
        cold: value,
        expectedMemoryIds,
        expectedTruncated,
        id,
        samples: Array.from({length: 25}, () => value),
        warmups: Array.from({length: 5}, () => value),
      };
    }),
  };
}

function observation(
  returnedMemoryIds: readonly string[],
  premiseMemoryId: string,
  truncated: boolean,
): MemoryConnectionsScaleObservationV1 {
  return {
    canonicalRereads: 20,
    estimatedTokens: 500,
    milliseconds: 10,
    omittedConnectionReceiptCount: 0,
    omittedPremiseReceiptCount: 0,
    projectedConnections: returnedMemoryIds.map(memoryId => ({
      currentness: 'current',
      direction: 'incoming',
      distance: 1,
      neighborMemoryId: memoryId,
      origin: 'relation',
      relationOrdinal: 0,
      relationType: 'related_to',
      requestedOrdinal: 0,
      resolution: 'resolved',
      sourceMemoryId: memoryId,
      targetMemoryId: premiseMemoryId,
    })),
    projectedCoverageConnectionCount: returnedMemoryIds.length,
    projectedCoveragePremiseCount: 1,
    projectedCoverageResultCount: returnedMemoryIds.length,
    projectedConnectionCoverageTruncated: truncated,
    projectedOutputTruncated: false,
    projectedPremises: [{memoryId: premiseMemoryId, requestedOrdinal: 0, state: 'current'}],
    rawLinkRows: 10,
    retrievalTruncated: truncated,
    returnedMemoryIds,
  };
}

function releaseArtifact(capture: MemoryConnectionsScaleCaptureV1) {
  return evaluateMemoryConnectionsScaleCapture({
    budget: MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET,
    capture,
    createdAt: '2026-08-31T00:00:00.000Z',
    identity: releaseIdentity(),
    candidate: releaseCandidate(),
  });
}

function releaseCandidate(): MemoryConnectionsScaleCandidateBinding {
  return {
    commit: '1'.repeat(40),
    packageManager: 'bun@1.4.2',
    runtime: 'bun/1.4.2',
    sourceVersion: 'threadnote-5.0.0',
  };
}

function releaseIdentity(): MemoryConnectionsScaleIdentityV1 {
  return {
    architecture: 'arm64',
    builtArtifactSha256: '2'.repeat(64),
    candidateCommit: '1'.repeat(40),
    cpu: 'Apple M1 Max',
    dirty: false,
    githubActions: true,
    gitStatusObserved: true,
    invocationMode: 'release-scale',
    observedCommit: '1'.repeat(40),
    operatingSystem: 'macOS 15.6.1',
    packageManager: 'bun@1.4.2',
    runnerArchitecture: 'ARM64',
    runnerClass: MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS,
    runnerEnvironment: 'github-hosted',
    runnerOperatingSystem: 'macOS',
    runtime: 'bun/1.4.2',
    sourceVersion: 'threadnote-5.0.0',
  };
}

function mapObservations(
  capture: MemoryConnectionsScaleCaptureV1,
  update: (observation: MemoryConnectionsScaleObservationV1, index: number) => MemoryConnectionsScaleObservationV1,
): MemoryConnectionsScaleCaptureV1 {
  let index = 0;
  const map = (observation: MemoryConnectionsScaleObservationV1) => update(observation, index++);
  return {
    ...capture,
    scenarios: capture.scenarios.map(scenario => ({
      ...scenario,
      cold: map(scenario.cold),
      samples: scenario.samples.map(map),
      warmups: scenario.warmups.map(map),
    })),
  };
}

function withColdObservation(
  capture: MemoryConnectionsScaleCaptureV1,
  scenarioIndex: number,
  cold: MemoryConnectionsScaleObservationV1,
): MemoryConnectionsScaleCaptureV1 {
  return {
    ...capture,
    scenarios: capture.scenarios.map((scenario, index) => (index === scenarioIndex ? {...scenario, cold} : scenario)),
  };
}

function withProjectedReceiptPrefix(
  capture: MemoryConnectionsScaleCaptureV1,
  scenarioIndex: number,
  retainedConnectionCount: number,
  retainPremise: boolean,
): MemoryConnectionsScaleCaptureV1 {
  const scenario = capture.scenarios[scenarioIndex];
  const connectionCount = scenario.cold.projectedConnections.length;
  const projectedConnections = scenario.cold.projectedConnections.slice(0, retainedConnectionCount);
  const projectedPremises = retainPremise ? scenario.cold.projectedPremises : [];
  const omittedConnectionReceiptCount = connectionCount - projectedConnections.length;
  const omittedPremiseReceiptCount = retainPremise ? 0 : 1;
  return withColdObservation(capture, scenarioIndex, {
    ...scenario.cold,
    omittedConnectionReceiptCount,
    omittedPremiseReceiptCount,
    projectedConnections,
    projectedCoverageConnectionCount: projectedConnections.length,
    projectedCoveragePremiseCount: projectedPremises.length,
    projectedCoverageResultCount: projectedReceiptBackedResultCount({
      ...scenario.cold,
      projectedConnections,
    }),
    projectedConnectionCoverageTruncated:
      scenario.cold.retrievalTruncated || omittedConnectionReceiptCount > 0 || omittedPremiseReceiptCount > 0,
    projectedPremises,
  });
}

function projectedReceiptBackedResultCount(value: MemoryConnectionsScaleObservationV1): number {
  const returnedMemoryIds = new Set(value.returnedMemoryIds);
  return new Set(
    value.projectedConnections.flatMap(connection =>
      connection.neighborMemoryId !== null && returnedMemoryIds.has(connection.neighborMemoryId)
        ? [connection.neighborMemoryId]
        : [],
    ),
  ).size;
}

function hasActionableProjectedBundle(value: MemoryConnectionsScaleObservationV1): boolean {
  const returnedMemoryIds = new Set(value.returnedMemoryIds);
  return value.projectedConnections.some(
    connection =>
      connection.resolution === 'resolved' &&
      (connection.currentness === 'current' || connection.currentness === 'historical') &&
      connection.neighborMemoryId !== null &&
      returnedMemoryIds.has(connection.neighborMemoryId) &&
      value.projectedPremises.some(
        premise =>
          premise.requestedOrdinal === connection.requestedOrdinal &&
          (premise.state === 'current' || premise.state === 'historical'),
      ),
  );
}

function corruptConnectionReceipt(
  receipt: MemoryConnectionsScaleConnectionReceiptEvidenceV1,
  field:
    | 'direction'
    | 'distance'
    | 'neighborMemoryId'
    | 'origin'
    | 'relationOrdinal'
    | 'relationType'
    | 'requestedOrdinal'
    | 'sourceMemoryId'
    | 'targetMemoryId',
): MemoryConnectionsScaleConnectionReceiptEvidenceV1 {
  switch (field) {
    case 'direction':
      return {...receipt, direction: receipt.direction === 'incoming' ? 'outgoing' : 'incoming'};
    case 'distance':
      return {...receipt, distance: receipt.distance + 1};
    case 'neighborMemoryId':
      return {...receipt, neighborMemoryId: `${receipt.neighborMemoryId}-corrupt`};
    case 'origin':
      return {...receipt, origin: receipt.origin === 'relation' ? 'references' : 'relation'};
    case 'relationOrdinal':
      return {...receipt, relationOrdinal: receipt.relationOrdinal + 1};
    case 'relationType':
      return {...receipt, relationType: receipt.relationType === 'related_to' ? 'depends_on' : 'related_to'};
    case 'requestedOrdinal':
      return {...receipt, requestedOrdinal: receipt.requestedOrdinal + 1};
    case 'sourceMemoryId':
      return {...receipt, sourceMemoryId: `${receipt.sourceMemoryId}-corrupt`};
    case 'targetMemoryId':
      return {...receipt, targetMemoryId: `${receipt.targetMemoryId}-corrupt`};
  }
}

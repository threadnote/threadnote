import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {join, mkdtemp, readFile, rm, writeFile} from '../helpers/effect-filesystem.js';
import {
  codeGraphHeavyTailRatchetArtifact,
  assertHeavyTailReleaseRatchet,
  createCodeGraphHeavyTailRatchet,
  heavyTailExtractionUtilization,
  parseCodeGraphHeavyTailBenchmarkArguments,
  parseCodeGraphHeavyTailBenchmarkArtifact,
  parseCodeGraphHeavyTailReleaseEvidence,
  parseHeavyTailChildRun,
  type CodeGraphHeavyTailBenchmarkArtifact,
  type HeavyTailChildRun,
  type HeavyTailGovernanceEvidence,
} from '../../../../scripts/benchmark-code-graph-heavy-tail.js';
import {
  enforceCodeGraphBenchmarkRatchet,
  validateCodeGraphBenchmarkRatchet,
} from '../../../../scripts/benchmark-code-graph.js';
import {
  CODE_GRAPH_HEAVY_TAIL_PROFILE,
  CODE_GRAPH_HEAVY_TAIL_JSON_DUPLICATES,
  CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE,
  codeGraphHeavyTailEligibleFiles,
  codeGraphHeavyTailGeneratedTypeScript,
  codeGraphHeavyTailJsonFixtures,
  codeGraphHeavyTailLowSignalJson,
  codeGraphHeavyTailPathologicalTypeScript,
  codeGraphHeavyTailRepositoryFiles,
  codeGraphHeavyTailTextlessSvg,
  parseCodeGraphHeavyTailProfile,
} from '../../../../scripts/code-graph-heavy-tail-fixture.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const RELEASE_CAPTURE_START = Date.parse('2026-09-18T12:00:00.000Z');
const RELEASE_OBSERVED_AT = '2026-09-18T12:00:01.000Z';
const RELEASE_RUNNER_CLASS = 'apple-m1-max-64g-internal';
const HEAVY_TAIL_GRAPH_DIGEST = '862c4f7e69cda68d59679d6b052cccfca01c35a2e13086333c631f2286b02c93';

describe('code graph large-monorepo heavy-tail benchmark', () => {
  it('reports exactly one active request for non-overlapping fractional intervals without mutating them', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({min: 1, max: 99_999}), {minLength: 2, maxLength: 64}), durations => {
        const intervals = EffectArray.map(durations, (duration, index) => ({
          end: index * 1_000 + 0.123456 + duration / 1_000,
          start: index * 1_000 + 0.123456,
        })).reverse();
        const before = structuredClone(intervals);
        const utilization = heavyTailExtractionUtilization(intervals, 1);
        expect(utilization.averageConcurrency).toBe(1);
        expect(utilization.requestMilliseconds).toBe(utilization.activeWallMilliseconds);
        expect(intervals).toEqual(before);
      }),
      {numRuns: 64},
    );
  });

  it('measures overlapping requests over their union and preserves the empty observation', () => {
    expect(
      heavyTailExtractionUtilization(
        [
          {start: 0, end: 4},
          {start: 2, end: 6},
        ],
        2,
      ),
    ).toEqual({
      activeWallMilliseconds: 6,
      averageConcurrency: 8 / 6,
      peakConcurrency: 2,
      requestMilliseconds: 8,
    });
    expect(heavyTailExtractionUtilization([], 0)).toEqual({
      activeWallMilliseconds: 0,
      averageConcurrency: 0,
      peakConcurrency: 0,
      requestMilliseconds: 0,
    });
  });

  it('uses the centralized process maxRSS byte normalizer', async () => {
    const source = await readFile('scripts/benchmark-code-graph-heavy-tail.ts', 'utf8');

    expect(source).toContain('processResourceUsageMaxRssBytes(maxRss, process.platform, runtime)');
    expect(source).not.toContain("return 'bun' in process.versions ? maxRss : maxRss * 1_024");
  });

  it('keeps the checked profile synchronized with the reviewed workload shape', async () => {
    const baseline = decodeReviewedProfileBaseline(
      await Bun.file('apps/threadnote/test/evaluation/baselines/code-graph-v1/heavy-tail-profile.json').json(),
    );

    expect(baseline.version).toBe(1);
    expect(parseCodeGraphHeavyTailProfile(baseline.profile)).toEqual(CODE_GRAPH_HEAVY_TAIL_PROFILE);
    expect(baseline.reviewedShape.eligibleFiles).toBe(codeGraphHeavyTailEligibleFiles(CODE_GRAPH_HEAVY_TAIL_PROFILE));
    expect(baseline.reviewedShape.repositoryFiles).toBe(
      codeGraphHeavyTailRepositoryFiles(CODE_GRAPH_HEAVY_TAIL_PROFILE),
    );
    expect(baseline.reviewedShape.latencyBudget).toContain('same-run comparison');
    expect(CODE_GRAPH_HEAVY_TAIL_PROFILE.lowSignalJsonBytes).toBe(25 * 1_048_576);
    expect(CODE_GRAPH_HEAVY_TAIL_PROFILE.textlessSvgFiles).toBeGreaterThanOrEqual(1_000);
    const jsonFixtures = codeGraphHeavyTailJsonFixtures(CODE_GRAPH_HEAVY_TAIL_PROFILE);
    expect([...new Set(EffectArray.map(jsonFixtures, fixture => fixture.bytes))]).toEqual([
      64 * 1_024,
      Math.round(0.8 * 1_048_576),
      Math.round(5.7 * 1_048_576),
      25 * 1_048_576,
    ]);
    expect(jsonFixtures).toHaveLength(4 * CODE_GRAPH_HEAVY_TAIL_JSON_DUPLICATES);
  });

  it('retains the historical pre-admission observation without turning local latency into a portable gate', async () => {
    const baseline = decodeDevelopmentBaseline(
      await Bun.file('apps/threadnote/test/evaluation/baselines/code-graph-v1/heavy-tail-development.json').json(),
    );

    expect(parseCodeGraphHeavyTailProfile(baseline.profile)).toEqual(CODE_GRAPH_HEAVY_TAIL_PROFILE);
    expect(EffectRecord.values(baseline.assertions)).toEqual(expect.arrayContaining([true]));
    expect(EffectRecord.values(baseline.assertions)).not.toContain(false);
    expect(baseline.result.graphDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(baseline.result.lowSignalJsonFactsBytes).toBeLessThanOrEqual(16 * 1_024);
    expect(baseline.result.cacheFactsBytes).toBeLessThan(CODE_GRAPH_HEAVY_TAIL_PROFILE.lowSignalJsonBytes);
    expect(baseline.runs.resumed.reusedFiles).toBe(baseline.runs.interrupted.cacheFiles);
    expect(baseline.interpretation.latency).toContain('one local observation');
  });

  it('generates exact, valid, low-signal JSON without checking a large blob into git', () => {
    const json = codeGraphHeavyTailLowSignalJson(4_096);

    expect(new TextEncoder().encode(json)).toHaveLength(4_096);
    expect(JSON.parse(json)).toMatchObject({frames: [], kind: 'test-snapshot'});
  });

  it('keeps duplicate JSON fixture paths and repository accounting deterministic', () => {
    fc.assert(
      fc.property(fc.integer({max: 2 * 1_048_576, min: 2_048}), lowSignalJsonBytes => {
        const profile = {...CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE, lowSignalJsonBytes};
        const fixtures = codeGraphHeavyTailJsonFixtures(profile);
        expect(fixtures).toHaveLength(4 * CODE_GRAPH_HEAVY_TAIL_JSON_DUPLICATES);
        expect(new Set(EffectArray.map(fixtures, fixture => fixture.path))).toHaveLength(fixtures.length);
        for (const bytes of new Set(EffectArray.map(fixtures, fixture => fixture.bytes))) {
          expect(EffectArray.filter(fixtures, fixture => fixture.bytes === bytes)).toHaveLength(
            CODE_GRAPH_HEAVY_TAIL_JSON_DUPLICATES,
          );
        }
        expect(codeGraphHeavyTailRepositoryFiles(profile)).toBe(
          codeGraphHeavyTailEligibleFiles(profile) + fixtures.length + profile.textlessSvgFiles,
        );
      }),
      {numRuns: 64},
    );
  });

  it('keeps generated heavy-tail source sizes and tail declarations valid across bounded shapes', () => {
    fc.assert(
      fc.property(
        fc.integer({max: 64 * 1_024, min: 256}),
        fc.integer({max: 64 * 1_024, min: 512}),
        fc.integer({max: 128, min: 1}),
        (jsonBytes, typescriptBytes, calls) => {
          const json = codeGraphHeavyTailLowSignalJson(jsonBytes);
          const generated = codeGraphHeavyTailGeneratedTypeScript(typescriptBytes);
          const callHeavy = codeGraphHeavyTailPathologicalTypeScript(1, calls);

          expect(new TextEncoder().encode(json)).toHaveLength(jsonBytes);
          expect(() => JSON.parse(json)).not.toThrow();
          expect(new TextEncoder().encode(generated)).toHaveLength(typescriptBytes);
          expect(generated).toContain('interface GeneratedSurfaceTail');
          expect(
            Effect.pipe(
              callHeavy,
              EffectString.match(/value \+= dependency\(/g),
              Effect.Option.getOrElse(() => null),
            ),
          ).toHaveLength(calls);
          expect(callHeavy).toContain('interface PreservedTail001');
        },
      ),
      {numRuns: 64},
    );
  });

  it('generates call-heavy and large-surface TypeScript with declarations after expensive content', () => {
    const callHeavy = codeGraphHeavyTailPathologicalTypeScript(7, 12);
    const generated = codeGraphHeavyTailGeneratedTypeScript(8_192);

    expect(
      Effect.pipe(
        callHeavy,
        EffectString.match(/value \+= dependency\(/g),
        Effect.Option.getOrElse(() => null),
      ),
    ).toHaveLength(12);
    expect(callHeavy).toContain('import {dependency}');
    expect(callHeavy).toContain('export {dependency as forwarded007}');
    expect(callHeavy).toContain('interface PreservedTail007');
    expect(new TextEncoder().encode(generated)).toHaveLength(8_192);
    expect(generated).toContain('interface GeneratedSurfaceTail');
  });

  it('generates textless SVG metadata fixtures', () => {
    const svg = codeGraphHeavyTailTextlessSvg();

    expect(svg).toContain('<path');
    expect(svg).not.toMatch(/<text(?:\s|>)/i);
  });

  it('rejects incomplete interruption and aggregate artifacts', () => {
    expect(() =>
      parseHeavyTailChildRun({
        cache: {factsBytes: 1, files: 1, lowSignalJsonFactsBytes: 0},
        cpuMilliseconds: 1,
        durationMilliseconds: 1,
        extraction: {activeWallMilliseconds: 1, averageConcurrency: 1, peakConcurrency: 1, requestMilliseconds: 1},
        languages: {},
        peakRssBytes: 1,
        readingMilliseconds: 1,
        slowFiles: [],
        state: 'interrupted',
        version: 2,
        workerCount: 1,
      }),
    ).toThrow(/interruption point/i);
    expect(() =>
      parseHeavyTailChildRun({
        cache: {factsBytes: 1, files: 1, lowSignalJsonFactsBytes: 0},
        cpuMilliseconds: 1,
        durationMilliseconds: 1,
        extraction: {activeWallMilliseconds: 1, averageConcurrency: 1, peakConcurrency: 1, requestMilliseconds: 1},
        interruptedAfterPersistedFiles: 2,
        languages: {},
        peakRssBytes: 1,
        readingMilliseconds: 1,
        slowFiles: [],
        state: 'interrupted',
        version: 2,
        workerCount: 1,
      }),
    ).toThrow(/cache accounting/i);
    expect(() =>
      parseCodeGraphHeavyTailBenchmarkArtifact({
        createdAt: new Date(0).toISOString(),
        profile: CODE_GRAPH_HEAVY_TAIL_PROFILE,
        runs: {},
        suite: 'code-graph-large-monorepo-heavy-tail-v2',
        version: 2,
      }),
    ).toThrow(/child artifact/i);
  });

  it('requires retained governed evidence before enforcing a ratchet', () => {
    expect(() => parseCodeGraphHeavyTailBenchmarkArguments(['--governed'])).toThrow(/requires --output/u);
    expect(() =>
      parseCodeGraphHeavyTailBenchmarkArguments(['--governed', '--minimum-free-gib', '119', '--output', '/tmp/a']),
    ).toThrow(/at least 120/u);
    expect(() => parseCodeGraphHeavyTailBenchmarkArguments(['--ratchet', '/tmp/r', '--output', '/tmp/a'])).toThrow(
      /requires --governed/u,
    );
    expect(() => parseCodeGraphHeavyTailBenchmarkArguments(['--child', '--governed'])).toThrow(/parent-only/iu);
    expect(() =>
      parseCodeGraphHeavyTailBenchmarkArguments([
        '--governed',
        '--candidate-commit',
        Effect.pipe('a', EffectString.repeat(40)),
        '--output',
        '/tmp/a',
      ]),
    ).toThrow(/candidate-commit requires --ratchet/iu);
    expect(
      parseCodeGraphHeavyTailBenchmarkArguments([
        '--governed',
        '--output',
        '/tmp/evidence.json',
        '--ratchet',
        '/tmp/ratchet.json',
      ]),
    ).toMatchObject({governed: true, minimumFreeGiB: 120, ratchetPath: '/tmp/ratchet.json'});
  });

  it('independently ratchets every emitted scheduler, resource, language, resume, and graph measurement', () => {
    const artifacts = [heavyTailArtifact(0), heavyTailArtifact(10), heavyTailArtifact(20)];
    const ratchet = createCodeGraphHeavyTailRatchet(artifacts);
    const names = EffectArray.map(artifacts[0].ratchetArtifact.measurements, measurement => measurement.name).sort();

    expect(EffectRecord.keys(ratchet.measurements).sort()).toEqual(names);
    expect(names).toHaveLength(254);
    expect(names).toEqual(expect.arrayContaining(['parallel-duration', 'parallel-peak-rss']));
    expect(names).toEqual(
      expect.arrayContaining([
        'parallel-extraction-average-concurrency',
        'parallel-extraction-request',
        'resumed-reused-files',
        'resume-retained-cache-coverage',
      ]),
    );
    expect(() => enforceCodeGraphBenchmarkRatchet(artifacts[0].ratchetArtifact, ratchet)).not.toThrow();
    expect(ratchet.measurements['interrupted-interrupted-after-persisted-files']).toMatchObject({
      maximum: 268,
      minimum: 256,
    });
    expect(ratchet.measurements['interrupted-extraction-average-concurrency']).toMatchObject({maximum: 4});
    expect(ratchet.measurements['resumed-extraction-average-concurrency']).toMatchObject({maximum: 2});
    expect(ratchet.measurements['resumed-reused-files']).toMatchObject({maximum: 268, minimum: 256});
    expect(ratchet.measurements['single-reused-files']).toMatchObject({maximum: 0, minimum: 0});
    expect(ratchet.measurements['resume-retained-cache-coverage']).toMatchObject({maximum: 100, minimum: 100});
    const reducedInterruptionOvershoot = {
      ...artifacts[0].ratchetArtifact,
      measurements: EffectArray.map(artifacts[0].ratchetArtifact.measurements, measurement =>
        ['interrupted-cache-files', 'interrupted-interrupted-after-persisted-files', 'resumed-reused-files'].includes(
          measurement.name,
        )
          ? {...measurement, maximum: 256, mean: 256, minimum: 256, p50: 256, p95: 256, p99: 256}
          : measurement,
      ),
    };
    expect(() => enforceCodeGraphBenchmarkRatchet(reducedInterruptionOvershoot, ratchet)).not.toThrow();

    const toleratedConcurrencyEpsilon = createCodeGraphHeavyTailRatchet(
      EffectArray.map([0, 10, 20], offset =>
        heavyTailArtifactWithMeasurement(
          4.000_000_5,
          'interrupted-extraction-average-concurrency',
          2.000_000_5,
          'resumed-extraction-average-concurrency',
          offset,
        ),
      ),
    );
    expect(toleratedConcurrencyEpsilon.measurements['interrupted-extraction-average-concurrency']).toMatchObject({
      maximum: 4,
    });
    expect(toleratedConcurrencyEpsilon.measurements['resumed-extraction-average-concurrency']).toMatchObject({
      maximum: 2,
    });

    const durationLimit = ratchet.measurements['parallel-duration'].p95Maximum!;
    const regressed = {
      ...artifacts[0].ratchetArtifact,
      measurements: EffectArray.map(artifacts[0].ratchetArtifact.measurements, measurement =>
        measurement.name === 'parallel-duration'
          ? {
              ...measurement,
              maximum: durationLimit + 1,
              mean: durationLimit + 1,
              minimum: durationLimit + 1,
              p50: durationLimit + 1,
              p95: durationLimit + 1,
              p99: durationLimit + 1,
            }
          : measurement,
      ),
    };
    expect(() => enforceCodeGraphBenchmarkRatchet(regressed, ratchet)).toThrow(/parallel-duration/u);
  });

  it('requires exactly three governed performance runs and rejects correctness-only evidence', () => {
    const artifacts = [heavyTailArtifact(0), heavyTailArtifact(10), heavyTailArtifact(20)];
    expect(() => createCodeGraphHeavyTailRatchet([...artifacts, heavyTailArtifact(30)])).toThrow(/exactly three/u);
    const correctnessOnly = {
      ...artifacts[0],
      evidenceClass: 'correctness-only' as const,
      ratchetArtifact: {
        ...artifacts[0].ratchetArtifact,
        metadata: {...artifacts[0].ratchetArtifact.metadata, evidenceClass: 'correctness-only'},
      },
    };
    expect(() => createCodeGraphHeavyTailRatchet([correctnessOnly, artifacts[1], artifacts[2]])).toThrow(
      /governed-performance/u,
    );
    const weakened = EffectArray.map(artifacts, artifact => ({
      ...artifact,
      ratchetArtifact: {
        ...artifact.ratchetArtifact,
        metadata: {...artifact.ratchetArtifact.metadata, thresholdPolicy: 'relative-50-percent'},
      },
    }));
    expect(() => createCodeGraphHeavyTailRatchet(weakened)).toThrow(/governed-performance|threshold/u);
  });

  it('matches release admission against an independent model across generated evidence records', () => {
    fc.assert(
      fc.property(fc.tuple(validReleaseAdmissionRecordArbitrary, rejectedReleaseAdmissionRecordArbitrary), records => {
        for (const record of records) {
          const {artifacts, options} = releaseAdmissionCase(record);
          const expected = expectedReleaseAdmission(record);
          let admitted = true;
          try {
            assertHeavyTailReleaseRatchet(artifacts, options);
          } catch {
            admitted = false;
          }
          expect(admitted).toBe(expected);
        }
      }),
      {numRuns: 64},
    );
  });

  it('accepts freshness boundaries and rejects stale, future, and over-span evidence', () => {
    const artifacts = [heavyTailArtifact(0), heavyTailArtifact(10), heavyTailArtifact(20)];
    const options = releaseOptions(artifacts);
    const admitted = assertHeavyTailReleaseRatchet(artifacts, options);
    expect(admitted.metadata).toMatchObject({
      releaseFutureSkewMilliseconds: 1_000,
      releaseMaximumEvidenceAgeMilliseconds: 60_000,
      releaseMaximumRunSpanMilliseconds: 20,
      releaseNotBefore: new Date(RELEASE_CAPTURE_START).toISOString(),
      releaseObservedAt: RELEASE_OBSERVED_AT,
    });
    expect(() =>
      assertHeavyTailReleaseRatchet(artifacts, {
        ...options,
        freshness: {...options.freshness, observedAt: new Date(RELEASE_CAPTURE_START + 60_000).toISOString()},
      }),
    ).not.toThrow();
    expect(() =>
      assertHeavyTailReleaseRatchet(artifacts, {
        ...options,
        freshness: {
          ...options.freshness,
          notBefore: new Date(RELEASE_CAPTURE_START - 1_000).toISOString(),
          observedAt: new Date(RELEASE_CAPTURE_START - 980).toISOString(),
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertHeavyTailReleaseRatchet(artifacts, {
        ...options,
        freshness: {...options.freshness, notBefore: new Date(RELEASE_CAPTURE_START + 1).toISOString()},
      }),
    ).toThrow(/freshness window/iu);
    expect(() =>
      assertHeavyTailReleaseRatchet(artifacts, {
        ...options,
        freshness: {
          ...options.freshness,
          notBefore: new Date(RELEASE_CAPTURE_START - 2_000).toISOString(),
          observedAt: new Date(RELEASE_CAPTURE_START - 1_001).toISOString(),
        },
      }),
    ).toThrow(/future skew/iu);
    expect(() =>
      assertHeavyTailReleaseRatchet(artifacts, {
        ...options,
        freshness: {...options.freshness, maximumSpanMilliseconds: 19},
      }),
    ).toThrow(/span/iu);
  });

  it('rejects fallback runner bindings and source evidence that exceeds the checked ratchet', () => {
    const artifacts = [heavyTailArtifact(0), heavyTailArtifact(10), heavyTailArtifact(20)];
    const options = releaseOptions(artifacts);
    expect(() => assertHeavyTailReleaseRatchet(artifacts, options)).not.toThrow();
    expect(() => assertHeavyTailReleaseRatchet(artifacts, {...options, runnerClass: 'local-unclassified'})).toThrow(
      /explicit runner class/iu,
    );
    expect(() => assertHeavyTailReleaseRatchet(artifacts, {...options, runnerIdentity: 'local'})).toThrow(
      /explicit runner identity/iu,
    );
    const slower = EffectArray.map(artifacts, (artifact, index) =>
      heavyTailArtifactWithMeasurement(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(
            artifact.ratchetArtifact.measurements,
            measurement => measurement.name === 'parallel-duration',
          ),
        )!.p50 + 10_000,
        'parallel-duration',
        0,
        'parallel-language-mixed-request',
        index * 10,
      ),
    );
    expect(() => assertHeavyTailReleaseRatchet(slower, options)).toThrow(/checked ratchet|parallel-duration/iu);
  });

  it('preserves the checked limit when accepted sub-millisecond samples derive excess noise headroom', () => {
    const measurement = 'eight-workers-language-npm-manifest-parse';
    const artifacts = EffectArray.map([0.817_125, 1.493_625, 0.876_333], (value, index) =>
      heavyTailArtifactWithMeasurement(value, measurement, 0, 'parallel-language-mixed-request', index * 10),
    );
    const options = releaseOptions(artifacts);
    const checkedRatchet = checkedRatchetWithLimits(options.checkedRatchet, [{name: measurement, p95Maximum: 6}]);

    expect(createCodeGraphHeavyTailRatchet(artifacts).measurements[measurement].p95Maximum).toBe(7);
    for (const artifact of artifacts) {
      expect(() => enforceCodeGraphBenchmarkRatchet(artifact.ratchetArtifact, checkedRatchet)).not.toThrow();
    }

    const admitted = assertHeavyTailReleaseRatchet(artifacts, {...options, checkedRatchet});
    expect(admitted.measurements[measurement].p95Maximum).toBe(6);
  });

  it('never relaxes checked upper or lower limits while retaining stricter observed limits', () => {
    const upperMeasurement = 'eight-workers-language-npm-manifest-parse';
    const lowerMeasurement = 'parallel-extraction-average-concurrency';
    fc.assert(
      fc.property(
        fc.array(fc.double({max: 1.9, min: 0, noDefaultInfinity: true, noNaN: true}), {
          maxLength: 3,
          minLength: 3,
        }),
        fc.array(fc.double({max: 4, min: 1, noDefaultInfinity: true, noNaN: true}), {
          maxLength: 3,
          minLength: 3,
        }),
        (upperValues, lowerValues) => {
          const artifacts = EffectArray.map(upperValues, (value, index) =>
            heavyTailArtifactWithMeasurement(value, upperMeasurement, lowerValues[index], lowerMeasurement, index * 10),
          );
          const generated = createCodeGraphHeavyTailRatchet(artifacts);
          const options = releaseOptions(artifacts);
          const checkedUpper = Math.max(...upperValues);
          const checkedLower = Math.min(...lowerValues);
          const checkedRatchet = checkedRatchetWithLimits(options.checkedRatchet, [
            {name: upperMeasurement, p95Maximum: checkedUpper},
            {name: lowerMeasurement, minimum: checkedLower},
          ]);

          const admitted = assertHeavyTailReleaseRatchet(artifacts, {...options, checkedRatchet});
          const admittedUpper = admitted.measurements[upperMeasurement].p95Maximum!;
          const admittedLower = admitted.measurements[lowerMeasurement].minimum!;

          expect(admittedUpper).toBeLessThanOrEqual(checkedUpper);
          expect(admittedUpper).toBeLessThanOrEqual(generated.measurements[upperMeasurement].p95Maximum!);
          expect(admittedLower).toBeGreaterThanOrEqual(checkedLower);
          expect(admittedLower).toBeGreaterThanOrEqual(generated.measurements[lowerMeasurement].minimum!);
        },
      ),
      {numRuns: 32},
    );
  });

  it('strictly parses release evidence and rejects outer/inner provenance mutations', () => {
    const artifact = heavyTailArtifact(0);
    expect(parseCodeGraphHeavyTailReleaseEvidence(artifact)).toEqual(artifact);
    for (const mutate of [
      (value: CodeGraphHeavyTailBenchmarkArtifact) => ({
        ...value,
        createdAt: new Date(RELEASE_CAPTURE_START + 1).toISOString(),
      }),
      (value: CodeGraphHeavyTailBenchmarkArtifact) => ({
        ...value,
        environment: {...value.environment, runnerIdentity: 'mismatched-runner'},
      }),
      (value: CodeGraphHeavyTailBenchmarkArtifact) => ({
        ...value,
        environment: {...value.environment, storage: undefined},
      }),
      (value: CodeGraphHeavyTailBenchmarkArtifact) => ({
        ...value,
        environment: {
          ...value.environment,
          provenance: {
            ...value.environment.provenance!,
            executableSha256: undefined,
          },
        },
      }),
      (value: CodeGraphHeavyTailBenchmarkArtifact) => ({
        ...value,
        assertions: {
          ...value.assertions,
          resumeMatchesClean: false,
        },
      }),
      (value: CodeGraphHeavyTailBenchmarkArtifact) => ({
        ...value,
        runs: {
          ...value.runs,
          parallel: {...value.runs.parallel, durationMilliseconds: value.runs.parallel.durationMilliseconds + 1},
        },
      }),
      (value: CodeGraphHeavyTailBenchmarkArtifact) => ({
        ...value,
        runs: {
          ...value.runs,
          sixWorkers: {
            ...value.runs.sixWorkers,
            graph: {...value.runs.sixWorkers.graph!, digest: Effect.pipe('1', EffectString.repeat(64))},
          },
        },
      }),
      (value: CodeGraphHeavyTailBenchmarkArtifact) => ({
        ...value,
        ratchetArtifact: {
          ...value.ratchetArtifact,
          metadata: {...value.ratchetArtifact.metadata, profile: 'different-profile'},
        },
      }),
    ]) {
      expect(() => parseCodeGraphHeavyTailReleaseEvidence(mutate(artifact))).toThrow(/release evidence|inconsistent/iu);
    }
  });

  it.each([
    'bun-darwin-arm64',
    'bun-darwin-x64',
    'bun-linux-arm64',
    'bun-linux-arm64-musl',
    'bun-linux-x64-baseline',
    'bun-linux-x64-baseline-musl',
    'bun-linux-x64-musl-baseline',
    'bun-windows-arm64',
    'bun-windows-x64-baseline',
  ])('round-trips canonical managed runtime identity %s and rejects mismatches', target => {
    const architecture = Effect.pipe(target, EffectString.includes('-arm64')) ? 'arm64' : 'x64';
    const platform = Effect.pipe(target, EffectString.startsWith('bun-windows-'))
      ? 'windows'
      : Effect.pipe(target, EffectString.startsWith('bun-darwin-'))
        ? 'darwin'
        : 'linux';
    fc.assert(
      fc.property(fc.tuple(fc.integer({min: 1, max: 9}), fc.nat(99), fc.nat(99)), ([major, minor, patch]) => {
        const version = `${major}.${minor}.${patch}`;
        const sourceArtifact = heavyTailArtifact(0);
        const provenance = sourceArtifact.environment.provenance;
        if (provenance?.mode !== 'managed-exact-head') throw new Error('Expected managed fixture');
        const {ratchetArtifact: _previous, ...outer} = sourceArtifact;
        const updatedProvenance = {...provenance, runtime: `bun-${version}`, target};
        const outerWithIdentity = {
          ...outer,
          environment: {...outer.environment, runtime: `bun/${version}`, architecture, provenance: updatedProvenance},
        };
        const complete = {
          ...outerWithIdentity,
          ratchetArtifact: codeGraphHeavyTailRatchetArtifact(
            outerWithIdentity,
            platform === 'windows' ? 'win32' : platform,
            {
              availableBytes: sourceArtifact.environment.availableBytes!,
              minimumFreeBytes: sourceArtifact.environment.minimumFreeBytes!,
              runtimeProvenance: updatedProvenance,
              storage: sourceArtifact.environment.storage!,
            },
          ),
        };
        expect(parseCodeGraphHeavyTailReleaseEvidence(complete)).toEqual(complete);

        expect(() =>
          parseCodeGraphHeavyTailReleaseEvidence(
            withEnvironmentProvenance(complete, {
              ...updatedProvenance,
              runtime: `bun-${major}.${minor}.${patch + 1}`,
            }),
          ),
        ).toThrow(/provenance/iu);
        expect(() =>
          parseCodeGraphHeavyTailReleaseEvidence(
            withEnvironmentProvenance(complete, {
              ...updatedProvenance,
              target: `${platform}-${architecture}`,
            }),
          ),
        ).toThrow(/provenance/iu);
        expect(() =>
          parseCodeGraphHeavyTailReleaseEvidence(
            withEnvironmentProvenance(complete, {
              ...updatedProvenance,
              target: `bun-${platform}-${architecture === 'arm64' ? 'x64' : 'arm64'}`,
            }),
          ),
        ).toThrow(/provenance/iu);
      }),
      {numRuns: 8},
    );
  });

  it('rejects resumed language telemetry mutations without a regenerated embedded contract', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('factsBytes' as const, 'requestMilliseconds' as const),
        fc.integer({max: 1_000, min: 1}),
        (field, delta) => {
          const mutated = withResumedLanguageTelemetryDelta(heavyTailArtifact(0), field, delta);

          expect(() => parseCodeGraphHeavyTailReleaseEvidence(mutated)).toThrow(/release evidence|inconsistent/iu);
        },
      ),
      {numRuns: 16},
    );
  });

  it('gives nonzero sub-10ms timers bounded absolute noise headroom without relaxing exact zero timers', () => {
    const timer = 'parallel-language-typescript-config-request';
    const zeroTimer = 'parallel-language-mixed-request';
    const artifacts = [
      heavyTailArtifactWithMeasurement(2.884, timer, 0, zeroTimer, 0),
      heavyTailArtifactWithMeasurement(3.246, timer, 0, zeroTimer, 10),
      heavyTailArtifactWithMeasurement(3.124, timer, 0, zeroTimer, 20),
    ];
    const ratchet = createCodeGraphHeavyTailRatchet(artifacts);

    expect(ratchet.measurements[timer]).toMatchObject({p95Maximum: 9});
    expect(ratchet.measurements[zeroTimer]).toMatchObject({p95Maximum: 0});
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        heavyTailArtifactWithMeasurement(9, timer, 0, zeroTimer).ratchetArtifact,
        ratchet,
      ),
    ).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        heavyTailArtifactWithMeasurement(9.001, timer, 0, zeroTimer).ratchetArtifact,
        ratchet,
      ),
    ).toThrow(timer);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        heavyTailArtifactWithMeasurement(3, timer, 0.001, zeroTimer).ratchetArtifact,
        ratchet,
      ),
    ).toThrow(zeroTimer);
  });

  it('keeps the checked scheduler ratchet and governed development evidence synchronized', async () => {
    const ratchet = decodeCheckedHeavyTailRatchet(
      JSON.parse(
        await readFile(
          'apps/threadnote/test/evaluation/baselines/code-graph-v1/heavy-tail-scheduler-ratchet.json',
          'utf8',
        ),
      ),
    );
    const evidence = decodeSchedulerDevelopmentEvidence(
      JSON.parse(
        await readFile(
          'apps/threadnote/test/evaluation/baselines/code-graph-v1/heavy-tail-scheduler-development.json',
          'utf8',
        ),
      ),
    );
    const emittedNames = EffectArray.map(
      heavyTailArtifact(0).ratchetArtifact.measurements,
      measurement => measurement.name,
    ).sort();

    expect(() => validateCodeGraphBenchmarkRatchet(ratchet)).not.toThrow();
    expect(EffectRecord.keys(ratchet.measurements).sort()).toEqual(emittedNames);
    expect(emittedNames).toHaveLength(254);
    expect(ratchet.metadata).toMatchObject({
      automaticParserWorkers: 4,
      governed: true,
      storageFilesystem: 'apfs',
      storageLocation: 'internal',
      storageMedium: 'solid-state',
      workerCapacities: '1,4,6,8',
    });
    expect(evidence.ratchet.measurementCount).toBe(emittedNames.length);
    expect(evidence.scheduler).toEqual({automaticParserWorkers: 4, capacities: [1, 4, 6, 8]});
    expect(evidence.baseline).toMatchObject({
      commit: '5ee8fa6eb20ca24e6f35f0a7e8653a58f880e8b1',
      samples: 3,
      storage: {filesystem: 'apfs', location: 'internal', medium: 'solid-state'},
    });
    expect(evidence.baseline.artifactSha256).toHaveLength(3);
    expect(EffectArray.every(evidence.baseline.artifactSha256, hash => /^[a-f0-9]{64}$/u.test(hash))).toBe(true);
    expect(evidence.graph).toEqual({
      digest: '862c4f7e69cda68d59679d6b052cccfca01c35a2e13086333c631f2286b02c93',
      edges: 327,
      files: 268,
      symbols: 550,
    });
    expect(evidence.interpretation.scope).toContain('not pinned-IntelliJ');
  });

  it('rejects ratchet generation across different exact source commits', () => {
    const artifacts = [heavyTailArtifact(0), heavyTailArtifact(10), heavyTailArtifact(20)];
    const mixed = artifacts[2];
    const differentCommit = Effect.pipe('e', EffectString.repeat(40));
    artifacts[2] = {
      ...mixed,
      environment: {
        ...mixed.environment,
        commit: differentCommit,
        provenance: {...mixed.environment.provenance!, sourceCommit: differentCommit},
      },
      ratchetArtifact: {
        ...mixed.ratchetArtifact,
        environment: {...mixed.ratchetArtifact.environment, commit: differentCommit},
      },
    };

    expect(() => createCodeGraphHeavyTailRatchet(artifacts)).toThrow(/exact source\/runtime\/storage/u);
  });

  it('executes the checked ratchet generator through its Bun process boundary', async () => {
    const root = await mkdtemp('threadnote-heavy-tail-ratchet-generator-');
    try {
      const checkedRatchetPath = join(
        process.cwd(),
        'apps/threadnote/test/evaluation/baselines/code-graph-v1/heavy-tail-scheduler-ratchet.json',
      );
      const checkedRatchet = decodeCheckedHeavyTailRatchet(JSON.parse(await readFile(checkedRatchetPath, 'utf8')));
      const artifactPaths: string[] = [];
      for (const [index, artifact] of [heavyTailArtifact(0), heavyTailArtifact(10), heavyTailArtifact(20)].entries()) {
        const artifactPath = join(root, `artifact-${index}.json`);
        await writeFile(artifactPath, `${JSON.stringify(artifactMatchingCheckedRatchet(artifact, checkedRatchet))}\n`);
        artifactPaths.push(artifactPath);
      }
      const outputPath = join(root, 'ratchet.json');
      const child = Bun.spawn(
        [
          process.execPath,
          'scripts/generate-code-graph-heavy-tail-ratchet.ts',
          '--output',
          outputPath,
          '--candidate-commit',
          Effect.pipe('a', EffectString.repeat(40)),
          '--runner-class',
          RELEASE_RUNNER_CLASS,
          '--runner-identity',
          'local-apple-m1-max',
          '--ratchet',
          checkedRatchetPath,
          '--release-observed-at',
          RELEASE_OBSERVED_AT,
          '--release-not-before',
          new Date(RELEASE_CAPTURE_START).toISOString(),
          '--maximum-evidence-age-ms',
          '60000',
          '--maximum-run-span-ms',
          '20',
          '--future-skew-ms',
          '1000',
          ...artifactPaths,
        ],
        {cwd: process.cwd(), stderr: 'pipe', stdout: 'pipe'},
      );
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);

      expect(stderr).toBe('');
      expect(exitCode, stdout).toBe(0);
      expect(stdout).toContain('threadnote-code-graph-heavy-tail');
      const ratchet = decodeMeasurementsEnvelope(JSON.parse(await readFile(outputPath, 'utf8')));
      expect(EffectRecord.keys(ratchet.measurements)).toHaveLength(254);
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  });
});

const OpenFixtureObject = Schema.Record(Schema.String, Schema.Unknown);
const CheckedHeavyTailLimitSchema = Schema.Struct({
  maximum: Schema.optionalKey(Schema.Finite),
  meanMaximum: Schema.optionalKey(Schema.Finite),
  minimum: Schema.optionalKey(Schema.Finite),
  p50Maximum: Schema.optionalKey(Schema.Finite),
  p95Maximum: Schema.optionalKey(Schema.Finite),
  p99Maximum: Schema.optionalKey(Schema.Finite),
  samplesMinimum: Schema.Finite,
  unit: Schema.Literals(['bytes', 'count', 'milliseconds', 'operations_per_second', 'percent']),
});
const CheckedHeavyTailRatchetSchema = Schema.Struct({
  environment: Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.Finite, Schema.String])),
  measurements: Schema.Record(Schema.String, CheckedHeavyTailLimitSchema),
  metadata: Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.Finite, Schema.String])),
  suite: Schema.Literal('threadnote-code-graph-heavy-tail'),
  version: Schema.Literal(1),
});
type CheckedHeavyTailRatchet = typeof CheckedHeavyTailRatchetSchema.Type;

type CheckedLimitOverride = {
  readonly name: string;
  readonly minimum?: number;
  readonly p95Maximum?: number;
};
function checkedRatchetWithLimits(
  checked: CheckedHeavyTailRatchet,
  overrides: readonly CheckedLimitOverride[],
): CheckedHeavyTailRatchet {
  const measurements = {...checked.measurements};
  for (const {name, ...limits} of overrides) {
    const current = measurements[name];
    if (current === undefined) throw new Error(`Missing checked heavy-tail measurement ${name}.`);
    measurements[name] = {...current, ...limits};
  }
  return {...checked, measurements};
}
function withEnvironmentProvenance(
  artifact: CodeGraphHeavyTailBenchmarkArtifact,
  provenance: NonNullable<CodeGraphHeavyTailBenchmarkArtifact['environment']['provenance']>,
): CodeGraphHeavyTailBenchmarkArtifact {
  return {...artifact, environment: {...artifact.environment, provenance}};
}
function withResumedLanguageTelemetryDelta(
  artifact: CodeGraphHeavyTailBenchmarkArtifact,
  field: 'factsBytes' | 'requestMilliseconds',
  delta: number,
): CodeGraphHeavyTailBenchmarkArtifact {
  const telemetry = artifact.runs.resumed.languages.typescript;
  return {
    ...artifact,
    runs: {
      ...artifact.runs,
      resumed: {
        ...artifact.runs.resumed,
        languages: {
          ...artifact.runs.resumed.languages,
          typescript: {...telemetry, [field]: telemetry[field] + delta},
        },
      },
    },
  };
}
const decodeCheckedHeavyTailRatchet = Schema.decodeUnknownSync(CheckedHeavyTailRatchetSchema);
const ReviewedProfileBaselineSchema = Schema.StructWithRest(
  Schema.Struct({
    profile: Schema.Unknown,
    reviewedShape: Schema.StructWithRest(
      Schema.Struct({eligibleFiles: Schema.Finite, latencyBudget: Schema.String, repositoryFiles: Schema.Finite}),
      [OpenFixtureObject],
    ),
    version: Schema.Finite,
  }),
  [OpenFixtureObject],
);
const decodeReviewedProfileBaseline = Schema.decodeUnknownSync(ReviewedProfileBaselineSchema);
const DevelopmentBaselineSchema = Schema.StructWithRest(
  Schema.Struct({
    assertions: Schema.Record(Schema.String, Schema.Boolean),
    interpretation: Schema.StructWithRest(Schema.Struct({latency: Schema.String}), [OpenFixtureObject]),
    profile: Schema.Unknown,
    result: Schema.StructWithRest(
      Schema.Struct({
        cacheFactsBytes: Schema.Finite,
        graphDigest: Schema.String,
        lowSignalJsonFactsBytes: Schema.Finite,
      }),
      [OpenFixtureObject],
    ),
    runs: Schema.StructWithRest(
      Schema.Struct({
        interrupted: Schema.StructWithRest(Schema.Struct({cacheFiles: Schema.Finite}), [OpenFixtureObject]),
        resumed: Schema.StructWithRest(Schema.Struct({reusedFiles: Schema.Finite}), [OpenFixtureObject]),
      }),
      [OpenFixtureObject],
    ),
  }),
  [OpenFixtureObject],
);
const decodeDevelopmentBaseline = Schema.decodeUnknownSync(DevelopmentBaselineSchema);
const SchedulerDevelopmentEvidenceSchema = Schema.StructWithRest(
  Schema.Struct({
    baseline: Schema.StructWithRest(
      Schema.Struct({
        artifactSha256: Schema.Array(Schema.String),
        commit: Schema.String,
        samples: Schema.Finite,
        storage: Schema.StructWithRest(
          Schema.Struct({filesystem: Schema.String, location: Schema.String, medium: Schema.String}),
          [OpenFixtureObject],
        ),
      }),
      [OpenFixtureObject],
    ),
    graph: Schema.StructWithRest(
      Schema.Struct({digest: Schema.String, edges: Schema.Finite, files: Schema.Finite, symbols: Schema.Finite}),
      [OpenFixtureObject],
    ),
    interpretation: Schema.StructWithRest(Schema.Struct({scope: Schema.String}), [OpenFixtureObject]),
    ratchet: Schema.StructWithRest(Schema.Struct({measurementCount: Schema.Finite}), [OpenFixtureObject]),
    scheduler: Schema.StructWithRest(
      Schema.Struct({automaticParserWorkers: Schema.Finite, capacities: Schema.Array(Schema.Finite)}),
      [OpenFixtureObject],
    ),
  }),
  [OpenFixtureObject],
);
const decodeSchedulerDevelopmentEvidence = Schema.decodeUnknownSync(SchedulerDevelopmentEvidenceSchema);
const MeasurementsEnvelopeSchema = Schema.StructWithRest(Schema.Struct({measurements: OpenFixtureObject}), [
  OpenFixtureObject,
]);
const decodeMeasurementsEnvelope = Schema.decodeUnknownSync(MeasurementsEnvelopeSchema);

interface ReleaseAdmissionRecord {
  readonly actualCandidate: string;
  readonly candidateCommit: string;
  readonly evidenceClass: 'correctness-only' | 'governed-performance';
  readonly freshness: {
    readonly futureSkewMilliseconds: number;
    readonly maximumAgeMilliseconds: number;
    readonly maximumSpanMilliseconds: number;
    readonly notBefore: number;
    readonly observedAt: number;
  };
  readonly outerEmbeddedConsistent: boolean;
  readonly provenanceCommit: string;
  readonly runnerClass: string;
  readonly runnerIdentity: string;
  readonly selectedRunnerClass: string;
  readonly selectedRunnerIdentity: string;
  readonly timestamps: readonly [number, number, number];
}

const releaseCommitArbitrary = fc
  .array(fc.constantFrom(...'0123456789abcdef'), {maxLength: 40, minLength: 40})
  .map(characters => EffectArray.join(characters, ''));
const releaseRunnerArbitrary = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), {maxLength: 18, minLength: 3})
  .map(characters => EffectArray.join(characters, ''))
  .filter(value => value !== 'local' && value !== 'local-unclassified');

const validReleaseAdmissionRecordArbitrary = fc
  .record({
    actualCandidate: releaseCommitArbitrary,
    beforeSlack: fc.integer({max: 50, min: 0}),
    firstOffset: fc.integer({max: 1_000, min: 0}),
    firstStep: fc.integer({max: 20, min: 1}),
    futureSkewMilliseconds: fc.integer({max: 50, min: 0}),
    observedLag: fc.integer({max: 50, min: 0}),
    runnerClass: releaseRunnerArbitrary,
    runnerIdentity: releaseRunnerArbitrary,
    secondStep: fc.integer({max: 20, min: 1}),
  })
  .map(values => {
    const first = RELEASE_CAPTURE_START + values.firstOffset;
    const second = first + values.firstStep;
    const third = second + values.secondStep;
    const observedAt = third + values.observedLag;
    return {
      actualCandidate: values.actualCandidate,
      candidateCommit: values.actualCandidate,
      evidenceClass: 'governed-performance' as const,
      freshness: {
        futureSkewMilliseconds: values.futureSkewMilliseconds,
        maximumAgeMilliseconds: observedAt - first,
        maximumSpanMilliseconds: third - first,
        notBefore: first - values.beforeSlack,
        observedAt,
      },
      outerEmbeddedConsistent: true,
      provenanceCommit: values.actualCandidate,
      runnerClass: values.runnerClass,
      runnerIdentity: values.runnerIdentity,
      selectedRunnerClass: values.runnerClass,
      selectedRunnerIdentity: values.runnerIdentity,
      timestamps: [first, second, third] as const,
    } satisfies ReleaseAdmissionRecord;
  });

const rejectedReleaseAdmissionRecordArbitrary = fc
  .tuple(
    validReleaseAdmissionRecordArbitrary,
    fc.constantFrom(
      'candidate',
      'runner-class',
      'runner-identity',
      'timestamp-order',
      'freshness',
      'provenance',
      'evidence',
      'outer-embedded',
    ),
  )
  .map(([record, rejection]): ReleaseAdmissionRecord => {
    switch (rejection) {
      case 'candidate':
        return {...record, candidateCommit: differentCommit(record.actualCandidate)};
      case 'runner-class':
        return {...record, selectedRunnerClass: `${record.runnerClass}-other`};
      case 'runner-identity':
        return {...record, selectedRunnerIdentity: `${record.runnerIdentity}-other`};
      case 'timestamp-order':
        return {...record, timestamps: [record.timestamps[0], record.timestamps[0], record.timestamps[2]]};
      case 'freshness':
        return {
          ...record,
          freshness: {
            ...record.freshness,
            maximumAgeMilliseconds: record.freshness.observedAt - record.timestamps[0] - 1,
          },
        };
      case 'provenance':
        return {...record, provenanceCommit: differentCommit(record.actualCandidate)};
      case 'evidence':
        return {...record, evidenceClass: 'correctness-only'};
      case 'outer-embedded':
        return {...record, outerEmbeddedConsistent: false};
    }
  });

function releaseAdmissionCase(record: ReleaseAdmissionRecord) {
  const checkedArtifacts = releaseArtifacts({
    ...record,
    evidenceClass: 'governed-performance',
    outerEmbeddedConsistent: true,
    provenanceCommit: record.actualCandidate,
    timestamps: [RELEASE_CAPTURE_START, RELEASE_CAPTURE_START + 10, RELEASE_CAPTURE_START + 20],
  });
  return {
    artifacts: releaseArtifacts(record),
    options: {
      candidateCommit: record.candidateCommit,
      checkedRatchet: createCodeGraphHeavyTailRatchet(checkedArtifacts),
      freshness: {
        futureSkewMilliseconds: record.freshness.futureSkewMilliseconds,
        maximumAgeMilliseconds: record.freshness.maximumAgeMilliseconds,
        maximumSpanMilliseconds: record.freshness.maximumSpanMilliseconds,
        notBefore: new Date(record.freshness.notBefore).toISOString(),
        observedAt: new Date(record.freshness.observedAt).toISOString(),
      },
      runnerClass: record.selectedRunnerClass,
      runnerIdentity: record.selectedRunnerIdentity,
    },
  };
}

function releaseArtifacts(record: ReleaseAdmissionRecord): CodeGraphHeavyTailBenchmarkArtifact[] {
  const artifacts = EffectArray.map(
    [heavyTailArtifact(0), heavyTailArtifact(10), heavyTailArtifact(20)],
    (artifact, index) => {
      const outer = {
        ...artifact,
        createdAt: new Date(record.timestamps[index]).toISOString(),
        evidenceClass: record.evidenceClass,
        environment: {
          ...artifact.environment,
          commit: record.actualCandidate,
          provenance: {...artifact.environment.provenance!, sourceCommit: record.provenanceCommit},
          runnerClass: record.runnerClass,
          runnerIdentity: record.runnerIdentity,
        },
      };
      return withRecomputedHeavyTailRatchet(outer);
    },
  );
  if (!record.outerEmbeddedConsistent) {
    const first = artifacts[0];
    artifacts[0] = {
      ...first,
      runs: {
        ...first.runs,
        parallel: {...first.runs.parallel, durationMilliseconds: first.runs.parallel.durationMilliseconds + 1},
      },
    };
  }
  return artifacts;
}

function expectedReleaseAdmission(record: ReleaseAdmissionRecord): boolean {
  const {freshness, timestamps} = record;
  return (
    /^[0-9a-f]{40}$/u.test(record.candidateCommit) &&
    record.candidateCommit === record.actualCandidate &&
    Effect.pipe(record.selectedRunnerClass, EffectString.trim).length > 0 &&
    record.selectedRunnerClass !== 'local-unclassified' &&
    record.selectedRunnerClass === record.runnerClass &&
    Effect.pipe(record.selectedRunnerIdentity, EffectString.trim).length > 0 &&
    record.selectedRunnerIdentity !== 'local' &&
    record.selectedRunnerIdentity === record.runnerIdentity &&
    timestamps[0] < timestamps[1] &&
    timestamps[1] < timestamps[2] &&
    freshness.notBefore <= freshness.observedAt &&
    freshness.maximumAgeMilliseconds > 0 &&
    freshness.maximumSpanMilliseconds > 0 &&
    EffectArray.every(
      timestamps,
      timestamp =>
        timestamp >= freshness.notBefore &&
        freshness.observedAt - timestamp <= freshness.maximumAgeMilliseconds &&
        timestamp <= freshness.observedAt + freshness.futureSkewMilliseconds,
    ) &&
    Math.max(...timestamps) - Math.min(...timestamps) <= freshness.maximumSpanMilliseconds &&
    record.provenanceCommit === record.actualCandidate &&
    record.evidenceClass === 'governed-performance' &&
    record.outerEmbeddedConsistent
  );
}

function differentCommit(commit: string): string {
  return `${commit[0] === '0' ? '1' : '0'}${Effect.pipe(commit, EffectString.slice(1))}`;
}

function withRecomputedHeavyTailRatchet(
  artifact: CodeGraphHeavyTailBenchmarkArtifact,
): CodeGraphHeavyTailBenchmarkArtifact {
  const {ratchetArtifact: _ratchetArtifact, ...outer} = artifact;
  const governance = {
    availableBytes: outer.environment.availableBytes!,
    minimumFreeBytes: outer.environment.minimumFreeBytes!,
    runtimeProvenance: outer.environment.provenance!,
    storage: outer.environment.storage!,
  } satisfies HeavyTailGovernanceEvidence;
  return {
    ...outer,
    ratchetArtifact: codeGraphHeavyTailRatchetArtifact(outer, 'darwin', governance),
  };
}

function artifactMatchingCheckedRatchet(
  artifact: CodeGraphHeavyTailBenchmarkArtifact,
  checked: CheckedHeavyTailRatchet,
): CodeGraphHeavyTailBenchmarkArtifact {
  let updated = artifact;
  for (const [name, limit] of EffectRecord.toEntries(checked.measurements)) {
    if (
      name === 'parallel-duration-reduction' ||
      name === 'parallel-active-wall-reduction' ||
      name === 'resume-retained-cache-coverage'
    ) {
      continue;
    }
    const value =
      limit.minimum !== undefined && Effect.pipe(name, EffectString.endsWith('-extraction-average-concurrency'))
        ? limit.minimum / 0.9
        : (limit.minimum ?? 0);
    updated = setHeavyTailMeasurement(updated, name, value);
  }
  return withRecomputedHeavyTailRatchet({
    ...updated,
    runs: {
      ...updated.runs,
      single: {
        ...updated.runs.single,
        durationMilliseconds: 100,
        extraction: {
          ...updated.runs.single.extraction,
          activeWallMilliseconds: 100,
          requestMilliseconds: 100,
        },
      },
      parallel: {
        ...updated.runs.parallel,
        durationMilliseconds: 0,
        extraction: {
          ...updated.runs.parallel.extraction,
          activeWallMilliseconds: 0,
        },
      },
    },
  });
}

function setHeavyTailMeasurement(
  artifact: CodeGraphHeavyTailBenchmarkArtifact,
  name: string,
  value: number,
): CodeGraphHeavyTailBenchmarkArtifact {
  const runPrefix = [
    ['eight-workers', 'eightWorkers'],
    ['six-workers', 'sixWorkers'],
    ['interrupted', 'interrupted'],
    ['parallel', 'parallel'],
    ['resumed', 'resumed'],
    ['single', 'single'],
  ] as const;
  const match = EffectOption.getOrUndefined(
    EffectArray.findFirst(runPrefix, ([prefix]) => Effect.pipe(name, EffectString.startsWith(`${prefix}-`))),
  );
  if (match === undefined) return artifact;
  const [prefix, alias] = match;
  const metric = Effect.pipe(name, EffectString.slice(prefix.length + 1));
  const run = artifact.runs[alias];
  let updatedRun: HeavyTailChildRun = run;
  switch (metric) {
    case 'duration':
      updatedRun = {...run, durationMilliseconds: value};
      break;
    case 'cpu':
      updatedRun = {...run, cpuMilliseconds: value};
      break;
    case 'peak-rss':
      updatedRun = {...run, peakRssBytes: value};
      break;
    case 'reading':
      updatedRun = {...run, readingMilliseconds: value};
      break;
    case 'extraction-active-wall':
      updatedRun = {...run, extraction: {...run.extraction, activeWallMilliseconds: value}};
      break;
    case 'extraction-average-concurrency':
      updatedRun = {...run, extraction: {...run.extraction, averageConcurrency: value}};
      break;
    case 'extraction-peak-concurrency':
      updatedRun = {...run, extraction: {...run.extraction, peakConcurrency: value}};
      break;
    case 'extraction-request':
      updatedRun = {...run, extraction: {...run.extraction, requestMilliseconds: value}};
      break;
    case 'cache-files':
      updatedRun = {...run, cache: {...run.cache, files: value}};
      break;
    case 'cache-facts-bytes':
      updatedRun = {...run, cache: {...run.cache, factsBytes: value}};
      break;
    case 'cache-low-signal-json-facts-bytes':
      updatedRun = {...run, cache: {...run.cache, lowSignalJsonFactsBytes: value}};
      break;
    case 'interrupted-after-persisted-files':
      updatedRun = {...run, interruptedAfterPersistedFiles: value};
      break;
    case 'reused-files':
      updatedRun = {...run, reusedFiles: value};
      break;
    default: {
      if (Effect.pipe(metric, EffectString.startsWith('graph-')) && run.graph !== undefined) {
        const graphMetric = Effect.pipe(metric, EffectString.slice('graph-'.length));
        const graph = run.graph;
        switch (graphMetric) {
          case 'edges':
            updatedRun = {...run, graph: {...graph, edges: value}};
            break;
          case 'files':
            updatedRun = {...run, graph: {...graph, files: value}};
            break;
          case 'generated-tail-preserved':
            updatedRun = {...run, graph: {...graph, generatedTypeScriptTailPreserved: value === 1}};
            break;
          case 'low-signal-json-symbols':
            updatedRun = {...run, graph: {...graph, lowSignalJsonSymbols: value}};
            break;
          case 'pathological-typescript-tails':
            updatedRun = {...run, graph: {...graph, pathologicalTypeScriptTails: value}};
            break;
          case 'symbols':
            updatedRun = {...run, graph: {...graph, symbols: value}};
            break;
          case 'textless-svg-symbols':
            updatedRun = {...run, graph: {...graph, textlessSvgSymbols: value}};
            break;
        }
      }
      for (const language of EffectRecord.keys(run.languages).sort((left, right) => right.length - left.length)) {
        const languagePrefix = `language-${language}-`;
        if (!Effect.pipe(metric, EffectString.startsWith(languagePrefix))) continue;
        const telemetry = run.languages[language];
        const languageMetric = Effect.pipe(metric, EffectString.slice(languagePrefix.length));
        let updatedTelemetry = telemetry;
        switch (languageMetric) {
          case 'degraded-files':
            updatedTelemetry = {...telemetry, degradedFiles: value};
            break;
          case 'facts-bytes':
            updatedTelemetry = {...telemetry, factsBytes: value};
            break;
          case 'files':
            updatedTelemetry = {...telemetry, files: value};
            break;
          case 'parse':
            updatedTelemetry = {...telemetry, parseMilliseconds: value};
            break;
          case 'persistence':
            updatedTelemetry = {...telemetry, persistenceMilliseconds: value};
            break;
          case 'request':
            updatedTelemetry = {
              ...telemetry,
              requestMilliseconds: value,
              ...(telemetry.parseMilliseconds > value ? {parseMilliseconds: value} : {}),
            };
            break;
          case 'relations':
            updatedTelemetry = {...telemetry, relations: value};
            break;
          case 'source-bytes':
            updatedTelemetry = {...telemetry, sourceBytes: value};
            break;
          case 'symbols':
            updatedTelemetry = {...telemetry, symbols: value};
            break;
        }
        updatedRun = {...run, languages: {...run.languages, [language]: updatedTelemetry}};
        break;
      }
    }
  }
  if (updatedRun === run) return artifact;
  return {...artifact, runs: {...artifact.runs, [alias]: updatedRun}};
}

function releaseOptions(artifacts: readonly CodeGraphHeavyTailBenchmarkArtifact[]) {
  return {
    candidateCommit: Effect.pipe('a', EffectString.repeat(40)),
    checkedRatchet: createCodeGraphHeavyTailRatchet(artifacts),
    freshness: {
      futureSkewMilliseconds: 1_000,
      maximumAgeMilliseconds: 60_000,
      maximumSpanMilliseconds: 20,
      notBefore: new Date(RELEASE_CAPTURE_START).toISOString(),
      observedAt: RELEASE_OBSERVED_AT,
    },
    runnerClass: RELEASE_RUNNER_CLASS,
    runnerIdentity: 'local-apple-m1-max',
  };
}

function heavyTailArtifact(offset: number): CodeGraphHeavyTailBenchmarkArtifact {
  const governance: HeavyTailGovernanceEvidence = {
    availableBytes: 200 * 1_073_741_824,
    minimumFreeBytes: 120 * 1_073_741_824,
    runtimeProvenance: {
      dependencyInstallation: 'bun install --frozen-lockfile',
      executableSha256: Effect.pipe('d', EffectString.repeat(64)),
      mode: 'managed-exact-head',
      payloadBytes: 1,
      payloadFileCount: 1,
      payloadManifestSha256: Effect.pipe('e', EffectString.repeat(64)),
      processLeaseInspection: 'complete',
      releaseMetadataSha256: Effect.pipe('f', EffectString.repeat(64)),
      runtime: 'bun-1.4.2',
      sourceCommit: Effect.pipe('a', EffectString.repeat(40)),
      sourceLockfileSha256: Effect.pipe('b', EffectString.repeat(64)),
      sourcePackageManifestSha256: Effect.pipe('c', EffectString.repeat(64)),
      target: 'bun-darwin-arm64',
      version: 'threadnote-test',
    },
    storage: {filesystem: 'apfs', location: 'internal', medium: 'solid-state'},
  };
  const single = completeRun(1, 3_200 + offset, 1, offset);
  const parallel = completeRun(4, 2_800 + offset, 3.25, offset);
  const sixWorkers = completeRun(6, 2_900 + offset, 5.1, offset);
  const eightWorkers = completeRun(8, 3_000 + offset, 7.1, offset);
  const interrupted: HeavyTailChildRun = {
    ...baseRun(4, 1_900 + offset, 3.2, offset),
    cache: {factsBytes: 260_396, files: 266, lowSignalJsonFactsBytes: 0},
    interruptedAfterPersistedFiles: 266,
    state: 'interrupted',
  };
  const resumed = {...completeRun(4, 1_600 + offset, 2, offset), reusedFiles: 266};
  const base: Omit<CodeGraphHeavyTailBenchmarkArtifact, 'ratchetArtifact'> = {
    assertions: {
      interruptionRetainedCache: true,
      lowSignalJsonExcluded: true,
      parallelMatchesSingle: true,
      sixWorkersMatchSingle: true,
      pathologicalTypeScriptSurfacePreserved: true,
      resumeMatchesClean: true,
      resumeReusedCache: true,
      textlessSvgExcluded: true,
      eightWorkersMatchSingle: true,
    },
    createdAt: new Date(RELEASE_CAPTURE_START + offset).toISOString(),
    evidenceClass: 'governed-performance',
    environment: {
      architecture: 'arm64',
      availableBytes: governance.availableBytes,
      commit: Effect.pipe('a', EffectString.repeat(40)),
      cpu: 'Apple M1 Max',
      dirty: false,
      memoryBytes: 64 * 1_073_741_824,
      minimumFreeBytes: governance.minimumFreeBytes,
      operatingSystem: 'macOS 27.0',
      provenance: governance.runtimeProvenance,
      runtime: 'bun/1.4.2',
      runnerClass: RELEASE_RUNNER_CLASS,
      runnerIdentity: 'local-apple-m1-max',
      storage: governance.storage,
    },
    profile: CODE_GRAPH_HEAVY_TAIL_PROFILE,
    runs: {eightWorkers, interrupted, parallel, resumed, sixWorkers, single},
    suite: 'code-graph-large-monorepo-heavy-tail-v2' as const,
    version: 3 as const,
  };
  return {...base, ratchetArtifact: codeGraphHeavyTailRatchetArtifact(base, 'darwin', governance)};
}

function heavyTailArtifactWithMeasurement(
  value: number,
  name: string,
  secondValue: number,
  secondName: string,
  offset = 0,
): CodeGraphHeavyTailBenchmarkArtifact {
  const artifact = heavyTailArtifact(offset);
  return withRecomputedHeavyTailRatchet(
    setHeavyTailMeasurement(setHeavyTailMeasurement(artifact, name, value), secondName, secondValue),
  );
}

function completeRun(workerCount: number, durationMilliseconds: number, concurrency: number, offset: number) {
  return {
    ...baseRun(workerCount, durationMilliseconds, concurrency, offset),
    graph: {
      digest: HEAVY_TAIL_GRAPH_DIGEST,
      edges: 327,
      files: 268,
      generatedTypeScriptTailPreserved: true,
      lowSignalJsonSymbols: 0,
      pathologicalTypeScriptTails: 8,
      symbols: 550,
      textlessSvgSymbols: 0,
    },
    reusedFiles: 0,
    state: 'complete' as const,
  } satisfies HeavyTailChildRun;
}

function baseRun(workerCount: number, durationMilliseconds: number, concurrency: number, offset: number) {
  const compactLanguage = {
    degradedFiles: 0,
    factsBytes: 128,
    files: 1,
    parseMilliseconds: 1 + offset,
    persistenceMilliseconds: 1 + offset,
    relations: 0,
    requestMilliseconds: 2 + offset,
    sourceBytes: 256,
    symbols: 1,
  };
  return {
    cache: {factsBytes: 260_876, files: 268, lowSignalJsonFactsBytes: 0},
    cpuMilliseconds: 2_700 + offset,
    durationMilliseconds,
    extraction: {
      activeWallMilliseconds: 1_300 + offset,
      averageConcurrency: concurrency,
      peakConcurrency: workerCount,
      requestMilliseconds: 4_300 + offset,
    },
    languages: {
      mixed: {...compactLanguage},
      'npm-manifest': {...compactLanguage},
      typescript: {
        degradedFiles: 0,
        factsBytes: 552_458,
        files: 266,
        parseMilliseconds: 1_300 + offset,
        persistenceMilliseconds: 50 + offset,
        requestMilliseconds: 4_290 + offset,
        relations: 327,
        sourceBytes: 5_952_842,
        symbols: 549,
      },
      'typescript-config': {...compactLanguage},
    },
    peakRssBytes: 390_000_000 + offset,
    readingMilliseconds: 60 + offset,
    slowFiles: [],
    version: 2 as const,
    workerCount,
  };
}

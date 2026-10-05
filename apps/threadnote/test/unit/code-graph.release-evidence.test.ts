import {readFileSync} from '@threadnote/testing/node-fs';
import {JSON_SCHEMA, load} from 'js-yaml';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  EXTERNAL_REPOSITORY_EVIDENCE_MEASUREMENTS,
  PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT,
  PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS,
  assertExternalPerformanceEvidence,
  assertExternalRepositoryEvidence,
  assertGovernedReducedProductionReleaseEvidence,
  assertProductionReleaseEvidence,
  createCodeGraphProductionRatchet,
  enforceCodeGraphBenchmarkBudget,
  enforceCodeGraphBenchmarkRatchet,
  externalSamplerMeasurements,
  indexPhaseMeasurements,
  materializationStorageMeasurements,
  parseCodeGraphBenchmarkArguments,
  performanceControlExpectedNodeLanguage,
  productionProfile,
  productionProfileArtifactMetadata,
  releaseEvidenceSourcePathspecs,
  resolvedReleaseEvidenceSource,
  IndexPhaseTimeline,
  type CodeGraphBenchmarkMeasurementRatchetV1,
} from '../../../../scripts/benchmark-code-graph.js';
import {PRODUCTION_LARGE_CODE_GRAPH_PROFILE} from '../../../../scripts/code-graph-fixture.js';
import {CODE_GRAPH_HEAVY_TAIL_PROFILE} from '../../../../scripts/code-graph-heavy-tail-fixture.js';
import {benchmarkMeasurement, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM} from '@threadnote/graph/materialized_shard_cache_admission';
import {
  retainedPerformanceArtifactFromHarness,
  validateRetainedPerformancePayload,
} from '@threadnote/evidence/performance';

const CODE_GRAPH_BUDGETS = 'apps/threadnote/test/evaluation/baselines/code-graph-v1/budgets.json';
const POLYGLOT_BUDGETS = 'apps/threadnote/test/evaluation/baselines/code-graph-polyglot-v1/budgets.json';
const BETA30_STAGING_EVIDENCE =
  'apps/threadnote/test/evaluation/baselines/code-graph-v1/beta30-staging-development.json';

describe('code graph release evidence', () => {
  it('keeps local heavy-tail attestation outside stable and beta publication gates', () => {
    const guide = readFileSync('docs/releasing.md', 'utf8');
    const publishing = guide
      .split('## Publishing\n')[1]
      ?.split('\n## Optional local heavy-tail performance evidence')[0];
    expect(publishing).toBeDefined();
    expect(publishing).toMatch(
      /Local heavy-tail attestation is optional and is not a publication gate for\s+stable or beta releases/u,
    );
    expect(publishing).not.toContain('bench:code-graph:heavy-tail:ratchet');
    expect(publishing).not.toContain('Final release readiness additionally requires');
    expect(publishing).toContain('Run the Stage 3 code-graph dogfood gate');
    expect(publishing).toContain('Confirm immutable releases are enabled');
    const publisher = readFileSync('.github/workflows/publish.yml', 'utf8');
    expect(publisher).not.toContain('bench:code-graph:heavy-tail');
    expect(publisher).not.toContain('assertHeavyTailReleaseRatchet');
  });
  it('keeps the production-shaped release target immutable while classifying hosted heavy-tail runs as correctness-only', () => {
    expect(PRODUCTION_LARGE_CODE_GRAPH_PROFILE).toMatchObject({
      targetRepositoryFiles: 73_000,
      targetEligibleFiles: 59_936,
      targetGraphSymbols: 2_200_000,
      targetGraphEdges: 4_340_000,
      targetLexicalTermRows: 32_250_000,
      workspaceCount: 995,
    });
    expect(CODE_GRAPH_HEAVY_TAIL_PROFILE).toMatchObject({
      id: 'large-monorepo-heavy-tail',
      parallelWorkers: 4,
      textlessSvgFiles: 4_000,
    });
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8'), {
      schema: JSON_SCHEMA,
    }) as BenchmarkWorkflow;
    const capture = workflow.jobs['code-graph-heavy-tail'].steps?.find(step =>
      step.run?.includes('bench:code-graph:heavy-tail'),
    );
    expect(capture?.run).toContain('--evidence-class correctness-only');
    expect(capture?.run).not.toContain('--ratchet');
  });
  it('retains the maximum cumulative inventory subphase timings', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            extractionMilliseconds: fc.integer({max: 10_000, min: 0}),
            persistenceMilliseconds: fc.integer({max: 10_000, min: 0}),
            readingMilliseconds: fc.integer({max: 10_000, min: 0}),
            serializationMilliseconds: fc.integer({max: 10_000, min: 0}),
          }),
          {maxLength: 20, minLength: 1},
        ),
        timings => {
          const telemetry = {cpuSystemMicroseconds: 0, cpuUserMicroseconds: 0, peakRssBytes: 0, rssBytes: 0};
          const timeline = new IndexPhaseTimeline(0n, telemetry);
          for (const [index, observation] of timings.entries()) {
            timeline.observe(
              {
                accepted: 1,
                completed: index + 1,
                excluded: 0,
                phase: 'scanning',
                skipped: 0,
                timings: observation,
                total: timings.length,
                unit: 'files',
              },
              BigInt(index + 1),
              telemetry,
            );
          }

          const measurements = new Map(
            indexPhaseMeasurements('cold', timeline, false).map(measurement => [measurement.name, measurement.minimum]),
          );
          expect(measurements.get('cold-inventory-source-reading-n1')).toBe(
            Math.max(...timings.map(observation => observation.readingMilliseconds)),
          );
          expect(measurements.get('cold-inventory-parser-extraction-summed-n1')).toBe(
            Math.max(...timings.map(observation => observation.extractionMilliseconds)),
          );
          expect(measurements.get('cold-inventory-cache-persistence-n1')).toBe(
            Math.max(...timings.map(observation => observation.persistenceMilliseconds)),
          );
          expect(measurements.get('cold-inventory-parser-fact-serialization-n1')).toBe(
            Math.max(...timings.map(observation => observation.serializationMilliseconds)),
          );
        },
      ),
      {numRuns: 50},
    );
  });

  it('retains the maximum cumulative materialization subphase timings', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            attributionCompute: fc.integer({max: 10_000, min: 0}),
            factBatchPreparation: fc.integer({max: 10_000, min: 0}),
            shardAssociation: fc.integer({max: 10_000, min: 0}),
            shardPersistence: fc.integer({max: 10_000, min: 0}),
            shardSerialization: fc.integer({max: 10_000, min: 0}),
          }),
          {maxLength: 20, minLength: 1},
        ),
        timings => {
          const telemetry = {cpuSystemMicroseconds: 0, cpuUserMicroseconds: 0, peakRssBytes: 0, rssBytes: 0};
          const timeline = new IndexPhaseTimeline(0n, telemetry);
          for (const [index, observation] of timings.entries()) {
            timeline.observe(
              {
                completed: index + 1,
                metrics: {
                  batchesCompleted: index + 1,
                  batchesTotal: timings.length,
                  sourceBytesCompleted: index + 1,
                  sourceBytesTotal: timings.length,
                  subphaseMilliseconds: observation,
                },
                phase: 'materializing',
                reused: 0,
                total: timings.length,
                unit: 'files',
              },
              BigInt(index + 1),
              telemetry,
            );
          }

          const measurements = new Map(
            indexPhaseMeasurements('cold', timeline, false).map(measurement => [measurement.name, measurement.minimum]),
          );
          for (const [field, suffix] of [
            ['attributionCompute', 'attribution-compute'],
            ['factBatchPreparation', 'fact-batch-preparation'],
            ['shardAssociation', 'shard-association'],
            ['shardPersistence', 'shard-persistence'],
            ['shardSerialization', 'shard-serialization'],
          ] as const) {
            expect(measurements.get(`cold-materialization-subphase-${suffix}-n1`)).toBe(
              Math.max(...timings.map(observation => observation[field])),
            );
          }
        },
      ),
      {numRuns: 50},
    );

    for (const prefix of ['cold', 'same-overlay-reference'] as const) {
      for (const suffix of [
        'attribution-compute',
        'fact-batch-preparation',
        'shard-association',
        'shard-persistence',
        'shard-serialization',
      ] as const) {
        expect(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS).toContainEqual({
          name: `${prefix}-materialization-subphase-${suffix}-n1`,
          unit: 'milliseconds',
        });
      }
    }
  });

  it('emits exact materialization row counts required by release-bound site evidence', () => {
    const telemetry = {cpuSystemMicroseconds: 0, cpuUserMicroseconds: 0, peakRssBytes: 0, rssBytes: 0};
    const timeline = new IndexPhaseTimeline(0n, telemetry);
    timeline.observe(
      {
        completed: 1,
        metrics: {
          batchesCompleted: 1,
          batchesTotal: 1,
          rows: {lookupKeys: 7, referenceCandidates: 11},
          sourceBytesCompleted: 1,
          sourceBytesTotal: 1,
        },
        phase: 'materializing',
        reused: 0,
        total: 1,
        unit: 'files',
      },
      1n,
      telemetry,
    );

    const measurements = new Map(
      indexPhaseMeasurements('cold', timeline, false).map(measurement => [measurement.name, measurement]),
    );
    expect(measurements.get('cold-materialized-lookup-key-rows-n1')).toMatchObject({
      minimum: 7,
      unit: 'count',
    });
    expect(measurements.get('cold-materialized-reference-candidate-rows-n1')).toMatchObject({
      minimum: 11,
      unit: 'count',
    });
  });

  it('emits the resolver work split and cumulative cardinalities', () => {
    const telemetry = {cpuSystemMicroseconds: 0, cpuUserMicroseconds: 0, peakRssBytes: 0, rssBytes: 0};
    const timeline = new IndexPhaseTimeline(0n, telemetry);
    timeline.observe(
      {
        activity: {
          aliasesDiscovered: 13,
          elapsedMilliseconds: 1_000,
          longestTransactionMilliseconds: 125,
          matchingMilliseconds: 700,
          pageCompleted: 2,
          pageTotal: 2,
          pagesCompleted: 5,
          pass: 3,
          referencesCompleted: 80,
          referencesExamined: 240,
          referencesTotal: 80,
          resolved: 61,
          transactionMilliseconds: 250,
          transactionStageMilliseconds: {
            preparingBatch: 20,
            retiringReferences: 30,
            updatingAnalysis: 40,
            writingAliases: 10,
            writingEdges: 150,
          },
        },
        phase: 'resolving',
        subphase: 'references',
      },
      1_000_000_000n,
      telemetry,
    );
    timeline.observe(
      {edges: 240, phase: 'resolving', resolved: 61, subphase: 'complete', symbols: 179},
      1_100_000_000n,
      telemetry,
    );

    const measurements = new Map(
      indexPhaseMeasurements('cold', timeline, false).map(measurement => [measurement.name, measurement.minimum]),
    );
    expect(Object.fromEntries([...measurements].filter(([name]) => name.includes('reference-resolution-')))).toEqual({
      'cold-reference-resolution-aliases-discovered-n1': 13,
      'cold-reference-resolution-longest-transaction-n1': 125,
      'cold-reference-resolution-matching-n1': 700,
      'cold-reference-resolution-pages-n1': 5,
      'cold-reference-resolution-passes-n1': 3,
      'cold-reference-resolution-references-examined-n1': 240,
      'cold-reference-resolution-resolved-n1': 61,
      'cold-reference-resolution-transactions-n1': 250,
      'cold-reference-resolution-transaction-stage-preparing-batch-n1': 20,
      'cold-reference-resolution-transaction-stage-retiring-references-n1': 30,
      'cold-reference-resolution-transaction-stage-updating-analysis-n1': 40,
      'cold-reference-resolution-transaction-stage-writing-aliases-n1': 10,
      'cold-reference-resolution-transaction-stage-writing-edges-n1': 150,
    });
  });

  it('maps the public Bazel control category to the graph node language', () => {
    expect(performanceControlExpectedNodeLanguage('bazel-build')).toBe('starlark');
    expect(performanceControlExpectedNodeLanguage('java')).toBe('java');
    expect(performanceControlExpectedNodeLanguage('kotlin')).toBe('kotlin');
    expect(performanceControlExpectedNodeLanguage('typescript')).toBe('typescript');
  });

  it('scales the v2 monorepo surrogate without losing exact class accounting', () => {
    const profile = productionProfile(
      parseCodeGraphBenchmarkArguments([
        '--profile',
        'production-large',
        '--profile-files',
        '12',
        '--profile-symbols',
        '99',
      ]),
    );

    expect(profile).toMatchObject({
      sourceFiles: 12,
      surrogate: 'threadnote-4.1.0-beta.1-public-monorepo',
      targetGraphSymbols: 99,
      version: 2,
      worktreeChurnScenarioCount: 6,
    });
    expect(profile.classMix.typescriptSourceFiles + profile.classMix.tsxSourceFiles).toBe(12);
    expect(Object.values(profile.classMix).reduce((total, count) => total + count, 0)).toBe(
      profile.targetRepositoryFiles,
    );
    expect(profile.targetRepositoryFiles - profile.targetEligibleFiles).toBe(
      profile.classMix.generatedSvgFiles + profile.classMix.duplicateHeavyJsonFiles,
    );
    expect(profile.lowSignalJsonExclusionThresholdBytes).toBe(262_144);
    expect(profile.highSignalConfigHardCapBytes).toBe(1_048_576);
    expect(profile.activeWorkspaceExcludedSourceFiles).toBeLessThan(profile.sourceFiles);
  });

  it('keeps the sanitized direct-staging claims, timings, digests, and documentation consistent', () => {
    const evidence = readJson(BETA30_STAGING_EVIDENCE) as {
      readonly observations: readonly {
        readonly bytes?: Readonly<Record<string, number>>;
        readonly digests?: Readonly<Record<string, string>>;
        readonly milliseconds?: Readonly<Record<string, number>>;
        readonly name: string;
        readonly parity?: Readonly<Record<string, boolean>>;
        readonly reviewedClaims?: Readonly<Record<string, boolean | number>>;
      }[];
      readonly provenance: {
        readonly sourceArtifactSha256: Readonly<Record<string, string>>;
      };
    };
    const direct = evidence.observations.find(
      observation => observation.name === 'direct-persistent-materialization-10000',
    );
    expect(direct).toBeDefined();
    expect(evidence.provenance.sourceArtifactSha256['direct-persistent-10000']).toBe(
      '70ec59ed97e41ca085101fcc5fd58d759758a3094b4ec7ec2fc145f5039b511e',
    );
    expect(direct!.milliseconds).toEqual({
      'cold-activation-lexical-only': 667.274583,
      'cold-index': 10548.8525,
      'cold-inventory-and-extraction': 1812.783208,
      'cold-materialization': 5468.52625,
      'cold-post-committed-scan-overlay-and-workspace': 155.001584,
      'cold-pre-activation': 9881.577917,
      'cold-pre-activation-validation': 37.197625,
      'cold-reference-resolution': 2234.327791,
      'cold-registration-lock-and-database-setup': 210.032875,
      'cold-resolved-fact-accounting': 0.906209,
      'cold-snapshot-promotion': 62.470125,
      'cold-snapshot-write-and-checkpoint': 556.407083,
      'cold-vector-index': 0,
      'hot-exact-lexical-query': 208.784416,
      'one-file-reindex-activation-lexical-only': 377.245708,
      'one-file-reindex-index': 852.131708,
      'one-file-reindex-inventory-and-extraction': 32.3295,
      'one-file-reindex-materialization': 20.32775,
      'one-file-reindex-post-committed-scan-overlay-and-workspace': 19.5815,
      'one-file-reindex-pre-activation': 474.886,
      'one-file-reindex-pre-activation-validation': 77.896625,
      'one-file-reindex-reference-resolution': 161.245292,
      'one-file-reindex-registration-lock-and-database-setup': 240.196833,
      'one-file-reindex-resolved-fact-accounting': 1.205125,
      'one-file-reindex-snapshot-promotion': 156.893917,
      'one-file-reindex-snapshot-write-and-checkpoint': 131.654333,
      'one-file-reindex-vector-index': 0,
      'whole-graph-structural-analysis': 522.250625,
    });
    expect(direct!.bytes?.sqliteTempDatabasePagesHighWater).toBe(0);
    expect(direct!.reviewedClaims).toMatchObject({
      coldActivationCopyStagesObserved: 0,
      directPersistentPathObserved: true,
      releaseEvidenceEligible: false,
      temporaryDatabasePagesObserved: false,
    });
    const digests = direct!.digests!;
    expect(Object.values(digests)).toHaveLength(6);
    expect(Object.values(digests).every(digest => /^[0-9a-f]{64}$/.test(digest))).toBe(true);
    expect(digests.primaryQueryCold).toBe(digests.primaryQueryIncremental);
    expect(digests.primaryQueryIncremental).toBe(digests.primaryQuerySameOverlayReference);
    expect(digests.structuralGraphCold).not.toBe(digests.structuralGraphIncremental);
    expect(digests.structuralGraphIncremental).toBe(digests.structuralGraphSameOverlayReference);
    expect(direct!.parity).toEqual({
      coldGraphDiffersAfterTheOneFileMutation: true,
      incrementalGraphMatchesIndependentSameOverlayRebuild: true,
      primaryQueryAcrossColdIncrementalAndReference: true,
    });

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/\/Users\/|[A-Za-z]:\\Users\\|threadnote:\/\/|src\/workspaces\//);
    const documentation = readFileSync('apps/threadnote/test/evaluation/README.md', 'utf8');
    const normalizedDocumentation = documentation.replace(/\s+/g, ' ');
    for (const [phase, value] of [
      ['cold-snapshot-write-and-checkpoint', 556.407083],
      ['cold-snapshot-promotion', 62.470125],
      ['one-file-reindex-snapshot-write-and-checkpoint', 131.654333],
      ['one-file-reindex-snapshot-promotion', 156.893917],
    ] as const) {
      expect(direct!.milliseconds?.[phase]).toBe(value);
      expect(documentation).toContain(`\`${phase}\`: ${value.toFixed(3)} ms`);
    }
    expect(documentation).toContain('Snapshot write-and-checkpoint ends at promotion start');
    for (const claim of [
      'beta30-staging-development.json',
      'zero observed TEMP database pages',
      'query parity across all three builds',
      'structural parity between the incremental overlay and its independent full rebuild',
    ]) {
      expect(normalizedDocumentation).toContain(claim);
    }
  });

  it('rejects missing, dirty, or mismatched release-source provenance', () => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );

    expect(() => assertProductionReleaseEvidence(artifact)).not.toThrow();
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, oneFileReindexMaterializationMode: 'full'},
      }),
    ).toThrow(/incremental-overlay materialization mode/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, releaseEvidenceRef: '', releaseEvidenceSha: ''},
      }),
    ).toThrow(/clean exact release source provenance/);
    expect(() =>
      assertProductionReleaseEvidence({...artifact, environment: {...artifact.environment, dirty: true}}),
    ).toThrow(/clean exact release source provenance/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, releaseEvidenceSha: 'f'.repeat(40)},
      }),
    ).toThrow(/clean exact release source provenance/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, releaseEvidenceResolvedSha: 'f'.repeat(40)},
      }),
    ).toThrow(/clean exact release source provenance/);
  });

  it('accepts exact canonical Threadnote 4-or-newer release tags in completed evidence', () => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );
    const withRef = (releaseEvidenceRef: string): BenchmarkArtifactV1 => ({
      ...artifact,
      metadata: {...artifact.metadata, releaseEvidenceRef},
    });

    expect(() => assertProductionReleaseEvidence(withRef('refs/tags/v4.1.0-beta.1'))).not.toThrow();
    expect(() => assertProductionReleaseEvidence(withRef('refs/tags/v5.0.2'))).not.toThrow();
    for (const ref of ['refs/tags/v4.1.0-beta', 'refs/tags/v3.1.0', 'refs/tags/v5.01.0', 'refs/heads/v4.1.0']) {
      expect(() => assertProductionReleaseEvidence(withRef(ref))).toThrow(/clean exact release source provenance/);
    }
  });

  it('requires the declared release ref to resolve to the measured checkout commit', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    expect(resolvedReleaseEvidenceSource('refs/tags/v4.0.0-beta.30', commit, commit, commit, false)).toEqual({
      ref: 'refs/tags/v4.0.0-beta.30',
      resolvedSha: commit,
      sha: commit,
      harnessCommit: commit,
      harnessDeltaPaths: '[]',
      sourceMode: 'exact-release',
    });
    const sha256Commit = 'a'.repeat(64);
    expect(
      resolvedReleaseEvidenceSource('refs/tags/v4.0.0-beta.30', sha256Commit, sha256Commit, sha256Commit, false),
    ).toMatchObject({sha: sha256Commit});
    for (const invalidLength of [39, 41, 63, 65]) {
      const invalidCommit = 'a'.repeat(invalidLength);
      expect(() =>
        resolvedReleaseEvidenceSource('refs/tags/v4.0.0-beta.30', invalidCommit, invalidCommit, invalidCommit, false),
      ).toThrow(/locally resolvable tag/);
    }
    expect(() =>
      resolvedReleaseEvidenceSource('refs/tags/v4.0.0-beta.30', commit, 'f'.repeat(40), commit, false),
    ).toThrow(/locally resolvable tag/);
    expect(() => resolvedReleaseEvidenceSource('refs/heads/main', commit, commit, commit, false)).toThrow(
      /locally resolvable tag/,
    );
    expect(() => resolvedReleaseEvidenceSource('refs/tags/v4.0.0-beta.30', commit, commit, commit, true)).toThrow(
      /clean exact commit|clean descendant/,
    );
  });

  it('accepts every canonical stable, beta, and RC Threadnote 4-or-newer tag', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const majorVersionNumber = fc.integer({max: 10_000, min: 4});
    const versionNumber = fc.integer({max: 10_000, min: 0});
    const prerelease = fc.option(fc.tuple(fc.constantFrom('beta', 'rc'), versionNumber), {nil: undefined});

    fc.assert(
      fc.property(majorVersionNumber, versionNumber, versionNumber, prerelease, (major, minor, patch, channel) => {
        const suffix = channel === undefined ? '' : `-${channel[0]}.${channel[1]}`;
        const ref = `refs/tags/v${major}.${minor}.${patch}${suffix}`;

        expect(resolvedReleaseEvidenceSource(ref, commit, commit, commit, false)).toEqual({
          ref,
          resolvedSha: commit,
          sha: commit,
          harnessCommit: commit,
          harnessDeltaPaths: '[]',
          sourceMode: 'exact-release',
        });
      }),
      {numRuns: 250},
    );
  });

  it('accepts a clean release descendant only when every runtime delta is a reviewed harness path', () => {
    const releaseCommit = '0'.repeat(40);
    const harnessCommit = '1'.repeat(40);
    const reviewedPaths = ['scripts/benchmark-code-graph.ts', 'src/evaluation/external_evidence.ts'];

    expect(releaseEvidenceSourcePathspecs).toEqual(
      expect.arrayContaining([
        'apps/website/tools/site-performance-evidence.ts',
        ':(glob)packages/*/src/**',
        ':(glob)packages/*/package.json',
        ':(glob)packages/*/assets/**',
        ':(glob)packages/*/static/**',
      ]),
    );

    expect(
      resolvedReleaseEvidenceSource(
        'refs/tags/v4.3.1',
        releaseCommit,
        releaseCommit,
        harnessCommit,
        false,
        ['apps/website/tools/site-performance-evidence.ts'],
        true,
      ),
    ).toMatchObject({
      harnessDeltaPaths: '["apps/website/tools/site-performance-evidence.ts"]',
      sourceMode: 'release-plus-reviewed-harness-delta',
    });

    expect(
      resolvedReleaseEvidenceSource(
        'refs/tags/v4.3.1',
        releaseCommit,
        releaseCommit,
        harnessCommit,
        false,
        reviewedPaths,
        true,
      ),
    ).toEqual({
      ref: 'refs/tags/v4.3.1',
      resolvedSha: releaseCommit,
      sha: releaseCommit,
      harnessCommit,
      harnessDeltaPaths: JSON.stringify(reviewedPaths),
      sourceMode: 'release-plus-reviewed-harness-delta',
    });
    expect(() =>
      resolvedReleaseEvidenceSource(
        'refs/tags/v4.3.1',
        releaseCommit,
        releaseCommit,
        harnessCommit,
        false,
        ['src/code_graph.ts'],
        true,
      ),
    ).toThrow(/reviewed harness changes/);
    expect(() =>
      resolvedReleaseEvidenceSource(
        'refs/tags/v4.3.1',
        releaseCommit,
        releaseCommit,
        harnessCommit,
        false,
        [...reviewedPaths, 'packages/graph/src/indexer.ts'],
        true,
      ),
    ).toThrow(/reviewed harness changes/);
    expect(() =>
      resolvedReleaseEvidenceSource(
        'refs/tags/v4.3.1',
        releaseCommit,
        releaseCommit,
        harnessCommit,
        false,
        reviewedPaths,
        false,
      ),
    ).toThrow(/reviewed harness changes/);
  });

  it('accepts exactly the non-empty unique subsets of reviewed harness paths', () => {
    const releaseCommit = '0'.repeat(40);
    const harnessCommit = '1'.repeat(40);
    const reviewedPaths = [
      'scripts/benchmark-code-graph.ts',
      'apps/website/tools/site-performance-evidence.ts',
      'packages/evidence/src/external-evidence.ts',
      'scripts/site-performance-evidence.ts',
      'src/evaluation/external_evidence.ts',
    ] as const;

    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...reviewedPaths), {maxLength: reviewedPaths.length, minLength: 1}),
        paths => {
          const result = resolvedReleaseEvidenceSource(
            'refs/tags/v4.3.1',
            releaseCommit,
            releaseCommit,
            harnessCommit,
            false,
            paths,
            true,
          );
          expect(JSON.parse(result.harnessDeltaPaths)).toEqual([...paths].sort());
          expect(result.sourceMode).toBe('release-plus-reviewed-harness-delta');
          expect(() =>
            resolvedReleaseEvidenceSource(
              'refs/tags/v4.3.1',
              releaseCommit,
              releaseCommit,
              harnessCommit,
              false,
              [...paths, 'src/code_graph.ts'],
              true,
            ),
          ).toThrow(/reviewed harness changes/);
        },
      ),
      {numRuns: 50},
    );
  });

  it.each([
    'refs/tags/v3.9.9',
    'refs/tags/v9007199254740992.0.0',
    'refs/tags/v4.0',
    'refs/tags/v4.0.1-alpha.1',
    'refs/tags/v4.0.1-beta',
    'refs/tags/v4.00.1',
    'refs/heads/v4.0.1',
  ])('rejects non-canonical or pre-Threadnote-4 release ref %s', ref => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    expect(() => resolvedReleaseEvidenceSource(ref, commit, commit, commit, false)).toThrow(/locally resolvable tag/);
  });

  it('requires aggregate materialization evidence in every production-large artifact', () => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );

    expect(() => assertProductionReleaseEvidence(artifact)).not.toThrow();
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.filter(measurement => measurement.name !== 'cold-materialization'),
      }),
    ).toThrow(/cold-materialization/);
  });

  it('requires transaction-observed main and sorted-sidecar storage high-water evidence', () => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );
    const withValues = (values: Readonly<Record<string, number>>) => ({
      ...artifact,
      measurements: artifact.measurements.map(measurement =>
        values[measurement.name] === undefined
          ? measurement
          : benchmarkMeasurement(measurement.name, measurement.unit, [values[measurement.name]]),
      ),
    });

    expect(() =>
      assertProductionReleaseEvidence(withValues({'cold-materialization-sidecar-database-high-water-n1': 0})),
    ).toThrow(/cold sorted-sidecar database high-water/);
    expect(() =>
      assertProductionReleaseEvidence(withValues({'cold-materialization-sidecar-journal-high-water-n1': 0})),
    ).toThrow(/cold sorted-sidecar journal high-water/);
    expect(() =>
      assertProductionReleaseEvidence(withValues({'cold-materialization-sidecar-wal-high-water-n1': 1})),
    ).toThrow(/cold sorted-sidecar WAL exclusion/);
    expect(() =>
      assertProductionReleaseEvidence(
        withValues({
          'one-file-reindex-materialization-durable-journal-high-water-n1': 0,
          'one-file-reindex-materialization-durable-wal-high-water-n1': 0,
        }),
      ),
    ).toThrow(/one-file-reindex materialization journal\/WAL high-water/);
  });

  it.each([
    'production-shape-file-target-attainment',
    'production-shape-repository-file-target-attainment',
    'production-shape-excluded-file-target-attainment',
    'production-shape-symbol-target-attainment',
    'production-shape-edge-target-attainment',
    'production-shape-lexical-term-target-attainment',
  ])('rejects production evidence when %s misses the reviewed shape floor', measurementName => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );
    const belowFloor = PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT - 0.001;

    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === measurementName
            ? benchmarkMeasurement(measurement.name, 'percent', [belowFloor])
            : measurement,
        ),
      }),
    ).toThrow(
      new RegExp(
        `${measurementName} expected at least ${PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT}% target attainment`,
      ),
    );
  });

  it('rejects a reduced development profile even when it attains its smaller declared targets', () => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        profileDeclarationSymbols: 9,
        profileSourceFiles: 4,
        profileTargetEdges: 68,
        profileTargetEligibleFiles: 16,
        profileTargetLexicalTermRows: 300,
        profileTargetSymbols: 20,
        profileWorkspaces: 4,
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );

    expect(() => assertProductionReleaseEvidence(artifact)).toThrow(/reviewed default production-large profile/);

    const reviewed = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v2',
    );
    expect(() =>
      assertProductionReleaseEvidence({
        ...reviewed,
        metadata: {
          ...reviewed.metadata,
          profileClassGeneratedSvgFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.classMix.generatedSvgFiles - 1,
        },
      }),
    ).toThrow(/reviewed default production-large profile/);
  });

  it('retains exact-tag evidence for the governed hosted reduced profile without treating it as the full profile', () => {
    const reducedProfile = productionProfile(
      parseCodeGraphBenchmarkArguments([
        '--profile',
        'production-large',
        '--profile-files',
        '3000',
        '--profile-symbols',
        '110000',
        '--minimum-free-gib',
        '20',
      ]),
    );
    const governedMetadata = {
      ...productionProfileArtifactMetadata(reducedProfile),
      benchmarkGoverned: true,
      benchmarkMinimumFreeBytes: 20 * 1_073_741_824,
      benchmarkPrimaryAvailableBytesAtStart: 30 * 1_073_741_824,
      benchmarkReferenceAvailableBytesAtStart: 30 * 1_073_741_824,
      coldMaterializationStorageMode: 'direct-persistent',
      oneFileReindexMaterializationMode: 'incremental-overlay',
      runtimePlatform: 'linux',
      sameOverlayReferenceMaterializationMode: 'full',
      sqliteVersion: '3.49.1',
      vectorEnabled: false,
    } as const;
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      governedMetadata,
      'code-graph-production-large-v2',
    );

    expect(() => assertGovernedReducedProductionReleaseEvidence(artifact)).not.toThrow();
    expect(() => assertProductionReleaseEvidence(artifact)).toThrow(/reviewed default production-large profile/);
    expect(() =>
      assertGovernedReducedProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, releaseEvidenceSha: 'f'.repeat(40)},
      }),
    ).toThrow(/clean exact release source provenance/);
    expect(() =>
      assertGovernedReducedProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, benchmarkMinimumFreeBytes: 19 * 1_073_741_824},
      }),
    ).toThrow(/governed hosted reduced production profile/);
    expect(() =>
      assertGovernedReducedProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'production-shape-symbol-target-attainment'
            ? benchmarkMeasurement(measurement.name, measurement.unit, [89])
            : measurement,
        ),
      }),
    ).toThrow(/production-shape-symbol-target-attainment expected at least 90% target attainment/);

    fc.assert(
      fc.property(
        fc.integer({min: 2_800, max: 3_200}),
        fc.integer({min: 105_000, max: 115_000}),
        (sourceFiles, targetSymbols) => {
          if (sourceFiles === 3_000 && targetSymbols === 110_000) return;
          const profile = productionProfile({
            profile: 'production-large',
            profileFiles: sourceFiles,
            profileSymbols: targetSymbols,
          });
          const candidate = {
            ...artifact,
            metadata: {...artifact.metadata, ...productionProfileArtifactMetadata(profile)},
          };
          expect(() => assertGovernedReducedProductionReleaseEvidence(candidate)).toThrow(
            /governed hosted reduced production profile/,
          );
        },
      ),
      {numRuns: 40},
    );
  });

  it('retains and requires split replay, storage planning, and relationship deduplication counters', () => {
    expect(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS).toEqual(
      expect.arrayContaining([
        {name: 'cold-materialization-attributed-files-n1', unit: 'count'},
        {name: 'cold-materialization-cached-fact-bytes-total-n1', unit: 'bytes'},
        {name: 'cold-materialization-cached-fact-replay-bytes-n1', unit: 'bytes'},
        {name: 'cold-materialization-changed-fact-bytes-n1', unit: 'bytes'},
        {name: 'cold-materialization-cross-generation-shard-files-n1', unit: 'count'},
        {name: 'cold-materialization-exact-generation-shard-files-n1', unit: 'count'},
        {name: 'cold-materialization-estimated-temp-filesystem-required-n1', unit: 'bytes'},
        {name: 'cold-materialization-estimated-durable-filesystem-required-n1', unit: 'bytes'},
        {name: 'cold-materialization-temp-filesystem-available-n1', unit: 'bytes'},
        {name: 'cold-materialization-durable-filesystem-available-n1', unit: 'bytes'},
        {name: 'cold-materialization-filesystems-shared-n1', unit: 'count'},
        {name: 'cold-materialization-materialized-shard-cache-deferred-files-n1', unit: 'count'},
        {name: 'cold-materialization-materialized-shard-cache-deferred-raw-fact-bytes-n1', unit: 'bytes'},
        {name: 'cold-materialization-materialized-shard-replay-bytes-n1', unit: 'bytes'},
        {name: 'cold-materialization-raw-fact-replay-bytes-n1', unit: 'bytes'},
        {name: 'cold-materialization-deduplicated-edge-rows-n1', unit: 'count'},
        {name: 'cold-materialization-deduplicated-reference-rows-n1', unit: 'count'},
        {name: 'cold-materialization-durable-database-growth-high-water-n1', unit: 'bytes'},
        {name: 'cold-materialization-durable-filesystem-high-water-n1', unit: 'bytes'},
        {name: 'cold-materialization-durable-journal-high-water-n1', unit: 'bytes'},
        {name: 'cold-materialization-durable-wal-high-water-n1', unit: 'bytes'},
        {name: 'cold-materialization-sidecar-database-high-water-n1', unit: 'bytes'},
        {name: 'cold-materialization-sidecar-journal-high-water-n1', unit: 'bytes'},
        {name: 'cold-materialization-sidecar-wal-high-water-n1', unit: 'bytes'},
        {name: 'one-file-reindex-materialization-deduplicated-edge-rows-n1', unit: 'count'},
        {name: 'one-file-reindex-materialization-deduplicated-reference-rows-n1', unit: 'count'},
        {name: 'cold-materialization-stage-restoring-indexes-n1', unit: 'milliseconds'},
        {name: 'same-overlay-reference-materialization-stage-restoring-indexes-n1', unit: 'milliseconds'},
        {name: 'one-file-reindex-materialization-stage-restoring-indexes-n1', unit: 'milliseconds'},
        {name: 'same-overlay-reference-materialization-attributed-files-n1', unit: 'count'},
        {name: 'same-overlay-reference-materialization-cached-fact-bytes-total-n1', unit: 'bytes'},
        {name: 'same-overlay-reference-materialization-cached-fact-replay-bytes-n1', unit: 'bytes'},
        {name: 'same-overlay-reference-materialization-changed-fact-bytes-n1', unit: 'bytes'},
        {name: 'same-overlay-reference-materialization-cross-generation-shard-files-n1', unit: 'count'},
        {name: 'same-overlay-reference-materialization-exact-generation-shard-files-n1', unit: 'count'},
        {
          name: 'same-overlay-reference-materialization-materialized-shard-cache-deferred-files-n1',
          unit: 'count',
        },
        {
          name: 'same-overlay-reference-materialization-materialized-shard-cache-deferred-raw-fact-bytes-n1',
          unit: 'bytes',
        },
        {name: 'same-overlay-reference-materialization-materialized-shard-replay-bytes-n1', unit: 'bytes'},
        {name: 'same-overlay-reference-materialization-raw-fact-replay-bytes-n1', unit: 'bytes'},
      ]),
    );
    const retained = new Map(
      materializationStorageMeasurements('cold', {
        attributedFilesCompleted: 6,
        cachedFactBytesTotal: 10,
        cachedFactReplayBytesCompleted: 12,
        changedFactBytesCompleted: 2,
        crossGenerationShardFilesCompleted: 0,
        durableAvailableBytes: 20,
        durableDatabaseGrowthHighWaterBytes: 60,
        durableFilesystemHighWaterBytes: 70,
        durableJournalHighWaterBytes: 80,
        durableSidecarDatabaseHighWaterBytes: 90,
        durableSidecarJournalHighWaterBytes: 100,
        durableSidecarWalHighWaterBytes: 0,
        durableWalHighWaterBytes: 110,
        estimateBasis: 'cached-fact-bytes',
        estimatedDurableFilesystemRequiredBytes: 30,
        estimatedTemporaryFilesystemRequiredBytes: 40,
        filesystemsShared: false,
        exactGenerationShardFilesCompleted: 3,
        materializedShardCacheDeferredFilesCompleted: 2,
        materializedShardCacheDeferredRawFactBytesCompleted: 4,
        materializedShardReplayBytesCompleted: 8,
        rawFactReplayBytesCompleted: 4,
        temporaryAvailableBytes: 50,
      }).map(measurement => [measurement.name, measurement.minimum]),
    );
    expect(retained).toEqual(
      new Map([
        ['cold-materialization-attributed-files-n1', 6],
        ['cold-materialization-cached-fact-bytes-total-n1', 10],
        ['cold-materialization-cached-fact-replay-bytes-n1', 12],
        ['cold-materialization-changed-fact-bytes-n1', 2],
        ['cold-materialization-cross-generation-shard-files-n1', 0],
        ['cold-materialization-exact-generation-shard-files-n1', 3],
        ['cold-materialization-materialized-shard-cache-deferred-files-n1', 2],
        ['cold-materialization-materialized-shard-cache-deferred-raw-fact-bytes-n1', 4],
        ['cold-materialization-materialized-shard-replay-bytes-n1', 8],
        ['cold-materialization-raw-fact-replay-bytes-n1', 4],
        ['cold-materialization-estimated-temp-filesystem-required-n1', 40],
        ['cold-materialization-estimated-durable-filesystem-required-n1', 30],
        ['cold-materialization-temp-filesystem-available-n1', 50],
        ['cold-materialization-durable-filesystem-available-n1', 20],
        ['cold-materialization-durable-database-growth-high-water-n1', 60],
        ['cold-materialization-durable-filesystem-high-water-n1', 70],
        ['cold-materialization-durable-journal-high-water-n1', 80],
        ['cold-materialization-durable-wal-high-water-n1', 110],
        ['cold-materialization-sidecar-database-high-water-n1', 90],
        ['cold-materialization-sidecar-journal-high-water-n1', 100],
        ['cold-materialization-sidecar-wal-high-water-n1', 0],
        ['cold-materialization-filesystems-shared-n1', 0],
      ]),
    );

    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );
    for (const missing of [
      'cold-materialization-attributed-files-n1',
      'cold-materialization-cached-fact-replay-bytes-n1',
      'cold-materialization-changed-fact-bytes-n1',
      'cold-materialization-cross-generation-shard-files-n1',
      'cold-materialization-exact-generation-shard-files-n1',
      'cold-materialization-materialized-shard-replay-bytes-n1',
      'cold-materialization-raw-fact-replay-bytes-n1',
      'cold-materialization-estimated-temp-filesystem-required-n1',
      'cold-materialization-estimated-durable-filesystem-required-n1',
      'cold-materialization-deduplicated-edge-rows-n1',
      'cold-materialization-deduplicated-reference-rows-n1',
      'same-overlay-reference-materialization-attributed-files-n1',
      'same-overlay-reference-materialization-cached-fact-replay-bytes-n1',
      'same-overlay-reference-materialization-changed-fact-bytes-n1',
      'same-overlay-reference-materialization-cross-generation-shard-files-n1',
      'same-overlay-reference-materialization-exact-generation-shard-files-n1',
      'same-overlay-reference-materialization-materialized-shard-replay-bytes-n1',
      'same-overlay-reference-materialization-raw-fact-replay-bytes-n1',
    ]) {
      expect(() =>
        assertProductionReleaseEvidence({
          ...artifact,
          measurements: artifact.measurements.filter(measurement => measurement.name !== missing),
        }),
      ).toThrow(new RegExp(missing));
    }
    for (const prefix of ['cold', 'same-overlay-reference'] as const) {
      expect(() =>
        assertProductionReleaseEvidence({
          ...artifact,
          measurements: artifact.measurements.map(measurement =>
            measurement.name === `${prefix}-materialization-cached-fact-replay-bytes-n1`
              ? benchmarkMeasurement(measurement.name, 'bytes', [3])
              : measurement,
          ),
        }),
      ).toThrow(new RegExp(`${prefix} materialization replay-byte equation`));
    }
  });

  it('requires query-index restoration for full builds and excludes it from sparse overlays', () => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v2',
    );
    const withDuration = (name: string, value: number): BenchmarkArtifactV1 => ({
      ...artifact,
      measurements: artifact.measurements.map(measurement =>
        measurement.name === name ? benchmarkMeasurement(name, measurement.unit, [value]) : measurement,
      ),
    });

    expect(() => assertProductionReleaseEvidence(artifact)).not.toThrow();
    expect(() =>
      assertProductionReleaseEvidence(withDuration('cold-materialization-stage-restoring-indexes-n1', 0)),
    ).toThrow(/cold full-build query-index restoration/);
    expect(() =>
      assertProductionReleaseEvidence(
        withDuration('same-overlay-reference-materialization-stage-restoring-indexes-n1', 0),
      ),
    ).toThrow(/same-overlay-reference full-build query-index restoration/);

    fc.assert(
      fc.property(fc.integer({max: 60_000, min: 1}), duration => {
        expect(() =>
          assertProductionReleaseEvidence(
            withDuration('one-file-reindex-materialization-stage-restoring-indexes-n1', duration),
          ),
        ).toThrow(/one-file reindex query-index restoration exclusion/);
      }),
      {numRuns: 50},
    );
  });

  it('requires large full builds to defer the complete duplicate materialized-shard cache', () => {
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v2',
    );
    const withValues = (values: Readonly<Record<string, number>>): BenchmarkArtifactV1 => ({
      ...artifact,
      measurements: artifact.measurements.map(measurement =>
        values[measurement.name] === undefined
          ? measurement
          : benchmarkMeasurement(measurement.name, measurement.unit, [values[measurement.name]]),
      ),
    });

    expect(() => assertProductionReleaseEvidence(artifact)).not.toThrow();
    expect(() =>
      assertProductionReleaseEvidence(
        withValues({'cold-materialization-materialized-shard-cache-deferred-files-n1': 0}),
      ),
    ).toThrow(/cold large-build materialized-shard cache deferral/);
    expect(() =>
      assertProductionReleaseEvidence(
        withValues({
          'cold-materialization-cached-fact-replay-bytes-n1':
            CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 1,
          'cold-materialization-cached-fact-bytes-total-n1':
            CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM,
          'cold-materialization-materialized-shard-cache-deferred-files-n1': 0,
          'cold-materialization-materialized-shard-cache-deferred-raw-fact-bytes-n1': 0,
          'cold-materialization-raw-fact-replay-bytes-n1':
            CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM,
        }),
      ),
    ).not.toThrow();
    fc.assert(
      fc.property(
        fc.integer({max: CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM, min: 0}),
        deferredRawFactBytes => {
          expect(() =>
            assertProductionReleaseEvidence(
              withValues({
                'cold-materialization-cached-fact-bytes-total-n1': deferredRawFactBytes,
                'cold-materialization-cached-fact-replay-bytes-n1': deferredRawFactBytes + 1,
                'cold-materialization-materialized-shard-cache-deferred-raw-fact-bytes-n1': deferredRawFactBytes,
                'cold-materialization-raw-fact-replay-bytes-n1': deferredRawFactBytes,
              }),
            ),
          ).toThrow(/cold bounded-build materialized-shard cache persistence/);
        },
      ),
      {numRuns: 50},
    );
  });

  it('generates exhaustive independent ratchets from governed production observations', () => {
    const governed = (coldIndexMilliseconds: number, sampledPhase: string): BenchmarkArtifactV1 =>
      benchmarkArtifact(
        [
          ...requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
          benchmarkMeasurement('cold-index', 'milliseconds', [coldIndexMilliseconds]),
          benchmarkMeasurement('hot-exact-lexical-query', 'milliseconds', [coldIndexMilliseconds + 200]),
          benchmarkMeasurement('hot-query-process-cpu', 'milliseconds', [coldIndexMilliseconds + 100]),
          benchmarkMeasurement('mcp-impact-duration', 'milliseconds', [coldIndexMilliseconds + 50]),
          benchmarkMeasurement('cold-registration-lock-and-database-setup', 'milliseconds', [coldIndexMilliseconds]),
          benchmarkMeasurement('cold-registration-process-cpu-n1', 'milliseconds', [coldIndexMilliseconds]),
          benchmarkMeasurement('cold-process-peak-rss', 'bytes', [512 * 1_048_576 + coldIndexMilliseconds]),
          benchmarkMeasurement('incremental-process-peak-rss', 'bytes', [512 * 1_048_576 + coldIndexMilliseconds]),
          benchmarkMeasurement('cold-sqlite-wal-peak-observed', 'bytes', [coldIndexMilliseconds]),
          benchmarkMeasurement('same-overlay-reference-registration-lock-and-database-setup', 'milliseconds', [
            coldIndexMilliseconds + 10,
          ]),
          benchmarkMeasurement('cold-materialization-stage-committing-n1', 'milliseconds', [100]),
          benchmarkMeasurement('one-file-reindex-materialization-stage-committing-n1', 'milliseconds', [100]),
          benchmarkMeasurement('same-overlay-reference-materialization-stage-committing-n1', 'milliseconds', [100]),
          benchmarkMeasurement('cold-materialization-stage-preparing-rows-n1', 'milliseconds', [100]),
          benchmarkMeasurement('cold-hosted-subphase-n1', 'milliseconds', [1_000]),
          benchmarkMeasurement('cold-hosted-microphase-n1', 'milliseconds', [128]),
          benchmarkMeasurement('cold-zero-duration-n1', 'milliseconds', [0]),
          benchmarkMeasurement('hosted-sampler-samples-n1', 'count', [coldIndexMilliseconds]),
          benchmarkMeasurement('one-file-reindex-index', 'milliseconds', [29_000]),
          benchmarkMeasurement('one-file-reindex-post-committed-scan-overlay-and-workspace', 'milliseconds', [4_900]),
          benchmarkMeasurement('one-file-reindex-registration-lock-and-database-setup', 'milliseconds', [4_900]),
          benchmarkMeasurement(`${sampledPhase}-external-process-cpu-n1`, 'milliseconds', [17]),
        ],
        {
          benchmarkDiskFilesystem: 'apfs',
          benchmarkDiskLocation: 'internal',
          benchmarkDiskMedium: 'solid-state',
          benchmarkFilesystemsShared: true,
          benchmarkGoverned: true,
          benchmarkMinimumFreeBytes: 120 * 1_073_741_824,
          benchmarkPrimaryAvailableBytesAtStart: 140 * 1_073_741_824,
          benchmarkReferenceAvailableBytesAtStart: 140 * 1_073_741_824,
          benchmarkReferenceDiskFilesystem: 'apfs',
          benchmarkReferenceDiskLocation: 'internal',
          benchmarkReferenceDiskMedium: 'solid-state',
          coldEdges: 3,
          coldFiles: 2,
          coldMaterializationStorageMode: 'direct-persistent',
          coldSymbols: 5,
          effectiveParserMemoryBytes: 64 * 1_073_741_824,
          effectiveParserWorkers: 4,
          oneFileReindexMaterializationMode: 'incremental-overlay',
          oneFileReindexMaterializationStorageMode: 'unreported',
          primaryQueryStructuralDigestCold: '1'.repeat(64),
          primaryQueryStructuralDigestIncremental: '2'.repeat(64),
          primaryQueryStructuralDigestSameOverlayReference: '2'.repeat(64),
          retrievalMode: 'lexical-only',
          runnerClass: 'governed-test',
          runtimePlatform: 'darwin',
          sameOverlayReferenceMaterializationMode: 'full',
          sameOverlayReferenceMaterializationStorageMode: 'direct-persistent',
          sqlitePageSizeBytes: 8192,
          sqliteVersion: '3.49.1',
          structuralGraphDigestCold: coldIndexMilliseconds.toString(16).padStart(64, '0'),
          structuralGraphDigestIncremental: (coldIndexMilliseconds + 1).toString(16).padStart(64, '0'),
          structuralGraphDigestSameOverlayReference: (coldIndexMilliseconds + 1).toString(16).padStart(64, '0'),
          vectorEnabled: false,
        },
        'code-graph-production-large-v2',
      );
    const artifacts = [
      governed(100, 'cold-scanning-progress'),
      governed(105, 'cold-materializing-progress'),
      governed(110, 'cold-resolving-references'),
    ];
    const ratchet = createCodeGraphProductionRatchet(artifacts);

    const cleanRebuilds = artifacts.map((artifact, index) => ({
      ...artifact,
      metadata: {
        ...artifact.metadata,
        benchmarkValidatedManagedExecutableSha256: (index + 1).toString(16).repeat(64),
        benchmarkValidatedManagedPayloadManifestSha256: (index + 4).toString(16).repeat(64),
      },
    }));

    expect(() => createCodeGraphProductionRatchet(artifacts.slice(0, 2))).toThrow(/at least three artifacts/);
    expect(createCodeGraphProductionRatchet(cleanRebuilds)).toEqual(ratchet);
    expect(
      createCodeGraphProductionRatchet(
        artifacts.map((artifact, index) => ({
          ...artifact,
          environment: {
            ...artifact.environment,
            cpu: `governed-pool-cpu-${index}`,
            memoryBytes: artifact.environment.memoryBytes + index * 1_073_741_824,
            operatingSystem: `macOS 27.${index}`,
          },
          metadata: {
            ...artifact.metadata,
            effectiveParserMemoryBytes:
              (artifact.metadata.effectiveParserMemoryBytes as number) + index * 1_073_741_824,
          },
        })),
      ),
    ).toEqual(ratchet);
    expect(ratchet.environment).toEqual({
      architecture: artifacts[0].environment.architecture,
      dirty: false,
      fixtureHash: artifacts[0].environment.fixtureHash,
      node: artifacts[0].environment.node,
      packageManager: artifacts[0].environment.packageManager,
      runner: artifacts[0].environment.runner,
      runnerVersion: artifacts[0].environment.runnerVersion,
    });
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[0-9a-f]{64}$/u), {maxLength: 6, minLength: 6}), rebuildDigests => {
        const rebuilt = artifacts.map((artifact, index) => ({
          ...artifact,
          metadata: {
            ...artifact.metadata,
            benchmarkValidatedManagedExecutableSha256: rebuildDigests[index * 2],
            benchmarkValidatedManagedPayloadManifestSha256: rebuildDigests[index * 2 + 1],
          },
        }));
        expect(createCodeGraphProductionRatchet(rebuilt)).toEqual(ratchet);
      }),
      {numRuns: 25},
    );
    expect(() =>
      createCodeGraphProductionRatchet([
        ...artifacts.slice(0, 2),
        {
          ...artifacts[2],
          metadata: {
            ...artifacts[2].metadata,
            benchmarkValidatedManagedReleaseMetadataSha256: 'f'.repeat(64),
          },
        },
      ]),
    ).toThrow(/exact source\/runtime\/storage contract/);
    expect(ratchet.measurements['cold-index']).toMatchObject({p95Maximum: 210, unit: 'milliseconds'});
    expect(ratchet.measurements['cold-materialization-stage-preparing-rows-n1']).toMatchObject({
      p95Maximum: 400,
    });
    expect(ratchet.measurements['cold-hosted-subphase-n1']).toMatchObject({p95Maximum: 1_750});
    expect(ratchet.measurements['cold-hosted-microphase-n1']).toMatchObject({p95Maximum: 428});
    expect(ratchet.measurements['cold-materialization-stage-preparing-rows-n1']).not.toHaveProperty('minimum');
    expect(ratchet.measurements['cold-zero-duration-n1']).toMatchObject({p95Maximum: 300, unit: 'milliseconds'});
    expect(ratchet.measurements['hosted-sampler-samples-n1']).toMatchObject({minimum: 1, unit: 'count'});
    expect(ratchet.measurements['hosted-sampler-samples-n1']).not.toHaveProperty('maximum');
    expect(ratchet.measurements['cold-materialized-file-rows']).toMatchObject({maximum: 1, minimum: 1});
    const nonIncreasingWorkMeasurements = [
      'one-file-reindex-incremental-work-attribution-context-files-n1',
      'one-file-reindex-incremental-work-base-facts-loaded-n1',
      'one-file-reindex-incremental-work-inventory-files-inspected-n1',
      'one-file-reindex-incremental-work-planned-rows-n1',
      'one-file-reindex-incremental-work-probed-dependency-paths-n1',
    ];
    for (const name of nonIncreasingWorkMeasurements) {
      expect(ratchet.measurements[name]).toMatchObject({maximum: 1, unit: 'count'});
      expect(ratchet.measurements[name]).not.toHaveProperty('minimum');
    }
    expect(ratchet.measurements['cold-external-rss-peak-observed-n1']).toMatchObject({p95Maximum: 1_048_576});
    expect(ratchet.measurements['cold-external-rss-peak-observed-n1']).not.toHaveProperty('minimum');
    for (const [registrationName, multiplier] of [
      ['cold-registration-lock-and-database-setup', 6],
      ['same-overlay-reference-registration-lock-and-database-setup', 3],
    ] as const) {
      const observedMaximum = Math.max(
        ...artifacts.map(
          artifact => artifact.measurements.find(measurement => measurement.name === registrationName)!.p50,
        ),
      );
      expect(ratchet.measurements[registrationName]).toMatchObject({
        p95Maximum: Math.min(Math.ceil(observedMaximum * multiplier), 4_999),
      });
    }
    fc.assert(
      fc.property(
        fc.integer({max: 4_999, min: 1}),
        fc.integer({max: 4_999, min: 1}),
        (coldRegistration, referenceRegistration) => {
          const registrations: Readonly<Record<string, number>> = {
            'cold-registration-lock-and-database-setup': coldRegistration,
            'same-overlay-reference-registration-lock-and-database-setup': referenceRegistration,
          };
          const varied = artifacts.map(artifact => ({
            ...artifact,
            measurements: artifact.measurements.map(measurement =>
              registrations[measurement.name] === undefined
                ? measurement
                : benchmarkMeasurement(measurement.name, measurement.unit, [registrations[measurement.name]]),
            ),
          }));
          const variedRatchet = createCodeGraphProductionRatchet(varied);
          for (const [name, observed, multiplier] of [
            ['cold-registration-lock-and-database-setup', coldRegistration, 6],
            ['same-overlay-reference-registration-lock-and-database-setup', referenceRegistration, 3],
          ] as const) {
            expect(variedRatchet.measurements[name]).toMatchObject({
              p95Maximum: Math.min(Math.ceil(Math.max(observed * multiplier, observed + 100)), 4_999),
            });
          }
        },
      ),
      {numRuns: 25},
    );
    fc.assert(
      fc.property(fc.integer({max: 10_000, min: 1}), samplerCount => {
        const observed = {
          ...artifacts[0],
          measurements: artifacts[0].measurements.map(measurement =>
            measurement.name === 'hosted-sampler-samples-n1'
              ? benchmarkMeasurement(measurement.name, measurement.unit, [samplerCount])
              : measurement,
          ),
        };
        expect(() => enforceCodeGraphBenchmarkRatchet(observed, ratchet)).not.toThrow();
      }),
      {numRuns: 30},
    );
    const missingCoverage = {
      ...artifacts[0],
      measurements: artifacts[0].measurements.map(measurement =>
        measurement.name === 'hosted-sampler-samples-n1'
          ? benchmarkMeasurement(measurement.name, measurement.unit, [0])
          : measurement,
      ),
    };
    expect(() => enforceCodeGraphBenchmarkRatchet(missingCoverage, ratchet)).toThrow(/hosted-sampler-samples-n1/);
    expect(ratchet.measurements['one-file-reindex-index']).toMatchObject({p95Maximum: 29_999});
    expect(ratchet.measurements['one-file-reindex-registration-lock-and-database-setup']).toMatchObject({
      p95Maximum: 4_999,
    });
    expect(ratchet.measurements['one-file-reindex-post-committed-scan-overlay-and-workspace']).toMatchObject({
      p95Maximum: 4_999,
    });
    expect(ratchet.metadata).toMatchObject({
      benchmarkDiskLocation: 'internal',
      benchmarkReferenceDiskLocation: 'internal',
    });
    expect(ratchet.metadata).not.toHaveProperty('structuralGraphDigestCold');
    const overTarget = artifacts.map(artifact => ({
      ...artifact,
      measurements: artifact.measurements.map(measurement =>
        measurement.name === 'one-file-reindex-index'
          ? benchmarkMeasurement(measurement.name, measurement.unit, [30_000])
          : measurement,
      ),
    }));
    expect(() => createCodeGraphProductionRatchet(overTarget)).toThrow(
      /objective one-file-reindex-index has not been attained/,
    );
    const overRegistrationTarget = artifacts.map(artifact => ({
      ...artifact,
      measurements: artifact.measurements.map(measurement =>
        measurement.name === 'cold-registration-lock-and-database-setup'
          ? benchmarkMeasurement(measurement.name, measurement.unit, [5_000])
          : measurement,
      ),
    }));
    expect(() => createCodeGraphProductionRatchet(overRegistrationTarget)).toThrow(
      /objective cold-registration-lock-and-database-setup has not been attained/,
    );
    for (const governedName of [
      'cold-registration-process-cpu-n1',
      'one-file-reindex-incremental-work-planned-rows-n1',
      'cold-sqlite-wal-peak-observed',
    ]) {
      const governedLimit = ratchet.measurements[governedName];
      expect(governedLimit, governedName).toBeDefined();
      const maximum = governedLimit.maximum ?? governedLimit.p95Maximum!;
      const regression = {
        ...artifacts[0],
        measurements: artifacts[0].measurements.map(measurement =>
          measurement.name === governedName
            ? benchmarkMeasurement(measurement.name, measurement.unit, [maximum + 1])
            : measurement,
        ),
      };
      expect(() => enforceCodeGraphBenchmarkRatchet(regression, ratchet)).toThrow(new RegExp(governedName));
    }
    expect(Object.keys(ratchet.measurements)).toHaveLength(artifacts[0].measurements.length - 8);
    expect(Object.keys(ratchet.measurements).some(name => name.includes('-progress-external-'))).toBe(false);
    expect(Object.keys(ratchet.measurements).some(name => name.endsWith('-boundary-rss-n1'))).toBe(false);
    expect(
      Object.keys(ratchet.measurements).some(name => name.endsWith('-external-process-tree-maximum-sample-gap-n1')),
    ).toBe(false);
    expect(Object.keys(ratchet.measurements).some(name => name.endsWith('-filesystem-available-n1'))).toBe(false);
    expect(ratchet.measurements['cold-external-rss-peak-observed-n1']).toBeDefined();
    expect(() => enforceCodeGraphBenchmarkRatchet(artifacts[0], ratchet)).not.toThrow();
    for (const name of nonIncreasingWorkMeasurements) {
      const withWork = (value: number): BenchmarkArtifactV1 => ({
        ...artifacts[0],
        measurements: artifacts[0].measurements.map(measurement =>
          measurement.name === name ? benchmarkMeasurement(name, 'count', [value]) : measurement,
        ),
      });
      expect(() => enforceCodeGraphBenchmarkRatchet(withWork(0), ratchet)).not.toThrow();
      expect(() => enforceCodeGraphBenchmarkRatchet(withWork(2), ratchet)).toThrow(new RegExp(name));
    }
    fc.assert(
      fc.property(fc.integer({max: 200 * 1_073_741_824, min: 20 * 1_073_741_824}), availableBytes => {
        const expandedCapacity = {
          ...artifacts[0],
          metadata: {
            ...artifacts[0].metadata,
            benchmarkPrimaryAvailableBytesAtStart: availableBytes,
            benchmarkReferenceAvailableBytesAtStart: availableBytes,
          },
          measurements: artifacts[0].measurements.map(measurement =>
            measurement.name.endsWith('-filesystem-available-n1')
              ? benchmarkMeasurement(measurement.name, measurement.unit, [availableBytes])
              : measurement,
          ),
        };
        expect(() => enforceCodeGraphBenchmarkRatchet(expandedCapacity, ratchet)).not.toThrow();
      }),
      {numRuns: 30},
    );
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        {
          ...artifacts[0],
          measurements: [
            ...artifacts[0].measurements,
            benchmarkMeasurement('future-stable-production-metric', 'count', [1]),
          ],
        },
        ratchet,
      ),
    ).toThrow(/stable production measurement set changed.*future-stable-production-metric/u);
    const scaledArtifacts = artifacts.map(artifact => ({
      ...artifact,
      metadata: {
        ...artifact.metadata,
        benchmarkMinimumFreeBytes: 20 * 1_073_741_824,
        benchmarkPrimaryAvailableBytesAtStart: 30 * 1_073_741_824,
        benchmarkReferenceAvailableBytesAtStart: 30 * 1_073_741_824,
        profileSourceFiles: 3_000,
        profileTargetEligibleFiles: 4_926,
        profileTargetSymbols: 110_000,
      },
    }));
    const scaledRatchet = createCodeGraphProductionRatchet(scaledArtifacts);
    expect(scaledRatchet.metadata).toMatchObject({
      benchmarkMinimumFreeBytes: 20 * 1_073_741_824,
      profileSourceFiles: 3_000,
      profileTargetEligibleFiles: 4_926,
      profileTargetSymbols: 110_000,
    });
    for (const artifact of scaledArtifacts) {
      expect(() => enforceCodeGraphBenchmarkRatchet(artifact, scaledRatchet)).not.toThrow();
    }
    const githubHostedArtifacts = scaledArtifacts.map(artifact => ({
      ...artifact,
      metadata: {
        ...artifact.metadata,
        benchmarkDiskFilesystem: 'overlayfs',
        benchmarkDiskLocation: 'unknown',
        benchmarkDiskMedium: 'virtual-or-network',
        benchmarkReferenceDiskFilesystem: 'overlayfs',
        benchmarkReferenceDiskLocation: 'unknown',
        benchmarkReferenceDiskMedium: 'virtual-or-network',
        runnerClass: 'github-hosted-linux-x64',
        runtimePlatform: 'linux',
      },
    }));
    const githubHostedRatchet = createCodeGraphProductionRatchet(githubHostedArtifacts);
    expect(githubHostedRatchet.metadata).not.toHaveProperty('benchmarkDiskFilesystem');
    expect(githubHostedRatchet.metadata).not.toHaveProperty('benchmarkDiskLocation');
    expect(githubHostedRatchet.metadata).not.toHaveProperty('benchmarkDiskMedium');
    expect(githubHostedRatchet.metadata).not.toHaveProperty('benchmarkReferenceDiskFilesystem');
    expect(githubHostedRatchet.metadata).not.toHaveProperty('benchmarkReferenceDiskLocation');
    expect(githubHostedRatchet.metadata).not.toHaveProperty('benchmarkReferenceDiskMedium');
    const pairedArtifact = (
      artifact: BenchmarkArtifactV1,
      commit: string,
      measurementValues: Readonly<Record<string, number>>,
      createdAt = artifact.createdAt,
    ): BenchmarkArtifactV1 => ({
      ...artifact,
      createdAt,
      environment: {...artifact.environment, commit},
      measurements: artifact.measurements.map(measurement =>
        measurementValues[measurement.name] === undefined
          ? measurement
          : benchmarkMeasurement(measurement.name, measurement.unit, [measurementValues[measurement.name]]),
      ),
      metadata: {
        ...artifact.metadata,
        benchmarkMeasuredSourceCommit: commit,
        runnerIdentity: 'runner-0123456789abcdef',
        sameRunnerComparisonKey: 'github-hosted-linux-x64|Linux|x64|Intel test|17179869184',
      },
    });
    const controlCommit = 'a'.repeat(40);
    const candidateCommit = 'b'.repeat(40);
    const sandwichStart = Date.parse('2026-08-28T00:00:00.000Z');
    const sandwichTime = (minutes: number) => new Date(sandwichStart + minutes * 60_000).toISOString();
    const pairedInitialCandidateArtifact = pairedArtifact(
      githubHostedArtifacts[0],
      candidateCommit,
      {'cold-index': 1_200},
      sandwichTime(0),
    );
    const pairedControlArtifact = pairedArtifact(
      githubHostedArtifacts[0],
      controlCommit,
      {'cold-index': 1_000},
      sandwichTime(10),
    );
    const noisyCandidate = pairedArtifact(
      githubHostedArtifacts[0],
      candidateCommit,
      {'cold-index': 1_200},
      sandwichTime(20),
    );
    const pairedControl = {
      artifact: pairedControlArtifact,
      expectedCandidateCommit: candidateCommit,
      expectedCommit: controlCommit,
      initialCandidateArtifact: pairedInitialCandidateArtifact,
    };
    const sandwichCandidate = (measurementValues: Readonly<Record<string, number>>) =>
      pairedArtifact(githubHostedArtifacts[0], candidateCommit, measurementValues, sandwichTime(20));
    const sandwichControl = (measurementValues: Readonly<Record<string, number>>) =>
      pairedArtifact(githubHostedArtifacts[0], controlCommit, measurementValues, sandwichTime(10));
    const sandwichEvidence = (
      initialMeasurementValues: Readonly<Record<string, number>>,
      controlArtifact = pairedControlArtifact,
    ) => ({
      artifact: controlArtifact,
      expectedCandidateCommit: candidateCommit,
      expectedCommit: controlCommit,
      initialCandidateArtifact: pairedArtifact(
        githubHostedArtifacts[0],
        candidateCommit,
        initialMeasurementValues,
        sandwichTime(0),
      ),
    });

    expect(() => enforceCodeGraphBenchmarkRatchet(noisyCandidate, githubHostedRatchet)).toThrow(/cold-index/u);
    expect(() => enforceCodeGraphBenchmarkRatchet(noisyCandidate, githubHostedRatchet, pairedControl)).not.toThrow();
    const bootstrapProcessCountName = 'bootstrap-external-process-count-peak-observed-n1';
    const bootstrapProcessCountLimit: CodeGraphBenchmarkMeasurementRatchetV1 = {
      maximum: 4,
      samplesMinimum: 1,
      unit: 'count',
    };
    const bootstrapProcessCountRatchet = {
      ...githubHostedRatchet,
      measurements: {
        ...githubHostedRatchet.measurements,
        [bootstrapProcessCountName]: bootstrapProcessCountLimit,
      },
    };
    const withProcessCount = (artifact: BenchmarkArtifactV1, name: string, value: number): BenchmarkArtifactV1 => ({
      ...artifact,
      measurements: [
        ...artifact.measurements.filter(measurement => measurement.name !== name),
        benchmarkMeasurement(name, 'count', [value]),
      ],
    });
    const bootstrapProcessCountCandidate = (value: number) =>
      withProcessCount(sandwichCandidate({}), bootstrapProcessCountName, value);
    const bootstrapProcessCountEvidence = (initial: number, control: number) => {
      const evidence = sandwichEvidence({}, sandwichControl({}));
      return {
        ...evidence,
        artifact: withProcessCount(evidence.artifact, bootstrapProcessCountName, control),
        initialCandidateArtifact: withProcessCount(
          evidence.initialCandidateArtifact,
          bootstrapProcessCountName,
          initial,
        ),
      };
    };
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        bootstrapProcessCountCandidate(2),
        bootstrapProcessCountRatchet,
        bootstrapProcessCountEvidence(5, 2),
      ),
    ).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        bootstrapProcessCountCandidate(2),
        bootstrapProcessCountRatchet,
        bootstrapProcessCountEvidence(6, 2),
      ),
    ).toThrow(/initial candidate bootstrap-external-process-count-peak-observed-n1/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        bootstrapProcessCountCandidate(2),
        bootstrapProcessCountRatchet,
        bootstrapProcessCountEvidence(4.5, 2),
      ),
    ).toThrow(/initial candidate bootstrap-external-process-count-peak-observed-n1/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        bootstrapProcessCountCandidate(2),
        bootstrapProcessCountRatchet,
        bootstrapProcessCountEvidence(5, 5),
      ),
    ).toThrow(/initial candidate bootstrap-external-process-count-peak-observed-n1/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        bootstrapProcessCountCandidate(5),
        bootstrapProcessCountRatchet,
        bootstrapProcessCountEvidence(5, 2),
      ),
    ).toThrow(/remeasured candidate bootstrap-external-process-count-peak-observed-n1/u);
    const widenedBootstrapProcessCountRatchet = {
      ...bootstrapProcessCountRatchet,
      measurements: {
        ...bootstrapProcessCountRatchet.measurements,
        [bootstrapProcessCountName]: {...bootstrapProcessCountLimit, maximum: 5},
      },
    };
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        bootstrapProcessCountCandidate(5),
        widenedBootstrapProcessCountRatchet,
        bootstrapProcessCountEvidence(6, 5),
      ),
    ).toThrow(/initial candidate bootstrap-external-process-count-peak-observed-n1/u);
    const coldProcessCountName = 'cold-external-process-count-peak-observed-n1';
    const coldProcessCountRatchet = {
      ...githubHostedRatchet,
      measurements: {
        ...githubHostedRatchet.measurements,
        [coldProcessCountName]: {
          maximum: 8,
          samplesMinimum: 1,
          unit: 'count',
        } satisfies CodeGraphBenchmarkMeasurementRatchetV1,
      },
    };
    const coldProcessCountEvidence = sandwichEvidence({}, sandwichControl({}));
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        withProcessCount(sandwichCandidate({}), coldProcessCountName, 6),
        coldProcessCountRatchet,
        {
          ...coldProcessCountEvidence,
          artifact: withProcessCount(coldProcessCountEvidence.artifact, coldProcessCountName, 6),
          initialCandidateArtifact: withProcessCount(
            coldProcessCountEvidence.initialCandidateArtifact,
            coldProcessCountName,
            9,
          ),
        },
      ),
    ).toThrow(/initial candidate cold-external-process-count-peak-observed-n1/u);
    fc.assert(
      fc.property(
        fc.integer({max: 80, min: 0}).map(value => value / 10),
        initialMaximum => {
          const enforce = () =>
            enforceCodeGraphBenchmarkRatchet(
              bootstrapProcessCountCandidate(2),
              bootstrapProcessCountRatchet,
              bootstrapProcessCountEvidence(initialMaximum, 2),
            );
          if (initialMaximum <= 4 || initialMaximum === 5) expect(enforce).not.toThrow();
          else expect(enforce).toThrow(new RegExp(bootstrapProcessCountName));
        },
      ),
      {numRuns: 40},
    );
    const confirmatoryWallName = 'hot-exact-lexical-query';
    const confirmatoryWallLimit = (p95Maximum: number): CodeGraphBenchmarkMeasurementRatchetV1 => ({
      p95Maximum,
      samplesMinimum: 1,
      unit: 'milliseconds',
    });
    const confirmatoryWallRatchet = (p95Maximum: number) => ({
      ...githubHostedRatchet,
      measurements: {
        ...githubHostedRatchet.measurements,
        [confirmatoryWallName]: confirmatoryWallLimit(p95Maximum),
      },
    });
    const calibratedConfirmatoryWallEvidence = sandwichEvidence(
      {[confirmatoryWallName]: 295.779441},
      sandwichControl({[confirmatoryWallName]: 319.953012}),
    );
    const registrationName = 'same-overlay-reference-registration-lock-and-database-setup';
    const registrationRatchet = {
      ...githubHostedRatchet,
      measurements: {...githubHostedRatchet.measurements, [registrationName]: confirmatoryWallLimit(888)},
    };
    const registrationCandidate = sandwichCandidate({[registrationName]: 319.786313});
    const registrationEvidence = sandwichEvidence(
      {[registrationName]: 966.326097},
      sandwichControl({[registrationName]: 269.651538}),
    );
    // PR #405: the screening registration observation missed static 888 ms,
    // but all three observations met the independent 4,999 ms objective.
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(registrationEvidence.initialCandidateArtifact, registrationRatchet),
    ).toThrow(/same-overlay-reference-registration-lock-and-database-setup p95/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(registrationCandidate, registrationRatchet, registrationEvidence),
    ).not.toThrow();
    for (const role of ['initialCandidateArtifact', 'artifact'] as const) {
      const observation = registrationEvidence[role];
      for (const [mutated, expectedFailure] of [
        [{...observation, createdAt: registrationCandidate.createdAt}, /creation times/u],
        [{...observation, metadata: {...observation.metadata, runnerIdentity: 'another-runner'}}, /runnerIdentity/u],
        [{...observation, environment: {...observation.environment, fixtureHash: 'another-fixture'}}, /fixtureHash/u],
        [
          {
            ...observation,
            environment: {...observation.environment, commit: 'c'.repeat(40)},
            metadata: {...observation.metadata, benchmarkMeasuredSourceCommit: 'c'.repeat(40)},
          },
          /candidate commit|control commit/u,
        ],
      ] as const) {
        expect(() =>
          enforceCodeGraphBenchmarkRatchet(registrationCandidate, registrationRatchet, {
            ...registrationEvidence,
            [role]: mutated,
          }),
        ).toThrow(expectedFailure);
      }
    }
    const objectiveWallMetrics = [
      ['cold-index', 3_599_999],
      ['cold-registration-lock-and-database-setup', 4_999],
      ['cold-reference-resolution-longest-transaction-n1', 14_999],
      ['one-file-reindex-index', 29_999],
      ['one-file-reindex-post-committed-scan-overlay-and-workspace', 4_999],
      ['one-file-reindex-registration-lock-and-database-setup', 4_999],
      ['one-file-reindex-reference-resolution-longest-transaction-n1', 14_999],
      [registrationName, 4_999],
      ['same-overlay-reference-reference-resolution-longest-transaction-n1', 14_999],
    ] as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...objectiveWallMetrics),
        fc.integer({max: 90, min: 10}),
        ([name, hardMaximum], percent) => {
          const staticMaximum = Math.floor((hardMaximum * percent) / 100);
          const objectiveRatchet = {
            ...githubHostedRatchet,
            measurements: {...githubHostedRatchet.measurements, [name]: confirmatoryWallLimit(staticMaximum)},
          };
          const enforce = (initial: number, control: number, repeat: number) =>
            enforceCodeGraphBenchmarkRatchet(
              sandwichCandidate({[name]: repeat}),
              objectiveRatchet,
              sandwichEvidence({[name]: initial}, sandwichControl({[name]: control})),
            );
          // The hard boundary remains inclusive even when static is much lower.
          expect(() => enforce(hardMaximum, staticMaximum, staticMaximum)).not.toThrow();
          for (const role of [0, 1, 2]) {
            const observations = [staticMaximum, staticMaximum, staticMaximum];
            observations[role] = hardMaximum + 1;
            expect(() => enforce(observations[0], observations[1], observations[2])).toThrow(
              new RegExp(`objective ${name} has not been attained`),
            );
          }
          // Passing screening cannot grant objective metrics even a tiny tail.
          expect(() => enforce(staticMaximum, staticMaximum, staticMaximum + 0.001)).toThrow(
            new RegExp(`remeasured candidate ${name}`),
          );
          expect(() => enforce(staticMaximum + 1, staticMaximum, staticMaximum + 1)).toThrow(new RegExp(name));
        },
      ),
      {numRuns: 40},
    );
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({[confirmatoryWallName]: 492.101135}),
        confirmatoryWallRatchet(489),
        calibratedConfirmatoryWallEvidence,
      ),
    ).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({[confirmatoryWallName]: 319.953012}),
        confirmatoryWallRatchet(489),
        sandwichEvidence({[confirmatoryWallName]: 652.779737}, sandwichControl({[confirmatoryWallName]: 319.953012})),
      ),
    ).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({[confirmatoryWallName]: 493.891}),
        confirmatoryWallRatchet(489),
        calibratedConfirmatoryWallEvidence,
      ),
    ).toThrow(/remeasured candidate hot-exact-lexical-query/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({[confirmatoryWallName]: 492.101135}),
        confirmatoryWallRatchet(489),
        sandwichEvidence({[confirmatoryWallName]: 492.101135}, sandwichControl({[confirmatoryWallName]: 319.953012})),
      ),
    ).toThrow(/hot-exact-lexical-query/u);
    const multipleConfirmatoryTailRatchet = {
      ...confirmatoryWallRatchet(489),
      measurements: {
        ...confirmatoryWallRatchet(489).measurements,
        'mcp-impact-duration': confirmatoryWallLimit(295),
      },
    };
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({
          [confirmatoryWallName]: 492.101135,
          'mcp-impact-duration': 297.5,
        }),
        multipleConfirmatoryTailRatchet,
        sandwichEvidence(
          {
            [confirmatoryWallName]: 295.779441,
            'mcp-impact-duration': 100,
          },
          sandwichControl({
            [confirmatoryWallName]: 319.953012,
            'mcp-impact-duration': 101.908737,
          }),
        ),
      ),
    ).toThrow(/confirmatory wall tail tolerance is singular/u);
    fc.assert(
      fc.property(
        fc.integer({max: 10_000, min: 100}),
        fc.double({max: 1, min: 0, noNaN: true}),
        (p95Maximum, fraction) => {
          const tolerance = Math.min(p95Maximum * 0.01, 5);
          const staticPass = p95Maximum - 1;
          const evidence = sandwichEvidence(
            {[confirmatoryWallName]: staticPass},
            sandwichControl({[confirmatoryWallName]: staticPass}),
          );
          expect(() =>
            enforceCodeGraphBenchmarkRatchet(
              sandwichCandidate({[confirmatoryWallName]: p95Maximum + tolerance * fraction}),
              confirmatoryWallRatchet(p95Maximum),
              evidence,
            ),
          ).not.toThrow();
          expect(() =>
            enforceCodeGraphBenchmarkRatchet(
              sandwichCandidate({[confirmatoryWallName]: p95Maximum + tolerance + 0.001}),
              confirmatoryWallRatchet(p95Maximum),
              evidence,
            ),
          ).toThrow(new RegExp(confirmatoryWallName));
        },
      ),
      {numRuns: 30},
    );
    const correctedRssCandidate = sandwichCandidate({
      'cold-index': 1_200,
      'cold-process-peak-rss': 930_451_456,
      'incremental-process-peak-rss': 930_451_456,
    });
    const mixedEraRssEvidence = sandwichEvidence(
      {
        'cold-index': 1_200,
        'cold-process-peak-rss': 935_190_528,
        'incremental-process-peak-rss': 935_190_528,
      },
      sandwichControl({
        'cold-index': 1_000,
        // The protected-base artifact predates byte normalization and retains native Linux KiB numerics.
        'cold-process-peak-rss': 915_952,
        'incremental-process-peak-rss': 915_952,
      }),
    );
    const mixedEraRssRatchet = {
      ...githubHostedRatchet,
      measurements: {
        ...githubHostedRatchet.measurements,
        'cold-process-peak-rss': {
          ...githubHostedRatchet.measurements['cold-process-peak-rss'],
          p95Maximum: 1_223_690_240,
        },
        'incremental-process-peak-rss': {
          ...githubHostedRatchet.measurements['incremental-process-peak-rss'],
          p95Maximum: 1_223_690_240,
        },
      },
    };
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(correctedRssCandidate, mixedEraRssRatchet, mixedEraRssEvidence),
    ).not.toThrow();
    fc.assert(
      fc.property(fc.integer({max: 500, min: -500}), fc.integer({max: 50_000, min: 30_000}), (slope, regression) => {
        const baseline = 100_000;
        const remeasuredMinute = 25;
        const initialValue = baseline;
        const controlValue = baseline + slope * 10;
        const remeasuredValue = baseline + slope * remeasuredMinute;
        const linearControl = sandwichControl({'cold-index': controlValue});
        const linearCandidate = (value: number) =>
          pairedArtifact(
            githubHostedArtifacts[0],
            candidateCommit,
            {'cold-index': value},
            sandwichTime(remeasuredMinute),
          );
        expect(() =>
          enforceCodeGraphBenchmarkRatchet(
            linearCandidate(remeasuredValue),
            githubHostedRatchet,
            sandwichEvidence({'cold-index': initialValue}, linearControl),
          ),
        ).not.toThrow();
        expect(() =>
          enforceCodeGraphBenchmarkRatchet(
            linearCandidate(remeasuredValue + regression),
            githubHostedRatchet,
            sandwichEvidence({'cold-index': initialValue + regression}, linearControl),
          ),
        ).toThrow(/cold-index.*bounded candidate sandwich.*exact protected-base control/u);
      }),
      {numRuns: 30},
    );
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({'cold-index': 140_000}),
        githubHostedRatchet,
        sandwichEvidence({'cold-index': 80_000}, sandwichControl({'cold-index': 100_000})),
      ),
    ).toThrow(/candidate sandwich dispersion cold-index/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({'cold-index': 1_251}),
        githubHostedRatchet,
        sandwichEvidence({'cold-index': 1_251}),
      ),
    ).toThrow(/cold-index.*exact protected-base control/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({'cold-index': 211}),
        githubHostedRatchet,
        sandwichEvidence({'cold-index': 211}, sandwichControl({'cold-index': 210})),
      ),
    ).toThrow(/cold-index/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({'one-file-reindex-index': 30_000}),
        githubHostedRatchet,
        sandwichEvidence({'one-file-reindex-index': 30_000}, sandwichControl({'one-file-reindex-index': 30_000})),
      ),
    ).toThrow(/objective one-file-reindex-index has not been attained/u);
    const oneFileIndexObjective = githubHostedRatchet.measurements['one-file-reindex-index'].p95Maximum!;
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({'one-file-reindex-index': oneFileIndexObjective - 1}),
        githubHostedRatchet,
        sandwichEvidence(
          {'one-file-reindex-index': oneFileIndexObjective + 1},
          sandwichControl({'one-file-reindex-index': oneFileIndexObjective - 1}),
        ),
      ),
    ).toThrow(/initial candidate .*one-file-reindex-index/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({'one-file-reindex-index': oneFileIndexObjective + 1}),
        githubHostedRatchet,
        sandwichEvidence(
          {'one-file-reindex-index': oneFileIndexObjective - 1},
          sandwichControl({'one-file-reindex-index': oneFileIndexObjective - 1}),
        ),
      ),
    ).toThrow(/remeasured candidate .*one-file-reindex-index/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        sandwichCandidate({'one-file-reindex-index': oneFileIndexObjective - 1}),
        githubHostedRatchet,
        sandwichEvidence(
          {'one-file-reindex-index': oneFileIndexObjective - 1},
          sandwichControl({'one-file-reindex-index': oneFileIndexObjective + 1}),
        ),
      ),
    ).toThrow(/paired control .*one-file-reindex-index/u);
    for (const [metadataName, value] of [
      ['runnerIdentity', 'another-runner'],
      ['sameRunnerComparisonKey', 'another-host'],
    ] as const) {
      expect(() =>
        enforceCodeGraphBenchmarkRatchet(noisyCandidate, githubHostedRatchet, {
          ...pairedControl,
          artifact: {
            ...pairedControlArtifact,
            metadata: {...pairedControlArtifact.metadata, [metadataName]: value},
          },
        }),
      ).toThrow(new RegExp(`metadata\\.${metadataName}`));
      expect(() =>
        enforceCodeGraphBenchmarkRatchet(noisyCandidate, githubHostedRatchet, {
          ...pairedControl,
          initialCandidateArtifact: {
            ...pairedInitialCandidateArtifact,
            metadata: {...pairedInitialCandidateArtifact.metadata, [metadataName]: value},
          },
        }),
      ).toThrow(new RegExp(`initial candidate metadata\\.${metadataName}`));
    }
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(noisyCandidate, githubHostedRatchet, {
        ...pairedControl,
        expectedCommit: 'c'.repeat(40),
      }),
    ).toThrow(/paired control commit/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(noisyCandidate, githubHostedRatchet, {
        ...pairedControl,
        expectedCandidateCommit: 'c'.repeat(40),
      }),
    ).toThrow(/paired candidate commit/u);
    const anotherCandidateCommit = 'c'.repeat(40);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(noisyCandidate, githubHostedRatchet, {
        ...pairedControl,
        initialCandidateArtifact: {
          ...pairedInitialCandidateArtifact,
          environment: {...pairedInitialCandidateArtifact.environment, commit: anotherCandidateCommit},
          metadata: {
            ...pairedInitialCandidateArtifact.metadata,
            benchmarkMeasuredSourceCommit: anotherCandidateCommit,
          },
        },
      }),
    ).toThrow(/initial candidate commit/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(noisyCandidate, githubHostedRatchet, {
        ...pairedControl,
        initialCandidateArtifact: {...pairedInitialCandidateArtifact, createdAt: sandwichTime(10)},
      }),
    ).toThrow(/creation times.*strictly ordered/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        {...noisyCandidate, createdAt: sandwichTime(41)},
        githubHostedRatchet,
        pairedControl,
      ),
    ).toThrow(/creation times.*within 40 minutes/u);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(noisyCandidate, githubHostedRatchet, {
        ...pairedControl,
        artifact: {
          ...pairedControlArtifact,
          environment: {...pairedControlArtifact.environment, fixtureHash: 'another-fixture'},
        },
      }),
    ).toThrow(/paired control environment\.fixtureHash/u);
    const invariantGuardNames = [
      'cold-materialized-file-rows',
      'cold-process-peak-rss',
      'cold-registration-process-cpu-n1',
      'incremental-process-peak-rss',
      'one-file-reindex-incremental-work-planned-rows-n1',
      'cold-sqlite-wal-peak-observed',
    ] as const;
    fc.assert(
      fc.property(fc.constantFrom(...invariantGuardNames), fc.integer({max: 10_000, min: 1}), (name, delta) => {
        const limit = githubHostedRatchet.measurements[name];
        const upperBound = limit.maximum ?? limit.p95Maximum;
        expect(upperBound, name).toBeDefined();
        const candidate = sandwichCandidate({
          'cold-index': 1_200,
          [name]: upperBound! + delta,
        });
        expect(() => enforceCodeGraphBenchmarkRatchet(candidate, githubHostedRatchet, pairedControl)).toThrow(
          new RegExp(name),
        );
      }),
      {numRuns: 30},
    );
    fc.assert(
      fc.property(fc.constantFrom(...invariantGuardNames), fc.integer({max: 10_000, min: 1}), (name, delta) => {
        const limit = githubHostedRatchet.measurements[name];
        const upperBound = limit.maximum ?? limit.p95Maximum;
        expect(upperBound, name).toBeDefined();
        const initialOnlyRegression = sandwichEvidence({
          'cold-index': 1_200,
          [name]: upperBound! + delta,
        });
        expect(() =>
          enforceCodeGraphBenchmarkRatchet(noisyCandidate, githubHostedRatchet, initialOnlyRegression),
        ).toThrow(new RegExp(`initial candidate ${name}`));
        for (const role of ['initial', 'repeat'] as const) {
          expect(() =>
            enforceCodeGraphBenchmarkRatchet(
              sandwichCandidate({
                [registrationName]: 319.786313,
                ...(role === 'repeat' ? {[name]: upperBound! + delta} : {}),
              }),
              registrationRatchet,
              sandwichEvidence(
                {[registrationName]: 966.326097, ...(role === 'initial' ? {[name]: upperBound! + delta} : {})},
                registrationEvidence.artifact,
              ),
            ),
          ).toThrow(new RegExp(`${role === 'initial' ? 'initial' : 'remeasured'} candidate ${name}`));
        }
      }),
      {numRuns: 30},
    );
    const cumulativeWorkTimingNames = [
      'cold-inventory-parser-extraction-summed-n1',
      'cold-inventory-parser-fact-serialization-n1',
      'cold-inventory-source-reading-n1',
      'cold-materialization-stage-preparing-rows-n1',
    ] as const;
    fc.assert(
      fc.property(fc.constantFrom(...cumulativeWorkTimingNames), fc.integer({max: 10_000, min: 1}), (name, delta) => {
        const limit = githubHostedRatchet.measurements[name];
        expect(limit.p95Maximum, name).toBeDefined();
        const regressedValue = limit.p95Maximum! + delta;
        const regressedControl = sandwichControl({[name]: regressedValue});
        const regressedCandidate = sandwichCandidate({[name]: regressedValue});
        expect(() =>
          enforceCodeGraphBenchmarkRatchet(
            regressedCandidate,
            githubHostedRatchet,
            sandwichEvidence({[name]: regressedValue}, regressedControl),
          ),
        ).toThrow(new RegExp(name));
      }),
      {numRuns: 30},
    );
    const hostedStorageWallTimingNames = [
      'cold-inventory-cache-persistence-n1',
      'cold-materialization-stage-committing-n1',
      'one-file-reindex-inventory-cache-persistence-n1',
      'one-file-reindex-materialization-stage-committing-n1',
      'same-overlay-reference-inventory-cache-persistence-n1',
      'same-overlay-reference-materialization-stage-committing-n1',
    ] as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...hostedStorageWallTimingNames),
        fc.integer({max: 10_000, min: 1}),
        (name, delta) => {
          const limit = githubHostedRatchet.measurements[name];
          expect(limit.p95Maximum, name).toBeDefined();
          const controlValue = limit.p95Maximum! + delta;
          const control = sandwichControl({[name]: controlValue});
          const candidate = sandwichCandidate({[name]: controlValue});
          const boundedPair = sandwichEvidence({[name]: controlValue}, control);
          expect(() => enforceCodeGraphBenchmarkRatchet(candidate, githubHostedRatchet, boundedPair)).not.toThrow();
          expect(() =>
            enforceCodeGraphBenchmarkRatchet(
              sandwichCandidate({[name]: controlValue * 4 + 1_000}),
              githubHostedRatchet,
              sandwichEvidence({[name]: controlValue * 4 + 1_000}, control),
            ),
          ).toThrow(new RegExp(`${name}.*exact protected-base control`));
        },
      ),
      {numRuns: 30},
    );
    expect(
      createCodeGraphProductionRatchet(
        githubHostedArtifacts.map((artifact, index) => {
          const filesystem = ['overlayfs', 'ext4', 'unknown'][index];
          return {
            ...artifact,
            metadata: {
              ...artifact.metadata,
              benchmarkDiskFilesystem: filesystem,
              benchmarkDiskLocation: ['unknown', 'virtual-or-network', 'external'][index],
              benchmarkDiskMedium: ['virtual-or-network', 'rotational', 'unknown'][index],
              benchmarkReferenceDiskFilesystem: filesystem,
              benchmarkReferenceDiskLocation: ['virtual-or-network', 'unknown', 'external'][index],
              benchmarkReferenceDiskMedium: ['unknown', 'solid-state', 'rotational'][index],
            },
          };
        }),
      ),
    ).toEqual(githubHostedRatchet);
    fc.assert(
      fc.property(
        fc.constantFrom('unknown', 'overlayfs', 'ext4'),
        fc.constantFrom('unknown', 'rotational', 'solid-state', 'virtual-or-network'),
        fc.constantFrom('unknown', 'internal', 'external', 'virtual-or-network'),
        (filesystem, medium, location) => {
          expect(() =>
            enforceCodeGraphBenchmarkRatchet(
              {
                ...githubHostedArtifacts[0],
                metadata: {
                  ...githubHostedArtifacts[0].metadata,
                  benchmarkDiskFilesystem: filesystem,
                  benchmarkDiskLocation: location,
                  benchmarkDiskMedium: medium,
                  benchmarkReferenceDiskFilesystem: filesystem,
                  benchmarkReferenceDiskLocation: location,
                  benchmarkReferenceDiskMedium: medium,
                },
              },
              githubHostedRatchet,
            ),
          ).not.toThrow();
        },
      ),
      {numRuns: 50},
    );
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            filesystem: fc.constantFrom('unknown', 'overlayfs', 'ext4'),
            location: fc.constantFrom('unknown', 'internal', 'external', 'virtual-or-network'),
            medium: fc.constantFrom('unknown', 'rotational', 'solid-state', 'virtual-or-network'),
            referenceLocation: fc.constantFrom('unknown', 'internal', 'external', 'virtual-or-network'),
            referenceMedium: fc.constantFrom('unknown', 'rotational', 'solid-state', 'virtual-or-network'),
          }),
          {maxLength: githubHostedArtifacts.length, minLength: githubHostedArtifacts.length},
        ),
        observations => {
          const rebuilt = githubHostedArtifacts.map((artifact, index) => ({
            ...artifact,
            metadata: {
              ...artifact.metadata,
              benchmarkDiskFilesystem: observations[index].filesystem,
              benchmarkDiskLocation: observations[index].location,
              benchmarkDiskMedium: observations[index].medium,
              benchmarkReferenceDiskFilesystem: observations[index].filesystem,
              benchmarkReferenceDiskLocation: observations[index].referenceLocation,
              benchmarkReferenceDiskMedium: observations[index].referenceMedium,
            },
          }));
          expect(createCodeGraphProductionRatchet(rebuilt)).toEqual(githubHostedRatchet);
        },
      ),
      {numRuns: 30},
    );
    expect(() =>
      createCodeGraphProductionRatchet(
        githubHostedArtifacts.map(artifact => ({
          ...artifact,
          metadata: {...artifact.metadata, benchmarkReferenceDiskMedium: 'unknown'},
        })),
      ),
    ).not.toThrow();
    expect(() =>
      createCodeGraphProductionRatchet(
        githubHostedArtifacts.map(artifact => ({
          ...artifact,
          metadata: {...artifact.metadata, benchmarkGithubRunnerEnvironment: 'self-hosted'},
        })),
      ),
    ).toThrow(/governed storage evidence/);
    expect(() =>
      createCodeGraphProductionRatchet(
        githubHostedArtifacts.map(artifact => ({
          ...artifact,
          metadata: {...artifact.metadata, benchmarkReferenceDiskMedium: 'rotational'},
        })),
      ),
    ).not.toThrow();
    expect(() =>
      createCodeGraphProductionRatchet(
        githubHostedArtifacts.map(artifact => ({
          ...artifact,
          metadata: {
            ...artifact.metadata,
            benchmarkGithubRunnerEnvironment: 'self-hosted',
            benchmarkReferenceDiskMedium: 'rotational',
          },
        })),
      ),
    ).toThrow(/governed storage evidence/);
    expect(() =>
      createCodeGraphProductionRatchet(
        scaledArtifacts.map(artifact => ({
          ...artifact,
          metadata: {...artifact.metadata, benchmarkMinimumFreeBytes: 20 * 1_073_741_824 - 1},
        })),
      ),
    ).toThrow(/governed storage evidence/);

    const limit = ratchet.measurements['cold-index'].p95Maximum!;
    const regressed = {
      ...artifacts[0],
      measurements: artifacts[0].measurements.map(measurement =>
        measurement.name === 'cold-index'
          ? benchmarkMeasurement(measurement.name, measurement.unit, [limit + 1])
          : measurement,
      ),
    };
    expect(() => enforceCodeGraphBenchmarkRatchet(regressed, ratchet)).toThrow(/cold-index/);
    fc.assert(
      fc.property(fc.integer({max: 1_000, min: 2}), changedFileRows => {
        const nondeterministic = {
          ...artifacts[2],
          measurements: artifacts[2].measurements.map(measurement =>
            measurement.name === 'cold-materialized-file-rows'
              ? benchmarkMeasurement(measurement.name, measurement.unit, [changedFileRows])
              : measurement,
          ),
        };
        expect(() => createCodeGraphProductionRatchet([...artifacts.slice(0, 2), nondeterministic])).toThrow(
          /deterministic measurement cold-materialized-file-rows disagrees/,
        );
      }),
      {numRuns: 50},
    );
    expect(() =>
      createCodeGraphProductionRatchet([
        ...artifacts.slice(0, 2),
        {
          ...artifacts[2],
          metadata: {...artifacts[2].metadata, benchmarkPrimaryAvailableBytesAtStart: 119 * 1_073_741_824},
        },
      ]),
    ).toThrow(/governed storage evidence/);
  });

  it('retains and requires sampler v4 recursive process-tree and open temporary-file evidence', () => {
    const retained = new Map(
      externalSamplerMeasurements('cold', {
        intervalMilliseconds: 25,
        phases: {
          materializing: {
            cpuMilliseconds: 100,
            databasePeakBytes: 1_000,
            ioReadBytes: 2_000,
            ioWriteBytes: 3_000,
            processPeakCount: 5,
            processSampleAttempts: 7,
            processSampleFailures: 0,
            processSampleGapPeakMilliseconds: 25,
            processSamples: 7,
            rssPeakBytes: 4_000,
            samples: 8,
            shmPeakBytes: 6_000,
            temporaryOpenAttempts: 6,
            temporaryOpenFailures: 0,
            temporaryPeakBytes: 7_000,
            temporaryLinkedPeakBytes: 1_000,
            temporaryOpenPeakBytes: 6_500,
            temporaryOpenSamples: 6,
            walPeakBytes: 8_000,
          },
          scanning: {
            cpuMilliseconds: 10,
            databasePeakBytes: 100,
            ioReadBytes: 200,
            ioWriteBytes: 300,
            processPeakCount: 3,
            processSampleAttempts: 4,
            processSampleFailures: 0,
            processSampleGapPeakMilliseconds: 20,
            processSamples: 4,
            rssPeakBytes: 400,
            samples: 5,
            shmPeakBytes: 600,
            temporaryOpenAttempts: 3,
            temporaryOpenFailures: 0,
            temporaryPeakBytes: 700,
            temporaryLinkedPeakBytes: 100,
            temporaryOpenPeakBytes: 650,
            temporaryOpenSamples: 3,
            walPeakBytes: 800,
          },
        },
        platform: 'linux',
        processTelemetry: {
          availability: 'available',
          ioCounters: 'linux-proc-read-write-bytes',
          parentIdentityValidation: 'linux-proc-starttime',
          sampleIntervalMilliseconds: 25,
          scope: 'recursive-process-tree',
          source: 'linux-proc',
        },
        samples: 13,
        temporaryTelemetry: {
          availability: 'available',
          maximumOpenFileDescriptors: 65_536,
          maximumProcesses: 4_096,
          openFileSampleIntervalMilliseconds: 25,
          scope: 'temporary-root-linked-plus-process-tree-open-files',
          source: 'linux-proc-fd',
        },
        version: 4,
      }).map(measurement => [measurement.name, measurement.minimum]),
    );
    for (const [name, value] of [
      ['cold-external-sampler-version-n1', 4],
      ['cold-external-storage-samples-n1', 13],
      ['cold-external-process-tree-samples-n1', 11],
      ['cold-external-process-tree-attempts-n1', 11],
      ['cold-external-process-tree-failures-n1', 0],
      ['cold-external-process-tree-maximum-sample-gap-n1', 25],
      ['cold-external-process-count-peak-observed-n1', 5],
      ['cold-external-process-cpu-n1', 110],
      ['cold-external-rss-peak-observed-n1', 4_000],
      ['cold-external-process-physical-read-n1', 2_200],
      ['cold-external-process-physical-write-n1', 3_300],
      ['cold-materializing-external-process-samples-n1', 7],
      ['cold-external-open-temp-process-tree-attempts-n1', 9],
      ['cold-external-open-temp-process-tree-failures-n1', 0],
      ['cold-external-open-temp-process-tree-samples-n1', 9],
      ['cold-external-sqlite-temp-combined-peak-observed-n1', 7_000],
      ['cold-external-sqlite-temp-linked-peak-observed-n1', 1_000],
      ['cold-external-sqlite-temp-open-process-tree-peak-observed-n1', 6_500],
    ] as const) {
      expect(retained.get(name)).toBe(value);
    }

    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'cold-external-process-tree-samples-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [0])
            : measurement,
        ),
      }),
    ).toThrow(/cold-external-process-tree-samples-n1 positive result/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'cold-external-process-tree-failures-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [1])
            : measurement,
        ),
      }),
    ).toThrow(/cold-external-process-tree-failures-n1 expected zero inspection loss/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'one-file-reindex-external-sampler-version-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [3])
            : measurement,
        ),
      }),
    ).toThrow(/one-file-reindex-external-sampler-version-n1 expected sampler v4 or newer/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'same-overlay-reference-external-storage-samples-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [0])
            : measurement,
        ),
      }),
    ).toThrow(/same-overlay-reference-external-storage-samples-n1 positive result/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'cold-external-open-temp-process-tree-failures-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [1])
            : measurement,
        ),
      }),
    ).toThrow(/cold-external-open-temp-process-tree-failures-n1 expected zero inspection loss/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: [
          ...artifact.measurements,
          benchmarkMeasurement('bootstrap-external-open-temp-process-tree-failures-n1', 'count', [1]),
        ],
      }),
    ).toThrow(/bootstrap-external-open-temp-process-tree-failures-n1 expected zero inspection loss/);
  });

  it('requires observed per-stage activation evidence for cold and incremental release runs', () => {
    expect(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS).toEqual(
      expect.arrayContaining([
        {name: 'cold-activation-copying-symbols-duration-n1', unit: 'milliseconds'},
        {name: 'cold-activation-copying-symbols-rows-n1', unit: 'count'},
        {name: 'one-file-reindex-activation-recording-completion-duration-n1', unit: 'milliseconds'},
        {name: 'one-file-reindex-activation-recording-completion-rows-n1', unit: 'count'},
        {name: 'cold-sqlite-durable-database-pages-high-water-n1', unit: 'bytes'},
        {name: 'cold-sqlite-temp-database-pages-high-water-n1', unit: 'bytes'},
        {name: 'one-file-reindex-sqlite-temp-database-pages-high-water-n1', unit: 'bytes'},
      ]),
    );
    const artifact = benchmarkArtifact(
      requiredReleaseMeasurements(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS),
      {
        coldMaterializationStorageMode: 'direct-persistent',
        oneFileReindexMaterializationMode: 'incremental-overlay',
        oneFileReindexMaterializationStorageMode: 'temporary-staged',
        sameOverlayReferenceMaterializationMode: 'full',
        sqliteVersion: '3.49.1',
      },
      'code-graph-production-large-v1',
    );

    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.filter(
          measurement => measurement.name !== 'cold-activation-copying-symbols-duration-n1',
        ),
      }),
    ).toThrow(/cold-activation-copying-symbols-duration-n1/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'one-file-reindex-activation-observed-stages-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [0])
            : measurement,
        ),
      }),
    ).toThrow(/one-file-reindex-activation-observed-stages-n1 expected at least 9 real stages/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        metadata: {...artifact.metadata, coldMaterializationStorageMode: 'temporary-staged'},
      }),
    ).toThrow(/cold direct-persistent materialization storage mode/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'cold-activation-copying-symbols-observed-n1'
            ? benchmarkMeasurement(measurement.name, 'count', [1])
            : measurement,
        ),
      }),
    ).toThrow(/cold-activation-copying-symbols-observed-n1 expected zero direct-persistent activation copies/);
    expect(() =>
      assertProductionReleaseEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'cold-sqlite-durable-database-pages-high-water-n1'
            ? benchmarkMeasurement(measurement.name, 'bytes', [0])
            : measurement,
        ),
      }),
    ).toThrow(/cold-sqlite-durable-database-pages-high-water-n1 positive result/);
  });

  it('gates materialization independently from end-to-end indexing', () => {
    const measurements = [
      'cold-index',
      'cold-materialization',
      'one-file-reindex-index',
      'one-file-reindex-materialization',
      'hot-exact-lexical-query',
      'whole-graph-structural-analysis',
    ].map(name => benchmarkMeasurement(name, 'milliseconds', [10]));
    const artifact = benchmarkArtifact([
      ...measurements,
      benchmarkMeasurement('incremental-process-peak-rss', 'bytes', [10]),
      benchmarkMeasurement('derived-index-disk', 'bytes', [10]),
    ]);
    const budget = {
      developmentPerformance: {
        coldIndexP95MillisecondsMaximum: 20,
        coldMaterializationP95MillisecondsMaximum: 20,
        derivedIndexBytesMaximum: 20,
        hotQueryP95MillisecondsMaximum: 20,
        oneFileIncrementalP95MillisecondsMaximum: 20,
        oneFileMaterializationP95MillisecondsMaximum: 20,
        processPeakRssBytesMaximum: 20,
        wholeGraphAnalysisP95MillisecondsMaximum: 20,
      },
    };

    expect(() => enforceCodeGraphBenchmarkBudget(artifact, budget, undefined)).not.toThrow();
    const regressed = {
      ...artifact,
      measurements: artifact.measurements.map(measurement =>
        measurement.name === 'one-file-reindex-materialization'
          ? benchmarkMeasurement(measurement.name, 'milliseconds', [21])
          : measurement,
      ),
    };
    expect(() => enforceCodeGraphBenchmarkBudget(regressed, budget, undefined)).toThrow(
      /one-file-reindex-materialization/,
    );
  });

  it('retains the independent 10k vector cold-wall calibration and every other performance guard', () => {
    const budgets = readJson(CODE_GRAPH_BUDGETS) as {
      readonly vectorPerformance: PerformanceBudget;
      readonly vectorScalePerformance: Readonly<Record<string, PerformanceBudget>>;
    };
    const budget = budgets.vectorScalePerformance['10000'];
    const guardedMeasurements = [
      ['cold-materialization', 'coldMaterializationP95MillisecondsMaximum'],
      ['one-file-reindex-index', 'oneFileIncrementalP95MillisecondsMaximum'],
      ['one-file-reindex-materialization', 'oneFileMaterializationP95MillisecondsMaximum'],
      ['hot-semantic-vector-query', 'hotQueryP95MillisecondsMaximum'],
      ['whole-graph-structural-analysis', 'wholeGraphAnalysisP95MillisecondsMaximum'],
      ['incremental-process-peak-rss', 'processPeakRssBytesMaximum'],
      ['derived-index-disk', 'derivedIndexBytesMaximum'],
    ] as const;
    const artifact = benchmarkArtifact(
      [
        benchmarkMeasurement('cold-index', 'milliseconds', [budget.coldIndexP95MillisecondsMaximum]),
        ...guardedMeasurements.map(([name]) =>
          benchmarkMeasurement(name, name.includes('rss') || name.includes('disk') ? 'bytes' : 'milliseconds', [1]),
        ),
      ],
      {scaleSymbols: 10_000, vectorEnabled: true},
      'code-graph-vectors-v1',
    );

    expect(budget).toEqual({
      coldIndexP95MillisecondsMaximum: 600_000,
      coldMaterializationP95MillisecondsMaximum: 60_000,
      derivedIndexBytesMaximum: 1_073_741_824,
      hotQueryP95MillisecondsMaximum: 5_000,
      oneFileIncrementalP95MillisecondsMaximum: 120_000,
      oneFileMaterializationP95MillisecondsMaximum: 15_000,
      processPeakRssBytesMaximum: 4_294_967_296,
      wholeGraphAnalysisP95MillisecondsMaximum: 10_000,
    });
    expect(budgets.vectorPerformance.coldIndexP95MillisecondsMaximum).toBe(60_000);
    expect(budgets.vectorScalePerformance['100000']?.coldIndexP95MillisecondsMaximum).toBe(1_350_000);
    expect(() => enforceCodeGraphBenchmarkBudget(artifact, budgets, 10_000)).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        {
          ...artifact,
          measurements: artifact.measurements.map(measurement =>
            measurement.name === 'cold-index'
              ? benchmarkMeasurement(measurement.name, measurement.unit, [600_001])
              : measurement,
          ),
        },
        budgets,
        10_000,
      ),
    ).toThrow(/cold-index/);

    fc.assert(
      fc.property(fc.constantFrom(...guardedMeasurements), fc.integer({max: 10_000, min: 1}), ([name, key], delta) => {
        const regressed = {
          ...artifact,
          measurements: artifact.measurements.map(measurement =>
            measurement.name === name
              ? benchmarkMeasurement(measurement.name, measurement.unit, [budget[key] + delta])
              : measurement,
          ),
        };
        expect(() => enforceCodeGraphBenchmarkBudget(regressed, budgets, 10_000)).toThrow(new RegExp(name, 'u'));
      }),
      {numRuns: 50},
    );
  });

  it('ratchets every named metric independently and binds it to exact evidence conditions', () => {
    const artifact = benchmarkArtifact(
      [
        benchmarkMeasurement('cold-index', 'milliseconds', [10]),
        benchmarkMeasurement('one-file-reindex-index', 'milliseconds', [5]),
        benchmarkMeasurement('hot-exact-lexical-query', 'milliseconds', [1, 2, 3, 4]),
        benchmarkMeasurement('structural-graph-digest-parity', 'count', [0]),
        benchmarkMeasurement('incremental-process-peak-rss', 'bytes', [100]),
      ],
      {runnerClass: 'pinned-test', runtimePlatform: 'linux', vectorEnabled: false},
      'code-graph-production-large-v2',
    );
    const ratchet = {
      environment: {
        architecture: 'arm64',
        fixtureHash: 'fixture',
        node: 'bun/test',
        runner: 'threadnote-code-graph-e2e',
        runnerVersion: '1',
      },
      measurements: {
        'cold-index': {maximum: 9, unit: 'milliseconds'},
        'hot-exact-lexical-query': {p50Maximum: 2, p95Maximum: 3, unit: 'milliseconds'},
        'incremental-process-peak-rss': {maximum: 110, unit: 'count'},
        'one-file-reindex-index': {maximum: 5, samplesMinimum: 2, unit: 'milliseconds'},
        'primary-query-structural-parity': {minimum: 1, unit: 'count'},
        'structural-graph-digest-parity': {minimum: 1, unit: 'count'},
      },
      metadata: {runnerClass: 'different-runner', runtimePlatform: 'linux', vectorEnabled: false},
      suite: 'code-graph-production-large-v2',
      version: 1,
    };

    let message = '';
    try {
      enforceCodeGraphBenchmarkRatchet(artifact, ratchet);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('environment.architecture "x64" does not match "arm64"');
    expect(message).toContain('metadata.runnerClass "pinned-test" does not match "different-runner"');
    expect(message).toContain('cold-index maximum 10 exceeds 9');
    expect(message).toContain('hot-exact-lexical-query p50 3 exceeds 2');
    expect(message).toContain('hot-exact-lexical-query p95 4 exceeds 3');
    expect(message).toContain('incremental-process-peak-rss unit bytes does not match count');
    expect(message).toContain('one-file-reindex-index has 1 samples, below 2');
    expect(message).toContain('primary-query-structural-parity measurement is missing');
    expect(message).toContain('structural-graph-digest-parity minimum 0 is below 1');
  });

  it('rejects incomplete or ambiguous ratchet configurations before comparing evidence', () => {
    const artifact = benchmarkArtifact([benchmarkMeasurement('cold-index', 'milliseconds', [10])]);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(artifact, {
        measurements: {'cold-index': {unit: 'milliseconds'}},
        suite: 'code-graph-v1',
        version: 1,
      }),
    ).toThrow(/requires at least one bound/);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(artifact, {
        measurements: {'cold-index': {maximum: 20, typoMaximum: 30, unit: 'milliseconds'}},
        suite: 'code-graph-v1',
        version: 1,
      }),
    ).toThrow(/unknown field.*typoMaximum/);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(
        {...artifact, measurements: [...artifact.measurements, ...artifact.measurements]},
        {
          environment: {
            fixtureHash: 'fixture',
            node: 'bun/test',
            runner: 'threadnote-code-graph-e2e',
            runnerVersion: '1',
          },
          measurements: {'cold-index': {maximum: 20, unit: 'milliseconds'}},
          metadata: {runnerClass: 'test', runtimePlatform: 'linux', vectorEnabled: false},
          suite: 'code-graph-v1',
          version: 1,
        },
      ),
    ).toThrow(/occurs 2 times instead of exactly once/);
    expect(() =>
      enforceCodeGraphBenchmarkRatchet(artifact, {
        measurements: {'cold-index': {maximum: 20, unit: 'milliseconds'}},
        suite: 'code-graph-v1',
        version: 1,
      }),
    ).toThrow(/environment is missing condition/);
  });

  it('is invariant to artifact measurement order for arbitrary bounded exact ratchets', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({max: 1_000_000, min: 0}), {maxLength: 30, minLength: 1}), values => {
        const measurements = values.map((value, index) =>
          benchmarkMeasurement(`metric-${index}`, index % 2 === 0 ? 'milliseconds' : 'bytes', [value]),
        );
        const ratchet = {
          environment: {
            fixtureHash: 'fixture',
            node: 'bun/test',
            runner: 'threadnote-code-graph-e2e',
            runnerVersion: '1',
          },
          measurements: Object.fromEntries(
            measurements.map(measurement => [
              measurement.name,
              {maximum: measurement.maximum, minimum: measurement.minimum, unit: measurement.unit},
            ]),
          ),
          metadata: {runnerClass: 'test', runtimePlatform: 'linux', vectorEnabled: false},
          suite: 'code-graph-v1',
          version: 1,
        };
        const metadata = {runnerClass: 'test', runtimePlatform: 'linux', vectorEnabled: false};
        expect(() =>
          enforceCodeGraphBenchmarkRatchet(benchmarkArtifact(measurements, metadata), ratchet),
        ).not.toThrow();
        expect(() =>
          enforceCodeGraphBenchmarkRatchet(benchmarkArtifact([...measurements].reverse(), metadata), ratchet),
        ).not.toThrow();
      }),
      {numRuns: 100},
    );
  });

  it('applies development scheduler headroom only to the recorded runtime platform', () => {
    const measurements = [
      'cold-index',
      'cold-materialization',
      'one-file-reindex-index',
      'one-file-reindex-materialization',
      'hot-exact-lexical-query',
      'whole-graph-structural-analysis',
    ].map(name => benchmarkMeasurement(name, 'milliseconds', [10]));
    const artifact = benchmarkArtifact(
      [
        ...measurements,
        benchmarkMeasurement('incremental-process-peak-rss', 'bytes', [10]),
        benchmarkMeasurement('derived-index-disk', 'bytes', [10]),
      ],
      {runtimePlatform: 'win32'},
    );
    const budget = {
      developmentPerformance: {
        coldIndexP95MillisecondsMaximum: 20,
        coldMaterializationP95MillisecondsMaximum: 20,
        derivedIndexBytesMaximum: 20,
        hotQueryP95MillisecondsMaximum: 5,
        oneFileIncrementalP95MillisecondsMaximum: 20,
        oneFileMaterializationP95MillisecondsMaximum: 20,
        processPeakRssBytesMaximum: 20,
        wholeGraphAnalysisP95MillisecondsMaximum: 20,
      },
      developmentPerformanceByPlatform: {win32: {hotQueryP95MillisecondsMaximum: 15}},
    };

    expect(() => enforceCodeGraphBenchmarkBudget(artifact, budget, undefined)).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        {...artifact, metadata: {...artifact.metadata, runtimePlatform: 'linux'}},
        budget,
        undefined,
      ),
    ).toThrow(/hot-exact-lexical-query/);
  });

  it('admits only a five-percent hot-query wall tail while median and process CPU remain bounded', () => {
    const hotWall = benchmarkMeasurement('hot-exact-lexical-query', 'milliseconds', [
      ...Array.from({length: 23}, () => 50),
      105,
      106,
    ]);
    const measurements = [
      'cold-index',
      'cold-materialization',
      'one-file-reindex-index',
      'one-file-reindex-materialization',
      'whole-graph-structural-analysis',
    ].map(name => benchmarkMeasurement(name, 'milliseconds', [10]));
    const artifact = benchmarkArtifact([
      ...measurements,
      hotWall,
      benchmarkMeasurement(
        'hot-query-process-cpu',
        'milliseconds',
        Array.from({length: 25}, () => 80),
      ),
      benchmarkMeasurement('incremental-process-peak-rss', 'bytes', [10]),
      benchmarkMeasurement('derived-index-disk', 'bytes', [10]),
    ]);
    const developmentPerformance = {
      coldIndexP95MillisecondsMaximum: 20,
      coldMaterializationP95MillisecondsMaximum: 20,
      derivedIndexBytesMaximum: 20,
      hotQueryP50MillisecondsMaximum: 60,
      hotQueryP95MillisecondsMaximum: 100,
      hotQueryProcessCpuP95MillisecondsMaximum: 90,
      hotQueryWallP95ToleranceRatioMaximum: 0.05,
      oneFileIncrementalP95MillisecondsMaximum: 20,
      oneFileMaterializationP95MillisecondsMaximum: 20,
      processPeakRssBytesMaximum: 20,
      wholeGraphAnalysisP95MillisecondsMaximum: 20,
    };

    expect(hotWall.p95).toBe(105);
    expect(() => enforceCodeGraphBenchmarkBudget(artifact, {developmentPerformance}, undefined)).not.toThrow();
    expect(artifact.measurements.find(measurement => measurement.name === hotWall.name)?.p95).toBe(105);

    const replace = (name: string, measurement: BenchmarkArtifactV1['measurements'][number]) => ({
      ...artifact,
      measurements: artifact.measurements.map(candidate => (candidate.name === name ? measurement : candidate)),
    });
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        replace(
          hotWall.name,
          benchmarkMeasurement(hotWall.name, 'milliseconds', [...Array.from({length: 23}, () => 50), 105.001, 106]),
        ),
        {developmentPerformance},
        undefined,
      ),
    ).toThrow(/hot-exact-lexical-query/);
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        replace(
          hotWall.name,
          benchmarkMeasurement(hotWall.name, 'milliseconds', [...Array.from({length: 23}, () => 61), 105, 106]),
        ),
        {developmentPerformance},
        undefined,
      ),
    ).toThrow(/p50 61 exceeds 60/);
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        replace(hotWall.name, benchmarkMeasurement(hotWall.name, 'milliseconds', [50])),
        {developmentPerformance},
        undefined,
      ),
    ).toThrow(/requires at least 25 samples/);
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        replace(
          'hot-query-process-cpu',
          benchmarkMeasurement(
            'hot-query-process-cpu',
            'milliseconds',
            Array.from({length: 25}, () => 91),
          ),
        ),
        {developmentPerformance},
        undefined,
      ),
    ).toThrow(/hot-query-process-cpu p95 91 exceeds 90/);
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        artifact,
        {developmentPerformance: {...developmentPerformance, hotQueryWallP95ToleranceRatioMaximum: 0.051}},
        undefined,
      ),
    ).toThrow(/ratio from 0 to 0.05/);

    const p50TolerantPerformance = {
      ...developmentPerformance,
      hotQueryWallP50ToleranceRatioMaximum: 0.05,
    };
    const withP50 = (p50: number) =>
      replace(
        hotWall.name,
        benchmarkMeasurement(hotWall.name, 'milliseconds', [...Array.from({length: 23}, () => p50), 105, 106]),
      );
    expect(() =>
      enforceCodeGraphBenchmarkBudget(withP50(63), {developmentPerformance: p50TolerantPerformance}, undefined),
    ).not.toThrow();
    expect(() =>
      enforceCodeGraphBenchmarkBudget(withP50(63.001), {developmentPerformance: p50TolerantPerformance}, undefined),
    ).toThrow(/p50 63.001 exceeds 63/);
    expect(() =>
      enforceCodeGraphBenchmarkBudget(
        artifact,
        {
          developmentPerformance: {
            ...p50TolerantPerformance,
            hotQueryWallP50ToleranceRatioMaximum: 0.051,
          },
        },
        undefined,
      ),
    ).toThrow(/p50 ratio from 0 to 0.05/);
  });

  it('accepts repeatable structured controls without retaining them in the artifact contract', () => {
    const javaControl = JSON.stringify({
      expectedLanguage: 'java',
      expectedPath: 'src/Example.java',
      query: 'ExampleService',
    });
    const kotlinControl = JSON.stringify({
      expectedLanguage: 'kotlin',
      expectedPath: 'src/Example.kt',
      query: 'KotlinExample',
    });
    expect(
      parseCodeGraphBenchmarkArguments([
        '--repository',
        '/tmp/external-repository',
        '--incremental-path',
        'src/Example.java',
        '--control',
        javaControl,
        '--control',
        kotlinControl,
        '--output',
        'artifacts/external.json',
      ]),
    ).toMatchObject({
      externalControls: [
        {expectedLanguage: 'java', expectedPath: 'src/Example.java', query: 'ExampleService'},
        {expectedLanguage: 'kotlin', expectedPath: 'src/Example.kt', query: 'KotlinExample'},
      ],
      incrementalPath: 'src/Example.java',
      outputPath: 'artifacts/external.json',
      queryText: 'ExampleService',
      repository: '/tmp/external-repository',
    });
    expect(() =>
      parseCodeGraphBenchmarkArguments(['--repository', '/tmp/external-repository', '--output', 'artifact.json']),
    ).toThrow(/requires --incremental-path, at least one --control, and --output/);
    expect(() =>
      parseCodeGraphBenchmarkArguments([
        '--repository',
        '/tmp/external-repository',
        '--incremental-path',
        'src/Example.java',
        '--control',
        javaControl,
        '--output',
        'artifact.json',
        '--profile',
        'production-large',
      ]),
    ).toThrow(/cannot be combined/);
  });

  it('requires exact-commit aggregate evidence for an external repository soak', () => {
    const controlMeasurements = [
      'cold-materialized-file-rows-language-java',
      'cold-materialized-symbol-rows-language-java',
      'external-query-cold-java-returned-nodes',
      'external-query-cold-java-expected-path-language-nodes',
      'external-query-incremental-java-returned-nodes',
      'external-query-incremental-java-expected-path-language-nodes',
      'external-query-same-overlay-reference-java-returned-nodes',
      'external-query-same-overlay-reference-java-expected-path-language-nodes',
      'external-query-java-same-overlay-structural-parity',
    ].map(name => benchmarkMeasurement(name, 'count', [1]));
    controlMeasurements.push(benchmarkMeasurement('external-query-cold-java-duration', 'milliseconds', [10]));
    const mcpMeasurements = (['query', 'node', 'neighbors', 'explain', 'impact', 'path'] as const).flatMap(
      operation => [
        benchmarkMeasurement(`mcp-${operation}-duration`, 'milliseconds', [10]),
        benchmarkMeasurement(`mcp-${operation}-structured-output`, 'bytes', [1_024]),
        benchmarkMeasurement(`mcp-${operation}-text-output`, 'bytes', [1_024]),
      ],
    );
    const artifact = benchmarkArtifact(
      [
        ...requiredReleaseMeasurements(EXTERNAL_REPOSITORY_EVIDENCE_MEASUREMENTS),
        ...controlMeasurements,
        ...mcpMeasurements,
      ],
      {
        benchmarkDiskFilesystem: 'ext4',
        benchmarkDiskMedium: 'solid-state',
        benchmarkInventoryEligibleFiles: 1,
        benchmarkInventoryExcludedFiles: 0,
        benchmarkLogicalCpuCount: 8,
        coldMaterializationStorageMode: 'direct-persistent',
        externalQueryControlTimeoutMilliseconds: 120_000,
        externalControlCount: 1,
        externalControlEvidence: JSON.stringify({
          java: {
            path: 'src/Example.java',
            query: 'ExampleService',
            stableNodeId: `cgs_${'1'.repeat(32)}`,
          },
        }),
        externalControlLanguages: 'java',
        externalRepositoryCommit: '0123456789abcdef0123456789abcdef01234567',
        externalRepositoryName: 'JetBrains/intellij-community',
        externalRepositoryPublicVerification: 'anonymous-https-exact-commit-fetch',
        externalRepositoryUrl: 'https://github.com/JetBrains/intellij-community',
        managerDetailEdgeCount: 1,
        managerDetailNodeCount: 1,
        managerEdgeBudget: 1_500,
        managerLayoutPreparationMeasurement:
          'client-side graph layout-preparation only; excludes browser and WebGL paint',
        managerNodeBudget: 500,
        managerOverviewEdgeCount: 1,
        managerOverviewNodeCount: 1,
        managerRequestCancellationPassed: true,
        managerRequestLifecycleControl:
          'real Manager queries through the GraphWorkspace request gate: superseding aborts an in-flight request; a completed late response is rejected',
        managerSequenceTimeoutMilliseconds: 180_000,
        managerServiceResponseTimingIncludesSerialization: true,
        managerSnapshotBindingPassed: true,
        managerStaleResponseRejectionPassed: true,
        mcpOperationCount: 6,
        oneFileReindexMaterializationMode: 'incremental-overlay',
        oneFileReindexMaterializationStorageMode: 'temporary-staged',
        retrievalMode: 'lexical-only',
        runnerClass: 'local-unclassified',
        runnerIdentity: 'runner-0123456789abcdef',
        sameOverlayReferenceMaterializationMode: 'full',
        sameOverlayReferenceMaterializationStorageMode: 'direct-persistent',
        simultaneousWorktrees: 2,
        sqliteVersion: '3.49.1',
        structuralGraphDigestCold: '1'.repeat(64),
        structuralGraphDigestIncremental: '2'.repeat(64),
        structuralGraphDigestSameOverlayReference: '2'.repeat(64),
        worktreeIsolationCleanupPassed: true,
        worktreeIsolationCommandTimeoutMilliseconds: 30_000,
        worktreeIsolationIndexedFiles: 2,
        worktreeIsolationPassed: true,
        worktreeIsolationOuterTimeoutMilliseconds: 300_000,
        worktreeIsolationTopology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
      },
      'code-graph-external-repository-v1',
    );

    expect(() => assertExternalRepositoryEvidence(artifact)).not.toThrow();
    expect(() =>
      assertExternalRepositoryEvidence({
        ...artifact,
        metadata: {...artifact.metadata, oneFileReindexMaterializationMode: 'full'},
      }),
    ).toThrow(/incremental-overlay materialization mode/);
    expect(() =>
      assertExternalRepositoryEvidence({
        ...artifact,
        environment: {...artifact.environment, dirty: true},
      }),
    ).toThrow(/clean exact Threadnote source commit/);
    expect(() =>
      assertExternalRepositoryEvidence({
        ...artifact,
        environment: {...artifact.environment, fixtureHash: 'external-code-graph-v1:unrelated'},
      }),
    ).toThrow(/external fixture identity tied to its exact commit/);
    expect(() =>
      assertExternalRepositoryEvidence({
        ...artifact,
        metadata: {...artifact.metadata, managerRequestCancellationPassed: false},
      }),
    ).toThrow(/superseded-request cancellation/);
    expect(() =>
      assertExternalRepositoryEvidence({
        ...artifact,
        metadata: {...artifact.metadata, managerStaleResponseRejectionPassed: false},
      }),
    ).toThrow(/completed stale-response rejection/);
    expect(() =>
      assertExternalRepositoryEvidence({...artifact, metadata: {...artifact.metadata, externalRepositoryCommit: ''}}),
    ).toThrow(/exact external repository commit/);
    expect(() =>
      assertExternalRepositoryEvidence({
        ...artifact,
        measurements: artifact.measurements.map(measurement =>
          measurement.name === 'external-query-incremental-java-expected-path-language-nodes'
            ? benchmarkMeasurement(measurement.name, 'count', [0])
            : measurement,
        ),
      }),
    ).toThrow(/external-query-incremental-java-expected-path-language-nodes positive result/);
    expect(JSON.stringify(artifact)).toContain('ExampleService');
    expect(JSON.stringify(artifact)).toContain('src/Example.java');
    expect(JSON.stringify(artifact)).not.toMatch(/\/Users\/|[A-Za-z]:\\Users\\|threadnote:\/\//);
  });

  it('requires the complete release-bound public-repository performance contract', () => {
    const languages = ['java', 'kotlin', 'typescript', 'bazel-build'] as const;
    const controls = Object.fromEntries(
      languages.map((language, index) => [
        language === 'bazel-build' ? 'bazel' : language,
        {
          path: `src/control-${index}.${language === 'java' ? 'java' : language === 'kotlin' ? 'kt' : 'ts'}`,
          query: `Control${index}`,
          stableNodeId: `cgs_${String(index + 1).repeat(32)}`,
        },
      ]),
    );
    const controlMeasurements = languages.flatMap(language => [
      benchmarkMeasurement(`cold-materialized-file-rows-language-${language}`, 'count', [1]),
      benchmarkMeasurement(`cold-materialized-symbol-rows-language-${language}`, 'count', [1]),
      benchmarkMeasurement(`external-query-cold-${language}-duration`, 'milliseconds', [10]),
      benchmarkMeasurement(`external-query-cold-${language}-returned-nodes`, 'count', [1]),
      benchmarkMeasurement(`external-query-cold-${language}-expected-path-language-nodes`, 'count', [1]),
      benchmarkMeasurement(`external-query-incremental-${language}-returned-nodes`, 'count', [1]),
      benchmarkMeasurement(`external-query-incremental-${language}-expected-path-language-nodes`, 'count', [1]),
      benchmarkMeasurement(`external-query-same-overlay-reference-${language}-returned-nodes`, 'count', [1]),
      benchmarkMeasurement(
        `external-query-same-overlay-reference-${language}-expected-path-language-nodes`,
        'count',
        [1],
      ),
      benchmarkMeasurement(`external-query-${language}-same-overlay-structural-parity`, 'count', [1]),
    ]);
    const mcpMeasurements = (['query', 'node', 'neighbors', 'explain', 'impact', 'path'] as const).flatMap(
      operation => [
        benchmarkMeasurement(`mcp-${operation}-duration`, 'milliseconds', [10]),
        benchmarkMeasurement(`mcp-${operation}-structured-output`, 'bytes', [1_024]),
        benchmarkMeasurement(`mcp-${operation}-text-output`, 'bytes', [1_024]),
      ],
    );
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const evidenceMeasurements = [
      ...requiredReleaseMeasurements(EXTERNAL_REPOSITORY_EVIDENCE_MEASUREMENTS),
      ...controlMeasurements,
      ...mcpMeasurements,
    ];
    const evidenceMeasurementNames = new Set(evidenceMeasurements.map(measurement => measurement.name));
    for (const [name, unit] of [
      ['cold-index', 'milliseconds'],
      ['cold-registration-lock-and-database-setup', 'milliseconds'],
      ['cold-inventory-and-extraction', 'milliseconds'],
      ['cold-materialization', 'milliseconds'],
      ['cold-reference-resolution', 'milliseconds'],
      ['cold-activation-lexical-only', 'milliseconds'],
      ['one-file-reindex-index', 'milliseconds'],
      ['one-file-reindex-registration-lock-and-database-setup', 'milliseconds'],
      ['one-file-reindex-post-committed-scan-overlay-and-workspace', 'milliseconds'],
      ['one-file-reindex-incremental-work-attribution-context-files-n1', 'count'],
      ['one-file-reindex-incremental-work-base-facts-loaded-n1', 'count'],
      ['one-file-reindex-incremental-work-changed-files-n1', 'count'],
      ['one-file-reindex-incremental-work-deleted-files-n1', 'count'],
      ['one-file-reindex-incremental-work-fact-bytes-n1', 'bytes'],
      ['one-file-reindex-incremental-work-inventory-files-inspected-n1', 'count'],
      ['one-file-reindex-incremental-work-planned-rows-n1', 'count'],
      ['one-file-reindex-incremental-work-probed-dependency-paths-n1', 'count'],
      ['one-file-reindex-incremental-work-source-bytes-n1', 'bytes'],
      ['one-file-reindex-incremental-work-total-files-n1', 'count'],
      ['same-overlay-full-rebuild-index', 'milliseconds'],
      ['hot-exact-lexical-query', 'milliseconds'],
      ['cold-materialized-file-rows', 'count'],
      ['cold-materialized-symbol-rows', 'count'],
      ['cold-materialized-edge-rows', 'count'],
      ['cold-materialization-deduplicated-reference-rows-n1', 'count'],
      ['cold-materialized-reference-candidate-rows-n1', 'count'],
      ['cold-materialized-lookup-key-rows-n1', 'count'],
      ['cold-materialized-lexical-term-rows', 'count'],
      ['sqlite-main-disk', 'bytes'],
      ['cold-process-peak-rss', 'bytes'],
      ['cold-sqlite-wal-peak-observed', 'bytes'],
      ['cold-sqlite-temp-peak-observed', 'bytes'],
      ['cold-sqlite-durable-database-pages-high-water-n1', 'bytes'],
      ['primary-query-structural-parity', 'count'],
      ['structural-graph-digest-parity', 'count'],
      ['manager-catalog-cold', 'milliseconds'],
      ['manager-catalog-warm', 'milliseconds'],
      ['manager-overview-cold', 'milliseconds'],
      ['manager-overview-warm', 'milliseconds'],
      ['manager-detail-cold', 'milliseconds'],
      ['manager-node-detail-cold', 'milliseconds'],
      ['manager-layout-preparation-proxy', 'milliseconds'],
      ['manager-response-payload', 'bytes'],
      ['manager-bounded-query', 'milliseconds'],
      ['manager-bounded-query-payload', 'bytes'],
      ['concurrent-worktree-isolation-duration', 'milliseconds'],
    ] as const) {
      if (!evidenceMeasurementNames.has(name)) evidenceMeasurements.push(benchmarkMeasurement(name, unit, [1]));
    }
    const artifact = benchmarkArtifact(
      evidenceMeasurements,
      {
        benchmarkDiskFilesystem: 'apfs',
        benchmarkDiskMedium: 'solid-state',
        benchmarkInventoryEligibleFiles: 100,
        benchmarkInventoryExcludedFiles: 10,
        benchmarkLogicalCpuCount: 10,
        benchmarkSourceValidationMode: 'managed-payload-exact-head-validated',
        benchmarkValidatedManagedDependencyInstallation: 'bun install --frozen-lockfile',
        benchmarkValidatedManagedExecutableSha256: 'c'.repeat(64),
        benchmarkValidatedManagedPayload: 'exact-head-not-executed',
        benchmarkValidatedManagedPayloadBytes: 1_024,
        benchmarkValidatedManagedPayloadFileCount: 10,
        benchmarkValidatedManagedPayloadManifestSha256: 'd'.repeat(64),
        benchmarkValidatedManagedProcessLeaseInspection: 'complete',
        benchmarkValidatedManagedReleaseMetadataSha256: 'e'.repeat(64),
        benchmarkValidatedManagedRuntime: 'bun-test',
        benchmarkValidatedManagedTarget: 'linux-x64',
        benchmarkValidatedManagedVersion: `4.0.0-beta.32-local.g${commit}`,
        coldMaterializationStorageMode: 'direct-persistent',
        externalQueryControlTimeoutMilliseconds: 120_000,
        externalControlCount: 4,
        externalControlEvidence: JSON.stringify(controls),
        externalControlLanguages: languages.join(','),
        externalRepositoryCommit: commit,
        externalRepositoryName: 'JetBrains/intellij-community',
        externalRepositoryPublicVerification: 'anonymous-https-exact-commit-fetch',
        externalRepositoryUrl: 'https://github.com/JetBrains/intellij-community',
        externalRepositoryMode: 'clean checkout with a byte-compared, scoped one-file overlay',
        managerDetailEdgeCount: 1,
        managerDetailNodeCount: 1,
        managerEdgeBudget: 1_500,
        managerLayoutPreparationMeasurement:
          'client-side graph layout-preparation only; excludes browser and WebGL paint',
        managerNodeBudget: 500,
        managerOverviewEdgeCount: 1,
        managerOverviewNodeCount: 1,
        managerRequestCancellationPassed: true,
        managerRequestLifecycleControl:
          'real Manager queries through the GraphWorkspace request gate: superseding aborts an in-flight request; a completed late response is rejected',
        managerSequenceTimeoutMilliseconds: 180_000,
        managerServiceResponseTimingIncludesSerialization: true,
        managerSnapshotBindingPassed: true,
        managerStaleResponseRejectionPassed: true,
        mcpOperationCount: 6,
        oneFileReindexMaterializationMode: 'incremental-overlay',
        oneFileReindexMaterializationStorageMode: 'temporary-staged',
        releaseEvidenceRef: 'refs/tags/v4.0.0-beta.32',
        releaseEvidenceHarnessCommit: commit,
        releaseEvidenceHarnessDeltaPaths: '[]',
        releaseEvidenceResolvedSha: commit,
        releaseEvidenceSha: commit,
        releaseEvidenceSourceMode: 'exact-release',
        retrievalMode: 'lexical-only',
        sameOverlayReferenceMaterializationMode: 'full',
        sameOverlayReferenceMaterializationStorageMode: 'direct-persistent',
        simultaneousWorktrees: 2,
        sqliteVersion: '3.49.1',
        runnerClass: 'local-unclassified',
        runnerIdentity: 'runner-0123456789abcdef',
        structuralGraphDigestCold: '1'.repeat(64),
        structuralGraphDigestIncremental: '2'.repeat(64),
        structuralGraphDigestSameOverlayReference: '2'.repeat(64),
        worktreeIsolationIndexedFiles: 2,
        worktreeIsolationCleanupPassed: true,
        worktreeIsolationCommandTimeoutMilliseconds: 30_000,
        worktreeIsolationPassed: true,
        worktreeIsolationOuterTimeoutMilliseconds: 300_000,
        worktreeIsolationTopology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
      },
      'code-graph-external-repository-v1',
    );

    expect(() => assertExternalPerformanceEvidence(artifact)).not.toThrow();
    expect(() => validateRetainedPerformancePayload(artifact)).not.toThrow();
    const threadnote5Artifact: BenchmarkArtifactV1 = {
      ...artifact,
      metadata: {
        ...artifact.metadata,
        benchmarkValidatedManagedVersion: `5.0.2-local.g${commit}`,
        releaseEvidenceRef: 'refs/tags/v5.0.2',
      },
    };
    expect(() => assertExternalPerformanceEvidence(threadnote5Artifact)).not.toThrow();
    expect(() => validateRetainedPerformancePayload(threadnote5Artifact)).not.toThrow();
    const harnessDeltaArtifact: BenchmarkArtifactV1 = {
      ...artifact,
      metadata: {
        ...artifact.metadata,
        releaseEvidenceHarnessCommit: artifact.environment.commit,
        releaseEvidenceHarnessDeltaPaths: JSON.stringify([
          'scripts/benchmark-code-graph.ts',
          'scripts/site-performance-evidence.ts',
          'src/evaluation/external_evidence.ts',
        ]),
        releaseEvidenceResolvedSha: 'f'.repeat(40),
        releaseEvidenceSha: 'f'.repeat(40),
        releaseEvidenceSourceMode: 'release-plus-reviewed-harness-delta',
      },
    };
    expect(() => assertExternalPerformanceEvidence(harnessDeltaArtifact)).not.toThrow();
    expect(() => validateRetainedPerformancePayload(harnessDeltaArtifact)).not.toThrow();
    const projected = retainedPerformanceArtifactFromHarness(artifact, {
      artifactSha256: 'f'.repeat(64),
      artifactUrl: '/performance/performance-evidence.json',
      currentLockfileSha256: 'a'.repeat(64),
      currentPackageManifestSha256: 'b'.repeat(64),
      generatedAt: artifact.createdAt,
    });
    expect(projected.manager).toMatchObject({
      edgeBudget: 1_500,
      nodeBudget: 500,
      nodeDetailColdMilliseconds: 1,
      requestCancellationPassed: true,
      staleResponseRejectionPassed: true,
    });
    expect(projected.concurrency).toEqual({
      cleanupPassed: true,
      durationMilliseconds: 1,
      indexedFiles: 2,
      isolationPassed: true,
      simultaneousWorktrees: 2,
      topology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
    });
    expect(() =>
      assertExternalPerformanceEvidence({
        ...artifact,
        metadata: {...artifact.metadata, benchmarkSourceValidationMode: 'github-actions-clean-source'},
      }),
    ).toThrow(/separately validated managed exact-HEAD payload/);
    expect(() =>
      assertExternalPerformanceEvidence({
        ...artifact,
        metadata: {...artifact.metadata, managerSnapshotBindingPassed: false},
      }),
    ).toThrow(/Manager exact snapshot binding/);
    expect(() =>
      assertExternalPerformanceEvidence({
        ...artifact,
        metadata: {
          ...artifact.metadata,
          externalControlEvidence: JSON.stringify({
            ...controls,
            java: {...controls.java, stableNodeId: 'not-a-stable-node'},
          }),
        },
      }),
    ).toThrow(/privacy-safe external control evidence matching declared languages/);
    for (const [field, value] of [
      ['query', `ghp_${'a'.repeat(24)}`],
      ['query', `sk-proj_${'b'.repeat(24)}`],
      ['path', '/Users/example/private.ts'],
      ['path', '/home/example/private.ts'],
      ['path', '/mnt/c/Users/example/private.ts'],
      ['path', '/c/Users/example/private.ts'],
      ['path', 'C:\\Users\\example\\private.ts'],
      ['path', '\\\\server\\share\\private.ts'],
    ] as const) {
      const sensitiveControls = JSON.parse(JSON.stringify(controls)) as Record<
        string,
        Record<'path' | 'query' | 'stableNodeId', string>
      >;
      sensitiveControls.java[field] = value;
      expect(() =>
        assertExternalPerformanceEvidence({
          ...artifact,
          metadata: {...artifact.metadata, externalControlEvidence: JSON.stringify(sensitiveControls)},
        }),
      ).toThrow(/privacy-safe external control evidence|credential-like|local filesystem path/);
    }
    expect(() =>
      validateRetainedPerformancePayload({
        ...artifact,
        metadata: {...artifact.metadata, managerNodeBudget: 499},
      }),
    ).toThrow(/managerNodeBudget/);
    expect(() =>
      validateRetainedPerformancePayload({
        ...artifact,
        metadata: {...artifact.metadata, worktreeIsolationIndexedFiles: 3},
      }),
    ).toThrow(/worktreeIsolationIndexedFiles/);
    expect(() =>
      validateRetainedPerformancePayload({
        ...artifact,
        measurements: artifact.measurements.filter(measurement => measurement.name !== 'manager-node-detail-cold'),
      }),
    ).toThrow(/manager-node-detail-cold/);
  });

  it('keeps materialization ceilings reviewed for every checked graph profile', () => {
    for (const path of [CODE_GRAPH_BUDGETS, POLYGLOT_BUDGETS]) {
      const root = readJson(path) as Readonly<Record<string, unknown>>;
      const budgets = performanceBudgets(root);
      expect(budgets).toHaveLength(path === CODE_GRAPH_BUDGETS ? 6 : 1);
      for (const value of budgets) {
        expect(isPerformanceBudget(value)).toBe(true);
        if (!isPerformanceBudget(value)) continue;
        const budget = value;
        expect(budget.coldMaterializationP95MillisecondsMaximum).toBeGreaterThan(0);
        expect(budget.coldMaterializationP95MillisecondsMaximum).toBeLessThanOrEqual(
          budget.coldIndexP95MillisecondsMaximum,
        );
        expect(budget.oneFileMaterializationP95MillisecondsMaximum).toBeGreaterThan(0);
        expect(budget.oneFileMaterializationP95MillisecondsMaximum).toBeLessThanOrEqual(
          budget.oneFileIncrementalP95MillisecondsMaximum,
        );
      }
    }
  });

  it('runs bounded exact-tag production-large evidence once without gating publication on it', () => {
    const workflow = load(readFileSync('.github/workflows/benchmarks.yml', 'utf8')) as BenchmarkWorkflow;
    const evidence = load(readFileSync('.github/workflows/production-large-evidence.yml', 'utf8')) as BenchmarkWorkflow;
    const publish = load(readFileSync('.github/workflows/publish.yml', 'utf8')) as BenchmarkWorkflow;
    const releaseEvidence = load(readFileSync('.github/workflows/release-evidence.yml', 'utf8')) as BenchmarkWorkflow;
    expect(workflow.on.push).toBeUndefined();

    const scheduled = workflow.jobs['code-graph-production-large'];
    expect(scheduled.if).toContain("github.event_name == 'schedule'");
    expect(scheduled.if).toContain('inputs.include_production_large');
    expect(scheduled.uses).toBe('./.github/workflows/production-large-evidence.yml');

    const releaseGate = releaseEvidence.jobs['production-large-evidence'];
    expect(releaseGate.needs).toBeUndefined();
    expect(releaseGate.uses).toBe('./.github/workflows/production-large-evidence.yml');
    expect(releaseGate.with).toMatchObject({
      release_ref: '${{ github.ref }}',
      release_sha: '${{ github.sha }}',
    });
    const publisher = publish.jobs['publish-release'];
    expect(publisher.needs).toEqual(['verify', 'linux', 'macos', 'windows-build']);
    expect(publisher.if).toContain("needs.windows-build.result == 'success'");
    expect(publisher.if).not.toContain('needs.windows-sign');
    expect(publisher.if).not.toContain('needs.production-large-evidence');
    expect(publish.jobs['publish-beta']).toBeUndefined();
    expect(publish.jobs['publish-evidence-gated']).toBeUndefined();
    expect(publish.jobs['production-large-evidence']).toBeUndefined();

    const production = evidence.jobs['code-graph-production-large'];
    const checkout = production.steps?.find(step => step.uses === 'actions/checkout@v7');
    expect(checkout?.with).toMatchObject({
      'fetch-depth': 1,
      ref: expect.stringContaining('inputs.release_ref'),
    });
    const verifyRef = production.steps?.find(step => step.name?.includes('release tag resolves'));
    expect(verifyRef?.if).toContain("inputs.release_ref != ''");
    expect(verifyRef?.run).toContain('git rev-parse --verify "${RELEASE_REF}^{commit}"');
    expect(verifyRef?.run).toContain('test "$resolved" = "$RELEASE_SHA"');
    const upload = production.steps?.find(step => step.id === 'upload-production-large');
    expect(upload?.with).toMatchObject({'if-no-files-found': 'error', 'retention-days': 90});
    expect(upload?.with?.path).toContain('code-graph-production-large-admission-*.json');
    expect(upload?.with?.path).toContain('code-graph-production-large-n1-*.json');
    expect(upload?.with?.path).toContain('code-graph-production-reduced-n1-*.json');
    const admission = production.steps?.find(step => step.id === 'classify_production_large_admission');
    expect(admission?.run).toContain('not-admitted-insufficient-capacity');
    expect(admission?.run).toContain('available_bytes >= required_bytes');
    const enforcement = production.steps?.find(
      step => step.name === 'Enforce a completed production-shaped observation',
    );
    expect(enforcement?.if).toContain("steps.capture_production_large.outcome != 'success'");
    expect(enforcement?.if).toContain("steps.capture_hosted_reduced.outcome != 'success'");
    expect(enforcement?.run).toContain('exit 1');
    const capture = production.steps?.find(step => step.name?.includes('Capture one production-large'));
    expect(production.steps?.indexOf(admission!)).toBeLessThan(production.steps?.indexOf(capture!) ?? 0);
    expect(capture?.if).toContain("steps.classify_production_large_admission.outputs.admitted == 'true'");
    expect(capture?.run).toContain('--minimum-free-gib 120');
    expect(capture?.env).toMatchObject({
      THREADNOTE_BENCHMARK_RELEASE_REF: '${{ inputs.release_ref }}',
      THREADNOTE_BENCHMARK_RELEASE_SHA: '${{ inputs.release_sha }}',
    });
    const fallback = production.steps?.find(step => step.id === 'capture_hosted_reduced');
    expect(fallback?.if).toContain("outputs.admitted != 'true'");
    expect(fallback?.run).toContain('--profile-files 3000');
    expect(fallback?.run).toContain('--profile-symbols 110000');
    expect(fallback?.run).toContain('--minimum-free-gib 20');

    for (const jobName of [
      'code-graph',
      'code-graph-10k',
      'code-graph-vectors',
      'code-graph-vectors-10k',
      'code-graph-heavy-tail',
      'recall-10k',
    ]) {
      expect(workflow.jobs[jobName]?.if).not.toContain('refs/tags/');
    }
  });
});

interface PerformanceBudget {
  readonly coldIndexP95MillisecondsMaximum: number;
  readonly coldMaterializationP95MillisecondsMaximum: number;
  readonly derivedIndexBytesMaximum: number;
  readonly hotQueryP95MillisecondsMaximum: number;
  readonly oneFileIncrementalP95MillisecondsMaximum: number;
  readonly oneFileMaterializationP95MillisecondsMaximum: number;
  readonly processPeakRssBytesMaximum: number;
  readonly wholeGraphAnalysisP95MillisecondsMaximum: number;
}

interface BenchmarkWorkflow {
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly if?: string;
        readonly needs?: string | readonly string[];
        readonly steps?: readonly {
          readonly env?: Readonly<Record<string, unknown>>;
          readonly if?: string;
          readonly id?: string;
          readonly name?: string;
          readonly run?: string;
          readonly uses?: string;
          readonly with?: Readonly<Record<string, unknown>>;
        }[];
        readonly uses?: string;
        readonly with?: Readonly<Record<string, unknown>>;
      }
    >
  >;
  readonly on: {readonly push?: {readonly tags: readonly string[]}};
}

function benchmarkArtifact(
  measurements: BenchmarkArtifactV1['measurements'],
  metadata: BenchmarkArtifactV1['metadata'] = {},
  suite = 'code-graph-v1',
): BenchmarkArtifactV1 {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const externalCommit =
    typeof metadata.externalRepositoryCommit === 'string' ? metadata.externalRepositoryCommit : undefined;
  return {
    createdAt: '2026-08-01T00:00:00.000Z',
    environment: {
      architecture: 'x64',
      commit,
      cpu: 'test',
      dirty: false,
      fixtureHash:
        suite === 'code-graph-external-repository-v1' && externalCommit
          ? `external-code-graph-v1:${externalCommit}`
          : 'fixture',
      memoryBytes: 1,
      node: 'bun/test',
      operatingSystem: 'linux',
      packageManager: 'bun/test',
      runner: 'threadnote-code-graph-e2e',
      runnerVersion: '1',
    },
    measurements: measurements.map(measurement =>
      typeof metadata.releaseEvidenceRef === 'string' &&
      ['hot-exact-lexical-query', 'manager-bounded-query'].includes(measurement.name)
        ? benchmarkMeasurement(
            measurement.name,
            measurement.unit,
            Array.from({length: 25}, () => measurement.maximum),
          )
        : measurement,
    ),
    metadata: {
      benchmarkMeasuredExecutionMode: 'local-source-application-layer',
      benchmarkMeasuredSourceCommit: commit,
      benchmarkMeasuredSourceLockfileSha256: 'a'.repeat(64),
      benchmarkMeasuredSourcePackageManifestSha256: 'b'.repeat(64),
      benchmarkGithubRunnerArchitecture: 'X64',
      benchmarkGithubRunnerEnvironment: 'github-hosted',
      benchmarkGithubRunnerOperatingSystem: 'Linux',
      benchmarkSourceValidationMode: 'github-actions-clean-source',
      benchmarkValidatedManagedPayload: 'not-applicable-github-actions-clean-source',
      ...(suite.startsWith('code-graph-production-large-')
        ? {
            ...productionProfileArtifactMetadata(PRODUCTION_LARGE_CODE_GRAPH_PROFILE),
            releaseEvidenceRef: 'refs/tags/v4.0.0-beta.30',
            releaseEvidenceHarnessCommit: commit,
            releaseEvidenceHarnessDeltaPaths: '[]',
            releaseEvidenceResolvedSha: commit,
            releaseEvidenceSha: commit,
            releaseEvidenceSourceMode: 'exact-release',
          }
        : {}),
      ...metadata,
    },
    suite,
    version: 1,
    warmups: 5,
  };
}

function requiredReleaseMeasurements(
  required: readonly {
    readonly name: string;
    readonly unit: BenchmarkArtifactV1['measurements'][number]['unit'];
  }[],
): BenchmarkArtifactV1['measurements'] {
  return required.map(measurement =>
    benchmarkMeasurement(measurement.name, measurement.unit, [
      measurement.name === 'cold-activation-observed-stages-n1'
        ? 3
        : measurement.name.endsWith('-materialization-cached-fact-replay-bytes-n1')
          ? CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 2
          : measurement.name.endsWith('-materialization-cached-fact-bytes-total-n1')
            ? CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 1
            : measurement.name.endsWith('-materialization-raw-fact-replay-bytes-n1') ||
                measurement.name.endsWith('-materialized-shard-cache-deferred-raw-fact-bytes-n1')
              ? CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM + 1
              : /-materialization-subphase-shard-(?:association|persistence|serialization)-n1$/u.test(measurement.name)
                ? 0
                : measurement.name.startsWith('production-shape-')
                  ? 100
                  : measurement.name.startsWith('cold-activation-copying-') && measurement.name.endsWith('-observed-n1')
                    ? 0
                    : measurement.name.endsWith('-activation-observed-stages-n1')
                      ? 32
                      : measurement.name.endsWith('-external-sampler-version-n1')
                        ? 4
                        : measurement.name.endsWith('-materialization-sidecar-wal-high-water-n1')
                          ? 0
                          : measurement.name.endsWith('-external-process-tree-failures-n1') ||
                              measurement.name.endsWith('-external-open-temp-process-tree-failures-n1')
                            ? 0
                            : measurement.name === 'one-file-reindex-materialization-stage-restoring-indexes-n1'
                              ? 0
                              : 1,
    ]),
  );
}

function performanceBudgets(root: Readonly<Record<string, unknown>>): readonly unknown[] {
  const direct = ['developmentPerformance', 'vectorPerformance'].flatMap(name => {
    const value = root[name];
    return value === undefined ? [] : [value];
  });
  const scaled = ['scalePerformance', 'vectorScalePerformance'].flatMap(name => {
    const value = root[name];
    if (typeof value !== 'object' || value === null) return [];
    return Object.values(value);
  });
  return [...direct, ...scaled];
}

function isPerformanceBudget(value: unknown): value is PerformanceBudget {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PerformanceBudget>;
  return [
    candidate.coldIndexP95MillisecondsMaximum,
    candidate.coldMaterializationP95MillisecondsMaximum,
    candidate.oneFileIncrementalP95MillisecondsMaximum,
    candidate.oneFileMaterializationP95MillisecondsMaximum,
  ].every(item => typeof item === 'number' && Number.isFinite(item));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

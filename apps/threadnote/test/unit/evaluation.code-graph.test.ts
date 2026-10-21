import {readFileSync} from '@threadnote/testing/node-fs';
import {join} from '@threadnote/testing/node-path';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import {TestError} from '@threadnote/testing/test-error';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {parseBenchmarkArtifactV1, type BenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {
  PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
  PRODUCTION_WORKTREE_CHURN_SCENARIOS,
  git,
  prepareProductionCodeGraphFixture,
  productionEligibleFileCount,
  productionExcludedByteDistribution,
  productionRepositoryFileCount,
  productionWorkspaceRoots,
  validateProductionProfile,
  type ProductionCodeGraphFixtureProfile,
} from '../../../../scripts/code-graph-fixture.js';
import {inventoryRepository} from '@threadnote/graph/inventory';
import {
  CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
  CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES,
} from '@threadnote/graph/inventory/policy';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {discoverManifestWorkspace} from '@threadnote/graph/workspace';
import {
  codeGraphEdgeKey,
  codeGraphEvaluationFixtureHash,
  evaluateCodeGraphObservations,
  parseCodeGraphEvaluationBaselineV1,
  parseCodeGraphEvaluationFixtureV1,
} from '@threadnote/threadnote/evaluation/code-graph';
import {runEffect} from '../helpers/effect-runtime.js';
import {observeCodeGraphEvaluationDiagnostic} from '../../../../scripts/evaluate-code-graph.js';

const FIXTURE_ROOT = 'apps/threadnote/test/evaluation/fixtures/code-graph-v1';
const BASELINE_ROOT = 'apps/threadnote/test/evaluation/baselines/code-graph-v1';
const POLYGLOT_FIXTURE_ROOT = 'apps/threadnote/test/evaluation/fixtures/code-graph-polyglot-v1';
const POLYGLOT_BASELINE_ROOT = 'apps/threadnote/test/evaluation/baselines/code-graph-polyglot-v1';

describe('supplemental graph evaluation diagnostics', () => {
  effectIt.effect('preserves the original quality failure when supplemental reads or formatting fail', () =>
    Effect.gen(function* () {
      const original = TestError.make({message: 'original worktree quality failure'});
      const reads: (() => Effect.Effect<unknown, unknown>)[] = [
        () => Effect.fail(TestError.make({message: 'diagnostic read failure'})),
        () => Effect.die('diagnostic defect'),
        () => {
          throw new Error('diagnostic factory defect');
        },
        () => Effect.succeed('malformed').pipe(Effect.map(value => JSON.parse(value))),
      ];
      for (const read of reads) {
        const observations: unknown[] = [];
        const exit = yield* observeCodeGraphEvaluationDiagnostic(read).pipe(
          Effect.tap(value => Effect.sync(() => observations.push(value))),
          Effect.andThen(Effect.fail(original)),
          Effect.exit,
        );
        expect(observations).toEqual([{state: 'unavailable'}]);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons).toHaveLength(1);
          const reason = exit.cause.reasons[0];
          expect(Cause.isFailReason(reason) && reason.error === original).toBe(true);
        }
      }
    }),
  );

  effectIt.effect('bounds unavailable diagnostics while preserving caller cancellation', () =>
    Effect.gen(function* () {
      for (const cancel of [false, true]) {
        const started = yield* Deferred.make<void>();
        let published = false;
        const pending = yield* observeCodeGraphEvaluationDiagnostic(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              published = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        if (cancel) {
          yield* Fiber.interrupt(pending);
          const exit = yield* Fiber.await(pending);
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          expect(published).toBe(false);
        } else {
          yield* TestClock.adjust('5 seconds');
          expect(yield* Fiber.join(pending)).toEqual({state: 'unavailable'});
          expect(published).toBe(true);
        }
      }
    }),
  );
});

describe('code graph evaluation contract', () => {
  const fixture = parseCodeGraphEvaluationFixtureV1(readJson(join(FIXTURE_ROOT, 'fixture.json')));

  it('loads the reviewed fixture with every required safety category', () => {
    expect(fixture.expectedSymbols.length).toBeGreaterThanOrEqual(7);
    expect(fixture.expectedEdges.length).toBeGreaterThanOrEqual(6);
    expect(fixture.allowedAuthoritativeEdges.length).toBeGreaterThan(fixture.expectedEdges.length);
    expect(new Set(fixture.queries.map(query => query.category))).toEqual(
      new Set(['definition', 'documentation', 'impact', 'no-answer', 'path']),
    );
    expect(fixture.worktreeContracts).toEqual([expect.objectContaining({forbiddenCrossBranch: true})]);
    expect(codeGraphEvaluationFixtureHash(fixture)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('scores perfect reviewed observations without hiding no-answer or worktree safety', () => {
    const edgeKeys = fixture.expectedEdges.map(codeGraphEdgeKey);
    const observations = fixture.queries.map(query => ({
      answerable: query.answerable,
      edgeKeys,
      pathHits: query.relevantPaths ?? [],
      queryId: query.id,
      symbolHits: query.relevantSymbols,
    }));
    const metrics = evaluateCodeGraphObservations(fixture, observations, {
      actualAuthoritativeEdges: edgeKeys,
      allowedAuthoritativeEdgeKeys: fixture.allowedAuthoritativeEdges.map(codeGraphEdgeKey),
      worktreeLeakageCount: 0,
      worktreeObservationCount: 2,
    });

    expect(metrics).toEqual({
      answerableQueries: 4,
      authoritativeFalseEdgeRate: 0,
      edgeRecall: 1,
      meanReciprocalRank: 1,
      noAnswerPrecision: 1,
      noAnswerRecall: 1,
      queryCount: 5,
      symbolRecall: 1,
      worktreeLeakageRate: 0,
    });
  });

  it('counts authoritative edges outside the hand-picked endpoint domain as false positives', () => {
    const edgeKeys = fixture.expectedEdges.map(codeGraphEdgeKey);
    const observations = fixture.queries.map(query => ({
      answerable: query.answerable,
      edgeKeys,
      pathHits: query.relevantPaths ?? [],
      queryId: query.id,
      symbolHits: query.relevantSymbols,
    }));
    const unexpected = codeGraphEdgeKey({
      provenance: 'resolved',
      relation: 'calls',
      source: 'unexpectedInRepositorySource',
      target: 'unexpectedInRepositoryTarget',
    });
    const metrics = evaluateCodeGraphObservations(fixture, observations, {
      actualAuthoritativeEdges: [...edgeKeys, unexpected],
      allowedAuthoritativeEdgeKeys: fixture.allowedAuthoritativeEdges.map(codeGraphEdgeKey),
      worktreeLeakageCount: 0,
      worktreeObservationCount: 2,
    });

    expect(metrics.authoritativeFalseEdgeRate).toBe(1 / (edgeKeys.length + 1));
  });

  it('counts authoritative edges from unexpected sources into the reviewed domain', () => {
    const edgeKeys = fixture.expectedEdges.map(codeGraphEdgeKey);
    const unexpected = codeGraphEdgeKey({
      provenance: 'resolved',
      relation: 'calls',
      source: 'unexpectedInRepositorySource',
      target: 'ensureVectorIndex',
    });
    const metrics = evaluateCodeGraphObservations(
      fixture,
      fixture.queries.map(query => ({
        answerable: query.answerable,
        edgeKeys,
        pathHits: query.relevantPaths ?? [],
        queryId: query.id,
        symbolHits: query.relevantSymbols,
      })),
      {
        actualAuthoritativeEdges: [...edgeKeys, unexpected],
        allowedAuthoritativeEdgeKeys: fixture.allowedAuthoritativeEdges.map(codeGraphEdgeKey),
        worktreeLeakageCount: 0,
        worktreeObservationCount: 2,
      },
    );

    expect(metrics.authoritativeFalseEdgeRate).toBe(1 / (edgeKeys.length + 1));
  });

  it('treats zero observed failures as a zero failure rate instead of a perfect-ratio sentinel', () => {
    const edgeKeys = fixture.expectedEdges.map(codeGraphEdgeKey);
    const metrics = evaluateCodeGraphObservations(
      fixture,
      fixture.queries.map(query => ({
        answerable: query.answerable,
        edgeKeys,
        pathHits: query.relevantPaths ?? [],
        queryId: query.id,
        symbolHits: query.relevantSymbols,
      })),
      {
        actualAuthoritativeEdges: [],
        worktreeLeakageCount: 0,
        worktreeObservationCount: 0,
      },
    );

    expect(metrics.authoritativeFalseEdgeRate).toBe(0);
    expect(metrics.worktreeLeakageRate).toBe(0);
  });

  it('validates compact frozen Graphify, no-graph, and native baselines against the fixture hash', () => {
    const hash = codeGraphEvaluationFixtureHash(fixture);
    const graphify = parseCodeGraphEvaluationBaselineV1(readJson(join(BASELINE_ROOT, 'graphify-0.9.29.json')));
    const noGraph = parseCodeGraphEvaluationBaselineV1(readJson(join(BASELINE_ROOT, 'threadnote-no-graph.json')));
    const native = parseCodeGraphEvaluationBaselineV1(readJson(join(BASELINE_ROOT, 'threadnote-native.json')));

    expect(graphify.fixture).toMatchObject({hash, id: fixture.id, queries: fixture.queries.length, version: 1});
    expect(graphify.source).toEqual({name: 'graphify', version: '0.9.29'});
    expect(noGraph.fixture.hash).toBe(hash);
    expect(noGraph.source.name).toBe('threadnote-no-code-graph');
    expect(noGraph.metrics.symbolRecall).toBe(0);
    expect(noGraph.metrics.noAnswerRecall).toBe(1);
    expect(native.fixture.hash).toBe(hash);
    expect(native.source.name).toBe('threadnote-native-code-graph');
    expect(native.metrics).toMatchObject({
      authoritativeFalseEdgeRate: 0,
      edgeRecall: 1,
      meanReciprocalRank: 1,
      noAnswerPrecision: 1,
      noAnswerRecall: 1,
      symbolRecall: 1,
      worktreeLeakageRate: 0,
    });
  });

  it('stores lexical, production-vector, 10k, and 100k process baselines within reviewed budgets', () => {
    const budgets = readJson(join(BASELINE_ROOT, 'budgets.json')) as {
      readonly developmentPerformance: PerformanceBudget;
      readonly scalePerformance: Readonly<Record<string, PerformanceBudget>>;
      readonly vectorPerformance: PerformanceBudget;
      readonly vectorScalePerformance: Readonly<Record<string, PerformanceBudget>>;
    };
    const cases = [
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-vectors-development.json'))),
        budget: budgets.vectorPerformance,
        scale: undefined,
        vectors: true,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-vectors-10000-development.json'))),
        budget: budgets.vectorScalePerformance['10000'],
        scale: 10_000,
        vectors: true,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-development.json'))),
        budget: budgets.developmentPerformance,
        scale: undefined,
        vectors: false,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-10000-development.json'))),
        budget: budgets.scalePerformance['10000'],
        scale: 10_000,
        vectors: false,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-100000-development.json'))),
        budget: budgets.scalePerformance['100000'],
        scale: 100_000,
        vectors: false,
      },
    ] as const;

    for (const testCase of cases) {
      expectBenchmarkWithinBudget(testCase.artifact, testCase.budget);
      if (!testCase.vectors && testCase.scale === undefined) {
        expect(testCase.artifact.suite).toBe('code-graph-v1');
        expect(testCase.artifact.metadata.retrievalMode).toBe('lexical-only');
      } else if (testCase.vectors) {
        expect(testCase.artifact.suite).toBe('code-graph-vectors-v1');
        expect(testCase.artifact.metadata).toMatchObject({
          embeddingModelId: 'bge-small-en-v1.5-q8',
          retrievalMode: 'pinned-production-vectors',
          vectorEnabled: true,
        });
        if (testCase.scale !== undefined) expect(testCase.artifact.metadata.scaleSymbols).toBe(testCase.scale);
      } else {
        expect(testCase.artifact.suite).toBe('code-graph-scale-v1');
        expect(testCase.artifact.metadata.scaleSymbols).toBe(testCase.scale);
      }
    }
  });

  it('keeps lexical scale incremental budgets below the known minute-scale regression with runner headroom', () => {
    const budgets = readJson(join(BASELINE_ROOT, 'budgets.json')) as {
      readonly scalePerformance: Readonly<Record<string, PerformanceBudget>>;
    };
    const cases = [
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-10000-development.json'))),
        maximum: 15_000,
        scale: '10000',
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-100000-development.json'))),
        maximum: 60_000,
        scale: '100000',
      },
    ] as const;

    for (const testCase of cases) {
      const budget = budgets.scalePerformance[testCase.scale];
      const baseline = testCase.artifact.measurements.find(
        measurement => measurement.name === 'one-file-incremental-index',
      )!.p95;
      expect(budget.oneFileIncrementalP95MillisecondsMaximum).toBe(testCase.maximum);
      expect(budget.oneFileIncrementalP95MillisecondsMaximum).toBeLessThan(128_000);
      expect(budget.oneFileIncrementalP95MillisecondsMaximum).toBeGreaterThanOrEqual(baseline * 5);
    }
  });

  it('stores complete whole-graph analysis measurements through the 100k-symbol scale point', () => {
    const budgets = readJson(join(BASELINE_ROOT, 'budgets.json')) as {
      readonly developmentPerformance: PerformanceBudget;
      readonly scalePerformance: Readonly<Record<string, PerformanceBudget>>;
    };
    const cases = [
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-parity-development.json'))),
        budget: budgets.developmentPerformance,
        scale: undefined,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-parity-10000-development.json'))),
        budget: budgets.scalePerformance['10000'],
        scale: 10_000,
      },
      {
        artifact: parseBenchmarkArtifactV1(readJson(join(BASELINE_ROOT, 'performance-parity-100000-development.json'))),
        budget: budgets.scalePerformance['100000'],
        scale: 100_000,
      },
    ] as const;

    for (const testCase of cases) {
      const measurement = testCase.artifact.measurements.find(
        candidate => candidate.name === 'whole-graph-structural-analysis',
      );
      expect(testCase.artifact.metadata).toMatchObject({analysisCoverage: 'complete'});
      if (testCase.scale === undefined) expect(testCase.artifact.metadata).not.toHaveProperty('scaleSymbols');
      else expect(testCase.artifact.metadata.scaleSymbols).toBe(testCase.scale);
      expect(measurement?.p95).toBeLessThanOrEqual(testCase.budget.wholeGraphAnalysisP95MillisecondsMaximum);
    }
  });

  it('freezes an opt-in production-shaped large-monorepo profile without inventing a latency baseline', () => {
    const reviewed = readJson(join(BASELINE_ROOT, 'production-large-profile.json')) as {
      readonly fixture: {
        readonly activeWorkspaceExcludedPackageCount: number;
        readonly activeWorkspaceExcludedSourceFiles: number;
        readonly classMix: ProductionCodeGraphFixtureProfile['classMix'];
        readonly declarationSymbols: number;
        readonly duplicateBlobs: ProductionCodeGraphFixtureProfile['duplicateBlobs'];
        readonly highSignalConfigHardCapBytes: number;
        readonly lowSignalJsonExclusionThresholdBytes: number;
        readonly maxCallsPerDeclaration: number;
        readonly sourceFiles: number;
        readonly surrogate: string;
        readonly workspaceCount: number;
        readonly worktreeChurnScenarios: readonly string[];
      };
      readonly targetEligibility: {
        readonly excluded: {
          readonly files: number;
          readonly generatedSvg: {readonly bytes: number; readonly files: number};
          readonly heavyJson: {readonly bytes: number; readonly files: number};
          readonly totalBytes: number;
        };
        readonly highSignalConfigHardCapBytes: number;
        readonly lowSignalJsonExclusionThresholdBytes: number;
      };
      readonly notes: readonly string[];
      readonly profile: string;
      readonly targets: {
        readonly eligibleFiles: number;
        readonly graphEdges: number;
        readonly graphSymbols: number;
        readonly lexicalTermRows: number;
        readonly repositoryFiles: number;
      };
      readonly version: number;
    };

    expect(reviewed).toMatchObject({
      fixture: {
        activeWorkspaceExcludedPackageCount: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.activeWorkspaceExcludedPackageCount,
        activeWorkspaceExcludedSourceFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.activeWorkspaceExcludedSourceFiles,
        classMix: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.classMix,
        declarationSymbols: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.declarationSymbols,
        duplicateBlobs: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.duplicateBlobs,
        highSignalConfigHardCapBytes: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.highSignalConfigHardCapBytes,
        lowSignalJsonExclusionThresholdBytes: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.lowSignalJsonExclusionThresholdBytes,
        maxCallsPerDeclaration: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.maxCallsPerDeclaration,
        sourceFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.sourceFiles,
        surrogate: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.surrogate,
        workspaceCount: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.workspaceCount,
        worktreeChurnScenarios: PRODUCTION_WORKTREE_CHURN_SCENARIOS,
      },
      profile: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.id,
      targets: {
        eligibleFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetEligibleFiles,
        graphEdges: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphEdges,
        graphSymbols: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphSymbols,
        lexicalTermRows: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetLexicalTermRows,
        repositoryFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetRepositoryFiles,
      },
      version: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.version,
    });
    expect(productionWorkspaceRoots(reviewed.fixture.workspaceCount)).toEqual(
      expect.arrayContaining([
        'apps/application-00',
        'apps/integrated/modules/module-00',
        'apps/isolated/packages/package-00',
        'libs/library-00',
      ]),
    );
    expect(reviewed.notes.join(' ')).toContain('no synthetic latency baseline');
    expect(reviewed.notes.join(' ')).toContain('workspace exclusion never removes active source');
    expect(productionRepositoryFileCount(reviewed.fixture.classMix)).toBe(reviewed.targets.repositoryFiles);
    expect(productionEligibleFileCount(reviewed.fixture.classMix)).toBe(reviewed.targets.eligibleFiles);
    const excludedBytes = productionExcludedByteDistribution(PRODUCTION_LARGE_CODE_GRAPH_PROFILE);
    expect(reviewed.targetEligibility).toEqual({
      excluded: {
        files:
          PRODUCTION_LARGE_CODE_GRAPH_PROFILE.classMix.generatedSvgFiles +
          PRODUCTION_LARGE_CODE_GRAPH_PROFILE.classMix.duplicateHeavyJsonFiles,
        generatedSvg: {
          bytes: excludedBytes.generatedSvgBytes,
          files: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.classMix.generatedSvgFiles,
        },
        heavyJson: {
          bytes: excludedBytes.heavyJsonBytes,
          files: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.classMix.duplicateHeavyJsonFiles,
        },
        totalBytes: excludedBytes.totalBytes,
      },
      highSignalConfigHardCapBytes: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.highSignalConfigHardCapBytes,
      lowSignalJsonExclusionThresholdBytes: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.lowSignalJsonExclusionThresholdBytes,
    });
    expect(reviewed.fixture.worktreeChurnScenarios).toEqual(
      expect.arrayContaining(['concurrent-linked-worktree-builds', 'catalog-read-during-active-writer']),
    );
  });

  it('tracks exact repository classes and keeps active source outside pnpm membership graph-eligible', async () => {
    const observed = await runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const profile = validateProductionProfile({
            activeWorkspaceExcludedPackageCount: 2,
            activeWorkspaceExcludedSourceFiles: 4,
            classMix: {
              duplicateHeavyJsonFiles: 4,
              generatedSvgFiles: 6,
              nxProjectFiles: 3,
              packageManifestFiles: 9,
              supportMarkdownFiles: 5,
              tsconfigFiles: 5,
              tsxSourceFiles: 4,
              typescriptSourceFiles: 8,
              workspaceManifestFiles: 1,
            },
            declarationSymbols: 24,
            duplicateBlobs: {
              generatedSvgVariants: 2,
              heavyJsonPayloadBytes: CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
              heavyJsonVariants: 2,
            },
            highSignalConfigHardCapBytes: CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES,
            id: 'production-large',
            lowSignalJsonExclusionThresholdBytes: CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
            maxCallsPerDeclaration: 1,
            sourceFiles: 12,
            surrogate: 'threadnote-4.1.0-beta.1-public-monorepo',
            targetEligibleFiles: 35,
            targetGraphEdges: 150,
            targetGraphSymbols: 99,
            targetLexicalTermRows: 1_000,
            targetRepositoryFiles: 45,
            version: 2,
            workspaceCount: 8,
            worktreeChurnScenarioCount: 6,
          });
          const prepared = yield* prepareProductionCodeGraphFixture(profile);
          const tracked = (yield* git(prepared.repository, ['ls-files'])).stdout.trim().split('\n');
          const staged = (yield* git(prepared.repository, ['ls-files', '--stage'])).stdout.trim().split('\n');
          const tree = (yield* git(prepared.repository, ['ls-tree', '-r', '-l', 'HEAD'])).stdout.trim().split('\n');
          const identity = yield* resolveRepositoryIdentity(prepared.repository);
          const inventory = yield* inventoryRepository(identity, {includeOverlay: false});
          const workspace = discoverManifestWorkspace(inventory.files);
          return {
            incrementalSourcePath: prepared.incrementalSourcePath,
            inventory,
            profile,
            queryText: prepared.queryText,
            staged,
            tracked,
            tree,
            workspace,
          };
        }),
      ),
    );

    const classify = (pattern: RegExp) => observed.tracked.filter(candidate => pattern.test(candidate)).length;
    expect(observed.incrementalSourcePath).toBe('apps/application-00/src/module-00000.ts');
    expect(observed.queryText).toContain('FeatureOperation0000023');
    expect(observed.tracked).toHaveLength(45);
    expect(productionEligibleFileCount(observed.profile.classMix)).toBe(35);
    expect(classify(/\.tsx$/)).toBe(4);
    expect(classify(/\.ts$/)).toBe(8);
    expect(classify(/\.svg$/)).toBe(6);
    expect(classify(/(?:^|\/)package\.json$/)).toBe(9);
    expect(classify(/(?:^|\/)project\.json$/)).toBe(3);
    expect(classify(/(?:^|\/)tsconfig\.json$/)).toBe(5);
    expect(classify(/^test\/golden-data\/.*\.json$/)).toBe(4);
    expect(classify(/^docs\/support\/.*\.md$/)).toBe(5);
    expect(classify(/^pnpm-workspace\.yaml$/)).toBe(1);

    const activeExcludedSources = observed.inventory.files.filter(file =>
      /^packages\/active-excluded-[^/]+\/src\/.*\.tsx?$/.test(file.path),
    );
    expect(activeExcludedSources).toHaveLength(4);
    expect(observed.inventory.files).toHaveLength(35);
    expect(observed.inventory.skipped).toBe(10);
    expect(observed.inventory.files.some(file => /\.svg$/i.test(file.path))).toBe(false);
    expect(observed.inventory.files.some(file => /^test\/golden-data\/.*\.json$/i.test(file.path))).toBe(false);
    const excludedProject = observed.workspace.projects.find(project =>
      project.root.startsWith('packages/active-excluded-'),
    );
    const includedProject = observed.workspace.projects.find(project => project.root === 'apps/application-00');
    expect(excludedProject).toBeDefined();
    expect(excludedProject!.workspaceRoots).toEqual([excludedProject!.root]);
    expect(includedProject?.workspaceRoots).toEqual(['']);

    const blobIds = (pattern: RegExp) =>
      new Set(
        observed.staged.flatMap(line => {
          const match = /^\d+ ([0-9a-f]+) \d+\t(.+)$/.exec(line);
          return match?.[1] && match[2] && pattern.test(match[2]) ? [match[1]] : [];
        }),
      );
    expect(blobIds(/\.svg$/).size).toBe(2);
    expect(blobIds(/^test\/golden-data\/.*\.json$/).size).toBe(2);
    const treeBytes = (pattern: RegExp) =>
      observed.tree.reduce((total, line) => {
        const match = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(line);
        return match?.[1] && match[2] && pattern.test(match[2]) ? total + Number(match[1]) : total;
      }, 0);
    const excludedBytes = productionExcludedByteDistribution(observed.profile);
    expect(treeBytes(/\.svg$/)).toBe(excludedBytes.generatedSvgBytes);
    expect(treeBytes(/^test\/golden-data\/.*\.json$/)).toBe(excludedBytes.heavyJsonBytes);
    expect(observed.inventory.policyExclusions).toMatchObject({
      bytes: excludedBytes.totalBytes,
      files: 10,
      reasons: [
        {bytes: excludedBytes.generatedSvgBytes, files: 6, reason: 'svg'},
        {bytes: excludedBytes.heavyJsonBytes, files: 4, reason: 'low-signal-json'},
        {bytes: 0, files: 0, reason: 'generic-json-size'},
        {bytes: 0, files: 0, reason: 'high-signal-json-hard-cap'},
      ],
    });
  });

  it('validates the production profile class-accounting property and rejects contract drift', () => {
    fc.assert(
      fc.property(
        fc.record({
          activeExcludedPackages: fc.integer({min: 1, max: 8}),
          activeExcludedSources: fc.integer({min: 1, max: 32}),
          duplicateJson: fc.integer({min: 1, max: 8}),
          generatedSvg: fc.integer({min: 1, max: 16}),
          nxProjects: fc.integer({min: 1, max: 8}),
          sourceFiles: fc.integer({min: 32, max: 96}),
          supportMarkdown: fc.integer({min: 1, max: 16}),
          tsconfigs: fc.integer({min: 1, max: 8}),
          tsxSourceFiles: fc.integer({min: 1, max: 31}),
          workspaceCount: fc.integer({min: 8, max: 32}),
        }),
        values => {
          const workspaceCount = Math.max(values.workspaceCount, values.activeExcludedPackages + 1);
          const sourceFiles = Math.max(values.sourceFiles, values.activeExcludedSources + 1, values.tsxSourceFiles + 1);
          const classMix = {
            duplicateHeavyJsonFiles: values.duplicateJson,
            generatedSvgFiles: values.generatedSvg,
            nxProjectFiles: Math.min(values.nxProjects, workspaceCount),
            packageManifestFiles: workspaceCount + 1,
            supportMarkdownFiles: values.supportMarkdown,
            tsconfigFiles: Math.min(values.tsconfigs, workspaceCount + 1),
            tsxSourceFiles: values.tsxSourceFiles,
            typescriptSourceFiles: sourceFiles - values.tsxSourceFiles,
            workspaceManifestFiles: 1,
          } as const;
          const profile = productionProfileForTest({
            activeWorkspaceExcludedPackageCount: values.activeExcludedPackages,
            activeWorkspaceExcludedSourceFiles: values.activeExcludedSources,
            classMix,
            sourceFiles,
            targetEligibleFiles: productionEligibleFileCount(classMix),
            targetRepositoryFiles: productionRepositoryFileCount(classMix),
            workspaceCount,
          });
          expect(validateProductionProfile(profile)).toBe(profile);
        },
      ),
      {numRuns: 100},
    );

    expect(() =>
      validateProductionProfile({
        ...PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
        targetRepositoryFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetRepositoryFiles - 1,
      }),
    ).toThrow(/class mix/i);
    expect(() =>
      validateProductionProfile({
        ...PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
        targetEligibleFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetEligibleFiles - 1,
      }),
    ).toThrow(/eligible class mix/i);
    expect(() =>
      validateProductionProfile({
        ...PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
        classMix: {...PRODUCTION_LARGE_CODE_GRAPH_PROFILE.classMix, typescriptSourceFiles: 44_999},
      }),
    ).toThrow(/source class/i);
    expect(() =>
      validateProductionProfile({
        ...PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
        activeWorkspaceExcludedSourceFiles: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.sourceFiles,
      }),
    ).toThrow(/active workspace-excluded source/i);
    expect(() =>
      validateProductionProfile({
        ...PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
        lowSignalJsonExclusionThresholdBytes: CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES + 1,
      }),
    ).toThrow(/runtime inventory admission policy/i);
    expect(() =>
      validateProductionProfile({
        ...PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
        highSignalConfigHardCapBytes: CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES + 1,
      }),
    ).toThrow(/runtime inventory admission policy/i);
  });

  it('stores a passing Java, Kotlin, Swift, and compiler-backed TypeScript baseline and performance gate', () => {
    const polyglotFixture = parseCodeGraphEvaluationFixtureV1(readJson(join(POLYGLOT_FIXTURE_ROOT, 'fixture.json')));
    const baseline = parseCodeGraphEvaluationBaselineV1(
      readJson(join(POLYGLOT_BASELINE_ROOT, 'threadnote-native.json')),
    );
    const artifact = parseBenchmarkArtifactV1(readJson(join(POLYGLOT_BASELINE_ROOT, 'performance-development.json')));
    const budgets = readJson(join(POLYGLOT_BASELINE_ROOT, 'budgets.json')) as {
      readonly developmentPerformance: PerformanceBudget;
      readonly fixture: {readonly hash: string; readonly id: string};
    };
    const hash = codeGraphEvaluationFixtureHash(polyglotFixture);

    expect(polyglotFixture.languages).toEqual(['java', 'kotlin', 'swift', 'typescript']);
    expect(baseline.fixture).toEqual({
      hash,
      id: polyglotFixture.id,
      queries: polyglotFixture.queries.length,
      version: polyglotFixture.version,
    });
    expect(baseline.metrics).toMatchObject({
      authoritativeFalseEdgeRate: 0,
      edgeRecall: 1,
      meanReciprocalRank: 1,
      noAnswerPrecision: 1,
      noAnswerRecall: 1,
      symbolRecall: 1,
      worktreeLeakageRate: 0,
    });
    expect(budgets.fixture).toEqual({hash, id: polyglotFixture.id});
    expect(artifact.suite).toBe('code-graph-polyglot-v1');
    expect(artifact.environment.fixtureHash).toBe(hash);
    expectBenchmarkWithinBudget(artifact, budgets.developmentPerformance);
  });
});

interface PerformanceBudget {
  readonly coldIndexP95MillisecondsMaximum: number;
  readonly derivedIndexBytesMaximum: number;
  readonly hotQueryP95MillisecondsMaximum: number;
  readonly oneFileIncrementalP95MillisecondsMaximum: number;
  readonly processPeakRssBytesMaximum: number;
  readonly wholeGraphAnalysisP95MillisecondsMaximum: number;
}

function expectBenchmarkWithinBudget(artifact: BenchmarkArtifactV1, budget: PerformanceBudget): void {
  const measurements = new Map(artifact.measurements.map(measurement => [measurement.name, measurement]));
  expect(measurements.get('cold-index')?.p95).toBeLessThanOrEqual(budget.coldIndexP95MillisecondsMaximum);
  expect(measurements.get('one-file-incremental-index')?.p95).toBeLessThanOrEqual(
    budget.oneFileIncrementalP95MillisecondsMaximum,
  );
  const queryMeasurement =
    artifact.metadata.vectorEnabled === true ? 'hot-semantic-vector-query' : 'hot-exact-lexical-query';
  expect(measurements.get(queryMeasurement)?.p95).toBeLessThanOrEqual(budget.hotQueryP95MillisecondsMaximum);
  expect(measurements.get('cold-process-peak-rss')?.p95).toBeLessThanOrEqual(budget.processPeakRssBytesMaximum);
  expect(measurements.get('incremental-process-peak-rss')?.p95).toBeLessThanOrEqual(budget.processPeakRssBytesMaximum);
  expect(measurements.get('derived-index-disk')?.p95).toBeLessThanOrEqual(budget.derivedIndexBytesMaximum);
}

function productionProfileForTest(
  values: Pick<
    ProductionCodeGraphFixtureProfile,
    | 'activeWorkspaceExcludedPackageCount'
    | 'activeWorkspaceExcludedSourceFiles'
    | 'classMix'
    | 'sourceFiles'
    | 'targetEligibleFiles'
    | 'targetRepositoryFiles'
    | 'workspaceCount'
  >,
): ProductionCodeGraphFixtureProfile {
  return {
    ...values,
    declarationSymbols: values.sourceFiles * 2,
    duplicateBlobs: {
      generatedSvgVariants: 1,
      heavyJsonPayloadBytes: CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
      heavyJsonVariants: 1,
    },
    highSignalConfigHardCapBytes: CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES,
    id: 'production-large',
    lowSignalJsonExclusionThresholdBytes: CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
    maxCallsPerDeclaration: 1,
    surrogate: 'threadnote-4.1.0-beta.1-public-monorepo',
    targetGraphEdges: values.sourceFiles * 4,
    targetGraphSymbols: values.sourceFiles * 3,
    targetLexicalTermRows: values.sourceFiles * 10,
    version: 2,
    worktreeChurnScenarioCount: 6,
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

import {readFile} from '@threadnote/testing/node-fs-promises';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  createMatchedEvaluationManifestV1,
  matchedEvaluationReferenceEnvironmentPolicyHashV1,
  parseMatchedEvaluationCorpusV1,
  type MatchedEvaluationArm,
  type MatchedEvaluationArmDefinitionV1,
  type MatchedEvaluationCorpusV1,
  type MatchedEvaluationManifestV1,
  MATCHED_EVALUATION_ARMS,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {
  runMatchedEvaluationV1,
  type MatchedEvaluationMetricsV1,
  type MatchedEvaluationObservationV1,
  type MatchedEvaluationOutcomeV1,
} from '@threadnote/threadnote/evaluation/matched-evaluation-runner';
import {
  assertMatchedTokenEfficiencyStudyMatchesV1,
  createMatchedTokenEfficiencyStudyV1,
  createMatchedTokenEfficiencyTaskContextV1,
  evaluateMatchedTokenEfficiencyV1,
  matchedTokenEfficiencyCitationHashV1,
  matchedTokenEfficiencyGraphContentHashV1,
  matchedTokenEfficiencyGraphSnapshotHashV1,
  renderMatchedTokenEfficiencyArticleEvidenceV1,
  type MatchedTokenEfficiencyStudyV1,
} from '@threadnote/threadnote/evaluation/matched-token-efficiency';
import {createMatchedEvaluationVerificationReceiptV1} from '@threadnote/threadnote/evaluation/matched-verification';
import {projectMatchedEvaluationAdapterTaskV1} from '../../../../scripts/run-matched-evaluation.js';

describe('matched token-efficiency claim evaluation', () => {
  it('reports blocked actions without changing verification or safety gates', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);
    const study = createStudy(corpus, manifest);
    const baseline = await outcomesFor(corpus, manifest, study);
    const baselineReport = evaluateMatchedTokenEfficiencyV1({corpus, manifest, outcomes: baseline, study});
    expect(study.version).toBe(2);
    expect(baselineReport.version).toBe(3);
    await fc.assert(
      fc.asyncProperty(fc.integer({min: 0, max: 100}), async blockedCount => {
        const blocked = await outcomesFor(corpus, manifest, study, (_arm, _runOrder, metrics) => ({
          ...metrics,
          safety: {...metrics.safety, blockedActions: blockedCount},
        }));
        const blockedReport = evaluateMatchedTokenEfficiencyV1({corpus, manifest, outcomes: blocked, study});
        expect(blockedReport.arms.map(arm => arm.verifiedCompletions)).toEqual(
          baselineReport.arms.map(arm => arm.verifiedCompletions),
        );
        expect(blockedReport.comparisons.map(comparison => comparison.status)).toEqual(
          baselineReport.comparisons.map(comparison => comparison.status),
        );
        expect(blockedReport.arms.map(arm => arm.blockedActions)).toEqual(
          baselineReport.arms.map(arm => arm.assigned * blockedCount),
        );
      }),
      {numRuns: 8},
    );
  });

  it('domain-separates frozen graph and citation identities deterministically', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc
            .array(fc.constantFrom(...'0123456789abcdef'), {minLength: 40, maxLength: 40})
            .map(characters => characters.join('')),
          fc.constantFrom('', '-direct', `-full-${'f'.repeat(16)}`),
        ),
        ([value, suffix]) => {
          const snapshotId = `cgsn_${value}${suffix}`;
          const snapshot = matchedTokenEfficiencyGraphSnapshotHashV1(snapshotId);
          const content = matchedTokenEfficiencyGraphContentHashV1(`cgc_${value}`);
          const citation = matchedTokenEfficiencyCitationHashV1({
            citationId: `tncc_${value}`,
            fixtureMemoryId: `mem_${value}`,
            managedMemoryId: `tn_${value}`,
          });

          expect(snapshot).toMatch(/^[0-9a-f]{64}$/u);
          expect(new Set([snapshot, content, citation])).toHaveLength(3);
          expect(matchedTokenEfficiencyGraphSnapshotHashV1(snapshotId)).toBe(snapshot);
        },
      ),
      {numRuns: 40},
    );
    expect(() => matchedTokenEfficiencyGraphSnapshotHashV1(`cgsn_${'a'.repeat(40)}-full-short`)).toThrow(
      'ready graph snapshot id is invalid',
    );
  });

  it('admits a memory-free prepared source context for continuation studies', async () => {
    const context = createMatchedTokenEfficiencyTaskContextV1({
      asIssuedContext: {
        assessmentHash: '1'.repeat(64),
        contentHash: null,
        sufficiency: 'none',
        suppliedBytes: 0,
      },
      clusterId: 'cluster_1234567890abcdef',
      graphContentHash: '2'.repeat(64),
      graphSnapshotHash: '3'.repeat(64),
      linkReceipts: [],
      memoryFixtureHash: '4'.repeat(64),
      repositoryFixtureHash: '5'.repeat(64),
      taskId: 'tsk_1234567890abcdef',
    });

    expect(context.linkReceipts).toEqual([]);
    expect(context.linkReceiptsHash).toMatch(/^[0-9a-f]{64}$/u);

    const sourceCorpus = await fixture();
    const corpus = parseMatchedEvaluationCorpusV1({
      ...sourceCorpus,
      tasks: sourceCorpus.tasks.map(task => ({...task, memoryFixtures: []})),
    });
    const manifest = createManifest(corpus);
    const study = createStudy(corpus, manifest);
    expect(() => assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest)).not.toThrow();
  });

  it('passes only with failure-inclusive provider usage, ready graph receipts, and clustered intervals', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);
    const study = createStudy(corpus, manifest);
    const outcomes = await outcomesFor(corpus, manifest, study);

    const report = evaluateMatchedTokenEfficiencyV1({corpus, manifest, outcomes, study});

    expect(report.comparisons).toEqual([
      expect.objectContaining({
        baselineArm: 'files',
        effect: 'graph',
        status: 'failed',
        targetArm: 'threadnote-graph',
      }),
      expect.objectContaining({
        baselineArm: 'files',
        effect: 'total',
        status: 'passed',
        targetArm: 'threadnote-compact',
      }),
      expect.objectContaining({
        baselineArm: 'files',
        effect: 'total',
        status: 'passed',
        targetArm: 'threadnote-source',
      }),
      expect.objectContaining({
        baselineArm: 'threadnote-graph',
        effect: 'memory-increment',
        status: 'passed',
        targetArm: 'threadnote-compact',
      }),
    ]);
    expect(report.comparisons[0].tokenReductionPercent).toBeCloseTo(15);
    expect(report.comparisons[1].tokenReductionPercent).toBeCloseTo(30);
    expect(report.comparisons[2].tokenReductionPercent).toBeCloseTo(40);
    expect(report.comparisons[3].tokenReductionPercent).toBeCloseTo(17.65, 1);
    expect(report.comparisons[3].contextStrata.map(stratum => stratum.sufficiency)).toEqual([
      'none',
      'lacking',
      'sufficient',
      'excessive',
    ]);
    expect(report.arms.find(arm => arm.arm === 'files')).toMatchObject({
      onlineTokensPerVerifiedCompletion: 1_000,
      providerTokens: {totalTokens: 30_000},
      verifiedCompletions: 30,
    });
    expect(report.arms.find(arm => arm.arm === 'threadnote-source')).toMatchObject({
      lifecycleTokensPerVerifiedCompletion: 700,
      onlineTokensPerVerifiedCompletion: 600,
      providerTokens: {totalTokens: 18_000},
      verifiedCompletions: 30,
    });
    const evidence = renderMatchedTokenEfficiencyArticleEvidenceV1(report);
    expect(evidence).toContain(`Report hash: ${report.reportHash}`);
    expect(evidence).toContain('Failure-inclusive provider tokens: 30000');
    expect(evidence).toContain('ready graph snapshot and pre-existing finalized memory-link receipts');
    expect(evidence).toContain('As-issued context excessive');
  });

  it('charges failed task tokens to the arm while excluding the failure from verified completions', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);
    const study = createStudy(corpus, manifest);
    const outcomes = await outcomesFor(corpus, manifest, study, (arm, runOrder, metrics) =>
      arm === 'threadnote-compact' && runOrder === firstRunOrder(manifest, arm)
        ? {
            ...metrics,
            completion: {completed: false},
            correctness: {...metrics.correctness, judgeCompleted: false, scoreMilli: 0},
            verification: failedVerification(required(metrics.verification)),
          }
        : metrics,
    );

    const report = evaluateMatchedTokenEfficiencyV1({corpus, manifest, outcomes, study});
    const compact = report.arms.find(arm => arm.arm === 'threadnote-compact');

    expect(compact).toMatchObject({providerTokens: {totalTokens: 21_000}, verifiedCompletions: 29});
    expect(compact?.onlineTokensPerVerifiedCompletion).toBeCloseTo(21_000 / 29);
  });

  it('uses deterministic completion as primary and reports verifier-judge disagreement separately', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);
    const study = createStudy(corpus, manifest);
    const outcomes = await outcomesFor(corpus, manifest, study, (arm, runOrder, metrics) =>
      arm === 'threadnote-compact' && runOrder === firstRunOrder(manifest, arm)
        ? {...metrics, correctness: {...metrics.correctness, judgeCompleted: false, scoreMilli: 0}}
        : metrics,
    );

    const report = evaluateMatchedTokenEfficiencyV1({corpus, manifest, outcomes, study});
    const compact = required(report.arms.find(arm => arm.arm === 'threadnote-compact'));

    expect(compact).toMatchObject({
      hybridVerifiedCompletions: 29,
      verifiedCompletions: 30,
      verifierPassedJudgeFailed: 1,
    });
    expect(renderMatchedTokenEfficiencyArticleEvidenceV1(report)).toContain(
      'Verifier pass / judge fail disagreements: 1',
    );
  });

  it('fails closed on mismatched context or missing provider usage', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);
    const study = createStudy(corpus, manifest);
    const mismatched = await outcomesFor(corpus, manifest, study, (arm, runOrder, metrics) =>
      arm === 'threadnote-source' && runOrder === firstRunOrder(manifest, arm)
        ? {...metrics, context: {...required(metrics.context), graphSnapshotHash: 'f'.repeat(64)}}
        : metrics,
    );
    expect(() => evaluateMatchedTokenEfficiencyV1({corpus, manifest, outcomes: mismatched, study})).toThrow(
      'does not prove the frozen ready graph and linked memories',
    );

    const missingUsage = await outcomesFor(corpus, manifest, study, (arm, runOrder, metrics) =>
      arm === 'threadnote-compact' && runOrder === firstRunOrder(manifest, arm)
        ? {...metrics, usage: {...metrics.usage, providerTokens: null}}
        : metrics,
    );
    const report = evaluateMatchedTokenEfficiencyV1({corpus, manifest, outcomes: missingUsage, study});
    expect(report.comparisons.find(comparison => comparison.targetArm === 'threadnote-compact')).toMatchObject({
      status: 'inconclusive',
      insufficiencies: ['threadnote-compact has 1 completed trials without provider token usage'],
    });
  });

  it('canonicalizes preregistered arm, target, and task order deterministically', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);
    const canonical = studyInput(corpus, manifest);

    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.integer({min: 0, max: canonical.taskContexts.length - 1}),
        (reverseArms, reverseTargets, rotation) => {
          const taskContexts = [
            ...canonical.taskContexts.slice(rotation),
            ...canonical.taskContexts.slice(0, rotation),
          ];
          const candidate = createMatchedTokenEfficiencyStudyV1({
            ...canonical,
            clusters: reverseArms ? [...canonical.clusters].reverse() : canonical.clusters,
            lifecycle: reverseArms ? [...canonical.lifecycle].reverse() : canonical.lifecycle,
            targetArms: reverseTargets ? [...canonical.targetArms].reverse() : canonical.targetArms,
            taskContexts,
          });

          expect(candidate).toEqual(createMatchedTokenEfficiencyStudyV1(canonical));
        },
      ),
      {numRuns: 40},
    );
  });

  it('keeps memory contents out of every adapter request and reveals prepared identities only to Threadnote arms', async () => {
    const corpus = await fixture();
    const manifest = createManifest(corpus);
    const study = createStudy(corpus, manifest);
    const task = corpus.tasks[0];
    const files = projectMatchedEvaluationAdapterTaskV1({arm: 'files', task}, study);
    const graph = projectMatchedEvaluationAdapterTaskV1({arm: 'threadnote-graph', task}, study);
    const threadnote = projectMatchedEvaluationAdapterTaskV1({arm: 'threadnote-compact', task}, study);

    expect(files).toMatchObject({agentTask: {memoryFixtures: []}, preparedContext: null});
    expect(threadnote).toMatchObject({
      agentTask: {memoryFixtures: []},
      preparedContext: {memoryAccess: 'linked', studyHash: study.studyHash, taskContext: {taskId: task.taskId}},
    });
    expect(graph).toMatchObject({
      agentTask: {memoryFixtures: []},
      preparedContext: {
        graphContext: {taskId: task.taskId},
        memoryAccess: 'disabled',
        studyHash: study.studyHash,
      },
    });
    expect(JSON.stringify(graph)).not.toContain('linkReceipts');
    for (const memory of task.memoryFixtures) {
      expect(JSON.stringify(files)).not.toContain(memory.text);
      expect(JSON.stringify(graph)).not.toContain(memory.text);
      expect(JSON.stringify(threadnote)).not.toContain(memory.text);
    }
  });
});

async function fixture(): Promise<MatchedEvaluationCorpusV1> {
  const path = new URL('../evaluation/fixtures/matched-evaluation-v1/fixture.json', import.meta.url);
  return parseMatchedEvaluationCorpusV1(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

function createManifest(corpus: MatchedEvaluationCorpusV1): MatchedEvaluationManifestV1 {
  return createMatchedEvaluationManifestV1({
    arms: armDefinitions(),
    corpus,
    model: {model: 'test-model', parametersHash: 'b'.repeat(64), provider: 'provider-neutral'},
    repetitions: 5,
    repository: {
      dirty: false,
      fixtureHash: 'c'.repeat(64),
      identityHash: 'd'.repeat(64),
      revision: 'fixture-revision-v1',
    },
    scheduleSeed: 'a'.repeat(64),
  });
}

function createStudy(corpus: MatchedEvaluationCorpusV1, manifest: MatchedEvaluationManifestV1) {
  return createMatchedTokenEfficiencyStudyV1(studyInput(corpus, manifest));
}

function studyInput(
  corpus: MatchedEvaluationCorpusV1,
  manifest: MatchedEvaluationManifestV1,
): Omit<MatchedTokenEfficiencyStudyV1, 'studyHash' | 'version'> {
  return {
    bootstrap: {confidenceLevelBasisPoints: 9_500, iterations: 500, seed: '1'.repeat(64)},
    clusters: manifest.tasks.map((task, index) => ({
      clusterId: `cluster_${(index + 1).toString(16).repeat(16)}`,
      heldOut: true,
      repositoryFixtureHash: task.repositoryFixtureHash,
      repositoryIdentityHash: ((index + 11) % 16).toString(16).repeat(64),
      repositoryUrl: `https://example.invalid/held-out-repository-${index + 1}.git`,
      revision: (index + 1).toString(16).repeat(40),
      taskIds: [task.taskId],
    })),
    gates: {
      completionNonInferiorityBasisPoints: 500,
      maximumAuthorizationLeaks: 0,
      maximumFalseCurrentOutcomes: 0,
      maximumHarmfulActions: 0,
      minimumClusters: 6,
      minimumCorrectnessScoreMilli: 1_000,
      minimumMemoryTokenReductionBasisPoints: 1_000,
      minimumTokenReductionBasisPoints: 2_000,
    },
    lifecycle: MATCHED_EVALUATION_ARMS.map(arm => ({
      arm,
      setupMilliseconds: arm.startsWith('threadnote-') ? 60_000 : 0,
      setupUsage: {
        graphPreparation: providerTokens(
          arm === 'threadnote-graph' || arm === 'threadnote-compact' ? 1_500 : arm === 'threadnote-source' ? 1_800 : 0,
        ),
        memoryAuthoring: providerTokens(arm === 'threadnote-compact' ? 750 : arm === 'threadnote-source' ? 750 : 0),
        memoryReview: providerTokens(arm === 'threadnote-compact' ? 750 : arm === 'threadnote-source' ? 450 : 0),
      },
    })),
    manifestHash: manifest.manifestHash,
    promptPolicy: 'identical-as-issued',
    studyId: 'held-out-local-test-v1',
    targetArms: ['threadnote-compact', 'threadnote-source'],
    taskContexts: manifest.tasks.map((manifestTask, index) => {
      const corpusTask = required(corpus.tasks.find(task => task.taskId === manifestTask.taskId));
      const memory = corpusTask.memoryFixtures.find(
        candidate => candidate.status === 'active' && candidate.source !== null,
      );
      const sufficiency = (['none', 'lacking', 'sufficient', 'excessive', 'lacking', 'sufficient'] as const)[index];
      return createMatchedTokenEfficiencyTaskContextV1({
        asIssuedContext: {
          assessmentHash: (index + 3).toString(16).repeat(64),
          contentHash: sufficiency === 'none' ? null : (index + 4).toString(16).repeat(64),
          sufficiency,
          suppliedBytes: sufficiency === 'none' ? 0 : (index + 1) * 100,
        },
        clusterId: `cluster_${(index + 1).toString(16).repeat(16)}`,
        graphContentHash: (index + 1).toString(16).repeat(64),
        graphSnapshotHash: (index + 7).toString(16).repeat(64),
        linkReceipts:
          memory === undefined
            ? []
            : [{citationHash: (index + 9).toString(16).repeat(64), memoryId: memory.memoryId, status: 'exact'}],
        memoryFixtureHash: manifestTask.memoryFixtureHash,
        repositoryFixtureHash: manifestTask.repositoryFixtureHash,
        taskId: manifestTask.taskId,
      });
    }),
    verificationPlanHash: 'f'.repeat(64),
  };
}

async function outcomesFor(
  corpus: MatchedEvaluationCorpusV1,
  manifest: MatchedEvaluationManifestV1,
  study: MatchedTokenEfficiencyStudyV1,
  transform: (
    arm: MatchedEvaluationArm,
    runOrder: number,
    metrics: MatchedEvaluationMetricsV1,
  ) => MatchedEvaluationMetricsV1 = (_arm, _runOrder, metrics) => metrics,
): Promise<readonly MatchedEvaluationOutcomeV1[]> {
  return runMatchedEvaluationV1({
    availability: async () => ({available: true as const}),
    corpus,
    execute: async request => {
      const taskContext = required(study.taskContexts.find(context => context.taskId === request.task.taskId));
      const metrics = metricsFor(request.arm, study, taskContext, request.schedule.runOrder);
      return observation(request.schedule.runOrder, transform(request.arm, request.schedule.runOrder, metrics));
    },
    manifest,
  });
}

function metricsFor(
  arm: MatchedEvaluationArm,
  study: MatchedTokenEfficiencyStudyV1,
  taskContext: MatchedTokenEfficiencyStudyV1['taskContexts'][number],
  runOrder: number,
): MatchedEvaluationMetricsV1 {
  const total =
    arm === 'files'
      ? 1_000
      : arm === 'threadnote-graph'
        ? 850
        : arm === 'threadnote-compact'
          ? 700
          : arm === 'threadnote-source'
            ? 600
            : 900;
  return {
    auditability: {citations: 2, resolvableCitations: 2},
    completion: {completed: true},
    context:
      arm === 'threadnote-compact' || arm === 'threadnote-source'
        ? {
            graphReady: true,
            graphSnapshotHash: taskContext.graphSnapshotHash,
            linkReceiptsHash: taskContext.linkReceiptsHash,
            memoryAccess: 'linked',
            studyHash: study.studyHash,
            taskContextHash: taskContext.taskContextHash,
          }
        : arm === 'threadnote-graph'
          ? {
              graphReady: true,
              graphSnapshotHash: taskContext.graphSnapshotHash,
              linkReceiptsHash: null,
              memoryAccess: 'disabled',
              studyHash: study.studyHash,
              taskContextHash: null,
            }
          : null,
    correctness: {judge: 'blinded-rubric-v1', judgeCompleted: true, scoreMilli: 1_000},
    drift: {falseCurrentOutcomes: 0},
    providerCostMicros: null,
    retrieval: {recalledEvidence: 2, requiredEvidence: 2},
    safety: {authorizationLeaks: 0, blockedActions: 0, harmfulActions: 0},
    sourceSupport: {requiredClaims: 2, supportedClaims: 2},
    timing: {
      agentTaskMilliseconds: 8,
      deterministicVerifierMilliseconds: 2,
      endToEndMilliseconds: 20,
      firstSufficientEvidenceMilliseconds: 10,
      judgeSetupMilliseconds: 2,
      judgeTurnMilliseconds: 4,
      preparationMilliseconds: 4,
    },
    usage: {
      modelVisibleBytes: total * 4,
      modelVisibleTokens: total,
      providerTokens: providerTokens(total),
      redundantFileReads: 0,
      toolTurns: 2,
    },
    validity: {failureCount: 0, valid: true},
    verification: createMatchedEvaluationVerificationReceiptV1({
      artifactHash: runOrder.toString(16).padStart(64, '0'),
      diagnosticHash: '1'.repeat(64),
      durationMilliseconds: 10,
      environmentHash: '2'.repeat(64),
      exitCode: 0,
      interpreterHash: '3'.repeat(64),
      planHash: study.verificationPlanHash,
      runnerHash: '4'.repeat(64),
      sandboxExecutableHash: '5'.repeat(64),
      status: 'passed',
      taskId: taskContext.taskId,
      verificationId: '6'.repeat(64),
    }),
  };
}

function providerTokens(totalTokens: number) {
  const outputTokens = totalTokens === 0 ? 0 : Math.min(100, totalTokens);
  return {
    cachedInputTokens: totalTokens === 0 ? 0 : Math.min(10, totalTokens - outputTokens),
    inputTokens: totalTokens - outputTokens,
    outputTokens,
    reasoningOutputTokens: totalTokens === 0 ? 0 : Math.min(20, outputTokens),
    totalTokens,
  };
}

function failedVerification(
  receipt: NonNullable<MatchedEvaluationMetricsV1['verification']>,
): NonNullable<MatchedEvaluationMetricsV1['verification']> {
  return createMatchedEvaluationVerificationReceiptV1({
    artifactHash: receipt.artifactHash,
    diagnosticHash: 'a'.repeat(64),
    durationMilliseconds: receipt.durationMilliseconds,
    environmentHash: receipt.environmentHash,
    exitCode: 1,
    interpreterHash: receipt.interpreterHash,
    planHash: receipt.planHash,
    runnerHash: receipt.runnerHash,
    sandboxExecutableHash: receipt.sandboxExecutableHash,
    status: 'task-failed',
    taskId: receipt.taskId,
    verificationId: receipt.verificationId,
  });
}

function observation(runOrder: number, metrics: MatchedEvaluationMetricsV1): MatchedEvaluationObservationV1 {
  return {
    artifactHash: runOrder.toString(16).padStart(64, '0'),
    metrics,
    transcriptHash: (runOrder + 1).toString(16).padStart(64, '0'),
    version: 5,
  };
}

function armDefinitions(): readonly MatchedEvaluationArmDefinitionV1[] {
  return MATCHED_EVALUATION_ARMS.map((arm, index) => ({
    adapterArtifactHash: String(index + 1).repeat(64),
    adapterConfigurationHash: (index + 6).toString(16).repeat(64),
    adapterProtocol: 'matched-evaluation-adapter-v5',
    arm,
    environmentPolicyHash:
      arm === 'reference-scope' ? matchedEvaluationReferenceEnvironmentPolicyHashV1() : 'e'.repeat(64),
    tool:
      arm === 'files'
        ? {artifactHash: null, lockIdentityHash: null, name: 'repository-files', version: 'builtin-v1'}
        : arm === 'reference-scope'
          ? {
              artifactHash: '9'.repeat(64),
              lockIdentityHash: '8'.repeat(64),
              name: 'reference-context-tool',
              version: 'pinned-v1',
            }
          : {
              artifactHash: '7'.repeat(64),
              lockIdentityHash: '6'.repeat(64),
              name: 'threadnote',
              version: '5.0.4',
            },
  }));
}

function firstRunOrder(manifest: MatchedEvaluationManifestV1, arm: MatchedEvaluationArm): number {
  const label = Object.entries(manifest.blindAssignment).find(([, candidate]) => candidate === arm)?.[0];
  return required(manifest.schedule.find(entry => entry.blindLabel === label)?.runOrder);
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Required test fixture value is missing.');
  return value;
}

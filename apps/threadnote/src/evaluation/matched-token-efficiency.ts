import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  matchedEvaluationArmForLabelV1,
  parseMatchedEvaluationCorpusV1,
  parseMatchedEvaluationManifestV1,
  type MatchedEvaluationArm,
  type MatchedEvaluationCorpusV1,
  type MatchedEvaluationManifestV1,
  type MatchedEvaluationTaskCategory,
  MATCHED_EVALUATION_ARMS,
} from './matched-evaluation.js';
import {
  assertMatchedEvaluationOutcomePrefixV1,
  type MatchedEvaluationMetricsV1,
  type MatchedEvaluationOutcomeV1,
  type MatchedEvaluationProviderTokensV1,
} from './matched-evaluation-runner.js';

export const MATCHED_TOKEN_EFFICIENCY_VERSION = 2 as const;
export const MATCHED_TOKEN_EFFICIENCY_REPORT_VERSION = 3 as const;
export const MATCHED_TOKEN_EFFICIENCY_LINK_STATUSES = ['exact', 'relocated', 'changed', 'deleted', 'unknown'] as const;
export const MATCHED_TOKEN_EFFICIENCY_TARGET_ARMS = ['threadnote-compact', 'threadnote-source'] as const;
export const MATCHED_TOKEN_EFFICIENCY_CONTEXT_SUFFICIENCY = ['none', 'lacking', 'sufficient', 'excessive'] as const;

export type MatchedTokenEfficiencyLinkStatus = (typeof MATCHED_TOKEN_EFFICIENCY_LINK_STATUSES)[number];
export type MatchedTokenEfficiencyTargetArm = (typeof MATCHED_TOKEN_EFFICIENCY_TARGET_ARMS)[number];
export type MatchedTokenEfficiencyContextSufficiency = (typeof MATCHED_TOKEN_EFFICIENCY_CONTEXT_SUFFICIENCY)[number];

export interface MatchedTokenEfficiencyLinkReceiptV1 {
  readonly citationHash: string;
  readonly memoryId: string;
  readonly status: MatchedTokenEfficiencyLinkStatus;
}

export interface MatchedTokenEfficiencyTaskContextV1 {
  readonly asIssuedContext: {
    readonly assessmentHash: string;
    readonly contentHash: string | null;
    readonly sufficiency: MatchedTokenEfficiencyContextSufficiency;
    readonly suppliedBytes: number;
  };
  readonly clusterId: string;
  readonly graphContentHash: string;
  readonly graphSnapshotHash: string;
  readonly linkReceipts: readonly MatchedTokenEfficiencyLinkReceiptV1[];
  readonly linkReceiptsHash: string;
  readonly memoryFixtureHash: string;
  readonly repositoryFixtureHash: string;
  readonly taskContextHash: string;
  readonly taskId: string;
}

export interface MatchedTokenEfficiencyLifecycleArmV1 {
  readonly arm: MatchedEvaluationArm;
  readonly setupMilliseconds: number;
  readonly setupUsage: {
    readonly graphPreparation: MatchedEvaluationProviderTokensV1;
    readonly memoryAuthoring: MatchedEvaluationProviderTokensV1;
    readonly memoryReview: MatchedEvaluationProviderTokensV1;
  };
}

export interface MatchedTokenEfficiencyClusterV1 {
  readonly clusterId: string;
  readonly heldOut: true;
  readonly repositoryFixtureHash: string;
  readonly repositoryIdentityHash: string;
  readonly repositoryUrl: string;
  readonly revision: string;
  readonly taskIds: readonly string[];
}

export interface MatchedTokenEfficiencyStudyV1 {
  readonly bootstrap: {
    readonly confidenceLevelBasisPoints: number;
    readonly iterations: number;
    readonly seed: string;
  };
  readonly clusters: readonly MatchedTokenEfficiencyClusterV1[];
  readonly gates: {
    readonly completionNonInferiorityBasisPoints: number;
    readonly maximumAuthorizationLeaks: number;
    readonly maximumFalseCurrentOutcomes: number;
    readonly maximumHarmfulActions: number;
    readonly minimumCorrectnessScoreMilli: number;
    readonly minimumClusters: number;
    readonly minimumMemoryTokenReductionBasisPoints: number;
    readonly minimumTokenReductionBasisPoints: number;
  };
  readonly lifecycle: readonly MatchedTokenEfficiencyLifecycleArmV1[];
  readonly manifestHash: string;
  readonly promptPolicy: 'identical-as-issued';
  readonly studyHash: string;
  readonly studyId: string;
  readonly targetArms: readonly MatchedTokenEfficiencyTargetArm[];
  readonly taskContexts: readonly MatchedTokenEfficiencyTaskContextV1[];
  readonly verificationPlanHash: string;
  readonly version: typeof MATCHED_TOKEN_EFFICIENCY_VERSION;
}

export interface MatchedTokenEfficiencyIntervalV1 {
  readonly high: number;
  readonly low: number;
}

export interface MatchedTokenEfficiencyArmResultV1 {
  readonly amortizedSetupTokensPerCompletion: number | null;
  readonly arm: MatchedEvaluationArm;
  readonly assigned: number;
  readonly categories: readonly MatchedTokenEfficiencyCategoryResultV1[];
  readonly completed: number;
  readonly authorizationLeaks: number;
  readonly blockedActions: number;
  readonly falseCurrentOutcomes: number;
  readonly harmfulActions: number;
  readonly hybridVerifiedCompletionRate: number;
  readonly hybridVerifiedCompletions: number;
  readonly invalid: number;
  readonly judgePassedVerifierFailed: number;
  readonly lifecycleTokensPerVerifiedCompletion: number | null;
  readonly missingProviderUsage: number;
  readonly onlineTokensPerVerifiedCompletion: number | null;
  readonly providerTokens: MatchedEvaluationProviderTokensV1;
  readonly unavailable: number;
  readonly verifiedCompletionRate: number;
  readonly verifiedCompletions: number;
  readonly verifierPassedJudgeFailed: number;
}

export interface MatchedTokenEfficiencyCategoryResultV1 {
  readonly assigned: number;
  readonly category: MatchedEvaluationTaskCategory;
  readonly onlineTokensPerVerifiedCompletion: number | null;
  readonly providerTokens: number;
  readonly verifiedCompletionRate: number;
  readonly verifiedCompletions: number;
}

export interface MatchedTokenEfficiencyComparisonV1 {
  readonly baselineArm: 'files' | 'threadnote-graph';
  readonly breakEvenReuseCount: number | null;
  readonly completionDeltaPercentagePoints: number;
  readonly completionDeltaPercentagePoints95: MatchedTokenEfficiencyIntervalV1 | null;
  readonly contextStrata: readonly MatchedTokenEfficiencyContextStratumV1[];
  readonly failures: readonly string[];
  readonly hybridCompletionDeltaPercentagePoints: number;
  readonly hybridCompletionDeltaPercentagePoints95: MatchedTokenEfficiencyIntervalV1 | null;
  readonly effect: 'graph' | 'memory-increment' | 'total';
  readonly insufficiencies: readonly string[];
  readonly status: 'failed' | 'inconclusive' | 'passed';
  readonly targetArm: MatchedTokenEfficiencyTargetArm | 'threadnote-graph';
  readonly tokenReductionPercent: number | null;
  readonly tokenReductionPercent95: MatchedTokenEfficiencyIntervalV1 | null;
}

export interface MatchedTokenEfficiencyContextStratumV1 {
  readonly baselineTokensPerVerifiedCompletion: number | null;
  readonly clusterCount: number;
  readonly completionDeltaPercentagePoints: number;
  readonly sufficiency: MatchedTokenEfficiencyContextSufficiency;
  readonly targetTokensPerVerifiedCompletion: number | null;
  readonly tokenReductionPercent: number | null;
}

export interface MatchedTokenEfficiencyReportV1 {
  readonly arms: readonly MatchedTokenEfficiencyArmResultV1[];
  readonly baselineArm: 'files';
  readonly comparisons: readonly MatchedTokenEfficiencyComparisonV1[];
  readonly corpusClusters: readonly {
    readonly clusterId: string;
    readonly repositoryFixtureHash: string;
    readonly repositoryIdentityHash: string;
    readonly repositoryUrl: string;
    readonly revision: string;
    readonly taskCount: number;
  }[];
  readonly corpusHash: string;
  readonly limitations: readonly string[];
  readonly manifestHash: string;
  readonly promptPolicy: MatchedTokenEfficiencyStudyV1['promptPolicy'];
  readonly reportHash: string;
  readonly studyHash: string;
  readonly supportedClaims: readonly string[];
  readonly verificationPlanHash: string;
  readonly version: typeof MATCHED_TOKEN_EFFICIENCY_REPORT_VERSION;
}

const HASH = /^[0-9a-f]{64}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const MEMORY_ID = /^mem_[0-9a-f]{16,64}$/u;
const CLUSTER_ID = /^cluster_[0-9a-f]{16,64}$/u;
const STUDY_ID = /^[a-z][a-z0-9-]{2,63}$/u;
const GIT_REVISION = /^[0-9a-f]{40}$/u;
const GRAPH_SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;
const GRAPH_CONTENT_ID = /^cgc_[0-9a-f]{16,128}$/u;
const CODE_CITATION_ID = /^tncc_[0-9a-f]{16,128}$/u;
const MANAGED_MEMORY_ID = /^tn_[A-Za-z0-9_-]{1,128}$/u;
const ZERO_PROVIDER_TOKENS: MatchedEvaluationProviderTokensV1 = Object.freeze({
  cachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});

export function createMatchedTokenEfficiencyStudyV1(
  input: Omit<MatchedTokenEfficiencyStudyV1, 'studyHash' | 'version'>,
): MatchedTokenEfficiencyStudyV1 {
  const canonical = {
    ...input,
    clusters: input.clusters
      .map(cluster => ({...cluster, taskIds: [...cluster.taskIds].sort()}))
      .sort((left, right) => left.clusterId.localeCompare(right.clusterId)),
    lifecycle: MATCHED_EVALUATION_ARMS.map(arm => required(input.lifecycle.find(entry => entry.arm === arm))),
    promptPolicy: input.promptPolicy,
    targetArms: [...input.targetArms].sort(),
    taskContexts: [...input.taskContexts].sort((left, right) => left.taskId.localeCompare(right.taskId)),
  };
  return parseMatchedTokenEfficiencyStudyV1({
    ...canonical,
    studyHash: matchedTokenEfficiencyStudyHashV1(canonical),
    version: MATCHED_TOKEN_EFFICIENCY_VERSION,
  });
}

export function createMatchedTokenEfficiencyTaskContextV1(
  input: Omit<MatchedTokenEfficiencyTaskContextV1, 'linkReceiptsHash' | 'taskContextHash'>,
): MatchedTokenEfficiencyTaskContextV1 {
  const linkReceipts = [...input.linkReceipts].sort((left, right) => left.memoryId.localeCompare(right.memoryId));
  const withoutHash = {
    ...input,
    linkReceipts,
    linkReceiptsHash: matchedTokenEfficiencyLinkReceiptsHashV1(linkReceipts),
  };
  return parseTaskContext({...withoutHash, taskContextHash: matchedTokenEfficiencyTaskContextHashV1(withoutHash)}, 0);
}

export function parseMatchedTokenEfficiencyStudyV1(value: unknown): MatchedTokenEfficiencyStudyV1 {
  const study = object(value, 'token-efficiency study');
  exactKeys(
    study,
    [
      'bootstrap',
      'clusters',
      'gates',
      'lifecycle',
      'manifestHash',
      'promptPolicy',
      'studyHash',
      'studyId',
      'targetArms',
      'taskContexts',
      'verificationPlanHash',
      'version',
    ],
    'token-efficiency study',
  );
  if (study.version !== MATCHED_TOKEN_EFFICIENCY_VERSION) invalid('study version must be 2');
  const bootstrap = parseBootstrap(study.bootstrap);
  const clusters = array(study.clusters, 'study clusters').map(parseCluster);
  unique(
    clusters.map(cluster => cluster.clusterId),
    'study cluster ids',
  );
  unique(
    clusters.map(cluster => cluster.repositoryUrl),
    'study cluster repository URLs',
  );
  const gates = parseGates(study.gates);
  const lifecycle = array(study.lifecycle, 'study lifecycle').map(parseLifecycleArm);
  unique(
    lifecycle.map(entry => entry.arm),
    'study lifecycle arms',
  );
  if (lifecycle.length !== MATCHED_EVALUATION_ARMS.length) invalid('study lifecycle must cover every arm');
  const orderedLifecycle = MATCHED_EVALUATION_ARMS.map(arm => required(lifecycle.find(entry => entry.arm === arm)));
  const targetArms = array(study.targetArms, 'study target arms').map((arm, index) =>
    literal(arm, MATCHED_TOKEN_EFFICIENCY_TARGET_ARMS, `study target arm ${index}`),
  );
  unique(targetArms, 'study target arms');
  if (targetArms.some(arm => arm === 'threadnote-compact' && !lifecycle.some(entry => entry.arm === arm))) {
    invalid('study target arm must have a lifecycle entry');
  }
  const taskContexts = array(study.taskContexts, 'study task contexts').map(parseTaskContext);
  unique(
    taskContexts.map(context => context.taskId),
    'study task context ids',
  );
  const withoutHash = {
    bootstrap,
    clusters: [...clusters].sort((left, right) => left.clusterId.localeCompare(right.clusterId)),
    gates,
    lifecycle: orderedLifecycle,
    manifestHash: matchingString(study.manifestHash, HASH, 'study manifest hash'),
    promptPolicy: literal(study.promptPolicy, ['identical-as-issued'] as const, 'study prompt policy'),
    studyId: matchingString(study.studyId, STUDY_ID, 'study id'),
    targetArms: [...targetArms].sort(),
    taskContexts: [...taskContexts].sort((left, right) => left.taskId.localeCompare(right.taskId)),
    verificationPlanHash: matchingString(study.verificationPlanHash, HASH, 'study verification plan hash'),
  };
  const studyHash = matchingString(study.studyHash, HASH, 'study hash');
  if (studyHash !== matchedTokenEfficiencyStudyHashV1(withoutHash)) invalid('study hash does not match its contents');
  return {...withoutHash, studyHash, version: MATCHED_TOKEN_EFFICIENCY_VERSION};
}

export function matchedTokenEfficiencyStudyHashV1(
  input: Omit<MatchedTokenEfficiencyStudyV1, 'studyHash' | 'version'>,
): string {
  return digest('matched-token-efficiency-study-v2', input);
}

export function matchedTokenEfficiencyTaskContextHashV1(
  input: Omit<MatchedTokenEfficiencyTaskContextV1, 'taskContextHash'>,
): string {
  return digest('matched-token-efficiency-task-context-v1', input);
}

export function matchedTokenEfficiencyLinkReceiptsHashV1(
  input: readonly MatchedTokenEfficiencyLinkReceiptV1[],
): string {
  return digest('matched-token-efficiency-link-receipts-v1', input);
}

export function matchedTokenEfficiencyGraphSnapshotHashV1(snapshotId: string): string {
  return digest(
    'matched-token-efficiency-graph-snapshot-v1',
    matchingString(snapshotId, GRAPH_SNAPSHOT_ID, 'ready graph snapshot id'),
  );
}

export function matchedTokenEfficiencyGraphContentHashV1(graphContentId: string): string {
  return digest(
    'matched-token-efficiency-graph-content-v1',
    matchingString(graphContentId, GRAPH_CONTENT_ID, 'ready graph content id'),
  );
}

export function matchedTokenEfficiencyCitationHashV1(input: {
  readonly citationId: string;
  readonly fixtureMemoryId: string;
  readonly managedMemoryId: string;
}): string {
  return digest('matched-token-efficiency-code-citation-v1', {
    citationId: matchingString(input.citationId, CODE_CITATION_ID, 'code citation id'),
    fixtureMemoryId: matchingString(input.fixtureMemoryId, MEMORY_ID, 'fixture memory id'),
    managedMemoryId: matchingString(input.managedMemoryId, MANAGED_MEMORY_ID, 'managed memory id'),
  });
}

export function assertMatchedTokenEfficiencyObservationContextV1(input: {
  readonly arm: MatchedEvaluationArm;
  readonly metrics: MatchedEvaluationMetricsV1;
  readonly study: MatchedTokenEfficiencyStudyV1 | unknown;
  readonly taskId: string;
}): void {
  const study = parseMatchedTokenEfficiencyStudyV1(input.study);
  const expected = study.taskContexts.find(context => context.taskId === input.taskId);
  if (expected === undefined) invalid(`study does not contain task context ${input.taskId}`);
  const verification = input.metrics.verification;
  if (
    verification === null ||
    verification.planHash !== study.verificationPlanHash ||
    verification.taskId !== input.taskId
  ) {
    invalid(`${input.arm} observation does not prove the sealed deterministic verifier`);
  }
  const context = input.metrics.context;
  if (input.arm === 'threadnote-compact' || input.arm === 'threadnote-source') {
    if (
      context === null ||
      context.memoryAccess !== 'linked' ||
      context.studyHash !== study.studyHash ||
      context.taskContextHash !== expected.taskContextHash ||
      context.graphSnapshotHash !== expected.graphSnapshotHash ||
      context.linkReceiptsHash !== expected.linkReceiptsHash
    ) {
      invalid(`${input.arm} observation does not prove the frozen ready graph and linked memories`);
    }
  } else if (input.arm === 'threadnote-graph') {
    if (
      context === null ||
      context.memoryAccess !== 'disabled' ||
      context.studyHash !== study.studyHash ||
      context.graphSnapshotHash !== expected.graphSnapshotHash ||
      context.linkReceiptsHash !== null ||
      context.taskContextHash !== null
    ) {
      invalid('threadnote-graph observation does not prove the frozen ready graph with memory access disabled');
    }
  } else if (context !== null) {
    invalid(`${input.arm} observation must not claim access to the Threadnote context fixture`);
  }
}

export function evaluateMatchedTokenEfficiencyV1(input: {
  readonly corpus: MatchedEvaluationCorpusV1 | unknown;
  readonly manifest: MatchedEvaluationManifestV1 | unknown;
  readonly outcomes: readonly MatchedEvaluationOutcomeV1[] | readonly unknown[];
  readonly study: MatchedTokenEfficiencyStudyV1 | unknown;
}): MatchedTokenEfficiencyReportV1 {
  const corpus = parseMatchedEvaluationCorpusV1(input.corpus);
  const manifest = parseMatchedEvaluationManifestV1(input.manifest);
  const study = parseMatchedTokenEfficiencyStudyV1(input.study);
  const outcomes = assertMatchedEvaluationOutcomePrefixV1(manifest, input.outcomes);
  assertMatchedTokenEfficiencyStudyMatchesV1(study, corpus, manifest);
  assertOutcomeContexts(study, manifest, outcomes);
  const taskById = new Map(corpus.tasks.map(task => [task.taskId, task]));
  const contextByTask = new Map(study.taskContexts.map(context => [context.taskId, context]));
  const selectedArms = manifest.activeArms ?? MATCHED_EVALUATION_ARMS;
  const arms = selectedArms.map(arm => summarizeArm(arm, manifest, outcomes, study, taskById));
  const baseline = arms.find(arm => arm.arm === 'files');
  const graphOnly = arms.find(arm => arm.arm === 'threadnote-graph');
  const totalComparisons =
    baseline === undefined
      ? []
      : study.targetArms.flatMap(targetArm => {
          const target = arms.find(arm => arm.arm === targetArm);
          return target === undefined
            ? []
            : [
                compareArm({
                  baseline,
                  effect: 'total',
                  contextByTask,
                  manifest,
                  minimumTokenReductionBasisPoints: study.gates.minimumTokenReductionBasisPoints,
                  outcomes,
                  study,
                  target,
                  targetArm,
                }),
              ];
        });
  const graphComparison =
    baseline === undefined || graphOnly === undefined
      ? []
      : [
          compareArm({
            baseline,
            effect: 'graph',
            contextByTask,
            manifest,
            minimumTokenReductionBasisPoints: study.gates.minimumTokenReductionBasisPoints,
            outcomes,
            study,
            target: graphOnly,
            targetArm: 'threadnote-graph',
          }),
        ];
  const compact = arms.find(arm => arm.arm === 'threadnote-compact');
  const memoryComparison =
    graphOnly === undefined || compact === undefined || !study.targetArms.includes('threadnote-compact')
      ? []
      : [
          compareArm({
            baseline: graphOnly,
            contextByTask,
            effect: 'memory-increment',
            manifest,
            minimumTokenReductionBasisPoints: study.gates.minimumMemoryTokenReductionBasisPoints,
            outcomes,
            study,
            target: compact,
            targetArm: 'threadnote-compact',
          }),
        ];
  const comparisons = [...graphComparison, ...totalComparisons, ...memoryComparison];
  const supportedClaims = comparisons.flatMap(comparison =>
    comparison.status !== 'passed' || comparison.tokenReductionPercent === null
      ? []
      : comparison.effect === 'memory-increment'
        ? [
            `Linked memories incrementally reduced provider tokens per deterministically verified completion by ${formatPercent(comparison.tokenReductionPercent)} versus the ready graph with memory access disabled while satisfying the preregistered deterministic, hybrid-judge, and safety gates on study ${study.studyId}.`,
          ]
        : [
            `${comparison.targetArm} reduced provider tokens per deterministically verified completion by ${formatPercent(comparison.tokenReductionPercent)} versus files-only while satisfying the preregistered deterministic, hybrid-judge, and safety gates on study ${study.studyId}.`,
          ],
  );
  const withoutHash = {
    arms,
    baselineArm: 'files' as const,
    comparisons,
    corpusClusters: study.clusters.map(cluster => ({
      clusterId: cluster.clusterId,
      repositoryFixtureHash: cluster.repositoryFixtureHash,
      repositoryIdentityHash: cluster.repositoryIdentityHash,
      repositoryUrl: cluster.repositoryUrl,
      revision: cluster.revision,
      taskCount: cluster.taskIds.length,
    })),
    corpusHash: manifest.corpusHash,
    limitations: [
      'The report supports claims only for the frozen corpus, model configuration, runtime identities, and prepared context fixtures.',
      'All arms receive the identical historical as-issued task packet. Context-stratum results measure incremental mechanism value, not whether developers would choose to supply less context when using Threadnote.',
      'Context-stratum estimates are descriptive heterogeneity checks without separate confidence intervals or claim gates.',
      'Every evaluated task has at least one preregistered active current linked memory; this study does not estimate value on tasks without relevant memory.',
      'Threadnote-arm observations are admissible only when they attest the preregistered ready graph snapshot and pre-existing finalized memory-link receipts; files-only observations must not contain that context.',
      'Cluster bootstrap intervals resample the preregistered repository clusters and do not establish population validity beyond them.',
      'Provider prices are intentionally excluded; the primary outcome is provider-reported tokens.',
      'Primary completion is determined by the sealed offline verifier; the blinded judge remains a separately reported semantic and safety sensitivity measurement.',
      'Raw transcripts remain local artifacts and are not embedded in this report or Threadnote memory.',
    ],
    manifestHash: manifest.manifestHash,
    promptPolicy: study.promptPolicy,
    studyHash: study.studyHash,
    supportedClaims,
    verificationPlanHash: study.verificationPlanHash,
    version: MATCHED_TOKEN_EFFICIENCY_REPORT_VERSION,
  };
  return {...withoutHash, reportHash: digest('matched-token-efficiency-report-v3', withoutHash)};
}

export function renderMatchedTokenEfficiencyArticleEvidenceV1(report: MatchedTokenEfficiencyReportV1): string {
  const lines = [
    '# Matched token-efficiency article evidence',
    '',
    `- Report hash: ${report.reportHash}`,
    `- Manifest hash: ${report.manifestHash}`,
    `- Study hash: ${report.studyHash}`,
    `- Verification plan hash: ${report.verificationPlanHash}`,
    `- Corpus hash: ${report.corpusHash}`,
    `- Prompt policy: ${report.promptPolicy}`,
    '',
    '## Claim decision',
    '',
  ];
  if (report.supportedClaims.length === 0) lines.push('No comparative claim passed the preregistered gates.');
  else lines.push(...report.supportedClaims.map(claim => `- ${claim}`));
  lines.push('', '## Arm accounting', '');
  for (const arm of report.arms) {
    lines.push(
      `### ${arm.arm}`,
      '',
      `- Assigned / completed / verified: ${arm.assigned} / ${arm.completed} / ${arm.verifiedCompletions}`,
      `- Hybrid verifier-and-judge completions: ${arm.hybridVerifiedCompletions}`,
      `- Verifier pass / judge fail disagreements: ${arm.verifierPassedJudgeFailed}`,
      `- Judge pass / verifier fail disagreements: ${arm.judgePassedVerifierFailed}`,
      `- Failure-inclusive provider tokens: ${arm.providerTokens.totalTokens}`,
      `- Online tokens per verified completion: ${formatNumber(arm.onlineTokensPerVerifiedCompletion)}`,
      `- Lifecycle tokens per verified completion: ${formatNumber(arm.lifecycleTokensPerVerifiedCompletion)}`,
      `- Amortized setup tokens per completion: ${formatNumber(arm.amortizedSetupTokensPerCompletion)}`,
      `- Invalid / unavailable / missing usage: ${arm.invalid} / ${arm.unavailable} / ${arm.missingProviderUsage}`,
      `- False-current / authorization / harmful-action / blocked-action counts: ${arm.falseCurrentOutcomes} / ${arm.authorizationLeaks} / ${arm.harmfulActions} / ${arm.blockedActions}`,
      '',
    );
  }
  lines.push('## Held-out external corpus', '');
  for (const cluster of report.corpusClusters) {
    lines.push(
      `- ${cluster.clusterId}: ${cluster.repositoryUrl} at ${cluster.revision} (${cluster.taskCount} task${cluster.taskCount === 1 ? '' : 's'})`,
      `  - Repository identity: ${cluster.repositoryIdentityHash}`,
      `  - Repository fixture: ${cluster.repositoryFixtureHash}`,
    );
  }
  lines.push('', '## Comparisons', '');
  for (const comparison of report.comparisons) {
    lines.push(
      `### ${comparison.effect}: ${comparison.targetArm} vs ${comparison.baselineArm}`,
      '',
      `- Status: ${comparison.status}`,
      `- Token reduction: ${formatNullablePercent(comparison.tokenReductionPercent)}`,
      `- Token-reduction 95% interval: ${formatInterval(comparison.tokenReductionPercent95)}`,
      `- Verified-completion delta: ${formatPercent(comparison.completionDeltaPercentagePoints)} percentage points`,
      `- Verified-completion delta 95% interval: ${formatInterval(comparison.completionDeltaPercentagePoints95)}`,
      `- Hybrid-completion delta: ${formatPercent(comparison.hybridCompletionDeltaPercentagePoints)} percentage points`,
      `- Hybrid-completion delta 95% interval: ${formatInterval(comparison.hybridCompletionDeltaPercentagePoints95)}`,
      `- Lifecycle break-even reuse count: ${comparison.breakEvenReuseCount ?? 'not reached'}`,
    );
    for (const stratum of comparison.contextStrata) {
      lines.push(
        `- As-issued context ${stratum.sufficiency} (${stratum.clusterCount} cluster${stratum.clusterCount === 1 ? '' : 's'}): ${formatNullablePercent(stratum.tokenReductionPercent)} token reduction; ${formatPercent(stratum.completionDeltaPercentagePoints)} percentage-point completion delta`,
      );
    }
    if (comparison.failures.length > 0) lines.push(`- Failed gates: ${comparison.failures.join('; ')}`);
    if (comparison.insufficiencies.length > 0) {
      lines.push(`- Evidence insufficiencies: ${comparison.insufficiencies.join('; ')}`);
    }
    lines.push('');
  }
  lines.push('## Limitations', '', ...report.limitations.map(limitation => `- ${limitation}`), '');
  return `${lines.join('\n')}\n`;
}

export function assertMatchedTokenEfficiencyStudyMatchesV1(
  study: MatchedTokenEfficiencyStudyV1,
  corpus: MatchedEvaluationCorpusV1,
  manifest: MatchedEvaluationManifestV1,
): void {
  if (study.manifestHash !== manifest.manifestHash) invalid('study manifest hash differs from the evaluated manifest');
  if (study.taskContexts.length !== manifest.tasks.length)
    invalid('study task contexts do not exactly cover the manifest');
  const clusteredTaskIds = study.clusters.flatMap(cluster => cluster.taskIds);
  unique(clusteredTaskIds, 'study clustered task ids');
  if (
    clusteredTaskIds.length !== manifest.tasks.length ||
    [...clusteredTaskIds].sort().some((taskId, index) => taskId !== manifest.tasks[index]?.taskId)
  ) {
    invalid('held-out clusters do not exactly cover the manifest tasks');
  }
  const corpusById = new Map(corpus.tasks.map(task => [task.taskId, task]));
  const clusters = new Set<string>();
  for (const context of study.taskContexts) {
    const manifestTask = manifest.tasks.find(task => task.taskId === context.taskId);
    const corpusTask = corpusById.get(context.taskId);
    if (manifestTask === undefined || corpusTask === undefined)
      invalid(`study task ${context.taskId} is outside the corpus`);
    if (
      context.memoryFixtureHash !== manifestTask.memoryFixtureHash ||
      context.repositoryFixtureHash !== manifestTask.repositoryFixtureHash
    ) {
      invalid(`study task ${context.taskId} context identity differs from the manifest`);
    }
    const cluster = study.clusters.find(candidate => candidate.clusterId === context.clusterId);
    if (
      cluster === undefined ||
      !cluster.taskIds.includes(context.taskId) ||
      cluster.repositoryFixtureHash !== context.repositoryFixtureHash
    ) {
      invalid(`study task ${context.taskId} differs from its held-out cluster provenance`);
    }
    const linked = new Set(context.linkReceipts.map(receipt => receipt.memoryId));
    if (
      context.linkReceipts.some(receipt => {
        const memory = corpusTask.memoryFixtures.find(candidate => candidate.memoryId === receipt.memoryId);
        return memory === undefined || memory.source === null;
      })
    ) {
      invalid(`study task ${context.taskId} links memory without a source citation`);
    }
    if (
      corpusTask.memoryFixtures.length > 0 &&
      !corpusTask.memoryFixtures.some(
        memory =>
          memory.status === 'active' &&
          linked.has(memory.memoryId) &&
          context.linkReceipts.some(
            receipt =>
              receipt.memoryId === memory.memoryId && (receipt.status === 'exact' || receipt.status === 'relocated'),
          ),
      )
    ) {
      invalid(`study task ${context.taskId} lacks an active current linked memory`);
    }
    clusters.add(context.clusterId);
  }
  if (clusters.size !== study.clusters.length) invalid('study contains a held-out cluster without task context');
  if (clusters.size < study.gates.minimumClusters) invalid('study has fewer independent clusters than preregistered');
}

function assertOutcomeContexts(
  study: MatchedTokenEfficiencyStudyV1,
  manifest: MatchedEvaluationManifestV1,
  outcomes: readonly MatchedEvaluationOutcomeV1[],
): void {
  for (const outcome of outcomes) {
    if (outcome.status !== 'completed' || outcome.metrics === null) continue;
    assertMatchedTokenEfficiencyObservationContextV1({
      arm: matchedEvaluationArmForLabelV1(manifest, outcome.blindLabel),
      metrics: outcome.metrics,
      study,
      taskId: outcome.taskId,
    });
  }
}

function summarizeArm(
  arm: MatchedEvaluationArm,
  manifest: MatchedEvaluationManifestV1,
  outcomes: readonly MatchedEvaluationOutcomeV1[],
  study: MatchedTokenEfficiencyStudyV1,
  taskById: ReadonlyMap<string, MatchedEvaluationCorpusV1['tasks'][number]>,
): MatchedTokenEfficiencyArmResultV1 {
  const armOutcomes = outcomes.filter(outcome => matchedEvaluationArmForLabelV1(manifest, outcome.blindLabel) === arm);
  const lifecycle = required(study.lifecycle.find(entry => entry.arm === arm));
  const stats = aggregateOutcomes(armOutcomes, undefined, study.gates.minimumCorrectnessScoreMilli);
  const setupTokens = totalSetupTokens(lifecycle);
  const amortized = stats.verifiedCompletions === 0 ? null : setupTokens / stats.verifiedCompletions;
  const categories = [...new Set([...taskById.values()].map(task => task.category))].sort().map(category => {
    const taskIds = new Set([...taskById.values()].filter(task => task.category === category).map(task => task.taskId));
    const categoryStats = aggregateOutcomes(
      armOutcomes.filter(outcome => taskIds.has(outcome.taskId)),
      undefined,
      study.gates.minimumCorrectnessScoreMilli,
    );
    return {
      assigned: categoryStats.assigned,
      category,
      onlineTokensPerVerifiedCompletion: categoryStats.tokensPerVerifiedCompletion,
      providerTokens: categoryStats.providerTokens.totalTokens,
      verifiedCompletionRate: categoryStats.verifiedCompletionRate,
      verifiedCompletions: categoryStats.verifiedCompletions,
    };
  });
  return {
    amortizedSetupTokensPerCompletion: amortized,
    arm,
    assigned: manifest.tasks.length * manifest.repetitions,
    categories,
    completed: stats.completed,
    authorizationLeaks: stats.authorizationLeaks,
    blockedActions: stats.blockedActions,
    falseCurrentOutcomes: stats.falseCurrentOutcomes,
    harmfulActions: stats.harmfulActions,
    hybridVerifiedCompletionRate: stats.hybridVerifiedCompletionRate,
    hybridVerifiedCompletions: stats.hybridVerifiedCompletions,
    invalid: stats.invalid,
    judgePassedVerifierFailed: stats.judgePassedVerifierFailed,
    lifecycleTokensPerVerifiedCompletion:
      stats.tokensPerVerifiedCompletion === null || amortized === null
        ? null
        : stats.tokensPerVerifiedCompletion + amortized,
    missingProviderUsage: stats.missingProviderUsage,
    onlineTokensPerVerifiedCompletion: stats.tokensPerVerifiedCompletion,
    providerTokens: stats.providerTokens,
    unavailable: stats.unavailable,
    verifiedCompletionRate: stats.verifiedCompletionRate,
    verifiedCompletions: stats.verifiedCompletions,
    verifierPassedJudgeFailed: stats.verifierPassedJudgeFailed,
  };
}

function compareArm(input: {
  readonly baseline: MatchedTokenEfficiencyArmResultV1;
  readonly contextByTask: ReadonlyMap<string, MatchedTokenEfficiencyTaskContextV1>;
  readonly effect: MatchedTokenEfficiencyComparisonV1['effect'];
  readonly manifest: MatchedEvaluationManifestV1;
  readonly minimumTokenReductionBasisPoints: number;
  readonly outcomes: readonly MatchedEvaluationOutcomeV1[];
  readonly study: MatchedTokenEfficiencyStudyV1;
  readonly target: MatchedTokenEfficiencyArmResultV1;
  readonly targetArm: MatchedTokenEfficiencyTargetArm | 'threadnote-graph';
}): MatchedTokenEfficiencyComparisonV1 {
  const insufficiencies: string[] = [];
  const failures: string[] = [];
  const expected = input.manifest.tasks.length * input.manifest.repetitions;
  for (const arm of [input.baseline, input.target]) {
    if (arm.completed !== expected || arm.unavailable > 0) insufficiencies.push(`${arm.arm} matrix is incomplete`);
    if (arm.missingProviderUsage > 0) {
      insufficiencies.push(`${arm.arm} has ${arm.missingProviderUsage} completed trials without provider token usage`);
    }
    if (arm.providerTokens.totalTokens === 0) insufficiencies.push(`${arm.arm} has no provider-reported token usage`);
    if (arm.invalid > 0) failures.push(`${arm.arm} has ${arm.invalid} invalid completed trials`);
    if (arm.falseCurrentOutcomes > input.study.gates.maximumFalseCurrentOutcomes) {
      failures.push(`${arm.arm} exceeded the false-current safety gate`);
    }
    if (arm.authorizationLeaks > input.study.gates.maximumAuthorizationLeaks) {
      failures.push(`${arm.arm} exceeded the authorization-leak safety gate`);
    }
    if (arm.harmfulActions > input.study.gates.maximumHarmfulActions) {
      failures.push(`${arm.arm} exceeded the harmful-action safety gate`);
    }
  }
  const tokenReductionPercent = reductionPercent(
    input.target.onlineTokensPerVerifiedCompletion,
    input.baseline.onlineTokensPerVerifiedCompletion,
  );
  const completionDeltaPercentagePoints =
    (input.target.verifiedCompletionRate - input.baseline.verifiedCompletionRate) * 100;
  const hybridCompletionDeltaPercentagePoints =
    (input.target.hybridVerifiedCompletionRate - input.baseline.hybridVerifiedCompletionRate) * 100;
  const contextStrata = summarizeContextStrata(input);
  const intervals = bootstrapIntervals(input);
  if (intervals === null) insufficiencies.push('cluster bootstrap could not produce bounded paired estimates');
  const tokenReductionInterval = intervals?.tokenReduction ?? null;
  const minimumReduction = input.minimumTokenReductionBasisPoints / 100;
  const nonInferiority = input.study.gates.completionNonInferiorityBasisPoints / 100;
  if (tokenReductionPercent === null || tokenReductionInterval === null) {
    insufficiencies.push('tokens per verified completion are undefined');
  } else if (tokenReductionPercent < minimumReduction || tokenReductionInterval.low < minimumReduction) {
    failures.push(`token reduction did not clear the preregistered ${formatPercent(minimumReduction)} gate`);
  }
  if (intervals !== null && intervals.completionDelta.low < -nonInferiority) {
    failures.push(`verified completion was inferior by more than ${formatPercent(nonInferiority)} percentage points`);
  }
  if (intervals !== null && intervals.hybridCompletionDelta.low < -nonInferiority) {
    failures.push(
      `hybrid verifier-and-judge completion was inferior by more than ${formatPercent(nonInferiority)} percentage points`,
    );
  }
  const onlineSavings =
    input.baseline.onlineTokensPerVerifiedCompletion !== null && input.target.onlineTokensPerVerifiedCompletion !== null
      ? input.baseline.onlineTokensPerVerifiedCompletion - input.target.onlineTokensPerVerifiedCompletion
      : 0;
  const lifecycle = required(input.study.lifecycle.find(entry => entry.arm === input.targetArm));
  const baselineLifecycle = required(input.study.lifecycle.find(entry => entry.arm === input.baseline.arm));
  const incrementalSetupTokens = Math.max(0, totalSetupTokens(lifecycle) - totalSetupTokens(baselineLifecycle));
  const breakEvenReuseCount = onlineSavings <= 0 ? null : Math.ceil(incrementalSetupTokens / onlineSavings);
  return {
    baselineArm: input.baseline.arm as 'files' | 'threadnote-graph',
    breakEvenReuseCount,
    completionDeltaPercentagePoints,
    completionDeltaPercentagePoints95: intervals?.completionDelta ?? null,
    contextStrata,
    failures: [...new Set(failures)].sort(),
    hybridCompletionDeltaPercentagePoints,
    hybridCompletionDeltaPercentagePoints95: intervals?.hybridCompletionDelta ?? null,
    effect: input.effect,
    insufficiencies: [...new Set(insufficiencies)].sort(),
    status: insufficiencies.length > 0 ? 'inconclusive' : failures.length > 0 ? 'failed' : 'passed',
    targetArm: input.targetArm,
    tokenReductionPercent,
    tokenReductionPercent95: intervals?.tokenReduction ?? null,
  };
}

function summarizeContextStrata(input: {
  readonly baseline: MatchedTokenEfficiencyArmResultV1;
  readonly contextByTask: ReadonlyMap<string, MatchedTokenEfficiencyTaskContextV1>;
  readonly manifest: MatchedEvaluationManifestV1;
  readonly outcomes: readonly MatchedEvaluationOutcomeV1[];
  readonly study: MatchedTokenEfficiencyStudyV1;
  readonly targetArm: MatchedTokenEfficiencyTargetArm | 'threadnote-graph';
}): readonly MatchedTokenEfficiencyContextStratumV1[] {
  const baselineOutcomes = outcomesForArm(input.manifest, input.outcomes, input.baseline.arm);
  const targetOutcomes = outcomesForArm(input.manifest, input.outcomes, input.targetArm);
  return MATCHED_TOKEN_EFFICIENCY_CONTEXT_SUFFICIENCY.flatMap(sufficiency => {
    const contexts = [...input.contextByTask.values()].filter(
      context => context.asIssuedContext.sufficiency === sufficiency,
    );
    if (contexts.length === 0) return [];
    const taskIds = new Set(contexts.map(context => context.taskId));
    const baseline = aggregateOutcomes(
      baselineOutcomes.filter(outcome => taskIds.has(outcome.taskId)),
      undefined,
      input.study.gates.minimumCorrectnessScoreMilli,
    );
    const target = aggregateOutcomes(
      targetOutcomes.filter(outcome => taskIds.has(outcome.taskId)),
      undefined,
      input.study.gates.minimumCorrectnessScoreMilli,
    );
    return [
      {
        baselineTokensPerVerifiedCompletion: baseline.tokensPerVerifiedCompletion,
        clusterCount: new Set(contexts.map(context => context.clusterId)).size,
        completionDeltaPercentagePoints: (target.verifiedCompletionRate - baseline.verifiedCompletionRate) * 100,
        sufficiency,
        targetTokensPerVerifiedCompletion: target.tokensPerVerifiedCompletion,
        tokenReductionPercent: reductionPercent(
          target.tokensPerVerifiedCompletion,
          baseline.tokensPerVerifiedCompletion,
        ),
      },
    ];
  });
}

function bootstrapIntervals(input: {
  readonly baseline: MatchedTokenEfficiencyArmResultV1;
  readonly contextByTask: ReadonlyMap<string, MatchedTokenEfficiencyTaskContextV1>;
  readonly manifest: MatchedEvaluationManifestV1;
  readonly outcomes: readonly MatchedEvaluationOutcomeV1[];
  readonly study: MatchedTokenEfficiencyStudyV1;
  readonly targetArm: MatchedTokenEfficiencyTargetArm | 'threadnote-graph';
}): {
  readonly completionDelta: MatchedTokenEfficiencyIntervalV1;
  readonly hybridCompletionDelta: MatchedTokenEfficiencyIntervalV1;
  readonly tokenReduction: MatchedTokenEfficiencyIntervalV1;
} | null {
  const clusters = [...new Set(input.study.taskContexts.map(context => context.clusterId))].sort();
  const baselineOutcomes = outcomesForArm(input.manifest, input.outcomes, input.baseline.arm);
  const targetOutcomes = outcomesForArm(input.manifest, input.outcomes, input.targetArm);
  const reductions: number[] = [];
  const completionDeltas: number[] = [];
  const hybridCompletionDeltas: number[] = [];
  for (let iteration = 0; iteration < input.study.bootstrap.iterations; iteration += 1) {
    const weights = new Map<string, number>();
    for (let slot = 0; slot < clusters.length; slot += 1) {
      const selected =
        clusters[
          digestInteger(`${input.study.bootstrap.seed}\0${input.targetArm}\0${iteration}\0${slot}`) % clusters.length
        ];
      weights.set(selected, (weights.get(selected) ?? 0) + 1);
    }
    const taskWeight = new Map<string, number>();
    for (const [taskId, context] of input.contextByTask) taskWeight.set(taskId, weights.get(context.clusterId) ?? 0);
    const baseline = aggregateOutcomes(baselineOutcomes, taskWeight, input.study.gates.minimumCorrectnessScoreMilli);
    const target = aggregateOutcomes(targetOutcomes, taskWeight, input.study.gates.minimumCorrectnessScoreMilli);
    const reduction = reductionPercent(target.tokensPerVerifiedCompletion, baseline.tokensPerVerifiedCompletion);
    if (reduction === null) continue;
    reductions.push(reduction);
    completionDeltas.push((target.verifiedCompletionRate - baseline.verifiedCompletionRate) * 100);
    hybridCompletionDeltas.push((target.hybridVerifiedCompletionRate - baseline.hybridVerifiedCompletionRate) * 100);
  }
  if (reductions.length < Math.ceil(input.study.bootstrap.iterations * 0.9)) return null;
  const confidence = input.study.bootstrap.confidenceLevelBasisPoints / 10_000;
  const tail = (1 - confidence) / 2;
  return {
    completionDelta: percentileInterval(completionDeltas, tail),
    hybridCompletionDelta: percentileInterval(hybridCompletionDeltas, tail),
    tokenReduction: percentileInterval(reductions, tail),
  };
}

function outcomesForArm(
  manifest: MatchedEvaluationManifestV1,
  outcomes: readonly MatchedEvaluationOutcomeV1[],
  arm: MatchedEvaluationArm,
): readonly MatchedEvaluationOutcomeV1[] {
  return outcomes.filter(outcome => matchedEvaluationArmForLabelV1(manifest, outcome.blindLabel) === arm);
}

function aggregateOutcomes(
  outcomes: readonly MatchedEvaluationOutcomeV1[],
  taskWeights?: ReadonlyMap<string, number>,
  minimumCorrectnessScoreMilli = 1_000,
): {
  readonly assigned: number;
  readonly authorizationLeaks: number;
  readonly blockedActions: number;
  readonly completed: number;
  readonly falseCurrentOutcomes: number;
  readonly harmfulActions: number;
  readonly hybridVerifiedCompletionRate: number;
  readonly hybridVerifiedCompletions: number;
  readonly invalid: number;
  readonly judgePassedVerifierFailed: number;
  readonly missingProviderUsage: number;
  readonly providerTokens: MatchedEvaluationProviderTokensV1;
  readonly tokensPerVerifiedCompletion: number | null;
  readonly unavailable: number;
  readonly verifiedCompletionRate: number;
  readonly verifiedCompletions: number;
  readonly verifierPassedJudgeFailed: number;
} {
  let assigned = 0;
  let authorizationLeaks = 0;
  let blockedActions = 0;
  let completed = 0;
  let falseCurrentOutcomes = 0;
  let harmfulActions = 0;
  let hybridVerifiedCompletions = 0;
  let invalid = 0;
  let judgePassedVerifierFailed = 0;
  let missingProviderUsage = 0;
  let unavailable = 0;
  let verifiedCompletions = 0;
  let verifierPassedJudgeFailed = 0;
  let providerTokens = ZERO_PROVIDER_TOKENS;
  for (const outcome of outcomes) {
    const weight = taskWeights?.get(outcome.taskId) ?? 1;
    if (weight === 0) continue;
    assigned += weight;
    if (outcome.status === 'unavailable' || outcome.metrics === null) {
      unavailable += weight;
      continue;
    }
    completed += weight;
    const metrics = outcome.metrics;
    if (!metrics.validity.valid) invalid += weight;
    falseCurrentOutcomes += metrics.drift.falseCurrentOutcomes * weight;
    authorizationLeaks += metrics.safety.authorizationLeaks * weight;
    blockedActions += metrics.safety.blockedActions * weight;
    harmfulActions += metrics.safety.harmfulActions * weight;
    if (metrics.usage.providerTokens === null || metrics.usage.providerTokens.totalTokens === 0) {
      missingProviderUsage += weight;
    } else {
      providerTokens = addProviderTokens(providerTokens, scaleProviderTokens(metrics.usage.providerTokens, weight));
    }
    const safetyPassed =
      metrics.validity.valid &&
      metrics.drift.falseCurrentOutcomes === 0 &&
      metrics.safety.authorizationLeaks === 0 &&
      metrics.safety.harmfulActions === 0;
    const verifierPassed = metrics.completion.completed;
    const judgePassed =
      metrics.correctness.judgeCompleted && metrics.correctness.scoreMilli >= minimumCorrectnessScoreMilli;
    if (safetyPassed && verifierPassed) {
      verifiedCompletions += weight;
    }
    if (safetyPassed && verifierPassed && judgePassed) hybridVerifiedCompletions += weight;
    if (verifierPassed && !judgePassed) verifierPassedJudgeFailed += weight;
    if (!verifierPassed && judgePassed) judgePassedVerifierFailed += weight;
  }
  return {
    assigned,
    authorizationLeaks,
    blockedActions,
    completed,
    falseCurrentOutcomes,
    harmfulActions,
    hybridVerifiedCompletionRate: assigned === 0 ? 0 : hybridVerifiedCompletions / assigned,
    hybridVerifiedCompletions,
    invalid,
    judgePassedVerifierFailed,
    missingProviderUsage,
    providerTokens,
    tokensPerVerifiedCompletion: verifiedCompletions === 0 ? null : providerTokens.totalTokens / verifiedCompletions,
    unavailable,
    verifiedCompletionRate: assigned === 0 ? 0 : verifiedCompletions / assigned,
    verifiedCompletions,
    verifierPassedJudgeFailed,
  };
}

function parseBootstrap(value: unknown): MatchedTokenEfficiencyStudyV1['bootstrap'] {
  const bootstrap = object(value, 'study bootstrap');
  exactKeys(bootstrap, ['confidenceLevelBasisPoints', 'iterations', 'seed'], 'study bootstrap');
  const confidenceLevelBasisPoints = boundedInteger(
    bootstrap.confidenceLevelBasisPoints,
    8_000,
    9_999,
    'bootstrap confidence level',
  );
  if (confidenceLevelBasisPoints !== 9_500) invalid('bootstrap confidence level must be 95%');
  return {
    confidenceLevelBasisPoints,
    iterations: boundedInteger(bootstrap.iterations, 200, 100_000, 'bootstrap iterations'),
    seed: matchingString(bootstrap.seed, HASH, 'bootstrap seed'),
  };
}

function parseGates(value: unknown): MatchedTokenEfficiencyStudyV1['gates'] {
  const gates = object(value, 'study gates');
  exactKeys(
    gates,
    [
      'completionNonInferiorityBasisPoints',
      'maximumAuthorizationLeaks',
      'maximumFalseCurrentOutcomes',
      'maximumHarmfulActions',
      'minimumCorrectnessScoreMilli',
      'minimumClusters',
      'minimumMemoryTokenReductionBasisPoints',
      'minimumTokenReductionBasisPoints',
    ],
    'study gates',
  );
  return {
    completionNonInferiorityBasisPoints: boundedInteger(
      gates.completionNonInferiorityBasisPoints,
      0,
      5_000,
      'completion non-inferiority margin',
    ),
    maximumAuthorizationLeaks: boundedInteger(gates.maximumAuthorizationLeaks, 0, 1_000, 'maximum authorization leaks'),
    maximumFalseCurrentOutcomes: boundedInteger(
      gates.maximumFalseCurrentOutcomes,
      0,
      1_000,
      'maximum false-current outcomes',
    ),
    maximumHarmfulActions: boundedInteger(gates.maximumHarmfulActions, 0, 1_000, 'maximum harmful actions'),
    minimumCorrectnessScoreMilli: boundedInteger(
      gates.minimumCorrectnessScoreMilli,
      0,
      1_000,
      'minimum correctness score',
    ),
    minimumClusters: boundedInteger(gates.minimumClusters, 2, 64, 'minimum clusters'),
    minimumMemoryTokenReductionBasisPoints: boundedInteger(
      gates.minimumMemoryTokenReductionBasisPoints,
      0,
      9_999,
      'minimum memory token reduction',
    ),
    minimumTokenReductionBasisPoints: boundedInteger(
      gates.minimumTokenReductionBasisPoints,
      0,
      9_999,
      'minimum token reduction',
    ),
  };
}

function parseCluster(value: unknown, index: number): MatchedTokenEfficiencyClusterV1 {
  const cluster = object(value, `study cluster ${index}`);
  exactKeys(
    cluster,
    ['clusterId', 'heldOut', 'repositoryFixtureHash', 'repositoryIdentityHash', 'repositoryUrl', 'revision', 'taskIds'],
    `study cluster ${index}`,
  );
  if (cluster.heldOut !== true) invalid(`study cluster ${index} must be held out`);
  const taskIds = array(cluster.taskIds, `study cluster ${index} task ids`).map((taskId, taskIndex) =>
    matchingString(taskId, TASK_ID, `study cluster ${index} task ${taskIndex}`),
  );
  unique(taskIds, `study cluster ${index} task ids`);
  if (taskIds.length === 0) invalid(`study cluster ${index} must contain a task`);
  const repositoryUrl = boundedString(cluster.repositoryUrl, 8, 2_048, `study cluster ${index} repository URL`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(repositoryUrl);
  } catch {
    invalid(`study cluster ${index} repository URL is invalid`);
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username !== '' || parsedUrl.password !== '') {
    invalid(`study cluster ${index} repository URL must be public HTTPS without credentials`);
  }
  return {
    clusterId: matchingString(cluster.clusterId, CLUSTER_ID, `study cluster ${index} id`),
    heldOut: true,
    repositoryFixtureHash: matchingString(
      cluster.repositoryFixtureHash,
      HASH,
      `study cluster ${index} repository fixture hash`,
    ),
    repositoryIdentityHash: matchingString(
      cluster.repositoryIdentityHash,
      HASH,
      `study cluster ${index} repository identity hash`,
    ),
    repositoryUrl,
    revision: matchingString(cluster.revision, GIT_REVISION, `study cluster ${index} revision`),
    taskIds: [...taskIds].sort(),
  };
}

function parseLifecycleArm(value: unknown, index: number): MatchedTokenEfficiencyLifecycleArmV1 {
  const lifecycle = object(value, `study lifecycle arm ${index}`);
  exactKeys(lifecycle, ['arm', 'setupMilliseconds', 'setupUsage'], `study lifecycle arm ${index}`);
  const setupUsage = object(lifecycle.setupUsage, `study lifecycle arm ${index} setup usage`);
  exactKeys(
    setupUsage,
    ['graphPreparation', 'memoryAuthoring', 'memoryReview'],
    `study lifecycle arm ${index} setup usage`,
  );
  return {
    arm: literal(lifecycle.arm, MATCHED_EVALUATION_ARMS, `study lifecycle arm ${index} id`),
    setupMilliseconds: nonNegativeInteger(lifecycle.setupMilliseconds, `study lifecycle arm ${index} setup time`),
    setupUsage: {
      graphPreparation: parseProviderTokens(setupUsage.graphPreparation, 'graph preparation'),
      memoryAuthoring: parseProviderTokens(setupUsage.memoryAuthoring, 'memory authoring'),
      memoryReview: parseProviderTokens(setupUsage.memoryReview, 'memory review'),
    },
  };
}

function parseTaskContext(value: unknown, index: number): MatchedTokenEfficiencyTaskContextV1 {
  const context = object(value, `study task context ${index}`);
  exactKeys(
    context,
    [
      'asIssuedContext',
      'clusterId',
      'graphContentHash',
      'graphSnapshotHash',
      'linkReceipts',
      'linkReceiptsHash',
      'memoryFixtureHash',
      'repositoryFixtureHash',
      'taskContextHash',
      'taskId',
    ],
    `study task context ${index}`,
  );
  const linkReceipts = array(context.linkReceipts, `study task context ${index} link receipts`).map(
    (receipt, receiptIndex) => parseLinkReceipt(receipt, index, receiptIndex),
  );
  if (linkReceipts.length > 32) invalid(`study task context ${index} links are unbounded`);
  unique(
    linkReceipts.map(receipt => receipt.memoryId),
    `study task context ${index} linked memories`,
  );
  const orderedLinkReceipts = [...linkReceipts].sort((left, right) => left.memoryId.localeCompare(right.memoryId));
  const asIssuedContext = parseAsIssuedContext(context.asIssuedContext, index);
  const withoutHash = {
    asIssuedContext,
    clusterId: matchingString(context.clusterId, CLUSTER_ID, `study task context ${index} cluster id`),
    graphContentHash: matchingString(context.graphContentHash, HASH, `study task context ${index} graph content hash`),
    graphSnapshotHash: matchingString(
      context.graphSnapshotHash,
      HASH,
      `study task context ${index} graph snapshot hash`,
    ),
    linkReceipts: orderedLinkReceipts,
    linkReceiptsHash: matchingString(context.linkReceiptsHash, HASH, `study task context ${index} link receipts hash`),
    memoryFixtureHash: matchingString(context.memoryFixtureHash, HASH, `study task context ${index} memory hash`),
    repositoryFixtureHash: matchingString(
      context.repositoryFixtureHash,
      HASH,
      `study task context ${index} repository hash`,
    ),
    taskId: matchingString(context.taskId, TASK_ID, `study task context ${index} task id`),
  };
  if (withoutHash.linkReceiptsHash !== matchedTokenEfficiencyLinkReceiptsHashV1(orderedLinkReceipts)) {
    invalid(`study task context ${index} link receipts hash differs`);
  }
  const taskContextHash = matchingString(context.taskContextHash, HASH, `study task context ${index} hash`);
  if (taskContextHash !== matchedTokenEfficiencyTaskContextHashV1(withoutHash)) {
    invalid(`study task context ${index} hash differs`);
  }
  return {...withoutHash, taskContextHash};
}

function parseAsIssuedContext(value: unknown, index: number): MatchedTokenEfficiencyTaskContextV1['asIssuedContext'] {
  const context = object(value, `study task context ${index} as-issued context`);
  exactKeys(
    context,
    ['assessmentHash', 'contentHash', 'sufficiency', 'suppliedBytes'],
    `study task context ${index} as-issued context`,
  );
  const sufficiency = literal(
    context.sufficiency,
    MATCHED_TOKEN_EFFICIENCY_CONTEXT_SUFFICIENCY,
    `study task context ${index} as-issued context sufficiency`,
  );
  const suppliedBytes = nonNegativeInteger(
    context.suppliedBytes,
    `study task context ${index} as-issued context bytes`,
  );
  const contentHash =
    context.contentHash === null
      ? null
      : matchingString(context.contentHash, HASH, `study task context ${index} as-issued context hash`);
  if (
    (sufficiency === 'none' && (suppliedBytes !== 0 || contentHash !== null)) ||
    (sufficiency !== 'none' && (suppliedBytes === 0 || contentHash === null))
  ) {
    invalid(`study task context ${index} as-issued context classification disagrees with its content`);
  }
  return {
    assessmentHash: matchingString(
      context.assessmentHash,
      HASH,
      `study task context ${index} as-issued context assessment`,
    ),
    contentHash,
    sufficiency,
    suppliedBytes,
  };
}

function parseLinkReceipt(value: unknown, taskIndex: number, index: number): MatchedTokenEfficiencyLinkReceiptV1 {
  const receipt = object(value, `study task context ${taskIndex} link receipt ${index}`);
  exactKeys(receipt, ['citationHash', 'memoryId', 'status'], 'study link receipt');
  return {
    citationHash: matchingString(receipt.citationHash, HASH, 'study link citation hash'),
    memoryId: matchingString(receipt.memoryId, MEMORY_ID, 'study linked memory id'),
    status: literal(receipt.status, MATCHED_TOKEN_EFFICIENCY_LINK_STATUSES, 'study link status'),
  };
}

function parseProviderTokens(value: unknown, label: string): MatchedEvaluationProviderTokensV1 {
  const tokens = object(value, `${label} provider tokens`);
  exactKeys(
    tokens,
    ['cachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'],
    `${label} provider tokens`,
  );
  const parsed = {
    cachedInputTokens: nonNegativeInteger(tokens.cachedInputTokens, `${label} cached input tokens`),
    inputTokens: nonNegativeInteger(tokens.inputTokens, `${label} input tokens`),
    outputTokens: nonNegativeInteger(tokens.outputTokens, `${label} output tokens`),
    reasoningOutputTokens: nonNegativeInteger(tokens.reasoningOutputTokens, `${label} reasoning output tokens`),
    totalTokens: nonNegativeInteger(tokens.totalTokens, `${label} total tokens`),
  };
  if (
    parsed.cachedInputTokens > parsed.inputTokens ||
    parsed.reasoningOutputTokens > parsed.outputTokens ||
    parsed.totalTokens !== parsed.inputTokens + parsed.outputTokens
  ) {
    invalid(`${label} provider token components are inconsistent`);
  }
  return parsed;
}

function totalSetupTokens(lifecycle: MatchedTokenEfficiencyLifecycleArmV1): number {
  return (
    lifecycle.setupUsage.graphPreparation.totalTokens +
    lifecycle.setupUsage.memoryAuthoring.totalTokens +
    lifecycle.setupUsage.memoryReview.totalTokens
  );
}

function addProviderTokens(
  left: MatchedEvaluationProviderTokensV1,
  right: MatchedEvaluationProviderTokensV1,
): MatchedEvaluationProviderTokensV1 {
  return {
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function scaleProviderTokens(
  tokens: MatchedEvaluationProviderTokensV1,
  multiplier: number,
): MatchedEvaluationProviderTokensV1 {
  return {
    cachedInputTokens: tokens.cachedInputTokens * multiplier,
    inputTokens: tokens.inputTokens * multiplier,
    outputTokens: tokens.outputTokens * multiplier,
    reasoningOutputTokens: tokens.reasoningOutputTokens * multiplier,
    totalTokens: tokens.totalTokens * multiplier,
  };
}

function reductionPercent(target: number | null, baseline: number | null): number | null {
  return target === null || baseline === null || baseline === 0 ? null : (1 - target / baseline) * 100;
}

function percentileInterval(values: readonly number[], tail: number): MatchedTokenEfficiencyIntervalV1 {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    high: percentile(sorted, 1 - tail),
    low: percentile(sorted, tail),
  };
}

function percentile(sorted: readonly number[], probability: number): number {
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(probability * (sorted.length - 1))))];
}

function digestInteger(input: string): number {
  return Number.parseInt(sha256HexSync(input).slice(0, 8), 16);
}

function digest(label: string, value: unknown): string {
  return sha256HexSync(`${label}\0${JSON.stringify(canonicalJson(value))}\n`);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

function formatNullablePercent(value: number | null): string {
  return value === null ? 'undefined' : formatPercent(value);
}

function formatInterval(value: MatchedTokenEfficiencyIntervalV1 | null): string {
  return value === null ? 'undefined' : `[${formatPercent(value.low)}, ${formatPercent(value.high)}]`;
}

function formatNumber(value: number | null): string {
  return value === null ? 'undefined' : `${Math.round(value * 100) / 100}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < minimum || parsed > maximum) invalid(`${label} is outside its allowed range`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) invalid('required study value is missing');
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid matched token-efficiency evaluation: ${message}.`);
}

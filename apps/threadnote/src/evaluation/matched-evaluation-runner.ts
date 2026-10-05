import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  createMatchedEvaluationManifestV1,
  matchedEvaluationArmForLabelV1,
  matchedEvaluationCorpusHashV1,
  parseMatchedEvaluationCorpusV1,
  parseMatchedEvaluationManifestV1,
  type MatchedEvaluationArm,
  type MatchedEvaluationArmDefinitionV1,
  type MatchedEvaluationCorpusTaskV1,
  type MatchedEvaluationCorpusV1,
  type MatchedEvaluationManifestV1,
  type MatchedEvaluationScheduleEntryV1,
  MATCHED_EVALUATION_ARMS,
} from './matched-evaluation.js';
import {
  parseMatchedEvaluationVerificationReceiptV1,
  type MatchedEvaluationVerificationReceiptV1,
} from './matched-verification.js';

export const MATCHED_EVALUATION_OUTCOME_VERSION = 5 as const;
export const MATCHED_EVALUATION_UNAVAILABLE_REASONS = [
  'runtime-not-configured',
  'adapter-missing',
  'adapter-config-missing',
  'tool-missing',
  'unsupported-platform',
] as const;

export type MatchedEvaluationUnavailableReason = (typeof MATCHED_EVALUATION_UNAVAILABLE_REASONS)[number];

export interface MatchedEvaluationProviderTokensV1 {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface MatchedEvaluationTokenAccountingV1 {
  readonly cacheWriteTokens: number | null;
  readonly cachedInputTokens: number;
  readonly newTokens: number | null;
  readonly outputTokens: number;
  readonly processedTokens: number | null;
  readonly rawInputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly uncachedInputTokens: number;
}

export interface MatchedEvaluationAttributionV1 {
  readonly completedItemBytes: {
    readonly agentMessage: number;
    readonly commandExecution: number;
    readonly fileChange: number;
    readonly mcpToolCall: number;
    readonly other: number;
    readonly reasoning: number;
  };
  readonly firstSufficientEvidenceMilliseconds: number | null;
  readonly graphRequests: readonly {
    readonly budgetTokens: number | null;
    readonly edgeLimit: number | null;
    readonly nodeLimit: number | null;
    readonly operation: string | null;
  }[];
  /** Structural evidence-card presence at agent start; not a sufficiency claim. */
  readonly initialContinuationEvidenceState?: 'background' | 'evidence-bearing';
  readonly lastTwoModelCallTokens: MatchedEvaluationTokenAccountingV1;
  readonly modelCallCount: number;
  readonly modelCalls: readonly MatchedEvaluationTokenAccountingV1[];
  readonly modelVisibleBytes: {
    readonly completedItemBytes: number;
    readonly promptBytes: number;
    readonly totalBytes: number;
  };
  /** Privacy-safe completed work after the first timestamped sufficient-evidence item. */
  readonly postSufficientEvidence?: {
    readonly completedItemBytes: number;
    readonly completedItems: number;
    readonly commandExecutions: number;
    readonly declinedCommandExecutions: number;
    readonly fileChanges: number;
    readonly mcpToolCalls: number;
  } | null;
  readonly repeatedToolCalls: {
    readonly commandExecution: number;
    readonly contextBrief: number;
    readonly fileChange: number;
    readonly inspectCodeGraph: number;
    readonly readContext: number;
    readonly recallContext: number;
  };
  readonly tokens: MatchedEvaluationTokenAccountingV1;
}

export interface MatchedEvaluationContextVerificationV1 {
  readonly graphReady: true;
  readonly graphSnapshotHash: string;
  readonly linkReceiptsHash: string | null;
  readonly memoryAccess: 'disabled' | 'linked';
  readonly studyHash: string;
  readonly taskContextHash: string | null;
}

export interface MatchedEvaluationMetricsV1 {
  readonly auditability: {
    readonly citations: number;
    readonly resolvableCitations: number;
  };
  readonly completion: {
    readonly completed: boolean;
  };
  readonly correctness: {
    readonly judge: 'blinded-rubric-v1';
    readonly judgeCompleted: boolean;
    readonly scoreMilli: number;
  };
  readonly drift: {
    readonly falseCurrentOutcomes: number;
  };
  readonly providerCostMicros: number | null;
  readonly retrieval: {
    readonly recalledEvidence: number;
    readonly requiredEvidence: number;
  };
  readonly safety: {
    readonly authorizationLeaks: number;
    /** Policy-denied action attempts; distinct from judge-observed harmful actions. */
    readonly blockedActions: number;
    readonly harmfulActions: number;
  };
  readonly sourceSupport: {
    readonly requiredClaims: number;
    readonly supportedClaims: number;
  };
  readonly timing: {
    readonly agentTaskMilliseconds: number;
    readonly deterministicVerifierMilliseconds: number;
    readonly endToEndMilliseconds: number;
    readonly firstSufficientEvidenceMilliseconds: number | null;
    readonly judgeSetupMilliseconds: number;
    readonly judgeTurnMilliseconds: number;
    readonly preparationMilliseconds: number;
  };
  readonly usage: {
    /** Derived, privacy-safe event accounting. Omitted by sealed v5 pilot outcomes. */
    readonly attribution?: MatchedEvaluationAttributionV1;
    readonly modelVisibleBytes: number;
    readonly modelVisibleTokens: number;
    /** Provider-reported task-window usage. Required for token-efficiency claims. */
    readonly providerTokens: MatchedEvaluationProviderTokensV1 | null;
    readonly redundantFileReads: number;
    readonly toolTurns: number;
  };
  /** Exact ready-graph and linked-memory preflight. Null for non-Threadnote arms. */
  readonly context: MatchedEvaluationContextVerificationV1 | null;
  readonly validity: {
    readonly failureCount: number;
    readonly valid: boolean;
  };
  /** Null for generic evaluations without a sealed deterministic verifier. */
  readonly verification: MatchedEvaluationVerificationReceiptV1 | null;
}

export interface MatchedEvaluationObservationV1 {
  readonly artifactHash: string;
  readonly metrics: MatchedEvaluationMetricsV1;
  readonly transcriptHash: string;
  readonly version: typeof MATCHED_EVALUATION_OUTCOME_VERSION;
}

export interface MatchedEvaluationOutcomeV1 {
  readonly artifactHash: string | null;
  readonly blindLabel: MatchedEvaluationScheduleEntryV1['blindLabel'];
  readonly manifestHash: string;
  readonly metrics: MatchedEvaluationMetricsV1 | null;
  readonly outcomeHash: string;
  readonly previousOutcomeHash: string | null;
  readonly runNonce: string;
  readonly runOrder: number;
  readonly status: 'completed' | 'unavailable';
  readonly taskId: string;
  readonly transcriptHash: string | null;
  readonly unavailable: {
    readonly detailHash: string;
    readonly reason: MatchedEvaluationUnavailableReason;
  } | null;
  readonly version: typeof MATCHED_EVALUATION_OUTCOME_VERSION;
}

export interface MatchedEvaluationRunRequestV1 {
  readonly arm: MatchedEvaluationArm;
  readonly armDefinition: MatchedEvaluationArmDefinitionV1;
  readonly manifest: MatchedEvaluationManifestV1;
  readonly schedule: MatchedEvaluationScheduleEntryV1;
  readonly task: MatchedEvaluationCorpusTaskV1;
}

export interface MatchedEvaluationSummaryV1 {
  readonly arms: readonly MatchedEvaluationArmSummaryV1[];
  readonly comparativeClaimsEligible: boolean;
  readonly corpusHash: string;
  readonly limitations: readonly string[];
  readonly manifestHash: string;
  readonly proxyDeclarations: Readonly<Record<string, string>>;
  readonly repetitions: number;
  readonly version: typeof MATCHED_EVALUATION_OUTCOME_VERSION;
}

export interface MatchedEvaluationArmSummaryV1 {
  readonly arm: MatchedEvaluationArm;
  readonly auditabilityRate: number | null;
  readonly averageAgentTaskMilliseconds: number | null;
  readonly averageDeterministicVerifierMilliseconds: number | null;
  readonly averageEndToEndMilliseconds: number | null;
  readonly averageJudgeSetupMilliseconds: number | null;
  readonly averageJudgeTurnMilliseconds: number | null;
  readonly averageModelVisibleBytes: number | null;
  readonly averageModelVisibleTokens: number | null;
  readonly averageProviderCostMicros: number | null;
  readonly averagePreparationMilliseconds: number | null;
  readonly averageRedundantFileReads: number | null;
  readonly averageToolTurns: number | null;
  readonly completed: number;
  readonly completionRate: number | null;
  readonly correctness: {
    readonly meanScore: number | null;
    readonly passRate: number | null;
    readonly wilson95: {readonly high: number; readonly low: number} | null;
  };
  readonly falseCurrentOutcomes: number;
  readonly blockedActions: number;
  readonly harmfulActions: number;
  readonly authorizationLeaks: number;
  readonly invalid: number;
  readonly retrievalRecall: number | null;
  readonly sourceSupportRate: number | null;
  readonly unavailable: number;
}

const HASH = /^[0-9a-f]{64}$/u;
const RUN_NONCE = /^run_[0-9a-f]{32}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const MAXIMUM_LEDGER_BYTES = 16 * 1_024 * 1_024;

export function parseMatchedEvaluationObservationV1(value: unknown): MatchedEvaluationObservationV1 {
  const observation = object(value, 'observation');
  exactKeys(observation, ['artifactHash', 'metrics', 'transcriptHash', 'version'], 'observation');
  if (observation.version !== MATCHED_EVALUATION_OUTCOME_VERSION) invalid('observation version must be 5');
  return {
    artifactHash: matchingString(observation.artifactHash, HASH, 'observation artifact hash'),
    metrics: parseMetrics(observation.metrics),
    transcriptHash: matchingString(observation.transcriptHash, HASH, 'observation transcript hash'),
    version: MATCHED_EVALUATION_OUTCOME_VERSION,
  };
}

export function createMatchedEvaluationCompletedOutcomeV1(input: {
  readonly manifest: MatchedEvaluationManifestV1;
  readonly observation: MatchedEvaluationObservationV1 | unknown;
  readonly previousOutcomeHash: string | null;
  readonly schedule: MatchedEvaluationScheduleEntryV1;
}): MatchedEvaluationOutcomeV1 {
  const observation = parseMatchedEvaluationObservationV1(input.observation);
  if (observation.metrics.verification !== null && observation.metrics.verification.taskId !== input.schedule.taskId) {
    invalid('verification receipt task differs from the immutable schedule');
  }
  if (
    observation.metrics.verification !== null &&
    observation.metrics.verification.artifactHash !== observation.artifactHash
  ) {
    invalid('verification receipt artifact differs from the observed artifact');
  }
  return createOutcome({
    artifactHash: observation.artifactHash,
    manifestHash: input.manifest.manifestHash,
    metrics: observation.metrics,
    previousOutcomeHash: input.previousOutcomeHash,
    schedule: input.schedule,
    status: 'completed',
    transcriptHash: observation.transcriptHash,
    unavailable: null,
  });
}

export function createMatchedEvaluationUnavailableOutcomeV1(input: {
  readonly detail: string;
  readonly manifest: MatchedEvaluationManifestV1;
  readonly previousOutcomeHash: string | null;
  readonly reason: MatchedEvaluationUnavailableReason;
  readonly schedule: MatchedEvaluationScheduleEntryV1;
}): MatchedEvaluationOutcomeV1 {
  const reason = literal(input.reason, MATCHED_EVALUATION_UNAVAILABLE_REASONS, 'unavailable reason');
  return createOutcome({
    artifactHash: null,
    manifestHash: input.manifest.manifestHash,
    metrics: null,
    previousOutcomeHash: input.previousOutcomeHash,
    schedule: input.schedule,
    status: 'unavailable',
    transcriptHash: null,
    unavailable: {
      detailHash: sha256HexSync(
        `matched-evaluation-unavailable-v2\0${boundedString(input.detail, 1, 2_048, 'unavailable detail')}\n`,
      ),
      reason,
    },
  });
}

export function parseMatchedEvaluationOutcomeV1(value: unknown): MatchedEvaluationOutcomeV1 {
  const outcome = object(value, 'outcome');
  exactKeys(
    outcome,
    [
      'artifactHash',
      'blindLabel',
      'manifestHash',
      'metrics',
      'outcomeHash',
      'previousOutcomeHash',
      'runNonce',
      'runOrder',
      'status',
      'taskId',
      'transcriptHash',
      'unavailable',
      'version',
    ],
    'outcome',
  );
  if (outcome.version !== MATCHED_EVALUATION_OUTCOME_VERSION) invalid('outcome version must be 5');
  const status = literal(outcome.status, ['completed', 'unavailable'] as const, 'outcome status');
  let unavailable: MatchedEvaluationOutcomeV1['unavailable'] = null;
  if (outcome.unavailable !== null) {
    const raw = object(outcome.unavailable, 'outcome unavailable');
    exactKeys(raw, ['detailHash', 'reason'], 'outcome unavailable');
    unavailable = {
      detailHash: matchingString(raw.detailHash, HASH, 'outcome unavailable detail hash'),
      reason: literal(raw.reason, MATCHED_EVALUATION_UNAVAILABLE_REASONS, 'outcome unavailable reason'),
    };
  }
  const metrics = outcome.metrics === null ? null : parseMetrics(outcome.metrics);
  const artifactHash =
    outcome.artifactHash === null ? null : matchingString(outcome.artifactHash, HASH, 'artifact hash');
  const transcriptHash =
    outcome.transcriptHash === null ? null : matchingString(outcome.transcriptHash, HASH, 'transcript hash');
  if (
    (status === 'completed' &&
      (metrics === null || artifactHash === null || transcriptHash === null || unavailable !== null)) ||
    (status === 'unavailable' &&
      (metrics !== null || artifactHash !== null || transcriptHash !== null || unavailable === null))
  ) {
    invalid('outcome status fields are inconsistent');
  }
  const withoutHash = {
    artifactHash,
    blindLabel: literal(outcome.blindLabel, ['A', 'B', 'C', 'D', 'E'] as const, 'outcome blind label'),
    manifestHash: matchingString(outcome.manifestHash, HASH, 'outcome manifest hash'),
    metrics,
    previousOutcomeHash:
      outcome.previousOutcomeHash === null
        ? null
        : matchingString(outcome.previousOutcomeHash, HASH, 'previous outcome hash'),
    runNonce: matchingString(outcome.runNonce, RUN_NONCE, 'outcome run nonce'),
    runOrder: nonNegativeInteger(outcome.runOrder, 'outcome run order'),
    status,
    taskId: matchingString(outcome.taskId, TASK_ID, 'outcome task id'),
    transcriptHash,
    unavailable,
    version: MATCHED_EVALUATION_OUTCOME_VERSION,
  };
  const outcomeHash = matchingString(outcome.outcomeHash, HASH, 'outcome hash');
  if (outcomeHash !== matchedEvaluationOutcomeHashV1(withoutHash)) {
    invalid('outcome hash does not match its canonical contents');
  }
  return {...withoutHash, outcomeHash};
}

export function parseMatchedEvaluationOutcomesJsonlV1(input: string): readonly MatchedEvaluationOutcomeV1[] {
  if (new TextEncoder().encode(input).byteLength > MAXIMUM_LEDGER_BYTES) {
    invalid('outcome ledger exceeds 16 MiB');
  }
  return input.split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [parseMatchedEvaluationOutcomeV1(JSON.parse(line) as unknown)];
    } catch (cause) {
      throw new Error(`Matched evaluation outcome ledger line ${index + 1} is invalid.`, {cause});
    }
  });
}

export function assertMatchedEvaluationOutcomePrefixV1(
  manifestInput: MatchedEvaluationManifestV1 | unknown,
  outcomesInput: readonly MatchedEvaluationOutcomeV1[] | readonly unknown[],
): readonly MatchedEvaluationOutcomeV1[] {
  const manifest = parseMatchedEvaluationManifestV1(manifestInput);
  if (outcomesInput.length > manifest.schedule.length) invalid('outcome ledger is longer than the schedule');
  let previous: string | null = null;
  const outcomes = outcomesInput.map((input, index) => {
    const outcome = parseMatchedEvaluationOutcomeV1(input);
    const scheduled = manifest.schedule[index];
    if (
      outcome.manifestHash !== manifest.manifestHash ||
      outcome.runOrder !== scheduled.runOrder ||
      outcome.runNonce !== scheduled.runNonce ||
      outcome.taskId !== scheduled.taskId ||
      outcome.blindLabel !== scheduled.blindLabel ||
      outcome.previousOutcomeHash !== previous
    ) {
      invalid(`outcome ${index} does not match the immutable manifest schedule and hash chain`);
    }
    previous = outcome.outcomeHash;
    return outcome;
  });
  return outcomes;
}

export async function runMatchedEvaluationV1(input: {
  readonly availability: (
    arm: MatchedEvaluationArm,
    definition: MatchedEvaluationArmDefinitionV1,
  ) => Promise<
    | {readonly available: true}
    | {readonly available: false; readonly detail: string; readonly reason: MatchedEvaluationUnavailableReason}
  >;
  readonly corpus: MatchedEvaluationCorpusV1 | unknown;
  readonly execute: (request: MatchedEvaluationRunRequestV1) => Promise<MatchedEvaluationObservationV1 | unknown>;
  readonly manifest: MatchedEvaluationManifestV1 | unknown;
  readonly onOutcome?: (outcome: MatchedEvaluationOutcomeV1) => Promise<void>;
  readonly outcomes?: readonly MatchedEvaluationOutcomeV1[] | readonly unknown[];
}): Promise<readonly MatchedEvaluationOutcomeV1[]> {
  const manifest = parseMatchedEvaluationManifestV1(input.manifest);
  const corpus = parseMatchedEvaluationCorpusV1(input.corpus);
  assertCorpusMatchesManifest(corpus, manifest);
  const outcomes = [...assertMatchedEvaluationOutcomePrefixV1(manifest, input.outcomes ?? [])];
  const availability = new Map<
    MatchedEvaluationArm,
    | {readonly available: true}
    | {readonly available: false; readonly detail: string; readonly reason: MatchedEvaluationUnavailableReason}
  >();
  for (let index = outcomes.length; index < manifest.schedule.length; index += 1) {
    const schedule = manifest.schedule[index];
    const arm = matchedEvaluationArmForLabelV1(manifest, schedule.blindLabel);
    const definition = manifest.arms.find(candidate => candidate.arm === arm);
    if (definition === undefined) invalid(`schedule arm ${arm} is not defined`);
    let state = availability.get(arm);
    if (state === undefined) {
      state = await input.availability(arm, definition);
      availability.set(arm, state);
    }
    const previousOutcomeHash = outcomes.at(-1)?.outcomeHash ?? null;
    const outcome = state.available
      ? createMatchedEvaluationCompletedOutcomeV1({
          manifest,
          observation: await input.execute({
            arm,
            armDefinition: definition,
            manifest,
            schedule,
            task: requiredTask(corpus, schedule.taskId),
          }),
          previousOutcomeHash,
          schedule,
        })
      : createMatchedEvaluationUnavailableOutcomeV1({
          detail: state.detail,
          manifest,
          previousOutcomeHash,
          reason: state.reason,
          schedule,
        });
    await input.onOutcome?.(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
}

export function summarizeMatchedEvaluationV1(
  manifestInput: MatchedEvaluationManifestV1 | unknown,
  outcomesInput: readonly MatchedEvaluationOutcomeV1[] | readonly unknown[],
): MatchedEvaluationSummaryV1 {
  const manifest = parseMatchedEvaluationManifestV1(manifestInput);
  const outcomes = assertMatchedEvaluationOutcomePrefixV1(manifest, outcomesInput);
  const arms = MATCHED_EVALUATION_ARMS.map(arm => {
    const label = (
      Object.entries(manifest.blindAssignment) as readonly [
        MatchedEvaluationScheduleEntryV1['blindLabel'],
        MatchedEvaluationArm,
      ][]
    ).find(([, candidate]) => candidate === arm)?.[0];
    if (label === undefined) invalid(`manifest has no blind label for ${arm}`);
    return summarizeArm(
      arm,
      outcomes.filter(outcome => outcome.blindLabel === label),
    );
  });
  const expectedPerArm = manifest.tasks.length * manifest.repetitions;
  return {
    arms,
    comparativeClaimsEligible: arms.every(
      arm => arm.completed === expectedPerArm && arm.invalid === 0 && arm.unavailable === 0,
    ),
    corpusHash: manifest.corpusHash,
    limitations: [
      'Confidence intervals treat one task repetition as an observation; scenario-family dependence can make them optimistic.',
      'Latency and provider cost are environment observations, not universal product properties.',
      'A complete balanced repeated matrix is required before comparative claims are eligible.',
      'Raw transcripts remain local runner artifacts and are excluded from this summary and outcome ledger.',
    ],
    manifestHash: manifest.manifestHash,
    proxyDeclarations: {
      auditability: 'Resolvable cited evidence divided by all cited evidence.',
      correctness: 'Score assigned by the blinded rubric adapter; deterministic completion is reported separately.',
      drift: 'Count of claims presented as current when the blinded rubric marks their evidence stale or absent.',
      retrieval: 'Required evidence items recalled divided by required evidence items in the sealed rubric.',
      sourceSupport: 'Required claims supported by exact source evidence divided by required claims.',
    },
    repetitions: manifest.repetitions,
    version: MATCHED_EVALUATION_OUTCOME_VERSION,
  };
}

function createOutcome(input: {
  readonly artifactHash: string | null;
  readonly manifestHash: string;
  readonly metrics: MatchedEvaluationMetricsV1 | null;
  readonly previousOutcomeHash: string | null;
  readonly schedule: MatchedEvaluationScheduleEntryV1;
  readonly status: MatchedEvaluationOutcomeV1['status'];
  readonly transcriptHash: string | null;
  readonly unavailable: MatchedEvaluationOutcomeV1['unavailable'];
}): MatchedEvaluationOutcomeV1 {
  const withoutHash = {
    artifactHash: input.artifactHash,
    blindLabel: input.schedule.blindLabel,
    manifestHash: input.manifestHash,
    metrics: input.metrics,
    previousOutcomeHash: input.previousOutcomeHash,
    runNonce: input.schedule.runNonce,
    runOrder: input.schedule.runOrder,
    status: input.status,
    taskId: input.schedule.taskId,
    transcriptHash: input.transcriptHash,
    unavailable: input.unavailable,
    version: MATCHED_EVALUATION_OUTCOME_VERSION,
  };
  return {...withoutHash, outcomeHash: matchedEvaluationOutcomeHashV1(withoutHash)};
}

function matchedEvaluationOutcomeHashV1(input: Omit<MatchedEvaluationOutcomeV1, 'outcomeHash'>): string {
  return sha256HexSync(`matched-evaluation-outcome-v4\0${JSON.stringify(input)}\n`);
}

function assertCorpusMatchesManifest(corpus: MatchedEvaluationCorpusV1, manifest: MatchedEvaluationManifestV1): void {
  if (matchedEvaluationCorpusHashV1(corpus) !== manifest.corpusHash) {
    invalid('corpus hash differs from the frozen manifest');
  }
  const reproduced = createMatchedEvaluationManifestV1({
    activeArms: manifest.activeArms,
    arms: manifest.arms,
    corpus,
    model: manifest.model,
    repetitions: manifest.repetitions,
    repository: manifest.repository,
    scheduleSeed: manifest.scheduleSeed,
  });
  if (reproduced.manifestHash !== manifest.manifestHash) {
    invalid('corpus task projections differ from the frozen manifest');
  }
}

function requiredTask(corpus: MatchedEvaluationCorpusV1, taskId: string): MatchedEvaluationCorpusTaskV1 {
  const task = corpus.tasks.find(candidate => candidate.taskId === taskId);
  if (task === undefined) invalid(`corpus does not contain scheduled task ${taskId}`);
  return task;
}

function summarizeArm(
  arm: MatchedEvaluationArm,
  outcomes: readonly MatchedEvaluationOutcomeV1[],
): MatchedEvaluationArmSummaryV1 {
  const completed = outcomes.filter(
    (outcome): outcome is MatchedEvaluationOutcomeV1 & {readonly metrics: MatchedEvaluationMetricsV1} =>
      outcome.status === 'completed' && outcome.metrics !== null,
  );
  const valid = completed.filter(outcome => outcome.metrics.validity.valid);
  const count = valid.length;
  const sum = (select: (metrics: MatchedEvaluationMetricsV1) => number) =>
    valid.reduce((total, outcome) => total + select(outcome.metrics), 0);
  const ratio = (
    numerator: (metrics: MatchedEvaluationMetricsV1) => number,
    denominator: (metrics: MatchedEvaluationMetricsV1) => number,
  ) => {
    const total = sum(denominator);
    return total === 0 ? null : sum(numerator) / total;
  };
  const costs = valid.flatMap(outcome =>
    outcome.metrics.providerCostMicros === null ? [] : [outcome.metrics.providerCostMicros],
  );
  const correctnessPasses = valid.filter(outcome => outcome.metrics.correctness.scoreMilli === 1_000).length;
  return {
    arm,
    auditabilityRate: ratio(
      metrics => metrics.auditability.resolvableCitations,
      metrics => metrics.auditability.citations,
    ),
    averageAgentTaskMilliseconds: average(valid.map(outcome => outcome.metrics.timing.agentTaskMilliseconds)),
    averageDeterministicVerifierMilliseconds: average(
      valid.map(outcome => outcome.metrics.timing.deterministicVerifierMilliseconds),
    ),
    averageEndToEndMilliseconds: average(valid.map(outcome => outcome.metrics.timing.endToEndMilliseconds)),
    averageJudgeSetupMilliseconds: average(valid.map(outcome => outcome.metrics.timing.judgeSetupMilliseconds)),
    averageJudgeTurnMilliseconds: average(valid.map(outcome => outcome.metrics.timing.judgeTurnMilliseconds)),
    averageModelVisibleBytes: average(valid.map(outcome => outcome.metrics.usage.modelVisibleBytes)),
    averageModelVisibleTokens: average(valid.map(outcome => outcome.metrics.usage.modelVisibleTokens)),
    averageProviderCostMicros: average(costs),
    averagePreparationMilliseconds: average(valid.map(outcome => outcome.metrics.timing.preparationMilliseconds)),
    averageRedundantFileReads: average(valid.map(outcome => outcome.metrics.usage.redundantFileReads)),
    averageToolTurns: average(valid.map(outcome => outcome.metrics.usage.toolTurns)),
    completed: completed.length,
    completionRate: count === 0 ? null : sum(metrics => (metrics.completion.completed ? 1 : 0)) / count,
    correctness: {
      meanScore: count === 0 ? null : sum(metrics => metrics.correctness.scoreMilli) / (1_000 * count),
      passRate: count === 0 ? null : correctnessPasses / count,
      wilson95: count === 0 ? null : wilson95(correctnessPasses, count),
    },
    falseCurrentOutcomes: sum(metrics => metrics.drift.falseCurrentOutcomes),
    blockedActions: sum(metrics => metrics.safety.blockedActions),
    harmfulActions: sum(metrics => metrics.safety.harmfulActions),
    authorizationLeaks: sum(metrics => metrics.safety.authorizationLeaks),
    invalid: completed.length - valid.length,
    retrievalRecall: ratio(
      metrics => metrics.retrieval.recalledEvidence,
      metrics => metrics.retrieval.requiredEvidence,
    ),
    sourceSupportRate: ratio(
      metrics => metrics.sourceSupport.supportedClaims,
      metrics => metrics.sourceSupport.requiredClaims,
    ),
    unavailable: outcomes.filter(outcome => outcome.status === 'unavailable').length,
  };
}

function parseMetrics(value: unknown): MatchedEvaluationMetricsV1 {
  const metrics = object(value, 'observation metrics');
  exactKeys(
    metrics,
    [
      'auditability',
      'completion',
      'context',
      'correctness',
      'drift',
      'providerCostMicros',
      'retrieval',
      'safety',
      'sourceSupport',
      'timing',
      'usage',
      'validity',
      'verification',
    ],
    'observation metrics',
  );
  const auditability = boundedPair(metrics.auditability, 'citations', 'resolvableCitations', 'auditability');
  const completion = object(metrics.completion, 'completion metrics');
  exactKeys(completion, ['completed'], 'completion metrics');
  if (typeof completion.completed !== 'boolean') invalid('completion flag must be boolean');
  const correctness = object(metrics.correctness, 'correctness metrics');
  exactKeys(correctness, ['judge', 'judgeCompleted', 'scoreMilli'], 'correctness metrics');
  if (typeof correctness.judgeCompleted !== 'boolean') invalid('judge completion flag must be boolean');
  const scoreMilli = nonNegativeInteger(correctness.scoreMilli, 'correctness score');
  if (scoreMilli > 1_000) invalid('correctness score must be at most 1000');
  const drift = object(metrics.drift, 'drift metrics');
  exactKeys(drift, ['falseCurrentOutcomes'], 'drift metrics');
  const retrieval = boundedPair(metrics.retrieval, 'requiredEvidence', 'recalledEvidence', 'retrieval');
  const safety = object(metrics.safety, 'safety metrics');
  exactKeys(safety, ['authorizationLeaks', 'blockedActions', 'harmfulActions'], 'safety metrics');
  const sourceSupport = boundedPair(metrics.sourceSupport, 'requiredClaims', 'supportedClaims', 'source support');
  const timing = object(metrics.timing, 'timing metrics');
  exactKeys(
    timing,
    [
      'agentTaskMilliseconds',
      'deterministicVerifierMilliseconds',
      'endToEndMilliseconds',
      'firstSufficientEvidenceMilliseconds',
      'judgeSetupMilliseconds',
      'judgeTurnMilliseconds',
      'preparationMilliseconds',
    ],
    'timing metrics',
  );
  const agentTaskMilliseconds = nonNegativeInteger(timing.agentTaskMilliseconds, 'agent task time');
  const deterministicVerifierMilliseconds = nonNegativeInteger(
    timing.deterministicVerifierMilliseconds,
    'deterministic verifier time',
  );
  const endToEndMilliseconds = nonNegativeInteger(timing.endToEndMilliseconds, 'end-to-end time');
  const judgeSetupMilliseconds = nonNegativeInteger(timing.judgeSetupMilliseconds, 'judge setup time');
  const judgeTurnMilliseconds = nonNegativeInteger(timing.judgeTurnMilliseconds, 'judge turn time');
  const preparationMilliseconds = nonNegativeInteger(timing.preparationMilliseconds, 'preparation time');
  if (
    endToEndMilliseconds !==
    preparationMilliseconds +
      agentTaskMilliseconds +
      deterministicVerifierMilliseconds +
      judgeSetupMilliseconds +
      judgeTurnMilliseconds
  ) {
    invalid('end-to-end time must equal the non-overlapping lifecycle phase times');
  }
  const firstSufficientEvidenceMilliseconds =
    timing.firstSufficientEvidenceMilliseconds === null
      ? null
      : nonNegativeInteger(timing.firstSufficientEvidenceMilliseconds, 'first sufficient evidence time');
  if (
    firstSufficientEvidenceMilliseconds !== null &&
    firstSufficientEvidenceMilliseconds > preparationMilliseconds + agentTaskMilliseconds
  ) {
    invalid('first sufficient evidence time exceeds the agent task window');
  }
  const usage = object(metrics.usage, 'usage metrics');
  exactKeys(
    usage,
    [
      ...(usage.attribution === undefined ? [] : ['attribution']),
      'modelVisibleBytes',
      'modelVisibleTokens',
      'providerTokens',
      'redundantFileReads',
      'toolTurns',
    ],
    'usage metrics',
  );
  const validity = object(metrics.validity, 'validity metrics');
  exactKeys(validity, ['failureCount', 'valid'], 'validity metrics');
  if (typeof validity.valid !== 'boolean') invalid('validity flag must be boolean');
  const failureCount = nonNegativeInteger(validity.failureCount, 'validity failure count');
  if (validity.valid !== (failureCount === 0)) invalid('validity flag and failure count disagree');
  const providerCostMicros =
    metrics.providerCostMicros === null ? null : nonNegativeInteger(metrics.providerCostMicros, 'provider cost micros');
  const context = parseContextVerification(metrics.context);
  const verification =
    metrics.verification === null ? null : parseMatchedEvaluationVerificationReceiptV1(metrics.verification);
  if (verification !== null && completion.completed !== (verification.status === 'passed')) {
    invalid('deterministic completion flag and verification receipt disagree');
  }
  if (verification === null && deterministicVerifierMilliseconds !== 0) {
    invalid('deterministic verifier time must be zero when verification is absent');
  }
  const modelVisibleBytes = nonNegativeInteger(usage.modelVisibleBytes, 'model-visible bytes');
  const providerTokens = usage.providerTokens === null ? null : parseProviderTokens(usage.providerTokens);
  const attribution = usage.attribution === undefined ? undefined : parseAttribution(usage.attribution);
  if (attribution !== undefined && attribution.modelVisibleBytes.totalBytes !== modelVisibleBytes) {
    invalid('attribution model-visible bytes differ from usage model-visible bytes');
  }
  if (attribution !== undefined && providerTokens !== null) {
    assertReconciledAttributionTokens(
      attribution.tokens,
      {
        cachedInputTokens: providerTokens.cachedInputTokens,
        outputTokens: providerTokens.outputTokens,
        rawInputTokens: providerTokens.inputTokens,
        reasoningOutputTokens: providerTokens.reasoningOutputTokens,
        totalTokens: providerTokens.totalTokens,
      },
      'provider token usage',
    );
  }
  return {
    auditability: {citations: auditability.total, resolvableCitations: auditability.subset},
    completion: {completed: completion.completed},
    context,
    correctness: {
      judge: literal(correctness.judge, ['blinded-rubric-v1'] as const, 'correctness judge'),
      judgeCompleted: correctness.judgeCompleted,
      scoreMilli,
    },
    drift: {falseCurrentOutcomes: nonNegativeInteger(drift.falseCurrentOutcomes, 'false-current outcomes')},
    providerCostMicros,
    retrieval: {recalledEvidence: retrieval.subset, requiredEvidence: retrieval.total},
    safety: {
      authorizationLeaks: nonNegativeInteger(safety.authorizationLeaks, 'authorization leaks'),
      blockedActions: nonNegativeInteger(safety.blockedActions, 'blocked actions'),
      harmfulActions: nonNegativeInteger(safety.harmfulActions, 'harmful actions'),
    },
    sourceSupport: {requiredClaims: sourceSupport.total, supportedClaims: sourceSupport.subset},
    timing: {
      agentTaskMilliseconds,
      deterministicVerifierMilliseconds,
      endToEndMilliseconds,
      firstSufficientEvidenceMilliseconds,
      judgeSetupMilliseconds,
      judgeTurnMilliseconds,
      preparationMilliseconds,
    },
    usage: {
      ...(attribution === undefined ? {} : {attribution}),
      modelVisibleBytes,
      modelVisibleTokens: nonNegativeInteger(usage.modelVisibleTokens, 'model-visible tokens'),
      providerTokens,
      redundantFileReads: nonNegativeInteger(usage.redundantFileReads, 'redundant file reads'),
      toolTurns: nonNegativeInteger(usage.toolTurns, 'tool turns'),
    },
    validity: {failureCount, valid: validity.valid},
    verification,
  };
}

function parseAttribution(value: unknown): MatchedEvaluationAttributionV1 {
  const attribution = object(value, 'usage attribution');
  const hasPostSufficientEvidence = Object.prototype.hasOwnProperty.call(attribution, 'postSufficientEvidence');
  const hasInitialContinuationEvidenceState = Object.prototype.hasOwnProperty.call(
    attribution,
    'initialContinuationEvidenceState',
  );
  exactKeys(
    attribution,
    [
      'completedItemBytes',
      'firstSufficientEvidenceMilliseconds',
      'graphRequests',
      ...(hasInitialContinuationEvidenceState ? ['initialContinuationEvidenceState'] : []),
      'lastTwoModelCallTokens',
      'modelCallCount',
      'modelCalls',
      'modelVisibleBytes',
      ...(hasPostSufficientEvidence ? ['postSufficientEvidence'] : []),
      'repeatedToolCalls',
      'tokens',
    ],
    'usage attribution',
  );
  const completedItemBytes = object(attribution.completedItemBytes, 'completed item bytes');
  exactKeys(
    completedItemBytes,
    ['agentMessage', 'commandExecution', 'fileChange', 'mcpToolCall', 'other', 'reasoning'],
    'completed item bytes',
  );
  const repeatedToolCalls = object(attribution.repeatedToolCalls, 'repeated tool calls');
  exactKeys(
    repeatedToolCalls,
    ['commandExecution', 'contextBrief', 'fileChange', 'inspectCodeGraph', 'readContext', 'recallContext'],
    'repeated tool calls',
  );
  const modelCalls = array(attribution.modelCalls, 'attribution model calls').map((call, index) =>
    parseAttributionTokens(call, `attribution model call ${index}`),
  );
  const modelCallCount = nonNegativeInteger(attribution.modelCallCount, 'model call count');
  if (modelCalls.length !== modelCallCount) invalid('attribution model call count differs from deltas');
  const lastTwoModelCallTokens = parseAttributionTokens(
    attribution.lastTwoModelCallTokens,
    'last two model call tokens',
  );
  if (!sameTokenAccounting(lastTwoModelCallTokens, sumTokenAccounting(modelCalls.slice(-2)))) {
    invalid('last two model call tokens differ from model call deltas');
  }
  const tokens = parseAttributionTokens(attribution.tokens, 'attribution tokens');
  assertReconciledAttributionTokens(tokens, sumTokenAccounting(modelCalls), 'model call deltas');
  const modelVisibleBytes = object(attribution.modelVisibleBytes, 'attribution model-visible bytes');
  exactKeys(modelVisibleBytes, ['completedItemBytes', 'promptBytes', 'totalBytes'], 'attribution model-visible bytes');
  const completedItemByteTotal = Object.values(completedItemBytes).reduce<number>(
    (total, bytes) => total + nonNegativeInteger(bytes, 'completed item byte count'),
    0,
  );
  const parsedModelVisibleBytes = {
    completedItemBytes: nonNegativeInteger(modelVisibleBytes.completedItemBytes, 'completed item byte total'),
    promptBytes: nonNegativeInteger(modelVisibleBytes.promptBytes, 'prompt bytes'),
    totalBytes: nonNegativeInteger(modelVisibleBytes.totalBytes, 'attribution model-visible byte total'),
  };
  if (
    parsedModelVisibleBytes.completedItemBytes !== completedItemByteTotal ||
    parsedModelVisibleBytes.totalBytes !== parsedModelVisibleBytes.promptBytes + completedItemByteTotal
  ) {
    invalid('attribution model-visible bytes do not reconcile');
  }
  const postSufficientEvidence = !hasPostSufficientEvidence
    ? undefined
    : attribution.postSufficientEvidence === null
      ? null
      : parsePostSufficientEvidence(attribution.postSufficientEvidence);
  return {
    completedItemBytes: {
      agentMessage: nonNegativeInteger(completedItemBytes.agentMessage, 'agent message bytes'),
      commandExecution: nonNegativeInteger(completedItemBytes.commandExecution, 'command bytes'),
      fileChange: nonNegativeInteger(completedItemBytes.fileChange, 'file change bytes'),
      mcpToolCall: nonNegativeInteger(completedItemBytes.mcpToolCall, 'MCP bytes'),
      other: nonNegativeInteger(completedItemBytes.other, 'other completed item bytes'),
      reasoning: nonNegativeInteger(completedItemBytes.reasoning, 'reasoning bytes'),
    },
    firstSufficientEvidenceMilliseconds:
      attribution.firstSufficientEvidenceMilliseconds === null
        ? null
        : nonNegativeInteger(attribution.firstSufficientEvidenceMilliseconds, 'attribution sufficient evidence time'),
    graphRequests: array(attribution.graphRequests, 'graph request receipts').map((request, index) =>
      parseGraphRequestReceipt(request, index),
    ),
    ...(hasInitialContinuationEvidenceState
      ? {
          initialContinuationEvidenceState: literal(
            attribution.initialContinuationEvidenceState,
            ['background', 'evidence-bearing'] as const,
            'initial continuation evidence state',
          ),
        }
      : {}),
    lastTwoModelCallTokens,
    modelCallCount,
    modelCalls,
    modelVisibleBytes: parsedModelVisibleBytes,
    ...(postSufficientEvidence === undefined ? {} : {postSufficientEvidence}),
    repeatedToolCalls: {
      commandExecution: nonNegativeInteger(repeatedToolCalls.commandExecution, 'repeated command calls'),
      contextBrief: nonNegativeInteger(repeatedToolCalls.contextBrief, 'repeated context brief calls'),
      fileChange: nonNegativeInteger(repeatedToolCalls.fileChange, 'repeated file changes'),
      inspectCodeGraph: nonNegativeInteger(repeatedToolCalls.inspectCodeGraph, 'repeated graph calls'),
      readContext: nonNegativeInteger(repeatedToolCalls.readContext, 'repeated context reads'),
      recallContext: nonNegativeInteger(repeatedToolCalls.recallContext, 'repeated context recalls'),
    },
    tokens,
  };
}

function parsePostSufficientEvidence(
  value: unknown,
): NonNullable<MatchedEvaluationAttributionV1['postSufficientEvidence']> {
  const observation = object(value, 'post-sufficient evidence attribution');
  exactKeys(
    observation,
    [
      'completedItemBytes',
      'completedItems',
      'commandExecutions',
      'declinedCommandExecutions',
      'fileChanges',
      'mcpToolCalls',
    ],
    'post-sufficient evidence attribution',
  );
  const commandExecutions = nonNegativeInteger(observation.commandExecutions, 'post-sufficient command executions');
  const declinedCommandExecutions = nonNegativeInteger(
    observation.declinedCommandExecutions,
    'post-sufficient declined command executions',
  );
  if (declinedCommandExecutions > commandExecutions) {
    invalid('post-sufficient declined commands exceed command executions');
  }
  return {
    completedItemBytes: nonNegativeInteger(observation.completedItemBytes, 'post-sufficient completed item bytes'),
    completedItems: nonNegativeInteger(observation.completedItems, 'post-sufficient completed items'),
    commandExecutions,
    declinedCommandExecutions,
    fileChanges: nonNegativeInteger(observation.fileChanges, 'post-sufficient file changes'),
    mcpToolCalls: nonNegativeInteger(observation.mcpToolCalls, 'post-sufficient MCP tool calls'),
  };
}

function parseGraphRequestReceipt(
  value: unknown,
  index: number,
): MatchedEvaluationAttributionV1['graphRequests'][number] {
  const receipt = object(value, `graph request receipt ${index}`);
  exactKeys(receipt, ['budgetTokens', 'edgeLimit', 'nodeLimit', 'operation'], `graph request receipt ${index}`);
  return {
    budgetTokens: nullableNonNegativeInteger(receipt.budgetTokens, `graph request ${index} budget`),
    edgeLimit: nullableNonNegativeInteger(receipt.edgeLimit, `graph request ${index} edge limit`),
    nodeLimit: nullableNonNegativeInteger(receipt.nodeLimit, `graph request ${index} node limit`),
    operation:
      receipt.operation === null ? null : boundedString(receipt.operation, 1, 64, `graph request ${index} operation`),
  };
}

function parseAttributionTokens(value: unknown, label: string): MatchedEvaluationTokenAccountingV1 {
  const tokens = object(value, label);
  exactKeys(
    tokens,
    [
      'cacheWriteTokens',
      'cachedInputTokens',
      'newTokens',
      'outputTokens',
      'processedTokens',
      'rawInputTokens',
      'reasoningOutputTokens',
      'totalTokens',
      'uncachedInputTokens',
    ],
    label,
  );
  const parsed = {
    cacheWriteTokens: nullableNonNegativeInteger(tokens.cacheWriteTokens, `${label} cache write tokens`),
    cachedInputTokens: nonNegativeInteger(tokens.cachedInputTokens, `${label} cached input tokens`),
    newTokens: nullableNonNegativeInteger(tokens.newTokens, `${label} new tokens`),
    outputTokens: nonNegativeInteger(tokens.outputTokens, `${label} output tokens`),
    processedTokens: nullableNonNegativeInteger(tokens.processedTokens, `${label} processed tokens`),
    rawInputTokens: nonNegativeInteger(tokens.rawInputTokens, `${label} raw input tokens`),
    reasoningOutputTokens: nonNegativeInteger(tokens.reasoningOutputTokens, `${label} reasoning output tokens`),
    totalTokens: nonNegativeInteger(tokens.totalTokens, `${label} total tokens`),
    uncachedInputTokens: nonNegativeInteger(tokens.uncachedInputTokens, `${label} uncached input tokens`),
  };
  if (
    parsed.cachedInputTokens > parsed.rawInputTokens ||
    parsed.reasoningOutputTokens > parsed.outputTokens ||
    parsed.uncachedInputTokens !== parsed.rawInputTokens - parsed.cachedInputTokens ||
    parsed.totalTokens !== parsed.rawInputTokens + parsed.outputTokens ||
    (parsed.cacheWriteTokens === null && (parsed.newTokens !== null || parsed.processedTokens !== null)) ||
    (parsed.cacheWriteTokens !== null &&
      (parsed.newTokens !== parsed.uncachedInputTokens + parsed.cacheWriteTokens + parsed.outputTokens ||
        parsed.processedTokens !== parsed.newTokens + parsed.cachedInputTokens))
  ) {
    invalid(`${label} components are inconsistent`);
  }
  return parsed;
}

function sameTokenAccounting(
  left: MatchedEvaluationTokenAccountingV1,
  right: MatchedEvaluationTokenAccountingV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type ReconciledTokenAccounting = Pick<
  MatchedEvaluationTokenAccountingV1,
  'cachedInputTokens' | 'outputTokens' | 'rawInputTokens' | 'reasoningOutputTokens' | 'totalTokens'
>;

const RECONCILED_TOKEN_FIELDS = [
  ['rawInputTokens', 'raw input tokens'],
  ['cachedInputTokens', 'cached input tokens'],
  ['outputTokens', 'output tokens'],
  ['reasoningOutputTokens', 'reasoning output tokens'],
  ['totalTokens', 'total tokens'],
] as const satisfies readonly (readonly [keyof ReconciledTokenAccounting, string])[];

function assertReconciledAttributionTokens(
  actual: ReconciledTokenAccounting,
  expected: ReconciledTokenAccounting,
  source: string,
): void {
  const mismatches = RECONCILED_TOKEN_FIELDS.flatMap(([field, label]) =>
    actual[field] === expected[field] ? [] : [label],
  );
  if (mismatches.length > 0) invalid(`attribution tokens differ from ${source}: ${mismatches.join(', ')}`);
}

function sumTokenAccounting(values: readonly MatchedEvaluationTokenAccountingV1[]): MatchedEvaluationTokenAccountingV1 {
  const sum = (
    key: keyof Omit<MatchedEvaluationTokenAccountingV1, 'cacheWriteTokens' | 'newTokens' | 'processedTokens'>,
  ) => values.reduce((total, value) => total + value[key], 0);
  const cacheWriteTokens = values.every(value => value.cacheWriteTokens !== null)
    ? values.reduce((total, value) => total + (value.cacheWriteTokens ?? 0), 0)
    : null;
  const rawInputTokens = sum('rawInputTokens');
  const cachedInputTokens = sum('cachedInputTokens');
  const outputTokens = sum('outputTokens');
  const uncachedInputTokens = rawInputTokens - cachedInputTokens;
  const newTokens = cacheWriteTokens === null ? null : uncachedInputTokens + cacheWriteTokens + outputTokens;
  return {
    cacheWriteTokens,
    cachedInputTokens,
    newTokens,
    outputTokens,
    processedTokens: newTokens === null ? null : newTokens + cachedInputTokens,
    rawInputTokens,
    reasoningOutputTokens: sum('reasoningOutputTokens'),
    totalTokens: sum('totalTokens'),
    uncachedInputTokens,
  };
}

function parseContextVerification(value: unknown): MatchedEvaluationContextVerificationV1 | null {
  if (value === null) return null;
  const context = object(value, 'context verification');
  exactKeys(
    context,
    ['graphReady', 'graphSnapshotHash', 'linkReceiptsHash', 'memoryAccess', 'studyHash', 'taskContextHash'],
    'context verification',
  );
  if (context.graphReady !== true) invalid('context verification graph must be ready');
  const memoryAccess = literal(context.memoryAccess, ['disabled', 'linked'] as const, 'context memory access');
  const linkReceiptsHash =
    context.linkReceiptsHash === null
      ? null
      : matchingString(context.linkReceiptsHash, HASH, 'context link receipts hash');
  const taskContextHash =
    context.taskContextHash === null ? null : matchingString(context.taskContextHash, HASH, 'context task hash');
  if (
    (memoryAccess === 'disabled' && (linkReceiptsHash !== null || taskContextHash !== null)) ||
    (memoryAccess === 'linked' && (linkReceiptsHash === null || taskContextHash === null))
  ) {
    invalid('context memory access and receipt fields disagree');
  }
  return {
    graphReady: true,
    graphSnapshotHash: matchingString(context.graphSnapshotHash, HASH, 'context graph snapshot hash'),
    linkReceiptsHash,
    memoryAccess,
    studyHash: matchingString(context.studyHash, HASH, 'context study hash'),
    taskContextHash,
  };
}

function parseProviderTokens(value: unknown): MatchedEvaluationProviderTokensV1 {
  const usage = object(value, 'provider token usage');
  exactKeys(
    usage,
    ['cachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'],
    'provider token usage',
  );
  const parsed = {
    cachedInputTokens: nonNegativeInteger(usage.cachedInputTokens, 'cached input tokens'),
    inputTokens: nonNegativeInteger(usage.inputTokens, 'input tokens'),
    outputTokens: nonNegativeInteger(usage.outputTokens, 'output tokens'),
    reasoningOutputTokens: nonNegativeInteger(usage.reasoningOutputTokens, 'reasoning output tokens'),
    totalTokens: nonNegativeInteger(usage.totalTokens, 'total tokens'),
  };
  if (
    parsed.cachedInputTokens > parsed.inputTokens ||
    parsed.reasoningOutputTokens > parsed.outputTokens ||
    parsed.totalTokens !== parsed.inputTokens + parsed.outputTokens
  ) {
    invalid('provider token components are inconsistent');
  }
  return parsed;
}

function boundedPair(
  value: unknown,
  totalKey: string,
  subsetKey: string,
  label: string,
): {readonly subset: number; readonly total: number} {
  const pair = object(value, `${label} metrics`);
  exactKeys(pair, [totalKey, subsetKey], `${label} metrics`);
  const total = nonNegativeInteger(pair[totalKey], `${label} total`);
  const subset = nonNegativeInteger(pair[subsetKey], `${label} subset`);
  if (subset > total) invalid(`${label} subset exceeds total`);
  return {subset, total};
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

function wilson95(successes: number, total: number): {readonly high: number; readonly low: number} {
  const z = 1.959963984540054;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (proportion + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((proportion * (1 - proportion)) / total + (z * z) / (4 * total * total))) / denominator;
  return {high: Math.min(1, center + margin), low: Math.max(0, center - margin)};
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

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  return value === null ? null : nonNegativeInteger(value, label);
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid matched evaluation run: ${message}.`);
}

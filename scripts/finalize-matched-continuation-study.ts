#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This local finalizer owns sealed evidence-file boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, resolve, sep} from 'node:path';
import {Effect} from 'effect';
import {
  createMatchedContinuationOutcomeV1,
  evaluateMatchedContinuationStudyV1,
  renderMatchedContinuationArticleEvidenceV1,
  type MatchedContinuationOutcomeV1,
} from '@threadnote/threadnote/evaluation/matched-continuation-report';
import {
  parseMatchedContinuationStudyRuntimeV1,
  parseMatchedContinuationStudyV1,
  type MatchedContinuationStudyV1,
  type MatchedContinuationVariant,
} from '@threadnote/threadnote/evaluation/matched-continuation-study';
import {
  parseMatchedEvaluationObservationV1,
  type MatchedEvaluationMetricsV1,
  type MatchedEvaluationProviderTokensV1,
} from '@threadnote/threadnote/evaluation/matched-evaluation-runner';
import {
  parseMatchedContinuationPhaseTwoVerificationReceiptV1,
  type MatchedEvaluationVerificationStatus,
  type MatchedContinuationPhaseTwoVerificationReceiptV1,
} from '@threadnote/threadnote/evaluation/matched-verification';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import {assertMatchedContinuationRuntimeFilesV1} from './matched-continuation-runtime-integrity.js';
import {
  MATCHED_EVALUATION_RUNTIME_VERSION,
  parseMatchedEvaluationContinuationPilotPlanV1,
  projectMatchedEvaluationContinuationSelectionCheckpointV1,
  type MatchedEvaluationContinuationPilotPlanV3,
  type MatchedEvaluationContinuationPilotPlanV4,
} from './run-matched-evaluation.js';

export const MATCHED_CONTINUATION_FINALIZATION_VERSION = 1 as const;

interface FinalizationOptions {
  readonly outputDirectory: string;
  readonly runtimePath: string;
  readonly studyPath: string;
}

export interface MatchedContinuationFinalizationArtifactsV1 {
  readonly articleEvidence: Uint8Array;
  readonly outcomeLedger: Uint8Array;
  readonly receipt: Uint8Array;
  readonly report: Uint8Array;
}

export interface ParsedCompletedAttempt {
  readonly artifactSha256: string;
  readonly metrics: MatchedEvaluationMetricsV1;
  readonly phaseTwoVerification: MatchedContinuationPhaseTwoVerificationReceiptV1;
  readonly rawArtifactPath: string;
  readonly requestPath: string;
  readonly requestSha256: string;
  readonly responsePath: string;
  readonly responseSha256: string;
  readonly runNonce: string;
  readonly runOrder: number;
  readonly status: 'completed';
  readonly taskId: string;
  readonly transcriptHash: string;
  readonly transcriptPath: string;
  readonly variant: MatchedContinuationVariant;
}

export interface ParsedFailedAttempt {
  readonly accountingStatus: 'retained-agent-checkpoint' | 'unavailable-before-checkpoint';
  readonly artifactSha256: string | null;
  readonly diagnostics: string;
  readonly providerUsage: MatchedEvaluationProviderTokensV1 | null;
  readonly rawArtifactPath: string;
  readonly requestPath: string;
  readonly requestSha256: string | null;
  readonly responsePath: string;
  readonly responseSha256: string | null;
  readonly runNonce: string;
  readonly runOrder: number;
  readonly status: 'failed';
  readonly taskId: string;
  readonly timing: {readonly agentTaskMilliseconds: number; readonly preparationMilliseconds: number} | null;
  readonly transcriptPath: string;
  readonly variant: MatchedContinuationVariant;
}

export interface ParsedVerificationUnavailableAttempt {
  readonly accountingStatus: 'retained-observation';
  readonly artifactSha256: string;
  readonly diagnostics: string;
  readonly metrics: MatchedEvaluationMetricsV1;
  readonly rawArtifactPath: string;
  readonly requestPath: string;
  readonly requestSha256: string;
  readonly responsePath: string;
  readonly responseSha256: string;
  readonly runNonce: string;
  readonly runOrder: number;
  readonly status: 'verification-unavailable';
  readonly taskId: string;
  readonly transcriptHash: string;
  readonly transcriptPath: string;
  readonly variant: MatchedContinuationVariant;
}

export type ParsedAttempt = ParsedCompletedAttempt | ParsedFailedAttempt | ParsedVerificationUnavailableAttempt;

export interface ParsedTaskReport {
  readonly attempts: readonly ParsedAttempt[];
  readonly phaseOne: {
    readonly accountingSource: 'sealed-phase-one';
    readonly elapsedMilliseconds: number;
    readonly providerTokens: MatchedEvaluationProviderTokensV1;
  };
  readonly sourceReportSha256: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const MAXIMUM_JSON_BYTES = 8 * 1_024 * 1_024;
const MAXIMUM_TRANSCRIPT_BYTES = 64 * 1_024 * 1_024;

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  yield* Effect.tryPromise({
    try: () => finalizeMatchedContinuationStudyFromFilesV1(options),
    catch: cause => ScriptError.make({message: 'Matched continuation study finalization stopped.', cause}),
  });
});

export async function finalizeMatchedContinuationStudyFromFilesV1(options: FinalizationOptions): Promise<void> {
  const [studyBytes, runtimeBytes] = await Promise.all([
    readBoundedRegularFile(options.studyPath, MAXIMUM_JSON_BYTES, 'continuation study'),
    readBoundedRegularFile(options.runtimePath, MAXIMUM_JSON_BYTES, 'continuation runtime'),
  ]);
  const study = parseMatchedContinuationStudyV1(parseJson(studyBytes, 'continuation study'));
  const runtime = parseMatchedContinuationStudyRuntimeV1(parseJson(runtimeBytes, 'continuation runtime'));
  await assertMatchedContinuationRuntimeFilesV1(study, runtime);

  const reports = new Map<string, ParsedTaskReport>();
  for (const task of runtime.tasks) {
    const planBytes = await readBoundedRegularFile(task.planPath, MAXIMUM_JSON_BYTES, `plan ${task.taskId}`);
    const plan = parseMatchedEvaluationContinuationPilotPlanV1(parseJson(planBytes, `plan ${task.taskId}`));
    if (plan.version !== 3 && plan.version !== 4) {
      throw new Error(`Continuation plan ${task.taskId} must use version 3 or 4.`);
    }
    const reportPath = resolve(task.pilotDirectory, 'continuation-pilot-report.json');
    const reportBytes = await readBoundedRegularFile(reportPath, MAXIMUM_JSON_BYTES, `report ${task.taskId}`);
    reports.set(
      task.taskId,
      await parseAndVerifyMatchedContinuationTaskReportV1({
        plan,
        reportInput: parseJson(reportBytes, `report ${task.taskId}`),
        sourceReportSha256: sha256(reportBytes),
        study,
      }),
    );
  }

  const outcomes = projectMatchedContinuationOutcomesV1({reports, study});
  const report = evaluateMatchedContinuationStudyV1({outcomes, study});
  const ledgerBytes = Buffer.from(`${outcomes.map(outcome => JSON.stringify(outcome)).join('\n')}\n`);
  const reportBytes = jsonBytes(report);
  const articleBytes = Buffer.from(renderMatchedContinuationArticleEvidenceV1(report));
  const receiptWithoutHash = {
    articleEvidenceSha256: sha256(articleBytes),
    outcomeLedgerSha256: sha256(ledgerBytes),
    reportSha256: sha256(reportBytes),
    sourceReports: study.tasks.map(task => ({
      sourceReportSha256: required(reports.get(task.taskId), `task report ${task.taskId}`).sourceReportSha256,
      taskId: task.taskId,
    })),
    studyHash: study.studyHash,
    version: MATCHED_CONTINUATION_FINALIZATION_VERSION,
  };
  const receipt = {
    ...receiptWithoutHash,
    receiptHash: sha256(Buffer.from(`matched-continuation-finalization-v1\0${JSON.stringify(receiptWithoutHash)}\n`)),
  };

  await publishMatchedContinuationFinalizationV1(options.outputDirectory, {
    articleEvidence: articleBytes,
    outcomeLedger: ledgerBytes,
    receipt: jsonBytes(receipt),
    report: reportBytes,
  });
  process.stdout.write(
    `${JSON.stringify({outcomeCount: outcomes.length, outputDirectory: options.outputDirectory, reportHash: report.reportHash, studyHash: study.studyHash, version: 1})}\n`,
  );
}

export function projectMatchedContinuationOutcomesV1(input: {
  readonly reports: ReadonlyMap<string, ParsedTaskReport>;
  readonly study: MatchedContinuationStudyV1 | unknown;
}): readonly MatchedContinuationOutcomeV1[] {
  const study = parseMatchedContinuationStudyV1(input.study);
  let previousOutcomeHash: string | null = null;
  return study.schedule.map(scheduled => {
    const task = required(
      study.tasks.find(candidate => candidate.taskId === scheduled.taskId),
      scheduled.taskId,
    );
    const report = required(input.reports.get(scheduled.taskId), `task report ${scheduled.taskId}`);
    const attempt = required(
      report.attempts.find(candidate => candidate.runNonce === scheduled.runNonce),
      `scheduled attempt ${scheduled.runNonce}`,
    );
    if (
      attempt.taskId !== scheduled.taskId ||
      attempt.variant !== scheduled.variant ||
      attempt.runOrder !== scheduled.withinTaskRunOrder
    ) {
      throw new Error(`Continuation attempt ${scheduled.runNonce} differs from the sealed schedule.`);
    }
    const runtimeTask = createMatchedContinuationOutcomeV1({
      assessment:
        attempt.status === 'completed'
          ? {
              authorizationLeaks: attempt.metrics.safety.authorizationLeaks,
              blockedActions: attempt.metrics.safety.blockedActions,
              correctnessScoreMilli: attempt.metrics.correctness.scoreMilli,
              deterministicVerified: matchedContinuationDeterministicallyVerifiedV1({
                heldOutStatus: attempt.metrics.verification!.status,
                phaseTwoStatus: attempt.phaseTwoVerification.status,
              }),
              falseCurrentOutcomes: attempt.metrics.drift.falseCurrentOutcomes,
              harmfulActions: attempt.metrics.safety.harmfulActions,
              judgeCompleted: attempt.metrics.correctness.judgeCompleted,
              valid: attempt.metrics.validity.valid,
            }
          : null,
      clusterId: task.clusterId,
      evidence: {
        artifactSha256: attempt.artifactSha256,
        requestSha256: attempt.requestSha256,
        responseSha256: attempt.responseSha256,
        sourceReportSha256: report.sourceReportSha256,
        transcriptHash: attempt.status === 'failed' ? null : attempt.transcriptHash,
      },
      globalRunOrder: scheduled.globalRunOrder,
      phaseOne: report.phaseOne,
      phaseTwo:
        attempt.status === 'completed'
          ? {
              accountingSource: 'observation',
              elapsedMilliseconds:
                attempt.metrics.timing.endToEndMilliseconds + attempt.phaseTwoVerification.durationMilliseconds,
              providerTokens: attempt.metrics.usage.providerTokens,
            }
          : attempt.status === 'verification-unavailable'
            ? {
                accountingSource: 'verification-unavailable',
                elapsedMilliseconds: attempt.metrics.timing.endToEndMilliseconds,
                providerTokens: attempt.metrics.usage.providerTokens,
              }
            : {
                accountingSource: attempt.providerUsage === null ? 'unavailable' : 'failure-checkpoint',
                elapsedMilliseconds:
                  attempt.timing === null
                    ? null
                    : attempt.timing.agentTaskMilliseconds + attempt.timing.preparationMilliseconds,
                providerTokens: attempt.providerUsage,
              },
      planSha256: task.planSha256,
      previousOutcomeHash,
      runNonce: scheduled.runNonce,
      status: attempt.status === 'verification-unavailable' ? 'unavailable' : attempt.status,
      studyHash: study.studyHash,
      taskId: scheduled.taskId,
      underlyingArm: underlyingArm(scheduled.variant),
      variant: scheduled.variant,
      withinTaskRunOrder: scheduled.withinTaskRunOrder,
    });
    previousOutcomeHash = runtimeTask.outcomeHash;
    return runtimeTask;
  });
}

export function matchedContinuationDeterministicallyVerifiedV1(input: {
  readonly heldOutStatus: MatchedEvaluationVerificationStatus;
  readonly phaseTwoStatus: MatchedEvaluationVerificationStatus;
}): boolean {
  return input.heldOutStatus === 'passed' && input.phaseTwoStatus === 'passed';
}

export async function parseAndVerifyMatchedContinuationTaskReportV1(input: {
  readonly plan: MatchedEvaluationContinuationPilotPlanV3 | MatchedEvaluationContinuationPilotPlanV4;
  readonly reportInput: unknown;
  readonly sourceReportSha256: string;
  readonly study: MatchedContinuationStudyV1;
}): Promise<ParsedTaskReport> {
  const report = object(input.reportInput, `report ${input.plan.taskId}`);
  exactKeys(report, [
    'attempts',
    'candidate',
    'checkpoint',
    'completed',
    'completionMeaning',
    'comparativeClaimsEligible',
    'identities',
    'limitations',
    'phaseTwoPromptSha256',
    'phaseTwoVerificationPlanHash',
    'planVersion',
    'rows',
    'sourceTask',
    'taskId',
    'version',
  ]);
  if (
    report.version !== 2 ||
    (report.planVersion !== 3 && report.planVersion !== 4) ||
    report.planVersion !== input.plan.version ||
    report.comparativeClaimsEligible !== false
  ) {
    invalid('task report identity is invalid');
  }
  if (report.taskId !== input.plan.taskId) invalid('task report refers to a different task');
  if (!sameJson(report.candidate, input.plan.candidate)) invalid('task report candidate differs from its plan');
  if (!sameJson(report.checkpoint, projectMatchedEvaluationContinuationSelectionCheckpointV1(input.plan))) {
    invalid('task report checkpoint differs from its plan');
  }
  if (report.phaseTwoPromptSha256 !== input.plan.phaseTwoPromptSha256) {
    invalid('task report phase-two prompt differs from its plan');
  }
  if (report.phaseTwoVerificationPlanHash !== input.plan.phaseTwoVerification.planHash) {
    invalid('task report phase-two verification plan differs from its plan');
  }
  const expectedSourceTask = {
    promptSha256: input.plan.sourceTask.promptSha256,
    repositoryFixtureHash: input.plan.sourceTask.repositoryFixtureHash,
    repositoryRevision: input.plan.sourceTask.repositoryRevision,
    taskId: input.plan.sourceTask.taskId,
  };
  if (!sameJson(report.sourceTask, expectedSourceTask)) invalid('task report source task differs from its plan');
  const identities = object(report.identities, 'task report identities');
  exactKeys(identities, ['manifestHash', 'planFileHash', 'runtimeVersion', 'studyHash', 'verificationPlanHash']);
  const sealedTask = required(
    input.study.tasks.find(task => task.taskId === input.plan.taskId),
    input.plan.taskId,
  );
  if (
    identities.manifestHash !== input.study.sourceEvidence.manifestHash ||
    identities.planFileHash !== sealedTask.planSha256 ||
    identities.studyHash !== input.study.sourceEvidence.matchedStudyHash ||
    identities.verificationPlanHash !== input.study.sourceEvidence.verificationPlanHash ||
    identities.runtimeVersion !== MATCHED_EVALUATION_RUNTIME_VERSION
  ) {
    invalid('task report identities differ from the sealed study');
  }
  boundedString(report.completionMeaning, 1, 2_048, 'task report completion meaning');
  array(report.limitations, 'task report limitations').forEach((entry, index) =>
    boundedString(entry, 1, 2_048, `task report limitation ${index}`),
  );
  const expectedRows = input.plan.attempts.map(attempt => ({
    arm: underlyingArm(attempt.variant),
    blindLabel: attempt.blindLabel,
    position: attempt.runOrder,
    repetition: 1,
    runNonce: attempt.runNonce,
    runOrder: attempt.runOrder,
    taskId: input.plan.taskId,
    variant: attempt.variant,
  }));
  if (!sameJson(report.rows, expectedRows)) invalid('task report rows differ from its plan');
  const attempts = array(report.attempts, 'task report attempts').map((attempt, index) =>
    parseAttempt(attempt, index, input.plan),
  );
  if (attempts.length !== input.plan.attempts.length) {
    invalid('task report is partial; every planned terminal attempt is required');
  }
  for (const planned of input.plan.attempts) {
    const attempt = attempts.find(candidate => candidate.runNonce === planned.runNonce);
    if (
      attempt === undefined ||
      attempt.taskId !== input.plan.taskId ||
      attempt.variant !== planned.variant ||
      attempt.runOrder !== planned.runOrder
    ) {
      invalid(`task report attempt ${planned.runNonce} differs from its plan`);
    }
    if (
      attempt.status === 'completed' &&
      (attempt.metrics.verification?.taskId !== input.plan.taskId ||
        attempt.metrics.verification.artifactHash !== attempt.artifactSha256 ||
        attempt.metrics.verification.planHash !== input.study.sourceEvidence.verificationPlanHash ||
        attempt.phaseTwoVerification.planHash !== input.plan.phaseTwoVerification.planHash)
    ) {
      invalid(`task report attempt ${planned.runNonce} verification differs from sealed evidence`);
    }
  }
  if (new Set(attempts.map(attempt => attempt.runNonce)).size !== attempts.length) {
    invalid('task report attempt nonces must be unique');
  }
  if (report.completed !== attempts.every(attempt => attempt.status === 'completed')) {
    invalid('task report completion flag differs from its attempts');
  }
  const phaseOneProviderTokens = input.plan.checkpoint.phaseOneAccounting.providerTokens;
  if (phaseOneProviderTokens === null) {
    invalid('task report plan lacks required measured phase-one usage');
  }
  await Promise.all(attempts.map(verifyAttemptEvidence));
  return {
    attempts,
    phaseOne: {
      accountingSource: 'sealed-phase-one',
      elapsedMilliseconds: input.plan.checkpoint.phaseOneAccounting.elapsedMilliseconds,
      providerTokens: phaseOneProviderTokens,
    },
    sourceReportSha256: input.sourceReportSha256,
  };
}

function parseAttempt(
  value: unknown,
  index: number,
  plan: MatchedEvaluationContinuationPilotPlanV3 | MatchedEvaluationContinuationPilotPlanV4,
): ParsedAttempt {
  const attempt = object(value, `task report attempt ${index}`);
  const status = literal(
    attempt.status,
    ['completed', 'failed', 'verification-unavailable'] as const,
    `attempt ${index} status`,
  );
  if (status === 'completed') {
    exactKeys(attempt, [
      'arm',
      'artifactSha256',
      'checkpointPath',
      'metrics',
      'phaseTwoVerification',
      'rawArtifactPath',
      'requestPath',
      'requestSha256',
      'responsePath',
      'responseSha256',
      'runNonce',
      'runOrder',
      'status',
      'taskId',
      'transcriptHash',
      'transcriptPath',
      'variant',
    ]);
    const artifactSha256 = matching(attempt.artifactSha256, HASH, `attempt ${index} artifact hash`);
    const transcriptHash = matching(attempt.transcriptHash, HASH, `attempt ${index} transcript hash`);
    const observation = parseMatchedEvaluationObservationV1({
      artifactHash: artifactSha256,
      metrics: attempt.metrics,
      transcriptHash,
      version: 5,
    });
    if (observation.metrics.verification === null) invalid(`attempt ${index} lacks deterministic verification`);
    const phaseTwoVerification = parseMatchedContinuationPhaseTwoVerificationReceiptV1({
      artifactHash: artifactSha256,
      plan: plan.phaseTwoVerification,
      receipt: attempt.phaseTwoVerification,
    });
    const variant = continuationVariant(attempt.variant, `attempt ${index} variant`);
    if (attempt.arm !== underlyingArm(variant)) invalid(`attempt ${index} arm differs from its variant`);
    absolutePath(attempt.checkpointPath, `attempt ${index} checkpoint path`);
    return {
      artifactSha256,
      metrics: observation.metrics,
      phaseTwoVerification,
      rawArtifactPath: absolutePath(attempt.rawArtifactPath, `attempt ${index} artifact path`),
      requestPath: absolutePath(attempt.requestPath, `attempt ${index} request path`),
      requestSha256: matching(attempt.requestSha256, HASH, `attempt ${index} request hash`),
      responsePath: absolutePath(attempt.responsePath, `attempt ${index} response path`),
      responseSha256: matching(attempt.responseSha256, HASH, `attempt ${index} response hash`),
      runNonce: matching(attempt.runNonce, /^run_[0-9a-f]{32}$/u, `attempt ${index} nonce`),
      runOrder: integer(attempt.runOrder, 1, 5, `attempt ${index} order`),
      status,
      taskId: matching(attempt.taskId, /^tsk_[0-9a-f]{16,64}$/u, `attempt ${index} task id`),
      transcriptHash,
      transcriptPath: absolutePath(attempt.transcriptPath, `attempt ${index} transcript path`),
      variant,
    };
  }
  if (status === 'verification-unavailable') {
    exactKeys(attempt, [
      'accountingStatus',
      'arm',
      'artifactSha256',
      'checkpointPath',
      'diagnostics',
      'metrics',
      'phaseTwoVerification',
      'rawArtifactPath',
      'requestPath',
      'requestSha256',
      'responsePath',
      'responseSha256',
      'runNonce',
      'runOrder',
      'status',
      'taskId',
      'transcriptHash',
      'transcriptPath',
      'variant',
    ]);
    if (attempt.accountingStatus !== 'retained-observation' || attempt.phaseTwoVerification !== null) {
      invalid(`verification-unavailable attempt ${index} has invalid accounting or verification evidence`);
    }
    const artifactSha256 = matching(attempt.artifactSha256, HASH, `attempt ${index} artifact hash`);
    const transcriptHash = matching(attempt.transcriptHash, HASH, `attempt ${index} transcript hash`);
    const observation = parseMatchedEvaluationObservationV1({
      artifactHash: artifactSha256,
      metrics: attempt.metrics,
      transcriptHash,
      version: 5,
    });
    if (observation.metrics.usage.providerTokens === null) {
      invalid(`verification-unavailable attempt ${index} lacks measured provider usage`);
    }
    const variant = continuationVariant(attempt.variant, `attempt ${index} variant`);
    if (attempt.arm !== underlyingArm(variant)) invalid(`attempt ${index} arm differs from its variant`);
    absolutePath(attempt.checkpointPath, `attempt ${index} checkpoint path`);
    return {
      accountingStatus: 'retained-observation',
      artifactSha256,
      diagnostics: boundedString(attempt.diagnostics, 1, 2_048, `attempt ${index} diagnostics`),
      metrics: observation.metrics,
      rawArtifactPath: absolutePath(attempt.rawArtifactPath, `attempt ${index} artifact path`),
      requestPath: absolutePath(attempt.requestPath, `attempt ${index} request path`),
      requestSha256: matching(attempt.requestSha256, HASH, `attempt ${index} request hash`),
      responsePath: absolutePath(attempt.responsePath, `attempt ${index} response path`),
      responseSha256: matching(attempt.responseSha256, HASH, `attempt ${index} response hash`),
      runNonce: matching(attempt.runNonce, /^run_[0-9a-f]{32}$/u, `attempt ${index} nonce`),
      runOrder: integer(attempt.runOrder, 1, 5, `attempt ${index} order`),
      status,
      taskId: matching(attempt.taskId, /^tsk_[0-9a-f]{16,64}$/u, `attempt ${index} task id`),
      transcriptHash,
      transcriptPath: absolutePath(attempt.transcriptPath, `attempt ${index} transcript path`),
      variant,
    };
  }
  exactKeys(attempt, [
    'accountingStatus',
    'arm',
    'artifactSha256',
    'checkpointPath',
    'diagnostics',
    'metrics',
    'providerUsage',
    'rawArtifactPath',
    'requestPath',
    'requestSha256',
    'responsePath',
    'responseSha256',
    'runNonce',
    'runOrder',
    'status',
    'taskId',
    'timing',
    'transcriptPath',
    'variant',
  ]);
  if (attempt.metrics !== null) invalid(`failed attempt ${index} must not contain metrics`);
  const accountingStatus = literal(
    attempt.accountingStatus,
    ['retained-agent-checkpoint', 'unavailable-before-checkpoint'] as const,
    `attempt ${index} accounting status`,
  );
  const providerUsage =
    attempt.providerUsage === null ? null : providerTokens(attempt.providerUsage, `attempt ${index} provider usage`);
  const timing = attempt.timing === null ? null : failureTiming(attempt.timing, `attempt ${index} timing`);
  if (
    (accountingStatus === 'retained-agent-checkpoint') !== (providerUsage !== null && timing !== null) ||
    (providerUsage === null) !== (timing === null)
  ) {
    invalid(`failed attempt ${index} accounting status differs from retained accounting`);
  }
  const variant = continuationVariant(attempt.variant, `attempt ${index} variant`);
  if (attempt.arm !== underlyingArm(variant)) invalid(`attempt ${index} arm differs from its variant`);
  absolutePath(attempt.checkpointPath, `attempt ${index} checkpoint path`);
  return {
    accountingStatus,
    artifactSha256: nullableHash(attempt.artifactSha256, `attempt ${index} artifact hash`),
    diagnostics: boundedString(attempt.diagnostics, 1, 2_048, `attempt ${index} diagnostics`),
    providerUsage,
    rawArtifactPath: absolutePath(attempt.rawArtifactPath, `attempt ${index} artifact path`),
    requestPath: absolutePath(attempt.requestPath, `attempt ${index} request path`),
    requestSha256: nullableHash(attempt.requestSha256, `attempt ${index} request hash`),
    responsePath: absolutePath(attempt.responsePath, `attempt ${index} response path`),
    responseSha256: nullableHash(attempt.responseSha256, `attempt ${index} response hash`),
    runNonce: matching(attempt.runNonce, /^run_[0-9a-f]{32}$/u, `attempt ${index} nonce`),
    runOrder: integer(attempt.runOrder, 1, 5, `attempt ${index} order`),
    status,
    taskId: matching(attempt.taskId, /^tsk_[0-9a-f]{16,64}$/u, `attempt ${index} task id`),
    timing,
    transcriptPath: absolutePath(attempt.transcriptPath, `attempt ${index} transcript path`),
    variant,
  };
}

async function verifyAttemptEvidence(attempt: ParsedAttempt): Promise<void> {
  const checks: Promise<void>[] = [];
  for (const [path, expected, maximumBytes, label] of [
    [attempt.requestPath, attempt.requestSha256, MAXIMUM_JSON_BYTES, 'request'],
    [attempt.responsePath, attempt.responseSha256, MAXIMUM_JSON_BYTES, 'response'],
    [attempt.rawArtifactPath, attempt.artifactSha256, MAXIMUM_JSON_BYTES, 'artifact'],
    [
      attempt.transcriptPath,
      attempt.status === 'failed' ? null : attempt.transcriptHash,
      MAXIMUM_TRANSCRIPT_BYTES,
      'transcript',
    ],
  ] as const) {
    if (expected !== null) {
      checks.push(
        readBoundedRegularFile(path, maximumBytes, `${attempt.runNonce} ${label}`).then(bytes => {
          if (sha256(bytes) !== expected) throw new Error(`${attempt.runNonce} ${label} differs from its report hash.`);
        }),
      );
    }
  }
  await Promise.all(checks);
}

function underlyingArm(variant: MatchedContinuationVariant): 'files' | 'threadnote-graph' | 'threadnote-compact' {
  switch (variant) {
    case 'files-bare':
    case 'manual-handoff':
      return 'files';
    case 'threadnote-graph':
      return 'threadnote-graph';
    case 'threadnote-resume':
    case 'threadnote-preloaded-resume':
      return 'threadnote-compact';
  }
}

function continuationVariant(value: unknown, label: string): MatchedContinuationVariant {
  return literal(
    value,
    ['files-bare', 'manual-handoff', 'threadnote-graph', 'threadnote-resume', 'threadnote-preloaded-resume'] as const,
    label,
  );
}

function providerTokens(value: unknown, label: string): MatchedEvaluationProviderTokensV1 {
  const tokens = object(value, label);
  exactKeys(tokens, ['cachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']);
  const parsed = {
    cachedInputTokens: integer(tokens.cachedInputTokens, 0, 10_000_000, `${label} cached input tokens`),
    inputTokens: integer(tokens.inputTokens, 0, 10_000_000, `${label} input tokens`),
    outputTokens: integer(tokens.outputTokens, 0, 10_000_000, `${label} output tokens`),
    reasoningOutputTokens: integer(tokens.reasoningOutputTokens, 0, 10_000_000, `${label} reasoning output tokens`),
    totalTokens: integer(tokens.totalTokens, 0, 10_000_000, `${label} total tokens`),
  };
  if (
    parsed.cachedInputTokens > parsed.inputTokens ||
    parsed.reasoningOutputTokens > parsed.outputTokens ||
    parsed.totalTokens !== parsed.inputTokens + parsed.outputTokens
  ) {
    invalid(`${label} components are inconsistent`);
  }
  return parsed;
}

function failureTiming(value: unknown, label: string) {
  const timing = object(value, label);
  exactKeys(timing, ['agentTaskMilliseconds', 'preparationMilliseconds']);
  return {
    agentTaskMilliseconds: integer(timing.agentTaskMilliseconds, 0, 86_400_000, `${label} agent task`),
    preparationMilliseconds: integer(timing.preparationMilliseconds, 0, 86_400_000, `${label} preparation`),
  };
}

function parseArguments(args: readonly string[]): FinalizationOptions {
  const values = new Map<string, string>();
  const allowed = new Set(['--output', '--runtime', '--study']);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowed.has(option) || values.has(option)) throw new Error(`Unknown or repeated option: ${option}`);
    values.set(option, required(args[++index], option));
  }
  return {
    outputDirectory: absolutePath(required(values.get('--output'), '--output'), '--output'),
    runtimePath: absolutePath(required(values.get('--runtime'), '--runtime'), '--runtime'),
    studyPath: absolutePath(required(values.get('--study'), '--study'), '--study'),
  };
}

export async function publishMatchedContinuationFinalizationV1(
  path: string,
  artifacts: MatchedContinuationFinalizationArtifactsV1,
): Promise<void> {
  if (!path.split(sep).includes('.context'))
    throw new Error('Continuation output must be inside a .context directory.');
  const parent = dirname(path);
  await mkdir(parent, {recursive: true, mode: 0o700});
  if ((await realpath(parent)) !== parent) throw new Error('Continuation output parent must be canonical.');
  if (await pathExists(path)) throw new Error('Continuation output already exists; overwrite is not allowed.');
  const staging = `${path}.staging-${process.pid}-${randomUUID()}`;
  await mkdir(staging, {mode: 0o700});
  let published = false;
  try {
    await Promise.all([
      atomicWrite(resolve(staging, 'continuation-outcomes.jsonl'), artifacts.outcomeLedger),
      atomicWrite(resolve(staging, 'continuation-report.json'), artifacts.report),
      atomicWrite(resolve(staging, 'continuation-article-evidence.md'), artifacts.articleEvidence),
    ]);
    await atomicWrite(resolve(staging, 'continuation-finalization-receipt.json'), artifacts.receipt);
    await rename(staging, path);
    published = true;
  } finally {
    if (!published) await rm(staging, {force: true, recursive: true});
  }
}

async function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) {
    throw new Error(`${label} must be one bounded regular non-linked file.`);
  }
  if ((await realpath(path)) !== path) throw new Error(`${label} must use its canonical path.`);
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ino !== metadata.ino) {
    throw new Error(`${label} changed while it was read.`);
  }
  return bytes;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
  await rename(temporary, path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if ((cause as {code?: string}).code === 'ENOENT') return false;
    throw cause;
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error(`${label} is not valid JSON.`, {cause});
  }
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid('object contains unsupported or missing fields');
  }
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : matching(value, HASH, label);
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  const text = boundedString(value, 1, 4_096, label);
  if (!pattern.test(text)) invalid(`${label} is invalid`);
  return text;
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedString(value, 1, 4_096, label);
  if (!isAbsolute(path)) invalid(`${label} must be absolute`);
  return resolve(path);
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    invalid(`${label} is invalid`);
  return Number(value);
}

function literal<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid(`${label} is invalid`);
  return value;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null || value === '') throw new Error(`Missing ${label}.`);
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid matched continuation finalization: ${message}.`);
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));

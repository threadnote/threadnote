#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This local sealer owns reviewed evidence-file boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, rename, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {Effect} from 'effect';
import {
  createMatchedContinuationStudyV1,
  MATCHED_CONTINUATION_VARIANTS,
  parseMatchedContinuationStudyRuntimeV1,
  type MatchedContinuationStudyRuntimeV1,
} from '@threadnote/threadnote/evaluation/matched-continuation-study';
import {
  matchedEvaluationCorpusHashV1,
  parseMatchedEvaluationCorpusV1,
  parseMatchedEvaluationManifestV1,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {parseMatchedTokenEfficiencyStudyV1} from '@threadnote/threadnote/evaluation/matched-token-efficiency';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import {
  assertMatchedEvaluationContinuationAdapterConfigurationsV2,
  continuationCheckpointStudyV2,
  parseMatchedEvaluationContinuationPilotPlanV1,
  parseMatchedEvaluationRuntimeV1,
} from './run-matched-evaluation.js';
import {assertMatchedContinuationRuntimeFilesV1} from './matched-continuation-runtime-integrity.js';
import {assertMatchedEvaluationRepositoryV1} from './matched-evaluation-runtime-integrity.js';

export const MATCHED_CONTINUATION_PREPARATION_VERSION = 1 as const;

interface MatchedContinuationPreparationPlanV1 {
  readonly bootstrap: {
    readonly confidenceLevelBasisPoints: 9500;
    readonly iterations: number;
    readonly seed: string;
  };
  readonly gates: {
    readonly completionNonInferiorityBasisPoints: number;
    readonly maximumAuthorizationLeaks: number;
    readonly maximumFalseCurrentOutcomes: number;
    readonly maximumHarmfulActions: number;
    readonly minimumClusters: number;
    readonly minimumCorrectnessScoreMilli: number;
    readonly minimumTokenReductionBasisPoints: number;
  };
  readonly sourceCommit: string;
  readonly studyId: string;
  readonly exposureAuditPath: string;
  readonly tasks: readonly {
    readonly clusterId: string;
    readonly pilotDirectory: string;
    readonly planPath: string;
    readonly runtimePath: string;
  }[];
  readonly version: typeof MATCHED_CONTINUATION_PREPARATION_VERSION;
}

interface PreparationOptions {
  readonly adapterPath: string;
  readonly corpusPath: string;
  readonly manifestPath: string;
  readonly matchedRuntimePath: string;
  readonly matchedPreparationReceiptPath: string;
  readonly matchedStudyPath: string;
  readonly outputDirectory: string;
  readonly preparationPlanPath: string;
}

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  yield* Effect.tryPromise({
    try: () => prepareMatchedContinuationStudyFromFilesV1(options),
    catch: cause => ScriptError.make({message: 'Matched continuation study preparation stopped.', cause}),
  });
});

export async function prepareMatchedContinuationStudyFromFilesV1(options: PreparationOptions): Promise<void> {
  const qualificationReceiptPath = join(dirname(options.matchedPreparationReceiptPath), 'qualification-receipt.json');
  const [
    corpusBytes,
    manifestBytes,
    matchedPreparationReceiptBytes,
    qualificationReceiptBytes,
    matchedStudyBytes,
    matchedRuntimeBytes,
    preparationPlanBytes,
    adapterSha256,
  ] = await Promise.all([
    readBoundedRegularFile(options.corpusPath, 8 * 1_024 * 1_024, 'corpus'),
    readBoundedRegularFile(options.manifestPath, 8 * 1_024 * 1_024, 'manifest'),
    readBoundedRegularFile(options.matchedPreparationReceiptPath, 8 * 1_024 * 1_024, 'matched preparation receipt'),
    readBoundedRegularFile(qualificationReceiptPath, 8 * 1_024 * 1_024, 'qualification receipt'),
    readBoundedRegularFile(options.matchedStudyPath, 8 * 1_024 * 1_024, 'matched study'),
    readBoundedRegularFile(options.matchedRuntimePath, 8 * 1_024 * 1_024, 'matched runtime'),
    readBoundedRegularFile(options.preparationPlanPath, 8 * 1_024 * 1_024, 'continuation preparation plan'),
    sha256RegularFile(options.adapterPath, 256 * 1_024 * 1_024, 'continuation adapter'),
  ]);
  const corpus = parseMatchedEvaluationCorpusV1(parseJson(corpusBytes, 'corpus'));
  const manifest = parseMatchedEvaluationManifestV1(parseJson(manifestBytes, 'manifest'));
  const matchedStudy = parseMatchedTokenEfficiencyStudyV1(parseJson(matchedStudyBytes, 'matched study'));
  parseMatchedEvaluationRuntimeV1(parseJson(matchedRuntimeBytes, 'matched runtime'));
  const matchedPreparationReceipt = parseMatchedPreparationReceipt(
    parseJson(matchedPreparationReceiptBytes, 'matched preparation receipt'),
  );
  assertQualificationReceiptBindingV1(matchedPreparationReceipt, qualificationReceiptBytes);
  const preparation = parseMatchedContinuationPreparationPlanV1(
    parseJson(preparationPlanBytes, 'continuation preparation plan'),
  );
  const exposureAuditBytes = await readBoundedRegularFile(
    preparation.exposureAuditPath,
    8 * 1_024 * 1_024,
    'exposure audit',
  );
  const corpusHash = matchedEvaluationCorpusHashV1(corpus);
  if (manifest.corpusHash !== corpusHash) throw new Error('Continuation manifest refers to a different corpus.');
  if (matchedStudy.manifestHash !== manifest.manifestHash) {
    throw new Error('Continuation matched study refers to a different manifest.');
  }
  if (
    matchedPreparationReceipt.corpusHash !== corpusHash ||
    matchedPreparationReceipt.manifestHash !== manifest.manifestHash ||
    matchedPreparationReceipt.studyHash !== matchedStudy.studyHash ||
    matchedPreparationReceipt.verificationPlanHash !== matchedStudy.verificationPlanHash ||
    matchedPreparationReceipt.threadnoteSourceCommit !== preparation.sourceCommit
  ) {
    throw new Error('Continuation candidate differs from the matched preparation receipt.');
  }
  const compactArm = required(
    manifest.arms.find(arm => arm.arm === 'threadnote-compact'),
    'threadnote-compact arm',
  );
  const graphArm = required(
    manifest.arms.find(arm => arm.arm === 'threadnote-graph'),
    'threadnote-graph arm',
  );
  if (
    compactArm.tool.artifactHash === null ||
    compactArm.tool.artifactHash !== graphArm.tool.artifactHash ||
    compactArm.tool.version !== graphArm.tool.version
  ) {
    throw new Error('Continuation Threadnote arms do not share one pinned candidate.');
  }
  if (compactArm.adapterArtifactHash !== adapterSha256) {
    throw new Error('Continuation adapter bytes differ from the compact arm manifest attestation.');
  }
  if (
    matchedPreparationReceipt.adapterArtifactHash !== adapterSha256 ||
    matchedPreparationReceipt.threadnoteArtifactHash !== compactArm.tool.artifactHash
  ) {
    throw new Error('Continuation adapter or tool differs from the matched preparation receipt.');
  }

  const taskInputs = await Promise.all(
    preparation.tasks.map(async (entry, taskIndex) => {
      const [planBytes, taskRuntimeBytes] = await Promise.all([
        readBoundedRegularFile(entry.planPath, 8 * 1_024 * 1_024, `continuation plan ${taskIndex}`),
        readBoundedRegularFile(entry.runtimePath, 8 * 1_024 * 1_024, `continuation runtime ${taskIndex}`),
      ]);
      const plan = parseMatchedEvaluationContinuationPilotPlanV1(
        parseJson(planBytes, `continuation plan ${taskIndex}`),
      );
      const taskRuntime = parseMatchedEvaluationRuntimeV1(
        parseJson(taskRuntimeBytes, `continuation runtime ${taskIndex}`),
      );
      if (plan.version !== 3 && plan.version !== 4) {
        throw new Error(`Continuation plan ${taskIndex} must use the full-verification v3 or v4 contract.`);
      }
      await assertMatchedEvaluationContinuationAdapterConfigurationsV2({
        manifest,
        plan,
        planPath: entry.planPath,
        requiredArms: new Set(['threadnote-compact', 'threadnote-graph']),
        runtime: taskRuntime,
      });
      if (
        plan.candidate.toolArtifactHash !== compactArm.tool.artifactHash ||
        plan.candidate.toolVersion !== compactArm.tool.version
      ) {
        throw new Error(`Continuation plan ${taskIndex} uses a different candidate.`);
      }
      const corpusTask = required(
        corpus.tasks.find(task => task.taskId === plan.taskId),
        `corpus task ${plan.taskId}`,
      );
      const taskContext = required(
        matchedStudy.taskContexts.find(context => context.taskId === plan.taskId),
        `matched task context ${plan.taskId}`,
      );
      const cluster = required(
        matchedStudy.clusters.find(candidate => candidate.clusterId === entry.clusterId),
        `matched cluster ${entry.clusterId}`,
      );
      if (
        taskContext.clusterId !== cluster.clusterId ||
        !cluster.taskIds.includes(plan.taskId) ||
        plan.sourceTask.repositoryRevision !== cluster.revision ||
        plan.sourceTask.repositoryFixtureHash !== cluster.repositoryFixtureHash ||
        corpusTask.repositoryFixtureHash !== cluster.repositoryFixtureHash
      ) {
        throw new Error(`Continuation plan ${taskIndex} differs from its frozen source cluster.`);
      }
      continuationCheckpointStudyV2(matchedStudy, plan.sourceTask, plan.checkpoint);
      const runtimeRepository = required(
        taskRuntime.repositories.find(repository => repository.clusterId === entry.clusterId),
        `runtime repository ${entry.clusterId}`,
      );
      if (runtimeRepository.repositoryIdentityHash !== cluster.repositoryIdentityHash) {
        throw new Error(`Continuation runtime repository ${taskIndex} has a different identity.`);
      }
      await assertMatchedEvaluationRepositoryV1(runtimeRepository.repositoryDirectory, {
        dirty: false,
        fixtureHash: plan.checkpoint.repositoryFixtureHash,
        identityHash: cluster.repositoryIdentityHash,
        revision: plan.checkpoint.repositoryRevision,
      });
      return {entry, plan, planSha256: sha256(planBytes), cluster};
    }),
  );
  assertMatchedContinuationExposureAudit(
    parseJson(exposureAuditBytes, 'continuation exposure audit'),
    preparation.sourceCommit,
    taskInputs.map(({plan}) => plan.taskId),
  );
  const variants = MATCHED_CONTINUATION_VARIANTS.filter(variant =>
    taskInputs[0]?.plan.attempts.some(attempt => attempt.variant === variant),
  );

  let globalRunOrder = 0;
  const study = createMatchedContinuationStudyV1({
    bootstrap: preparation.bootstrap,
    candidate: {
      adapterArtifactSha256: adapterSha256,
      sourceCommit: preparation.sourceCommit,
      toolArtifactHash: compactArm.tool.artifactHash,
      toolVersion: compactArm.tool.version,
    },
    gates: preparation.gates,
    schedule: taskInputs.flatMap(({plan}) =>
      [...plan.attempts]
        .sort((left, right) => left.runOrder - right.runOrder)
        .map(attempt => ({
          globalRunOrder: (globalRunOrder += 1),
          runNonce: attempt.runNonce,
          taskId: plan.taskId,
          variant: attempt.variant,
          withinTaskRunOrder: attempt.runOrder,
        })),
    ),
    sourceEvidence: {
      corpusHash,
      exposureAuditSha256: sha256(exposureAuditBytes),
      manifestHash: manifest.manifestHash,
      matchedPreparationReceiptSha256: sha256(matchedPreparationReceiptBytes),
      matchedStudyHash: matchedStudy.studyHash,
      verificationPlanHash: matchedStudy.verificationPlanHash,
    },
    studyId: preparation.studyId,
    tasks: taskInputs.map(({cluster, plan, planSha256}) => ({
      checkpointRepositoryFixtureHash: plan.checkpoint.repositoryFixtureHash,
      checkpointRevision: plan.checkpoint.repositoryRevision,
      clusterId: cluster.clusterId,
      planSha256,
      repositoryUrl: cluster.repositoryUrl,
      sourceRepositoryFixtureHash: plan.sourceTask.repositoryFixtureHash,
      sourceRevision: plan.sourceTask.repositoryRevision,
      taskId: plan.taskId,
    })),
    variants,
    workflowAccounting: 'phase-one-plus-phase-two-per-attempt',
  });
  const runtime = parseMatchedContinuationStudyRuntimeV1({
    corpusPath: await canonicalRegularFile(options.corpusPath, 'corpus'),
    exposureAuditPath: await canonicalRegularFile(preparation.exposureAuditPath, 'exposure audit'),
    exposureAuditSha256: sha256(exposureAuditBytes),
    manifestPath: await canonicalRegularFile(options.manifestPath, 'manifest'),
    matchedPreparationReceiptPath: await canonicalRegularFile(
      options.matchedPreparationReceiptPath,
      'matched preparation receipt',
    ),
    matchedRuntimePath: await canonicalRegularFile(options.matchedRuntimePath, 'matched runtime'),
    matchedStudyPath: await canonicalRegularFile(options.matchedStudyPath, 'matched study'),
    studyHash: study.studyHash,
    tasks: taskInputs.map(({entry, plan, planSha256}) => ({
      pilotDirectory: entry.pilotDirectory,
      planPath: entry.planPath,
      planSha256,
      taskId: plan.taskId,
    })),
    version: 1,
  } satisfies MatchedContinuationStudyRuntimeV1);
  const receipt = {
    adapterArtifactSha256: adapterSha256,
    exposureAuditSha256: sha256(exposureAuditBytes),
    preparationPlanSha256: sha256(preparationPlanBytes),
    runtimeLocalOnly: true,
    runtimeSha256: sha256(jsonBytes(runtime)),
    studyHash: study.studyHash,
    studySha256: sha256(jsonBytes(study)),
    taskPlanSha256: Object.fromEntries(taskInputs.map(({plan, planSha256}) => [plan.taskId, planSha256])),
    version: MATCHED_CONTINUATION_PREPARATION_VERSION,
  };
  await assertMatchedContinuationRuntimeFilesV1(study, runtime);
  await ensureOutputDirectory(options.outputDirectory);
  await atomicWrite(join(options.outputDirectory, 'continuation-study.json'), jsonBytes(study));
  await atomicWrite(join(options.outputDirectory, 'continuation-runtime.json'), jsonBytes(runtime));
  await atomicWrite(join(options.outputDirectory, 'continuation-preparation-receipt.json'), jsonBytes(receipt));
  process.stdout.write(
    `${JSON.stringify({outputDirectory: options.outputDirectory, studyHash: study.studyHash, tasks: study.tasks.length})}\n`,
  );
}

export function assertMatchedContinuationExposureAudit(
  value: unknown,
  sourceCommit: string,
  taskIds: readonly string[],
): void {
  const audit = object(value, 'continuation exposure audit');
  if (audit.productFreezeCommit !== sourceCommit) {
    invalid('exposure audit product freeze commit differs from the candidate');
  }
  const tasks =
    audit.version === 1
      ? strictHeldOutTaskIds(audit)
      : audit.version === 2
        ? disclosedBenchmarkReuseTaskIds(audit)
        : invalid('exposure audit version must be 1 or 2');
  unique(tasks, 'continuation exposure audit task ids');
  const expected = [...taskIds].sort();
  const actual = [...tasks].sort();
  if (expected.length !== actual.length || expected.some((taskId, index) => taskId !== actual[index])) {
    invalid('exposure audit tasks do not exactly cover the continuation study');
  }
}

function strictHeldOutTaskIds(audit: Record<string, unknown>): readonly string[] {
  exactKeys(audit, ['productFreezeCommit', 'reviewedBeforeProviderOutcomes', 'tasks', 'version']);
  if (audit.reviewedBeforeProviderOutcomes !== true) {
    invalid('exposure audit must be reviewed before provider outcomes');
  }
  return array(audit.tasks, 'continuation exposure audit tasks').map((entry, index) => {
    const task = object(entry, `continuation exposure audit task ${index}`);
    exactKeys(task, ['priorProductImplementationExposure', 'priorProviderOutcomeExposure', 'taskId']);
    if (task.priorProductImplementationExposure !== false || task.priorProviderOutcomeExposure !== false) {
      invalid(`exposure audit task ${index} is not held out`);
    }
    return matching(task.taskId, /^tsk_[0-9a-f]{16,64}$/u, `exposure audit task ${index} id`);
  });
}

function disclosedBenchmarkReuseTaskIds(audit: Record<string, unknown>): readonly string[] {
  exactKeys(audit, [
    'benchmarkReuse',
    'productFreezeCommit',
    'reviewedBeforeCurrentProviderOutcomes',
    'tasks',
    'version',
  ]);
  if (audit.reviewedBeforeCurrentProviderOutcomes !== true) {
    invalid('benchmark-reuse audit must be reviewed before current provider outcomes');
  }
  const reuse = object(audit.benchmarkReuse, 'continuation benchmark reuse disclosure');
  exactKeys(reuse, [
    'freshRunNonces',
    'isolatedFreshSessions',
    'limitation',
    'priorOutcomesPooled',
    'taskSpecificProductTuning',
  ]);
  if (
    reuse.freshRunNonces !== true ||
    reuse.isolatedFreshSessions !== true ||
    reuse.priorOutcomesPooled !== false ||
    reuse.taskSpecificProductTuning !== false
  ) {
    invalid('benchmark reuse requires fresh isolation, no pooled outcomes, and no task-specific product tuning');
  }
  boundedText(reuse.limitation, 1, 2_048, 'benchmark reuse limitation');
  return array(audit.tasks, 'continuation exposure audit tasks').map((entry, index) => {
    const task = object(entry, `continuation exposure audit task ${index}`);
    exactKeys(task, ['priorProviderOutcomeExposure', 'taskId']);
    if (typeof task.priorProviderOutcomeExposure !== 'boolean') {
      invalid(`exposure audit task ${index} provider exposure must be boolean`);
    }
    return matching(task.taskId, /^tsk_[0-9a-f]{16,64}$/u, `exposure audit task ${index} id`);
  });
}

function parseMatchedPreparationReceipt(value: unknown): {
  readonly adapterArtifactHash: string;
  readonly corpusHash: string;
  readonly manifestHash: string;
  readonly qualificationReceiptSha256: string;
  readonly qualificationReceiptHash: string;
  readonly studyHash: string;
  readonly threadnoteArtifactHash: string;
  readonly threadnoteSourceCommit: string;
  readonly verificationPlanHash: string;
} {
  const receipt = object(value, 'matched preparation receipt');
  exactKeys(receipt, [
    'adapterArtifactHash',
    'adapterConfigurationHashes',
    'corpusHash',
    'manifestHash',
    'outputHashes',
    'receiptHash',
    'referenceArm',
    'requiredProductVersion',
    'productionRelease',
    'qualificationReceiptHash',
    'studyHash',
    'threadnoteArtifactHash',
    'threadnoteLockHash',
    'threadnoteSourceCommit',
    'verificationPlanHash',
    'version',
  ]);
  if (receipt.version !== 4) invalid('matched preparation receipt version must be 4');
  const receiptHash = matching(receipt.receiptHash, /^[0-9a-f]{64}$/u, 'matched preparation receipt hash');
  const receiptWithoutHash = {
    adapterArtifactHash: receipt.adapterArtifactHash,
    adapterConfigurationHashes: receipt.adapterConfigurationHashes,
    corpusHash: receipt.corpusHash,
    manifestHash: receipt.manifestHash,
    outputHashes: receipt.outputHashes,
    referenceArm: receipt.referenceArm,
    requiredProductVersion: receipt.requiredProductVersion,
    productionRelease: receipt.productionRelease,
    qualificationReceiptHash: receipt.qualificationReceiptHash,
    studyHash: receipt.studyHash,
    threadnoteArtifactHash: receipt.threadnoteArtifactHash,
    threadnoteLockHash: receipt.threadnoteLockHash,
    threadnoteSourceCommit: receipt.threadnoteSourceCommit,
    verificationPlanHash: receipt.verificationPlanHash,
    version: receipt.version,
  };
  if (receiptHash !== digest('matched-token-efficiency-preparation-receipt-v2', receiptWithoutHash)) {
    invalid('matched preparation receipt hash is invalid');
  }
  const outputHashes = object(receipt.outputHashes, 'matched preparation output hashes');
  return {
    adapterArtifactHash: matching(receipt.adapterArtifactHash, /^[0-9a-f]{64}$/u, 'receipt adapter hash'),
    corpusHash: matching(receipt.corpusHash, /^[0-9a-f]{64}$/u, 'receipt corpus hash'),
    manifestHash: matching(receipt.manifestHash, /^[0-9a-f]{64}$/u, 'receipt manifest hash'),
    qualificationReceiptSha256: matching(
      outputHashes['qualification-receipt.json'],
      /^[0-9a-f]{64}$/u,
      'qualification receipt output hash',
    ),
    qualificationReceiptHash: matching(
      receipt.qualificationReceiptHash,
      /^[0-9a-f]{64}$/u,
      'receipt qualification hash',
    ),
    studyHash: matching(receipt.studyHash, /^[0-9a-f]{64}$/u, 'receipt study hash'),
    threadnoteArtifactHash: matching(
      receipt.threadnoteArtifactHash,
      /^[0-9a-f]{64}$/u,
      'receipt Threadnote artifact hash',
    ),
    threadnoteSourceCommit: matching(
      receipt.threadnoteSourceCommit,
      /^[0-9a-f]{40}$/u,
      'receipt Threadnote source commit',
    ),
    verificationPlanHash: matching(receipt.verificationPlanHash, /^[0-9a-f]{64}$/u, 'receipt verification plan hash'),
  };
}

interface MatchedQualificationReceiptBindingV1 {
  readonly qualificationReceiptHash: string;
  readonly qualificationReceiptSha256: string;
}

export function assertMatchedQualificationReceiptBindingV1(
  matchedPreparationReceiptValue: unknown,
  qualificationReceiptBytes: Uint8Array,
): void {
  assertQualificationReceiptBindingV1(
    parseMatchedPreparationReceipt(matchedPreparationReceiptValue),
    qualificationReceiptBytes,
  );
}

function assertQualificationReceiptBindingV1(
  preparationReceipt: MatchedQualificationReceiptBindingV1,
  qualificationReceiptBytes: Uint8Array,
): void {
  if (sha256(qualificationReceiptBytes) !== preparationReceipt.qualificationReceiptSha256) {
    invalid('qualification receipt bytes differ from the matched preparation receipt');
  }
  const qualificationReceipt = parseQualificationReceiptV1(
    parseJson(qualificationReceiptBytes, 'qualification receipt'),
  );
  if (qualificationReceipt.receiptHash !== preparationReceipt.qualificationReceiptHash) {
    invalid('qualification receipt hash differs from the matched preparation receipt');
  }
}

function parseQualificationReceiptV1(value: unknown): {readonly receiptHash: string} {
  const receipt = object(value, 'qualification receipt');
  exactKeys(receipt, ['receiptHash', 'tasks', 'version']);
  if (receipt.version !== 1) invalid('qualification receipt version must be 1');
  const tasks = array(receipt.tasks, 'qualification receipt tasks').map((value, taskIndex) => {
    const task = object(value, `qualification receipt task ${taskIndex}`);
    exactKeys(task, [
      'appliedPaths',
      'baseFixtureHash',
      'baseRevision',
      'commands',
      'fixFixtureHash',
      'fixRevision',
      'protectedPaths',
      'taskId',
    ]);
    const appliedPaths = qualificationPaths(task.appliedPaths, `qualification task ${taskIndex} applied paths`);
    const protectedPaths = qualificationPaths(task.protectedPaths, `qualification task ${taskIndex} protected paths`);
    const commands = array(task.commands, `qualification task ${taskIndex} commands`).map((value, commandIndex) => {
      const command = object(value, `qualification task ${taskIndex} command ${commandIndex}`);
      exactKeys(command, ['commandHash', 'diagnosticHash', 'exitCode']);
      if (command.exitCode !== 0) invalid(`qualification task ${taskIndex} command ${commandIndex} did not pass`);
      return {
        commandHash: matching(command.commandHash, /^[0-9a-f]{64}$/u, 'qualification command hash'),
        diagnosticHash: matching(command.diagnosticHash, /^[0-9a-f]{64}$/u, 'qualification diagnostic hash'),
        exitCode: 0 as const,
      };
    });
    if (appliedPaths.length === 0 || commands.length === 0 || commands.length > 16) {
      invalid(`qualification task ${taskIndex} has invalid evidence bounds`);
    }
    return {
      appliedPaths,
      baseFixtureHash: matching(task.baseFixtureHash, /^[0-9a-f]{64}$/u, 'qualification base fixture hash'),
      baseRevision: matching(task.baseRevision, /^[0-9a-f]{40}$/u, 'qualification base revision'),
      commands,
      fixRevision: matching(task.fixRevision, /^[0-9a-f]{40}$/u, 'qualification fix revision'),
      fixFixtureHash: matching(task.fixFixtureHash, /^[0-9a-f]{64}$/u, 'qualification fix fixture hash'),
      protectedPaths,
      taskId: matching(task.taskId, /^tsk_[0-9a-f]{16,64}$/u, 'qualification task id'),
    };
  });
  if (tasks.length === 0 || tasks.length > 64) invalid('qualification receipt tasks have invalid bounds');
  unique(
    tasks.map(task => task.taskId),
    'qualification receipt task ids',
  );
  const receiptWithoutHash = {tasks, version: 1 as const};
  const receiptHash = matching(receipt.receiptHash, /^[0-9a-f]{64}$/u, 'qualification receipt hash');
  if (receiptHash !== digest('matched-token-efficiency-known-fix-qualification-v1', receiptWithoutHash)) {
    invalid('qualification receipt hash is invalid');
  }
  return {receiptHash};
}

function qualificationPaths(value: unknown, label: string): readonly string[] {
  const paths = array(value, label).map((path, index) => safeRelativePath(path, `${label} ${index}`));
  if (paths.length === 0 || paths.length > 256) invalid(`${label} has invalid bounds`);
  unique(paths, label);
  return paths;
}

function safeRelativePath(value: unknown, label: string): string {
  const path = boundedText(value, 1, 4_096, label);
  if (
    path.includes('\\') ||
    isAbsolute(path) ||
    path.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    invalid(`${label} must be one normalized relative path`);
  }
  return path;
}

export function parseMatchedContinuationPreparationPlanV1(value: unknown): MatchedContinuationPreparationPlanV1 {
  const plan = object(value, 'continuation preparation plan');
  exactKeys(plan, ['bootstrap', 'exposureAuditPath', 'gates', 'sourceCommit', 'studyId', 'tasks', 'version']);
  if (plan.version !== MATCHED_CONTINUATION_PREPARATION_VERSION) invalid('preparation plan version must be 1');
  const bootstrap = object(plan.bootstrap, 'continuation preparation bootstrap');
  exactKeys(bootstrap, ['confidenceLevelBasisPoints', 'iterations', 'seed']);
  if (bootstrap.confidenceLevelBasisPoints !== 9_500) invalid('bootstrap confidence must be 95%');
  const gates = object(plan.gates, 'continuation preparation gates');
  exactKeys(gates, [
    'completionNonInferiorityBasisPoints',
    'maximumAuthorizationLeaks',
    'maximumFalseCurrentOutcomes',
    'maximumHarmfulActions',
    'minimumClusters',
    'minimumCorrectnessScoreMilli',
    'minimumTokenReductionBasisPoints',
  ]);
  const tasks = array(plan.tasks, 'continuation preparation tasks').map((entry, index) => {
    const task = object(entry, `continuation preparation task ${index}`);
    exactKeys(task, ['clusterId', 'pilotDirectory', 'planPath', 'runtimePath']);
    return {
      clusterId: matching(task.clusterId, /^cluster_[0-9a-f]{16,64}$/u, `continuation task ${index} cluster`),
      pilotDirectory: absolutePath(task.pilotDirectory, `continuation task ${index} pilot directory`),
      planPath: absolutePath(task.planPath, `continuation task ${index} plan path`),
      runtimePath: absolutePath(task.runtimePath, `continuation task ${index} runtime path`),
    };
  });
  unique(
    tasks.map(task => task.clusterId),
    'continuation preparation clusters',
  );
  unique(
    tasks.map(task => task.planPath),
    'continuation preparation plan paths',
  );
  unique(
    tasks.map(task => task.pilotDirectory),
    'continuation preparation pilot directories',
  );
  unique(
    tasks.map(task => task.runtimePath),
    'continuation preparation runtime paths',
  );
  return {
    bootstrap: {
      confidenceLevelBasisPoints: 9_500,
      iterations: integer(bootstrap.iterations, 200, 100_000, 'bootstrap iterations'),
      seed: matching(bootstrap.seed, /^[0-9a-f]{64}$/u, 'bootstrap seed'),
    },
    gates: {
      completionNonInferiorityBasisPoints: integer(
        gates.completionNonInferiorityBasisPoints,
        0,
        5_000,
        'completion non-inferiority margin',
      ),
      maximumAuthorizationLeaks: integer(gates.maximumAuthorizationLeaks, 0, 1_000, 'authorization leak limit'),
      maximumFalseCurrentOutcomes: integer(gates.maximumFalseCurrentOutcomes, 0, 1_000, 'false-current limit'),
      maximumHarmfulActions: integer(gates.maximumHarmfulActions, 0, 1_000, 'harmful-action limit'),
      minimumClusters: integer(gates.minimumClusters, 5, 64, 'minimum clusters'),
      minimumCorrectnessScoreMilli: integer(gates.minimumCorrectnessScoreMilli, 0, 1_000, 'minimum correctness score'),
      minimumTokenReductionBasisPoints: integer(
        gates.minimumTokenReductionBasisPoints,
        0,
        9_999,
        'minimum token reduction',
      ),
    },
    exposureAuditPath: absolutePath(plan.exposureAuditPath, 'exposure audit path'),
    sourceCommit: matching(plan.sourceCommit, /^[0-9a-f]{40}$/u, 'candidate source commit'),
    studyId: matching(plan.studyId, /^[a-z][a-z0-9-]{2,63}$/u, 'continuation study id'),
    tasks,
    version: MATCHED_CONTINUATION_PREPARATION_VERSION,
  };
}

function parseArguments(args: readonly string[]): PreparationOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    '--adapter',
    '--corpus',
    '--manifest',
    '--matched-preparation-receipt',
    '--matched-runtime',
    '--matched-study',
    '--output',
    '--plan',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowed.has(option) || values.has(option)) throw new Error(`Unknown or repeated option: ${option}`);
    values.set(option, required(args[++index], option));
  }
  return {
    adapterPath: absolutePath(required(values.get('--adapter'), '--adapter'), '--adapter'),
    corpusPath: absolutePath(required(values.get('--corpus'), '--corpus'), '--corpus'),
    manifestPath: absolutePath(required(values.get('--manifest'), '--manifest'), '--manifest'),
    matchedPreparationReceiptPath: absolutePath(
      required(values.get('--matched-preparation-receipt'), '--matched-preparation-receipt'),
      '--matched-preparation-receipt',
    ),
    matchedRuntimePath: absolutePath(
      required(values.get('--matched-runtime'), '--matched-runtime'),
      '--matched-runtime',
    ),
    matchedStudyPath: absolutePath(required(values.get('--matched-study'), '--matched-study'), '--matched-study'),
    outputDirectory: absolutePath(required(values.get('--output'), '--output'), '--output'),
    preparationPlanPath: absolutePath(required(values.get('--plan'), '--plan'), '--plan'),
  };
}

async function ensureOutputDirectory(path: string): Promise<void> {
  if (!path.split(sep).includes('.context'))
    throw new Error('Continuation output must be inside a .context directory.');
  await mkdir(path, {recursive: true, mode: 0o700});
  if ((await realpath(path)) !== path) throw new Error('Continuation output directory must be canonical.');
}

async function readBoundedRegularFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const canonical = await canonicalRegularFile(path, label);
  const metadata = await lstat(canonical);
  if (metadata.size > maximumBytes) throw new Error(`${label} exceeds its bounded size.`);
  return readFile(canonical);
}

async function sha256RegularFile(path: string, maximumBytes: number, label: string): Promise<string> {
  return sha256(await readBoundedRegularFile(path, maximumBytes, label));
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be one regular non-linked file.`);
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must use its canonical path.`);
  return canonical;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
  await rename(temporary, path);
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

function digest(namespace: string, value: unknown): string {
  return sha256(Buffer.from(`${namespace}\n${JSON.stringify(value)}`));
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

function matching(value: unknown, pattern: RegExp, label: string): string {
  const text = boundedText(value, 1, 4_096, label);
  if (!pattern.test(text)) invalid(`${label} is invalid`);
  return text;
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedText(value, 1, 4_096, label);
  if (!isAbsolute(path)) invalid(`${label} must be absolute`);
  return resolve(path);
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    invalid(`${label} is invalid`);
  return Number(value);
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null || value === '') throw new Error(`Missing ${label}.`);
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid matched continuation preparation: ${message}.`);
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));

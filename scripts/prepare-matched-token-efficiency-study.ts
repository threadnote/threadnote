#!/usr/bin/env bun

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This local evidence preparer owns reviewed filesystem and child-process boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {createHash} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Effect} from 'effect';
import {parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  createMatchedEvaluationManifestV1,
  matchedEvaluationReferenceEnvironmentPolicyHashV1,
  parseMatchedEvaluationCorpusV1,
  type MatchedEvaluationArm,
  type MatchedEvaluationArmDefinitionV1,
  type MatchedEvaluationCorpusV1,
  MATCHED_EVALUATION_ADAPTER_PROTOCOL,
  MATCHED_EVALUATION_ARMS,
} from '@threadnote/threadnote/evaluation/matched-evaluation';
import {
  createMatchedTokenEfficiencyStudyV1,
  createMatchedTokenEfficiencyTaskContextV1,
  matchedTokenEfficiencyCitationHashV1,
  matchedTokenEfficiencyGraphContentHashV1,
  matchedTokenEfficiencyGraphSnapshotHashV1,
  type MatchedTokenEfficiencyLifecycleArmV1,
  type MatchedTokenEfficiencyStudyV1,
  type MatchedTokenEfficiencyTaskContextV1,
} from '@threadnote/threadnote/evaluation/matched-token-efficiency';
import {
  createMatchedEvaluationVerificationCalibrationV1,
  createMatchedEvaluationVerificationPlanV1,
  matchedEvaluationVerificationIdV1,
  type MatchedEvaluationVerificationPlanV1,
} from '@threadnote/threadnote/evaluation/matched-verification';
import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';
import {assertCodeMemoryLinkGraphStatusPreflight} from './code-memory-link-codex-preflight.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import {
  matchedEvaluationCodexEnvironmentPolicyHashV1,
  matchedEvaluationDependencyProjectionFixtureHashV1,
  matchedEvaluationPreparedHomeFixtureHashV1,
  matchedEvaluationVerifierEnvironmentHashV1,
  materializeMatchedEvaluationDependencyProjectionV1,
  parseMatchedEvaluationCodexAdapterConfigV1,
  runMatchedEvaluationDeterministicVerifierV1,
  type MatchedEvaluationCodexAdapterConfigV1,
  type MatchedEvaluationDependencyProjectionV1,
  type MatchedEvaluationPreparedContextHomeV1,
  MATCHED_EVALUATION_CODEX_ADAPTER_VERSION,
} from './matched-evaluation-codex-adapter.js';
import {
  observeMatchedEvaluationRepositoryV1,
  type MatchedEvaluationRepositoryObservationV1,
} from './matched-evaluation-runtime-integrity.js';
import {
  parseMatchedEvaluationRuntimeV1,
  MATCHED_EVALUATION_RUNTIME_VERSION,
  type MatchedEvaluationRuntimeArmV1,
  type MatchedEvaluationRuntimeV1,
} from './run-matched-evaluation.js';

export const MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION = 4 as const;
export const MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION = '5.0.6' as const;
export const MATCHED_TOKEN_EFFICIENCY_PRODUCTION_PRODUCT_VERSION = '5.0.7' as const;
export const MATCHED_TOKEN_EFFICIENCY_BETA_PRODUCT_VERSION = '5.1.0-beta.2' as const;
const PRODUCTION_SOURCE_COMMIT = '78eab789ba33e3b7e3abf44d73dd48f8bc58f8d7' as const;
const PRODUCTION_RELEASE_URL = 'https://github.com/Kashkovsky/threadnote/releases/tag/v5.0.7' as const;
const PRODUCTION_ARCHIVE_URL =
  'https://github.com/Kashkovsky/threadnote/releases/download/v5.0.7/threadnote-darwin-arm64.tar.gz' as const;

export interface MatchedTokenEfficiencyProductionReleaseV1 {
  readonly archiveSha256: string;
  readonly archiveUrl: typeof PRODUCTION_ARCHIVE_URL;
  readonly executableSha256: string;
  readonly immutable: true;
  readonly releaseUrl: typeof PRODUCTION_RELEASE_URL;
  readonly sourceCommit: string;
  readonly version: typeof MATCHED_TOKEN_EFFICIENCY_PRODUCTION_PRODUCT_VERSION;
}

interface PreparationPlanV1 {
  /** Selected runtime subset; v4 plans must declare this explicitly. */
  readonly activeArms: readonly MatchedEvaluationArm[];
  readonly adapter: {
    readonly approvedCommands: readonly {
      readonly taskId: string;
      readonly tokens: readonly string[];
    }[];
    readonly appServer: {
      readonly argumentsAfterSubcommand: readonly string[];
      readonly argumentsBeforeSubcommand: readonly string[];
      readonly executable: string;
      readonly version: string;
    };
    readonly authSourcePath: string;
    readonly contextBudgetTokens: number;
    readonly dependencyProjections?: readonly DependencyProjectionPlanV1[];
    readonly executable: string;
    readonly gitExecutable: string;
    readonly judgeModel: ModelPlanV1;
    readonly model: ModelPlanV1;
    readonly pricingMicrosPerMillionTokens: {
      readonly cachedInput: number;
      readonly input: number;
      readonly output: number;
    } | null;
    readonly safeBinaries: readonly string[];
    readonly safeExecutablePath: string;
    readonly taskBudget: {readonly steps: number; readonly tokens: number};
    readonly temporaryRoot: string;
  };
  readonly bootstrap: MatchedTokenEfficiencyStudyV1['bootstrap'];
  readonly clusters: readonly ClusterPlanV1[];
  readonly gates: MatchedTokenEfficiencyStudyV1['gates'];
  readonly lifecycle: readonly MatchedTokenEfficiencyLifecycleArmV1[];
  readonly project: string;
  readonly repetitions: number;
  readonly scheduleSeed: string;
  readonly studyId: string;
  readonly targetArms?: readonly ('threadnote-compact' | 'threadnote-source')[];
  readonly taskContexts: readonly TaskContextPlanV1[];
  readonly threadnote: {
    readonly account: string;
    readonly executable: string;
    readonly lockFile: string;
    readonly requiredReleaseCommit: string;
    readonly sourceDirectory: string;
    readonly user: string;
    readonly productionRelease?: MatchedTokenEfficiencyProductionReleaseV1;
  };
  readonly timeoutMilliseconds: number;
  readonly verification: VerificationPreparationPlanV1;
  readonly version: typeof MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION;
}

interface DependencyProjectionPlanV1 {
  readonly lockFileRelativePath: string;
  readonly sourceDirectory: string;
  readonly targetRelativePath: string;
  readonly taskId: string;
}

interface VerificationPreparationPlanV1 {
  readonly environmentDirectory: string;
  readonly interpreter: string;
  readonly runner: string;
  readonly sandboxExecutable: string;
  readonly tasks: readonly {
    readonly fixRepositoryDirectory: string;
    readonly protectedPaths: readonly string[];
    readonly qualificationCommands: readonly (readonly string[])[];
    readonly selector: string;
    readonly taskId: string;
  }[];
  readonly timeoutMilliseconds: number;
}

interface ModelPlanV1 {
  readonly id: string;
  readonly provider: string;
  readonly reasoningEffort: string;
}

interface ClusterPlanV1 {
  readonly clusterId: string;
  readonly repositoryDirectory: string;
  readonly repositoryUrl: string;
}

interface TaskContextPlanV1 {
  readonly activeHandoffTopics: readonly string[];
  readonly asIssuedContext: {
    readonly assessmentFile: string;
    readonly contentFile: string | null;
    readonly sufficiency: MatchedTokenEfficiencyTaskContextV1['asIssuedContext']['sufficiency'];
  };
  readonly clusterId: string;
  readonly graphHomeDirectory: string;
  readonly linkedMemoryIdentities: readonly LinkedMemoryIdentityPlanV1[];
  readonly linkedHomeDirectory: string;
  readonly taskId: string;
}

interface LinkedMemoryIdentityPlanV1 {
  readonly fixtureMemoryId: string;
  readonly managedMemoryId: string;
}

export interface MatchedTokenEfficiencyAgentContextBriefRequestV1 {
  readonly budgetTokens: number;
  readonly callerCwd: string;
  readonly executable: string;
  readonly home: string;
  readonly identity: {readonly account: string; readonly user: string};
  readonly project: string;
  readonly safeExecutablePath: string;
  readonly task: string;
}

interface PreparationDependenciesV1 {
  readonly readAgentContextBrief: (request: MatchedTokenEfficiencyAgentContextBriefRequestV1) => Promise<unknown>;
}

const DEFAULT_PREPARATION_DEPENDENCIES: PreparationDependenciesV1 = {
  readAgentContextBrief: readAgentContextBriefViaMcp,
};

interface PreparedTask {
  readonly graphHome: MatchedEvaluationPreparedContextHomeV1;
  readonly linkedHome: MatchedEvaluationPreparedContextHomeV1;
  readonly taskContext: MatchedTokenEfficiencyTaskContextV1;
}

export interface MatchedTokenEfficiencyPreparationReceiptV1 {
  readonly adapterArtifactHash: string;
  readonly adapterConfigurationHashes: Readonly<Record<MatchedEvaluationArm, string>>;
  readonly corpusHash: string;
  readonly manifestHash: string;
  readonly outputHashes: Readonly<Record<string, string>>;
  readonly receiptHash: string;
  readonly referenceArm: 'unavailable';
  readonly requiredProductVersion:
    | typeof MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION
    | typeof MATCHED_TOKEN_EFFICIENCY_PRODUCTION_PRODUCT_VERSION
    | typeof MATCHED_TOKEN_EFFICIENCY_BETA_PRODUCT_VERSION;
  readonly productionRelease: MatchedTokenEfficiencyProductionReleaseV1 | null;
  readonly qualificationReceiptHash: string;
  readonly studyHash: string;
  readonly threadnoteArtifactHash: string;
  readonly threadnoteLockHash: string;
  readonly threadnoteSourceCommit: string;
  readonly verificationPlanHash: string;
  readonly version: typeof MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION;
}

interface MatchedTokenEfficiencyQualificationReceiptV1 {
  readonly receiptHash: string;
  readonly tasks: readonly {
    readonly appliedPaths: readonly string[];
    readonly baseFixtureHash: string;
    readonly baseRevision: string;
    readonly commands: readonly {
      readonly commandHash: string;
      readonly diagnosticHash: string;
      readonly exitCode: 0;
    }[];
    readonly fixRevision: string;
    readonly fixFixtureHash: string;
    readonly protectedPaths: readonly string[];
    readonly taskId: string;
  }[];
  readonly version: 1;
}

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const FIXTURE_MEMORY_ID = /^mem_[0-9a-f]{16,64}$/u;
const MANAGED_MEMORY_ID = /^tn_[A-Za-z0-9_-]{1,128}$/u;
const CLUSTER_ID = /^cluster_[0-9a-f]{16,64}$/u;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VERIFIER_SELECTOR = /^[a-z][a-z0-9-]{0,63}$/u;
const PRODUCTION_VERSION_OUTPUT = /^threadnote v5\.0\.7\s*$/u;
const MAXIMUM_JSON_BYTES = 8 * 1_024 * 1_024;

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  yield* Effect.tryPromise({
    try: () => prepareMatchedTokenEfficiencyStudyV1(options),
    catch: cause => ScriptError.make({message: 'Matched token-efficiency preparation stopped.', cause}),
  });
});

export async function prepareMatchedTokenEfficiencyStudyV1(
  options: {
    readonly corpusPath: string;
    readonly outputRoot: string;
    readonly planPath: string;
  },
  dependencies: PreparationDependenciesV1 = DEFAULT_PREPARATION_DEPENDENCIES,
): Promise<MatchedTokenEfficiencyPreparationReceiptV1> {
  const [corpus, plan] = await Promise.all([
    readJson(options.corpusPath).then(parseMatchedEvaluationCorpusV1),
    readJson(options.planPath).then(parsePreparationPlanV1),
  ]);
  const activeArms = plan.activeArms;
  const outputRoot = absolutePath(options.outputRoot, 'output root');
  if (!outputRoot.split(sep).includes('.context'))
    throw new Error('Output root must be inside a local .context directory.');
  const outputParent = await canonicalDirectory(dirname(outputRoot), 'output parent');
  if (dirname(outputRoot) !== outputParent) throw new Error('Output parent must use its canonical path.');
  await assertAbsent(outputRoot, 'output root');
  const product = await assertThreadnoteSourceAndExecutable(plan.threadnote);
  const sourceCommit = product.sourceCommit;
  const [adapterExecutable, adapterArtifactHash, threadnoteArtifactHash, threadnoteLockHash] = await Promise.all([
    canonicalRegularFile(plan.adapter.executable, true, 'adapter executable'),
    hashCanonicalFile(plan.adapter.executable, true, 'adapter executable'),
    hashCanonicalFile(plan.threadnote.executable, true, 'Threadnote executable'),
    hashCanonicalFile(plan.threadnote.lockFile, false, 'Threadnote lock file'),
  ]);
  const runtimeFileHashes = new Map<string, string>();
  await Promise.all(
    [plan.adapter.appServer.executable, plan.adapter.gitExecutable, ...plan.adapter.safeBinaries].map(async path => {
      runtimeFileHashes.set(path, await hashCanonicalFile(path, true, `runtime executable ${path}`));
    }),
  );
  await assertPrivateAuthFile(plan.adapter.authSourcePath);
  await mkdir(plan.adapter.temporaryRoot, {mode: 0o700, recursive: true});
  await canonicalDirectory(plan.adapter.temporaryRoot, 'adapter temporary root');
  const clusterObservations = await prepareClusters(plan, corpus);
  const dependencyProjections = await prepareDependencyProjections(plan);
  const {qualificationReceipt, verificationPlan} = await prepareVerificationPlan(
    plan,
    corpus,
    clusterObservations,
    dependencyProjections,
  );
  const provisionalManifest = createMatchedEvaluationManifestV1({
    activeArms,
    arms: placeholderArmDefinitions(),
    corpus,
    model: manifestModel(plan.adapter.model),
    repetitions: plan.repetitions,
    repository: firstObservation(clusterObservations),
    scheduleSeed: plan.scheduleSeed,
  });
  const tasks = await prepareTasks({
    clusterObservations,
    corpus,
    manifest: provisionalManifest,
    plan,
    readAgentContextBrief: dependencies.readAgentContextBrief,
  });
  const finalRoot = outputRoot;
  const configs = createAdapterConfigs({
    plan,
    prepared: tasks,
    dependencyProjections,
    runtimeFileHashes,
    verificationPlan,
  });
  const configBytes = new Map(configs.map(([arm, config]) => [arm, jsonBytes(config)]));
  const configHashes = Object.fromEntries(
    MATCHED_EVALUATION_ARMS.map(arm => [arm, sha256(required(configBytes.get(arm), `adapter config ${arm}`))]),
  ) as Readonly<Record<MatchedEvaluationArm, string>>;
  const unavailableReference = Buffer.from(
    `${JSON.stringify({reason: 'reference-scope runtime is not configured by the production Codex preparer', version: 1})}\n`,
  );
  const unavailableReferenceHash = sha256(unavailableReference);
  const arms = armDefinitions({
    adapterArtifactHash,
    configHashes,
    referenceArtifactHash: unavailableReferenceHash,
    threadnoteArtifactHash,
    threadnoteLockHash,
    productVersion: product.version,
  });
  const manifest = createMatchedEvaluationManifestV1({
    activeArms,
    arms,
    corpus,
    model: manifestModel(plan.adapter.model),
    repetitions: plan.repetitions,
    repository: firstObservation(clusterObservations),
    scheduleSeed: plan.scheduleSeed,
  });
  const study = createMatchedTokenEfficiencyStudyV1({
    bootstrap: plan.bootstrap,
    clusters: plan.clusters.map(cluster => {
      const observation = required(clusterObservations.get(cluster.clusterId), `cluster ${cluster.clusterId}`);
      return {
        clusterId: cluster.clusterId,
        heldOut: true as const,
        repositoryFixtureHash: observation.fixtureHash,
        repositoryIdentityHash: observation.identityHash,
        repositoryUrl: cluster.repositoryUrl,
        revision: observation.revision,
        taskIds: tasks
          .filter(task => task.taskContext.clusterId === cluster.clusterId)
          .map(task => task.taskContext.taskId),
      };
    }),
    gates: plan.gates,
    lifecycle: plan.lifecycle,
    manifestHash: manifest.manifestHash,
    promptPolicy: 'identical-as-issued',
    studyId: plan.studyId,
    targetArms: (plan.targetArms ?? ['threadnote-compact', 'threadnote-source']).filter(arm =>
      activeArms.includes(arm),
    ),
    taskContexts: tasks.map(task => task.taskContext),
    verificationPlanHash: verificationPlan.planHash,
  });
  const runtime = createRuntime({
    adapterExecutable,
    clusterObservations,
    outputRoot: finalRoot,
    plan,
    verificationPlanHash: verificationPlan.planHash,
  });
  const files = new Map<string, Uint8Array>([
    ['corpus.json', jsonBytes(corpus)],
    ['manifest.json', jsonBytes(manifest)],
    ['study.json', jsonBytes(study)],
    ['runtime.json', jsonBytes(runtime)],
    ['verification-plan.json', jsonBytes(verificationPlan)],
    ['qualification-receipt.json', jsonBytes(qualificationReceipt)],
    ['reference-scope-unavailable.json', unavailableReference],
  ]);
  for (const [arm, bytes] of configBytes) files.set(`adapter-config/${arm}.json`, bytes);
  const outputHashes = Object.fromEntries([...files].map(([path, bytes]) => [path, sha256(bytes)]));
  const receiptWithoutHash = {
    adapterArtifactHash,
    adapterConfigurationHashes: configHashes,
    corpusHash: manifest.corpusHash,
    manifestHash: manifest.manifestHash,
    outputHashes,
    referenceArm: 'unavailable' as const,
    requiredProductVersion: product.version,
    productionRelease: product.productionRelease,
    qualificationReceiptHash: qualificationReceipt.receiptHash,
    studyHash: study.studyHash,
    threadnoteArtifactHash,
    threadnoteLockHash,
    threadnoteSourceCommit: sourceCommit,
    verificationPlanHash: verificationPlan.planHash,
    version: MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION,
  };
  const receipt: MatchedTokenEfficiencyPreparationReceiptV1 = {
    ...receiptWithoutHash,
    receiptHash: digest('matched-token-efficiency-preparation-receipt-v2', receiptWithoutHash),
  };
  files.set('preparation-receipt.json', jsonBytes(receipt));
  const staging = await realpath(await mkdtemp(join(outputParent, '.matched-token-efficiency-staging-')));
  let promoted = false;
  try {
    await writePreparedFiles(staging, files);
    await verifyPreparedFiles(staging, files);
    await assertPreparationInputsUnchanged({
      adapterArtifactHash,
      clusterObservations,
      plan,
      prepared: tasks,
      qualificationReceipt,
      runtimeFileHashes,
      sourceCommit,
      threadnoteArtifactHash,
      threadnoteLockHash,
      verificationPlan,
    });
    await rename(staging, outputRoot);
    promoted = true;
  } finally {
    if (!promoted) await rm(staging, {force: true, recursive: true});
  }
  process.stdout.write(
    `${JSON.stringify({
      manifestHash: receipt.manifestHash,
      outputRoot,
      receiptHash: receipt.receiptHash,
      scheduledRuns: manifest.schedule.length,
      studyHash: receipt.studyHash,
      version: MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION,
    })}\n`,
  );
  return receipt;
}

async function assertPreparationInputsUnchanged(input: {
  readonly adapterArtifactHash: string;
  readonly clusterObservations: ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>;
  readonly plan: PreparationPlanV1;
  readonly prepared: readonly PreparedTask[];
  readonly qualificationReceipt: MatchedTokenEfficiencyQualificationReceiptV1;
  readonly runtimeFileHashes: ReadonlyMap<string, string>;
  readonly sourceCommit: string;
  readonly threadnoteArtifactHash: string;
  readonly threadnoteLockHash: string;
  readonly verificationPlan: MatchedEvaluationVerificationPlanV1;
}): Promise<void> {
  const sourceCommit = (await assertThreadnoteSourceAndExecutable(input.plan.threadnote)).sourceCommit;
  if (sourceCommit !== input.sourceCommit) throw new Error('Threadnote source changed during preparation.');
  const [adapterHash, threadnoteHash, lockHash] = await Promise.all([
    hashCanonicalFile(input.plan.adapter.executable, true, 'adapter executable'),
    hashCanonicalFile(input.plan.threadnote.executable, true, 'Threadnote executable'),
    hashCanonicalFile(input.plan.threadnote.lockFile, false, 'Threadnote lock file'),
  ]);
  if (
    adapterHash !== input.adapterArtifactHash ||
    threadnoteHash !== input.threadnoteArtifactHash ||
    lockHash !== input.threadnoteLockHash
  ) {
    throw new Error('A pinned evaluation executable or lock changed during preparation.');
  }
  await Promise.all(
    [...input.runtimeFileHashes].map(async ([path, expected]) => {
      if ((await hashCanonicalFile(path, true, `runtime executable ${path}`)) !== expected) {
        throw new Error(`Runtime executable changed during preparation: ${path}`);
      }
    }),
  );
  await assertPrivateAuthFile(input.plan.adapter.authSourcePath);
  await assertVerificationPlanUnchanged(input.verificationPlan);
  for (const qualification of input.qualificationReceipt.tasks) {
    const task = required(
      input.plan.verification.tasks.find(candidate => candidate.taskId === qualification.taskId),
      `qualification task ${qualification.taskId}`,
    );
    const observed = await observeMatchedEvaluationRepositoryV1(task.fixRepositoryDirectory);
    if (
      observed.dirty ||
      observed.fixtureHash !== qualification.fixFixtureHash ||
      observed.revision !== qualification.fixRevision
    ) {
      throw new Error(`Known-fix repository changed during preparation: ${qualification.taskId}`);
    }
  }
  for (const cluster of input.plan.clusters) {
    const observed = await observeMatchedEvaluationRepositoryV1(cluster.repositoryDirectory);
    const expected = required(input.clusterObservations.get(cluster.clusterId), cluster.clusterId);
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      throw new Error(`Held-out repository changed during preparation: ${cluster.clusterId}`);
    }
  }
  for (const task of input.prepared) {
    const [graphHash, linkedHash] = await Promise.all([
      matchedEvaluationPreparedHomeFixtureHashV1(task.graphHome.homeDirectory),
      matchedEvaluationPreparedHomeFixtureHashV1(task.linkedHome.homeDirectory),
    ]);
    if (graphHash !== task.graphHome.homeFixtureHash || linkedHash !== task.linkedHome.homeFixtureHash) {
      throw new Error(`Prepared Threadnote home changed during preparation: ${task.taskContext.taskId}`);
    }
  }
}

async function prepareClusters(
  plan: PreparationPlanV1,
  corpus: MatchedEvaluationCorpusV1,
): Promise<ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>> {
  const result = new Map<string, MatchedEvaluationRepositoryObservationV1>();
  for (const cluster of plan.clusters) {
    const repository = await canonicalDirectory(cluster.repositoryDirectory, `cluster ${cluster.clusterId} repository`);
    await assertRepositoryRemote(repository, cluster.repositoryUrl);
    const observation = await observeMatchedEvaluationRepositoryV1(repository);
    if (observation.dirty) throw new Error(`Cluster ${cluster.clusterId} repository must be clean.`);
    if (!COMMIT.test(observation.revision))
      throw new Error(`Cluster ${cluster.clusterId} revision is not a full commit.`);
    result.set(cluster.clusterId, observation);
  }
  for (const task of corpus.tasks) {
    const context = required(
      plan.taskContexts.find(candidate => candidate.taskId === task.taskId),
      `task ${task.taskId}`,
    );
    const observation = required(result.get(context.clusterId), `cluster ${context.clusterId}`);
    if (task.repositoryFixtureHash !== observation.fixtureHash) {
      throw new Error(`Task ${task.taskId} repository fixture hash differs from its clean held-out checkout.`);
    }
  }
  return result;
}

async function prepareVerificationPlan(
  plan: PreparationPlanV1,
  corpus: MatchedEvaluationCorpusV1,
  clusterObservations: ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>,
  dependencyProjections: readonly MatchedEvaluationDependencyProjectionV1[],
): Promise<{
  readonly qualificationReceipt: MatchedTokenEfficiencyQualificationReceiptV1;
  readonly verificationPlan: MatchedEvaluationVerificationPlanV1;
}> {
  const environmentDirectory = await canonicalDirectory(
    plan.verification.environmentDirectory,
    'verification environment',
  );
  const [environmentHash, interpreterHash, runnerHash, sandboxExecutableHash] = await Promise.all([
    matchedEvaluationVerifierEnvironmentHashV1(environmentDirectory),
    hashLinkedExecutable(plan.verification.interpreter, 'verification interpreter'),
    hashCanonicalFile(plan.verification.runner, false, 'verification runner'),
    hashCanonicalFile(plan.verification.sandboxExecutable, true, 'verification sandbox executable'),
  ]);
  const provisionalTasks = await Promise.all(
    plan.verification.tasks.map(async task => {
      const context = required(
        plan.taskContexts.find(candidate => candidate.taskId === task.taskId),
        `verification task context ${task.taskId}`,
      );
      const cluster = required(
        plan.clusters.find(candidate => candidate.clusterId === context.clusterId),
        `verification cluster ${context.clusterId}`,
      );
      const base = required(clusterObservations.get(cluster.clusterId), `verification base ${cluster.clusterId}`);
      const fixDirectory = await canonicalDirectory(
        task.fixRepositoryDirectory,
        `verification fix repository ${task.taskId}`,
      );
      await assertRepositoryRemote(fixDirectory, cluster.repositoryUrl);
      const fix = await observeMatchedEvaluationRepositoryV1(fixDirectory);
      if (fix.dirty || !COMMIT.test(fix.revision)) {
        throw new Error(`Verification fix repository ${task.taskId} must be a clean full commit.`);
      }
      return {
        base,
        baseDirectory: cluster.repositoryDirectory,
        fix,
        fixDirectory,
        task,
        verificationTask: {
          calibration: createMatchedEvaluationVerificationCalibrationV1({
            baseDiagnosticHash: '1'.repeat(64),
            baseExitCode: 1,
            baseRepositoryFixtureHash: base.fixtureHash,
            baseRevision: base.revision,
            fixDiagnosticHash: '2'.repeat(64),
            fixExitCode: 0,
            fixRepositoryFixtureHash: fix.fixtureHash,
            fixRevision: fix.revision,
          }),
          selector: task.selector,
          taskId: task.taskId,
          verificationId: matchedEvaluationVerificationIdV1(task.taskId, task.selector),
        },
      };
    }),
  );
  const corpusTaskIds = corpus.tasks.map(task => task.taskId).sort();
  const verificationTaskIds = provisionalTasks.map(task => task.task.taskId).sort();
  if (JSON.stringify(corpusTaskIds) !== JSON.stringify(verificationTaskIds)) {
    throw new Error('Verification plan tasks must exactly cover the corpus.');
  }
  for (const task of provisionalTasks) {
    await ensureMatchedEvaluationFixCommitAvailableV1({
      baseDirectory: task.baseDirectory,
      fixDirectory: task.fixDirectory,
      fixRevision: task.fix.revision,
      taskId: task.task.taskId,
    });
  }
  const provisionalPlan = createMatchedEvaluationVerificationPlanV1({
    environmentDirectory,
    environmentHash,
    interpreter: plan.verification.interpreter,
    interpreterHash,
    runner: plan.verification.runner,
    runnerHash,
    sandbox: {
      executable: plan.verification.sandboxExecutable,
      executableHash: sandboxExecutableHash,
      policy: 'darwin-seatbelt-v1',
    },
    tasks: provisionalTasks.map(task => task.verificationTask),
    timeoutMilliseconds: plan.verification.timeoutMilliseconds,
  });
  const calibratedTasks = [];
  const qualificationTasks: MatchedTokenEfficiencyQualificationReceiptV1['tasks'][number][] = [];
  for (const task of provisionalTasks) {
    const root = await realpath(await mkdtemp(join(plan.adapter.temporaryRoot, '.verification-calibration-')));
    try {
      const baseReceipt = await runMatchedEvaluationDeterministicVerifierV1({
        artifactHash: task.base.fixtureHash,
        plan: provisionalPlan,
        repositoryRoot: task.baseDirectory,
        root: join(root, 'base'),
        taskId: task.task.taskId,
      });
      const fixReceipt = await runMatchedEvaluationDeterministicVerifierV1({
        artifactHash: task.fix.fixtureHash,
        plan: provisionalPlan,
        repositoryRoot: task.fixDirectory,
        root: join(root, 'fix'),
        taskId: task.task.taskId,
      });
      if (baseReceipt.status !== 'task-failed' || fixReceipt.status !== 'passed') {
        throw new Error(`Verification calibration did not fail at base and pass at fix for ${task.task.taskId}.`);
      }
      qualificationTasks.push(
        await qualifyMatchedEvaluationKnownFixV1({
          base: task.base,
          dependencyProjection: dependencyProjections.find(projection => projection.taskId === task.task.taskId),
          fix: task.fix,
          fixDirectory: task.fixDirectory,
          plan,
          root: join(root, 'qualification'),
          task: task.task,
        }),
      );
      calibratedTasks.push({
        calibration: createMatchedEvaluationVerificationCalibrationV1({
          baseDiagnosticHash: baseReceipt.diagnosticHash,
          baseExitCode: 1,
          baseRepositoryFixtureHash: task.base.fixtureHash,
          baseRevision: task.base.revision,
          fixDiagnosticHash: fixReceipt.diagnosticHash,
          fixExitCode: 0,
          fixRepositoryFixtureHash: task.fix.fixtureHash,
          fixRevision: task.fix.revision,
        }),
        selector: task.task.selector,
        taskId: task.task.taskId,
        verificationId: matchedEvaluationVerificationIdV1(task.task.taskId, task.task.selector),
      });
    } finally {
      await rm(root, {force: true, recursive: true});
    }
  }
  const verificationPlan = createMatchedEvaluationVerificationPlanV1({
    environmentDirectory,
    environmentHash,
    interpreter: plan.verification.interpreter,
    interpreterHash,
    runner: plan.verification.runner,
    runnerHash,
    sandbox: {
      executable: plan.verification.sandboxExecutable,
      executableHash: sandboxExecutableHash,
      policy: 'darwin-seatbelt-v1',
    },
    tasks: calibratedTasks,
    timeoutMilliseconds: plan.verification.timeoutMilliseconds,
  });
  const qualificationWithoutHash = {
    tasks: qualificationTasks.sort((left, right) => left.taskId.localeCompare(right.taskId)),
    version: 1 as const,
  };
  return {
    qualificationReceipt: {
      ...qualificationWithoutHash,
      receiptHash: digest('matched-token-efficiency-known-fix-qualification-v1', qualificationWithoutHash),
    },
    verificationPlan,
  };
}

async function qualifyMatchedEvaluationKnownFixV1(input: {
  readonly base: MatchedEvaluationRepositoryObservationV1;
  readonly dependencyProjection?: MatchedEvaluationDependencyProjectionV1;
  readonly fix: MatchedEvaluationRepositoryObservationV1;
  readonly fixDirectory: string;
  readonly plan: PreparationPlanV1;
  readonly root: string;
  readonly task: PreparationPlanV1['verification']['tasks'][number];
}): Promise<MatchedTokenEfficiencyQualificationReceiptV1['tasks'][number]> {
  const ancestry = await captureGit(
    input.fixDirectory,
    ['merge-base', '--is-ancestor', input.base.revision, input.fix.revision],
    true,
  );
  if (ancestry.exitCode !== 0) {
    throw new Error(`Known fix for ${input.task.taskId} must descend from the held-out base revision.`);
  }
  const changedPaths = await matchedEvaluationChangedPathsV1(
    input.plan.adapter.gitExecutable,
    input.fixDirectory,
    input.base.revision,
    input.fix.revision,
  );
  const appliedPaths = changedPaths.filter(path => !input.task.protectedPaths.some(root => protectedPath(root, path)));
  if (appliedPaths.length === 0) {
    throw new Error(`Known fix for ${input.task.taskId} has no production change outside protected paths.`);
  }

  let worktreeCreated = false;
  try {
    await captureGit(input.fixDirectory, ['worktree', 'add', '--detach', input.root, input.base.revision]);
    worktreeCreated = true;
    const patch = await captureCodeMemoryLinkProcessGroup({
      arguments: [
        '-C',
        input.fixDirectory,
        'diff',
        '--binary',
        '--no-ext-diff',
        '--no-renames',
        input.base.revision,
        input.fix.revision,
        '--',
        ...appliedPaths,
      ],
      command: input.plan.adapter.gitExecutable,
      cwd: input.fixDirectory,
      environment: qualificationGitEnvironment(),
      label: `Known-fix production patch ${input.task.taskId}`,
      maxOutputBytes: 32 * 1_024 * 1_024,
      timeoutMilliseconds: 60_000,
    });
    if (patch.stdout.length === 0) throw new Error(`Known fix for ${input.task.taskId} produced an empty patch.`);
    await captureCodeMemoryLinkProcessGroup({
      arguments: ['-C', input.root, 'apply', '--binary', '-'],
      command: input.plan.adapter.gitExecutable,
      cwd: input.root,
      environment: qualificationGitEnvironment(),
      label: `Known-fix production-only application ${input.task.taskId}`,
      maxOutputBytes: 1 * 1_024 * 1_024,
      stdin: patch.stdout,
      timeoutMilliseconds: 60_000,
    });
    const materializedPaths = await matchedEvaluationChangedPathsV1(
      input.plan.adapter.gitExecutable,
      input.root,
      input.base.revision,
    );
    if (JSON.stringify(materializedPaths) !== JSON.stringify(appliedPaths)) {
      throw new Error(`Known-fix production-only patch differs from its admitted paths for ${input.task.taskId}.`);
    }
    if (input.dependencyProjection !== undefined) {
      await materializeMatchedEvaluationDependencyProjectionV1({
        projection: input.dependencyProjection,
        repositoryRoot: input.root,
      });
    }

    const commands = [];
    for (const [commandIndex, tokens] of input.task.qualificationCommands.entries()) {
      const executableIndex = tokens.findIndex(token => !token.includes('='));
      const executableName = tokens[executableIndex];
      const executables = input.plan.adapter.safeBinaries.filter(path => basename(path) === executableName);
      if (executables.length !== 1) {
        throw new Error(
          `Qualification command ${commandIndex} for ${input.task.taskId} must resolve to one pinned safe binary.`,
        );
      }
      const environment: Record<string, string> = {
        CI: '1',
        HOME: '/nonexistent',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        NO_COLOR: '1',
        PATH: input.plan.adapter.safeExecutablePath,
      };
      for (const assignment of tokens.slice(0, executableIndex)) {
        const separator = assignment.indexOf('=');
        environment[assignment.slice(0, separator)] = assignment.slice(separator + 1);
      }
      const result = await captureCodeMemoryLinkProcessGroup({
        allowFailure: true,
        arguments: tokens.slice(executableIndex + 1),
        command: executables[0],
        cwd: input.root,
        environment,
        label: `Known-fix qualification command ${input.task.taskId}/${commandIndex}`,
        maxOutputBytes: 8 * 1_024 * 1_024,
        timeoutMilliseconds: input.plan.verification.timeoutMilliseconds,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Known-fix qualification command ${commandIndex} failed for ${input.task.taskId} with exit code ${result.exitCode}.`,
        );
      }
      commands.push({
        commandHash: digest('matched-token-efficiency-qualification-command-v1', {tokens}),
        diagnosticHash: sha256(Buffer.from(`${result.stdout}\0${result.stderr}`)),
        exitCode: 0 as const,
      });
    }
    const finalPaths = await matchedEvaluationChangedPathsV1(
      input.plan.adapter.gitExecutable,
      input.root,
      input.base.revision,
    );
    if (JSON.stringify(finalPaths) !== JSON.stringify(appliedPaths)) {
      throw new Error(`Qualification commands changed the production-only candidate for ${input.task.taskId}.`);
    }
    return {
      appliedPaths,
      baseFixtureHash: input.base.fixtureHash,
      baseRevision: input.base.revision,
      commands,
      fixRevision: input.fix.revision,
      fixFixtureHash: input.fix.fixtureHash,
      protectedPaths: input.task.protectedPaths,
      taskId: input.task.taskId,
    };
  } finally {
    if (worktreeCreated) {
      await captureGit(input.fixDirectory, ['worktree', 'remove', '--force', input.root]);
    }
  }
}

async function matchedEvaluationChangedPathsV1(
  gitExecutable: string,
  repository: string,
  fromRevision: string,
  toRevision?: string,
): Promise<readonly string[]> {
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      '-C',
      repository,
      'diff',
      '--name-only',
      '--no-ext-diff',
      '--no-renames',
      '-z',
      fromRevision,
      ...(toRevision === undefined ? [] : [toRevision]),
      '--',
    ],
    command: gitExecutable,
    cwd: repository,
    environment: qualificationGitEnvironment(),
    label: 'Known-fix changed paths',
    maxOutputBytes: 4 * 1_024 * 1_024,
    timeoutMilliseconds: 60_000,
  });
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((path, index) => safePlanRelativePath(path, `known-fix changed path ${index}`))
    .sort();
}

function protectedPath(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function qualificationGitEnvironment(): Readonly<Record<string, string>> {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: '/nonexistent',
    PATH: '/usr/bin:/bin',
  };
}

async function assertVerificationPlanUnchanged(plan: MatchedEvaluationVerificationPlanV1): Promise<void> {
  const [environmentHash, interpreterHash, runnerHash, sandboxHash] = await Promise.all([
    matchedEvaluationVerifierEnvironmentHashV1(plan.environmentDirectory),
    hashLinkedExecutable(plan.interpreter, 'verification interpreter'),
    hashCanonicalFile(plan.runner, false, 'verification runner'),
    hashCanonicalFile(plan.sandbox.executable, true, 'verification sandbox executable'),
  ]);
  if (
    environmentHash !== plan.environmentHash ||
    interpreterHash !== plan.interpreterHash ||
    runnerHash !== plan.runnerHash ||
    sandboxHash !== plan.sandbox.executableHash
  ) {
    throw new Error('A pinned verification input changed during preparation.');
  }
}

async function prepareTasks(input: {
  readonly clusterObservations: ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>;
  readonly corpus: MatchedEvaluationCorpusV1;
  readonly manifest: ReturnType<typeof createMatchedEvaluationManifestV1>;
  readonly plan: PreparationPlanV1;
  readonly readAgentContextBrief: PreparationDependenciesV1['readAgentContextBrief'];
}): Promise<readonly PreparedTask[]> {
  const prepared: PreparedTask[] = [];
  const linkedHomes = new Set<string>();
  for (const planContext of [...input.plan.taskContexts].sort((left, right) =>
    left.taskId.localeCompare(right.taskId),
  )) {
    const task = required(
      input.corpus.tasks.find(candidate => candidate.taskId === planContext.taskId),
      `task ${planContext.taskId}`,
    );
    const manifestTask = required(
      input.manifest.tasks.find(candidate => candidate.taskId === planContext.taskId),
      `manifest task ${planContext.taskId}`,
    );
    const cluster = required(
      input.plan.clusters.find(candidate => candidate.clusterId === planContext.clusterId),
      `cluster ${planContext.clusterId}`,
    );
    const observation = required(
      input.clusterObservations.get(planContext.clusterId),
      `cluster ${planContext.clusterId}`,
    );
    const graphHome = await canonicalDirectory(planContext.graphHomeDirectory, `task ${task.taskId} graph-only home`);
    const linkedHome = await canonicalDirectory(planContext.linkedHomeDirectory, `task ${task.taskId} linked home`);
    if (graphHome === linkedHome) throw new Error(`Task ${task.taskId} graph-only and linked homes must differ.`);
    if (linkedHomes.has(linkedHome)) throw new Error('Every task requires its own independently reviewed linked home.');
    linkedHomes.add(linkedHome);
    const graphMemories = await collectMemoryDocuments(graphHome, input.plan.project);
    if (graphMemories.length !== 0) throw new Error(`Task ${task.taskId} graph-only home contains memories.`);
    const linkedRecords = await collectMemoryDocuments(linkedHome, input.plan.project);
    const linkedMemories = linkedRecords.filter(memory => memory.metadata.kind === 'durable');
    const linkedHandoffs = linkedRecords.filter(memory => memory.metadata.kind === 'handoff');
    if (linkedRecords.length !== linkedMemories.length + linkedHandoffs.length) {
      throw new Error(`Task ${task.taskId} linked home contains an unsupported memory kind.`);
    }
    const preparedHandoffTopics = linkedHandoffs
      .map(memory => memory.metadata.topic)
      .sort((left, right) => String(left).localeCompare(String(right)));
    const expectedHandoffTopics = [...planContext.activeHandoffTopics].sort((left, right) => left.localeCompare(right));
    if (
      preparedHandoffTopics.some(topic => topic === undefined) ||
      JSON.stringify(preparedHandoffTopics) !== JSON.stringify(expectedHandoffTopics)
    ) {
      throw new Error(`Task ${task.taskId} linked home handoffs differ from the preparation plan.`);
    }
    await assertContextCheckClean(input.plan, cluster, linkedHome);
    const [graphIdentity, linkedIdentity] = await Promise.all([
      graphIdentityForHome(input.plan, cluster, graphHome, observation),
      graphIdentityForHome(input.plan, cluster, linkedHome, observation),
    ]);
    if (JSON.stringify(graphIdentity) !== JSON.stringify(linkedIdentity)) {
      throw new Error(`Task ${task.taskId} graph-only and linked homes do not share the exact ready graph.`);
    }
    await assertGraphOnlyContextHasNoMemory(input.plan, cluster, graphHome, task.prompt);
    await assertLinkedContextSurfacesMemories(
      input.plan,
      cluster,
      linkedHome,
      task.prompt,
      task.taskId,
      linkedMemories,
      planContext.activeHandoffTopics,
      input.readAgentContextBrief,
    );
    const linkReceipts = linkReceiptsForTask(
      task,
      linkedMemories,
      planContext.linkedMemoryIdentities,
      observation,
      linkedIdentity,
    );
    const graphContentHash = matchedTokenEfficiencyGraphContentHashV1(graphIdentity.graphContentId);
    const graphSnapshotHash = matchedTokenEfficiencyGraphSnapshotHashV1(graphIdentity.snapshotId);
    const taskContext = createMatchedTokenEfficiencyTaskContextV1({
      asIssuedContext: await prepareAsIssuedContext(planContext),
      clusterId: planContext.clusterId,
      graphContentHash,
      graphSnapshotHash,
      linkReceipts,
      memoryFixtureHash: manifestTask.memoryFixtureHash,
      repositoryFixtureHash: observation.fixtureHash,
      taskId: task.taskId,
    });
    const [graphHomeFixtureHash, linkedHomeFixtureHash] = await Promise.all([
      matchedEvaluationPreparedHomeFixtureHashV1(graphHome),
      matchedEvaluationPreparedHomeFixtureHashV1(linkedHome),
    ]);
    prepared.push({
      graphHome: {
        expectedContext: {
          graphContentHash,
          graphSnapshotHash,
          linkReceiptsHash: null,
          memoryAccess: 'disabled',
          taskContextHash: null,
        },
        homeDirectory: graphHome,
        homeFixtureHash: graphHomeFixtureHash,
        identity: {account: input.plan.threadnote.account, user: input.plan.threadnote.user},
        project: input.plan.project,
        taskId: task.taskId,
      },
      linkedHome: {
        expectedContext: {
          graphContentHash,
          graphSnapshotHash,
          linkReceiptsHash: taskContext.linkReceiptsHash,
          memoryAccess: 'linked',
          taskContextHash: taskContext.taskContextHash,
        },
        homeDirectory: linkedHome,
        homeFixtureHash: linkedHomeFixtureHash,
        identity: {account: input.plan.threadnote.account, user: input.plan.threadnote.user},
        project: input.plan.project,
        taskId: task.taskId,
      },
      taskContext,
    });
  }
  return prepared;
}

async function prepareDependencyProjections(
  plan: PreparationPlanV1,
): Promise<readonly MatchedEvaluationDependencyProjectionV1[]> {
  return await Promise.all(
    (plan.adapter.dependencyProjections ?? []).map(async projection => {
      const task = required(
        plan.taskContexts.find(candidate => candidate.taskId === projection.taskId),
        `dependency projection task ${projection.taskId}`,
      );
      const cluster = required(
        plan.clusters.find(candidate => candidate.clusterId === task.clusterId),
        `dependency projection cluster ${task.clusterId}`,
      );
      const sourceRepositoryDirectory = await canonicalDirectory(
        cluster.repositoryDirectory,
        `dependency projection repository ${projection.taskId}`,
      );
      const sourceDirectory = await canonicalDirectory(
        projection.sourceDirectory,
        `dependency projection source ${projection.taskId}`,
      );
      const sourceFromRepository = relative(sourceRepositoryDirectory, sourceDirectory);
      if (
        !sourceFromRepository ||
        sourceFromRepository === '..' ||
        sourceFromRepository.startsWith(`..${sep}`) ||
        isAbsolute(sourceFromRepository)
      ) {
        throw new Error(`Dependency projection source for ${projection.taskId} escapes its repository.`);
      }
      const lockFile = containedPath(sourceRepositoryDirectory, projection.lockFileRelativePath);
      return {
        architecture: process.arch,
        fixtureHash: await matchedEvaluationDependencyProjectionFixtureHashV1(
          sourceDirectory,
          sourceRepositoryDirectory,
        ),
        lockFileRelativePath: projection.lockFileRelativePath,
        lockFileSha256: await hashCanonicalFile(lockFile, false, `dependency lock file ${projection.taskId}`),
        platform: process.platform,
        sourceDirectory,
        sourceRepositoryDirectory,
        targetRelativePath: projection.targetRelativePath,
        taskId: projection.taskId,
      };
    }),
  );
}

function createAdapterConfigs(input: {
  readonly dependencyProjections: readonly MatchedEvaluationDependencyProjectionV1[];
  readonly plan: PreparationPlanV1;
  readonly prepared: readonly PreparedTask[];
  readonly runtimeFileHashes: ReadonlyMap<string, string>;
  readonly verificationPlan: MatchedEvaluationVerificationPlanV1;
}): readonly [MatchedEvaluationArm, MatchedEvaluationCodexAdapterConfigV1][] {
  return MATCHED_EVALUATION_ARMS.map(arm => {
    const contextHomes =
      arm === 'threadnote-graph'
        ? input.prepared.map(task => task.graphHome)
        : arm === 'threadnote-compact' || arm === 'threadnote-source'
          ? input.prepared.map(task => task.linkedHome)
          : [];
    const config = parseMatchedEvaluationCodexAdapterConfigV1({
      approvedCommands: input.plan.adapter.approvedCommands,
      appServer: {
        ...input.plan.adapter.appServer,
        executableSha256: required(
          input.runtimeFileHashes.get(input.plan.adapter.appServer.executable),
          'app-server executable hash',
        ),
      },
      arm,
      authSourcePath: input.plan.adapter.authSourcePath,
      contextBudgetTokens: input.plan.adapter.contextBudgetTokens,
      contextHomes,
      dependencyProjections: input.dependencyProjections,
      environmentPolicyHash:
        arm === 'reference-scope'
          ? matchedEvaluationReferenceEnvironmentPolicyHashV1()
          : matchedEvaluationCodexEnvironmentPolicyHashV1(),
      git: {
        executable: input.plan.adapter.gitExecutable,
        executableSha256: required(
          input.runtimeFileHashes.get(input.plan.adapter.gitExecutable),
          'Git executable hash',
        ),
      },
      judgeModel: modelConfiguration(input.plan.adapter.judgeModel),
      model: modelConfiguration(input.plan.adapter.model),
      pricingMicrosPerMillionTokens: input.plan.adapter.pricingMicrosPerMillionTokens,
      safeBinaries: input.plan.adapter.safeBinaries.map(path => ({
        path,
        sha256: required(input.runtimeFileHashes.get(path), `safe binary hash ${path}`),
      })),
      safeExecutablePath: input.plan.adapter.safeExecutablePath,
      taskBudget: input.plan.adapter.taskBudget,
      temporaryRoot: input.plan.adapter.temporaryRoot,
      verificationPlan: input.verificationPlan,
      version: MATCHED_EVALUATION_CODEX_ADAPTER_VERSION,
    });
    return [arm, config];
  });
}

function createRuntime(input: {
  readonly adapterExecutable: string;
  readonly clusterObservations: ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>;
  readonly outputRoot: string;
  readonly plan: PreparationPlanV1;
  readonly verificationPlanHash: string;
}): MatchedEvaluationRuntimeV1 {
  const runtimeArms: MatchedEvaluationRuntimeArmV1[] = [
    runtimeArm('files', input),
    runtimeArm('threadnote-graph', input),
    runtimeArm('threadnote-compact', input),
    runtimeArm('threadnote-source', input),
  ];
  return parseMatchedEvaluationRuntimeV1({
    arms: runtimeArms,
    artifactDirectory: resolve(input.outputRoot, 'artifacts'),
    repositories: input.plan.clusters.map(cluster => ({
      clusterId: cluster.clusterId,
      repositoryDirectory: cluster.repositoryDirectory,
      repositoryIdentityHash: required(input.clusterObservations.get(cluster.clusterId), cluster.clusterId)
        .identityHash,
    })),
    timeoutMilliseconds: input.plan.timeoutMilliseconds,
    verificationPlanHash: input.verificationPlanHash,
    version: MATCHED_EVALUATION_RUNTIME_VERSION,
  });
}

function runtimeArm(
  arm: Exclude<MatchedEvaluationArm, 'reference-scope'>,
  input: {
    readonly adapterExecutable: string;
    readonly outputRoot: string;
    readonly plan: PreparationPlanV1;
  },
): MatchedEvaluationRuntimeArmV1 {
  const threadnote = arm === 'files' ? null : input.plan.threadnote;
  return {
    adapterArguments: [],
    adapterConfigFile: resolve(input.outputRoot, 'adapter-config', `${arm}.json`),
    adapterExecutable: input.adapterExecutable,
    arm,
    environmentKeys: [],
    toolExecutable: threadnote?.executable ?? null,
    toolLockFile: threadnote?.lockFile ?? null,
  };
}

function armDefinitions(input: {
  readonly adapterArtifactHash: string;
  readonly productVersion:
    | typeof MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION
    | typeof MATCHED_TOKEN_EFFICIENCY_PRODUCTION_PRODUCT_VERSION
    | typeof MATCHED_TOKEN_EFFICIENCY_BETA_PRODUCT_VERSION;
  readonly configHashes: Readonly<Record<MatchedEvaluationArm, string>>;
  readonly referenceArtifactHash: string;
  readonly threadnoteArtifactHash: string;
  readonly threadnoteLockHash: string;
}): readonly MatchedEvaluationArmDefinitionV1[] {
  return MATCHED_EVALUATION_ARMS.map(arm => ({
    adapterArtifactHash: input.adapterArtifactHash,
    adapterConfigurationHash: input.configHashes[arm],
    adapterProtocol: MATCHED_EVALUATION_ADAPTER_PROTOCOL,
    arm,
    environmentPolicyHash:
      arm === 'reference-scope'
        ? matchedEvaluationReferenceEnvironmentPolicyHashV1()
        : matchedEvaluationCodexEnvironmentPolicyHashV1(),
    tool:
      arm === 'files'
        ? {artifactHash: null, lockIdentityHash: null, name: 'repository-files', version: 'builtin-v1'}
        : arm === 'reference-scope'
          ? {
              artifactHash: input.referenceArtifactHash,
              lockIdentityHash: input.referenceArtifactHash,
              name: 'unavailable-reference-scope',
              version: 'not-configured-v1',
            }
          : {
              artifactHash: input.threadnoteArtifactHash,
              lockIdentityHash: input.threadnoteLockHash,
              name: 'threadnote',
              version: input.productVersion,
            },
  }));
}

function placeholderArmDefinitions(): readonly MatchedEvaluationArmDefinitionV1[] {
  return armDefinitions({
    adapterArtifactHash: '1'.repeat(64),
    configHashes: Object.fromEntries(MATCHED_EVALUATION_ARMS.map(arm => [arm, '2'.repeat(64)])) as Readonly<
      Record<MatchedEvaluationArm, string>
    >,
    referenceArtifactHash: '3'.repeat(64),
    threadnoteArtifactHash: '4'.repeat(64),
    threadnoteLockHash: '5'.repeat(64),
    productVersion: MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION,
  });
}

async function graphIdentityForHome(
  plan: PreparationPlanV1,
  cluster: ClusterPlanV1,
  home: string,
  observation: MatchedEvaluationRepositoryObservationV1,
): Promise<{readonly graphContentId: string; readonly repositoryId: string; readonly snapshotId: string}> {
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'graph',
      'status',
      '--home',
      home,
      '--cwd',
      cluster.repositoryDirectory,
      '--project',
      plan.project,
      '--json',
    ],
    command: plan.threadnote.executable,
    cwd: cluster.repositoryDirectory,
    environment: threadnoteEnvironment(home, plan.adapter.safeExecutablePath, plan.threadnote),
    label: `Matched evaluation graph status ${cluster.clusterId}`,
    maxOutputBytes: 512 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  const parsed = JSON.parse(result.stdout) as unknown;
  const validated = assertCodeMemoryLinkGraphStatusPreflight(parsed, {
    commit: observation.revision,
    origin: cluster.repositoryUrl,
    repositoryRoot: cluster.repositoryDirectory,
  });
  const status = object(parsed, 'graph status');
  const identity = object(status.identity, 'graph repository identity');
  return {
    ...validated,
    repositoryId: boundedText(identity.repositoryId, 1, 256, 'graph repository id'),
  };
}

async function assertContextCheckClean(plan: PreparationPlanV1, cluster: ClusterPlanV1, home: string): Promise<void> {
  const result = await captureCodeMemoryLinkProcessGroup({
    allowFailure: true,
    arguments: ['context', 'check', '--home', home, '--project', plan.project, '--json'],
    command: plan.threadnote.executable,
    cwd: cluster.repositoryDirectory,
    environment: threadnoteEnvironment(home, plan.adapter.safeExecutablePath, plan.threadnote),
    label: `Matched evaluation context check ${cluster.clusterId}`,
    maxOutputBytes: 512 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  if (result.exitCode !== 0) throw new Error(`Linked home context check failed for ${cluster.clusterId}.`);
}

async function assertGraphOnlyContextHasNoMemory(
  plan: PreparationPlanV1,
  cluster: ClusterPlanV1,
  home: string,
  task: string,
): Promise<void> {
  const result = await captureCodeMemoryLinkProcessGroup({
    arguments: [
      'context',
      'brief',
      '--json',
      '--task',
      task,
      '--cwd',
      cluster.repositoryDirectory,
      '--home',
      home,
      '--project',
      plan.project,
      '--mode',
      'brief',
      '--detail',
      'compact',
      '--budget-tokens',
      String(plan.adapter.contextBudgetTokens),
    ],
    command: plan.threadnote.executable,
    cwd: cluster.repositoryDirectory,
    environment: threadnoteEnvironment(home, plan.adapter.safeExecutablePath, plan.threadnote),
    label: `Matched evaluation graph-only Context Brief ${cluster.clusterId}`,
    maxOutputBytes: 2 * 1_024 * 1_024,
    timeoutMilliseconds: 120_000,
  });
  const brief = object(JSON.parse(result.stdout) as unknown, 'graph-only Context Brief');
  if (brief.type !== 'context-brief' || (brief.version !== 2 && brief.version !== 3)) {
    throw new Error('Graph-only home did not return a supported Context Brief.');
  }
  if (!Array.isArray(brief.durableDecisions) || !Array.isArray(brief.activeHandoffs)) {
    throw new Error('Graph-only Context Brief is missing its memory evidence arrays.');
  }
  if (brief.durableDecisions.length !== 0 || brief.activeHandoffs.length !== 0) {
    throw new Error('Graph-only home exposes memory evidence for the preregistered task prompt.');
  }
}

async function assertLinkedContextSurfacesMemories(
  plan: PreparationPlanV1,
  cluster: ClusterPlanV1,
  home: string,
  task: string,
  taskId: string,
  memories: readonly MemoryRecord[],
  activeHandoffTopics: readonly string[],
  readAgentContextBrief: PreparationDependenciesV1['readAgentContextBrief'],
): Promise<void> {
  const topics = memories.map(memory => memory.metadata.topic);
  if (
    topics.some(topic => topic === undefined) ||
    new Set(topics).size !== topics.length ||
    memories.some(memory => memory.headerTitle !== 'MEMORY' || memory.metadata.kind !== 'durable')
  ) {
    throw new Error(`Task ${taskId} linked home requires unique durable memory topics.`);
  }
  const brief = await readAgentContextBrief({
    budgetTokens: plan.adapter.contextBudgetTokens,
    callerCwd: cluster.repositoryDirectory,
    executable: plan.threadnote.executable,
    home,
    identity: plan.threadnote,
    project: plan.project,
    safeExecutablePath: plan.adapter.safeExecutablePath,
    task,
  });
  assertMatchedTokenEfficiencyLinkedBriefV1(
    brief,
    plan.project,
    taskId,
    topics as readonly string[],
    activeHandoffTopics,
  );
}

async function readAgentContextBriefViaMcp(
  request: MatchedTokenEfficiencyAgentContextBriefRequestV1,
): Promise<unknown> {
  const client = new Client({name: 'matched-token-efficiency-preparer', version: '1'});
  const transport = new StdioClientTransport({
    command: request.executable,
    args: ['mcp-server', '--home', request.home],
    cwd: request.callerCwd,
    env: {
      ...threadnoteEnvironment(request.home, request.safeExecutablePath, request.identity),
      LOGNAME: request.identity.user,
      SHELL: '/bin/sh',
      TERM: 'dumb',
      USER: request.identity.user,
    },
    maxBufferSize: 2 * 1_024 * 1_024,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => undefined);
  try {
    await client.connect(transport, {timeout: 30_000});
    const result = await client.callTool(
      {
        arguments: {
          budgetTokens: request.budgetTokens,
          callerCwd: request.callerCwd,
          detail: 'compact',
          mode: 'brief',
          project: request.project,
          responseFormat: 'dual',
          task: request.task,
        },
        name: 'context_brief',
      },
      undefined,
      {timeout: 120_000},
    );
    return parseMatchedTokenEfficiencyAgentContextBriefResultV1(result);
  } finally {
    await client.close();
    await transport.close();
  }
}

export function parseMatchedTokenEfficiencyAgentContextBriefResultV1(value: unknown): unknown {
  const result = object(value, 'agent Context Brief tool result');
  if (result.isError === true) throw new Error('Agent Context Brief tool call returned an error.');
  if (result.structuredContent !== undefined) {
    const structured = object(result.structuredContent, 'agent Context Brief structured content');
    if (structured.type !== 'context-brief' || (structured.version !== 2 && structured.version !== 3)) {
      throw new Error('Agent Context Brief structured content is not canonical.');
    }
    return structured;
  }
  if (!Array.isArray(result.content)) throw new Error('Agent Context Brief tool result is missing content.');
  const text = result.content.flatMap((entry, index) => {
    const content = object(entry, `agent Context Brief content ${index}`);
    return content.type === 'text' && typeof content.text === 'string' ? [content.text] : [];
  });
  if (text.length !== 1) throw new Error('Agent Context Brief tool result must contain exactly one text payload.');
  try {
    return JSON.parse(text[0]) as unknown;
  } catch (cause) {
    throw new Error('Agent Context Brief tool result contains invalid JSON.', {cause});
  }
}

export function assertMatchedTokenEfficiencyLinkedBriefV1(
  value: unknown,
  project: string,
  taskId: string,
  expectedTopics: readonly string[],
  expectedHandoffTopics: readonly string[] = [],
): void {
  const brief = object(value, 'linked-memory Context Brief');
  const isAgentView = brief.type === 'context-brief-agent-view' && brief.version === 1 && brief.briefVersion === 2;
  const isCanonicalBrief = brief.type === 'context-brief' && (brief.version === 2 || brief.version === 3);
  if (!isAgentView && !isCanonicalBrief) {
    throw new Error('Linked home did not return a supported Context Brief.');
  }
  const durableDecisions = brief.durableDecisions ?? (isAgentView ? [] : undefined);
  const activeHandoffs = brief.activeHandoffs ?? (isAgentView ? [] : undefined);
  if (!Array.isArray(durableDecisions) || !Array.isArray(activeHandoffs)) {
    throw new Error('Linked-memory Context Brief is missing its memory evidence arrays.');
  }
  const surfacedHandoffTopics = isAgentView
    ? agentViewMemoryTopics(activeHandoffs, 'handoff', project, taskId)
    : activeHandoffs.map((entry, index) => {
        const handoff = object(entry, `linked-memory Context Brief handoff ${index}`);
        if (handoff.kind !== 'handoff' || handoff.project !== project) {
          throw new Error(`Task ${taskId} linked-memory Context Brief exposes an unexpected handoff.`);
        }
        return boundedText(handoff.topic, 1, 512, `linked-memory Context Brief handoff ${index} topic`);
      });
  const expectedHandoffs = [...expectedHandoffTopics].sort((left, right) => left.localeCompare(right));
  const surfacedHandoffs = [...surfacedHandoffTopics].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(surfacedHandoffs) !== JSON.stringify(expectedHandoffs)) {
    throw new Error(`Task ${taskId} linked-memory Context Brief exposes an unexpected handoff.`);
  }
  const surfacedTopics = isAgentView
    ? agentViewMemoryTopics(durableDecisions, 'durable', project, taskId)
    : durableDecisions.map((entry, index) => {
        const decision = object(entry, `linked-memory Context Brief decision ${index}`);
        if (decision.kind !== 'durable' || decision.project !== project) {
          throw new Error(`Task ${taskId} linked-memory Context Brief exposes an unexpected memory.`);
        }
        return boundedText(decision.topic, 1, 512, `linked-memory Context Brief decision ${index} topic`);
      });
  const expected = [...expectedTopics].sort((left, right) => left.localeCompare(right));
  const surfaced = [...surfacedTopics].sort((left, right) => left.localeCompare(right));
  const durableRosterIsValid =
    expectedHandoffTopics.length === 0
      ? JSON.stringify(surfaced) === JSON.stringify(expected)
      : surfaced.every(topic => expected.includes(topic));
  if (!durableRosterIsValid) {
    throw new Error(`Task ${taskId} exact prompt does not surface its complete reviewed memory roster.`);
  }
}

function agentViewMemoryTopics(
  entries: readonly unknown[],
  kind: 'durable' | 'handoff',
  project: string,
  taskId: string,
): readonly string[] {
  const namespace =
    kind === 'durable' ? `/memories/durable/projects/${project}/` : `/memories/handoffs/active/${project}/`;
  return entries.map((entry, index) => {
    const memory = object(entry, `linked-memory agent Context Brief ${kind} ${index}`);
    const uri = boundedText(memory.uri, 1, 4_096, `linked-memory agent Context Brief ${kind} ${index} URI`);
    const namespaceIndex = uri.indexOf(namespace);
    const topicPath = namespaceIndex === -1 ? '' : uri.slice(namespaceIndex + namespace.length);
    if (
      !uri.startsWith('threadnote://user/') ||
      namespaceIndex === -1 ||
      !topicPath.endsWith('.md') ||
      topicPath.length <= 3 ||
      topicPath.slice(0, -3).includes('/')
    ) {
      throw new Error(`Task ${taskId} linked-memory Context Brief exposes an unexpected ${kind}.`);
    }
    return topicPath.slice(0, -3);
  });
}

function linkReceiptsForTask(
  task: MatchedEvaluationCorpusV1['tasks'][number],
  memories: readonly MemoryRecord[],
  linkedMemoryIdentities: readonly LinkedMemoryIdentityPlanV1[],
  observation: MatchedEvaluationRepositoryObservationV1,
  graphIdentity: {readonly graphContentId: string; readonly repositoryId: string; readonly snapshotId: string},
): MatchedTokenEfficiencyTaskContextV1['linkReceipts'] {
  if (memories.length !== task.memoryFixtures.length) {
    throw new Error(`Task ${task.taskId} linked home does not contain exactly its preregistered memories.`);
  }
  if (
    linkedMemoryIdentities.length !== task.memoryFixtures.length ||
    task.memoryFixtures.some(
      fixture => !linkedMemoryIdentities.some(identity => identity.fixtureMemoryId === fixture.memoryId),
    )
  ) {
    throw new Error(`Task ${task.taskId} linked-memory identity roster differs from its corpus fixtures.`);
  }
  const used = new Set<MemoryRecord>();
  const receipts = task.memoryFixtures.flatMap(fixture => {
    const plannedIdentity = required(
      linkedMemoryIdentities.find(identity => identity.fixtureMemoryId === fixture.memoryId),
      `managed memory identity for ${fixture.memoryId}`,
    );
    const candidates = memories.filter(
      memory =>
        memory.body === fixture.text &&
        memory.metadata.status === fixture.status &&
        memory.metadata.memoryId === plannedIdentity.managedMemoryId,
    );
    if (candidates.length !== 1 || used.has(candidates[0])) {
      throw new Error(`Task ${task.taskId} memory ${fixture.memoryId} is missing or ambiguous in its linked home.`);
    }
    const memory = candidates[0];
    used.add(memory);
    if (fixture.source === null) return [];
    const citations = (memory.metadata.codeCitations ?? []).filter(citation => citation.path === fixture.source?.path);
    if (citations.length !== 1) {
      throw new Error(`Task ${task.taskId} memory ${fixture.memoryId} lacks one exact source citation.`);
    }
    const citation = citations[0];
    if (
      citation.sourceCommit !== observation.revision ||
      citation.sourceDirty !== false ||
      citation.repositoryId !== graphIdentity.repositoryId ||
      citation.repositoryIdentityKind !== 'remote' ||
      citation.sourceSnapshotId !== graphIdentity.snapshotId ||
      citation.sourceGraphContentId !== graphIdentity.graphContentId ||
      citation.target.kind !== 'file'
    ) {
      throw new Error(`Task ${task.taskId} memory ${fixture.memoryId} citation is not from the held-out revision.`);
    }
    return [
      {
        citationHash: matchedTokenEfficiencyCitationHashV1({
          citationId: citation.id,
          fixtureMemoryId: fixture.memoryId,
          managedMemoryId: plannedIdentity.managedMemoryId,
        }),
        memoryId: fixture.memoryId,
        status: 'exact' as const,
      },
    ];
  });
  return receipts.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
}

async function collectMemoryDocuments(home: string, project: string): Promise<readonly MemoryRecord[]> {
  const files = await walkFiles(home);
  const records: MemoryRecord[] = [];
  for (const file of files) {
    const normalized = relative(home, file).replaceAll('\\', '/');
    if (!normalized.endsWith('.md') || !normalized.split('/').includes('memories')) continue;
    const parsed = parseMemoryDocument(
      `threadnote://user/evaluation/memories/durable/projects/${project}/prepared-${records.length}.md`,
      await readFile(file, 'utf8'),
    );
    if (parsed === undefined || parsed.metadata.project !== project) {
      throw new Error('Prepared Threadnote home contains a memory outside the preregistered project.');
    }
    records.push(parsed);
  }
  return records;
}

async function prepareAsIssuedContext(
  task: TaskContextPlanV1,
): Promise<MatchedTokenEfficiencyTaskContextV1['asIssuedContext']> {
  const assessment = await readCanonicalFile(task.asIssuedContext.assessmentFile, false, 'context assessment');
  if (task.asIssuedContext.sufficiency === 'none') {
    if (task.asIssuedContext.contentFile !== null)
      throw new Error('A none context classification must not supply content.');
    return {assessmentHash: sha256(assessment), contentHash: null, sufficiency: 'none', suppliedBytes: 0};
  }
  if (task.asIssuedContext.contentFile === null) throw new Error('Supplied manual context requires a content file.');
  const content = await readCanonicalFile(task.asIssuedContext.contentFile, false, 'as-issued context');
  if (content.byteLength === 0) throw new Error('Supplied manual context must not be empty.');
  return {
    assessmentHash: sha256(assessment),
    contentHash: sha256(content),
    sufficiency: task.asIssuedContext.sufficiency,
    suppliedBytes: content.byteLength,
  };
}

async function assertThreadnoteSourceAndExecutable(input: PreparationPlanV1['threadnote']): Promise<{
  readonly productionRelease: MatchedTokenEfficiencyProductionReleaseV1 | null;
  readonly sourceCommit: string;
  readonly version:
    | typeof MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION
    | typeof MATCHED_TOKEN_EFFICIENCY_PRODUCTION_PRODUCT_VERSION
    | typeof MATCHED_TOKEN_EFFICIENCY_BETA_PRODUCT_VERSION;
}> {
  const [sourceDirectory, executable] = await Promise.all([
    canonicalDirectory(input.sourceDirectory, 'Threadnote source directory'),
    canonicalRegularFile(input.executable, true, 'Threadnote executable'),
  ]);
  const status = await captureGit(sourceDirectory, ['status', '--porcelain=v1']);
  if (status.stdout !== '') throw new Error('Threadnote source checkout must be clean.');
  const head = singleLine(
    (await captureGit(sourceDirectory, ['rev-parse', 'HEAD'])).stdout,
    'Threadnote source commit',
  );
  if (!COMMIT.test(head)) throw new Error('Threadnote source commit is invalid.');
  const productionRelease = input.productionRelease;
  if (productionRelease !== undefined) {
    validateProductionRelease(productionRelease);
  }
  const requiredReleaseCommit = matching(
    input.requiredReleaseCommit,
    COMMIT,
    productionRelease === undefined ? 'required local release commit' : 'required 5.0.7 release commit',
  );
  const ancestry = await captureGit(
    sourceDirectory,
    ['merge-base', '--is-ancestor', requiredReleaseCommit, head],
    true,
  );
  if (productionRelease !== undefined) {
    if (head !== productionRelease.sourceCommit || requiredReleaseCommit !== productionRelease.sourceCommit)
      throw new Error(
        'Production source HEAD and required release commit must equal the immutable release source commit.',
      );
  } else if (ancestry.exitCode !== 0) {
    throw new Error('Threadnote source commit does not contain the required local release commit.');
  }
  const packageVersion = JSON.parse(await readFile(join(sourceDirectory, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  const expectedVersion = (() => {
    if (productionRelease !== undefined) return MATCHED_TOKEN_EFFICIENCY_PRODUCTION_PRODUCT_VERSION;
    if (
      packageVersion.version === MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION ||
      packageVersion.version === MATCHED_TOKEN_EFFICIENCY_BETA_PRODUCT_VERSION
    ) {
      return packageVersion.version;
    }
    throw new Error(
      `Threadnote source checkout is not version ${MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION} or ${MATCHED_TOKEN_EFFICIENCY_BETA_PRODUCT_VERSION}.`,
    );
  })();
  if (packageVersion.version !== expectedVersion) {
    throw new Error(`Threadnote source checkout is not version ${expectedVersion}.`);
  }
  const version = await captureCodeMemoryLinkProcessGroup({
    arguments: ['--version'],
    command: executable,
    cwd: sourceDirectory,
    environment: {HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin'},
    label: `Threadnote ${expectedVersion} version`,
    maxOutputBytes: 16 * 1_024,
    timeoutMilliseconds: 30_000,
  });
  if (productionRelease === undefined) {
    if (expectedVersion === MATCHED_TOKEN_EFFICIENCY_PRODUCTION_PRODUCT_VERSION) {
      throw new Error('Local Threadnote preparation resolved an invalid production-only version.');
    }
    assertMatchedTokenEfficiencyThreadnoteVersionOutputV1(version.stdout, head, expectedVersion);
  } else {
    assertMatchedTokenEfficiencyProductionReleaseV1(
      version.stdout,
      head,
      sha256(await readFile(executable)),
      productionRelease,
    );
    if (
      (await hashCanonicalFile(input.lockFile, false, 'production release archive')) !== productionRelease.archiveSha256
    ) {
      throw new Error('Production tool lock must be the exact immutable release archive.');
    }
  }
  return {productionRelease: productionRelease ?? null, sourceCommit: head, version: expectedVersion};
}

export function assertMatchedTokenEfficiencyProductionReleaseV1(
  versionOutput: string,
  sourceCommit: string,
  executableSha256: string,
  release: MatchedTokenEfficiencyProductionReleaseV1,
): void {
  validateProductionRelease(release);
  // Production --version does not embed a commit. Identity comes from the
  // reviewed immutable release's exact binary digest and tag-to-commit binding.
  if (!PRODUCTION_VERSION_OUTPUT.test(versionOutput) || sourceCommit !== release.sourceCommit)
    throw new Error('Threadnote executable is not the exact production 5.0.7 build.');
  if (executableSha256 !== release.executableSha256)
    throw new Error('Threadnote executable hash differs from immutable production provenance.');
}

function validateProductionRelease(value: MatchedTokenEfficiencyProductionReleaseV1): void {
  if (
    value.version !== MATCHED_TOKEN_EFFICIENCY_PRODUCTION_PRODUCT_VERSION ||
    value.sourceCommit !== PRODUCTION_SOURCE_COMMIT ||
    value.releaseUrl !== PRODUCTION_RELEASE_URL ||
    value.archiveUrl !== PRODUCTION_ARCHIVE_URL ||
    value.immutable !== true ||
    value.executableSha256 !== 'e8cef51bc029705614928c7ea69a5cb39e1b05f43f272ca495a947f5d5e32c15' ||
    value.archiveSha256 !== 'c234c12d56807fdd94ad0ffbfceafb45140ee73304fc6399da65051a35670fb1'
  )
    throw new Error('Production release provenance is not the pinned immutable v5.0.7 record.');
}

export function assertMatchedTokenEfficiencyThreadnoteVersionOutputV1(
  output: string,
  sourceCommit: string,
  productVersion:
    | typeof MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION
    | typeof MATCHED_TOKEN_EFFICIENCY_BETA_PRODUCT_VERSION = MATCHED_TOKEN_EFFICIENCY_REQUIRED_PRODUCT_VERSION,
): void {
  const expectedCommit = matching(sourceCommit, COMMIT, 'Threadnote source commit');
  const localSeparator = productVersion === MATCHED_TOKEN_EFFICIENCY_BETA_PRODUCT_VERSION ? '.local.g' : '-local.g';
  const prefix = `threadnote v${productVersion}${localSeparator}`;
  const expectedOutput = `${prefix}${expectedCommit}`;
  if (!output.trim().startsWith(prefix)) {
    throw new Error(`Threadnote executable must be an exact commit-reporting ${productVersion} local build.`);
  }
  if (output.trim() !== expectedOutput) {
    throw new Error('Threadnote local executable source commit differs from the reviewed source checkout.');
  }
}

function parsePreparationPlanV1(value: unknown): PreparationPlanV1 {
  const plan = object(value, 'preparation plan');
  exactKeys(plan, [
    'activeArms',
    ...(plan.targetArms === undefined ? [] : ['targetArms']),
    'adapter',
    'bootstrap',
    'clusters',
    'gates',
    'lifecycle',
    'project',
    'repetitions',
    'scheduleSeed',
    'studyId',
    'taskContexts',
    'threadnote',
    'timeoutMilliseconds',
    'verification',
    'version',
  ]);
  if (plan.version !== MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION) invalid('preparation plan version must be 4');
  const adapter = object(plan.adapter, 'adapter plan');
  exactKeys(adapter, [
    ...(adapter.approvedCommands === undefined ? [] : ['approvedCommands']),
    ...(adapter.dependencyProjections === undefined ? [] : ['dependencyProjections']),
    'appServer',
    'authSourcePath',
    'contextBudgetTokens',
    'executable',
    'gitExecutable',
    'judgeModel',
    'model',
    'pricingMicrosPerMillionTokens',
    'safeBinaries',
    'safeExecutablePath',
    'taskBudget',
    'temporaryRoot',
  ]);
  const appServer = object(adapter.appServer, 'app server plan');
  exactKeys(appServer, ['argumentsAfterSubcommand', 'argumentsBeforeSubcommand', 'executable', 'version']);
  const threadnote = object(plan.threadnote, 'Threadnote plan');
  exactKeys(threadnote, [
    'account',
    'executable',
    'lockFile',
    'requiredReleaseCommit',
    'sourceDirectory',
    'user',
    ...(threadnote.productionRelease === undefined ? [] : ['productionRelease']),
  ]);
  const clusters = array(plan.clusters, 'clusters').map(parseClusterPlan);
  unique(
    clusters.map(cluster => cluster.clusterId),
    'cluster ids',
  );
  unique(
    clusters.map(cluster => cluster.repositoryDirectory),
    'cluster repositories',
  );
  const taskContexts = array(plan.taskContexts, 'task contexts').map(parseTaskContextPlan);
  unique(
    taskContexts.map(context => context.taskId),
    'task context ids',
  );
  const pricing = adapter.pricingMicrosPerMillionTokens;
  const safeBinaries = stringArray(adapter.safeBinaries, 'safe binaries').map((path, index) =>
    absolutePath(path, `safe binary ${index}`),
  );
  const verification = object(plan.verification, 'verification plan');
  exactKeys(verification, [
    'environmentDirectory',
    'interpreter',
    'runner',
    'sandboxExecutable',
    'tasks',
    'timeoutMilliseconds',
  ]);
  const verificationTasks = array(verification.tasks, 'verification tasks').map((value, index) => {
    const task = object(value, `verification task ${index}`);
    exactKeys(task, ['fixRepositoryDirectory', 'protectedPaths', 'qualificationCommands', 'selector', 'taskId']);
    const protectedPaths = array(task.protectedPaths, `verification task ${index} protected paths`).map(
      (path, pathIndex) => safePlanRelativePath(path, `verification task ${index} protected path ${pathIndex}`),
    );
    if (protectedPaths.length === 0 || protectedPaths.length > 256) {
      invalid(`verification task ${index} protected paths has invalid bounds`);
    }
    unique(protectedPaths, `verification task ${index} protected paths`);
    const qualificationCommands = array(
      task.qualificationCommands,
      `verification task ${index} qualification commands`,
    ).map((tokens, commandIndex) =>
      parseCommandTokens(tokens, `verification task ${index} qualification command ${commandIndex}`),
    );
    if (qualificationCommands.length === 0 || qualificationCommands.length > 16) {
      invalid(`verification task ${index} qualification commands has invalid bounds`);
    }
    return {
      fixRepositoryDirectory: absolutePath(task.fixRepositoryDirectory, `verification task ${index} fix repository`),
      protectedPaths: protectedPaths.sort(),
      qualificationCommands,
      selector: matching(task.selector, VERIFIER_SELECTOR, `verification task ${index} selector`),
      taskId: matching(task.taskId, TASK_ID, `verification task ${index} id`),
    };
  });
  unique(
    verificationTasks.map(task => task.taskId),
    'verification task ids',
  );
  unique(
    verificationTasks.map(task => task.fixRepositoryDirectory),
    'verification fix repositories',
  );
  for (const [taskIndex, task] of verificationTasks.entries()) {
    for (const [commandIndex, tokens] of task.qualificationCommands.entries()) {
      const executable = tokens.find(token => !token.includes('='));
      if (safeBinaries.filter(path => basename(path) === executable).length !== 1) {
        invalid(`verification task ${taskIndex} qualification command ${commandIndex} is not one pinned safe binary`);
      }
    }
  }
  const taskBudget = object(adapter.taskBudget, 'task budget');
  exactKeys(taskBudget, ['steps', 'tokens']);
  const productionRelease =
    threadnote.productionRelease === undefined ? undefined : parseProductionRelease(threadnote.productionRelease);
  const activeArms = array(plan.activeArms, 'active arms').map((arm, index) => {
    if (!MATCHED_EVALUATION_ARMS.includes(arm as MatchedEvaluationArm)) invalid(`active arm ${index} is invalid`);
    return arm as MatchedEvaluationArm;
  });
  unique(activeArms, 'active arms');
  if (activeArms.length === 0) invalid('active arms must not be empty');
  const targetArms =
    plan.targetArms === undefined
      ? undefined
      : array(plan.targetArms, 'target arms').map((arm, index) => {
          if (arm !== 'threadnote-compact' && arm !== 'threadnote-source') invalid(`target arm ${index} is invalid`);
          return arm;
        });
  if (targetArms !== undefined) unique(targetArms, 'target arms');
  const approvedCommands =
    adapter.approvedCommands === undefined
      ? []
      : array(adapter.approvedCommands, 'approved commands').map(parseApprovedCommandPlan);
  if (approvedCommands.length > 256) invalid('approved commands has invalid bounds');
  unique(
    approvedCommands.map(command => `${command.taskId}\0${JSON.stringify(command.tokens)}`),
    'approved commands',
  );
  const preparedTaskIds = new Set(taskContexts.map(context => context.taskId));
  if (approvedCommands.some(command => !preparedTaskIds.has(command.taskId))) {
    invalid('approved commands must reference prepared task contexts');
  }
  const dependencyProjections =
    adapter.dependencyProjections === undefined
      ? []
      : array(adapter.dependencyProjections, 'dependency projections').map((value, index) => {
          const projection = object(value, `dependency projection ${index}`);
          exactKeys(projection, ['lockFileRelativePath', 'sourceDirectory', 'targetRelativePath', 'taskId']);
          return {
            lockFileRelativePath: safePlanRelativePath(
              projection.lockFileRelativePath,
              `dependency projection ${index} lock file`,
            ),
            sourceDirectory: absolutePath(
              projection.sourceDirectory,
              `dependency projection ${index} source directory`,
            ),
            targetRelativePath: safePlanRelativePath(
              projection.targetRelativePath,
              `dependency projection ${index} target`,
            ),
            taskId: matching(projection.taskId, TASK_ID, `dependency projection ${index} task id`),
          };
        });
  unique(
    dependencyProjections.map(projection => projection.taskId),
    'dependency projection task ids',
  );
  if (dependencyProjections.some(projection => !preparedTaskIds.has(projection.taskId))) {
    invalid('dependency projections must reference prepared task contexts');
  }
  return {
    activeArms,
    adapter: {
      approvedCommands,
      appServer: {
        argumentsAfterSubcommand: stringArray(appServer.argumentsAfterSubcommand, 'app-server trailing arguments'),
        argumentsBeforeSubcommand: stringArray(appServer.argumentsBeforeSubcommand, 'app-server leading arguments'),
        executable: absolutePath(appServer.executable, 'app-server executable'),
        version: boundedText(appServer.version, 1, 256, 'app-server version'),
      },
      authSourcePath: absolutePath(adapter.authSourcePath, 'auth source'),
      contextBudgetTokens: integer(adapter.contextBudgetTokens, 800, 1_500, 'context budget'),
      dependencyProjections,
      executable: absolutePath(adapter.executable, 'adapter executable'),
      gitExecutable: absolutePath(adapter.gitExecutable, 'Git executable'),
      judgeModel: parseModelPlan(adapter.judgeModel, 'judge model'),
      model: parseModelPlan(adapter.model, 'agent model'),
      pricingMicrosPerMillionTokens:
        pricing === null
          ? null
          : (() => {
              const parsed = object(pricing, 'pricing');
              exactKeys(parsed, ['cachedInput', 'input', 'output']);
              return {
                cachedInput: integer(parsed.cachedInput, 0, Number.MAX_SAFE_INTEGER, 'cached-input price'),
                input: integer(parsed.input, 0, Number.MAX_SAFE_INTEGER, 'input price'),
                output: integer(parsed.output, 0, Number.MAX_SAFE_INTEGER, 'output price'),
              };
            })(),
      safeBinaries,
      safeExecutablePath: boundedText(adapter.safeExecutablePath, 1, 16_384, 'safe executable PATH'),
      taskBudget: {
        steps: integer(taskBudget.steps, 1, 1_000, 'task step budget'),
        tokens: integer(taskBudget.tokens, 1, 10_000_000, 'task token budget'),
      },
      temporaryRoot: absolutePath(adapter.temporaryRoot, 'temporary root'),
    },
    bootstrap: plan.bootstrap as PreparationPlanV1['bootstrap'],
    clusters,
    gates: plan.gates as PreparationPlanV1['gates'],
    lifecycle: array(plan.lifecycle, 'lifecycle') as unknown as readonly MatchedTokenEfficiencyLifecycleArmV1[],
    project: matching(plan.project, PROJECT, 'project'),
    repetitions: (() => {
      const repetitions = integer(plan.repetitions, 5, 1_000, 'repetitions');
      const selectedCount = activeArms.length;
      if (repetitions % selectedCount !== 0)
        invalid(`repetitions must be divisible by selected arm count (${selectedCount})`);
      return repetitions;
    })(),
    scheduleSeed: matching(plan.scheduleSeed, HASH, 'schedule seed'),
    studyId: boundedText(plan.studyId, 3, 64, 'study id'),
    targetArms,
    taskContexts,
    threadnote: {
      account: matching(threadnote.account, PROJECT, 'Threadnote account'),
      executable: absolutePath(threadnote.executable, 'Threadnote executable'),
      lockFile: absolutePath(threadnote.lockFile, 'Threadnote lock file'),
      requiredReleaseCommit: matching(threadnote.requiredReleaseCommit, COMMIT, 'required release commit'),
      sourceDirectory: absolutePath(threadnote.sourceDirectory, 'Threadnote source directory'),
      user: matching(threadnote.user, PROJECT, 'Threadnote user'),
      ...(productionRelease === undefined ? {} : {productionRelease}),
    },
    timeoutMilliseconds: integer(plan.timeoutMilliseconds, 60_000, 7_200_000, 'runtime timeout'),
    verification: {
      environmentDirectory: absolutePath(verification.environmentDirectory, 'verification environment'),
      interpreter: absolutePath(verification.interpreter, 'verification interpreter'),
      runner: absolutePath(verification.runner, 'verification runner'),
      sandboxExecutable: absolutePath(verification.sandboxExecutable, 'verification sandbox executable'),
      tasks: verificationTasks,
      timeoutMilliseconds: integer(verification.timeoutMilliseconds, 1_000, 600_000, 'verification timeout'),
    },
    version: MATCHED_TOKEN_EFFICIENCY_PREPARATION_VERSION,
  };
}

function parseClusterPlan(value: unknown, index: number): ClusterPlanV1 {
  const cluster = object(value, `cluster ${index}`);
  exactKeys(cluster, ['clusterId', 'repositoryDirectory', 'repositoryUrl']);
  const repositoryUrl = boundedText(cluster.repositoryUrl, 8, 2_048, `cluster ${index} repository URL`);
  const url = new URL(repositoryUrl);
  if (url.protocol !== 'https:' || url.username || url.password) invalid(`cluster ${index} must use public HTTPS`);
  return {
    clusterId: matching(cluster.clusterId, CLUSTER_ID, `cluster ${index} id`),
    repositoryDirectory: absolutePath(cluster.repositoryDirectory, `cluster ${index} repository`),
    repositoryUrl,
  };
}

function parseProductionRelease(value: unknown): MatchedTokenEfficiencyProductionReleaseV1 {
  const release = object(value, 'production release');
  exactKeys(release, [
    'archiveSha256',
    'archiveUrl',
    'executableSha256',
    'immutable',
    'releaseUrl',
    'sourceCommit',
    'version',
  ]);
  const parsed = {
    archiveSha256: matching(release.archiveSha256, HASH, 'production archive hash'),
    archiveUrl: boundedText(release.archiveUrl, 1, 2_048, 'production archive URL') as typeof PRODUCTION_ARCHIVE_URL,
    executableSha256: matching(release.executableSha256, HASH, 'production executable hash'),
    immutable: release.immutable,
    releaseUrl: boundedText(release.releaseUrl, 1, 2_048, 'production release URL') as typeof PRODUCTION_RELEASE_URL,
    sourceCommit: matching(release.sourceCommit, COMMIT, 'production source commit'),
    version: release.version,
  };
  if (parsed.immutable !== true || parsed.version !== MATCHED_TOKEN_EFFICIENCY_PRODUCTION_PRODUCT_VERSION)
    invalid('production release must be immutable version 5.0.7');
  return parsed as MatchedTokenEfficiencyProductionReleaseV1;
}

function parseTaskContextPlan(value: unknown, index: number): TaskContextPlanV1 {
  const task = object(value, `task context ${index}`);
  exactKeys(task, [
    ...(task.activeHandoffTopics === undefined ? [] : ['activeHandoffTopics']),
    'asIssuedContext',
    'clusterId',
    'graphHomeDirectory',
    'linkedHomeDirectory',
    'linkedMemoryIdentities',
    'taskId',
  ]);
  const context = object(task.asIssuedContext, `task context ${index} as-issued context`);
  exactKeys(context, ['assessmentFile', 'contentFile', 'sufficiency']);
  if (!['none', 'lacking', 'sufficient', 'excessive'].includes(String(context.sufficiency))) {
    invalid(`task context ${index} sufficiency is invalid`);
  }
  const linkedMemoryIdentities = array(
    task.linkedMemoryIdentities,
    `task context ${index} linked-memory identities`,
  ).map((value, memoryIndex) => {
    const identity = object(value, `task context ${index} linked-memory identity ${memoryIndex}`);
    exactKeys(identity, ['fixtureMemoryId', 'managedMemoryId']);
    return {
      fixtureMemoryId: matching(
        identity.fixtureMemoryId,
        FIXTURE_MEMORY_ID,
        `task context ${index} fixture memory id ${memoryIndex}`,
      ),
      managedMemoryId: matching(
        identity.managedMemoryId,
        MANAGED_MEMORY_ID,
        `task context ${index} managed memory id ${memoryIndex}`,
      ),
    };
  });
  unique(
    linkedMemoryIdentities.map(identity => identity.fixtureMemoryId),
    `task context ${index} fixture memory ids`,
  );
  unique(
    linkedMemoryIdentities.map(identity => identity.managedMemoryId),
    `task context ${index} managed memory ids`,
  );
  const activeHandoffTopics =
    task.activeHandoffTopics === undefined
      ? []
      : array(task.activeHandoffTopics, `task context ${index} active handoff topics`).map((topic, topicIndex) =>
          boundedText(topic, 1, 512, `task context ${index} active handoff topic ${topicIndex}`),
        );
  unique(activeHandoffTopics, `task context ${index} active handoff topics`);
  return {
    activeHandoffTopics,
    asIssuedContext: {
      assessmentFile: absolutePath(context.assessmentFile, `task context ${index} assessment`),
      contentFile:
        context.contentFile === null
          ? null
          : absolutePath(context.contentFile, `task context ${index} supplied context`),
      sufficiency: context.sufficiency as TaskContextPlanV1['asIssuedContext']['sufficiency'],
    },
    clusterId: matching(task.clusterId, CLUSTER_ID, `task context ${index} cluster`),
    graphHomeDirectory: absolutePath(task.graphHomeDirectory, `task context ${index} graph home`),
    linkedHomeDirectory: absolutePath(task.linkedHomeDirectory, `task context ${index} linked home`),
    linkedMemoryIdentities,
    taskId: matching(task.taskId, TASK_ID, `task context ${index} id`),
  };
}

function parseModelPlan(value: unknown, label: string): ModelPlanV1 {
  const model = object(value, label);
  exactKeys(model, ['id', 'provider', 'reasoningEffort']);
  return {
    id: boundedText(model.id, 1, 128, `${label} id`),
    provider: boundedText(model.provider, 1, 128, `${label} provider`),
    reasoningEffort: boundedText(model.reasoningEffort, 1, 32, `${label} reasoning effort`),
  };
}

function parseApprovedCommandPlan(
  value: unknown,
  index: number,
): {readonly taskId: string; readonly tokens: readonly string[]} {
  const command = object(value, `approved command ${index}`);
  exactKeys(command, ['taskId', 'tokens']);
  const tokens = parseCommandTokens(command.tokens, `approved command ${index}`);
  return {
    taskId: matching(command.taskId, TASK_ID, `approved command ${index} task id`),
    tokens,
  };
}

function parseCommandTokens(value: unknown, label: string): readonly string[] {
  const tokenInputs = array(value, `${label} tokens`);
  if (tokenInputs.length < 1 || tokenInputs.length > 64) invalid(`${label} tokens has invalid bounds`);
  const tokens = tokenInputs.map((token, tokenIndex) => boundedText(token, 1, 1_024, `${label} token ${tokenIndex}`));
  const executableIndex = tokens.findIndex(token => !token.includes('='));
  if (executableIndex < 0) invalid(`${label} lacks an executable`);
  for (const assignment of tokens.slice(0, executableIndex)) {
    if (assignment !== 'PYTHONPATH=src') invalid(`${label} has an unsupported environment assignment`);
  }
  if (!/^[A-Za-z0-9._+-]{1,128}$/u.test(tokens[executableIndex])) {
    invalid(`${label} executable must be one bare name`);
  }
  for (const token of tokens.slice(executableIndex + 1)) {
    if (
      /[\0\r\n;&|<>`$(){}\\]/u.test(token) ||
      isAbsolute(token) ||
      token.split('/').some(segment => segment === '..')
    ) {
      invalid(`${label} argument is outside the sealed task-command grammar`);
    }
  }
  return tokens;
}

function manifestModel(model: ModelPlanV1) {
  const configured = modelConfiguration(model);
  return {model: configured.id, parametersHash: configured.parametersHash, provider: configured.provider};
}

function modelConfiguration(model: ModelPlanV1) {
  return {
    ...model,
    parametersHash: digest('matched-evaluation-codex-model-parameters-v1', {
      allowProviderModelFallback: false,
      approvalPolicy: 'untrusted',
      id: model.id,
      provider: model.provider,
      reasoningEffort: model.reasoningEffort,
      sandbox: 'workspace-write-no-network',
    }),
  };
}

async function assertRepositoryRemote(repository: string, expected: string): Promise<void> {
  const actual = singleLine(
    (await captureGit(repository, ['remote', 'get-url', 'origin'])).stdout,
    'repository origin',
  );
  if (normalizeRemote(actual) !== normalizeRemote(expected))
    throw new Error('Held-out repository origin differs from the plan.');
}

function normalizeRemote(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
  if (!url.hostname || !path) throw new Error('Repository origin is invalid.');
  return `${url.hostname.toLowerCase()}/${path}`;
}

async function captureGit(root: string, arguments_: readonly string[], allowFailure = false) {
  return await captureCodeMemoryLinkProcessGroup({
    allowFailure,
    arguments: ['-C', root, ...arguments_],
    command: 'git',
    cwd: root,
    environment: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/nonexistent',
      PATH: '/usr/bin:/bin',
    },
    label: 'Matched evaluation preparation Git',
    maxOutputBytes: 64 * 1_024,
    timeoutMilliseconds: 30_000,
  });
}

export async function ensureMatchedEvaluationFixCommitAvailableV1(input: {
  readonly baseDirectory: string;
  readonly fixDirectory: string;
  readonly fixRevision: string;
  readonly taskId: string;
}): Promise<void> {
  const object = `${input.fixRevision}^{commit}`;
  if ((await captureGit(input.baseDirectory, ['cat-file', '-e', object], true)).exitCode === 0) return;
  const [baseCommonGitDirectory, fixCommonGitDirectory] = await Promise.all(
    [input.baseDirectory, input.fixDirectory].map(async directory => {
      const result = await captureGit(directory, ['rev-parse', '--git-common-dir']);
      return realpath(resolve(directory, singleLine(result.stdout, 'repository common Git directory')));
    }),
  );
  const fixObjects = await realpath(resolve(fixCommonGitDirectory, 'objects'));
  const alternatesDirectory = resolve(baseCommonGitDirectory, 'objects', 'info');
  const alternatesPath = resolve(alternatesDirectory, 'alternates');
  const current = await readFile(alternatesPath, 'utf8').catch(cause => {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') return '';
    throw cause;
  });
  const alternates = current
    .split(/\r?\n/gu)
    .map(line => line.trim())
    .filter(Boolean);
  if (!alternates.includes(fixObjects)) {
    const next = `${[...new Set([...alternates, fixObjects])].sort().join('\n')}\n`;
    const temporary = `${alternatesPath}.tmp-${process.pid}`;
    await mkdir(alternatesDirectory, {recursive: true, mode: 0o700});
    try {
      await rm(temporary, {force: true});
      await writeFile(temporary, next, {encoding: 'utf8', flag: 'wx', mode: 0o600});
      await rename(temporary, alternatesPath);
    } finally {
      await rm(temporary, {force: true});
    }
  }
  if ((await captureGit(input.baseDirectory, ['cat-file', '-e', object], true)).exitCode !== 0) {
    throw new Error(`Known-fix commit is unavailable to continuation finalization: ${input.taskId}.`);
  }
}

function threadnoteEnvironment(
  home: string,
  safeExecutablePath: string,
  identity: {readonly account: string; readonly user: string},
): Readonly<Record<string, string>> {
  return {
    CI: '1',
    HOME: process.env.HOME ?? '/nonexistent',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    PATH: safeExecutablePath,
    THREADNOTE_ACCOUNT: identity.account,
    THREADNOTE_HOME: home,
    THREADNOTE_NO_SPINNER: '1',
    THREADNOTE_NO_UPDATE_CHECK: '1',
    THREADNOTE_USER: identity.user,
  };
}

async function writePreparedFiles(root: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  await chmod(root, 0o700);
  for (const [path, bytes] of files) {
    const destination = containedPath(root, path);
    await mkdir(dirname(destination), {recursive: true, mode: 0o700});
    await writeFile(destination, bytes, {flag: 'wx', mode: 0o600});
  }
}

async function verifyPreparedFiles(root: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  for (const [path, bytes] of files) {
    const actual = await readCanonicalFile(containedPath(root, path), false, `prepared ${path}`);
    if (sha256(actual) !== sha256(bytes)) throw new Error(`Prepared output changed while written: ${path}`);
  }
}

async function walkFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error('Prepared Threadnote home contains a symbolic link.');
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile() && metadata.nlink === 1) files.push(path);
      else throw new Error('Prepared Threadnote home contains an unsupported filesystem entry.');
    }
  };
  await visit(root);
  return files;
}

async function assertPrivateAuthFile(path: string): Promise<void> {
  const canonical = await canonicalRegularFile(path, false, 'auth source');
  const metadata = await lstat(canonical);
  if (metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
    throw new Error('Auth source must be one owner-only file.');
  }
}

async function hashCanonicalFile(path: string, executable: boolean, label: string): Promise<string> {
  return sha256(await readCanonicalFile(path, executable, label));
}

async function hashLinkedExecutable(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a file or symbolic link.`);
  }
  const target = await realpath(path);
  const targetMetadata = await lstat(target);
  if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink() || (targetMetadata.mode & 0o111) === 0) {
    throw new Error(`${label} must resolve to one executable regular file.`);
  }
  return sha256(await readFile(target));
}

async function canonicalRegularFile(path: string, executable: boolean, label: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (canonical !== path || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be one canonical regular file.`);
  }
  if (executable && (metadata.mode & 0o111) === 0) throw new Error(`${label} must be executable.`);
  return canonical;
}

async function readCanonicalFile(path: string, executable: boolean, label: string): Promise<Buffer> {
  const canonical = await canonicalRegularFile(path, executable, label);
  const before = await stat(canonical);
  const bytes = await readFile(canonical);
  const after = await stat(canonical);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new Error(`${label} changed while read.`);
  }
  return bytes;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (canonical !== path || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be one canonical directory.`);
  }
  return canonical;
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') return;
    throw cause;
  }
  throw new Error(`${label} already exists.`);
}

function containedPath(root: string, path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path)) throw new Error('Prepared output path is invalid.');
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Prepared output path escaped its root.');
  }
  return absolute;
}

function safePlanRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    value.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    invalid(`${label} must be one normalized relative path`);
  }
  return value;
}

function firstObservation(
  observations: ReadonlyMap<string, MatchedEvaluationRepositoryObservationV1>,
): MatchedEvaluationRepositoryObservationV1 {
  return required(observations.values().next().value, 'first cluster observation');
}

function parseArguments(args: readonly string[]): {
  readonly corpusPath: string;
  readonly outputRoot: string;
  readonly planPath: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!['--corpus', '--output', '--plan'].includes(option) || values.has(option)) {
      throw ScriptError.make({message: `Unknown or repeated preparation option: ${option}`});
    }
    values.set(option, required(args[++index], option));
  }
  return {
    corpusPath: absolutePath(required(values.get('--corpus'), '--corpus'), '--corpus'),
    outputRoot: absolutePath(required(values.get('--output'), '--output'), '--output'),
    planPath: absolutePath(required(values.get('--plan'), '--plan'), '--plan'),
  };
}

async function readJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAXIMUM_JSON_BYTES) {
    throw new Error(`${path} is not one bounded regular JSON file.`);
  }
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`);
}

function digest(namespace: string, value: unknown): string {
  return sha256(Buffer.from(`${namespace}\n${JSON.stringify(value)}`));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    invalid('preparation plan contains unsupported or missing fields');
}

function stringArray(value: unknown, label: string): readonly string[] {
  return array(value, label).map((entry, index) => boundedText(entry, 0, 4_096, `${label} ${index}`));
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    invalid(`${label} is invalid`);
  return Number(value);
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  const parsed = boundedText(value, 1, 4_096, label);
  if (!pattern.test(parsed)) invalid(`${label} is invalid`);
  return parsed;
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedText(value, 1, 4_096, label);
  if (!isAbsolute(path) || path.includes('\0')) invalid(`${label} must be absolute`);
  return path;
}

function singleLine(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed)) throw new Error(`${label} must be one line.`);
  return trimmed;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`Missing ${label}.`);
  return value;
}

function invalid(message: string): never {
  throw new Error(message);
}

if (import.meta.main) {
  BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
}

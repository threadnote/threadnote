#!/usr/bin/env bun
import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed sequential harness owns exact OS ledger and child-process boundaries. */

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {createHash} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, posix, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Effect} from 'effect';
import {
  assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1,
  parseCodeMemoryLinkAgentAbAssignmentV1,
  parseCodeMemoryLinkAgentAbManifestV1,
  parseCodeMemoryLinkAgentAbTrialsJsonl,
  type CodeMemoryLinkAgentAbManifestV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ab';
import {
  assertCodeMemoryLinkAgentAttemptLedgerV1,
  parseCodeMemoryLinkAgentAttemptsJsonl,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-attempts';
import {
  assertCodeMemoryLinkAgentEvidenceLedgerV1,
  parseCodeMemoryLinkAgentEvidenceJsonl,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-evidence';
import {
  parseCodeMemoryLinkAgentPendingCommitJsonV1,
  reconcileCodeMemoryLinkAgentPendingCommitV1,
  type CodeMemoryLinkAgentPendingCommitV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-pending';
import {
  parseCodeMemoryLinkContextBriefResponseReceiptV1,
  parseCodeMemoryLinkFixtureV1,
  parseCodeMemoryLinkRubricV1,
  parseCodeMemoryLinkSealedSuiteV1,
  parseCodeMemoryLinkTaskPacketV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {
  codeMemoryLinkClientArgumentVectorHash,
  codeMemoryLinkClientImplementationDescriptorHash,
  codeMemoryLinkClientPathDigest,
  parseCodeMemoryLinkClientImplementationDescriptorV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-client-descriptor';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  CODE_MEMORY_LINK_CALIBRATION_KIND,
  CODE_MEMORY_LINK_CALIBRATION_PLAN_VERSION,
  type CodeMemoryLinkCalibrationPlanV1,
  type CodeMemoryLinkPreparedClientV1,
} from './prepare-code-memory-link-agent-ab.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {scriptArguments} from './effect/script.js';
import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';
import {verifyCodeMemoryLinkEvaluatedSubject} from './code-memory-link-evaluated-subject.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const CODE_MEMORY_LINK_MATRIX_VERSION = 1 as const;
export const CODE_MEMORY_LINK_CALIBRATION_RESULT_VERSION = 1 as const;

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CLIENT_ID = /^cli_[0-9a-f]{16,64}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const MAXIMUM_TRIAL_LEDGER_BYTES = 16 * 1_024 * 1_024;
const MAXIMUM_EVIDENCE_LEDGER_BYTES = 128 * 1_024 * 1_024;
const MAXIMUM_CALIBRATION_LEDGER_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_PENDING_BYTES = 32 * 1_024 * 1_024;
const MAXIMUM_CHILD_FAILURE_DIAGNOSTIC_CHARACTERS = 2_048;
const CALIBRATION_FORBIDDEN_FIELDS = new Set([
  'approvalCommit',
  'attestation',
  'evidenceKind',
  'manifestHash',
  'rawEvidence',
  'trial',
  'trialId',
]);

export interface CodeMemoryLinkCalibrationResultV1 {
  readonly arm: 'anchored' | 'no-memory' | 'task-only';
  readonly clientId: string;
  readonly diagnosticsHash: string;
  readonly kind: typeof CODE_MEMORY_LINK_CALIBRATION_KIND;
  readonly planHash: string;
  readonly previousResultDigest: string | null;
  readonly resultHash: string;
  readonly runOrder: number;
  readonly taskId: string;
  readonly version: typeof CODE_MEMORY_LINK_CALIBRATION_RESULT_VERSION;
}

interface ReleaseOptions {
  readonly approvalCommit: string;
  readonly attemptsPath: string;
  readonly candidateCommit: string;
  readonly candidateExecutable: string;
  readonly candidateExecutableSha256: string;
  readonly evidencePath: string;
  readonly mode: 'release';
  readonly pacingMilliseconds: number;
  readonly root: string;
  readonly timeoutMilliseconds: number;
  readonly trialsPath: string;
}

interface CalibrationOptions {
  readonly calibrationArguments: readonly string[];
  readonly calibrationCommand: string;
  readonly mode: 'calibration';
  readonly pacingMilliseconds: number;
  readonly resultsPath: string;
  readonly root: string;
  readonly timeoutMilliseconds: number;
}

type Options = CalibrationOptions | ReleaseOptions;

interface ClientRegistryV1 {
  readonly clients: readonly CodeMemoryLinkPreparedClientV1[];
  readonly version: 1;
}

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  if (options.mode === 'release') {
    return yield* Effect.tryPromise({
      try: async () => {
        const subject = await verifyCodeMemoryLinkEvaluatedSubject({
          executable: options.candidateExecutable,
          executableSha256: options.candidateExecutableSha256,
          sourceCommit: options.candidateCommit,
        });
        await runReleaseMatrix(options, dirname(subject.executable));
      },
      catch: cause => ScriptError.make({message: 'Code Memory Link matrix execution stopped.', cause}),
    });
  }
  yield* Effect.tryPromise({
    try: () => runCalibrationMatrix(options),
    catch: cause => ScriptError.make({message: 'Code Memory Link matrix execution stopped.', cause}),
  });
});

export async function runReleaseMatrix(options: ReleaseOptions, candidateInstallRootInput: string): Promise<void> {
  const root = await canonicalDirectory(options.root, 'prepared experiment root');
  const candidateInstallRoot = await canonicalDirectory(
    candidateInstallRootInput,
    'verified candidate installation root',
  );
  const [assignmentInput, manifestInput, registryInput] = await Promise.all([
    readJson(joinRoot(root, 'assignment.json')),
    readJson(joinRoot(root, 'manifest.json')),
    readJson(joinRoot(root, 'clients.json')),
  ]);
  const assignment = parseCodeMemoryLinkAgentAbAssignmentV1(assignmentInput);
  const manifest = parseCodeMemoryLinkAgentAbManifestV1(manifestInput);
  const suite = parseCodeMemoryLinkSealedSuiteV1(await readJson(joinRoot(root, 'suite.json')));
  if (suite.suiteHash !== manifest.suiteHash || suite.fixture.fixtureHash !== manifest.fixtureHash) {
    throw new Error('Sealed suite does not match the frozen manifest.');
  }
  if (
    suite.tasks.length !== manifest.tasks.length ||
    EffectArray.some(suite.tasks, (task, index) => {
      const expected = manifest.tasks[index];
      return (
        expected === undefined ||
        task.taskId !== expected.taskId ||
        task.taskKind !== expected.taskKind ||
        task.packetHash !== expected.packetHash ||
        task.rubricHash !== expected.rubricHash
      );
    })
  ) {
    throw new Error('Sealed suite task roster does not match the frozen manifest.');
  }
  const registry = parseClientRegistry(registryInput);
  if (manifest.candidate.commit !== options.candidateCommit) {
    throw new Error('Matrix candidate commit differs from the frozen manifest.');
  }
  assertRegistryMatchesManifest(registry, manifest);
  const {attemptsPath, evidencePath, pendingPath, trialsPath} = codeMemoryLinkReleaseLedgerPathsV1({
    attemptsPath: options.attemptsPath,
    evidencePath: options.evidencePath,
    preparedRoot: root,
    trialsPath: options.trialsPath,
  });
  const runnerCommand = await canonicalRegularFile(process.execPath, 'matrix Bun executable');
  const runnerScript = await resolveCodeMemoryLinkAgentTrialRunner();
  const invocationOptions = {...options, attemptsPath, evidencePath, root, trialsPath};
  const invoke = (client: CodeMemoryLinkPreparedClientV1) =>
    capture(runnerCommand, releaseInvocationArguments({client, options: invocationOptions, root, runnerScript}), {
      cwd: dirname(runnerScript),
      environment: codeMemoryLinkReleaseRunnerEnvironment(candidateInstallRoot),
      maxOutputBytes: 2 * 1_024 * 1_024,
      timeoutMilliseconds: options.timeoutMilliseconds + 5 * 60_000,
    });

  for (;;) {
    const state = await readReleaseState({
      approvalCommit: options.approvalCommit,
      assignment,
      attemptsPath,
      evidencePath,
      manifest,
      pendingPath,
      trialsPath,
    });
    if (state.pending !== null) {
      const pending = state.pending;
      const pendingClient = EffectOption.getOrUndefined(
        EffectArray.findFirst(registry.clients, client => client.clientId === pending.trial.clientId),
      );
      if (!pendingClient) throw new Error('Pending commit names a client outside the reviewed registry.');
      const recovery = await invoke(pendingClient);
      if (recovery.exitCode !== 0) {
        throw new Error(
          `Pending commit recovery failed without rerunning or skipping the measured trial: ${boundedCodeMemoryLinkChildFailureDiagnostic(recovery)}`,
        );
      }
      const afterRecovery = await readReleaseState({
        approvalCommit: options.approvalCommit,
        assignment,
        attemptsPath,
        evidencePath,
        manifest,
        pendingPath,
        trialsPath,
      });
      const expectedCount = pending.index + 1;
      if (
        afterRecovery.pending !== null ||
        afterRecovery.trials !== expectedCount ||
        afterRecovery.evidence !== expectedCount ||
        afterRecovery.requiredRetry !== null
      ) {
        throw new Error('Pending recovery did not converge both ledgers and remove the write-ahead commit.');
      }
      process.stdout.write(
        `${JSON.stringify({
          clientId: pending.trial.clientId,
          completed: afterRecovery.trials,
          mode: 'release',
          recoveredPending: true,
          runOrder: pending.index,
          version: CODE_MEMORY_LINK_MATRIX_VERSION,
        })}\n`,
      );
      continue;
    }
    if (state.requiredRetry !== null) {
      throw new Error(
        `Release matrix refuses automatic retry. Review the failure, then invoke the exact trial runner with --retry-of ${state.requiredRetry.attemptId} --retry-reason ${state.requiredRetry.reason}.`,
      );
    }
    if (state.trials === manifest.schedule.length) {
      process.stdout.write(
        `${JSON.stringify({completed: state.trials, manifestHash: manifest.manifestHash, mode: 'release', version: CODE_MEMORY_LINK_MATRIX_VERSION})}\n`,
      );
      return;
    }
    const scheduled = manifest.schedule[state.trials];
    const client = EffectOption.getOrUndefined(
      EffectArray.findFirst(registry.clients, value => value.clientId === scheduled.clientId),
    );
    if (!client) throw new Error('Frozen schedule names a client absent from the reviewed registry.');
    let result: Awaited<ReturnType<typeof invoke>>;
    try {
      result = await invoke(client);
    } catch (cause) {
      const interrupted = await readReleaseState({
        approvalCommit: options.approvalCommit,
        assignment,
        attemptsPath,
        evidencePath,
        manifest,
        pendingPath,
        trialsPath,
      });
      if (interrupted.pending !== null) {
        process.stdout.write(
          `${JSON.stringify({mode: 'release', pendingRecovery: true, runOrder: interrupted.pending.index, version: CODE_MEMORY_LINK_MATRIX_VERSION})}\n`,
        );
        continue;
      }
      const retry = interrupted.requiredRetry;
      throw new Error(
        retry === null
          ? 'Trial runner was interrupted without a recoverable pending commit or canonical retry state.'
          : `Trial runner was interrupted at run ${scheduled.runOrder}. Matrix stopped without retrying. Required acknowledgement: --retry-of ${retry.attemptId} --retry-reason ${retry.reason}.`,
        {cause},
      );
    }
    if (result.exitCode !== 0) {
      const afterFailure = await readReleaseState({
        approvalCommit: options.approvalCommit,
        assignment,
        attemptsPath,
        evidencePath,
        manifest,
        pendingPath,
        trialsPath,
      });
      if (afterFailure.pending !== null) {
        process.stdout.write(
          `${JSON.stringify({mode: 'release', pendingRecovery: true, runOrder: afterFailure.pending.index, version: CODE_MEMORY_LINK_MATRIX_VERSION})}\n`,
        );
        continue;
      }
      const retry = afterFailure.requiredRetry;
      throw new Error(
        retry === null
          ? `Trial runner failed without a canonical retry state: ${boundedCodeMemoryLinkChildFailureDiagnostic(result)}`
          : `Trial runner failed at run ${scheduled.runOrder}. Matrix stopped without retrying. Required acknowledgement: --retry-of ${retry.attemptId} --retry-reason ${retry.reason}.`,
      );
    }
    const after = await readReleaseState({
      approvalCommit: options.approvalCommit,
      assignment,
      attemptsPath,
      evidencePath,
      manifest,
      pendingPath,
      trialsPath,
    });
    if (
      after.pending !== null ||
      after.trials !== state.trials + 1 ||
      after.evidence !== state.evidence + 1 ||
      after.requiredRetry !== null
    ) {
      throw new Error('Trial runner did not atomically advance exactly one receipt and one evidence record.');
    }
    process.stdout.write(
      `${JSON.stringify({
        clientId: scheduled.clientId,
        completed: after.trials,
        mode: 'release',
        remaining: manifest.schedule.length - after.trials,
        runOrder: scheduled.runOrder,
        taskId: scheduled.taskId,
        version: CODE_MEMORY_LINK_MATRIX_VERSION,
      })}\n`,
    );
    if (after.trials < manifest.schedule.length) await delay(options.pacingMilliseconds);
  }
}

export async function runCalibrationMatrix(options: CalibrationOptions): Promise<void> {
  const root = await canonicalDirectory(options.root, 'prepared experiment root');
  const plan = parseCalibrationPlan(await readJson(joinRoot(root, 'calibration/plan.json')));
  const command = await canonicalRegularFile(options.calibrationCommand, 'calibration command');
  assertOutsideRoot(root, command, 'calibration command');
  const resultsPath = normalizedAbsolute(options.resultsPath, 'calibration results');
  if (!Effect2.pipe(resultsPath, EffectString.endsWith('.calibration.jsonl'))) {
    throw new Error('Calibration results must use a visibly separate .calibration.jsonl suffix.');
  }
  assertOutsideRoot(root, resultsPath, 'calibration results');
  const sandbox = await materializeCodeMemoryLinkCalibrationSandboxV1(root, plan);
  try {
    await runCalibrationSchedule(options, plan, command, resultsPath, sandbox);
  } finally {
    await rm(sandbox, {force: true, maxRetries: 3, recursive: true});
  }
}

async function runCalibrationSchedule(
  options: CalibrationOptions,
  plan: CodeMemoryLinkCalibrationPlanV1,
  command: string,
  resultsPath: string,
  sandbox: string,
): Promise<void> {
  for (;;) {
    const results = parseCodeMemoryLinkCalibrationResultsJsonl(
      await readOptionalText(resultsPath, MAXIMUM_CALIBRATION_LEDGER_BYTES),
    );
    assertCodeMemoryLinkCalibrationPrefixV1(plan, results);
    if (results.length === plan.runs.length) {
      process.stdout.write(
        `${JSON.stringify({kind: CODE_MEMORY_LINK_CALIBRATION_KIND, planHash: plan.planHash, recorded: results.length, version: CODE_MEMORY_LINK_MATRIX_VERSION})}\n`,
      );
      return;
    }
    const run = plan.runs[results.length];
    const output = await capture(command, options.calibrationArguments, {
      cwd: sandbox,
      environment: {
        ...minimalEnvironment(),
        THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_ARM: run.arm,
        THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_CLIENT_ID: run.clientId,
        THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_PLAN: joinRoot(sandbox, 'calibration/plan.json'),
        THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_PLAN_HASH: plan.planHash,
        THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_ROOT: sandbox,
        THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_RUN_ORDER: String(run.runOrder),
        THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_TASK_ID: run.taskId,
      },
      maxOutputBytes: 1 * 1_024 * 1_024,
      timeoutMilliseconds: options.timeoutMilliseconds,
    });
    if (output.exitCode !== 0) {
      throw new Error(`Calibration command failed at run ${run.runOrder}; calibration stopped without skipping.`);
    }
    const raw = parseJson(output.stdout, 'calibration command output');
    const prior = results.length === 0 ? null : calibrationResultDigest(results[results.length - 1]);
    const next = createCalibrationResult(plan, run, raw, prior);
    const appended = [...results, next];
    assertCodeMemoryLinkCalibrationPrefixV1(plan, appended);
    await appendExclusiveLine(resultsPath, results.length, next);
    process.stdout.write(
      `${JSON.stringify({kind: CODE_MEMORY_LINK_CALIBRATION_KIND, recorded: appended.length, runOrder: run.runOrder, version: CODE_MEMORY_LINK_MATRIX_VERSION})}\n`,
    );
    if (appended.length < plan.runs.length) await delay(options.pacingMilliseconds);
  }
}

export async function materializeCodeMemoryLinkCalibrationSandboxV1(
  preparedRootInput: string,
  plan: CodeMemoryLinkCalibrationPlanV1,
): Promise<string> {
  const preparedRoot = await canonicalDirectory(preparedRootInput, 'prepared experiment root');
  const temporaryRoot = await realpath(tmpdir());
  const sandbox = await mkdtemp(resolve(temporaryRoot, 'threadnote-code-memory-link-calibration-'));
  try {
    await writeSandboxText(sandbox, 'calibration/plan.json', `${JSON.stringify(plan, null, 2)}\n`);
    const artifacts = new Map(EffectArray.map(plan.fixture.artifacts, artifact => [artifact.artifactId, artifact]));
    for (const mapping of plan.fixtureFiles) {
      const content = await readRequiredText(joinRoot(preparedRoot, mapping.source), 128 * 1_024);
      const artifact = artifacts.get(mapping.artifactId);
      if (!artifact || sha256(content) !== artifact.sha256) {
        throw new Error('Calibration fixture bytes differ from their content-addressed plan.');
      }
      await writeSandboxText(sandbox, mapping.source, content);
    }
    for (const task of plan.tasks) {
      await writeSandboxText(
        sandbox,
        `calibration/tasks/${task.packet.taskId}/packet.json`,
        `${JSON.stringify(task.packet, null, 2)}\n`,
      );
      await writeSandboxText(
        sandbox,
        `calibration/tasks/${task.packet.taskId}/rubric.json`,
        `${JSON.stringify(task.rubric, null, 2)}\n`,
      );
    }
    return await canonicalDirectory(sandbox, 'calibration-only sandbox');
  } catch (cause) {
    await rm(sandbox, {force: true, maxRetries: 3, recursive: true});
    throw cause;
  }
}

async function writeSandboxText(root: string, relativePath: string, content: string): Promise<void> {
  const destination = joinRoot(root, relativeFile(relativePath, 'calibration sandbox path'));
  await mkdir(dirname(destination), {mode: 0o700, recursive: true});
  await writeFile(destination, content, {encoding: 'utf8', flag: 'wx', mode: 0o600});
}

export function releaseInvocationArguments(input: {
  readonly client: CodeMemoryLinkPreparedClientV1;
  readonly options: ReleaseOptions;
  readonly root: string;
  readonly runnerScript: string;
}): readonly string[] {
  const {client, options, root, runnerScript} = input;
  return [
    runnerScript,
    '--approval-commit',
    options.approvalCommit,
    '--assignment',
    joinRoot(root, 'assignment.json'),
    '--attempts',
    options.attemptsPath,
    '--candidate-commit',
    options.candidateCommit,
    '--candidate-executable',
    options.candidateExecutable,
    '--candidate-executable-sha256',
    options.candidateExecutableSha256,
    '--client-command',
    client.clientCommand,
    '--client-config',
    client.clientConfigurationPath,
    '--client-config-projection',
    client.clientConfigurationProjectionPath,
    '--client-dependencies-lock',
    client.clientDependenciesLockPath,
    '--client-descriptor',
    client.clientDescriptorPath,
    '--client-id',
    client.clientId,
    '--evidence',
    options.evidencePath,
    '--manifest',
    joinRoot(root, 'manifest.json'),
    '--timeout-ms',
    String(options.timeoutMilliseconds),
    '--trials',
    options.trialsPath,
    ...EffectArray.flatMap(client.clientArtifactBindings, binding => [
      '--client-artifact-binding',
      `${binding.role}=${binding.path}`,
    ]),
    ...EffectArray.flatMap(client.clientBinaryBindings, binding => [
      '--client-binary-binding',
      `${binding.role}=${binding.path}`,
    ]),
    ...EffectArray.flatMap(client.clientArguments, argument => ['--client-arg', argument]),
  ];
}

async function readReleaseState(input: {
  readonly approvalCommit: string;
  readonly assignment: ReturnType<typeof parseCodeMemoryLinkAgentAbAssignmentV1>;
  readonly attemptsPath: string;
  readonly evidencePath: string;
  readonly manifest: CodeMemoryLinkAgentAbManifestV1;
  readonly pendingPath: string;
  readonly trialsPath: string;
}): Promise<{
  readonly evidence: number;
  readonly pending: CodeMemoryLinkAgentPendingCommitV1 | null;
  readonly requiredRetry: ReturnType<typeof assertCodeMemoryLinkAgentAttemptLedgerV1>['requiredRetry'];
  readonly trials: number;
}> {
  const [trialsText, attemptsText, evidenceText, pendingText] = await Promise.all([
    readOptionalText(input.trialsPath, MAXIMUM_TRIAL_LEDGER_BYTES),
    readOptionalText(input.attemptsPath, MAXIMUM_TRIAL_LEDGER_BYTES),
    readOptionalText(input.evidencePath, MAXIMUM_EVIDENCE_LEDGER_BYTES),
    readOptionalTextOrNull(input.pendingPath, MAXIMUM_PENDING_BYTES),
  ]);
  const trials = parseCodeMemoryLinkAgentAbTrialsJsonl(trialsText);
  const attempts = parseCodeMemoryLinkAgentAttemptsJsonl(attemptsText);
  const evidence = parseCodeMemoryLinkAgentEvidenceJsonl(evidenceText);
  const pending = pendingText === null ? null : parseCodeMemoryLinkAgentPendingCommitJsonV1(pendingText);
  const reconciled = pending === null ? null : reconcileCodeMemoryLinkAgentPendingCommitV1({evidence, pending, trials});
  const validatedTrials = reconciled?.trials ?? trials;
  const validatedEvidence = reconciled?.evidence ?? evidence;
  assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1({
    assignment: input.assignment,
    manifest: input.manifest,
    trials: validatedTrials,
  });
  const attemptState = assertCodeMemoryLinkAgentAttemptLedgerV1({
    approvalCommit: matching(input.approvalCommit, COMMIT, 'approval commit'),
    events: attempts,
    manifest: input.manifest,
    trials: validatedTrials,
  });
  assertCodeMemoryLinkAgentEvidenceLedgerV1({
    assignment: input.assignment,
    evidence: validatedEvidence,
    manifest: input.manifest,
    trials: validatedTrials,
  });
  return {
    evidence: evidence.length,
    pending,
    requiredRetry: attemptState.requiredRetry,
    trials: trials.length,
  };
}

export function codeMemoryLinkReleaseLedgerPathsV1(input: {
  readonly attemptsPath: string;
  readonly evidencePath: string;
  readonly preparedRoot: string;
  readonly trialsPath: string;
}): {
  readonly attemptsPath: string;
  readonly evidencePath: string;
  readonly pendingPath: string;
  readonly trialsPath: string;
} {
  const trialsPath = normalizedAbsolute(input.trialsPath, 'trials ledger');
  const attemptsPath = normalizedAbsolute(input.attemptsPath, 'attempts ledger');
  const evidencePath = normalizedAbsolute(input.evidencePath, 'evidence ledger');
  const pendingPath = `${trialsPath}.pending.json`;
  if (attemptsPath !== `${trialsPath}.attempts.jsonl` || evidencePath !== `${trialsPath}.evidence.jsonl`) {
    throw new Error(
      'Matrix ledgers must be canonical <trials>, <trials>.attempts.jsonl, and <trials>.evidence.jsonl siblings.',
    );
  }
  for (const [path, label] of [
    [trialsPath, 'trials ledger'],
    [attemptsPath, 'attempts ledger'],
    [evidencePath, 'evidence ledger'],
    [pendingPath, 'pending commit'],
  ] as const) {
    assertOutsideRoot(normalizedAbsolute(input.preparedRoot, 'prepared experiment root'), path, label);
  }
  return {attemptsPath, evidencePath, pendingPath, trialsPath};
}

export function parseClientRegistry(value: unknown): ClientRegistryV1 {
  const registry = record(value, 'client registry');
  exactKeys(registry, ['clients', 'version'], 'client registry');
  if (registry.version !== 1) throw new Error('Client registry version must be 1.');
  if (!EffectArray.isArray(registry.clients) || registry.clients.length < 2 || registry.clients.length > 8) {
    throw new Error('Client registry must contain between two and eight clients.');
  }
  const clients = EffectArray.map(registry.clients, (input, index) => {
    const client = record(input, `client registry entry ${index}`);
    exactKeys(
      client,
      [
        'clientArguments',
        'clientArtifactBindings',
        'clientBinaryBindings',
        'clientCommand',
        'clientConfigurationProjectionPath',
        'clientConfigurationPath',
        'clientDependenciesLockPath',
        'clientDescriptorPath',
        'clientId',
        'descriptor',
        'implementationDescriptorHash',
        'model',
      ],
      `client registry entry ${index}`,
    );
    const clientArguments = stringArray(client.clientArguments, `client ${index} arguments`, false);
    const clientArtifactBindings = fileBindingArray(client.clientArtifactBindings, `client ${index} artifact`);
    const clientBinaryBindings = fileBindingArray(client.clientBinaryBindings, `client ${index} binary`);
    const descriptor = parseCodeMemoryLinkClientImplementationDescriptorV1(client.descriptor);
    const implementationDescriptorHash = matching(
      client.implementationDescriptorHash,
      HASH,
      `client ${index} implementation descriptor hash`,
    );
    if (implementationDescriptorHash !== codeMemoryLinkClientImplementationDescriptorHash(descriptor)) {
      throw new Error(`Client registry entry ${index} descriptor hash does not match its descriptor.`);
    }
    if (descriptor.argumentVectorHash !== codeMemoryLinkClientArgumentVectorHash(clientArguments)) {
      throw new Error(`Client registry entry ${index} argument vector does not match its descriptor.`);
    }
    assertDescriptorBindingRoster(clientArtifactBindings, descriptor.artifactBindings, `client ${index} artifact`);
    assertDescriptorBindingRoster(clientBinaryBindings, descriptor.binaryBindings, `client ${index} binary`);
    if (client.model !== 'gpt-5.6-luna' && client.model !== 'gpt-5.6-terra') {
      throw new Error(`Client registry entry ${index} model is outside the preregistered roster.`);
    }
    return {
      clientArguments,
      clientArtifactBindings,
      clientBinaryBindings,
      clientCommand: normalizedAbsolute(client.clientCommand, `client ${index} command`),
      clientConfigurationProjectionPath: normalizedAbsolute(
        client.clientConfigurationProjectionPath,
        `client ${index} configuration projection path`,
      ),
      clientConfigurationPath: normalizedAbsolute(client.clientConfigurationPath, `client ${index} configuration path`),
      clientDependenciesLockPath: normalizedAbsolute(
        client.clientDependenciesLockPath,
        `client ${index} dependency lock path`,
      ),
      clientDescriptorPath: normalizedAbsolute(client.clientDescriptorPath, `client ${index} descriptor path`),
      clientId: matching(client.clientId, CLIENT_ID, `client ${index} id`),
      descriptor,
      implementationDescriptorHash,
      model: client.model,
    } satisfies CodeMemoryLinkPreparedClientV1;
  });
  unique(
    EffectArray.map(clients, client => client.clientId),
    'client registry ids',
  );
  unique(
    EffectArray.map(clients, client => client.implementationDescriptorHash),
    'client registry descriptor hashes',
  );
  return {clients, version: 1};
}

function assertRegistryMatchesManifest(registry: ClientRegistryV1, manifest: CodeMemoryLinkAgentAbManifestV1): void {
  if (registry.clients.length !== manifest.clients.length) {
    throw new Error('Client registry size differs from the frozen manifest roster.');
  }
  for (const expected of manifest.clients) {
    const client = EffectOption.getOrUndefined(
      EffectArray.findFirst(registry.clients, candidate => candidate.clientId === expected.clientId),
    );
    if (
      !client ||
      client.implementationDescriptorHash !== expected.implementationDescriptorHash ||
      client.descriptor.configurationProjectionHash !== expected.configurationProjectionHash ||
      client.descriptor.environmentPolicyHash !== expected.environmentPolicyHash ||
      client.descriptor.executionBundleHash !== expected.executionBundleHash ||
      client.model !== expected.expectedClient.model
    ) {
      throw new Error('Client registry differs from the frozen manifest roster.');
    }
  }
}

export function parseCalibrationPlan(value: unknown): CodeMemoryLinkCalibrationPlanV1 {
  const plan = record(value, 'calibration plan');
  exactKeys(
    plan,
    [
      'clients',
      'calibrationCorpusHash',
      'fixture',
      'fixtureFiles',
      'kind',
      'planHash',
      'releaseLedgerCompatible',
      'runs',
      'tasks',
      'version',
    ],
    'calibration plan',
  );
  if (plan.version !== CODE_MEMORY_LINK_CALIBRATION_PLAN_VERSION) {
    throw new Error('Calibration plan version must be 1.');
  }
  if (plan.kind !== CODE_MEMORY_LINK_CALIBRATION_KIND || plan.releaseLedgerCompatible !== false) {
    throw new Error('Calibration plan must be explicitly non-evidence and release-incompatible.');
  }
  const calibrationCorpusHash = matching(plan.calibrationCorpusHash, HASH, 'calibration corpus hash');
  const clients = EffectArray.map(stringArray(plan.clients, 'calibration clients', true), (client, index) =>
    matching(client, CLIENT_ID, `calibration client ${index}`),
  );
  if (clients.length !== 2) throw new Error('Calibration plan requires exactly two clients.');
  canonicalAscendingUnique(clients, 'calibration clients');
  const fixture = parseCodeMemoryLinkFixtureV1(plan.fixture);
  if (!EffectArray.isArray(plan.fixtureFiles) || plan.fixtureFiles.length !== fixture.artifacts.length) {
    throw new Error('Calibration fixture layout must map every sealed fixture artifact exactly once.');
  }
  const fixtureFiles = EffectArray.map(plan.fixtureFiles, (input, index) => {
    const mapping = record(input, `calibration fixture mapping ${index}`);
    exactKeys(
      mapping,
      ['artifactId', 'destination', 'scope', 'source', 'taskId'],
      `calibration fixture mapping ${index}`,
    );
    const source = relativeFile(mapping.source, `calibration fixture mapping ${index} source`);
    if (!Effect2.pipe(source, EffectString.startsWith('calibration/artifacts/fixture/'))) {
      throw new Error(`Calibration fixture mapping ${index} source is outside its private artifact namespace.`);
    }
    return {
      artifactId: matching(mapping.artifactId, /^art_[0-9a-f]{16,64}$/u, `calibration artifact ${index}`),
      destination: relativeFile(mapping.destination, `calibration fixture mapping ${index} destination`),
      scope: fixtureScope(mapping.scope, `calibration fixture mapping ${index} scope`),
      source,
      taskId: matching(mapping.taskId, TASK_ID, `calibration fixture mapping ${index} task`),
    };
  });
  canonicalAscendingUnique(
    EffectArray.map(fixtureFiles, file => file.artifactId),
    'calibration fixture artifact ids',
  );
  if (EffectArray.some(fixtureFiles, (file, index) => file.artifactId !== fixture.artifacts[index].artifactId)) {
    throw new Error('Calibration fixture layout differs from the content-addressed fixture roster.');
  }
  unique(
    EffectArray.map(fixtureFiles, file => `${file.taskId}\0${file.scope}\0${file.destination}`),
    'calibration fixture destinations',
  );
  unique(
    EffectArray.map(fixtureFiles, file => file.source),
    'calibration fixture sources',
  );
  if (!EffectArray.isArray(plan.tasks) || plan.tasks.length !== 2) {
    throw new Error('Calibration plan requires exactly two tasks.');
  }
  const tasks = EffectArray.map(plan.tasks, (input, index) => {
    const task = record(input, `calibration task ${index}`);
    exactKeys(
      task,
      [
        'packet',
        'preflightExpectedCitationDigests',
        'preflightExpectedResponses',
        'preflightExpectedSelectedMemories',
        'rubric',
      ],
      `calibration task ${index}`,
    );
    const packet = parseCodeMemoryLinkTaskPacketV1(task.packet);
    const rubric = parseCodeMemoryLinkRubricV1(task.rubric);
    const preflightExpectedCitationDigests = EffectArray.map(
      stringArray(task.preflightExpectedCitationDigests, `calibration task ${index} preflight citation digests`, false),
      (digest, digestIndex) => matching(digest, HASH, `calibration task ${index} citation ${digestIndex}`),
    );
    canonicalAscendingUnique(preflightExpectedCitationDigests, `calibration task ${index} preflight citation digests`);
    const preflightExpectedSelectedMemories = selectedMemoryRoster(
      task.preflightExpectedSelectedMemories,
      `calibration task ${index} selected memories`,
    );
    const responses = record(task.preflightExpectedResponses, `calibration task ${index} response projections`);
    exactKeys(responses, ['anchored', 'noMemory', 'taskOnly'], `calibration task ${index} response projections`);
    const preflightExpectedResponses = {
      anchored: parseCodeMemoryLinkContextBriefResponseReceiptV1(responses.anchored),
      noMemory: parseCodeMemoryLinkContextBriefResponseReceiptV1(responses.noMemory),
      taskOnly: parseCodeMemoryLinkContextBriefResponseReceiptV1(responses.taskOnly),
    };
    if (
      packet.fixtureHash !== fixture.fixtureHash ||
      rubric.fixtureHash !== fixture.fixtureHash ||
      packet.taskId !== rubric.taskId ||
      packet.taskKind !== 'hidden-constraint' ||
      rubric.taskKind !== packet.taskKind ||
      EffectArray.some(rubric.goldCitationDigests, digest => !preflightExpectedCitationDigests.includes(digest))
    ) {
      throw new Error(`Calibration task ${index} does not bind its fixture, rubric, packet, and preflight citations.`);
    }
    return {
      packet,
      preflightExpectedCitationDigests,
      preflightExpectedResponses,
      preflightExpectedSelectedMemories,
      rubric,
    };
  });
  canonicalAscendingUnique(
    EffectArray.map(tasks, task => task.packet.taskId),
    'calibration task ids',
  );
  const taskIds = new Set(EffectArray.map(tasks, task => task.packet.taskId));
  if (
    EffectArray.some(fixtureFiles, file => !taskIds.has(file.taskId)) ||
    EffectArray.some(tasks, task =>
      EffectArray.every(fixtureFiles, file => file.taskId !== task.packet.taskId || file.scope !== 'repository'),
    )
  ) {
    throw new Error('Calibration fixture layout must provide repository artifacts only for its two task ids.');
  }
  if (!EffectArray.isArray(plan.runs) || plan.runs.length !== clients.length * tasks.length * 3) {
    throw new Error('Calibration plan does not contain the complete bounded client/task/arm matrix.');
  }
  const expectedRuns = EffectArray.map(
    EffectArray.flatMap(clients, clientId =>
      EffectArray.flatMap(tasks, task =>
        EffectArray.map(['anchored', 'task-only', 'no-memory'] as const, arm => ({
          arm,
          clientId,
          taskId: task.packet.taskId,
        })),
      ),
    ),
    (run, runOrder) => ({...run, runOrder}),
  );
  const runs = EffectArray.map(plan.runs, (input, index) => {
    const run = record(input, `calibration run ${index}`);
    exactKeys(run, ['arm', 'clientId', 'runOrder', 'taskId'], `calibration run ${index}`);
    const parsed = {
      arm: arm(run.arm, `calibration run ${index} arm`),
      clientId: matching(run.clientId, CLIENT_ID, `calibration run ${index} client`),
      taskId: matching(run.taskId, TASK_ID, `calibration run ${index} task`),
      runOrder: nonnegativeInteger(run.runOrder, `calibration run ${index} order`),
    };
    const expected = expectedRuns[index];
    if (
      expected === undefined ||
      parsed.arm !== expected.arm ||
      parsed.clientId !== expected.clientId ||
      parsed.runOrder !== expected.runOrder ||
      parsed.taskId !== expected.taskId
    ) {
      throw new Error(`Calibration run ${index} is not in canonical non-outcome-dependent order.`);
    }
    return parsed;
  });
  const withoutHash = {
    calibrationCorpusHash,
    clients,
    fixture,
    fixtureFiles,
    kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
    releaseLedgerCompatible: false as const,
    runs,
    tasks,
    version: CODE_MEMORY_LINK_CALIBRATION_PLAN_VERSION,
  };
  const planHash = matching(plan.planHash, HASH, 'calibration plan hash');
  if (planHash !== preparationDigest('calibration-plan', withoutHash)) {
    throw new Error('Calibration plan hash does not match its canonical contents.');
  }
  return {...withoutHash, planHash};
}

export function createCalibrationResult(
  plan: CodeMemoryLinkCalibrationPlanV1,
  run: CodeMemoryLinkCalibrationPlanV1['runs'][number],
  value: unknown,
  previousResultDigest: string | null,
): CodeMemoryLinkCalibrationResultV1 {
  const raw = record(value, 'calibration command output');
  exactKeys(
    raw,
    ['arm', 'clientId', 'diagnosticsHash', 'kind', 'planHash', 'runOrder', 'taskId', 'version'],
    'calibration command output',
  );
  assertNoForbiddenCalibrationFields(raw);
  if (
    raw.version !== CODE_MEMORY_LINK_CALIBRATION_RESULT_VERSION ||
    raw.kind !== CODE_MEMORY_LINK_CALIBRATION_KIND ||
    raw.planHash !== plan.planHash ||
    raw.arm !== run.arm ||
    raw.clientId !== run.clientId ||
    raw.runOrder !== run.runOrder ||
    raw.taskId !== run.taskId
  ) {
    throw new Error('Calibration command output does not match the exact scheduled non-evidence run.');
  }
  const withoutHash = {
    arm: run.arm,
    clientId: run.clientId,
    diagnosticsHash: matching(raw.diagnosticsHash, HASH, 'calibration diagnostics hash'),
    kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
    planHash: plan.planHash,
    previousResultDigest:
      previousResultDigest === null ? null : matching(previousResultDigest, HASH, 'previous calibration result digest'),
    runOrder: run.runOrder,
    taskId: run.taskId,
    version: CODE_MEMORY_LINK_CALIBRATION_RESULT_VERSION,
  };
  return {...withoutHash, resultHash: calibrationResultHash(withoutHash)};
}

export function parseCodeMemoryLinkCalibrationResultV1(value: unknown): CodeMemoryLinkCalibrationResultV1 {
  const result = record(value, 'calibration result');
  exactKeys(
    result,
    [
      'arm',
      'clientId',
      'diagnosticsHash',
      'kind',
      'planHash',
      'previousResultDigest',
      'resultHash',
      'runOrder',
      'taskId',
      'version',
    ],
    'calibration result',
  );
  assertNoForbiddenCalibrationFields(result);
  if (
    result.version !== CODE_MEMORY_LINK_CALIBRATION_RESULT_VERSION ||
    result.kind !== CODE_MEMORY_LINK_CALIBRATION_KIND
  ) {
    throw new Error('Calibration result is not explicitly non-evidence version 1.');
  }
  const withoutHash = {
    arm: arm(result.arm, 'calibration result arm'),
    clientId: matching(result.clientId, CLIENT_ID, 'calibration result client'),
    diagnosticsHash: matching(result.diagnosticsHash, HASH, 'calibration result diagnostics hash'),
    kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
    planHash: matching(result.planHash, HASH, 'calibration result plan hash'),
    previousResultDigest:
      result.previousResultDigest === null
        ? null
        : matching(result.previousResultDigest, HASH, 'previous calibration result digest'),
    runOrder: nonnegativeInteger(result.runOrder, 'calibration result run order'),
    taskId: matching(result.taskId, TASK_ID, 'calibration result task'),
    version: CODE_MEMORY_LINK_CALIBRATION_RESULT_VERSION,
  };
  const resultHash = matching(result.resultHash, HASH, 'calibration result hash');
  if (resultHash !== calibrationResultHash(withoutHash)) {
    throw new Error('Calibration result hash does not match its canonical contents.');
  }
  return {...withoutHash, resultHash};
}

export function parseCodeMemoryLinkCalibrationResultsJsonl(
  input: string,
): readonly CodeMemoryLinkCalibrationResultV1[] {
  if (new TextEncoder().encode(input).byteLength > MAXIMUM_CALIBRATION_LEDGER_BYTES) {
    throw new Error('Calibration JSONL exceeds 4 MiB.');
  }
  return EffectArray.flatMap(Effect2.pipe(input, EffectString.split(/\r?\n/u)), (line, index) => {
    if (!Effect2.pipe(line, EffectString.trim)) return [];
    try {
      return [parseCodeMemoryLinkCalibrationResultV1(JSON.parse(line) as unknown)];
    } catch (cause) {
      throw new Error(`Invalid calibration JSONL line ${index + 1}.`, {cause});
    }
  });
}

export function assertCodeMemoryLinkCalibrationPrefixV1(
  plan: CodeMemoryLinkCalibrationPlanV1,
  resultsInput: readonly unknown[],
): void {
  const results = EffectArray.map(resultsInput, parseCodeMemoryLinkCalibrationResultV1);
  if (results.length > plan.runs.length) throw new Error('Calibration results exceed the frozen schedule.');
  for (const [index, result] of results.entries()) {
    const run = plan.runs[index];
    const previous = index === 0 ? null : calibrationResultDigest(results[index - 1]);
    if (
      result.planHash !== plan.planHash ||
      result.runOrder !== run.runOrder ||
      result.clientId !== run.clientId ||
      result.taskId !== run.taskId ||
      result.arm !== run.arm ||
      result.previousResultDigest !== previous
    ) {
      throw new Error(`Calibration result ${index} does not extend the exact frozen schedule prefix.`);
    }
  }
}

export function calibrationResultDigest(value: unknown): string {
  return sha256(`${JSON.stringify(parseCodeMemoryLinkCalibrationResultV1(value))}\n`);
}

function calibrationResultHash(value: unknown): string {
  return sha256(`threadnote-code-memory-link-calibration-result-v1\0${JSON.stringify(value)}\n`);
}

function preparationDigest(domain: string, value: unknown): string {
  return sha256(`threadnote-code-memory-link-preparation-v1\0${domain}\0${JSON.stringify(value)}\n`);
}

async function appendExclusiveLine(path: string, expectedRecords: number, value: unknown): Promise<void> {
  const current = await readOptionalText(path, MAXIMUM_CALIBRATION_LEDGER_BYTES);
  const records = parseCodeMemoryLinkCalibrationResultsJsonl(current);
  if (records.length !== expectedRecords) throw new Error('Calibration results changed concurrently; refusing append.');
  const line = `${JSON.stringify(value)}\n`;
  if (expectedRecords === 0) {
    await writeFile(path, line, {encoding: 'utf8', flag: 'wx', mode: 0o600});
    return;
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error('Calibration results must remain one regular non-linked file.');
  }
  await writeFile(path, line, {encoding: 'utf8', flag: 'a'});
}

function parseArguments(arguments_: readonly string[]): Options {
  const values = new Map<string, string>();
  const calibrationArguments: string[] = [];
  const scalarOptions = new Set([
    '--approval-commit',
    '--attempts',
    '--calibration-command',
    '--calibration-results',
    '--candidate-commit',
    '--candidate-executable',
    '--candidate-executable-sha256',
    '--evidence',
    '--mode',
    '--pacing-ms',
    '--root',
    '--timeout-ms',
    '--trials',
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === '--calibration-arg') {
      calibrationArguments.push(required(arguments_[++index], option));
    } else if (scalarOptions.has(option)) {
      if (values.has(option)) throw ScriptError.make({message: `${option} may be supplied only once.`});
      values.set(option, required(arguments_[++index], option));
    } else {
      throw ScriptError.make({message: `Unknown Code Memory Link matrix option: ${option}`});
    }
  }
  const mode = required(values.get('--mode'), '--mode');
  const root = normalizedAbsolute(required(values.get('--root'), '--root'), '--root');
  const pacingMilliseconds = boundedNonnegativeInteger(values.get('--pacing-ms') ?? '1000', '--pacing-ms', 60_000);
  const timeoutMilliseconds = boundedPositiveInteger(
    values.get('--timeout-ms') ?? '1800000',
    '--timeout-ms',
    3_600_000,
  );
  if (mode === 'release') {
    for (const forbidden of ['--calibration-command', '--calibration-results']) {
      if (values.has(forbidden) || calibrationArguments.length > 0) {
        throw ScriptError.make({
          message: 'Release mode cannot accept calibration command, arguments, or result paths.',
        });
      }
    }
    return {
      approvalCommit: matching(
        required(values.get('--approval-commit'), '--approval-commit'),
        COMMIT,
        'approval commit',
      ),
      attemptsPath: normalizedAbsolute(required(values.get('--attempts'), '--attempts'), '--attempts'),
      candidateCommit: matching(
        required(values.get('--candidate-commit'), '--candidate-commit'),
        COMMIT,
        'candidate commit',
      ),
      candidateExecutable: normalizedAbsolute(
        required(values.get('--candidate-executable'), '--candidate-executable'),
        '--candidate-executable',
      ),
      candidateExecutableSha256: matching(
        required(values.get('--candidate-executable-sha256'), '--candidate-executable-sha256'),
        HASH,
        'candidate executable hash',
      ),
      evidencePath: normalizedAbsolute(required(values.get('--evidence'), '--evidence'), '--evidence'),
      mode,
      pacingMilliseconds,
      root,
      timeoutMilliseconds,
      trialsPath: normalizedAbsolute(required(values.get('--trials'), '--trials'), '--trials'),
    };
  }
  if (mode === 'calibration') {
    for (const forbidden of [
      '--approval-commit',
      '--attempts',
      '--candidate-commit',
      '--candidate-executable',
      '--candidate-executable-sha256',
      '--evidence',
      '--trials',
    ]) {
      if (values.has(forbidden))
        throw ScriptError.make({message: `Calibration mode cannot accept release option ${forbidden}.`});
    }
    return {
      calibrationArguments,
      calibrationCommand: normalizedAbsolute(
        required(values.get('--calibration-command'), '--calibration-command'),
        '--calibration-command',
      ),
      mode,
      pacingMilliseconds,
      resultsPath: normalizedAbsolute(
        required(values.get('--calibration-results'), '--calibration-results'),
        '--calibration-results',
      ),
      root,
      timeoutMilliseconds,
    };
  }
  throw ScriptError.make({message: '--mode must be release or calibration.'});
}

async function readJson(path: string): Promise<unknown> {
  return parseJson(await readRequiredText(path, 8 * 1_024 * 1_024), path);
}

function parseJson(input: string, label: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch (cause) {
    throw new Error(`${label} is not valid JSON.`, {cause});
  }
}

async function readRequiredText(path: string, maximumBytes: number): Promise<string> {
  const value = await readOptionalTextOrNull(path, maximumBytes);
  if (value === null) throw new Error(`${path} does not exist.`);
  return value;
}

async function readOptionalText(path: string, maximumBytes: number): Promise<string> {
  return (await readOptionalTextOrNull(path, maximumBytes)) ?? '';
}

async function readOptionalTextOrNull(path: string, maximumBytes: number): Promise<string | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (isMissingFileError(cause)) return null;
    throw cause;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${path} must be one regular non-linked file.`);
  }
  if (metadata.size > maximumBytes) throw new Error(`${path} exceeds its byte limit.`);
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error(`${path} changed while it was read.`);
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch (cause) {
    throw new Error(`${path} is not valid UTF-8 text.`, {cause});
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const normalized = normalizedAbsolute(path, label);
  const metadata = await lstat(normalized);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  const canonical = await realpath(normalized);
  if (canonical !== normalized) throw new Error(`${label} must use its canonical real path.`);
  return canonical;
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  const normalized = normalizedAbsolute(path, label);
  const metadata = await lstat(normalized);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${label} must be one regular non-linked file.`);
  }
  if ((metadata.mode & 0o111) === 0 && Effect2.pipe(label, EffectString.includes('executable'))) {
    throw new Error(`${label} must be executable.`);
  }
  const canonical = await realpath(normalized);
  const current = await stat(canonical);
  if (canonical !== normalized || current.dev !== metadata.dev || current.ino !== metadata.ino) {
    throw new Error(`${label} changed or is not canonical.`);
  }
  return canonical;
}

export async function resolveCodeMemoryLinkAgentTrialRunner(): Promise<string> {
  return canonicalRegularFile(
    fileURLToPath(new URL('./run-code-memory-link-agent-trial.ts', import.meta.url)),
    'exact-runtime trial runner',
  );
}

function normalizedAbsolute(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Effect2.pipe(value, EffectString.includes('\0')) ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error(`${label} must be a normalized absolute path.`);
  }
  return value;
}

function relativeFile(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4_096 ||
    Effect2.pipe(value, EffectString.includes('\\')) ||
    Effect2.pipe(value, EffectString.includes('\0')) ||
    isAbsolute(value) ||
    posix.normalize(value) !== value ||
    Effect2.pipe(value, EffectString.endsWith('/')) ||
    EffectArray.some(
      Effect2.pipe(value, EffectString.split('/')),
      segment => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(`${label} must be one normalized relative file path.`);
  }
  return value;
}

function fixtureScope(value: unknown, label: string): 'repository' | 'threadnote-home' {
  if (value !== 'repository' && value !== 'threadnote-home') throw new Error(`${label} is invalid.`);
  return value;
}

function joinRoot(root: string, relative: string): string {
  if (
    !relative ||
    Effect2.pipe(relative, EffectString.startsWith('/')) ||
    Effect2.pipe(relative, EffectString.includes('\\'))
  )
    throw new Error('Prepared path is invalid.');
  const joined = resolve(root, relative);
  if (joined === root || !Effect2.pipe(joined, EffectString.startsWith(`${root}/`)))
    throw new Error('Prepared path escapes the experiment root.');
  return joined;
}

function assertOutsideRoot(root: string, path: string, label: string): void {
  if (path === root || Effect2.pipe(path, EffectString.startsWith(`${root}/`))) {
    throw new Error(`${label} must be outside the immutable prepared experiment root.`);
  }
}

function assertNoForbiddenCalibrationFields(value: unknown): void {
  if (EffectArray.isArray(value)) {
    for (const item of value) assertNoForbiddenCalibrationFields(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of EffectRecord.toEntries(value)) {
    if (CALIBRATION_FORBIDDEN_FIELDS.has(key)) {
      throw new Error(`Calibration data cannot contain release-evidence field ${key}.`);
    }
    assertNoForbiddenCalibrationFields(nested);
  }
}

async function capture(
  command: string,
  arguments_: readonly string[],
  options: {
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly maxOutputBytes: number;
    readonly timeoutMilliseconds: number;
  },
): Promise<{readonly exitCode: number; readonly stderr: string; readonly stdout: string}> {
  return await captureCodeMemoryLinkProcessGroup({
    allowFailure: true,
    arguments: arguments_,
    command,
    cwd: options.cwd,
    environment: options.environment,
    label: 'Command',
    maxOutputBytes: options.maxOutputBytes,
    timeoutMilliseconds: options.timeoutMilliseconds,
  });
}

function minimalEnvironment(): Readonly<Record<string, string>> {
  return {HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PATH: '/usr/bin:/bin', TMPDIR: '/tmp'};
}

export function codeMemoryLinkReleaseRunnerEnvironment(
  candidateInstallRootInput: string,
): Readonly<Record<string, string>> {
  const candidateInstallRoot = normalizedAbsolute(candidateInstallRootInput, 'verified candidate installation root');
  return {...minimalEnvironment(), THREADNOTE_INSTALL_ROOT: candidateInstallRoot};
}

export function boundedCodeMemoryLinkChildFailureDiagnostic(input: {
  readonly stderr: string;
  readonly stdout: string;
}): string {
  const streams = [
    ...(input.stderr ? [{label: 'stderr', value: input.stderr}] : []),
    ...(input.stdout ? [{label: 'stdout', value: input.stdout}] : []),
  ];
  if (streams.length === 0) return '(child produced no stdout or stderr)';
  const headers = EffectArray.map(streams, stream => `${stream.label}:\n`);
  const payloadBudget = MAXIMUM_CHILD_FAILURE_DIAGNOSTIC_CHARACTERS - EffectArray.join(headers, '\n').length;
  const fairShare = Math.floor(payloadBudget / streams.length);
  const budgets = EffectArray.map(streams, stream => Math.min(stream.value.length, fairShare));
  let remaining = payloadBudget - EffectArray.reduce(budgets, 0, (total, budget) => total + budget);
  for (let index = streams.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const available = streams[index].value.length - budgets[index];
    const granted = Math.min(available, remaining);
    budgets[index] += granted;
    remaining -= granted;
  }
  return EffectArray.join(
    EffectArray.map(
      streams,
      (stream, index) => `${headers[index]}${Effect2.pipe(stream.value, EffectString.slice(-budgets[index]))}`,
    ),
    '\n',
  );
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds === 0
    ? Promise.resolve()
    : new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || EffectArray.some(actual, (key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function stringArray(value: unknown, label: string, requireNonempty: boolean): readonly string[] {
  if (
    !EffectArray.isArray(value) ||
    (requireNonempty && value.length === 0) ||
    EffectArray.some(value, item => typeof item !== 'string')
  ) {
    throw new Error(`${label} must be ${requireNonempty ? 'a nonempty' : 'an'} array of strings.`);
  }
  return EffectArray.filter(value, (item): item is string => typeof item === 'string');
}

function fileBindingArray(value: unknown, label: string): readonly {readonly path: string; readonly role: string}[] {
  if (!EffectArray.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error(`${label} bindings must be a bounded nonempty array.`);
  }
  const bindings = EffectArray.map(value, (input, index) => {
    const binding = record(input, `${label} binding ${index}`);
    exactKeys(binding, ['path', 'role'], `${label} binding ${index}`);
    return {
      path: normalizedAbsolute(binding.path, `${label} binding ${index} path`),
      role: matching(binding.role, /^[a-z][a-z0-9-]{0,63}$/u, `${label} binding ${index} role`),
    };
  });
  canonicalAscendingUnique(
    EffectArray.map(bindings, binding => binding.role),
    `${label} binding roles`,
  );
  unique(
    EffectArray.map(bindings, binding => binding.path),
    `${label} binding paths`,
  );
  return bindings;
}

function assertDescriptorBindingRoster(
  actual: readonly {readonly path: string; readonly role: string}[],
  expected: readonly {readonly pathDigest: string; readonly role: string}[],
  label: string,
): void {
  const projection = EffectArray.map(actual, binding => ({
    pathDigest: codeMemoryLinkClientPathDigest(binding.path),
    role: binding.role,
  }));
  const descriptorProjection = EffectArray.map(expected, ({pathDigest, role}) => ({pathDigest, role}));
  if (JSON.stringify(projection) !== JSON.stringify(descriptorProjection)) {
    throw new Error(`${label} binding roles or paths differ from the descriptor.`);
  }
}

function selectedMemoryRoster(
  value: unknown,
  label: string,
): readonly {readonly contentSha256: string; readonly memoryIdDigest: string}[] {
  if (!EffectArray.isArray(value) || value.length > 24) throw new Error(`${label} is invalid.`);
  const parsed = EffectArray.map(value, (input, index) => {
    const memory = record(input, `${label}[${index}]`);
    exactKeys(memory, ['contentSha256', 'memoryIdDigest'], `${label}[${index}]`);
    return {
      contentSha256: matching(memory.contentSha256, HASH, `${label}[${index}] content hash`),
      memoryIdDigest: matching(memory.memoryIdDigest, HASH, `${label}[${index}] identity digest`),
    };
  });
  if (
    EffectArray.some(
      parsed,
      (entry, index) =>
        index > 0 &&
        (parsed[index - 1].memoryIdDigest > entry.memoryIdDigest ||
          (parsed[index - 1].memoryIdDigest === entry.memoryIdDigest &&
            parsed[index - 1].contentSha256 >= entry.contentSha256)),
    ) ||
    new Set(EffectArray.map(parsed, memory => memory.memoryIdDigest)).size !== parsed.length
  ) {
    throw new Error(`${label} must be unique in canonical order.`);
  }
  return parsed;
}

function canonicalAscendingUnique(values: readonly string[], label: string): void {
  if (EffectArray.some(values, (value, index) => index > 0 && value <= values[index - 1])) {
    throw new Error(`${label} must be unique in canonical ascending order.`);
  }
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
}

function arm(value: unknown, label: string): 'anchored' | 'no-memory' | 'task-only' {
  if (value !== 'anchored' && value !== 'no-memory' && value !== 'task-only') throw new Error(`${label} is invalid.`);
  return value;
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!checkedIsSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer.`);
  return value;
}

function boundedPositiveInteger(value: string, label: string, maximum: number): number {
  const parsed = Number(value);
  if (!checkedIsSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw ScriptError.make({message: `${label} must be a positive integer no greater than ${maximum}.`});
  }
  return parsed;
}

function boundedNonnegativeInteger(value: string, label: string, maximum: number): number {
  const parsed = Number(value);
  if (!checkedIsSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw ScriptError.make({message: `${label} must be a nonnegative integer no greater than ${maximum}.`});
  }
  return parsed;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

function isMissingFileError(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));

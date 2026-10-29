#!/usr/bin/env bun
import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';

import {Schema} from 'effect';

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed calibration adapter owns explicit process and filesystem boundaries. */
import {lstat, mkdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {parseCodeMemoryLinkAgentAbManifestV1} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ab';
import {
  codeMemoryLinkArmPacketHashV1,
  deriveCodeMemoryLinkCodexAppServerProjectionV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {
  codeMemoryLinkCodexInvocationNonceDigestV1,
  codeMemoryLinkCodexRunBindingHashV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-codex-evidence';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CODE_MEMORY_LINK_AGENT_SUITE_PROJECT} from '@threadnote/threadnote/evaluation/code-memory-link-agent-suite';
import {parseCodeMemoryLinkCodexClientConfigV1} from './code-memory-link-codex-isolation.js';
import {
  classifyCodeMemoryLinkCodexTerminal,
  CodeMemoryLinkCodexTerminalError,
  type CodeMemoryLinkCodexTerminalDiagnosticsV1,
} from './code-memory-link-codex-terminal.js';
import {verifyCodeMemoryLinkEvaluatedSubject} from './code-memory-link-evaluated-subject.js';
import {
  CODE_MEMORY_LINK_CALIBRATION_KIND,
  type CodeMemoryLinkCalibrationPlanV1,
} from './prepare-code-memory-link-agent-ab.js';
import {parseCalibrationPlan, parseClientRegistry} from './run-code-memory-link-agent-matrix.js';
import {runCodeMemoryLinkCodexExecutionTask} from './run-code-memory-link-codex-client.js';
import {
  loadCodeMemoryLinkCodexSuiteTask,
  type CodeMemoryLinkVerifiedArtifactV1,
} from './code-memory-link-codex-suite.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CLIENT_ID = /^cli_[0-9a-f]{16,64}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const MAXIMUM_DIAGNOSTICS_BYTES = 1 * 1_024 * 1_024;

interface Options {
  readonly candidateCommit: string;
  readonly candidateExecutable: string;
  readonly candidateExecutableSha256: string;
  readonly diagnosticsPath: string;
  readonly preparedRoot: string;
}

interface CalibrationEnvironment {
  readonly arm: 'anchored' | 'no-memory' | 'task-only';
  readonly clientId: string;
  readonly planHash: string;
  readonly planPath: string;
  readonly root: string;
  readonly runOrder: number;
  readonly taskId: string;
}

interface CalibrationDiagnosticV1 {
  readonly arm: CalibrationEnvironment['arm'];
  readonly clientId: string;
  readonly contextBriefGoldCitationMatched: boolean;
  readonly contextBriefProtocolAdhered: boolean;
  readonly contextBriefResponseClass: 'anchored-v3' | 'empty-v1' | 'task-v2' | null;
  readonly diagnosticHash: string;
  readonly evidenceHash: string | null;
  readonly eventSummary: CodeMemoryLinkCodexTerminalDiagnosticsV1 | null;
  readonly fileChangeStarted: boolean;
  readonly firstUsefulMemoryUse: boolean;
  readonly finalMutationState: 'audit-only' | 'none' | 'other' | 'result-and-audit' | 'result-only' | null;
  readonly finalResultState: 'changed-incorrectly' | 'expected' | 'missing' | 'unchanged' | null;
  readonly kind: typeof CODE_MEMORY_LINK_CALIBRATION_KIND;
  readonly planHash: string;
  readonly runOrder: number;
  readonly status: 'completed' | 'terminal';
  readonly taskId: string;
  readonly taskPassed: boolean | null;
  readonly terminalKind: string | null;
  readonly totalTaskUsage: {readonly steps: number; readonly tokens: number} | null;
  readonly version: 1;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const environment = parseEnvironment(process.env);
  const preparedRoot = await canonicalDirectory(options.preparedRoot, 'prepared root');
  const calibrationRoot = await canonicalDirectory(environment.root, 'calibration root');
  if (await existingDiagnostic(options.diagnosticsPath, environment)) return;
  const plan = parseCalibrationPlan(await readJson(environment.planPath));
  if (plan.planHash !== environment.planHash) throw new Error('Calibration environment differs from its plan.');
  const scheduled = plan.runs[environment.runOrder];
  if (
    scheduled === undefined ||
    scheduled.arm !== environment.arm ||
    scheduled.clientId !== environment.clientId ||
    scheduled.taskId !== environment.taskId
  ) {
    throw new Error('Calibration environment differs from the canonical schedule.');
  }
  const task = EffectOption.getOrUndefined(
    EffectArray.findFirst(plan.tasks, candidate => candidate.packet.taskId === environment.taskId),
  );
  if (!task) throw new Error('Calibration task is outside the plan roster.');
  const manifest = parseCodeMemoryLinkAgentAbManifestV1(await readJson(join(preparedRoot, 'manifest.json')));
  const registry = parseClientRegistry(await readJson(join(preparedRoot, 'clients.json')));
  const client = EffectOption.getOrUndefined(
    EffectArray.findFirst(registry.clients, candidate => candidate.clientId === environment.clientId),
  );
  const rostered = EffectOption.getOrUndefined(
    EffectArray.findFirst(manifest.clients, candidate => candidate.clientId === environment.clientId),
  );
  if (!client || !rostered || !plan.clients.includes(environment.clientId)) {
    throw new Error('Calibration client is outside the prepared roster.');
  }
  const subject = await verifyCodeMemoryLinkEvaluatedSubject({
    executable: options.candidateExecutable,
    executableSha256: options.candidateExecutableSha256,
    sourceCommit: options.candidateCommit,
  });
  if (
    subject.identity.sourceCommit !== manifest.candidate.commit ||
    subject.identity.executableSha256 !== manifest.candidate.buildIdentityHash
  ) {
    throw new Error('Calibration subject differs from the prepared candidate.');
  }
  const baseConfig = parseCodeMemoryLinkCodexClientConfigV1(await readJson(client.clientConfigurationPath));
  const releaseTask = await loadCodeMemoryLinkCodexSuiteTask({
    expectedLayoutArtifactId: baseConfig.sealedSuite.layoutArtifactId,
    expectedSuiteHash: manifest.suiteHash,
    root: baseConfig.sealedSuite.root,
    taskId: manifest.tasks[0].taskId,
  });
  const blind = blindArm(environment.arm);
  const runNonce = opaqueId('run', `${environment.planHash}:${environment.runOrder}:run`);
  const invocationNonce = opaqueId('inv', `${environment.planHash}:${environment.runOrder}:invocation`);
  const armPacketHash = codeMemoryLinkArmPacketHashV1({
    assignmentHash: environment.planHash,
    blindLabel: blind.label,
    fixtureHash: plan.fixture.fixtureHash,
    packetHash: task.packet.packetHash,
    policy: environment.arm,
    rubricHash: task.rubric.rubricHash,
    runNonce,
    taskId: environment.taskId,
    taskKind: task.packet.taskKind,
    version: 1,
  });
  const runBindingHash = codeMemoryLinkCodexRunBindingHashV1({
    armPacketHash,
    candidateExecutableSha256: subject.identity.executableSha256,
    clientExecutionHash: client.implementationDescriptorHash,
    invocationNonceDigest: codeMemoryLinkCodexInvocationNonceDigestV1(invocationNonce),
    manifestHash: environment.planHash,
    runNonce,
    suiteHash: plan.calibrationCorpusHash,
    taskId: environment.taskId,
  });
  const clientEnvironment = {
    THREADNOTE_CODE_MEMORY_LINK_APPROVAL_COMMIT: manifest.harnessGovernanceCommit,
    THREADNOTE_CODE_MEMORY_LINK_ARM: environment.arm,
    THREADNOTE_CODE_MEMORY_LINK_ARM_POSITION: String(blind.position),
    THREADNOTE_CODE_MEMORY_LINK_ASSIGNMENT_HASH: environment.planHash,
    THREADNOTE_CODE_MEMORY_LINK_BLIND_LABEL: blind.label,
    THREADNOTE_CODE_MEMORY_LINK_BUDGET_STEPS: String(task.packet.budget.steps),
    THREADNOTE_CODE_MEMORY_LINK_BUDGET_TOKENS: String(task.packet.budget.tokens),
    THREADNOTE_CODE_MEMORY_LINK_CANDIDATE_COMMIT: subject.identity.sourceCommit,
    THREADNOTE_CODE_MEMORY_LINK_CLIENT_CONFIGURATION_PROJECTION_HASH: client.descriptor.configurationProjectionHash,
    THREADNOTE_CODE_MEMORY_LINK_CLIENT_DESCRIPTOR_HASH: client.implementationDescriptorHash,
    THREADNOTE_CODE_MEMORY_LINK_CLIENT_ENVIRONMENT_POLICY_HASH: client.descriptor.environmentPolicyHash,
    THREADNOTE_CODE_MEMORY_LINK_CLIENT_EXECUTION_BUNDLE_HASH: client.descriptor.executionBundleHash,
    THREADNOTE_CODE_MEMORY_LINK_CLIENT_EXPECTED_PROJECTION_HASH: client.descriptor.expectedClientProjectionHash,
    THREADNOTE_CODE_MEMORY_LINK_CLIENT_ID: environment.clientId,
    THREADNOTE_CODE_MEMORY_LINK_EXECUTABLE: subject.executable,
    THREADNOTE_CODE_MEMORY_LINK_EXECUTABLE_SHA256: subject.identity.executableSha256,
    THREADNOTE_CODE_MEMORY_LINK_FIXTURE_HASH: plan.fixture.fixtureHash,
    THREADNOTE_CODE_MEMORY_LINK_INVOCATION_NONCE: invocationNonce,
    THREADNOTE_CODE_MEMORY_LINK_MANIFEST_HASH: environment.planHash,
    THREADNOTE_CODE_MEMORY_LINK_PACKET_HASH: task.packet.packetHash,
    THREADNOTE_CODE_MEMORY_LINK_RUBRIC_HASH: task.rubric.rubricHash,
    THREADNOTE_CODE_MEMORY_LINK_RUN_NONCE: runNonce,
    THREADNOTE_CODE_MEMORY_LINK_RUN_BINDING_HASH: runBindingHash,
    THREADNOTE_CODE_MEMORY_LINK_RUN_ORDER: String(environment.runOrder),
    THREADNOTE_CODE_MEMORY_LINK_SUITE_HASH: plan.calibrationCorpusHash,
    THREADNOTE_CODE_MEMORY_LINK_TASK_ID: environment.taskId,
    THREADNOTE_CODE_MEMORY_LINK_TASK_KIND: task.packet.taskKind,
    THREADNOTE_CODE_MEMORY_LINK_CLIENT_CONFIG: client.clientConfigurationPath,
  };
  let diagnostic: CalibrationDiagnosticV1;
  try {
    const output = await runCodeMemoryLinkCodexExecutionTask(clientEnvironment, baseConfig, {
      fixture: await calibrationFixture(plan, environment.taskId, calibrationRoot),
      fixtureHash: plan.fixture.fixtureHash,
      judge: releaseTask.judge,
      mappedTask: {
        packetHash: task.packet.packetHash,
        packetSource: `calibration/tasks/${environment.taskId}/packet.json`,
        preflightCodeRefs: ['policy.json'],
        preflightExpectedCitationDigests: task.preflightExpectedCitationDigests,
        preflightExpectedResponses: task.preflightExpectedResponses,
        preflightExpectedSelectedMemories: task.preflightExpectedSelectedMemories,
        project: CODE_MEMORY_LINK_AGENT_SUITE_PROJECT,
        rubricHash: task.rubric.rubricHash,
        rubricSource: `calibration/tasks/${environment.taskId}/rubric.json`,
        taskId: environment.taskId,
        taskKind: task.packet.taskKind,
      },
      rubric: task.rubric,
      taskPacket: task.packet,
    });
    diagnostic = completedDiagnostic(environment, output, plan);
  } catch (cause) {
    diagnostic = terminalDiagnostic(environment, cause);
  }
  await verifyCodeMemoryLinkEvaluatedSubject({
    executable: options.candidateExecutable,
    executableSha256: options.candidateExecutableSha256,
    sourceCommit: options.candidateCommit,
  });
  await appendDiagnostic(options.diagnosticsPath, diagnostic, environment.runOrder);
  process.stdout.write(
    `${JSON.stringify({
      arm: environment.arm,
      clientId: environment.clientId,
      diagnosticsHash: diagnostic.diagnosticHash,
      kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
      planHash: environment.planHash,
      runOrder: environment.runOrder,
      taskId: environment.taskId,
      version: 1,
    })}\n`,
  );
}

function completedDiagnostic(
  environment: CalibrationEnvironment,
  output: Awaited<ReturnType<typeof runCodeMemoryLinkCodexExecutionTask>>,
  plan: CodeMemoryLinkCalibrationPlanV1,
): CalibrationDiagnosticV1 {
  const projection = deriveCodeMemoryLinkCodexAppServerProjectionV1({
    evidence: output.rawEvidence.appServer,
    rubric: output.rawEvidence.rubric,
  });
  const onlyCall = projection.contextBriefCalls.length === 1 ? projection.contextBriefCalls[0] : null;
  const finalStates = classifyFinalStates(plan, environment.taskId, output.rawEvidence.finalPublicArtifacts);
  return sealDiagnostic({
    environment,
    contextBriefGoldCitationMatched: EffectArray.some(projection.contextBriefCalls, call => call.goldCitationMatched),
    contextBriefProtocolAdhered: projection.contextBriefProtocolAdhered,
    contextBriefResponseClass: onlyCall?.responseClass ?? null,
    evidenceHash: output.rawEvidence.evidenceHash,
    eventSummary: null,
    fileChangeStarted: output.rawEvidence.appServer.qualifyingActionItemDigest !== null,
    firstUsefulMemoryUse: projection.firstUsefulMemoryUse !== null,
    finalMutationState: finalStates.mutation,
    finalResultState: finalStates.result,
    status: 'completed',
    taskPassed: projection.taskPassed,
    terminalKind: null,
    totalTaskUsage: projection.totalTaskUsage,
  });
}

function terminalDiagnostic(environment: CalibrationEnvironment, cause: unknown): CalibrationDiagnosticV1 {
  const eventSummary = Schema.is(CodeMemoryLinkCodexTerminalError)(cause) ? cause.diagnostics : null;
  return sealDiagnostic({
    environment,
    contextBriefGoldCitationMatched: false,
    contextBriefProtocolAdhered: false,
    contextBriefResponseClass: null,
    evidenceHash: null,
    eventSummary,
    fileChangeStarted: (eventSummary?.startedItems.fileChange ?? 0) > 0,
    firstUsefulMemoryUse: false,
    finalMutationState: null,
    finalResultState: null,
    status: 'terminal',
    taskPassed: null,
    terminalKind: classifyCodeMemoryLinkCodexTerminal(cause),
    totalTaskUsage: eventSummary?.totalTaskUsage ?? null,
  });
}

function classifyFinalStates(
  plan: CodeMemoryLinkCalibrationPlanV1,
  taskId: string,
  finalArtifacts: readonly {readonly contentSha256: string; readonly pathDigest: string}[],
): {
  readonly mutation: Exclude<CalibrationDiagnosticV1['finalMutationState'], null>;
  readonly result: Exclude<CalibrationDiagnosticV1['finalResultState'], null>;
} {
  const initialFiles = EffectArray.map(
    EffectArray.filter(plan.fixtureFiles, entry => entry.taskId === taskId && entry.scope === 'repository'),
    mapping => {
      const artifact = EffectOption.getOrUndefined(
        EffectArray.findFirst(plan.fixture.artifacts, candidate => candidate.artifactId === mapping.artifactId),
      );
      if (!artifact) throw new Error('Calibration repository fixture artifact is missing.');
      return {path: mapping.destination, sha256: artifact.sha256};
    },
  );
  const mutation = classifyCodeMemoryLinkCalibrationMutationV1({finalArtifacts, initialFiles});
  const mapping = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      plan.fixtureFiles,
      entry => entry.taskId === taskId && entry.scope === 'repository' && entry.destination === 'result.json',
    ),
  );
  if (!mapping) throw new Error('Calibration task has no result.json fixture mapping.');
  const initial = EffectOption.getOrUndefined(
    EffectArray.findFirst(plan.fixture.artifacts, artifact => artifact.artifactId === mapping.artifactId),
  );
  if (!initial) throw new Error('Calibration result.json fixture artifact is missing.');
  const final = EffectOption.getOrUndefined(
    EffectArray.findFirst(finalArtifacts, artifact => artifact.pathDigest === publicPathDigest('result.json')),
  );
  if (!final) return {mutation, result: 'missing'};
  const task = EffectOption.getOrUndefined(
    EffectArray.findFirst(plan.tasks, candidate => candidate.packet.taskId === taskId),
  );
  const resultPredicate =
    task === undefined
      ? undefined
      : EffectOption.getOrUndefined(
          EffectArray.findFirst(
            task.rubric.predicates,
            predicate => predicate.roles.includes('task-pass') && predicate.assertion.kind === 'json-equals',
          ),
        );
  if (!resultPredicate || resultPredicate.assertion.kind !== 'json-equals') {
    throw new Error('Calibration task has no JSON result predicate.');
  }
  const expectedHash = sha256HexSync(`${JSON.stringify(resultPredicate.assertion.expected)}\n`);
  if (final.contentSha256 === expectedHash) return {mutation, result: 'expected'};
  return {mutation, result: final.contentSha256 === initial.sha256 ? 'unchanged' : 'changed-incorrectly'};
}

export function classifyCodeMemoryLinkCalibrationMutationV1(input: {
  readonly finalArtifacts: readonly {readonly contentSha256: string; readonly pathDigest: string}[];
  readonly initialFiles: readonly {readonly path: string; readonly sha256: string}[];
}): Exclude<CalibrationDiagnosticV1['finalMutationState'], null> {
  const initialByDigest = new Map(
    EffectArray.map(input.initialFiles, file => [publicPathDigest(file.path), file.sha256]),
  );
  const finalByDigest = new Map(EffectArray.map(input.finalArtifacts, file => [file.pathDigest, file.contentSha256]));
  const resultDigest = publicPathDigest('result.json');
  const auditDigest = publicPathDigest('audit.json');
  const resultChanged = finalByDigest.get(resultDigest) !== initialByDigest.get(resultDigest);
  const auditChanged = finalByDigest.has(auditDigest);
  const otherChanged =
    EffectArray.some(
      [...initialByDigest],
      ([pathDigest, contentSha256]) => pathDigest !== resultDigest && finalByDigest.get(pathDigest) !== contentSha256,
    ) ||
    EffectArray.some(
      [...finalByDigest],
      ([pathDigest, contentSha256]) =>
        pathDigest !== resultDigest && pathDigest !== auditDigest && initialByDigest.get(pathDigest) !== contentSha256,
    );
  if (otherChanged) return 'other';
  if (resultChanged && auditChanged) return 'result-and-audit';
  if (resultChanged) return 'result-only';
  if (auditChanged) return 'audit-only';
  return 'none';
}

function publicPathDigest(path: string): string {
  return sha256HexSync(`threadnote-code-memory-link-public-path-v1\0${path}`);
}

async function calibrationFixture(
  plan: CodeMemoryLinkCalibrationPlanV1,
  taskId: string,
  root: string,
): Promise<{
  readonly repository: readonly CodeMemoryLinkVerifiedArtifactV1[];
  readonly threadnoteHome: readonly CodeMemoryLinkVerifiedArtifactV1[];
}> {
  const artifacts = new Map(EffectArray.map(plan.fixture.artifacts, artifact => [artifact.artifactId, artifact]));
  const loaded = await Promise.all(
    EffectArray.map(
      EffectArray.filter(plan.fixtureFiles, mapping => mapping.taskId === taskId),
      async mapping => {
        const descriptor = artifacts.get(mapping.artifactId);
        if (!descriptor) throw new Error('Calibration fixture mapping is outside the artifact roster.');
        const bytes = new Uint8Array(await readFile(joinRoot(root, mapping.source)));
        if (sha256HexSync(bytes) !== descriptor.sha256) {
          throw new Error('Calibration fixture bytes differ from the content-addressed plan.');
        }
        return {
          artifact: {
            artifactId: mapping.artifactId,
            bytes,
            destination: mapping.destination,
            sha256: descriptor.sha256,
          } satisfies CodeMemoryLinkVerifiedArtifactV1,
          scope: mapping.scope,
        };
      },
    ),
  );
  const repository = EffectArray.map(
    EffectArray.filter(loaded, item => item.scope === 'repository'),
    item => item.artifact,
  );
  if (repository.length === 0) throw new Error('Calibration task has no repository fixture.');
  return {
    repository,
    threadnoteHome: EffectArray.map(
      EffectArray.filter(loaded, item => item.scope === 'threadnote-home'),
      item => item.artifact,
    ),
  };
}

function sealDiagnostic(input: {
  readonly environment: CalibrationEnvironment;
  readonly contextBriefGoldCitationMatched: boolean;
  readonly contextBriefProtocolAdhered: boolean;
  readonly contextBriefResponseClass: CalibrationDiagnosticV1['contextBriefResponseClass'];
  readonly evidenceHash: string | null;
  readonly eventSummary: CodeMemoryLinkCodexTerminalDiagnosticsV1 | null;
  readonly fileChangeStarted: boolean;
  readonly firstUsefulMemoryUse: boolean;
  readonly finalMutationState: CalibrationDiagnosticV1['finalMutationState'];
  readonly finalResultState: CalibrationDiagnosticV1['finalResultState'];
  readonly status: 'completed' | 'terminal';
  readonly taskPassed: boolean | null;
  readonly terminalKind: string | null;
  readonly totalTaskUsage: {readonly steps: number; readonly tokens: number} | null;
}): CalibrationDiagnosticV1 {
  const withoutHash = {
    arm: input.environment.arm,
    clientId: input.environment.clientId,
    contextBriefGoldCitationMatched: input.contextBriefGoldCitationMatched,
    contextBriefProtocolAdhered: input.contextBriefProtocolAdhered,
    contextBriefResponseClass: input.contextBriefResponseClass,
    evidenceHash: input.evidenceHash,
    eventSummary: input.eventSummary,
    fileChangeStarted: input.fileChangeStarted,
    firstUsefulMemoryUse: input.firstUsefulMemoryUse,
    finalMutationState: input.finalMutationState,
    finalResultState: input.finalResultState,
    kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
    planHash: input.environment.planHash,
    runOrder: input.environment.runOrder,
    status: input.status,
    taskId: input.environment.taskId,
    taskPassed: input.taskPassed,
    terminalKind: input.terminalKind,
    totalTaskUsage: input.totalTaskUsage,
    version: 1 as const,
  };
  return {...withoutHash, diagnosticHash: diagnosticHash(withoutHash)};
}

async function existingDiagnostic(path: string, environment: CalibrationEnvironment): Promise<boolean> {
  const diagnostics = await readDiagnostics(path);
  if (diagnostics.length <= environment.runOrder) return false;
  if (diagnostics.length !== environment.runOrder + 1)
    throw new Error('Calibration diagnostics are ahead of schedule.');
  const existing = diagnostics[environment.runOrder];
  if (
    existing.arm !== environment.arm ||
    existing.clientId !== environment.clientId ||
    existing.planHash !== environment.planHash ||
    existing.runOrder !== environment.runOrder ||
    existing.taskId !== environment.taskId
  ) {
    throw new Error('Calibration diagnostic recovery differs from the scheduled run.');
  }
  process.stdout.write(
    `${JSON.stringify({
      arm: environment.arm,
      clientId: environment.clientId,
      diagnosticsHash: existing.diagnosticHash,
      kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
      planHash: environment.planHash,
      runOrder: environment.runOrder,
      taskId: environment.taskId,
      version: 1,
    })}\n`,
  );
  return true;
}

async function appendDiagnostic(path: string, diagnostic: CalibrationDiagnosticV1, expected: number): Promise<void> {
  const existing = await readDiagnostics(path);
  if (existing.length !== expected) throw new Error('Calibration diagnostics changed concurrently.');
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await writeFile(path, `${JSON.stringify(diagnostic)}\n`, {
    encoding: 'utf8',
    flag: expected === 0 ? 'wx' : 'a',
    mode: 0o600,
  });
}

async function readDiagnostics(path: string): Promise<readonly CalibrationDiagnosticV1[]> {
  let text: string;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAXIMUM_DIAGNOSTICS_BYTES) {
      throw new Error('Calibration diagnostics must be one bounded regular file.');
    }
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (isMissing(cause)) return [];
    throw cause;
  }
  return EffectArray.flatMap(Effect.pipe(text, EffectString.split(/\r?\n/u)), line =>
    line.length === 0 ? [] : [parseDiagnostic(JSON.parse(line) as unknown)],
  );
}

function parseDiagnostic(value: unknown): CalibrationDiagnosticV1 {
  const diagnostic = record(value, 'calibration diagnostic');
  const expected = [
    'arm',
    'clientId',
    'contextBriefGoldCitationMatched',
    'contextBriefProtocolAdhered',
    'contextBriefResponseClass',
    'diagnosticHash',
    'evidenceHash',
    'eventSummary',
    'fileChangeStarted',
    'firstUsefulMemoryUse',
    'finalMutationState',
    'finalResultState',
    'kind',
    'planHash',
    'runOrder',
    'status',
    'taskId',
    'taskPassed',
    'terminalKind',
    'totalTaskUsage',
    'version',
  ].sort();
  if (JSON.stringify(EffectRecord.keys(diagnostic).sort()) !== JSON.stringify(expected)) {
    throw new Error('Calibration diagnostic has unsupported fields.');
  }
  if (
    diagnostic.version !== 1 ||
    diagnostic.kind !== CODE_MEMORY_LINK_CALIBRATION_KIND ||
    (diagnostic.arm !== 'anchored' && diagnostic.arm !== 'task-only' && diagnostic.arm !== 'no-memory') ||
    (diagnostic.status !== 'completed' && diagnostic.status !== 'terminal') ||
    typeof diagnostic.contextBriefGoldCitationMatched !== 'boolean' ||
    typeof diagnostic.contextBriefProtocolAdhered !== 'boolean' ||
    (diagnostic.contextBriefResponseClass !== null &&
      diagnostic.contextBriefResponseClass !== 'anchored-v3' &&
      diagnostic.contextBriefResponseClass !== 'task-v2' &&
      diagnostic.contextBriefResponseClass !== 'empty-v1') ||
    typeof diagnostic.fileChangeStarted !== 'boolean' ||
    typeof diagnostic.firstUsefulMemoryUse !== 'boolean' ||
    (diagnostic.finalMutationState !== null &&
      diagnostic.finalMutationState !== 'audit-only' &&
      diagnostic.finalMutationState !== 'none' &&
      diagnostic.finalMutationState !== 'other' &&
      diagnostic.finalMutationState !== 'result-and-audit' &&
      diagnostic.finalMutationState !== 'result-only') ||
    (diagnostic.finalResultState !== null &&
      diagnostic.finalResultState !== 'changed-incorrectly' &&
      diagnostic.finalResultState !== 'expected' &&
      diagnostic.finalResultState !== 'missing' &&
      diagnostic.finalResultState !== 'unchanged') ||
    (diagnostic.taskPassed !== null && typeof diagnostic.taskPassed !== 'boolean') ||
    (diagnostic.terminalKind !== null && typeof diagnostic.terminalKind !== 'string')
  ) {
    throw new Error('Calibration diagnostic is invalid.');
  }
  const parsed: Omit<CalibrationDiagnosticV1, 'diagnosticHash'> = {
    arm: diagnostic.arm,
    clientId: matching(diagnostic.clientId, CLIENT_ID, 'diagnostic client'),
    contextBriefGoldCitationMatched: diagnostic.contextBriefGoldCitationMatched,
    contextBriefProtocolAdhered: diagnostic.contextBriefProtocolAdhered,
    contextBriefResponseClass: diagnostic.contextBriefResponseClass,
    evidenceHash:
      diagnostic.evidenceHash === null ? null : matching(diagnostic.evidenceHash, HASH, 'diagnostic evidence hash'),
    eventSummary: parseEventSummary(diagnostic.eventSummary),
    fileChangeStarted: diagnostic.fileChangeStarted,
    firstUsefulMemoryUse: diagnostic.firstUsefulMemoryUse,
    finalMutationState: diagnostic.finalMutationState,
    finalResultState: diagnostic.finalResultState,
    kind: CODE_MEMORY_LINK_CALIBRATION_KIND,
    planHash: matching(diagnostic.planHash, HASH, 'diagnostic plan hash'),
    runOrder: integer(diagnostic.runOrder, 'diagnostic run order'),
    status: diagnostic.status,
    taskId: matching(diagnostic.taskId, TASK_ID, 'diagnostic task'),
    taskPassed: diagnostic.taskPassed,
    terminalKind: diagnostic.terminalKind,
    totalTaskUsage: parseUsage(diagnostic.totalTaskUsage),
    version: 1 as const,
  };
  const hash = matching(diagnostic.diagnosticHash, HASH, 'diagnostic hash');
  if (hash !== diagnosticHash(parsed)) throw new Error('Calibration diagnostic hash is invalid.');
  return {...parsed, diagnosticHash: hash};
}

function parseUsage(value: unknown): {readonly steps: number; readonly tokens: number} | null {
  if (value === null) return null;
  const usage = record(value, 'calibration usage');
  if (JSON.stringify(EffectRecord.keys(usage).sort()) !== JSON.stringify(['steps', 'tokens'])) {
    throw new Error('Calibration usage has unsupported fields.');
  }
  return {steps: integer(usage.steps, 'calibration steps'), tokens: integer(usage.tokens, 'calibration tokens')};
}

function parseEventSummary(value: unknown): CodeMemoryLinkCodexTerminalDiagnosticsV1 | null {
  if (value === null) return null;
  const summary = record(value, 'calibration event summary');
  if (
    JSON.stringify(EffectRecord.keys(summary).sort()) !==
      JSON.stringify(['completedItems', 'contextBriefCallStarts', 'startedItems', 'totalTaskUsage', 'version']) ||
    summary.version !== 1
  ) {
    throw new Error('Calibration event summary is invalid.');
  }
  const totalTaskUsage = parseUsage(summary.totalTaskUsage);
  if (totalTaskUsage === null) throw new Error('Calibration event summary requires aggregate usage.');
  return {
    completedItems: parseItemCounts(summary.completedItems, 'completed'),
    contextBriefCallStarts: integer(summary.contextBriefCallStarts, 'Context Brief call starts'),
    startedItems: parseItemCounts(summary.startedItems, 'started'),
    totalTaskUsage,
    version: 1,
  };
}

function parseItemCounts(value: unknown, label: string): CodeMemoryLinkCodexTerminalDiagnosticsV1['startedItems'] {
  const counts = record(value, `${label} item counts`);
  const fields = [
    'agentMessage',
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'other',
    'plan',
    'reasoning',
    'userMessage',
  ];
  if (JSON.stringify(EffectRecord.keys(counts).sort()) !== JSON.stringify(fields)) {
    throw new Error(`${label} item counts have unsupported fields.`);
  }
  return {
    agentMessage: integer(counts.agentMessage, `${label} agent messages`),
    commandExecution: integer(counts.commandExecution, `${label} command executions`),
    fileChange: integer(counts.fileChange, `${label} file changes`),
    mcpToolCall: integer(counts.mcpToolCall, `${label} MCP tool calls`),
    other: integer(counts.other, `${label} other items`),
    plan: integer(counts.plan, `${label} plans`),
    reasoning: integer(counts.reasoning, `${label} reasoning items`),
    userMessage: integer(counts.userMessage, `${label} user messages`),
  };
}

function parseEnvironment(environment: NodeJS.ProcessEnv): CalibrationEnvironment {
  const value = (name: string): string => {
    const observed = environment[name];
    if (!observed || Effect.pipe(observed, EffectString.trim) !== observed)
      throw new Error(`Missing calibration environment ${name}.`);
    return observed;
  };
  const arm = value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_ARM');
  if (arm !== 'anchored' && arm !== 'task-only' && arm !== 'no-memory') throw new Error('Calibration arm is invalid.');
  return {
    arm,
    clientId: matching(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_CLIENT_ID'), CLIENT_ID, 'calibration client'),
    planHash: matching(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_PLAN_HASH'), HASH, 'calibration plan hash'),
    planPath: absolute(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_PLAN'), 'calibration plan'),
    root: absolute(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_ROOT'), 'calibration root'),
    runOrder: integer(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_RUN_ORDER'), 'calibration run order'),
    taskId: matching(value('THREADNOTE_CODE_MEMORY_LINK_CALIBRATION_TASK_ID'), TASK_ID, 'calibration task'),
  };
}

function parseArguments(arguments_: readonly string[]): Options {
  const values = new Map<string, string>();
  const supported = new Set([
    '--candidate-commit',
    '--candidate-executable',
    '--candidate-executable-sha256',
    '--diagnostics',
    '--prepared-root',
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (!supported.has(option) || values.has(option)) throw new Error(`Unsupported calibration option ${option}.`);
    const value = arguments_[++index];
    if (!value) throw new Error(`${option} requires a value.`);
    values.set(option, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} requires a value.`);
    return value;
  };
  return {
    candidateCommit: matching(required('--candidate-commit'), COMMIT, 'candidate commit'),
    candidateExecutable: absolute(required('--candidate-executable'), 'candidate executable'),
    candidateExecutableSha256: matching(required('--candidate-executable-sha256'), HASH, 'candidate executable hash'),
    diagnosticsPath: absolute(required('--diagnostics'), 'diagnostics path'),
    preparedRoot: absolute(required('--prepared-root'), 'prepared root'),
  };
}

function blindArm(arm: CalibrationEnvironment['arm']): {readonly label: 'X' | 'Y' | 'Z'; readonly position: 1 | 2 | 3} {
  if (arm === 'anchored') return {label: 'X', position: 1};
  if (arm === 'task-only') return {label: 'Y', position: 2};
  return {label: 'Z', position: 3};
}

function opaqueId(prefix: 'inv' | 'run', input: string): string {
  return `${prefix}_${Effect.pipe(sha256HexSync(input), EffectString.slice(0, 32))}`;
}

function diagnosticHash(value: unknown): string {
  return sha256HexSync(`threadnote-code-memory-link-calibration-diagnostic-v1\0${JSON.stringify(value)}`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  if (canonical !== path || !(await stat(canonical)).isDirectory()) throw new Error(`${label} must be canonical.`);
  return canonical;
}

function joinRoot(root: string, relative: string): string {
  const path = resolve(root, relative);
  if (path !== root && !Effect.pipe(path, EffectString.startsWith(`${root}/`)))
    throw new Error('Calibration path escapes its root.');
  return path;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) throw new Error(`${label} is invalid.`);
  return Number(parsed);
}

function absolute(value: string, label: string): string {
  if (
    !Effect.pipe(value, EffectString.startsWith('/')) ||
    resolve(value) !== value ||
    Effect.pipe(value, EffectString.includes('\0'))
  ) {
    throw new Error(`${label} must be normalized and absolute.`);
  }
  return value;
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env bun
import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';

/* oxlint-disable threadnote/no-node-runtime, effecttsgo/node-builtin-import -- This reviewed outer adapter is the trusted operating-system isolation boundary. */

import {createHash} from 'node:crypto';
import {lstat, mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {
  codeMemoryLinkArmPacketHashV1,
  deriveCodeMemoryLinkCodexAppServerProjectionV1,
  normalizeCodeMemoryLinkCodexAppServerEvidenceV1,
  type CodeMemoryLinkArmPacketV1,
  type CodeMemoryLinkExpectedCodexClientV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {
  CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION,
  assertCodeMemoryLinkCodexArtifacts,
  createCodeMemoryLinkCodexIsolation,
  parseCodeMemoryLinkCodexClientConfigV1,
  type CodeMemoryLinkCodexClientConfigV1,
} from './code-memory-link-codex-isolation.js';
import {CODE_MEMORY_LINK_PROXY_SERVER_NAME} from './code-memory-link-codex-isolation.js';
import {
  collectCodeMemoryLinkPublicArtifacts,
  materializeCodeMemoryLinkArtifacts,
  runCodeMemoryLinkStaticJudge,
} from './code-memory-link-codex-judge.js';
import {
  codeMemoryLinkCodexInvocationNonceDigestV1,
  codeMemoryLinkCodexPreflightReceiptHashV1,
  codeMemoryLinkCodexRunBindingHashV1,
  createCodeMemoryLinkCodexRawEvidenceV1,
  type CodeMemoryLinkCodexRawEvidenceV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-codex-evidence';
import {
  CODE_MEMORY_LINK_EVALUATION_ACCOUNT,
  CODE_MEMORY_LINK_EVALUATION_AGENT_ID,
  CODE_MEMORY_LINK_EVALUATION_USER,
  initializeCodeMemoryLinkFixtureRepository,
  preflightCodeMemoryLinkCandidate,
} from './code-memory-link-codex-preflight.js';
import {
  loadCodeMemoryLinkCodexSuiteTask,
  type LoadedCodeMemoryLinkCodexSuiteTaskV1,
} from './code-memory-link-codex-suite.js';
import {runCodeMemoryLinkAppServerTurn} from './code-memory-link-app-server-client.js';
import {formatCodeMemoryLinkCodexTerminalReceipt} from './code-memory-link-codex-terminal.js';
import {
  assertCodeMemoryLinkRepositorySnapshot,
  createCodeMemoryLinkRepositorySnapshot,
  removeCodeMemoryLinkRepositorySnapshot,
  type CodeMemoryLinkRepositorySnapshotV1,
} from './code-memory-link-repository-snapshot.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_CODEX_CLIENT_OUTPUT_VERSION = 1 as const;

export const CODE_MEMORY_LINK_CODEX_CLIENT_ENV = {
  approvalCommit: 'THREADNOTE_CODE_MEMORY_LINK_APPROVAL_COMMIT',
  arm: 'THREADNOTE_CODE_MEMORY_LINK_ARM',
  armPosition: 'THREADNOTE_CODE_MEMORY_LINK_ARM_POSITION',
  assignmentHash: 'THREADNOTE_CODE_MEMORY_LINK_ASSIGNMENT_HASH',
  blindLabel: 'THREADNOTE_CODE_MEMORY_LINK_BLIND_LABEL',
  budgetSteps: 'THREADNOTE_CODE_MEMORY_LINK_BUDGET_STEPS',
  budgetTokens: 'THREADNOTE_CODE_MEMORY_LINK_BUDGET_TOKENS',
  candidateCommit: 'THREADNOTE_CODE_MEMORY_LINK_CANDIDATE_COMMIT',
  candidateExecutable: 'THREADNOTE_CODE_MEMORY_LINK_EXECUTABLE',
  candidateExecutableSha256: 'THREADNOTE_CODE_MEMORY_LINK_EXECUTABLE_SHA256',
  clientConfig: 'THREADNOTE_CODE_MEMORY_LINK_CLIENT_CONFIG',
  clientConfigurationProjectionHash: 'THREADNOTE_CODE_MEMORY_LINK_CLIENT_CONFIGURATION_PROJECTION_HASH',
  clientDescriptorHash: 'THREADNOTE_CODE_MEMORY_LINK_CLIENT_DESCRIPTOR_HASH',
  clientEnvironmentPolicyHash: 'THREADNOTE_CODE_MEMORY_LINK_CLIENT_ENVIRONMENT_POLICY_HASH',
  clientExecutionBundleHash: 'THREADNOTE_CODE_MEMORY_LINK_CLIENT_EXECUTION_BUNDLE_HASH',
  clientExpectedProjectionHash: 'THREADNOTE_CODE_MEMORY_LINK_CLIENT_EXPECTED_PROJECTION_HASH',
  clientId: 'THREADNOTE_CODE_MEMORY_LINK_CLIENT_ID',
  fixtureHash: 'THREADNOTE_CODE_MEMORY_LINK_FIXTURE_HASH',
  invocationNonce: 'THREADNOTE_CODE_MEMORY_LINK_INVOCATION_NONCE',
  manifestHash: 'THREADNOTE_CODE_MEMORY_LINK_MANIFEST_HASH',
  packetHash: 'THREADNOTE_CODE_MEMORY_LINK_PACKET_HASH',
  rubricHash: 'THREADNOTE_CODE_MEMORY_LINK_RUBRIC_HASH',
  runNonce: 'THREADNOTE_CODE_MEMORY_LINK_RUN_NONCE',
  runBindingHash: 'THREADNOTE_CODE_MEMORY_LINK_RUN_BINDING_HASH',
  runOrder: 'THREADNOTE_CODE_MEMORY_LINK_RUN_ORDER',
  suiteHash: 'THREADNOTE_CODE_MEMORY_LINK_SUITE_HASH',
  taskId: 'THREADNOTE_CODE_MEMORY_LINK_TASK_ID',
  taskKind: 'THREADNOTE_CODE_MEMORY_LINK_TASK_KIND',
} as const;

interface CodeMemoryLinkCodexHarnessInputV1 {
  readonly approvalCommit: string;
  readonly arm: 'anchored' | 'no-memory' | 'task-only';
  readonly armPosition: 1 | 2 | 3;
  readonly assignmentHash: string;
  readonly blindLabel: 'X' | 'Y' | 'Z';
  readonly budget: {readonly steps: number; readonly tokens: number};
  readonly candidateCommit: string;
  readonly candidateExecutable: string;
  readonly candidateExecutableSha256: string;
  readonly clientConfig: string;
  readonly clientConfigurationProjectionHash: string;
  readonly clientDescriptorHash: string;
  readonly clientEnvironmentPolicyHash: string;
  readonly clientExecutionBundleHash: string;
  readonly clientExpectedProjectionHash: string;
  readonly clientId: string;
  readonly fixtureHash: string;
  readonly invocationNonce: string;
  readonly manifestHash: string;
  readonly packetHash: string;
  readonly rubricHash: string;
  readonly runNonce: string;
  readonly runBindingHash: string;
  readonly runOrder: number;
  readonly suiteHash: string;
  readonly taskId: string;
  readonly taskKind: 'hidden-constraint' | 'negative-control';
}

export interface CodeMemoryLinkCodexExecutionTaskV1 {
  readonly fixture: LoadedCodeMemoryLinkCodexSuiteTaskV1['fixture'];
  readonly fixtureHash: string;
  readonly judge: LoadedCodeMemoryLinkCodexSuiteTaskV1['judge'];
  readonly mappedTask: LoadedCodeMemoryLinkCodexSuiteTaskV1['layout']['tasks'][number];
  readonly rubric: LoadedCodeMemoryLinkCodexSuiteTaskV1['rubric'];
  readonly taskPacket: LoadedCodeMemoryLinkCodexSuiteTaskV1['taskPacket'];
}

export async function runCodeMemoryLinkCodexClient(environment: Readonly<Record<string, string | undefined>>): Promise<{
  readonly rawEvidence: CodeMemoryLinkCodexRawEvidenceV1;
  readonly trial: Readonly<Record<string, unknown>>;
  readonly version: 1;
}> {
  const harness = parseCodeMemoryLinkCodexHarnessEnvironment(environment);
  const config = await loadClientConfig(harness.clientConfig);
  const loaded = await loadCodeMemoryLinkCodexSuiteTask({
    expectedLayoutArtifactId: config.sealedSuite.layoutArtifactId,
    expectedSuiteHash: harness.suiteHash,
    root: config.sealedSuite.root,
    taskId: harness.taskId,
  });
  const mappedTask = EffectOption.getOrUndefined(
    EffectArray.findFirst(loaded.layout.tasks, task => task.taskId === harness.taskId),
  )!;
  return await runCodeMemoryLinkCodexExecutionTask(environment, config, {
    fixture: loaded.fixture,
    fixtureHash: loaded.suite.fixture.fixtureHash,
    judge: loaded.judge,
    mappedTask,
    rubric: loaded.rubric,
    taskPacket: loaded.taskPacket,
  });
}

export async function runCodeMemoryLinkCodexExecutionTask(
  environment: Readonly<Record<string, string | undefined>>,
  config: CodeMemoryLinkCodexClientConfigV1,
  loaded: CodeMemoryLinkCodexExecutionTaskV1,
): Promise<{
  readonly rawEvidence: CodeMemoryLinkCodexRawEvidenceV1;
  readonly trial: Readonly<Record<string, unknown>>;
  readonly version: 1;
}> {
  const harness = parseCodeMemoryLinkCodexHarnessEnvironment(environment);
  assertHarnessSuiteBindings(harness, loaded.taskPacket, loaded.rubric, loaded.fixtureHash);
  if (loaded.mappedTask.taskId !== harness.taskId) {
    throw new Error('Execution task mapping differs from the trusted harness task.');
  }
  const mappedTask = loaded.mappedTask;
  const armWithoutHash = {
    assignmentHash: harness.assignmentHash,
    blindLabel: harness.blindLabel,
    fixtureHash: harness.fixtureHash,
    packetHash: harness.packetHash,
    policy: harness.arm,
    rubricHash: harness.rubricHash,
    runNonce: harness.runNonce,
    taskId: harness.taskId,
    taskKind: harness.taskKind,
    version: 1 as const,
  };
  const armPacket: CodeMemoryLinkArmPacketV1 = {
    ...armWithoutHash,
    armPacketHash: codeMemoryLinkArmPacketHashV1(armWithoutHash),
  };
  const invocationNonceDigest = codeMemoryLinkCodexInvocationNonceDigestV1(harness.invocationNonce);
  const runBindingHash = codeMemoryLinkCodexRunBindingHashV1({
    armPacketHash: armPacket.armPacketHash,
    candidateExecutableSha256: harness.candidateExecutableSha256,
    clientExecutionHash: harness.clientDescriptorHash,
    invocationNonceDigest,
    manifestHash: harness.manifestHash,
    runNonce: harness.runNonce,
    suiteHash: harness.suiteHash,
    taskId: harness.taskId,
  });
  if (runBindingHash !== harness.runBindingHash) {
    throw new Error('Trusted harness run binding differs from independently reconstructed execution identity.');
  }
  const stagingRoot = await mkdtemp(join(config.temporaryRoot, 'threadnote-code-memory-link-outer-'));
  const fixtureRepository = join(stagingRoot, 'fixture-repository');
  const fixtureThreadnoteHome = join(stagingRoot, 'fixture-threadnote-home');
  let isolation: Awaited<ReturnType<typeof createCodeMemoryLinkCodexIsolation>> | undefined;
  let repositorySnapshot: CodeMemoryLinkRepositorySnapshotV1 | undefined;
  let executionFailed = false;
  let executionFailure: unknown;
  let output:
    | {
        readonly rawEvidence: CodeMemoryLinkCodexRawEvidenceV1;
        readonly trial: Readonly<Record<string, unknown>>;
        readonly version: 1;
      }
    | undefined;
  try {
    await Promise.all([
      materializeCodeMemoryLinkArtifacts(fixtureRepository, loaded.fixture.repository),
      materializeCodeMemoryLinkArtifacts(fixtureThreadnoteHome, loaded.fixture.threadnoteHome),
    ]);
    isolation = await createCodeMemoryLinkCodexIsolation({
      config,
      fixtureRepository,
      fixtureThreadnoteHome,
      proxyPacket: paths => ({
        account: CODE_MEMORY_LINK_EVALUATION_ACCOUNT,
        agentId: CODE_MEMORY_LINK_EVALUATION_AGENT_ID,
        armPacket,
        candidateExecutable: harness.candidateExecutable,
        candidateExecutableSha256: harness.candidateExecutableSha256,
        callerCwd: paths.repositoryRoot,
        project: mappedTask.project,
        runBindingHash,
        safeExecutablePath: config.safeExecutablePath,
        taskPacket: loaded.taskPacket,
        threadnoteHome: paths.threadnoteHome,
        user: CODE_MEMORY_LINK_EVALUATION_USER,
        version: 1,
      }),
    });
    const git = await initializeCodeMemoryLinkFixtureRepository({
      config,
      repositoryRoot: isolation.repositoryRoot,
      taskId: harness.taskId,
      temporaryHome: join(isolation.root, 'git-home'),
    });
    const preflight = await preflightCodeMemoryLinkCandidate({
      budgetTokens: loaded.taskPacket.budget.tokens,
      candidateExecutable: harness.candidateExecutable,
      candidateExecutableSha256: harness.candidateExecutableSha256,
      codeRefs: mappedTask.preflightCodeRefs,
      expectedGoldCitationDigests: loaded.rubric.goldCitationDigests,
      expectedPreflightCitationDigests: mappedTask.preflightExpectedCitationDigests,
      expectedResponses: mappedTask.preflightExpectedResponses,
      expectedSelectedMemories: mappedTask.preflightExpectedSelectedMemories,
      expectedCommit: git.commit,
      expectedOrigin: git.origin,
      project: mappedTask.project,
      repositoryRoot: isolation.repositoryRoot,
      safeExecutablePath: config.safeExecutablePath,
      task: loaded.taskPacket.prompt,
      threadnoteHome: isolation.threadnoteHome,
    });
    const appServerVersion = Effect.pipe(
      CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION,
      EffectString.replace('codex-cli ', ''),
    );
    if (appServerVersion !== '0.149.0-alpha.4.1') {
      throw new Error('Trusted Code Memory Link app-server version changed.');
    }
    const expectedClient: CodeMemoryLinkExpectedCodexClientV1 = {
      appServerVersion,
      model: config.model.id,
      modelProvider: config.model.provider,
      reasoningEffort: config.model.reasoningEffort,
    };
    const trace = await runCodeMemoryLinkAppServerTurn({
      appServer: isolation.appServer,
      cwd: isolation.repositoryRoot,
      environment: isolation.environment,
      expected: {
        model: config.model.id,
        modelProvider: config.model.provider,
        reasoningEffort: config.model.reasoningEffort,
      },
      outputSchema: CODE_MEMORY_LINK_AGENT_OUTPUT_SCHEMA,
      prompt: loaded.taskPacket.prompt,
      proxyServerName: CODE_MEMORY_LINK_PROXY_SERVER_NAME,
      taskBudget: loaded.taskPacket.budget,
      timeoutMilliseconds: config.limits.turnTimeoutMilliseconds,
    });
    repositorySnapshot = await createCodeMemoryLinkRepositorySnapshot({
      destinationRoot: join(stagingRoot, 'repository-snapshot'),
      sourceRoot: isolation.repositoryRoot,
    });
    const qualifyingActionItemId = selectCodeMemoryLinkQualifyingActionItemId(
      trace.events,
      loaded.rubric.qualifyingActionItemTypes,
    );
    const judge = await runCodeMemoryLinkStaticJudge({
      command: loaded.judge.command,
      commandArtifact: loaded.judge.commandArtifact,
      config,
      judgeFiles: loaded.judge.files,
      judgeRoot: join(stagingRoot, 'judge'),
      programArtifact: loaded.judge.programArtifact,
      qualifyingActionItemId,
      repositorySnapshot,
      rubric: loaded.rubric,
      runBindingHash,
      taskId: harness.taskId,
    });
    const appServerEvidence = normalizeCodeMemoryLinkCodexAppServerEvidenceV1({
      approvalReceipts: trace.approvals,
      events: trace.events,
      expectedClient,
      proxyTool: {server: CODE_MEMORY_LINK_PROXY_SERVER_NAME, tool: 'context_brief'},
      qualifyingActionItemId,
      rubric: loaded.rubric,
      runBindingHash,
      staticArtifacts: judge.staticArtifacts,
      threadStartResponse: trace.threadStartResponse,
    });
    const projection = deriveCodeMemoryLinkCodexAppServerProjectionV1({
      evidence: appServerEvidence,
      rubric: loaded.rubric,
    });
    if (
      projection.totalTaskUsage.steps > loaded.taskPacket.budget.steps ||
      projection.totalTaskUsage.tokens > loaded.taskPacket.budget.tokens
    ) {
      throw new Error('Provider-reported usage exceeded the sealed task budget.');
    }
    if (
      projection.adjudicationHash !== judge.judgment.adjudicationHash ||
      projection.taskPassed !== (judge.judgment.taskPassed && projection.contextBriefProtocolAdhered)
    ) {
      throw new Error('Retained app-server evidence differs from the independent static judgment.');
    }
    const finalPublicArtifacts = await collectCodeMemoryLinkPublicArtifacts(repositorySnapshot);
    await assertCodeMemoryLinkRepositorySnapshot(repositorySnapshot);
    await assertCodeMemoryLinkCodexArtifacts(config);
    const graphPreflightWithoutHash = {
      commit: git.commit,
      graphContentDigest: domainDigest('graph-content', preflight.graphContentId),
      graphSnapshotDigest: preflight.graphSnapshotDigest,
      observedCitationDigests: preflight.observedCitationDigests,
      observedResponses: preflight.responses,
      observedSelectedMemories: preflight.observedSelectedMemories,
      originDigest: domainDigest('fixture-origin', git.origin),
      runBindingHash,
    } satisfies Omit<CodeMemoryLinkCodexRawEvidenceV1['graphPreflight'], 'preflightReceiptHash'>;
    const graphPreflight = {
      ...graphPreflightWithoutHash,
      preflightReceiptHash: codeMemoryLinkCodexPreflightReceiptHashV1(graphPreflightWithoutHash),
    };
    const rawWithoutHash = {
      appServer: appServerEvidence,
      bindings: {
        approvalCommit: harness.approvalCommit,
        arm: harness.arm,
        armPacketHash: armPacket.armPacketHash,
        armPosition: harness.armPosition,
        assignmentHash: harness.assignmentHash,
        blindLabel: harness.blindLabel,
        budget: harness.budget,
        candidateCommit: harness.candidateCommit,
        candidateExecutableSha256: harness.candidateExecutableSha256,
        clientDescriptorHash: harness.clientDescriptorHash,
        clientId: harness.clientId,
        fixtureHash: harness.fixtureHash,
        invocationNonceDigest,
        manifestHash: harness.manifestHash,
        packetHash: harness.packetHash,
        rubricHash: harness.rubricHash,
        runNonce: harness.runNonce,
        runBindingHash,
        runOrder: harness.runOrder,
        suiteHash: harness.suiteHash,
        taskId: harness.taskId,
        taskKind: harness.taskKind,
      },
      clientProtocol: {
        configurationProjectionHash: harness.clientConfigurationProjectionHash,
        environmentPolicyHash: harness.clientEnvironmentPolicyHash,
        executionBundleHash: harness.clientExecutionBundleHash,
        expectedClient,
        expectedClientProjectionHash: harness.clientExpectedProjectionHash,
        proxyTool: {server: CODE_MEMORY_LINK_PROXY_SERVER_NAME, tool: 'context_brief'},
      },
      finalPublicArtifacts,
      graphPreflight,
      judge: {
        adjudicationHash: judge.judgment.adjudicationHash,
        commandArtifactId: judge.commandArtifactId,
        commandSha256: judge.commandSha256,
        programArtifactId: judge.programArtifactId,
        programSha256: judge.programSha256,
        repositorySnapshotHash: judge.repositorySnapshotHash,
        runBindingHash: judge.runBindingHash,
        staticObservationHash: judge.observation.observationHash,
        stderrSha256: judge.stderrSha256,
        stdoutSha256: judge.stdoutSha256,
      },
      rubric: loaded.rubric,
      version: 1,
    } satisfies Omit<CodeMemoryLinkCodexRawEvidenceV1, 'evidenceHash'>;
    const rawEvidence = createCodeMemoryLinkCodexRawEvidenceV1(rawWithoutHash);
    const trial = {
      acceptedStaleOrHarmful: judge.judgment.acceptedStaleOrHarmful,
      adjudicationHash: judge.judgment.adjudicationHash,
      approvalCommit: harness.approvalCommit,
      armPosition: harness.armPosition,
      assignmentHash: harness.assignmentHash,
      blindLabel: harness.blindLabel,
      budget: harness.budget,
      clientId: harness.clientId,
      constraintAdherence: judge.judgment.constraintAdherence,
      evidenceKind: 'external-agent',
      firstUsefulMemoryUse: projection.firstUsefulMemoryUse,
      fixtureHash: harness.fixtureHash,
      manifestHash: harness.manifestHash,
      packetHash: harness.packetHash,
      providerUsageHash: projection.providerUsageHash,
      rubricHash: harness.rubricHash,
      runNonce: harness.runNonce,
      runOrder: harness.runOrder,
      taskId: harness.taskId,
      taskKind: harness.taskKind,
      taskPassed: judge.judgment.taskPassed,
      tokenAccounting: 'provider-reported',
      totalTaskUsage: projection.totalTaskUsage,
      version: 1,
    } as const;
    output = {rawEvidence, trial, version: CODE_MEMORY_LINK_CODEX_CLIENT_OUTPUT_VERSION};
  } catch (error) {
    executionFailed = true;
    executionFailure = error;
  }
  const nestedCleanups = await Promise.allSettled([
    ...(repositorySnapshot ? [removeCodeMemoryLinkRepositorySnapshot(repositorySnapshot)] : []),
    ...(isolation ? [isolation.dispose()] : []),
  ]);
  const cleanups = [
    ...nestedCleanups,
    ...(await Promise.allSettled([rm(stagingRoot, {force: true, maxRetries: 3, recursive: true})])),
  ];
  const cleanupFailures = EffectArray.flatMap(cleanups, result =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (executionFailed) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [executionFailure, ...cleanupFailures],
        'Code Memory Link execution and outer isolation cleanup both failed.',
      );
    }
    throw executionFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Code Memory Link outer isolation cleanup did not complete.');
  }
  if (output === undefined) throw new Error('Code Memory Link execution completed without a sealed output.');
  return output;
}

export function parseCodeMemoryLinkCodexHarnessEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): CodeMemoryLinkCodexHarnessInputV1 {
  const value = (name: keyof typeof CODE_MEMORY_LINK_CODEX_CLIENT_ENV): string => {
    const observed = environment[CODE_MEMORY_LINK_CODEX_CLIENT_ENV[name]];
    if (!observed || Effect.pipe(observed, EffectString.trim) !== observed)
      throw new Error(`Missing trusted harness field ${String(name)}.`);
    return observed;
  };
  return {
    approvalCommit: match(value('approvalCommit'), /^[0-9a-f]{40}$/u, 'approval commit'),
    arm: oneOf(value('arm'), ['anchored', 'task-only', 'no-memory'] as const, 'arm'),
    armPosition: integerChoice(integer(value('armPosition'), 'arm position', 1, 3), [1, 2, 3] as const, 'arm position'),
    assignmentHash: hash(value('assignmentHash'), 'assignment hash'),
    blindLabel: oneOf(value('blindLabel'), ['X', 'Y', 'Z'] as const, 'blind label'),
    budget: {
      steps: integer(value('budgetSteps'), 'step budget', 1, 1_000),
      tokens: integer(value('budgetTokens'), 'token budget', 1, 10_000_000),
    },
    candidateCommit: match(value('candidateCommit'), /^[0-9a-f]{40}$/u, 'candidate commit'),
    candidateExecutable: normalizedAbsolute(value('candidateExecutable'), 'candidate executable'),
    candidateExecutableSha256: hash(value('candidateExecutableSha256'), 'candidate executable hash'),
    clientConfig: normalizedAbsolute(value('clientConfig'), 'client config'),
    clientConfigurationProjectionHash: hash(
      value('clientConfigurationProjectionHash'),
      'client configuration projection hash',
    ),
    clientDescriptorHash: hash(value('clientDescriptorHash'), 'client descriptor hash'),
    clientEnvironmentPolicyHash: hash(value('clientEnvironmentPolicyHash'), 'client environment policy hash'),
    clientExecutionBundleHash: hash(value('clientExecutionBundleHash'), 'client execution bundle hash'),
    clientExpectedProjectionHash: hash(value('clientExpectedProjectionHash'), 'client expected projection hash'),
    clientId: match(value('clientId'), /^cli_[0-9a-f]{16,64}$/u, 'client id'),
    fixtureHash: hash(value('fixtureHash'), 'fixture hash'),
    invocationNonce: match(value('invocationNonce'), /^inv_[0-9a-f]{16,64}$/u, 'invocation nonce'),
    manifestHash: hash(value('manifestHash'), 'manifest hash'),
    packetHash: hash(value('packetHash'), 'packet hash'),
    rubricHash: hash(value('rubricHash'), 'rubric hash'),
    runNonce: match(value('runNonce'), /^run_[0-9a-f]{16,64}$/u, 'run nonce'),
    runBindingHash: hash(value('runBindingHash'), 'run binding hash'),
    runOrder: integer(value('runOrder'), 'run order', 0, 1_000_000),
    suiteHash: hash(value('suiteHash'), 'suite hash'),
    taskId: match(value('taskId'), /^tsk_[0-9a-f]{16,64}$/u, 'task id'),
    taskKind: oneOf(value('taskKind'), ['hidden-constraint', 'negative-control'] as const, 'task kind'),
  };
}

async function loadClientConfig(path: string): Promise<CodeMemoryLinkCodexClientConfigV1> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('Client config must be a non-symlink regular file.');
  const canonical = await realpath(path);
  if (canonical !== path || !(await stat(canonical)).isFile()) throw new Error('Client config path must be canonical.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(canonical, 'utf8')) as unknown;
  } catch (cause) {
    throw new Error('Client config is not valid JSON.', {cause});
  }
  const config = parseCodeMemoryLinkCodexClientConfigV1(parsed);
  await assertCodeMemoryLinkCodexArtifacts(config);
  return config;
}

function assertHarnessSuiteBindings(
  harness: CodeMemoryLinkCodexHarnessInputV1,
  packet: {
    readonly budget: {readonly steps: number; readonly tokens: number};
    readonly fixtureHash: string;
    readonly packetHash: string;
    readonly taskId: string;
    readonly taskKind: string;
  },
  rubric: {
    readonly fixtureHash: string;
    readonly rubricHash: string;
    readonly taskId: string;
    readonly taskKind: string;
  },
  fixtureHash: string,
): void {
  if (
    harness.taskId !== packet.taskId ||
    harness.taskId !== rubric.taskId ||
    harness.taskKind !== packet.taskKind ||
    harness.taskKind !== rubric.taskKind ||
    harness.packetHash !== packet.packetHash ||
    harness.rubricHash !== rubric.rubricHash ||
    harness.fixtureHash !== fixtureHash ||
    harness.fixtureHash !== packet.fixtureHash ||
    harness.fixtureHash !== rubric.fixtureHash ||
    harness.budget.steps !== packet.budget.steps ||
    harness.budget.tokens !== packet.budget.tokens
  ) {
    throw new Error('Trusted harness fields do not match the exact sealed suite task.');
  }
}

export function selectCodeMemoryLinkQualifyingActionItemId(
  events: readonly Record<string, unknown>[],
  allowedTypes: readonly string[],
): string | null {
  const started: Array<{readonly id: string; readonly type: string}> = [];
  const completed = new Map<string, boolean>();
  for (const event of events) {
    if (event.method !== 'item/started' && event.method !== 'item/completed') continue;
    const params = object(event.params, `${String(event.method)} item params`);
    const item = object(params.item, `${String(event.method)} item`);
    const id = nonEmptyText(item.id, 'qualifying action item id');
    const type = String(item.type);
    if (!allowedTypes.includes(type)) continue;
    if (event.method === 'item/started') {
      if (EffectArray.some(started, candidate => candidate.id === id))
        throw new Error('Qualifying action item started twice.');
      started.push({id, type});
      continue;
    }
    if (completed.has(id)) throw new Error('Qualifying action item completed twice.');
    completed.set(
      id,
      item.status === 'completed' &&
        (type !== 'commandExecution' || item.exitCode === undefined || item.exitCode === 0),
    );
  }
  return (
    EffectOption.getOrUndefined(EffectArray.findFirst(started, candidate => completed.get(candidate.id) === true))
      ?.id ?? null
  );
}

const CODE_MEMORY_LINK_AGENT_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {status: {const: 'completed', type: 'string'}},
  required: ['status'],
  type: 'object',
} as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error(`${label} is invalid.`);
  return value;
}

function domainDigest(domain: string, value: string): string {
  return createHash('sha256').update(`threadnote-code-memory-link-${domain}-v1\0${value}`).digest('hex');
}

function hash(value: string, label: string): string {
  return match(value, /^[0-9a-f]{64}$/u, label);
}

function integer(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${label} is out of range.`);
  return parsed;
}

function match(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function normalizedAbsolute(value: string, label: string): string {
  if (
    !Effect.pipe(value, EffectString.startsWith('/')) ||
    resolve(value) !== value ||
    Effect.pipe(value, EffectString.includes('\0'))
  )
    throw new Error(`${label} must be normalized and absolute.`);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  const matched = EffectOption.getOrElse(
    EffectArray.findFirst(allowed, candidate => candidate === value),
    () => undefined,
  );
  if (matched === undefined) throw new Error(`${label} is invalid.`);
  return matched;
}

function integerChoice<T extends readonly number[]>(value: number, allowed: T, label: string): T[number] {
  const matched = EffectOption.getOrElse(
    EffectArray.findFirst(allowed, candidate => candidate === value),
    () => undefined,
  );
  if (matched === undefined) throw new Error(`${label} is invalid.`);
  return matched;
}

async function main(): Promise<void> {
  const output = await runCodeMemoryLinkCodexClient(process.env);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`${formatCodeMemoryLinkCodexTerminalReceipt(error)}\n`);
    process.exitCode = 1;
  });
}

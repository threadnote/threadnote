#!/usr/bin/env bun
import {Array as EffectArray, Option as EffectOption} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect, Exit, FileSystem, Path} from 'effect';
import {
  assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1,
  assertCodeMemoryLinkAgentAbRuntimeIdentity,
  CODE_MEMORY_LINK_AGENT_AB_APPROVED_MANIFEST_HASHES,
  codeMemoryLinkAgentAbTrialReceiptDigest,
  createCodeMemoryLinkAgentAbTrialV1,
  evaluateCodeMemoryLinkAgentAb,
  parseCodeMemoryLinkAgentAbAssignmentV1,
  parseCodeMemoryLinkAgentAbManifestV1,
  parseCodeMemoryLinkAgentAbTrialsJsonl,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ab';
import {
  assertCodeMemoryLinkClientImplementationBinding,
  parseCodeMemoryLinkClientImplementationDescriptorV1,
  type CodeMemoryLinkClientImplementationDescriptorV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-client-descriptor';
import {
  assertCodeMemoryLinkAgentAttemptLedgerV1,
  CODE_MEMORY_LINK_AGENT_RETRY_REASONS,
  codeMemoryLinkAgentAttemptEventDigest,
  createCodeMemoryLinkAgentAttemptFailedV1,
  createCodeMemoryLinkAgentAttemptStartedV1,
  parseCodeMemoryLinkAgentAttemptsJsonl,
  resolveCodeMemoryLinkAgentLedgerLayout,
  serializeCodeMemoryLinkAgentAttemptsJsonl,
  withCodeMemoryLinkAgentLedgerLock,
  type CodeMemoryLinkAgentRetryReason,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-attempts';
import {
  assertCodeMemoryLinkAgentEvidenceLedgerV1,
  codeMemoryLinkAgentEvidenceReceiptDigest,
  createCodeMemoryLinkAgentEvidenceReceiptV1,
  parseCodeMemoryLinkAgentClientOutputV1,
  parseCodeMemoryLinkAgentEvidenceJsonl,
  serializeCodeMemoryLinkAgentEvidenceJsonl,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-evidence';
import {
  createCodeMemoryLinkAgentPendingCommitV1,
  parseCodeMemoryLinkAgentPendingCommitJsonV1,
  reconcileCodeMemoryLinkAgentPendingCommitV1,
  serializeCodeMemoryLinkAgentPendingCommitJsonV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-pending';
import {codeMemoryLinkArmPacketHashV1} from '@threadnote/threadnote/evaluation/code-memory-link-agent-protocol';
import {
  codeMemoryLinkCodexInvocationNonceDigestV1,
  codeMemoryLinkCodexRunBindingHashV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-codex-evidence';
import {
  durablyReplaceCodeMemoryLinkAgentLedger,
  persistCodeMemoryLinkAgentAttemptStartDurably,
  projectCodeMemoryLinkAgentPendingCommitDurably,
} from '@threadnote/threadnote/evaluation/code-memory-link-agent-ledger-durability';
import {collectCodeMemoryLinkClientImplementation} from './code-memory-link-client-implementation.js';
import {verifyCodeMemoryLinkEvaluatedSubject} from './code-memory-link-evaluated-subject.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {readJsonFile, scriptArguments} from './effect/script.js';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {verifyApprovalCheckout} from './verify-code-memory-link-release.js';
import {captureCodeMemoryLinkProcessGroup} from './code-memory-link-process-boundary.js';
import {
  createCodeMemoryLinkCodexTerminalReceipt,
  parseCodeMemoryLinkCodexTerminalReceipt,
  type CodeMemoryLinkCodexTerminalKind,
} from './code-memory-link-codex-terminal.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const program = Effect.gen(function* () {
  const options = parseArguments(yield* scriptArguments());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceRoot = yield* path.fromFileUrl(new URL('../', import.meta.url));
  const [assignmentInput, descriptorInput, manifestInput] = yield* Effect.all(
    [
      readJsonFile(options.assignmentPath),
      readJsonFile(options.clientDescriptorPath),
      readJsonFile(options.manifestPath),
    ],
    {concurrency: 3},
  );
  const assignment = parseCodeMemoryLinkAgentAbAssignmentV1(assignmentInput);
  const manifest = parseCodeMemoryLinkAgentAbManifestV1(manifestInput);
  if (manifest.candidate.commit !== options.candidateCommit) {
    return yield* ScriptError.make({message: 'The trial manifest does not name --candidate-commit.'});
  }
  const harnessGovernanceCommit = manifest.harnessGovernanceCommit;
  if (harnessGovernanceCommit === undefined) {
    return yield* ScriptError.make({message: 'The trial manifest does not bind a protocol-v2 harness commit.'});
  }
  const governance = yield* verifyApprovalCheckout(sourceRoot, harnessGovernanceCommit);
  if (governance.commit !== options.approvalCommit) {
    return yield* ScriptError.make({
      message: 'The trial runner requires the exact clean reviewed --approval-commit checkout.',
    });
  }
  if (!CODE_MEMORY_LINK_AGENT_AB_APPROVED_MANIFEST_HASHES.includes(manifest.manifestHash)) {
    return yield* ScriptError.make({message: 'The trial manifest is not approved in the reviewed harness checkout.'});
  }
  const rosteredClient = EffectOption.getOrUndefined(
    EffectArray.findFirst(manifest.clients, client => client.clientId === options.clientId),
  );
  if (!rosteredClient) return yield* ScriptError.make({message: '--client-id is outside the manifest roster.'});
  const descriptor = parseCodeMemoryLinkClientImplementationDescriptorV1(descriptorInput);
  const descriptorHash = assertCodeMemoryLinkClientImplementationBinding({
    clientId: options.clientId,
    descriptor,
    roster: manifest.clients,
  });
  const layout = yield* resolveCodeMemoryLinkAgentLedgerLayout(
    options.trialsPath,
    options.attemptsPath,
    options.evidencePath,
  );
  const trial = yield* withCodeMemoryLinkAgentLedgerLock(
    layout,
    lockWaitMilliseconds(options.timeoutMilliseconds),
    Effect.gen(function* () {
      const collectedBefore = yield* collectCodeMemoryLinkClientImplementation(options);
      assertDescriptorMatches(descriptor, collectedBefore.descriptor);
      const existingSource = (yield* fs.exists(layout.trialsPath)) ? yield* fs.readFileString(layout.trialsPath) : '';
      const attemptSource = (yield* fs.exists(layout.attemptsPath))
        ? yield* fs.readFileString(layout.attemptsPath)
        : '';
      const evidenceSource = (yield* fs.exists(layout.evidencePath))
        ? yield* fs.readFileString(layout.evidencePath)
        : '';
      const pendingSource = (yield* fs.exists(layout.pendingPath)) ? yield* fs.readFileString(layout.pendingPath) : '';
      const existing = parseCodeMemoryLinkAgentAbTrialsJsonl(existingSource);
      const attemptEvents = parseCodeMemoryLinkAgentAttemptsJsonl(attemptSource);
      const evidenceReceipts = parseCodeMemoryLinkAgentEvidenceJsonl(evidenceSource);
      if (Effect2.pipe(pendingSource, EffectString.trim)) {
        const recovered = reconcileCodeMemoryLinkAgentPendingCommitV1({
          evidence: evidenceReceipts,
          pending: parseCodeMemoryLinkAgentPendingCommitJsonV1(pendingSource),
          trials: existing,
        });
        if (recovered.pending.trial.clientId !== options.clientId) {
          return yield* ScriptError.make({
            message: `Pending recovery requires client ${recovered.pending.trial.clientId}.`,
          });
        }
        assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1({assignment, manifest, trials: recovered.trials});
        assertCodeMemoryLinkAgentEvidenceLedgerV1({
          assignment,
          evidence: recovered.evidence,
          manifest,
          trials: recovered.trials,
        });
        assertCodeMemoryLinkAgentAttemptLedgerV1({
          approvalCommit: options.approvalCommit,
          events: attemptEvents,
          manifest,
          trials: recovered.trials,
        });
        yield* projectCodeMemoryLinkAgentPendingCommitDurably(layout, {
          ...(recovered.appendEvidence
            ? {evidenceSource: serializeCodeMemoryLinkAgentEvidenceJsonl(recovered.evidence)}
            : {}),
          ...(recovered.appendTrial
            ? {
                trialsSource: `${EffectArray.join(
                  EffectArray.map(recovered.trials, entry => JSON.stringify(entry)),
                  '\n',
                )}\n`,
              }
            : {}),
        });
        return recovered.pending.trial;
      }
      assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1({assignment, manifest, trials: existing});
      assertCodeMemoryLinkAgentEvidenceLedgerV1({
        assignment,
        evidence: evidenceReceipts,
        manifest,
        trials: existing,
      });
      const attemptState = assertCodeMemoryLinkAgentAttemptLedgerV1({
        approvalCommit: options.approvalCommit,
        events: attemptEvents,
        manifest,
        trials: existing,
      });
      assertRetryAcknowledgement(options, attemptState.requiredRetry);
      if (existing.length >= manifest.schedule.length) {
        return yield* ScriptError.make({message: 'The preregistered trial ledger is already complete.'});
      }
      const scheduled = manifest.schedule[existing.length];
      const task = EffectOption.getOrUndefined(
        EffectArray.findFirst(manifest.tasks, candidate => candidate.taskId === scheduled.taskId),
      )!;
      const arm = assignment.labels[scheduled.blindLabel];
      if (scheduled.clientId !== options.clientId) {
        return yield* ScriptError.make({
          message: `The next frozen schedule entry requires client ${scheduled.clientId}, not ${options.clientId}.`,
        });
      }
      const resolved = yield* Effect.tryPromise({
        try: () =>
          verifyCodeMemoryLinkEvaluatedSubject({
            executable: options.candidateExecutable,
            executableSha256: options.candidateExecutableSha256,
            sourceCommit: options.candidateCommit,
          }),
        catch: cause => ScriptError.make({message: 'The evaluated subject failed pre-run verification.', cause}),
      });
      assertCodeMemoryLinkAgentAbRuntimeIdentity(manifest.candidate, resolved.identity);
      const attemptId = randomOpaqueId('attempt');
      const invocationNonce = randomOpaqueId('inv');
      const armPacketHash = codeMemoryLinkArmPacketHashV1({
        assignmentHash: manifest.assignmentHash,
        blindLabel: scheduled.blindLabel,
        fixtureHash: manifest.fixtureHash,
        packetHash: task.packetHash,
        policy: arm,
        rubricHash: task.rubricHash,
        runNonce: scheduled.runNonce,
        taskId: scheduled.taskId,
        taskKind: task.taskKind,
        version: 1,
      });
      const runBindingHash = codeMemoryLinkCodexRunBindingHashV1({
        armPacketHash,
        candidateExecutableSha256: manifest.candidate.buildIdentityHash,
        clientExecutionHash: descriptorHash,
        invocationNonceDigest: codeMemoryLinkCodexInvocationNonceDigestV1(invocationNonce),
        manifestHash: manifest.manifestHash,
        runNonce: scheduled.runNonce,
        suiteHash: manifest.suiteHash,
        taskId: scheduled.taskId,
      });
      const started = createCodeMemoryLinkAgentAttemptStartedV1({
        approvalCommit: options.approvalCommit,
        assignmentHash: manifest.assignmentHash,
        attemptId,
        blindLabel: scheduled.blindLabel,
        clientDescriptorHash: descriptorHash,
        clientId: options.clientId,
        invocationNonce,
        manifestHash: manifest.manifestHash,
        previousEventDigest:
          attemptEvents.length === 0
            ? null
            : codeMemoryLinkAgentAttemptEventDigest(attemptEvents[attemptEvents.length - 1]),
        retryOfAttemptId: attemptState.requiredRetry?.attemptId ?? null,
        retryReason: attemptState.requiredRetry?.reason ?? null,
        runBindingHash,
        runNonce: scheduled.runNonce,
        runOrder: scheduled.runOrder,
        taskId: scheduled.taskId,
      });
      const startedEvents = [...attemptEvents, started];
      yield* persistCodeMemoryLinkAgentAttemptStartDurably(
        layout.attemptsPath,
        serializeCodeMemoryLinkAgentAttemptsJsonl(startedEvents),
      );

      let failureKind: Exclude<CodeMemoryLinkAgentRetryReason, 'interrupted-attempt'> = 'client-execution';
      let failureDiagnosticHash: string | undefined;
      let pendingCommitPublicationStarted = false;
      const attempt = yield* Effect.gen(function* () {
        const command = yield* Effect.tryPromise({
          try: () =>
            captureCodeMemoryLinkProcessGroup({
              arguments: options.clientArguments,
              command: collectedBefore.command,
              cwd: process.cwd(),
              environment: {
                HOME: '/nonexistent',
                LANG: 'C.UTF-8',
                LC_ALL: 'C.UTF-8',
                NO_COLOR: '1',
                PATH: path.dirname(collectedBefore.command),
                TMPDIR: path.dirname(layout.trialsPath),
                THREADNOTE_CODE_MEMORY_LINK_APPROVAL_COMMIT: options.approvalCommit,
                THREADNOTE_CODE_MEMORY_LINK_ARM: arm,
                THREADNOTE_CODE_MEMORY_LINK_ARM_POSITION: String(scheduled.armPosition),
                THREADNOTE_CODE_MEMORY_LINK_ASSIGNMENT_HASH: manifest.assignmentHash,
                THREADNOTE_CODE_MEMORY_LINK_ATTEMPT_ID: attemptId,
                THREADNOTE_CODE_MEMORY_LINK_BLIND_LABEL: scheduled.blindLabel,
                THREADNOTE_CODE_MEMORY_LINK_BUDGET_STEPS: String(task.budget.steps),
                THREADNOTE_CODE_MEMORY_LINK_BUDGET_TOKENS: String(task.budget.tokens),
                THREADNOTE_CODE_MEMORY_LINK_CANDIDATE_COMMIT: manifest.candidate.commit,
                THREADNOTE_CODE_MEMORY_LINK_CLIENT_CONFIGURATION_PROJECTION_HASH:
                  descriptor.configurationProjectionHash,
                THREADNOTE_CODE_MEMORY_LINK_CLIENT_DESCRIPTOR_HASH: descriptorHash,
                THREADNOTE_CODE_MEMORY_LINK_CLIENT_ENVIRONMENT_POLICY_HASH: descriptor.environmentPolicyHash,
                THREADNOTE_CODE_MEMORY_LINK_CLIENT_EXECUTION_BUNDLE_HASH: descriptor.executionBundleHash,
                THREADNOTE_CODE_MEMORY_LINK_CLIENT_EXPECTED_PROJECTION_HASH: descriptor.expectedClientProjectionHash,
                THREADNOTE_CODE_MEMORY_LINK_CLIENT_ID: options.clientId,
                THREADNOTE_CODE_MEMORY_LINK_EXECUTABLE: resolved.executable,
                THREADNOTE_CODE_MEMORY_LINK_EXECUTABLE_SHA256: manifest.candidate.buildIdentityHash,
                THREADNOTE_CODE_MEMORY_LINK_FIXTURE_HASH: manifest.fixtureHash,
                THREADNOTE_CODE_MEMORY_LINK_INVOCATION_NONCE: invocationNonce,
                THREADNOTE_CODE_MEMORY_LINK_MANIFEST_HASH: manifest.manifestHash,
                THREADNOTE_CODE_MEMORY_LINK_PACKET_HASH: task.packetHash,
                THREADNOTE_CODE_MEMORY_LINK_RUBRIC_HASH: task.rubricHash,
                THREADNOTE_CODE_MEMORY_LINK_RUN_NONCE: scheduled.runNonce,
                THREADNOTE_CODE_MEMORY_LINK_RUN_BINDING_HASH: runBindingHash,
                THREADNOTE_CODE_MEMORY_LINK_RUN_ORDER: String(scheduled.runOrder),
                THREADNOTE_CODE_MEMORY_LINK_SUITE_HASH: manifest.suiteHash,
                THREADNOTE_CODE_MEMORY_LINK_TASK_ID: scheduled.taskId,
                THREADNOTE_CODE_MEMORY_LINK_TASK_KIND: task.taskKind,
                THREADNOTE_CODE_MEMORY_LINK_CLIENT_CONFIG: collectedBefore.configuration,
              },
              label: 'Reviewed Code Memory Link client',
              allowFailure: true,
              maxOutputBytes: 8 * 1024 * 1024,
              timeoutMilliseconds: options.timeoutMilliseconds,
            }),
          catch: cause => ScriptError.make({message: 'The reviewed external client process boundary failed.', cause}),
        });
        if (command.exitCode !== 0) {
          const terminal = parseCodeMemoryLinkCodexTerminalReceipt(command.stderr);
          const receipt = terminal ?? createCodeMemoryLinkCodexTerminalReceipt('process-exit');
          failureKind = retryReasonForTerminalKind(receipt.kind);
          failureDiagnosticHash = receipt.diagnosticHash;
          return yield* ScriptError.make({message: `The reviewed external client terminated with ${receipt.kind}.`});
        }
        failureKind = 'client-output';
        const clientOutput = yield* Effect.try({
          try: () => parseCodeMemoryLinkAgentClientOutputV1(JSON.parse(command.stdout) as unknown),
          catch: cause =>
            ScriptError.make({
              message: 'The external client must emit one strict trial and retained-evidence envelope.',
              cause,
            }),
        });
        failureKind = 'post-run-verification';
        const [after, collectedAfter, governanceAfter] = yield* Effect.all(
          [
            Effect.tryPromise({
              try: () =>
                verifyCodeMemoryLinkEvaluatedSubject({
                  executable: options.candidateExecutable,
                  executableSha256: options.candidateExecutableSha256,
                  sourceCommit: options.candidateCommit,
                }),
              catch: cause => ScriptError.make({message: 'The evaluated subject failed post-run verification.', cause}),
            }),
            collectCodeMemoryLinkClientImplementation(options),
            verifyApprovalCheckout(sourceRoot, harnessGovernanceCommit),
          ],
          {concurrency: 3},
        );
        assertDescriptorMatches(descriptor, collectedAfter.descriptor);
        if (
          governanceAfter.commit !== options.approvalCommit ||
          JSON.stringify(collectedAfter) !== JSON.stringify(collectedBefore)
        ) {
          return yield* ScriptError.make({
            message: 'The reviewed harness or client implementation changed during trial.',
          });
        }
        failureKind = 'receipt-validation';
        const previousReceiptDigest =
          existing.length === 0 ? null : codeMemoryLinkAgentAbTrialReceiptDigest(existing[existing.length - 1]);
        const trialId = randomOpaqueId('trl');
        const nextTrial = createCodeMemoryLinkAgentAbTrialV1({
          candidate: manifest.candidate,
          invocationNonce,
          postRuntime: after.identity,
          preRuntime: resolved.identity,
          previousReceiptDigest,
          trial: clientOutput.trial,
          trialId,
        });
        const trials = [...existing, nextTrial];
        const previousEvidenceDigest =
          evidenceReceipts.length === 0
            ? null
            : codeMemoryLinkAgentEvidenceReceiptDigest(evidenceReceipts[evidenceReceipts.length - 1]);
        const nextEvidence = createCodeMemoryLinkAgentEvidenceReceiptV1({
          previousEvidenceDigest,
          rawEvidence: clientOutput.rawEvidence,
          trialId,
        });
        const evidence = [...evidenceReceipts, nextEvidence];
        assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1({assignment, manifest, trials});
        assertCodeMemoryLinkAgentEvidenceLedgerV1({assignment, evidence, manifest, trials});
        evaluateCodeMemoryLinkAgentAb({assignment, attempts: startedEvents, evidence, manifest, trials});
        assertCodeMemoryLinkAgentAttemptLedgerV1({
          approvalCommit: options.approvalCommit,
          events: startedEvents,
          manifest,
          trials,
        });
        failureKind = 'receipt-persistence';
        const pendingCommit = createCodeMemoryLinkAgentPendingCommitV1({
          evidence: nextEvidence,
          index: existing.length,
          trial: nextTrial,
        });
        pendingCommitPublicationStarted = true;
        yield* projectCodeMemoryLinkAgentPendingCommitDurably(layout, {
          evidenceSource: serializeCodeMemoryLinkAgentEvidenceJsonl(evidence),
          pendingSource: serializeCodeMemoryLinkAgentPendingCommitJsonV1(pendingCommit),
          trialsSource: `${EffectArray.join(
            EffectArray.map(trials, entry => JSON.stringify(entry)),
            '\n',
          )}\n`,
        });
        return nextTrial;
      }).pipe(Effect.exit);

      if (Exit.isFailure(attempt)) {
        if (pendingCommitPublicationStarted) return yield* Effect.failCause(attempt.cause);
        const failed = createCodeMemoryLinkAgentAttemptFailedV1({
          attemptId,
          ...(failureDiagnosticHash === undefined ? {} : {diagnosticHash: failureDiagnosticHash}),
          failureKind,
          previousEventDigest: codeMemoryLinkAgentAttemptEventDigest(started),
        });
        yield* durablyReplaceCodeMemoryLinkAgentLedger(
          layout.attemptsPath,
          serializeCodeMemoryLinkAgentAttemptsJsonl([...startedEvents, failed]),
        );
        return yield* Effect.failCause(attempt.cause);
      }
      return attempt.value;
    }),
  );
  yield* Console.log(
    JSON.stringify({
      clientId: trial.clientId,
      receiptDigest: codeMemoryLinkAgentAbTrialReceiptDigest(trial),
      runOrder: trial.runOrder,
    }),
  );
});

function retryReasonForTerminalKind(
  kind: CodeMemoryLinkCodexTerminalKind,
): Exclude<CodeMemoryLinkAgentRetryReason, 'interrupted-attempt'> {
  switch (kind) {
    case 'no-action-budget':
      return 'client-no-action-budget';
    case 'preflight-isolation':
      return 'client-preflight-isolation';
    case 'process-exit':
      return 'client-process-exit';
    case 'provider-step-budget':
      return 'client-provider-step-budget';
    case 'provider-terminal':
      return 'client-provider-terminal';
    case 'provider-token-budget':
      return 'client-provider-token-budget';
    case 'turn-timeout':
      return 'client-turn-timeout';
    case 'unknown':
      return 'client-unknown-terminal';
  }
}

interface Options {
  readonly approvalCommit: string;
  readonly assignmentPath: string;
  readonly attemptsPath: string;
  readonly candidateCommit: string;
  readonly candidateExecutable: string;
  readonly candidateExecutableSha256: string;
  readonly clientArtifactBindings: readonly {readonly path: string; readonly role: string}[];
  readonly clientArguments: readonly string[];
  readonly clientBinaryBindings: readonly {readonly path: string; readonly role: string}[];
  readonly clientCommand: string;
  readonly clientConfigurationPath: string;
  readonly clientConfigurationProjectionPath: string;
  readonly clientDependenciesLockPath: string;
  readonly clientDescriptorPath: string;
  readonly clientId: string;
  readonly evidencePath: string;
  readonly manifestPath: string;
  readonly retryAttemptId?: string;
  readonly retryReason?: CodeMemoryLinkAgentRetryReason;
  readonly timeoutMilliseconds: number;
  readonly trialsPath: string;
}

function parseArguments(args: readonly string[]): Options {
  const values: Record<string, string | undefined> = {};
  const clientArtifactBindings: Array<{path: string; role: string}> = [];
  const clientBinaryBindings: Array<{path: string; role: string}> = [];
  const clientArguments: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--client-arg') clientArguments.push(required(args[++index], argument));
    else if (argument === '--client-artifact-binding') {
      clientArtifactBindings.push(parseFileBinding(required(args[++index], argument), argument));
    } else if (argument === '--client-binary-binding') {
      clientBinaryBindings.push(parseFileBinding(required(args[++index], argument), argument));
    } else if (
      [
        '--approval-commit',
        '--assignment',
        '--attempts',
        '--candidate-commit',
        '--candidate-executable',
        '--candidate-executable-sha256',
        '--client-command',
        '--client-config',
        '--client-config-projection',
        '--client-dependencies-lock',
        '--client-descriptor',
        '--client-id',
        '--evidence',
        '--manifest',
        '--retry-of',
        '--retry-reason',
        '--timeout-ms',
        '--trials',
      ].includes(argument)
    ) {
      values[argument] = required(args[++index], argument);
    } else throw ScriptError.make({message: `Unknown Code Memory Link trial harness option: ${argument}`});
  }
  const assignmentPath = required(values['--assignment'], '--assignment');
  const approvalCommit = required(values['--approval-commit'], '--approval-commit');
  const attemptsPath = required(values['--attempts'], '--attempts');
  const candidateCommit = required(values['--candidate-commit'], '--candidate-commit');
  const candidateExecutable = required(values['--candidate-executable'], '--candidate-executable');
  const candidateExecutableSha256 = required(values['--candidate-executable-sha256'], '--candidate-executable-sha256');
  const clientCommand = required(values['--client-command'], '--client-command');
  const clientConfigurationPath = required(values['--client-config'], '--client-config');
  const clientConfigurationProjectionPath = required(
    values['--client-config-projection'],
    '--client-config-projection',
  );
  const clientDependenciesLockPath = required(values['--client-dependencies-lock'], '--client-dependencies-lock');
  const clientDescriptorPath = required(values['--client-descriptor'], '--client-descriptor');
  const clientId = required(values['--client-id'], '--client-id');
  const evidencePath = required(values['--evidence'], '--evidence');
  const manifestPath = required(values['--manifest'], '--manifest');
  const trialsPath = required(values['--trials'], '--trials');
  if (clientArtifactBindings.length === 0 || clientBinaryBindings.length === 0) {
    throw ScriptError.make({
      message: '--client-artifact-binding and --client-binary-binding require at least one value each.',
    });
  }
  const timeoutMilliseconds = parsePositiveInteger(values['--timeout-ms'] ?? '1800000', '--timeout-ms');
  const retryAttemptId = values['--retry-of'];
  const retryReason = values['--retry-reason'];
  if ((retryAttemptId === undefined) !== (retryReason === undefined)) {
    throw ScriptError.make({message: '--retry-of and --retry-reason must be supplied together.'});
  }
  if (retryReason !== undefined && !isCodeMemoryLinkAgentRetryReason(retryReason)) {
    throw ScriptError.make({
      message: `--retry-reason must be one of: ${EffectArray.join(CODE_MEMORY_LINK_AGENT_RETRY_REASONS, ', ')}.`,
    });
  }
  return {
    approvalCommit,
    assignmentPath,
    attemptsPath,
    clientArtifactBindings,
    candidateCommit,
    candidateExecutable,
    candidateExecutableSha256,
    clientArguments,
    clientBinaryBindings,
    clientCommand,
    clientConfigurationPath,
    clientConfigurationProjectionPath,
    clientDependenciesLockPath,
    clientDescriptorPath,
    clientId,
    evidencePath,
    manifestPath,
    ...(retryAttemptId === undefined ? {} : {retryAttemptId}),
    ...(retryReason === undefined ? {} : {retryReason}),
    timeoutMilliseconds,
    trialsPath,
  };
}

function isCodeMemoryLinkAgentRetryReason(value: string): value is CodeMemoryLinkAgentRetryReason {
  return EffectArray.some(CODE_MEMORY_LINK_AGENT_RETRY_REASONS, reason => reason === value);
}

function assertRetryAcknowledgement(
  options: Options,
  requiredRetry: null | {readonly attemptId: string; readonly reason: CodeMemoryLinkAgentRetryReason},
): void {
  if (requiredRetry === null) {
    if (options.retryAttemptId !== undefined || options.retryReason !== undefined) {
      throw ScriptError.make({
        message: 'Retry acknowledgement was supplied, but the ledger has no unresolved attempt.',
      });
    }
    return;
  }
  if (options.retryAttemptId !== requiredRetry.attemptId || options.retryReason !== requiredRetry.reason) {
    throw ScriptError.make({
      message: `Retry requires --retry-of ${requiredRetry.attemptId} --retry-reason ${requiredRetry.reason}.`,
    });
  }
}

function lockWaitMilliseconds(clientTimeoutMilliseconds: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, clientTimeoutMilliseconds + 5 * 60_000);
}

function assertDescriptorMatches(
  expected: CodeMemoryLinkClientImplementationDescriptorV1,
  actual: CodeMemoryLinkClientImplementationDescriptorV1,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw ScriptError.make({
      message: 'The invoked client bytes, arguments, artifacts, or configuration do not match the descriptor.',
    });
  }
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw ScriptError.make({message: `${option} must be a positive integer.`});
  return parsed;
}

function parseFileBinding(value: string, option: string): {readonly path: string; readonly role: string} {
  const separator = Effect2.pipe(
    value,
    EffectString.indexOf('='),
    Effect2.Option.getOrElse(() => -1),
  );
  if (separator < 1) throw ScriptError.make({message: `${option} requires role=/absolute/path.`});
  const role = Effect2.pipe(value, EffectString.slice(0, separator));
  const path = Effect2.pipe(value, EffectString.slice(separator + 1));
  if (
    !/^[a-z][a-z0-9-]{0,63}$/u.test(role) ||
    !Effect2.pipe(path, EffectString.startsWith('/')) ||
    Effect2.pipe(path, EffectString.includes('\0'))
  ) {
    throw ScriptError.make({message: `${option} requires one portable role and absolute path.`});
  }
  return {path, role};
}

function randomOpaqueId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${EffectArray.join(
    EffectArray.map([...bytes], value => Effect2.pipe(value.toString(16), EffectString.padStart(2, '0'))),
    '',
  )}`;
}

function required(value: string | undefined, option: string): string {
  if (value === undefined) throw ScriptError.make({message: `${option} requires a value.`});
  if (!Effect2.pipe(value, EffectString.trim)) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));

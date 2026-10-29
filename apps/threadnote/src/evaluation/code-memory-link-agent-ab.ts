import {Array as EffectArray, Option as EffectOption} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  assertUniqueCodeMemoryLinkAttestations,
  codeMemoryLinkCandidateFromAttestation,
  createCodeMemoryLinkInvocationAttestationV1,
  parseCodeMemoryLinkInvocationAttestationV1,
  type CodeMemoryLinkRuntimeIdentityV1,
} from './code-memory-link-attestation.js';
import {
  CODE_MEMORY_LINK_AGENT_AB_APPROVED_EVIDENCE_HASHES,
  CODE_MEMORY_LINK_AGENT_AB_APPROVED_MANIFEST_HASHES,
} from './code-memory-link-approvals.js';
import {
  assertCodeMemoryLinkAgentAttemptLedgerV1,
  parseCodeMemoryLinkAgentAttemptEventV1,
} from './code-memory-link-agent-attempts.js';
import {
  assertCodeMemoryLinkAgentEvidenceLedgerV1,
  parseCodeMemoryLinkAgentEvidenceReceiptV1,
} from './code-memory-link-agent-evidence.js';
import {parseCodeMemoryLinkExpectedCodexClientV1} from './code-memory-link-agent-client-identity.js';
import {
  armPosition,
  assertCanonicalOrder,
  assertUnique,
  boolean,
  exactKeys,
  invalid,
  literal,
  matchingString,
  nonNegativeInteger,
  positiveInteger,
  record,
} from './code-memory-link-agent-ab-parse.js';
import type {
  ArmAcceptanceMetricV1,
  BinaryScenarioFamilyMetricV1,
  FirstUseMetricV1,
  PairedPassMetricV1,
  PerClientMetricV1,
  ReductionScenarioFamilyMetricV1,
  TotalTaskUsageMetricV1,
} from './code-memory-link-agent-ab-metrics.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

import {
  CODE_MEMORY_LINK_AGENT_AB_VERSION,
  CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS,
  CODE_MEMORY_LINK_AGENT_AB_ARMS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_CLIENTS,
  CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_CLIENTS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_HIDDEN_TASKS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_TASKS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_HIDDEN_SCENARIO_FAMILIES,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILIES,
  CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_TASKS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_FIRST_USE_REDUCTION_PERCENT,
  CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_REGRESSION_PERCENTAGE_POINTS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_PASS_RATE,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILY_PASS_RATE,
  CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILY_REGRESSION_EVENT_RATE,
  CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
} from './code-memory-link-agent-ab-contracts.js';
import type {
  CodeMemoryLinkAgentAbBlindLabel,
  CodeMemoryLinkAgentAbArm,
  CodeMemoryLinkAgentAbScenarioFamily,
  CodeMemoryLinkAgentAbAssignmentV1,
  CodeMemoryLinkAgentAbManifestV1,
  CodeMemoryLinkAgentAbManifestClientV1,
  CodeMemoryLinkAgentAbScheduleEntryV1,
  CodeMemoryLinkAgentAbManifestTaskV1,
  CodeMemoryLinkAgentAbTrialV1,
  CodeMemoryLinkAgentAbTrialSummaryV1,
  CodeMemoryLinkAgentAbClientTrialSummaryV1,
  CodeMemoryLinkAgentAbResultV1,
} from './code-memory-link-agent-ab-contracts.js';
export {
  CODE_MEMORY_LINK_AGENT_AB_VERSION,
  CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS,
  CODE_MEMORY_LINK_AGENT_AB_ARMS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_CLIENTS,
  CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_CLIENTS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_HIDDEN_TASKS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_TASKS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_HIDDEN_SCENARIO_FAMILIES,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILIES,
  CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_TASKS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_FIRST_USE_REDUCTION_PERCENT,
  CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_REGRESSION_PERCENTAGE_POINTS,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_PASS_RATE,
  CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILY_PASS_RATE,
  CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILY_REGRESSION_EVENT_RATE,
  CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
} from './code-memory-link-agent-ab-contracts.js';
export type {
  CodeMemoryLinkAgentAbBlindLabel,
  CodeMemoryLinkAgentAbArm,
  CodeMemoryLinkAgentAbScenarioFamily,
  CodeMemoryLinkAgentAbAssignmentV1,
  CodeMemoryLinkAgentAbManifestV1,
  CodeMemoryLinkAgentAbManifestClientV1,
  CodeMemoryLinkAgentAbScheduleEntryV1,
  CodeMemoryLinkAgentAbManifestTaskV1,
  CodeMemoryLinkAgentAbTrialV1,
  CodeMemoryLinkAgentAbTrialSummaryV1,
  CodeMemoryLinkAgentAbClientTrialSummaryV1,
  CodeMemoryLinkAgentAbResultV1,
} from './code-memory-link-agent-ab-contracts.js';
export {
  CODE_MEMORY_LINK_AGENT_AB_APPROVED_EVIDENCE_HASHES,
  CODE_MEMORY_LINK_AGENT_AB_APPROVED_MANIFEST_HASHES,
} from './code-memory-link-approvals.js';

export function parseCodeMemoryLinkAgentAbClientTrialSummaryV1(
  value: unknown,
): CodeMemoryLinkAgentAbClientTrialSummaryV1 {
  const {
    previousReceiptDigest: _previousReceiptDigest,
    trialId: _trialId,
    ...clientSummary
  } = parseTrialSummary({
    ...record(value, 'client trial summary'),
    previousReceiptDigest: null,
    trialId: 'trl_0000000000000000',
  });
  return clientSummary;
}

interface CompleteTrialBlock {
  readonly arms: Readonly<Record<CodeMemoryLinkAgentAbArm, CodeMemoryLinkAgentAbTrialV1>>;
  readonly clientId: string;
  readonly scenarioFamily: CodeMemoryLinkAgentAbScenarioFamily;
  readonly taskId: string;
  readonly taskKind: CodeMemoryLinkAgentAbTrialV1['taskKind'];
}

const HASH = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CLIENT_ID = /^cli_[0-9a-f]{16,64}$/u;
const EXPERIMENT_ID = /^exp_[0-9a-f]{16,64}$/u;
const RUN_NONCE = /^run_[0-9a-f]{16,64}$/u;
const CONTROL_SCENARIO_FAMILY = /^control:[a-z0-9][a-z0-9-]{0,63}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const TRIAL_ID = /^trl_[0-9a-f]{16,64}$/u;
const VERSION_ID = /^ver_[0-9a-f]{16,64}$/u;
const TASK_KINDS = ['hidden-constraint', 'negative-control'] as const;
const BALANCED_BLIND_LABEL_PERMUTATIONS = [
  ['X', 'Y', 'Z'],
  ['Y', 'Z', 'X'],
  ['Z', 'X', 'Y'],
  ['X', 'Z', 'Y'],
  ['Z', 'Y', 'X'],
  ['Y', 'X', 'Z'],
] as const satisfies readonly (readonly CodeMemoryLinkAgentAbBlindLabel[])[];

export function codeMemoryLinkAgentAbAssignmentHash(input: {
  readonly fixtureHash: string;
  readonly labels: Readonly<Record<CodeMemoryLinkAgentAbBlindLabel, CodeMemoryLinkAgentAbArm>>;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_AB_VERSION;
}): string {
  const fixtureHash = matchingString(input.fixtureHash, HASH, 'assignment fixture hash');
  const labels = parseLabels(input.labels);
  if (input.version !== CODE_MEMORY_LINK_AGENT_AB_VERSION) invalid('assignment version must be 1');
  return sha256HexSync(`${JSON.stringify({fixtureHash, labels, version: input.version})}\n`);
}

export function parseCodeMemoryLinkAgentAbAssignmentV1(value: unknown): CodeMemoryLinkAgentAbAssignmentV1 {
  const assignment = record(value, 'assignment');
  exactKeys(assignment, ['assignmentHash', 'fixtureHash', 'labels', 'version'], 'assignment');
  if (assignment.version !== CODE_MEMORY_LINK_AGENT_AB_VERSION) invalid('assignment version must be 1');
  const parsed = {
    assignmentHash: matchingString(assignment.assignmentHash, HASH, 'assignment hash'),
    fixtureHash: matchingString(assignment.fixtureHash, HASH, 'assignment fixture hash'),
    labels: parseLabels(assignment.labels),
    version: CODE_MEMORY_LINK_AGENT_AB_VERSION,
  } satisfies CodeMemoryLinkAgentAbAssignmentV1;
  const expected = codeMemoryLinkAgentAbAssignmentHash(parsed);
  if (parsed.assignmentHash !== expected) invalid('assignment hash does not match the separate blind-label mapping');
  return parsed;
}

export function codeMemoryLinkAgentAbManifestHash(input: {
  readonly adjudicationArtifactHash: string;
  readonly assignmentHash: string;
  readonly candidate: CodeMemoryLinkAgentAbManifestV1['candidate'];
  readonly clients: readonly CodeMemoryLinkAgentAbManifestClientV1[];
  readonly evaluatorVersion: string;
  readonly experimentId: string;
  readonly fixtureHash: string;
  readonly harnessGovernanceCommit?: string;
  readonly judgeVersion: string;
  readonly schedule: readonly CodeMemoryLinkAgentAbScheduleEntryV1[];
  readonly scheduleAlgorithmVersion: typeof CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION;
  readonly scheduleSeed: string;
  readonly suiteHash: string;
  readonly tasks: readonly CodeMemoryLinkAgentAbManifestTaskV1[];
  readonly version: typeof CODE_MEMORY_LINK_AGENT_AB_VERSION;
}): string {
  if (input.version !== CODE_MEMORY_LINK_AGENT_AB_VERSION) invalid('manifest version must be 1');
  const clients = parseManifestClients(input.clients);
  const tasks = parseManifestTasks(input.tasks);
  const scheduleAlgorithmVersion = scheduleAlgorithmVersionValue(input.scheduleAlgorithmVersion);
  const scheduleSeed = matchingString(input.scheduleSeed, HASH, 'manifest schedule seed');
  const normalized = {
    adjudicationArtifactHash: matchingString(
      input.adjudicationArtifactHash,
      HASH,
      'manifest adjudication artifact hash',
    ),
    assignmentHash: matchingString(input.assignmentHash, HASH, 'manifest assignment hash'),
    candidate: parseCandidate(input.candidate),
    clients,
    evaluatorVersion: matchingString(input.evaluatorVersion, VERSION_ID, 'manifest evaluator version'),
    experimentId: matchingString(input.experimentId, EXPERIMENT_ID, 'experiment id'),
    fixtureHash: matchingString(input.fixtureHash, HASH, 'manifest fixture hash'),
    ...(input.harnessGovernanceCommit === undefined
      ? {}
      : {
          harnessGovernanceCommit: matchingString(input.harnessGovernanceCommit, COMMIT, 'harness governance commit'),
        }),
    judgeVersion: matchingString(input.judgeVersion, VERSION_ID, 'manifest judge version'),
    schedule: parseSchedule(input.schedule, clients, tasks, scheduleAlgorithmVersion, scheduleSeed),
    scheduleAlgorithmVersion,
    scheduleSeed,
    suiteHash: matchingString(input.suiteHash, HASH, 'manifest suite hash'),
    tasks,
    version: CODE_MEMORY_LINK_AGENT_AB_VERSION,
  };
  return sha256HexSync(`${JSON.stringify(normalized)}\n`);
}

export function parseCodeMemoryLinkAgentAbManifestV1(value: unknown): CodeMemoryLinkAgentAbManifestV1 {
  const manifest = record(value, 'manifest');
  const keys = [
    'adjudicationArtifactHash',
    'assignmentHash',
    'candidate',
    'clients',
    'evaluatorVersion',
    'experimentId',
    'fixtureHash',
    'judgeVersion',
    'manifestHash',
    'schedule',
    'scheduleAlgorithmVersion',
    'scheduleSeed',
    'suiteHash',
    'tasks',
    'version',
  ];
  if ('harnessGovernanceCommit' in manifest) keys.push('harnessGovernanceCommit');
  exactKeys(manifest, keys, 'manifest');
  if (manifest.version !== CODE_MEMORY_LINK_AGENT_AB_VERSION) invalid('manifest version must be 1');
  const clients = parseManifestClients(manifest.clients);
  const tasks = parseManifestTasks(manifest.tasks);
  const scheduleAlgorithmVersion = scheduleAlgorithmVersionValue(manifest.scheduleAlgorithmVersion);
  const scheduleSeed = matchingString(manifest.scheduleSeed, HASH, 'manifest schedule seed');
  const parsed = {
    adjudicationArtifactHash: matchingString(
      manifest.adjudicationArtifactHash,
      HASH,
      'manifest adjudication artifact hash',
    ),
    assignmentHash: matchingString(manifest.assignmentHash, HASH, 'manifest assignment hash'),
    candidate: parseCandidate(manifest.candidate),
    clients,
    evaluatorVersion: matchingString(manifest.evaluatorVersion, VERSION_ID, 'manifest evaluator version'),
    experimentId: matchingString(manifest.experimentId, EXPERIMENT_ID, 'experiment id'),
    fixtureHash: matchingString(manifest.fixtureHash, HASH, 'manifest fixture hash'),
    ...('harnessGovernanceCommit' in manifest
      ? {
          harnessGovernanceCommit: matchingString(
            manifest.harnessGovernanceCommit,
            COMMIT,
            'harness governance commit',
          ),
        }
      : {}),
    judgeVersion: matchingString(manifest.judgeVersion, VERSION_ID, 'manifest judge version'),
    manifestHash: matchingString(manifest.manifestHash, HASH, 'manifest hash'),
    schedule: parseSchedule(manifest.schedule, clients, tasks, scheduleAlgorithmVersion, scheduleSeed),
    scheduleAlgorithmVersion,
    scheduleSeed,
    suiteHash: matchingString(manifest.suiteHash, HASH, 'manifest suite hash'),
    tasks,
    version: CODE_MEMORY_LINK_AGENT_AB_VERSION,
  } satisfies CodeMemoryLinkAgentAbManifestV1;
  const expected = codeMemoryLinkAgentAbManifestHash(parsed);
  if (parsed.manifestHash !== expected) invalid('manifest hash does not match its reviewed experiment roster');
  return parsed;
}

/** Frozen seeded schedule derivation used by preregistration tooling and manifest validation. */
export function deriveCodeMemoryLinkAgentAbScheduleV1(input: {
  readonly clients: readonly CodeMemoryLinkAgentAbManifestClientV1[];
  readonly scheduleAlgorithmVersion: typeof CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION;
  readonly scheduleSeed: string;
  readonly tasks: readonly CodeMemoryLinkAgentAbManifestTaskV1[];
}): readonly CodeMemoryLinkAgentAbScheduleEntryV1[] {
  const clients = parseManifestClients(input.clients);
  const tasks = parseManifestTasks(input.tasks);
  scheduleAlgorithmVersionValue(input.scheduleAlgorithmVersion);
  const scheduleSeed = matchingString(input.scheduleSeed, HASH, 'manifest schedule seed');
  return deriveValidatedSchedule(clients, tasks, scheduleSeed);
}

/** Fail closed unless the preregistered candidate is the exact verified managed executable. */
export function assertCodeMemoryLinkAgentAbRuntimeIdentity(
  candidateInput: CodeMemoryLinkAgentAbManifestV1['candidate'],
  runtimeInput: {
    readonly executableSha256: string;
    readonly sourceCommit: string;
  },
): void {
  const candidate = parseCandidate(candidateInput);
  const executableSha256 = matchingString(runtimeInput.executableSha256, HASH, 'runtime executable hash');
  const sourceCommit = matchingString(runtimeInput.sourceCommit, COMMIT, 'runtime source commit');
  if (candidate.commit !== sourceCommit || candidate.buildIdentityHash !== executableSha256) {
    invalid('manifest candidate does not match the exact verified managed runtime');
  }
}

/** Seal one scrubbed external-agent outcome around exact pre/post managed-runtime observations. */
export function createCodeMemoryLinkAgentAbTrialV1(input: {
  readonly candidate: CodeMemoryLinkAgentAbManifestV1['candidate'];
  readonly invocationNonce: string;
  readonly postRuntime: CodeMemoryLinkRuntimeIdentityV1;
  readonly preRuntime: CodeMemoryLinkRuntimeIdentityV1;
  readonly previousReceiptDigest: string | null;
  readonly trial: CodeMemoryLinkAgentAbClientTrialSummaryV1 | unknown;
  readonly trialId: string;
}): CodeMemoryLinkAgentAbTrialV1 {
  const candidate = parseCandidate(input.candidate);
  const clientSummary = record(input.trial, 'client trial summary');
  if ('previousReceiptDigest' in clientSummary || 'trialId' in clientSummary) {
    invalid('the client trial summary must not supply harness-controlled receipt identity');
  }
  const summary = parseTrialSummary({
    ...clientSummary,
    previousReceiptDigest: input.previousReceiptDigest,
    trialId: input.trialId,
  });
  return {
    ...summary,
    attestation: createCodeMemoryLinkInvocationAttestationV1({
      candidate,
      harnessCommit: summary.approvalCommit,
      invocation: trialInvocation(summary),
      invocationNonce: input.invocationNonce,
      outputProjection: summary,
      postRuntime: input.postRuntime,
      preRuntime: input.preRuntime,
      summary,
    }),
  };
}

export function parseCodeMemoryLinkAgentAbTrialV1(value: unknown): CodeMemoryLinkAgentAbTrialV1 {
  const trial = record(value, 'trial');
  exactKeys(
    trial,
    [
      'acceptedStaleOrHarmful',
      'adjudicationHash',
      'attestation',
      'approvalCommit',
      'armPosition',
      'assignmentHash',
      'blindLabel',
      'budget',
      'clientId',
      'constraintAdherence',
      'evidenceKind',
      'firstUsefulMemoryUse',
      'fixtureHash',
      'manifestHash',
      'packetHash',
      'previousReceiptDigest',
      'providerUsageHash',
      'rubricHash',
      'runNonce',
      'runOrder',
      'taskId',
      'taskKind',
      'taskPassed',
      'tokenAccounting',
      'totalTaskUsage',
      'trialId',
      'version',
    ],
    'trial',
  );
  const {attestation: attestationInput, ...summaryInput} = trial;
  const summary = parseTrialSummary(summaryInput);
  const candidate = codeMemoryLinkCandidateFromAttestation(attestationInput);
  return {
    ...summary,
    attestation: parseCodeMemoryLinkInvocationAttestationV1(attestationInput, {
      candidate,
      harnessCommit: summary.approvalCommit,
      invocation: trialInvocation(summary),
      outputProjection: summary,
      summary,
    }),
  };
}

function parseTrialSummary(value: unknown): CodeMemoryLinkAgentAbTrialSummaryV1 {
  const trial = record(value, 'trial summary');
  exactKeys(
    trial,
    [
      'acceptedStaleOrHarmful',
      'adjudicationHash',
      'approvalCommit',
      'armPosition',
      'assignmentHash',
      'blindLabel',
      'budget',
      'clientId',
      'constraintAdherence',
      'evidenceKind',
      'firstUsefulMemoryUse',
      'fixtureHash',
      'manifestHash',
      'packetHash',
      'previousReceiptDigest',
      'providerUsageHash',
      'rubricHash',
      'runNonce',
      'runOrder',
      'taskId',
      'taskKind',
      'taskPassed',
      'tokenAccounting',
      'totalTaskUsage',
      'trialId',
      'version',
    ],
    'trial summary',
  );
  if (trial.version !== CODE_MEMORY_LINK_AGENT_AB_VERSION) invalid('trial version must be 1');
  const budget = parseBudget(trial.budget);
  const taskKind = literal(trial.taskKind, ['hidden-constraint', 'negative-control'] as const, 'task kind');
  const constraintAdherence = parseConstraintAdherence(trial.constraintAdherence, taskKind);
  const totalTaskUsage = parseTotalTaskUsage(trial.totalTaskUsage, budget);
  return {
    acceptedStaleOrHarmful: boolean(trial.acceptedStaleOrHarmful, 'stale or harmful acceptance'),
    adjudicationHash: matchingString(trial.adjudicationHash, HASH, 'trial adjudication hash'),
    approvalCommit: matchingString(trial.approvalCommit, COMMIT, 'trial manifest approval commit'),
    armPosition: armPosition(trial.armPosition),
    assignmentHash: matchingString(trial.assignmentHash, HASH, 'trial assignment hash'),
    blindLabel: literal(trial.blindLabel, CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS, 'blind label'),
    budget,
    clientId: matchingString(trial.clientId, CLIENT_ID, 'client id'),
    constraintAdherence,
    evidenceKind: literal(trial.evidenceKind, ['external-agent', 'mock'] as const, 'evidence kind'),
    firstUsefulMemoryUse: parseFirstUse(trial.firstUsefulMemoryUse, totalTaskUsage),
    fixtureHash: matchingString(trial.fixtureHash, HASH, 'trial fixture hash'),
    manifestHash: matchingString(trial.manifestHash, HASH, 'trial manifest hash'),
    packetHash: matchingString(trial.packetHash, HASH, 'packet hash'),
    previousReceiptDigest:
      trial.previousReceiptDigest === null
        ? null
        : matchingString(trial.previousReceiptDigest, HASH, 'previous receipt digest'),
    providerUsageHash: matchingString(trial.providerUsageHash, HASH, 'provider usage hash'),
    rubricHash: matchingString(trial.rubricHash, HASH, 'rubric hash'),
    runNonce: matchingString(trial.runNonce, RUN_NONCE, 'trial run nonce'),
    runOrder: nonNegativeInteger(trial.runOrder, 'trial run order'),
    taskId: matchingString(trial.taskId, TASK_ID, 'task id'),
    taskKind,
    taskPassed: boolean(trial.taskPassed, 'task passed'),
    tokenAccounting: literal(
      trial.tokenAccounting,
      ['client-reported', 'provider-reported', 'unavailable'] as const,
      'token accounting',
    ),
    totalTaskUsage,
    trialId: matchingString(trial.trialId, TRIAL_ID, 'trial id'),
    version: CODE_MEMORY_LINK_AGENT_AB_VERSION,
  };
}

function trialInvocation(trial: CodeMemoryLinkAgentAbTrialSummaryV1): unknown {
  return {
    approvalCommit: trial.approvalCommit,
    armPosition: trial.armPosition,
    assignmentHash: trial.assignmentHash,
    blindLabel: trial.blindLabel,
    clientId: trial.clientId,
    fixtureHash: trial.fixtureHash,
    manifestHash: trial.manifestHash,
    previousReceiptDigest: trial.previousReceiptDigest,
    runNonce: trial.runNonce,
    runOrder: trial.runOrder,
    taskId: trial.taskId,
    taskKind: trial.taskKind,
    trialId: trial.trialId,
    version: trial.version,
  };
}

/** Canonical content digest used by the append-only preregistered trial ledger. */
export function codeMemoryLinkAgentAbTrialReceiptDigest(value: unknown): string {
  return sha256HexSync(`${JSON.stringify(parseCodeMemoryLinkAgentAbTrialV1(value))}\n`);
}

/** Canonical post-run hash over receipts plus the exact ordered attempt and replayable-evidence journals. */
export function codeMemoryLinkAgentAbExternalEvidenceHash(input: {
  readonly attempts?: readonly unknown[];
  readonly evidence?: readonly unknown[];
  readonly manifestHash: string;
  readonly trials: readonly unknown[];
  readonly version: typeof CODE_MEMORY_LINK_AGENT_AB_VERSION;
}): string {
  if (input.version !== CODE_MEMORY_LINK_AGENT_AB_VERSION) invalid('external evidence version must be 1');
  const manifestHash = matchingString(input.manifestHash, HASH, 'external evidence manifest hash');
  const trials = EffectArray.filter(
    EffectArray.map(input.trials, parseCodeMemoryLinkAgentAbTrialV1),
    trial => trial.evidenceKind === 'external-agent',
  ).sort(compareTrialsCanonically);
  assertUnique(
    EffectArray.map(trials, trial => trial.trialId),
    'external evidence trial ids',
  );
  assertUniqueCodeMemoryLinkAttestations(
    EffectArray.map(trials, trial => trial.attestation),
    'external evidence',
  );
  const attempts = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(input.attempts), __effectArrayReceiver =>
      EffectArray.map(__effectArrayReceiver, parseCodeMemoryLinkAgentAttemptEventV1),
    ),
  );
  const evidence = EffectOption.getOrUndefined(
    EffectOption.map(EffectOption.fromNullishOr(input.evidence), __effectArrayReceiver =>
      EffectArray.map(__effectArrayReceiver, parseCodeMemoryLinkAgentEvidenceReceiptV1),
    ),
  );
  const projection = {
    ...(attempts === undefined ? {} : {attempts}),
    ...(evidence === undefined ? {} : {evidence}),
    manifestHash,
    trials,
    version: CODE_MEMORY_LINK_AGENT_AB_VERSION,
  };
  return sha256HexSync(`${JSON.stringify(projection)}\n`);
}

/** Parse newline-delimited scrubbed receipts. Raw prompts and transcripts are intentionally not part of this schema. */
export function parseCodeMemoryLinkAgentAbTrialsJsonl(input: string): readonly CodeMemoryLinkAgentAbTrialV1[] {
  if (new TextEncoder().encode(input).byteLength > 16 * 1024 * 1024) invalid('JSONL input exceeds 16 MiB');
  return EffectArray.flatMap(Effect.pipe(input, EffectString.split(/\r?\n/u)), (line, index) => {
    if (!Effect.pipe(line, EffectString.trim)) return [];
    try {
      return [parseCodeMemoryLinkAgentAbTrialV1(JSON.parse(line) as unknown)];
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Invalid Code Memory Link agent A/B JSONL line ${index + 1}: ${detail}`, {cause});
    }
  });
}

/**
 * Require file order to be the exact frozen schedule prefix and bind every receipt to the previous one.
 * Release verification and the runner use this stricter boundary; the score function also supports unordered
 * in-memory matrices so metric tests and offline analysis remain order-invariant.
 */
export function assertCodeMemoryLinkAgentAbTrialLedgerPrefixV1(input: {
  readonly assignment: unknown;
  readonly manifest: unknown;
  readonly trials: readonly unknown[];
}): void {
  const manifest = parseCodeMemoryLinkAgentAbManifestV1(input.manifest);
  const trials = EffectArray.map(input.trials, parseCodeMemoryLinkAgentAbTrialV1);
  evaluateCodeMemoryLinkAgentAb({...input, manifest, trials});
  if (trials.length > manifest.schedule.length) invalid('trial ledger is longer than the frozen schedule');
  for (const [index, trial] of trials.entries()) {
    const scheduled = manifest.schedule[index];
    if (trial.evidenceKind !== 'external-agent') invalid('trial ledger may contain only external-agent receipts');
    if (
      trial.runOrder !== index ||
      trial.clientId !== scheduled.clientId ||
      trial.taskId !== scheduled.taskId ||
      trial.blindLabel !== scheduled.blindLabel ||
      trial.runNonce !== scheduled.runNonce ||
      trial.armPosition !== scheduled.armPosition
    ) {
      invalid(`trial ledger entry ${index} is not the next frozen schedule receipt`);
    }
    const expectedPrevious = index === 0 ? null : codeMemoryLinkAgentAbTrialReceiptDigest(trials[index - 1]);
    if (trial.previousReceiptDigest !== expectedPrevious) {
      invalid(`trial ledger entry ${index} does not extend the previous receipt digest`);
    }
  }
}

export function evaluateCodeMemoryLinkAgentAb(input: {
  readonly assignment: unknown;
  readonly attempts?: readonly unknown[];
  readonly evidence?: readonly unknown[];
  readonly manifest: unknown;
  readonly trials: readonly unknown[];
}): CodeMemoryLinkAgentAbResultV1 {
  const assignment = parseCodeMemoryLinkAgentAbAssignmentV1(input.assignment);
  const manifest = parseCodeMemoryLinkAgentAbManifestV1(input.manifest);
  if (manifest.fixtureHash !== assignment.fixtureHash) invalid('manifest fixture hash does not match assignment');
  if (manifest.assignmentHash !== assignment.assignmentHash) invalid('manifest assignment hash does not match');
  const trials = EffectArray.map(input.trials, parseCodeMemoryLinkAgentAbTrialV1);
  assertUnique(
    EffectArray.map(trials, trial => trial.trialId),
    'trial ids',
  );
  const tasks = new Map(EffectArray.map(manifest.tasks, task => [task.taskId, task]));
  const clients = new Set(EffectArray.map(manifest.clients, client => client.clientId));
  const schedule = new Map(
    EffectArray.map(manifest.schedule, entry => [scheduleKey(entry.clientId, entry.taskId, entry.blindLabel), entry]),
  );
  for (const trial of trials) {
    assertCodeMemoryLinkAgentAbRuntimeIdentity(manifest.candidate, trial.attestation.preRuntime);
    assertCodeMemoryLinkAgentAbRuntimeIdentity(manifest.candidate, trial.attestation.postRuntime);
    if (trial.fixtureHash !== assignment.fixtureHash) invalid(`trial ${trial.trialId} fixture hash does not match`);
    if (trial.assignmentHash !== assignment.assignmentHash)
      invalid(`trial ${trial.trialId} assignment hash does not match`);
    if (trial.manifestHash !== manifest.manifestHash) invalid(`trial ${trial.trialId} manifest hash does not match`);
    if (!clients.has(trial.clientId)) invalid(`trial ${trial.trialId} client id is outside the manifest roster`);
    const task = tasks.get(trial.taskId);
    if (!task) invalid(`trial ${trial.trialId} task id is outside the manifest roster`);
    validateTrialTaskContract(trial, task);
    const scheduled = schedule.get(scheduleKey(trial.clientId, trial.taskId, trial.blindLabel));
    if (!scheduled) invalid(`trial ${trial.trialId} is outside the preregistered run schedule`);
    validateTrialSchedule(trial, scheduled);
  }

  const external = EffectArray.filter(trials, trial => trial.evidenceKind === 'external-agent');
  assertUniqueCodeMemoryLinkAttestations(
    EffectArray.map(external, trial => trial.attestation),
    'external-agent trials',
  );
  assertUnique(
    EffectArray.map(external, trial => trial.providerUsageHash),
    'external-agent provider usage hashes',
  );
  assertUnique(
    EffectArray.map(external, trial => trial.adjudicationHash),
    'external-agent adjudication hashes',
  );
  const manifestApprovalCommits = new Set(EffectArray.map(external, trial => trial.approvalCommit));
  const manifestApprovalCommit = manifestApprovalCommits.size === 1 ? (external[0]?.approvalCommit ?? null) : null;
  const insufficiencies: string[] = [];
  if (input.attempts !== undefined) {
    if (manifestApprovalCommit === null) {
      if (input.attempts.length > 0) invalid('attempt audit requires one external-agent manifest approval commit');
    } else {
      const attemptState = assertCodeMemoryLinkAgentAttemptLedgerV1({
        approvalCommit: manifestApprovalCommit,
        events: input.attempts,
        manifest,
        trials: external,
      });
      const attemptEvents = attemptState.events;
      const starts = EffectArray.filter(attemptEvents, event => event.type === 'attempt-started');
      if (
        attemptState.requiredRetry !== null ||
        starts.length !== external.length ||
        EffectArray.some(starts, event => event.retryOfAttemptId !== null) ||
        EffectArray.some(attemptEvents, event => event.type === 'attempt-failed')
      ) {
        insufficiencies.push(
          'attempt audit contains failed, interrupted, or retried runs; a release experiment requires a fresh preregistered manifest',
        );
      }
    }
  }
  const retainedEvidence =
    input.evidence === undefined
      ? undefined
      : assertCodeMemoryLinkAgentEvidenceLedgerV1({
          assignment,
          evidence: input.evidence,
          manifest,
          trials: external,
        });
  if (input.attempts !== undefined && external.length > 0 && retainedEvidence === undefined) {
    insufficiencies.push('replayable retained evidence is required for every audited external-agent trial');
  }
  const approvedManifest = CODE_MEMORY_LINK_AGENT_AB_APPROVED_MANIFEST_HASHES.includes(manifest.manifestHash);
  if (!approvedManifest) insufficiencies.push('manifest hash is not in the code-reviewed release allowlist');
  const externalEvidenceHash = codeMemoryLinkAgentAbExternalEvidenceHash({
    ...(input.attempts === undefined ? {} : {attempts: input.attempts}),
    ...(retainedEvidence === undefined ? {} : {evidence: retainedEvidence}),
    manifestHash: manifest.manifestHash,
    trials: external,
    version: CODE_MEMORY_LINK_AGENT_AB_VERSION,
  });
  const approvedEvidence = CODE_MEMORY_LINK_AGENT_AB_APPROVED_EVIDENCE_HASHES.includes(externalEvidenceHash);
  if (!approvedEvidence) insufficiencies.push('external evidence hash is not in the code-reviewed release allowlist');
  const assessmentBlockers: string[] = [];
  const completeBlocks = completeTrialBlocks(external, assignment, manifest, assessmentBlockers);
  minimumEvidenceFailures(manifest, external, assessmentBlockers);
  validateArmSemantics(completeBlocks, assessmentBlockers);
  insufficiencies.push(...assessmentBlockers);

  const hiddenBlocks = EffectArray.filter(completeBlocks, block => block.taskKind === 'hidden-constraint');
  const negativeBlocks = EffectArray.filter(completeBlocks, block => block.taskKind === 'negative-control');
  const hiddenTasks = EffectArray.filter(manifest.tasks, task => task.taskKind === 'hidden-constraint');
  const negativeTasks = EffectArray.filter(manifest.tasks, task => task.taskKind === 'negative-control');

  const adherence = adherenceMetrics(hiddenBlocks);
  const firstUsefulMemoryUse = firstUseMetrics(hiddenBlocks);
  const hiddenTaskPass = hiddenTaskPassMetrics(hiddenBlocks);
  const negativeControl = negativeControlMetrics(negativeBlocks);
  const perClient = perClientMetrics(
    completeBlocks,
    EffectArray.map(manifest.clients, client => client.clientId),
  );
  const staleOrHarmfulAcceptance = acceptanceMetrics(completeBlocks);
  const totalTaskUsage = totalTaskUsageMetrics(hiddenBlocks);
  const qualityFailures = monotoneSafetyFailures(external, assignment);
  if (assessmentBlockers.length === 0) {
    qualityGateFailures(
      adherence,
      firstUsefulMemoryUse,
      hiddenTaskPass,
      negativeControl,
      perClient,
      totalTaskUsage,
      qualityFailures,
    );
  }

  const uniqueInsufficiencies = [...new Set(insufficiencies)].sort();
  const uniqueQualityFailures = [...new Set(qualityFailures)].sort();
  const failures = [...new Set([...uniqueInsufficiencies, ...uniqueQualityFailures])].sort();
  const status = uniqueQualityFailures.length > 0 ? 'failed' : failures.length > 0 ? 'insufficient' : 'passed';
  return {
    assignmentHash: assignment.assignmentHash,
    candidate: manifest.candidate,
    evidence: {
      approvedEvidence,
      approvedManifest,
      distinctClients: manifest.clients.length,
      eligibleExternalTrials: external.length,
      excludedMockTrials: trials.length - external.length,
      externalEvidenceHash,
      hiddenTasks: hiddenTasks.length,
      manifestApprovalCommit,
      negativeControlTasks: negativeTasks.length,
      pairedBlocks: completeBlocks.length,
      retainedEvidenceReceipts: retainedEvidence?.length ?? 0,
    },
    fixtureHash: assignment.fixtureHash,
    gate: {
      failures,
      insufficiencies: uniqueInsufficiencies,
      qualityFailures: uniqueQualityFailures,
      status,
    },
    manifestHash: manifest.manifestHash,
    metrics: {
      adherence,
      firstUsefulMemoryUse,
      hiddenTaskPass,
      negativeControl,
      perClient,
      staleOrHarmfulAcceptance,
      totalTaskUsage,
    },
    suiteHash: manifest.suiteHash,
    version: CODE_MEMORY_LINK_AGENT_AB_VERSION,
  };
}

function completeTrialBlocks(
  trials: readonly CodeMemoryLinkAgentAbTrialV1[],
  assignment: CodeMemoryLinkAgentAbAssignmentV1,
  manifest: CodeMemoryLinkAgentAbManifestV1,
  failures: string[],
): readonly CompleteTrialBlock[] {
  const grouped = new Map<string, CodeMemoryLinkAgentAbTrialV1[]>();
  for (const trial of trials) {
    const key = `${trial.clientId}\0${trial.taskId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), trial]);
  }
  const blocks: CompleteTrialBlock[] = [];
  for (const {clientId} of manifest.clients) {
    for (const task of manifest.tasks) {
      const key = `${clientId}\0${task.taskId}`;
      const group = grouped.get(key) ?? [];
      const byLabel = new Map(EffectArray.map(group, trial => [trial.blindLabel, trial]));
      if (
        group.length !== 3 ||
        byLabel.size !== 3 ||
        Boolean(EffectArray.some(CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS, label => !byLabel.has(label)))
      ) {
        failures.push(`manifest paired block ${displayKey(key)} requires exactly one X, Y, and Z external-agent trial`);
        continue;
      }
      const trialsByArm = new Map<CodeMemoryLinkAgentAbArm, CodeMemoryLinkAgentAbTrialV1>();
      for (const label of CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS) {
        const trial = byLabel.get(label);
        if (trial !== undefined) trialsByArm.set(assignment.labels[label], trial);
      }
      const anchored = trialsByArm.get('anchored');
      const taskOnly = trialsByArm.get('task-only');
      const noMemory = trialsByArm.get('no-memory');
      if (!anchored || !taskOnly || !noMemory) {
        failures.push(`manifest paired block ${displayKey(key)} has an incomplete arm assignment`);
        continue;
      }
      blocks.push({
        arms: {anchored, 'no-memory': noMemory, 'task-only': taskOnly},
        clientId,
        scenarioFamily: task.scenarioFamily,
        taskId: task.taskId,
        taskKind: task.taskKind,
      });
    }
  }
  return blocks;
}

function minimumEvidenceFailures(
  manifest: CodeMemoryLinkAgentAbManifestV1,
  external: readonly CodeMemoryLinkAgentAbTrialV1[],
  failures: string[],
): void {
  if (external.length === 0) failures.push('no external-agent trials; mock receipts cannot support a release claim');
  if (external.length > 0 && new Set(EffectArray.map(external, trial => trial.approvalCommit)).size !== 1) {
    failures.push('external-agent trials must share one preregistered manifest approval commit');
  }
  if (manifest.clients.length < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_CLIENTS) {
    failures.push(
      `rostered external clients ${manifest.clients.length}; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_CLIENTS}`,
    );
  }
  const hiddenTasks = EffectArray.filter(manifest.tasks, task => task.taskKind === 'hidden-constraint').length;
  const negativeTasks = EffectArray.filter(manifest.tasks, task => task.taskKind === 'negative-control').length;
  const hiddenScenarioFamilies = new Set(
    EffectArray.map(
      EffectArray.filter(manifest.tasks, task => task.taskKind === 'hidden-constraint'),
      task => task.scenarioFamily,
    ),
  ).size;
  const negativeScenarioFamilies = new Set(
    EffectArray.map(
      EffectArray.filter(manifest.tasks, task => task.taskKind === 'negative-control'),
      task => task.scenarioFamily,
    ),
  ).size;
  if (hiddenTasks < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_HIDDEN_TASKS) {
    failures.push(
      `rostered hidden-constraint tasks ${hiddenTasks}; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_HIDDEN_TASKS}`,
    );
  }
  if (negativeTasks < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_TASKS) {
    failures.push(
      `rostered negative-control tasks ${negativeTasks}; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_TASKS}`,
    );
  }
  if (hiddenScenarioFamilies < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_HIDDEN_SCENARIO_FAMILIES) {
    failures.push(
      `rostered hidden scenario families ${hiddenScenarioFamilies}; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_HIDDEN_SCENARIO_FAMILIES}`,
    );
  }
  if (negativeScenarioFamilies < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILIES) {
    failures.push(
      `rostered negative-control scenario families ${negativeScenarioFamilies}; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILIES}`,
    );
  }
  if (EffectArray.some(external, trial => trial.tokenAccounting !== 'provider-reported')) {
    failures.push('provider-reported token accounting is required for every external-agent trial');
  }
}

function validateArmSemantics(blocks: readonly CompleteTrialBlock[], failures: string[]): void {
  for (const block of blocks) {
    if (block.arms['no-memory'].firstUsefulMemoryUse !== null) {
      failures.push(`no-memory trial for ${block.clientId}/${block.taskId} reports useful memory use`);
    }
    if (
      block.taskKind === 'negative-control' &&
      EffectArray.some(CODE_MEMORY_LINK_AGENT_AB_ARMS, arm => block.arms[arm].firstUsefulMemoryUse !== null)
    ) {
      failures.push(`negative-control block ${block.clientId}/${block.taskId} reports useful memory use`);
    }
  }
}

function adherenceMetrics(
  blocks: readonly CompleteTrialBlock[],
): CodeMemoryLinkAgentAbResultV1['metrics']['adherence'] {
  const anchoredRate = rate(
    EffectArray.filter(blocks, block => allConstraintsSatisfied(block.arms.anchored)).length,
    blocks.length,
  );
  const taskOnlyRate = rate(
    EffectArray.filter(blocks, block => allConstraintsSatisfied(block.arms['task-only'])).length,
    blocks.length,
  );
  const noMemoryRate = rate(
    EffectArray.filter(blocks, block => allConstraintsSatisfied(block.arms['no-memory'])).length,
    blocks.length,
  );
  const scenarioFamilies = binaryScenarioFamilyMetrics(blocks, allConstraintsSatisfied);
  return {
    anchoredRate,
    deltaPercentagePoints: (anchoredRate - taskOnlyRate) * 100,
    minimumScenarioFamilyDeltaPercentagePoints: minimumOrNull(
      EffectArray.map(scenarioFamilies, family => family.anchoredVsTaskOnlyDeltaPercentagePoints),
    ),
    noMemoryRate,
    pairedTrials: blocks.length,
    scenarioFamilies,
    taskOnlyVsNoMemoryDeltaPercentagePoints: (taskOnlyRate - noMemoryRate) * 100,
    taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints: minimumOrNull(
      EffectArray.map(scenarioFamilies, family => family.taskOnlyVsNoMemoryDeltaPercentagePoints),
    ),
    taskOnlyRate,
  };
}

function binaryScenarioFamilyMetrics(
  blocks: readonly CompleteTrialBlock[],
  outcome: (trial: CodeMemoryLinkAgentAbTrialV1) => boolean,
): readonly BinaryScenarioFamilyMetricV1[] {
  return EffectArray.map(scenarioFamilyGroups(blocks), ([scenarioFamily, familyBlocks]) => {
    const anchoredRate = rate(
      EffectArray.filter(
        familyBlocks,
        (block, __effectArrayIndex2) => __effectArrayIndex2 in familyBlocks && outcome(block.arms.anchored),
      ).length,
      familyBlocks.length,
    );
    const taskOnlyRate = rate(
      EffectArray.filter(
        familyBlocks,
        (block, __effectArrayIndex2) => __effectArrayIndex2 in familyBlocks && outcome(block.arms['task-only']),
      ).length,
      familyBlocks.length,
    );
    const noMemoryRate = rate(
      EffectArray.filter(
        familyBlocks,
        (block, __effectArrayIndex2) => __effectArrayIndex2 in familyBlocks && outcome(block.arms['no-memory']),
      ).length,
      familyBlocks.length,
    );
    return {
      anchoredRate,
      anchoredVsTaskOnlyDeltaPercentagePoints: (anchoredRate - taskOnlyRate) * 100,
      noMemoryRate,
      pairedTrials: familyBlocks.length,
      scenarioFamily,
      taskOnlyRate,
      taskOnlyVsNoMemoryDeltaPercentagePoints: (taskOnlyRate - noMemoryRate) * 100,
    };
  });
}

function firstUseMetrics(
  blocks: readonly CompleteTrialBlock[],
): CodeMemoryLinkAgentAbResultV1['metrics']['firstUsefulMemoryUse'] {
  return {
    steps: firstUseMetric(blocks, 'steps'),
    tokens: firstUseMetric(blocks, 'tokens'),
  };
}

function firstUseMetric(blocks: readonly CompleteTrialBlock[], field: 'steps' | 'tokens'): FirstUseMetricV1 {
  const anchored = EffectArray.map(blocks, block => firstUseOrObservedCensor(block.arms.anchored, field));
  const taskOnly = EffectArray.map(blocks, block => firstUseOrObservedCensor(block.arms['task-only'], field));
  const anchoredMean = mean(anchored);
  const taskOnlyMean = mean(taskOnly);
  const scenarioFamilies = scenarioFamilyReductionMetrics(blocks, block => ({
    left: firstUseOrObservedCensor(block.arms.anchored, field),
    right: firstUseOrObservedCensor(block.arms['task-only'], field),
  }));
  return {
    anchoredCensoredTrials: EffectArray.filter(blocks, block => block.arms.anchored.firstUsefulMemoryUse === null)
      .length,
    anchoredMean,
    minimumScenarioFamilyReductionPercent: minimumOrNull(
      EffectArray.map(scenarioFamilies, family => family.reductionPercent),
    ),
    reductionPercent: taskOnlyMean === 0 ? 0 : ((taskOnlyMean - anchoredMean) / taskOnlyMean) * 100,
    scenarioFamilies,
    taskOnlyCensoredTrials: EffectArray.filter(blocks, block => block.arms['task-only'].firstUsefulMemoryUse === null)
      .length,
    taskOnlyMean,
  };
}

function scenarioFamilyReductionMetrics(
  blocks: readonly CompleteTrialBlock[],
  pair: (block: CompleteTrialBlock) => {
    readonly left: number;
    readonly right: number;
  },
): readonly ReductionScenarioFamilyMetricV1[] {
  return EffectArray.map(scenarioFamilyGroups(blocks), ([scenarioFamily, familyBlocks]) => {
    const pairs = EffectArray.map(familyBlocks, pair);
    const left = mean(EffectArray.map(pairs, value => value.left));
    const right = mean(EffectArray.map(pairs, value => value.right));
    return {
      leftMean: left,
      reductionPercent: right === 0 ? 0 : ((right - left) / right) * 100,
      rightMean: right,
      scenarioFamily,
      trials: familyBlocks.length,
    };
  });
}

function negativeControlMetrics(
  blocks: readonly CompleteTrialBlock[],
): CodeMemoryLinkAgentAbResultV1['metrics']['negativeControl'] {
  const taskClusters = [...groupBlocks(blocks, block => block.taskId).values()];
  const anchoredPasses = EffectArray.filter(taskClusters, taskBlocks =>
    taskClusterPasses(taskBlocks, 'anchored'),
  ).length;
  const taskOnlyPasses = EffectArray.filter(taskClusters, taskBlocks =>
    taskClusterPasses(taskBlocks, 'task-only'),
  ).length;
  const noMemoryPasses = EffectArray.filter(taskClusters, taskBlocks =>
    taskClusterPasses(taskBlocks, 'no-memory'),
  ).length;
  const anchoredRegressionEvents = EffectArray.filter(
    taskClusters,
    taskBlocks => taskClusterPasses(taskBlocks, 'no-memory') && !taskClusterPasses(taskBlocks, 'anchored'),
  ).length;
  const taskOnlyRegressionEvents = EffectArray.filter(
    taskClusters,
    taskBlocks => taskClusterPasses(taskBlocks, 'no-memory') && !taskClusterPasses(taskBlocks, 'task-only'),
  ).length;
  const taskCount = taskClusters.length;
  const anchoredPassRate = rate(anchoredPasses, taskCount);
  const taskOnlyPassRate = rate(taskOnlyPasses, taskCount);
  const noMemoryPassRate = rate(noMemoryPasses, taskCount);
  const scenarioFamilies = EffectArray.map(scenarioFamilyGroups(blocks), ([scenarioFamily, familyBlocks]) => {
    const familyTaskClusters = [...groupBlocks(familyBlocks, block => block.taskId).values()];
    const familyTaskCount = familyTaskClusters.length;
    const familyAnchoredPasses = EffectArray.filter(familyTaskClusters, taskBlocks =>
      taskClusterPasses(taskBlocks, 'anchored'),
    );
    const familyTaskOnlyPasses = EffectArray.filter(familyTaskClusters, taskBlocks =>
      taskClusterPasses(taskBlocks, 'task-only'),
    );
    const familyNoMemoryPasses = EffectArray.filter(familyTaskClusters, taskBlocks =>
      taskClusterPasses(taskBlocks, 'no-memory'),
    );
    return {
      anchoredPassRate: rate(familyAnchoredPasses.length, familyTaskCount),
      anchoredRegressionEventRate: rate(
        EffectArray.filter(
          familyTaskClusters,
          taskBlocks => taskClusterPasses(taskBlocks, 'no-memory') && !taskClusterPasses(taskBlocks, 'anchored'),
        ).length,
        familyTaskCount,
      ),
      noMemoryPassRate: rate(familyNoMemoryPasses.length, familyTaskCount),
      scenarioFamily,
      taskClusters: familyTaskCount,
      taskOnlyPassRate: rate(familyTaskOnlyPasses.length, familyTaskCount),
      taskOnlyRegressionEventRate: rate(
        EffectArray.filter(
          familyTaskClusters,
          taskBlocks => taskClusterPasses(taskBlocks, 'no-memory') && !taskClusterPasses(taskBlocks, 'task-only'),
        ).length,
        familyTaskCount,
      ),
    };
  });
  return {
    anchoredMaximumScenarioFamilyRegressionEventRate: maximumOrNull(
      EffectArray.map(scenarioFamilies, family => family.anchoredRegressionEventRate),
    ),
    anchoredMinimumScenarioFamilyPassRate: minimumOrNull(
      EffectArray.map(scenarioFamilies, family => family.anchoredPassRate),
    ),
    anchoredRegressionPercentagePoints: (noMemoryPassRate - anchoredPassRate) * 100,
    anchoredRegressionEventRate: rate(anchoredRegressionEvents, taskCount),
    anchoredPassRate,
    noMemoryMinimumScenarioFamilyPassRate: minimumOrNull(
      EffectArray.map(scenarioFamilies, family => family.noMemoryPassRate),
    ),
    noMemoryPassRate,
    pairedTrials: blocks.length,
    scenarioFamilies,
    taskOnlyMaximumScenarioFamilyRegressionEventRate: maximumOrNull(
      EffectArray.map(scenarioFamilies, family => family.taskOnlyRegressionEventRate),
    ),
    taskOnlyMinimumScenarioFamilyPassRate: minimumOrNull(
      EffectArray.map(scenarioFamilies, family => family.taskOnlyPassRate),
    ),
    taskOnlyRegressionPercentagePoints: (noMemoryPassRate - taskOnlyPassRate) * 100,
    taskOnlyRegressionEventRate: rate(taskOnlyRegressionEvents, taskCount),
    taskOnlyPassRate,
  };
}

function taskClusterPasses(blocks: readonly CompleteTrialBlock[], arm: CodeMemoryLinkAgentAbArm): boolean {
  return blocks.length > 0 && EffectArray.every(blocks, block => block.arms[arm].taskPassed);
}

function hiddenTaskPassMetrics(blocks: readonly CompleteTrialBlock[]): PairedPassMetricV1 {
  const anchoredPassRate = rate(
    EffectArray.filter(blocks, block => block.arms.anchored.taskPassed).length,
    blocks.length,
  );
  const taskOnlyPassRate = rate(
    EffectArray.filter(blocks, block => block.arms['task-only'].taskPassed).length,
    blocks.length,
  );
  const noMemoryPassRate = rate(
    EffectArray.filter(blocks, block => block.arms['no-memory'].taskPassed).length,
    blocks.length,
  );
  const scenarioFamilies = binaryScenarioFamilyMetrics(blocks, trial => trial.taskPassed);
  return {
    anchoredPassRate,
    deltaPercentagePoints: (anchoredPassRate - taskOnlyPassRate) * 100,
    minimumScenarioFamilyDeltaPercentagePoints: minimumOrNull(
      EffectArray.map(scenarioFamilies, family => family.anchoredVsTaskOnlyDeltaPercentagePoints),
    ),
    noMemoryPassRate,
    pairedTrials: blocks.length,
    scenarioFamilies,
    taskOnlyPassRate,
    taskOnlyVsNoMemoryDeltaPercentagePoints: (taskOnlyPassRate - noMemoryPassRate) * 100,
    taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints: minimumOrNull(
      EffectArray.map(scenarioFamilies, family => family.taskOnlyVsNoMemoryDeltaPercentagePoints),
    ),
  };
}

function totalTaskUsageMetrics(
  blocks: readonly CompleteTrialBlock[],
): CodeMemoryLinkAgentAbResultV1['metrics']['totalTaskUsage'] {
  return {
    steps: totalTaskUsageMetric(blocks, 'steps'),
    tokens: totalTaskUsageMetric(blocks, 'tokens'),
  };
}

function totalTaskUsageMetric(
  blocks: readonly CompleteTrialBlock[],
  field: 'steps' | 'tokens',
): TotalTaskUsageMetricV1 {
  const taskOnlyMean = mean(EffectArray.map(blocks, block => block.arms['task-only'].totalTaskUsage[field]));
  const noMemoryMean = mean(EffectArray.map(blocks, block => block.arms['no-memory'].totalTaskUsage[field]));
  const scenarioFamilies = scenarioFamilyReductionMetrics(blocks, block => ({
    left: block.arms['task-only'].totalTaskUsage[field],
    right: block.arms['no-memory'].totalTaskUsage[field],
  }));
  return {
    minimumScenarioFamilyReductionPercent: minimumOrNull(
      EffectArray.map(scenarioFamilies, family => family.reductionPercent),
    ),
    noMemoryMean,
    reductionPercent: noMemoryMean === 0 ? 0 : ((noMemoryMean - taskOnlyMean) / noMemoryMean) * 100,
    scenarioFamilies,
    taskOnlyMean,
  };
}

function perClientMetrics(
  blocks: readonly CompleteTrialBlock[],
  clientIds: readonly string[],
): readonly PerClientMetricV1[] {
  return EffectArray.map(clientIds, clientId => {
    const clientBlocks = EffectArray.filter(blocks, block => block.clientId === clientId);
    const hidden = EffectArray.filter(clientBlocks, block => block.taskKind === 'hidden-constraint');
    const negative = EffectArray.filter(clientBlocks, block => block.taskKind === 'negative-control');
    const adherence = adherenceMetrics(hidden);
    const firstUse = firstUseMetrics(hidden);
    const hiddenPass = hiddenTaskPassMetrics(hidden);
    const usage = totalTaskUsageMetrics(hidden);
    const negativeControl = negativeControlMetrics(negative);
    return {
      anchoredNegativeControlPassRate: negativeControl.anchoredPassRate,
      anchoredNegativeControlRegressionPercentagePoints: negativeControl.anchoredRegressionPercentagePoints,
      anchoredFirstUseStepsReductionPercent: firstUse.steps.reductionPercent,
      anchoredFirstUseTokensReductionPercent: firstUse.tokens.reductionPercent,
      adherenceDeltaPercentagePoints: adherence.deltaPercentagePoints,
      clientId,
      hiddenTaskPassDeltaPercentagePoints: hiddenPass.deltaPercentagePoints,
      noMemoryNegativeControlPassRate: negativeControl.noMemoryPassRate,
      taskOnlyAdherenceDeltaPercentagePoints: adherence.taskOnlyVsNoMemoryDeltaPercentagePoints,
      taskOnlyHiddenTaskPassDeltaPercentagePoints: hiddenPass.taskOnlyVsNoMemoryDeltaPercentagePoints,
      taskOnlyNegativeControlRegressionPercentagePoints: negativeControl.taskOnlyRegressionPercentagePoints,
      taskOnlyNegativeControlPassRate: negativeControl.taskOnlyPassRate,
      taskOnlyTotalStepsReductionPercent: usage.steps.reductionPercent,
      taskOnlyTotalTokensReductionPercent: usage.tokens.reductionPercent,
    };
  });
}

function acceptanceMetrics(
  blocks: readonly CompleteTrialBlock[],
): CodeMemoryLinkAgentAbResultV1['metrics']['staleOrHarmfulAcceptance'] {
  const metric = (arm: CodeMemoryLinkAgentAbArm): ArmAcceptanceMetricV1 => {
    const trials = EffectArray.map(blocks, block => block.arms[arm]);
    const acceptedTrials = EffectArray.filter(
      trials,
      (trial, __effectArrayIndex) => __effectArrayIndex in trials && trial.acceptedStaleOrHarmful,
    ).length;
    return {
      acceptedTrials,
      rate: rate(acceptedTrials, trials.length),
      trials: trials.length,
    };
  };
  return {
    anchored: metric('anchored'),
    'no-memory': metric('no-memory'),
    'task-only': metric('task-only'),
  };
}

function qualityGateFailures(
  adherence: CodeMemoryLinkAgentAbResultV1['metrics']['adherence'],
  firstUse: CodeMemoryLinkAgentAbResultV1['metrics']['firstUsefulMemoryUse'],
  hiddenTaskPass: PairedPassMetricV1,
  negative: CodeMemoryLinkAgentAbResultV1['metrics']['negativeControl'],
  perClient: readonly PerClientMetricV1[],
  totalTaskUsage: CodeMemoryLinkAgentAbResultV1['metrics']['totalTaskUsage'],
  failures: string[],
): void {
  if (adherence.deltaPercentagePoints < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS) {
    failures.push(
      `anchored versus task-only adherence delta ${format(adherence.deltaPercentagePoints)} pp; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS} pp`,
    );
  }
  const anchoredOnlyFamily = EffectOption.getOrUndefined(
    EffectArray.findFirst(adherence.scenarioFamilies, family => family.scenarioFamily === 'hidden:anchored-only'),
  );
  if (
    adherence.minimumScenarioFamilyDeltaPercentagePoints === null ||
    adherence.minimumScenarioFamilyDeltaPercentagePoints < 0
  ) {
    failures.push(
      `anchored adherence minimum finite-corpus scenario-family delta ${formatNullable(adherence.minimumScenarioFamilyDeltaPercentagePoints)} pp; minimum 0 pp`,
    );
  }
  if (
    anchoredOnlyFamily === undefined ||
    anchoredOnlyFamily.anchoredVsTaskOnlyDeltaPercentagePoints <
      CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS
  ) {
    failures.push(
      `anchored-only family anchored adherence delta ${formatNullable(anchoredOnlyFamily?.anchoredVsTaskOnlyDeltaPercentagePoints ?? null)} pp; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS} pp`,
    );
  }
  if (
    adherence.taskOnlyVsNoMemoryDeltaPercentagePoints <
    CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS
  ) {
    failures.push(
      `task-only versus no-memory adherence delta ${format(adherence.taskOnlyVsNoMemoryDeltaPercentagePoints)} pp; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS} pp`,
    );
  }
  const lexicalFamily = EffectOption.getOrUndefined(
    EffectArray.findFirst(adherence.scenarioFamilies, family => family.scenarioFamily === 'hidden:lexical'),
  );
  if (
    adherence.taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints === null ||
    adherence.taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints < 0
  ) {
    failures.push(
      `task-only adherence minimum finite-corpus scenario-family delta ${formatNullable(adherence.taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints)} pp; minimum 0 pp`,
    );
  }
  if (
    lexicalFamily === undefined ||
    lexicalFamily.taskOnlyVsNoMemoryDeltaPercentagePoints <
      CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS
  ) {
    failures.push(
      `lexical family task-only adherence delta ${formatNullable(lexicalFamily?.taskOnlyVsNoMemoryDeltaPercentagePoints ?? null)} pp; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS} pp`,
    );
  }
  if (hiddenTaskPass.deltaPercentagePoints < 0) {
    failures.push(
      `anchored versus task-only hidden-task pass delta ${format(hiddenTaskPass.deltaPercentagePoints)} pp; minimum 0 pp`,
    );
  }
  if (
    hiddenTaskPass.minimumScenarioFamilyDeltaPercentagePoints === null ||
    hiddenTaskPass.minimumScenarioFamilyDeltaPercentagePoints < 0
  ) {
    failures.push(
      `anchored hidden-task pass minimum finite-corpus scenario-family delta ${formatNullable(hiddenTaskPass.minimumScenarioFamilyDeltaPercentagePoints)} pp; minimum 0 pp`,
    );
  }
  if (hiddenTaskPass.taskOnlyVsNoMemoryDeltaPercentagePoints < 0) {
    failures.push(
      `task-only versus no-memory hidden-task pass delta ${format(hiddenTaskPass.taskOnlyVsNoMemoryDeltaPercentagePoints)} pp; minimum 0 pp`,
    );
  }
  if (
    hiddenTaskPass.taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints === null ||
    hiddenTaskPass.taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints < 0
  ) {
    failures.push(
      `task-only hidden-task pass minimum finite-corpus scenario-family delta ${formatNullable(hiddenTaskPass.taskOnlyVsNoMemoryMinimumScenarioFamilyDeltaPercentagePoints)} pp; minimum 0 pp`,
    );
  }
  for (const [name, metric] of EffectRecord.toEntries(firstUse) as readonly [string, FirstUseMetricV1][]) {
    if (metric.reductionPercent < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_FIRST_USE_REDUCTION_PERCENT) {
      failures.push(
        `anchored versus task-only ${name}-to-first-use reduction ${format(metric.reductionPercent)}%; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_FIRST_USE_REDUCTION_PERCENT}%`,
      );
    }
    if (
      metric.minimumScenarioFamilyReductionPercent === null ||
      metric.minimumScenarioFamilyReductionPercent < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_FIRST_USE_REDUCTION_PERCENT
    ) {
      failures.push(
        `anchored versus task-only ${name}-to-first-use minimum finite-corpus scenario-family reduction ${formatNullable(metric.minimumScenarioFamilyReductionPercent)}%; minimum ${CODE_MEMORY_LINK_AGENT_AB_MINIMUM_FIRST_USE_REDUCTION_PERCENT}%`,
      );
    }
  }
  for (const [name, metric] of EffectRecord.toEntries(totalTaskUsage) as readonly [string, TotalTaskUsageMetricV1][]) {
    if (metric.reductionPercent < 0) {
      failures.push(
        `task-only versus no-memory total ${name} reduction ${format(metric.reductionPercent)}%; minimum 0%`,
      );
    }
    if (metric.minimumScenarioFamilyReductionPercent === null || metric.minimumScenarioFamilyReductionPercent < 0) {
      failures.push(
        `task-only versus no-memory total ${name} minimum finite-corpus scenario-family reduction ${formatNullable(metric.minimumScenarioFamilyReductionPercent)}%; minimum 0%`,
      );
    }
  }
  const absoluteNegativeControls = [
    ['anchored', negative.anchoredPassRate, negative.anchoredMinimumScenarioFamilyPassRate],
    ['task-only', negative.taskOnlyPassRate, negative.taskOnlyMinimumScenarioFamilyPassRate],
    ['no-memory', negative.noMemoryPassRate, negative.noMemoryMinimumScenarioFamilyPassRate],
  ] as const;
  for (const [arm, passRate, minimumFamilyPassRate] of absoluteNegativeControls) {
    if (passRate < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_PASS_RATE) {
      failures.push(
        `${arm} negative-control absolute pass rate ${format(passRate * 100)}%; minimum ${format(CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_PASS_RATE * 100)}%`,
      );
    }
    if (
      minimumFamilyPassRate === null ||
      minimumFamilyPassRate < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILY_PASS_RATE
    ) {
      failures.push(
        `${arm} negative-control minimum finite-corpus scenario-family pass rate ${formatNullable(minimumFamilyPassRate === null ? null : minimumFamilyPassRate * 100)}%; minimum ${format(CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILY_PASS_RATE * 100)}%`,
      );
    }
  }
  const regressionEventFamilyMaxima = [
    ['anchored', negative.anchoredRegressionEventRate, negative.anchoredMaximumScenarioFamilyRegressionEventRate],
    ['task-only', negative.taskOnlyRegressionEventRate, negative.taskOnlyMaximumScenarioFamilyRegressionEventRate],
  ] as const;
  for (const [arm, eventRate, maximumFamilyEventRate] of regressionEventFamilyMaxima) {
    if (
      maximumFamilyEventRate === null ||
      maximumFamilyEventRate > CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILY_REGRESSION_EVENT_RATE
    ) {
      failures.push(
        `${arm} versus no-memory negative-control maximum finite-corpus scenario-family regression-event rate ${formatNullable(maximumFamilyEventRate === null ? null : maximumFamilyEventRate * 100)}%; observed ${format(eventRate * 100)}%; maximum ${format(CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILY_REGRESSION_EVENT_RATE * 100)}%`,
      );
    }
  }
  if (
    negative.anchoredRegressionPercentagePoints >
    CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_REGRESSION_PERCENTAGE_POINTS
  ) {
    failures.push(
      `anchored versus no-memory negative-control regression ${format(negative.anchoredRegressionPercentagePoints)} pp; maximum ${CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_REGRESSION_PERCENTAGE_POINTS} pp`,
    );
  }
  if (
    negative.taskOnlyRegressionPercentagePoints >
    CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_REGRESSION_PERCENTAGE_POINTS
  ) {
    failures.push(
      `task-only versus no-memory negative-control regression ${format(negative.taskOnlyRegressionPercentagePoints)} pp; maximum ${CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_REGRESSION_PERCENTAGE_POINTS} pp`,
    );
  }
  for (const metric of perClient) {
    if (metric.anchoredNegativeControlPassRate < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_PASS_RATE) {
      failures.push(`client ${metric.clientId} anchored negative-control absolute pass rate is below minimum`);
    }
    if (metric.taskOnlyNegativeControlPassRate < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_PASS_RATE) {
      failures.push(`client ${metric.clientId} task-only negative-control absolute pass rate is below minimum`);
    }
    if (metric.noMemoryNegativeControlPassRate < CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_PASS_RATE) {
      failures.push(`client ${metric.clientId} no-memory negative-control absolute pass rate is below minimum`);
    }
    if (metric.adherenceDeltaPercentagePoints < 0) {
      failures.push(`client ${metric.clientId} anchored adherence regressed against task-only`);
    }
    if (metric.hiddenTaskPassDeltaPercentagePoints < 0) {
      failures.push(`client ${metric.clientId} anchored hidden-task pass regressed against task-only`);
    }
    if (metric.anchoredFirstUseTokensReductionPercent < 0) {
      failures.push(`client ${metric.clientId} anchored tokens-to-first-use regressed against task-only`);
    }
    if (metric.anchoredFirstUseStepsReductionPercent < 0) {
      failures.push(`client ${metric.clientId} anchored steps-to-first-use regressed against task-only`);
    }
    if (metric.taskOnlyAdherenceDeltaPercentagePoints < 0) {
      failures.push(`client ${metric.clientId} task-only adherence regressed against no-memory`);
    }
    if (metric.taskOnlyHiddenTaskPassDeltaPercentagePoints < 0) {
      failures.push(`client ${metric.clientId} task-only hidden-task pass regressed against no-memory`);
    }
    if (metric.taskOnlyTotalTokensReductionPercent < 0) {
      failures.push(`client ${metric.clientId} task-only total tokens regressed against no-memory`);
    }
    if (metric.taskOnlyTotalStepsReductionPercent < 0) {
      failures.push(`client ${metric.clientId} task-only total steps regressed against no-memory`);
    }
    if (
      metric.anchoredNegativeControlRegressionPercentagePoints >
      CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_REGRESSION_PERCENTAGE_POINTS
    ) {
      failures.push(`client ${metric.clientId} anchored negative-control pass regressed against no-memory`);
    }
    if (
      metric.taskOnlyNegativeControlRegressionPercentagePoints >
      CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_REGRESSION_PERCENTAGE_POINTS
    ) {
      failures.push(`client ${metric.clientId} task-only negative-control pass regressed against no-memory`);
    }
  }
}

function monotoneSafetyFailures(
  trials: readonly CodeMemoryLinkAgentAbTrialV1[],
  assignment: CodeMemoryLinkAgentAbAssignmentV1,
): string[] {
  const anchored = EffectArray.filter(trials, trial => assignment.labels[trial.blindLabel] === 'anchored');
  const taskOnly = EffectArray.filter(trials, trial => assignment.labels[trial.blindLabel] === 'task-only');
  const anchoredHarmful = EffectArray.filter(
    anchored,
    __effectArrayValue => !!(trial => trial.acceptedStaleOrHarmful)(__effectArrayValue),
  ).length;
  const taskOnlyHarmful = EffectArray.filter(
    taskOnly,
    __effectArrayValue => !!(trial => trial.acceptedStaleOrHarmful)(__effectArrayValue),
  ).length;
  const hiddenFailures = EffectArray.filter(
    anchored,
    trial => trial.taskKind === 'hidden-constraint' && !trial.taskPassed,
  ).length;
  const anchoredWithoutUsefulMemory = EffectArray.filter(
    anchored,
    trial => trial.taskKind === 'hidden-constraint' && trial.firstUsefulMemoryUse === null,
  ).length;
  const failures: string[] = [];
  if (anchoredHarmful > 0) failures.push(`anchored stale/harmful acceptance ${anchoredHarmful}; required 0`);
  if (taskOnlyHarmful > 0) failures.push(`task-only stale/harmful acceptance ${taskOnlyHarmful}; required 0`);
  if (hiddenFailures > 0) failures.push(`anchored hidden-task failures ${hiddenFailures}; required 0`);
  if (anchoredWithoutUsefulMemory > 0) {
    failures.push(
      `anchored hidden trials without adjudicated useful memory ${anchoredWithoutUsefulMemory}; required 0`,
    );
  }
  return failures;
}

function parseLabels(value: unknown): Readonly<Record<CodeMemoryLinkAgentAbBlindLabel, CodeMemoryLinkAgentAbArm>> {
  const labels = record(value, 'assignment labels');
  exactKeys(labels, CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS, 'assignment labels');
  const parsed = {
    X: literal(labels.X, CODE_MEMORY_LINK_AGENT_AB_ARMS, 'assignment label X'),
    Y: literal(labels.Y, CODE_MEMORY_LINK_AGENT_AB_ARMS, 'assignment label Y'),
    Z: literal(labels.Z, CODE_MEMORY_LINK_AGENT_AB_ARMS, 'assignment label Z'),
  };
  if (new Set(EffectRecord.values(parsed)).size !== CODE_MEMORY_LINK_AGENT_AB_ARMS.length) {
    invalid('assignment labels must map bijectively to all three arms');
  }
  return parsed;
}

function parseCandidate(value: unknown): CodeMemoryLinkAgentAbManifestV1['candidate'] {
  const candidate = record(value, 'manifest candidate');
  exactKeys(candidate, ['buildIdentityHash', 'commit', 'dirty'], 'manifest candidate');
  if (candidate.dirty !== false) invalid('manifest candidate must identify a clean build');
  return {
    buildIdentityHash: matchingString(candidate.buildIdentityHash, HASH, 'candidate build identity hash'),
    commit: matchingString(candidate.commit, COMMIT, 'candidate commit'),
    dirty: false,
  };
}

function parseManifestClients(value: unknown): readonly CodeMemoryLinkAgentAbManifestClientV1[] {
  if (!EffectArray.isArray(value)) invalid('manifest clients must be an array');
  if (value.length === 0 || value.length > CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_CLIENTS) {
    invalid(`manifest client roster must contain 1-${CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_CLIENTS} opaque ids`);
  }
  const parsed = EffectArray.map(value, entry => {
    const client = record(entry, 'manifest client');
    exactKeys(
      client,
      [
        'clientId',
        'configurationProjectionHash',
        'environmentPolicyHash',
        'executionBundleHash',
        'expectedClient',
        'implementationDescriptorHash',
      ],
      'manifest client',
    );
    return {
      clientId: matchingString(client.clientId, CLIENT_ID, 'manifest client id'),
      configurationProjectionHash: matchingString(
        client.configurationProjectionHash,
        HASH,
        'client configuration projection hash',
      ),
      environmentPolicyHash: matchingString(client.environmentPolicyHash, HASH, 'client environment policy hash'),
      executionBundleHash: matchingString(client.executionBundleHash, HASH, 'client execution bundle hash'),
      expectedClient: parseCodeMemoryLinkExpectedCodexClientV1(client.expectedClient),
      implementationDescriptorHash: matchingString(
        client.implementationDescriptorHash,
        HASH,
        'client implementation descriptor hash',
      ),
    };
  });
  assertUnique(
    EffectArray.map(parsed, client => client.clientId),
    'manifest client ids',
  );
  assertUnique(
    EffectArray.map(parsed, client => client.implementationDescriptorHash),
    'client implementation descriptor hashes',
  );
  assertCanonicalOrder(
    EffectArray.map(parsed, client => client.clientId),
    'manifest clients',
  );
  return parsed;
}

function parseSchedule(
  value: unknown,
  clients: readonly CodeMemoryLinkAgentAbManifestClientV1[],
  tasks: readonly CodeMemoryLinkAgentAbManifestTaskV1[],
  scheduleAlgorithmVersion: typeof CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION,
  scheduleSeed: string,
): readonly CodeMemoryLinkAgentAbScheduleEntryV1[] {
  if (!EffectArray.isArray(value)) invalid('manifest schedule must be an array');
  const expectedLength = clients.length * tasks.length * CODE_MEMORY_LINK_AGENT_AB_ARMS.length;
  if (value.length !== expectedLength) invalid(`manifest schedule must contain exactly ${expectedLength} runs`);
  const entries = EffectArray.map(value, parseScheduleEntry);
  const clientIds = new Set(EffectArray.map(clients, client => client.clientId));
  const taskIds = new Set(EffectArray.map(tasks, task => task.taskId));
  for (const entry of entries) {
    if (!clientIds.has(entry.clientId)) invalid('manifest schedule contains a client outside the roster');
    if (!taskIds.has(entry.taskId)) invalid('manifest schedule contains a task outside the roster');
  }
  assertUnique(
    EffectArray.map(entries, entry => entry.runNonce),
    'manifest schedule run nonces',
  );
  assertUnique(
    EffectArray.map(entries, entry => entry.runOrder.toString()),
    'manifest schedule run order',
  );
  assertUnique(
    EffectArray.map(entries, entry => scheduleKey(entry.clientId, entry.taskId, entry.blindLabel)),
    'manifest schedule client/task/arm runs',
  );
  if (EffectArray.some(entries, (entry, index) => entry.runOrder !== index)) {
    invalid('manifest schedule must be canonically ordered with contiguous zero-based run order');
  }
  validateScheduleBlocks(entries, clients, tasks);
  validateBalancedArmPositions(entries, clients, tasks);
  scheduleAlgorithmVersionValue(scheduleAlgorithmVersion);
  const expected = deriveValidatedSchedule(clients, tasks, scheduleSeed);
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    invalid('manifest schedule does not match the frozen seeded derivation');
  }
  return entries;
}

function deriveValidatedSchedule(
  clients: readonly CodeMemoryLinkAgentAbManifestClientV1[],
  tasks: readonly CodeMemoryLinkAgentAbManifestTaskV1[],
  scheduleSeed: string,
): readonly CodeMemoryLinkAgentAbScheduleEntryV1[] {
  const scheduledBlocks = EffectArray.flatMap(clients, client =>
    EffectArray.flatMap(TASK_KINDS, taskKind => {
      const stratum = EffectArray.map(
        EffectArray.filter(tasks, task => task.taskKind === taskKind),
        task => ({
          clientId: client.clientId,
          order: sha256HexSync(`${scheduleSeed}\0task-order\0${client.clientId}\0${taskKind}\0${task.taskId}`),
          task,
        }),
      ).sort(
        (left, right) => compareStrings(left.order, right.order) || compareStrings(left.task.taskId, right.task.taskId),
      );
      const offset = schedulePermutationOffset(scheduleSeed, client.clientId, taskKind);
      return EffectArray.map(stratum, (block, index) => ({
        ...block,
        permutation: BALANCED_BLIND_LABEL_PERMUTATIONS[(index + offset) % BALANCED_BLIND_LABEL_PERMUTATIONS.length],
      }));
    }),
  );
  const orderedBlocks = scheduledBlocks.sort(
    (left, right) =>
      compareStrings(
        sha256HexSync(`${scheduleSeed}\0block-order\0${left.clientId}\0${left.task.taskId}`),
        sha256HexSync(`${scheduleSeed}\0block-order\0${right.clientId}\0${right.task.taskId}`),
      ) || compareStrings(`${left.clientId}\0${left.task.taskId}`, `${right.clientId}\0${right.task.taskId}`),
  );
  return EffectArray.flatMap(orderedBlocks, (block, blockIndex) =>
    EffectArray.map(block.permutation, (blindLabel, positionIndex) => {
      const runOrder = blockIndex * CODE_MEMORY_LINK_AGENT_AB_ARMS.length + positionIndex;
      return {
        armPosition: armPosition(positionIndex + 1),
        blindLabel,
        clientId: block.clientId,
        runNonce: `run_${sha256HexSync(`${scheduleSeed}\0run\0${block.clientId}\0${block.task.taskId}\0${blindLabel}`)}`,
        runOrder,
        taskId: block.task.taskId,
      };
    }),
  );
}

function schedulePermutationOffset(
  scheduleSeed: string,
  clientId: string,
  taskKind: CodeMemoryLinkAgentAbManifestTaskV1['taskKind'],
): number {
  const digest = sha256HexSync(`${scheduleSeed}\0permutation-offset\0${clientId}\0${taskKind}`);
  // Either balanced Latin-square half may lead; every prefix then differs by at most one position per label.
  return (Number.parseInt(Effect.pipe(digest, EffectString.slice(0, 8)), 16) % 2) * 3;
}

function parseScheduleEntry(value: unknown): CodeMemoryLinkAgentAbScheduleEntryV1 {
  const entry = record(value, 'manifest schedule entry');
  exactKeys(
    entry,
    ['armPosition', 'blindLabel', 'clientId', 'runNonce', 'runOrder', 'taskId'],
    'manifest schedule entry',
  );
  return {
    armPosition: armPosition(entry.armPosition),
    blindLabel: literal(entry.blindLabel, CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS, 'schedule blind label'),
    clientId: matchingString(entry.clientId, CLIENT_ID, 'schedule client id'),
    runNonce: matchingString(entry.runNonce, RUN_NONCE, 'schedule run nonce'),
    runOrder: nonNegativeInteger(entry.runOrder, 'schedule run order'),
    taskId: matchingString(entry.taskId, TASK_ID, 'schedule task id'),
  };
}

function validateScheduleBlocks(
  entries: readonly CodeMemoryLinkAgentAbScheduleEntryV1[],
  clients: readonly CodeMemoryLinkAgentAbManifestClientV1[],
  tasks: readonly CodeMemoryLinkAgentAbManifestTaskV1[],
): void {
  for (const {clientId} of clients) {
    for (const task of tasks) {
      const block = EffectArray.filter(entries, entry => entry.clientId === clientId && entry.taskId === task.taskId);
      if (
        block.length !== CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS.length ||
        new Set(EffectArray.map(block, entry => entry.blindLabel)).size !==
          CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS.length ||
        new Set(EffectArray.map(block, entry => entry.armPosition)).size !==
          CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS.length
      ) {
        invalid(`manifest schedule block ${clientId}/${task.taskId} must contain each blind arm and position once`);
      }
      const chronologicalPositions = EffectArray.map(
        [...block].sort((left, right) => left.runOrder - right.runOrder),
        entry => entry.armPosition,
      );
      if (EffectArray.some(chronologicalPositions, (position, index) => position !== index + 1)) {
        invalid(`manifest schedule block ${clientId}/${task.taskId} chronological order must match arm positions 1-3`);
      }
    }
  }
}

function validateBalancedArmPositions(
  entries: readonly CodeMemoryLinkAgentAbScheduleEntryV1[],
  clients: readonly CodeMemoryLinkAgentAbManifestClientV1[],
  tasks: readonly CodeMemoryLinkAgentAbManifestTaskV1[],
): void {
  for (const {clientId} of clients) {
    for (const taskKind of TASK_KINDS) {
      const taskIds = new Set(
        EffectArray.map(
          EffectArray.filter(tasks, task => task.taskKind === taskKind),
          task => task.taskId,
        ),
      );
      for (const blindLabel of CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS) {
        const counts = EffectArray.map(
          [1, 2, 3],
          position =>
            EffectArray.filter(
              entries,
              (entry, __effectArrayIndex) =>
                __effectArrayIndex in entries &&
                entry.clientId === clientId &&
                taskIds.has(entry.taskId) &&
                entry.blindLabel === blindLabel &&
                entry.armPosition === position,
            ).length,
        );
        if (Math.max(...counts) - Math.min(...counts) > 1) {
          invalid(`manifest schedule arm positions are not counterbalanced for client ${clientId}/${taskKind}`);
        }
      }
    }
  }
}

function parseManifestTasks(value: unknown): readonly CodeMemoryLinkAgentAbManifestTaskV1[] {
  if (!EffectArray.isArray(value)) invalid('manifest tasks must be an array');
  if (value.length === 0 || value.length > CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_TASKS) {
    invalid(`manifest task roster must contain 1-${CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_TASKS} tasks`);
  }
  const tasks = EffectArray.map(value, parseManifestTask);
  assertUnique(
    EffectArray.map(tasks, task => task.taskId),
    'manifest task ids',
  );
  assertUnique(
    EffectArray.map(tasks, task => task.packetHash),
    'manifest task packet hashes',
  );
  assertUnique(
    EffectArray.map(tasks, task =>
      JSON.stringify({
        budget: task.budget,
        constraintTotal: task.constraintTotal,
        packetHash: task.packetHash,
        rubricHash: task.rubricHash,
        scenarioFamily: task.scenarioFamily,
        taskKind: task.taskKind,
      }),
    ),
    'manifest task contracts',
  );
  assertCanonicalOrder(
    EffectArray.map(tasks, task => task.taskId),
    'manifest tasks',
  );
  const hiddenBudgets = new Set(
    EffectArray.map(
      EffectArray.filter(tasks, task => task.taskKind === 'hidden-constraint'),
      task => JSON.stringify(task.budget),
    ),
  );
  if (hiddenBudgets.size > 1) invalid('manifest hidden-constraint tasks must share one token and step budget');
  return tasks;
}

function parseManifestTask(value: unknown): CodeMemoryLinkAgentAbManifestTaskV1 {
  const task = record(value, 'manifest task');
  exactKeys(
    task,
    [
      'budget',
      'constraintTotal',
      'expectedResponseHashes',
      'packetHash',
      'rubricHash',
      'scenarioFamily',
      'taskId',
      'taskKind',
    ],
    'manifest task',
  );
  const expectedResponseHashes = record(task.expectedResponseHashes, 'manifest task expected response hashes');
  exactKeys(expectedResponseHashes, ['anchored', 'noMemory', 'taskOnly'], 'manifest task expected response hashes');
  const taskKind = literal(task.taskKind, ['hidden-constraint', 'negative-control'] as const, 'manifest task kind');
  const scenarioFamily = parseScenarioFamily(task.scenarioFamily, taskKind);
  const constraintTotal = nonNegativeInteger(task.constraintTotal, 'manifest constraint total');
  if (taskKind === 'hidden-constraint' && constraintTotal === 0)
    invalid('hidden-constraint manifest tasks require at least one constraint');
  if (taskKind === 'negative-control' && constraintTotal !== 0)
    invalid('negative-control manifest tasks must not contain hidden constraints');
  return {
    budget: parseBudget(task.budget),
    constraintTotal,
    expectedResponseHashes: {
      anchored: matchingString(expectedResponseHashes.anchored, HASH, 'anchored expected response hash'),
      noMemory: matchingString(expectedResponseHashes.noMemory, HASH, 'no-memory expected response hash'),
      taskOnly: matchingString(expectedResponseHashes.taskOnly, HASH, 'task-only expected response hash'),
    },
    packetHash: matchingString(task.packetHash, HASH, 'manifest packet hash'),
    rubricHash: matchingString(task.rubricHash, HASH, 'manifest rubric hash'),
    scenarioFamily,
    taskId: matchingString(task.taskId, TASK_ID, 'manifest task id'),
    taskKind,
  };
}

function parseScenarioFamily(
  value: unknown,
  taskKind: CodeMemoryLinkAgentAbManifestTaskV1['taskKind'],
): CodeMemoryLinkAgentAbScenarioFamily {
  if (taskKind === 'hidden-constraint') {
    return literal(value, ['hidden:anchored-only', 'hidden:lexical'] as const, 'hidden scenario family');
  }
  if (!isControlScenarioFamily(value)) {
    invalid('negative-control scenario family is invalid');
  }
  return value;
}
function isControlScenarioFamily(value: unknown): value is `control:${string}` {
  return typeof value === 'string' && CONTROL_SCENARIO_FAMILY.test(value);
}

function validateTrialTaskContract(
  trial: CodeMemoryLinkAgentAbTrialV1,
  task: CodeMemoryLinkAgentAbManifestTaskV1,
): void {
  if (
    trial.packetHash !== task.packetHash ||
    trial.rubricHash !== task.rubricHash ||
    trial.taskKind !== task.taskKind ||
    trial.constraintAdherence.total !== task.constraintTotal ||
    trial.budget.tokens !== task.budget.tokens ||
    trial.budget.steps !== task.budget.steps
  ) {
    invalid(`trial ${trial.trialId} task contract does not match the manifest roster`);
  }
}

function validateTrialSchedule(
  trial: CodeMemoryLinkAgentAbTrialV1,
  scheduled: CodeMemoryLinkAgentAbScheduleEntryV1,
): void {
  if (
    trial.armPosition !== scheduled.armPosition ||
    trial.runNonce !== scheduled.runNonce ||
    trial.runOrder !== scheduled.runOrder
  ) {
    invalid(`trial ${trial.trialId} does not match its preregistered run position and nonce`);
  }
}

function parseBudget(value: unknown): CodeMemoryLinkAgentAbTrialV1['budget'] {
  const budget = record(value, 'trial budget');
  exactKeys(budget, ['steps', 'tokens'], 'trial budget');
  return {
    steps: positiveInteger(budget.steps, 'step budget'),
    tokens: positiveInteger(budget.tokens, 'token budget'),
  };
}

function parseTotalTaskUsage(
  value: unknown,
  budget: CodeMemoryLinkAgentAbTrialV1['budget'],
): CodeMemoryLinkAgentAbTrialV1['totalTaskUsage'] {
  const usage = record(value, 'total task usage');
  exactKeys(usage, ['steps', 'tokens'], 'total task usage');
  const parsed = {
    steps: positiveInteger(usage.steps, 'total task steps'),
    tokens: positiveInteger(usage.tokens, 'total task tokens'),
  };
  if (parsed.tokens > budget.tokens || parsed.steps > budget.steps) {
    invalid('total task usage exceeds the trial budget');
  }
  return parsed;
}

function parseConstraintAdherence(
  value: unknown,
  taskKind: CodeMemoryLinkAgentAbTrialV1['taskKind'],
): CodeMemoryLinkAgentAbTrialV1['constraintAdherence'] {
  const adherence = record(value, 'constraint adherence');
  exactKeys(adherence, ['satisfied', 'total'], 'constraint adherence');
  const total = nonNegativeInteger(adherence.total, 'constraint total');
  const satisfied = nonNegativeInteger(adherence.satisfied, 'constraints satisfied');
  if (satisfied > total) invalid('constraints satisfied cannot exceed the total');
  if (taskKind === 'hidden-constraint' && total === 0)
    invalid('hidden-constraint tasks require at least one constraint');
  if (taskKind === 'negative-control' && (total !== 0 || satisfied !== 0)) {
    invalid('negative-control tasks must not contain hidden constraints');
  }
  return {satisfied, total};
}

function parseFirstUse(
  value: unknown,
  totalTaskUsage: CodeMemoryLinkAgentAbTrialV1['totalTaskUsage'],
): CodeMemoryLinkAgentAbTrialV1['firstUsefulMemoryUse'] {
  if (value === null) return null;
  const firstUse = record(value, 'first useful memory use');
  exactKeys(firstUse, ['steps', 'tokens'], 'first useful memory use');
  const parsed = {
    steps: positiveInteger(firstUse.steps, 'first-use steps'),
    tokens: nonNegativeInteger(firstUse.tokens, 'first-use tokens'),
  };
  if (parsed.tokens > totalTaskUsage.tokens || parsed.steps > totalTaskUsage.steps) {
    invalid('first useful memory use exceeds observed total task usage');
  }
  return parsed;
}

function firstUseOrObservedCensor(trial: CodeMemoryLinkAgentAbTrialV1, field: 'steps' | 'tokens'): number {
  return trial.firstUsefulMemoryUse?.[field] ?? trial.totalTaskUsage[field];
}

function allConstraintsSatisfied(trial: CodeMemoryLinkAgentAbTrialV1): boolean {
  return trial.constraintAdherence.satisfied === trial.constraintAdherence.total;
}

function groupBlocks<Key extends string>(
  blocks: readonly CompleteTrialBlock[],
  keyFor: (block: CompleteTrialBlock) => Key,
): ReadonlyMap<Key, readonly CompleteTrialBlock[]> {
  const grouped = new Map<Key, CompleteTrialBlock[]>();
  for (const block of blocks) {
    const key = keyFor(block);
    grouped.set(key, [...(grouped.get(key) ?? []), block]);
  }
  return grouped;
}

function scenarioFamilyGroups(
  blocks: readonly CompleteTrialBlock[],
): readonly (readonly [CodeMemoryLinkAgentAbScenarioFamily, readonly CompleteTrialBlock[]])[] {
  return EffectArray.map(
    [...groupBlocks(blocks, block => block.scenarioFamily).entries()].sort(([left], [right]) =>
      compareStrings(left, right),
    ),
    ([scenarioFamily, familyBlocks]) => [scenarioFamily, familyBlocks],
  );
}

function compareTrialsCanonically(left: CodeMemoryLinkAgentAbTrialV1, right: CodeMemoryLinkAgentAbTrialV1): number {
  return left.runOrder - right.runOrder || compareStrings(left.trialId, right.trialId);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scheduleKey(clientId: string, taskId: string, blindLabel: CodeMemoryLinkAgentAbBlindLabel): string {
  return `${clientId}\0${taskId}\0${blindLabel}`;
}

function scheduleAlgorithmVersionValue(value: unknown): typeof CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION {
  if (value !== CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION) {
    invalid(`manifest schedule algorithm must be ${CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION}`);
  }
  return CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION;
}

function displayKey(value: string): string {
  return Effect.pipe(value, EffectString.replaceAll('\0', '/'));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : EffectArray.reduce(values, 0, (total, value) => total + value) / values.length;
}

function minimumOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

function maximumOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function format(value: number): string {
  return value.toFixed(3);
}

function formatNullable(value: number | null): string {
  return value === null ? 'unavailable' : format(value);
}

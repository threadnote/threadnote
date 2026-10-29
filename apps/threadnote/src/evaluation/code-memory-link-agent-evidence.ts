import {Array as EffectArray, Option as EffectOption} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {parseCodeMemoryLinkAgentAbClientTrialSummaryV1} from './code-memory-link-agent-ab.js';
import type {
  CodeMemoryLinkAgentAbAssignmentV1,
  CodeMemoryLinkAgentAbClientTrialSummaryV1,
  CodeMemoryLinkAgentAbManifestV1,
  CodeMemoryLinkAgentAbTrialV1,
} from './code-memory-link-agent-ab.js';
import {deriveCodeMemoryLinkCodexAppServerProjectionV1} from './code-memory-link-agent-protocol.js';
import {codeMemoryLinkClientProjectionHash} from './code-memory-link-client-descriptor.js';
import {Predicate} from 'effect';
import {
  codeMemoryLinkCodexInvocationNonceDigestV1,
  parseCodeMemoryLinkCodexRawEvidenceV1,
  type CodeMemoryLinkCodexRawEvidenceV1,
} from './code-memory-link-codex-evidence.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_AGENT_EVIDENCE_VERSION = 1 as const;

export interface CodeMemoryLinkAgentClientOutputV1 {
  readonly rawEvidence: CodeMemoryLinkCodexRawEvidenceV1;
  readonly trial: CodeMemoryLinkAgentAbClientTrialSummaryV1;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_EVIDENCE_VERSION;
}

export interface CodeMemoryLinkAgentEvidenceReceiptV1 {
  readonly previousEvidenceDigest: string | null;
  readonly rawEvidence: CodeMemoryLinkCodexRawEvidenceV1;
  readonly trialId: string;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_EVIDENCE_VERSION;
}

const HASH = /^[0-9a-f]{64}$/u;
const TRIAL_ID = /^trl_[0-9a-f]{16,64}$/u;
const MAXIMUM_EVIDENCE_JSONL_BYTES = 128 * 1_024 * 1_024;

/** Parse the exact stdout envelope while leaving the client summary to the harness-owned trial sealer. */
export function parseCodeMemoryLinkAgentClientOutputV1(value: unknown): CodeMemoryLinkAgentClientOutputV1 {
  const output = record(value, 'client output');
  exactKeys(output, ['rawEvidence', 'trial', 'version'], 'client output');
  if (output.version !== CODE_MEMORY_LINK_AGENT_EVIDENCE_VERSION) invalid('client output version must be 1');
  return {
    rawEvidence: parseCodeMemoryLinkCodexRawEvidenceV1(output.rawEvidence),
    trial: parseCodeMemoryLinkAgentAbClientTrialSummaryV1(output.trial),
    version: CODE_MEMORY_LINK_AGENT_EVIDENCE_VERSION,
  };
}

export function createCodeMemoryLinkAgentEvidenceReceiptV1(input: {
  readonly previousEvidenceDigest: string | null;
  readonly rawEvidence: unknown;
  readonly trialId: string;
}): CodeMemoryLinkAgentEvidenceReceiptV1 {
  return parseCodeMemoryLinkAgentEvidenceReceiptV1({
    previousEvidenceDigest: input.previousEvidenceDigest,
    rawEvidence: input.rawEvidence,
    trialId: input.trialId,
    version: CODE_MEMORY_LINK_AGENT_EVIDENCE_VERSION,
  });
}

export function parseCodeMemoryLinkAgentEvidenceReceiptV1(value: unknown): CodeMemoryLinkAgentEvidenceReceiptV1 {
  const receipt = record(value, 'evidence receipt');
  exactKeys(receipt, ['previousEvidenceDigest', 'rawEvidence', 'trialId', 'version'], 'evidence receipt');
  if (receipt.version !== CODE_MEMORY_LINK_AGENT_EVIDENCE_VERSION) invalid('evidence receipt version must be 1');
  return {
    previousEvidenceDigest:
      receipt.previousEvidenceDigest === null
        ? null
        : matching(receipt.previousEvidenceDigest, HASH, 'previous evidence digest'),
    rawEvidence: parseCodeMemoryLinkCodexRawEvidenceV1(receipt.rawEvidence),
    trialId: matching(receipt.trialId, TRIAL_ID, 'evidence trial id'),
    version: CODE_MEMORY_LINK_AGENT_EVIDENCE_VERSION,
  };
}

export function codeMemoryLinkAgentEvidenceReceiptDigest(value: unknown): string {
  return sha256HexSync(`${JSON.stringify(parseCodeMemoryLinkAgentEvidenceReceiptV1(value))}\n`);
}

export function parseCodeMemoryLinkAgentEvidenceJsonl(input: string): readonly CodeMemoryLinkAgentEvidenceReceiptV1[] {
  if (new TextEncoder().encode(input).byteLength > MAXIMUM_EVIDENCE_JSONL_BYTES) {
    invalid('evidence JSONL input exceeds 128 MiB');
  }
  return EffectArray.flatMap(Effect.pipe(input, EffectString.split(/\r?\n/u)), (line, index) => {
    if (!Effect.pipe(line, EffectString.trim)) return [];
    try {
      return [parseCodeMemoryLinkAgentEvidenceReceiptV1(JSON.parse(line) as unknown)];
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Invalid Code Memory Link evidence JSONL line ${index + 1}: ${detail}`, {cause});
    }
  });
}

export function serializeCodeMemoryLinkAgentEvidenceJsonl(
  receipts: readonly CodeMemoryLinkAgentEvidenceReceiptV1[],
): string {
  return receipts.length === 0
    ? ''
    : `${EffectArray.join(
        EffectArray.map(receipts, receipt => JSON.stringify(receipt)),
        '\n',
      )}\n`;
}

/**
 * Replay every retained outcome from normalized app-server and synthetic-artifact evidence, then bind it to the
 * harness-owned receipt identity, exact manifest roster, blind assignment, and append-only evidence chain.
 */
export function assertCodeMemoryLinkAgentEvidenceLedgerV1(input: {
  readonly assignment: CodeMemoryLinkAgentAbAssignmentV1;
  readonly evidence: readonly unknown[];
  readonly manifest: CodeMemoryLinkAgentAbManifestV1;
  readonly trials: readonly CodeMemoryLinkAgentAbTrialV1[];
}): readonly CodeMemoryLinkAgentEvidenceReceiptV1[] {
  const receipts = EffectArray.map(input.evidence, parseCodeMemoryLinkAgentEvidenceReceiptV1);
  if (receipts.length !== input.trials.length) invalid('evidence ledger must contain exactly one receipt per trial');
  const evidenceHashes = new Set<string>();
  const appServerEvidenceHashes = new Set<string>();
  const runBindingHashes = new Set<string>();
  let previousEvidenceDigest: string | null = null;

  for (const [index, trial] of input.trials.entries()) {
    const receipt = receipts[index];
    const raw = receipt.rawEvidence;
    const binding = raw.bindings;
    const task = EffectOption.getOrUndefined(
      EffectArray.findFirst(input.manifest.tasks, candidate => candidate.taskId === trial.taskId),
    );
    const client = EffectOption.getOrUndefined(
      EffectArray.findFirst(input.manifest.clients, candidate => candidate.clientId === trial.clientId),
    );
    if (!task || !client) invalid(`evidence receipt ${index} is outside the manifest roster`);
    const expectedClientProjectionHash = codeMemoryLinkClientProjectionHash('expected-client', {
      appServerVersion: client.expectedClient.appServerVersion,
      model: client.expectedClient.model,
      modelProvider: client.expectedClient.modelProvider,
      proxyTool: raw.clientProtocol.proxyTool,
      reasoningEffort: client.expectedClient.reasoningEffort,
    });
    if (
      raw.clientProtocol.configurationProjectionHash !== client.configurationProjectionHash ||
      raw.clientProtocol.environmentPolicyHash !== client.environmentPolicyHash ||
      raw.clientProtocol.executionBundleHash !== client.executionBundleHash ||
      raw.clientProtocol.expectedClientProjectionHash !== expectedClientProjectionHash ||
      JSON.stringify(raw.clientProtocol.expectedClient) !== JSON.stringify(client.expectedClient)
    ) {
      invalid(`evidence receipt ${index} differs from the manifest client identity projection`);
    }
    if (receipt.previousEvidenceDigest !== previousEvidenceDigest) {
      invalid(`evidence receipt ${index} does not extend the previous evidence digest`);
    }
    if (receipt.trialId !== trial.trialId) invalid(`evidence receipt ${index} names another trial`);
    if (trial.evidenceKind !== 'external-agent') invalid('retained evidence may bind only external-agent trials');
    if (binding.arm !== input.assignment.labels[trial.blindLabel]) {
      invalid(`evidence receipt ${index} uses the wrong private arm assignment`);
    }
    if (
      binding.approvalCommit !== trial.approvalCommit ||
      binding.armPosition !== trial.armPosition ||
      binding.assignmentHash !== trial.assignmentHash ||
      binding.blindLabel !== trial.blindLabel ||
      binding.budget.steps !== trial.budget.steps ||
      binding.budget.tokens !== trial.budget.tokens ||
      binding.candidateCommit !== input.manifest.candidate.commit ||
      binding.candidateExecutableSha256 !== input.manifest.candidate.buildIdentityHash ||
      binding.clientDescriptorHash !== client.implementationDescriptorHash ||
      binding.clientId !== trial.clientId ||
      binding.fixtureHash !== trial.fixtureHash ||
      binding.invocationNonceDigest !== codeMemoryLinkCodexInvocationNonceDigestV1(trial.attestation.invocationNonce) ||
      binding.manifestHash !== trial.manifestHash ||
      binding.packetHash !== trial.packetHash ||
      binding.rubricHash !== trial.rubricHash ||
      binding.runNonce !== trial.runNonce ||
      binding.runOrder !== trial.runOrder ||
      binding.suiteHash !== input.manifest.suiteHash ||
      binding.taskId !== trial.taskId ||
      binding.taskKind !== trial.taskKind
    ) {
      invalid(`evidence receipt ${index} does not match its exact harness, candidate, client, or task binding`);
    }
    if (
      task.packetHash !== trial.packetHash ||
      task.rubricHash !== trial.rubricHash ||
      task.taskKind !== trial.taskKind ||
      task.constraintTotal !== trial.constraintAdherence.total
    ) {
      invalid(`evidence receipt ${index} differs from the manifest task contract`);
    }
    if (
      EffectArray.some(
        raw.rubric.goldCitationDigests,
        digest => !raw.graphPreflight.observedCitationDigests.includes(digest),
      )
    ) {
      invalid(`evidence receipt ${index} graph preflight omitted a gold citation`);
    }
    const contextCalls = EffectArray.filter(
      raw.appServer.checkpoints,
      checkpoint => checkpoint.method === 'item/completed' && checkpoint.itemType === 'mcpToolCall',
    );
    const expectedResponseHash =
      binding.arm === 'anchored'
        ? task.expectedResponseHashes.anchored
        : binding.arm === 'task-only'
          ? task.expectedResponseHashes.taskOnly
          : task.expectedResponseHashes.noMemory;
    if (contextCalls.length !== 1 || contextCalls[0].proxyReceipt?.responseHash !== expectedResponseHash) {
      invalid(`evidence receipt ${index} model-visible response differs from the preregistered arm projection`);
    }

    const projection = deriveCodeMemoryLinkCodexAppServerProjectionV1({
      evidence: raw.appServer,
      rubric: raw.rubric,
    });
    if (
      projection.acceptedStaleOrHarmful !== trial.acceptedStaleOrHarmful ||
      projection.adjudicationHash !== trial.adjudicationHash ||
      projection.constraintAdherence.satisfied !== trial.constraintAdherence.satisfied ||
      projection.constraintAdherence.total !== trial.constraintAdherence.total ||
      !sameUsage(projection.firstUsefulMemoryUse, trial.firstUsefulMemoryUse) ||
      projection.providerUsageHash !== trial.providerUsageHash ||
      projection.taskPassed !== trial.taskPassed ||
      !sameUsage(projection.totalTaskUsage, trial.totalTaskUsage) ||
      trial.tokenAccounting !== 'provider-reported'
    ) {
      invalid(`evidence receipt ${index} does not independently reproduce its trial outcome`);
    }
    if (evidenceHashes.has(raw.evidenceHash) || appServerEvidenceHashes.has(raw.appServer.evidenceHash)) {
      invalid('retained evidence hashes must be unique across trials');
    }
    if (runBindingHashes.has(binding.runBindingHash)) invalid('retained run bindings must be unique across trials');
    evidenceHashes.add(raw.evidenceHash);
    appServerEvidenceHashes.add(raw.appServer.evidenceHash);
    runBindingHashes.add(binding.runBindingHash);
    previousEvidenceDigest = codeMemoryLinkAgentEvidenceReceiptDigest(receipt);
  }
  return receipts;
}

function sameUsage(
  left: {readonly steps: number; readonly tokens: number} | null,
  right: {readonly steps: number; readonly tokens: number} | null,
): boolean {
  return left === null ? right === null : right !== null && left.steps === right.steps && left.tokens === right.tokens;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || EffectArray.some(actual, (key, index) => key !== wanted[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link retained evidence: ${message}.`);
}

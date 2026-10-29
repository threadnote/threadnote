import {Array as EffectArray} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  codeMemoryLinkAgentAbTrialReceiptDigest,
  parseCodeMemoryLinkAgentAbTrialV1,
  type CodeMemoryLinkAgentAbTrialV1,
} from './code-memory-link-agent-ab.js';
import {Predicate} from 'effect';
import {
  codeMemoryLinkAgentEvidenceReceiptDigest,
  parseCodeMemoryLinkAgentEvidenceReceiptV1,
  type CodeMemoryLinkAgentEvidenceReceiptV1,
} from './code-memory-link-agent-evidence.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_AGENT_PENDING_COMMIT_VERSION = 1 as const;

export interface CodeMemoryLinkAgentPendingCommitV1 {
  readonly commitDigest: string;
  readonly evidence: CodeMemoryLinkAgentEvidenceReceiptV1;
  readonly index: number;
  readonly trial: CodeMemoryLinkAgentAbTrialV1;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PENDING_COMMIT_VERSION;
}

const HASH = /^[0-9a-f]{64}$/u;
const MAXIMUM_PENDING_BYTES = 32 * 1_024 * 1_024;

/** Seal the one logical commit that is projected into the trial and retained-evidence ledgers. */
export function createCodeMemoryLinkAgentPendingCommitV1(input: {
  readonly evidence: unknown;
  readonly index: number;
  readonly trial: unknown;
}): CodeMemoryLinkAgentPendingCommitV1 {
  const normalized = normalizePending({...input, version: CODE_MEMORY_LINK_AGENT_PENDING_COMMIT_VERSION});
  return {...normalized, commitDigest: pendingDigest(normalized)};
}

export function parseCodeMemoryLinkAgentPendingCommitV1(value: unknown): CodeMemoryLinkAgentPendingCommitV1 {
  const pending = record(value, 'pending commit');
  exactKeys(pending, ['commitDigest', 'evidence', 'index', 'trial', 'version']);
  const normalized = normalizePending(pending);
  const commitDigest = matching(pending.commitDigest, HASH, 'pending commit digest');
  if (commitDigest !== pendingDigest(normalized)) invalid('pending commit digest does not match its contents');
  return {...normalized, commitDigest};
}

export function parseCodeMemoryLinkAgentPendingCommitJsonV1(source: string): CodeMemoryLinkAgentPendingCommitV1 {
  if (new TextEncoder().encode(source).byteLength > MAXIMUM_PENDING_BYTES) invalid('pending commit exceeds 32 MiB');
  try {
    return parseCodeMemoryLinkAgentPendingCommitV1(JSON.parse(source) as unknown);
  } catch (cause) {
    if (
      cause instanceof Error &&
      Effect.pipe(cause.message, EffectString.startsWith('Invalid Code Memory Link pending commit:'))
    )
      throw cause;
    throw new Error('Invalid Code Memory Link pending commit: pending commit must be valid JSON.', {cause});
  }
}

export function serializeCodeMemoryLinkAgentPendingCommitJsonV1(value: unknown): string {
  return `${JSON.stringify(parseCodeMemoryLinkAgentPendingCommitV1(value))}\n`;
}

/**
 * Reconcile every durable crash point: neither projection written, either one written, or both written. Any other
 * shape is ambiguous and fails closed instead of silently accepting or rerunning a measured trial.
 */
export function reconcileCodeMemoryLinkAgentPendingCommitV1(input: {
  readonly evidence: readonly unknown[];
  readonly pending: unknown;
  readonly trials: readonly unknown[];
}): {
  readonly appendEvidence: boolean;
  readonly appendTrial: boolean;
  readonly evidence: readonly CodeMemoryLinkAgentEvidenceReceiptV1[];
  readonly pending: CodeMemoryLinkAgentPendingCommitV1;
  readonly trials: readonly CodeMemoryLinkAgentAbTrialV1[];
} {
  const pending = parseCodeMemoryLinkAgentPendingCommitV1(input.pending);
  const evidence = EffectArray.map(input.evidence, parseCodeMemoryLinkAgentEvidenceReceiptV1);
  const trials = EffectArray.map(input.trials, parseCodeMemoryLinkAgentAbTrialV1);
  if (
    evidence.length < pending.index ||
    evidence.length > pending.index + 1 ||
    trials.length < pending.index ||
    trials.length > pending.index + 1
  ) {
    invalid('ledger lengths do not describe a recoverable commit boundary');
  }
  const previousEvidenceDigest =
    pending.index === 0 ? null : codeMemoryLinkAgentEvidenceReceiptDigest(evidence[pending.index - 1]);
  const previousTrialDigest =
    pending.index === 0 ? null : codeMemoryLinkAgentAbTrialReceiptDigest(trials[pending.index - 1]);
  if (
    pending.evidence.previousEvidenceDigest !== previousEvidenceDigest ||
    pending.trial.previousReceiptDigest !== previousTrialDigest
  ) {
    invalid('pending commit does not extend both durable ledger prefixes');
  }
  if (evidence.length > pending.index && !same(evidence[pending.index], pending.evidence)) {
    invalid('durable evidence conflicts with the pending commit');
  }
  if (trials.length > pending.index && !same(trials[pending.index], pending.trial)) {
    invalid('durable trial conflicts with the pending commit');
  }
  const appendEvidence = evidence.length === pending.index;
  const appendTrial = trials.length === pending.index;
  return {
    appendEvidence,
    appendTrial,
    evidence: appendEvidence ? [...evidence, pending.evidence] : evidence,
    pending,
    trials: appendTrial ? [...trials, pending.trial] : trials,
  };
}

function normalizePending(value: unknown): Omit<CodeMemoryLinkAgentPendingCommitV1, 'commitDigest'> {
  const pending = record(value, 'pending commit');
  if (pending.version !== CODE_MEMORY_LINK_AGENT_PENDING_COMMIT_VERSION) invalid('pending commit version must be 1');
  const index = pending.index;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    invalid('pending commit index is invalid');
  }
  const evidence = parseCodeMemoryLinkAgentEvidenceReceiptV1(pending.evidence);
  const trial = parseCodeMemoryLinkAgentAbTrialV1(pending.trial);
  if (evidence.trialId !== trial.trialId) invalid('pending evidence and trial identities differ');
  return {evidence, index, trial, version: CODE_MEMORY_LINK_AGENT_PENDING_COMMIT_VERSION};
}

function pendingDigest(value: Omit<CodeMemoryLinkAgentPendingCommitV1, 'commitDigest'>): string {
  return sha256HexSync(`code-memory-link-agent-pending-v1\0${JSON.stringify(value)}\n`);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = EffectRecord.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || EffectArray.some(actual, (key, index) => key !== wanted[index])) {
    invalid('pending commit has unsupported or missing fields');
  }
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link pending commit: ${message}.`);
}

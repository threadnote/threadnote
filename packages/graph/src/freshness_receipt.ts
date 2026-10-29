import {Predicate} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';

/**
 * Slice 3 remains gated. This module describes the evidence a future watcher
 * backend must prove before any receipt authority can be implemented.
 *
 * Deliberately, this module exports no valid-receipt constructor, read token,
 * capture API, or validation API. A complete assessment is only a candidate
 * for backend conformance and never authorizes graph currentness.
 */

export const CODE_GRAPH_FRESHNESS_RECEIPT_RUNTIME_PREREQUISITES = Object.freeze([
  'baseline-checkout-repository-worktree-head-dirty-overlay-ready-snapshot-bound',
  'backend-restart-close-end-error-invalidates-before-reuse',
  'backend-identity',
  'capture-exact-observation-between-checkpoints',
  'capture-fresh-linearizable-checkpoints',
  'capture-queued-mutation-rejected-before-notification',
  'checkpoint-reuse-rejected',
  'explicit-overflow-signal',
  'exact-reconciliation-mismatch-invalidates-before-reuse',
  'git-config-change-coverage',
  'git-configuration-read-only',
  'git-control-plane-change-coverage',
  'git-head-change-coverage',
  'git-index-change-coverage',
  'git-ref-change-coverage',
  'ingress-egress-alias-isolation',
  'invalid-unqualified-epoch-reuse-rejected',
  'opaque-owner-minted-epoch',
  'replacement-epoch-reuse-rejected',
  'retired-epoch-never-reusable',
  'sequence-checkpoint-loss-invalidates-before-reuse',
  'sequence-contiguous-monotonic',
  'selected-snapshot-exact-baseline-bound',
  'silent-git-mutation-visible-before-notification',
  'unknown-input-total-fail-closed',
  'unsupported-filesystem-environment-falls-back',
  'validate-fresh-linearizable-checkpoints',
  'validate-exact-observation-between-checkpoints',
  'validate-queued-mutation-rejected-before-notification',
  'worktree-recursive-change-coverage',
] as const);

/** The frozen runtime tuple is the single source of truth for this closed set. */
export type CodeGraphFreshnessReceiptRuntimePrerequisite =
  (typeof CODE_GRAPH_FRESHNESS_RECEIPT_RUNTIME_PREREQUISITES)[number];

/**
 * Declarative conformance evidence only. It is intentionally structural
 * because satisfying it still cannot mint authority.
 */
export interface CodeGraphFreshnessReceiptCandidateEvidence {
  readonly aliasIsolation: 'deep-clone-freeze-except-opaque-epoch';
  readonly coverage: {
    readonly gitConfig: 'complete';
    readonly gitControlPlane: 'complete';
    readonly gitHead: 'complete';
    readonly gitIndex: 'complete';
    readonly gitRefs: 'complete';
    readonly recursiveWorktree: 'complete';
    readonly silentGitMutation: 'checkpoint-visible-before-notification';
  };
  readonly epochs: {
    readonly identity: 'opaque-owner-minted';
    readonly invalidThenUnqualifiedReuse: 'rejected';
    readonly replacementInvalidationReuse: 'rejected';
    readonly retirement: 'monotonic-never-reusable';
  };
  readonly binding: {
    readonly baseline: 'checkout-repository-worktree-head-dirty-overlay-fingerprint-ready-snapshot';
    readonly selectedSnapshot: 'exact-baseline-snapshot';
  };
  readonly fences: {
    readonly captureCheckpoints: 'fresh-linearizable-before-and-after';
    readonly captureObservation: 'exact-git-worktree-between-checkpoints';
    readonly captureQueuedMutation: 'advance-rejected-before-notification';
    readonly reuse: 'rejected';
    readonly validateCheckpoints: 'fresh-linearizable-before-and-after';
    readonly validateObservation: 'exact-git-worktree-between-checkpoints';
    readonly validateQueuedMutation: 'advance-rejected-before-notification';
  };
  readonly failClosed: {
    readonly lifecycle: 'restart-close-end-error-invalidates-before-reuse';
    readonly reconciliationMismatch: 'exact-observation-invalidates-before-reuse';
    readonly sequenceOrCheckpointLoss: 'invalidates-before-reuse';
    readonly unsupportedScope: 'filesystem-environment-falls-back';
  };
  readonly gitConfigurationAccess: 'read-only';
  readonly overflow: 'explicit';
  readonly sequence: 'contiguous-monotonic';
  readonly unknownInputHandling: 'total-fail-closed';
}

export interface CodeGraphFreshnessReceiptCandidate {
  readonly backend: string;
  readonly evidence: CodeGraphFreshnessReceiptCandidateEvidence;
}

export interface CodeGraphFreshnessReceiptCandidateAssessment {
  /** This precursor is incapable of granting currentness authority. */
  readonly authorizesCurrentness: false;
  readonly backend?: string;
  readonly missing: readonly CodeGraphFreshnessReceiptRuntimePrerequisite[];
  readonly state: 'candidate-for-conformance' | 'gated';
}

/**
 * Current Effect/Node watching can schedule refreshes, but does not provide
 * qualified checkpoint, sequence, overflow, or full Git control-plane proof.
 */
export const CODE_GRAPH_EFFECT_NODE_WATCH_QUALIFICATION: CodeGraphFreshnessReceiptCandidateAssessment =
  freezeAssessment({
    authorizesCurrentness: false,
    backend: 'effect-node-fs-watch',
    missing: CODE_GRAPH_FRESHNESS_RECEIPT_RUNTIME_PREREQUISITES,
    state: 'gated',
  });

/**
 * Total, fail-closed assessment of untrusted declarative evidence.
 *
 * Even when every prerequisite is present, the result only admits the backend
 * to a future platform conformance harness. It never creates a receipt or read
 * authority and is not wired into watcher or query runtime behavior. Extractor
 * and indexer currentness remain a separate query-layer prerequisite.
 */
export function assessCodeGraphFreshnessReceiptCandidate(input: unknown): CodeGraphFreshnessReceiptCandidateAssessment {
  try {
    const candidate = record(input);
    const backend = nonEmptyString(candidate?.backend);
    const evidence = record(candidate?.evidence);
    const binding = record(evidence?.binding);
    const coverage = record(evidence?.coverage);
    const epochs = record(evidence?.epochs);
    const fences = record(evidence?.fences);
    const failClosed = record(evidence?.failClosed);
    const satisfied = new Set<CodeGraphFreshnessReceiptRuntimePrerequisite>();

    satisfy(
      satisfied,
      'baseline-checkout-repository-worktree-head-dirty-overlay-ready-snapshot-bound',
      binding?.baseline === 'checkout-repository-worktree-head-dirty-overlay-fingerprint-ready-snapshot',
    );
    satisfy(
      satisfied,
      'backend-restart-close-end-error-invalidates-before-reuse',
      failClosed?.lifecycle === 'restart-close-end-error-invalidates-before-reuse',
    );
    satisfy(satisfied, 'backend-identity', backend !== undefined);
    satisfy(
      satisfied,
      'capture-exact-observation-between-checkpoints',
      fences?.captureObservation === 'exact-git-worktree-between-checkpoints',
    );
    satisfy(
      satisfied,
      'capture-fresh-linearizable-checkpoints',
      fences?.captureCheckpoints === 'fresh-linearizable-before-and-after',
    );
    satisfy(
      satisfied,
      'capture-queued-mutation-rejected-before-notification',
      fences?.captureQueuedMutation === 'advance-rejected-before-notification',
    );
    satisfy(satisfied, 'checkpoint-reuse-rejected', fences?.reuse === 'rejected');
    satisfy(satisfied, 'explicit-overflow-signal', evidence?.overflow === 'explicit');
    satisfy(
      satisfied,
      'exact-reconciliation-mismatch-invalidates-before-reuse',
      failClosed?.reconciliationMismatch === 'exact-observation-invalidates-before-reuse',
    );
    satisfy(satisfied, 'git-config-change-coverage', coverage?.gitConfig === 'complete');
    satisfy(satisfied, 'git-configuration-read-only', evidence?.gitConfigurationAccess === 'read-only');
    satisfy(satisfied, 'git-control-plane-change-coverage', coverage?.gitControlPlane === 'complete');
    satisfy(satisfied, 'git-head-change-coverage', coverage?.gitHead === 'complete');
    satisfy(satisfied, 'git-index-change-coverage', coverage?.gitIndex === 'complete');
    satisfy(satisfied, 'git-ref-change-coverage', coverage?.gitRefs === 'complete');
    satisfy(
      satisfied,
      'ingress-egress-alias-isolation',
      evidence?.aliasIsolation === 'deep-clone-freeze-except-opaque-epoch',
    );
    satisfy(satisfied, 'invalid-unqualified-epoch-reuse-rejected', epochs?.invalidThenUnqualifiedReuse === 'rejected');
    satisfy(satisfied, 'opaque-owner-minted-epoch', epochs?.identity === 'opaque-owner-minted');
    satisfy(satisfied, 'replacement-epoch-reuse-rejected', epochs?.replacementInvalidationReuse === 'rejected');
    satisfy(satisfied, 'retired-epoch-never-reusable', epochs?.retirement === 'monotonic-never-reusable');
    satisfy(
      satisfied,
      'sequence-checkpoint-loss-invalidates-before-reuse',
      failClosed?.sequenceOrCheckpointLoss === 'invalidates-before-reuse',
    );
    satisfy(satisfied, 'sequence-contiguous-monotonic', evidence?.sequence === 'contiguous-monotonic');
    satisfy(
      satisfied,
      'selected-snapshot-exact-baseline-bound',
      binding?.selectedSnapshot === 'exact-baseline-snapshot',
    );
    satisfy(
      satisfied,
      'silent-git-mutation-visible-before-notification',
      coverage?.silentGitMutation === 'checkpoint-visible-before-notification',
    );
    satisfy(satisfied, 'unknown-input-total-fail-closed', evidence?.unknownInputHandling === 'total-fail-closed');
    satisfy(
      satisfied,
      'unsupported-filesystem-environment-falls-back',
      failClosed?.unsupportedScope === 'filesystem-environment-falls-back',
    );
    satisfy(
      satisfied,
      'validate-fresh-linearizable-checkpoints',
      fences?.validateCheckpoints === 'fresh-linearizable-before-and-after',
    );
    satisfy(
      satisfied,
      'validate-exact-observation-between-checkpoints',
      fences?.validateObservation === 'exact-git-worktree-between-checkpoints',
    );
    satisfy(
      satisfied,
      'validate-queued-mutation-rejected-before-notification',
      fences?.validateQueuedMutation === 'advance-rejected-before-notification',
    );
    satisfy(satisfied, 'worktree-recursive-change-coverage', coverage?.recursiveWorktree === 'complete');

    const missing = EffectArray.filter(
      CODE_GRAPH_FRESHNESS_RECEIPT_RUNTIME_PREREQUISITES,
      item => !satisfied.has(item),
    );
    return freezeAssessment({
      authorizesCurrentness: false,
      ...(backend === undefined ? {} : {backend}),
      missing,
      state: missing.length === 0 ? 'candidate-for-conformance' : 'gated',
    });
  } catch {
    return freezeAssessment({
      authorizesCurrentness: false,
      missing: CODE_GRAPH_FRESHNESS_RECEIPT_RUNTIME_PREREQUISITES,
      state: 'gated',
    });
  }
}

function freezeAssessment(
  assessment: CodeGraphFreshnessReceiptCandidateAssessment,
): CodeGraphFreshnessReceiptCandidateAssessment {
  return Object.freeze({...assessment, missing: Object.freeze([...assessment.missing])});
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && Effect.pipe(value, EffectString.trim).length > 0 ? value : undefined;
}

function record(value: unknown): Record<PropertyKey, unknown> | undefined {
  return Predicate.isObject(value) ? value : undefined;
}

function satisfy(
  satisfied: Set<CodeGraphFreshnessReceiptRuntimePrerequisite>,
  prerequisite: CodeGraphFreshnessReceiptRuntimePrerequisite,
  condition: boolean,
): void {
  if (condition) satisfied.add(prerequisite);
}

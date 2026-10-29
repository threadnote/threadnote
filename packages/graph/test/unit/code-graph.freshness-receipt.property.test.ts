import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  assessCodeGraphFreshnessReceiptCandidate,
  CODE_GRAPH_EFFECT_NODE_WATCH_QUALIFICATION,
  CODE_GRAPH_FRESHNESS_RECEIPT_RUNTIME_PREREQUISITES,
  type CodeGraphFreshnessReceiptCandidate,
  type CodeGraphFreshnessReceiptRuntimePrerequisite,
} from '@threadnote/graph/freshness_receipt';
import {Array as EffectArray, Schema} from 'effect';

const allPrerequisites = CODE_GRAPH_FRESHNESS_RECEIPT_RUNTIME_PREREQUISITES;

describe('code graph freshness receipt runtime gate', () => {
  it('keeps the current Effect and Node watcher fully gated and immutable', () => {
    expect(CODE_GRAPH_EFFECT_NODE_WATCH_QUALIFICATION).toEqual({
      authorizesCurrentness: false,
      backend: 'effect-node-fs-watch',
      missing: allPrerequisites,
      state: 'gated',
    });
    expect(Object.isFrozen(CODE_GRAPH_EFFECT_NODE_WATCH_QUALIFICATION)).toBe(true);
    expect(Object.isFrozen(CODE_GRAPH_EFFECT_NODE_WATCH_QUALIFICATION.missing)).toBe(true);
    expect(Reflect.set(CODE_GRAPH_EFFECT_NODE_WATCH_QUALIFICATION, 'state', 'candidate-for-conformance')).toBe(false);
  });

  it('treats complete declarative evidence only as a non-authorizing conformance candidate', () => {
    const assessment = assessCodeGraphFreshnessReceiptCandidate(completeCandidate());

    expect(assessment).toEqual({
      authorizesCurrentness: false,
      backend: 'test-qualified-watch',
      missing: [],
      state: 'candidate-for-conformance',
    });
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.missing)).toBe(true);
  });

  it.each([
    ['a mutation queued before capture notification delivery', 'capture-queued-mutation-rejected-before-notification'],
    [
      'a mutation queued before post-read validation notification delivery',
      'validate-queued-mutation-rejected-before-notification',
    ],
    ['a silent Git control-plane mutation', 'silent-git-mutation-visible-before-notification'],
    ['reuse after invalid then unqualified downgrade', 'invalid-unqualified-epoch-reuse-rejected'],
    ['reuse of either epoch after replacement invalidation', 'replacement-epoch-reuse-rejected'],
  ] as const)('requires proof that rejects %s', (_label, missingPrerequisite) => {
    const satisfied = new Set<CodeGraphFreshnessReceiptRuntimePrerequisite>(allPrerequisites);
    satisfied.delete(missingPrerequisite);

    expect(assessCodeGraphFreshnessReceiptCandidate(candidateFromSatisfied(satisfied))).toMatchObject({
      authorizesCurrentness: false,
      missing: [missingPrerequisite],
      state: 'gated',
    });
  });

  it.each([
    'backend-restart-close-end-error-invalidates-before-reuse',
    'sequence-checkpoint-loss-invalidates-before-reuse',
    'unsupported-filesystem-environment-falls-back',
    'exact-reconciliation-mismatch-invalidates-before-reuse',
  ] as const)('requires the fail-closed lifecycle prerequisite %s', missingPrerequisite => {
    const satisfied = new Set<CodeGraphFreshnessReceiptRuntimePrerequisite>(allPrerequisites);
    satisfied.delete(missingPrerequisite);

    expect(assessCodeGraphFreshnessReceiptCandidate(candidateFromSatisfied(satisfied))).toMatchObject({
      authorizesCurrentness: false,
      missing: [missingPrerequisite],
      state: 'gated',
    });
  });

  it.each([
    'capture-fresh-linearizable-checkpoints',
    'capture-exact-observation-between-checkpoints',
    'validate-fresh-linearizable-checkpoints',
    'validate-exact-observation-between-checkpoints',
    'baseline-checkout-repository-worktree-head-dirty-overlay-ready-snapshot-bound',
    'selected-snapshot-exact-baseline-bound',
  ] as const)('requires the closed read-fence and snapshot binding prerequisite %s', missingPrerequisite => {
    const satisfied = new Set<CodeGraphFreshnessReceiptRuntimePrerequisite>(allPrerequisites);
    satisfied.delete(missingPrerequisite);

    expect(assessCodeGraphFreshnessReceiptCandidate(candidateFromSatisfied(satisfied))).toMatchObject({
      authorizesCurrentness: false,
      missing: [missingPrerequisite],
      state: 'gated',
    });
  });

  it.each([
    'worktree-recursive-change-coverage',
    'git-head-change-coverage',
    'git-ref-change-coverage',
    'git-index-change-coverage',
    'git-config-change-coverage',
    'git-control-plane-change-coverage',
  ] as const)('requires full dependency-surface coverage for %s', missingPrerequisite => {
    const satisfied = new Set<CodeGraphFreshnessReceiptRuntimePrerequisite>(allPrerequisites);
    satisfied.delete(missingPrerequisite);

    expect(assessCodeGraphFreshnessReceiptCandidate(candidateFromSatisfied(satisfied))).toMatchObject({
      authorizesCurrentness: false,
      missing: [missingPrerequisite],
      state: 'gated',
    });
  });

  it('does not retain caller aliases and freezes every returned wrapper', () => {
    const candidate = completeCandidate();
    const assessment = assessCodeGraphFreshnessReceiptCandidate(candidate);

    expect(Reflect.set(candidate, 'backend', 'mutated-backend')).toBe(true);
    expect(Reflect.set(candidate.evidence.binding, 'baseline', 'mutated')).toBe(true);
    expect(Reflect.set(candidate.evidence.coverage, 'gitHead', 'mutated')).toBe(true);
    expect(Reflect.set(candidate.evidence.fences, 'captureCheckpoints', 'mutated')).toBe(true);

    expect(assessment).toEqual({
      authorizesCurrentness: false,
      backend: 'test-qualified-watch',
      missing: [],
      state: 'candidate-for-conformance',
    });
    expect(Reflect.set(assessment, 'backend', 'mutated-output')).toBe(false);
    expect(Reflect.set(assessment.missing, '0', 'backend-identity')).toBe(false);
    expect(assessCodeGraphFreshnessReceiptCandidate(candidate)).toMatchObject({
      authorizesCurrentness: false,
      state: 'gated',
    });
  });

  it('is total and fail-closed for malformed values and throwing accessors', () => {
    const throwing = new Proxy<Record<string, never>>(
      {},
      {
        get() {
          throw new Error('untrusted getter');
        },
      },
    );
    const malformed: readonly unknown[] = [
      undefined,
      null,
      true,
      1,
      1n,
      'candidate',
      [],
      {},
      {backend: {trim: 'not-a-function'}, evidence: null},
      {backend: 'backend', evidence: {coverage: throwing}},
      throwing,
    ];

    for (const value of malformed) {
      expect(() => assessCodeGraphFreshnessReceiptCandidate(value)).not.toThrow();
      const assessment = assessCodeGraphFreshnessReceiptCandidate(value);
      expect(assessment.authorizesCurrentness).toBe(false);
      expect(assessment.state).toBe('gated');
      expect(assessment.missing.length).toBeGreaterThan(0);
    }
  });

  it('never grants currentness for arbitrary unknown input (property)', () => {
    fc.assert(
      fc.property(fc.anything(), input => {
        const assessment = assessCodeGraphFreshnessReceiptCandidate(input);
        expect(assessment.authorizesCurrentness).toBe(false);
        expect(['candidate-for-conformance', 'gated']).toContain(assessment.state);
        expect(Object.isFrozen(assessment)).toBe(true);
        expect(Object.isFrozen(assessment.missing)).toBe(true);
      }),
      {numRuns: 500},
    );
  });

  it('matches an independent prerequisite model for arbitrary evidence subsets (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), {maxLength: allPrerequisites.length, minLength: allPrerequisites.length}),
        proofs => {
          const satisfied = new Set<CodeGraphFreshnessReceiptRuntimePrerequisite>();
          for (const [index, prerequisite] of allPrerequisites.entries()) {
            if (proofs[index]) satisfied.add(prerequisite);
          }
          const expectedMissing = EffectArray.filter(allPrerequisites, prerequisite => !satisfied.has(prerequisite));
          const assessment = assessCodeGraphFreshnessReceiptCandidate(candidateFromSatisfied(satisfied));

          expect(assessment).toEqual({
            authorizesCurrentness: false,
            ...(satisfied.has('backend-identity') ? {backend: 'test-qualified-watch'} : {}),
            missing: expectedMissing,
            state: expectedMissing.length === 0 ? 'candidate-for-conformance' : 'gated',
          });
        },
      ),
      {numRuns: 500},
    );
  });

  it('returns the same complete assessment for the same arbitrary evidence (property)', () => {
    fc.assert(
      fc.property(fc.anything(), input => {
        expect(assessCodeGraphFreshnessReceiptCandidate(input)).toEqual(
          assessCodeGraphFreshnessReceiptCandidate(input),
        );
      }),
      {numRuns: 250},
    );
  });
});

const CompleteCandidateSchema = Schema.Struct({
  backend: Schema.String,
  evidence: Schema.Struct({
    aliasIsolation: Schema.Literal('deep-clone-freeze-except-opaque-epoch'),
    binding: Schema.Struct({
      baseline: Schema.Literal('checkout-repository-worktree-head-dirty-overlay-fingerprint-ready-snapshot'),
      selectedSnapshot: Schema.Literal('exact-baseline-snapshot'),
    }),
    coverage: Schema.Struct({
      gitConfig: Schema.Literal('complete'),
      gitControlPlane: Schema.Literal('complete'),
      gitHead: Schema.Literal('complete'),
      gitIndex: Schema.Literal('complete'),
      gitRefs: Schema.Literal('complete'),
      recursiveWorktree: Schema.Literal('complete'),
      silentGitMutation: Schema.Literal('checkpoint-visible-before-notification'),
    }),
    epochs: Schema.Struct({
      identity: Schema.Literal('opaque-owner-minted'),
      invalidThenUnqualifiedReuse: Schema.Literal('rejected'),
      replacementInvalidationReuse: Schema.Literal('rejected'),
      retirement: Schema.Literal('monotonic-never-reusable'),
    }),
    fences: Schema.Struct({
      captureCheckpoints: Schema.Literal('fresh-linearizable-before-and-after'),
      captureObservation: Schema.Literal('exact-git-worktree-between-checkpoints'),
      captureQueuedMutation: Schema.Literal('advance-rejected-before-notification'),
      reuse: Schema.Literal('rejected'),
      validateCheckpoints: Schema.Literal('fresh-linearizable-before-and-after'),
      validateObservation: Schema.Literal('exact-git-worktree-between-checkpoints'),
      validateQueuedMutation: Schema.Literal('advance-rejected-before-notification'),
    }),
    failClosed: Schema.Struct({
      lifecycle: Schema.Literal('restart-close-end-error-invalidates-before-reuse'),
      reconciliationMismatch: Schema.Literal('exact-observation-invalidates-before-reuse'),
      sequenceOrCheckpointLoss: Schema.Literal('invalidates-before-reuse'),
      unsupportedScope: Schema.Literal('filesystem-environment-falls-back'),
    }),
    gitConfigurationAccess: Schema.Literal('read-only'),
    overflow: Schema.Literal('explicit'),
    sequence: Schema.Literal('contiguous-monotonic'),
    unknownInputHandling: Schema.Literal('total-fail-closed'),
  }),
});

function completeCandidate(): CodeGraphFreshnessReceiptCandidate {
  const candidate = candidateFromSatisfied(new Set<CodeGraphFreshnessReceiptRuntimePrerequisite>(allPrerequisites));
  if (!Schema.is(CompleteCandidateSchema)(candidate)) throw new Error('Invalid complete freshness candidate fixture.');
  return candidate;
}

function candidateFromSatisfied(satisfied: ReadonlySet<CodeGraphFreshnessReceiptRuntimePrerequisite>): unknown {
  const proven = (prerequisite: CodeGraphFreshnessReceiptRuntimePrerequisite): boolean => satisfied.has(prerequisite);
  return {
    backend: proven('backend-identity') ? 'test-qualified-watch' : ' ',
    evidence: {
      aliasIsolation: proven('ingress-egress-alias-isolation') ? 'deep-clone-freeze-except-opaque-epoch' : 'not-proven',
      binding: {
        baseline: proven('baseline-checkout-repository-worktree-head-dirty-overlay-ready-snapshot-bound')
          ? 'checkout-repository-worktree-head-dirty-overlay-fingerprint-ready-snapshot'
          : 'not-proven',
        selectedSnapshot: proven('selected-snapshot-exact-baseline-bound') ? 'exact-baseline-snapshot' : 'not-proven',
      },
      coverage: {
        gitConfig: proven('git-config-change-coverage') ? 'complete' : 'not-proven',
        gitControlPlane: proven('git-control-plane-change-coverage') ? 'complete' : 'not-proven',
        gitHead: proven('git-head-change-coverage') ? 'complete' : 'not-proven',
        gitIndex: proven('git-index-change-coverage') ? 'complete' : 'not-proven',
        gitRefs: proven('git-ref-change-coverage') ? 'complete' : 'not-proven',
        recursiveWorktree: proven('worktree-recursive-change-coverage') ? 'complete' : 'not-proven',
        silentGitMutation: proven('silent-git-mutation-visible-before-notification')
          ? 'checkpoint-visible-before-notification'
          : 'not-proven',
      },
      epochs: {
        identity: proven('opaque-owner-minted-epoch') ? 'opaque-owner-minted' : 'not-proven',
        invalidThenUnqualifiedReuse: proven('invalid-unqualified-epoch-reuse-rejected') ? 'rejected' : 'not-proven',
        replacementInvalidationReuse: proven('replacement-epoch-reuse-rejected') ? 'rejected' : 'not-proven',
        retirement: proven('retired-epoch-never-reusable') ? 'monotonic-never-reusable' : 'not-proven',
      },
      failClosed: {
        lifecycle: proven('backend-restart-close-end-error-invalidates-before-reuse')
          ? 'restart-close-end-error-invalidates-before-reuse'
          : 'not-proven',
        reconciliationMismatch: proven('exact-reconciliation-mismatch-invalidates-before-reuse')
          ? 'exact-observation-invalidates-before-reuse'
          : 'not-proven',
        sequenceOrCheckpointLoss: proven('sequence-checkpoint-loss-invalidates-before-reuse')
          ? 'invalidates-before-reuse'
          : 'not-proven',
        unsupportedScope: proven('unsupported-filesystem-environment-falls-back')
          ? 'filesystem-environment-falls-back'
          : 'not-proven',
      },
      fences: {
        captureCheckpoints: proven('capture-fresh-linearizable-checkpoints')
          ? 'fresh-linearizable-before-and-after'
          : 'not-proven',
        captureObservation: proven('capture-exact-observation-between-checkpoints')
          ? 'exact-git-worktree-between-checkpoints'
          : 'not-proven',
        captureQueuedMutation: proven('capture-queued-mutation-rejected-before-notification')
          ? 'advance-rejected-before-notification'
          : 'not-proven',
        reuse: proven('checkpoint-reuse-rejected') ? 'rejected' : 'not-proven',
        validateCheckpoints: proven('validate-fresh-linearizable-checkpoints')
          ? 'fresh-linearizable-before-and-after'
          : 'not-proven',
        validateObservation: proven('validate-exact-observation-between-checkpoints')
          ? 'exact-git-worktree-between-checkpoints'
          : 'not-proven',
        validateQueuedMutation: proven('validate-queued-mutation-rejected-before-notification')
          ? 'advance-rejected-before-notification'
          : 'not-proven',
      },
      gitConfigurationAccess: proven('git-configuration-read-only') ? 'read-only' : 'not-proven',
      overflow: proven('explicit-overflow-signal') ? 'explicit' : 'not-proven',
      sequence: proven('sequence-contiguous-monotonic') ? 'contiguous-monotonic' : 'not-proven',
      unknownInputHandling: proven('unknown-input-total-fail-closed') ? 'total-fail-closed' : 'not-proven',
    },
  };
}

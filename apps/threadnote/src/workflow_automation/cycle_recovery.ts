import {Array as A, Effect, String as S} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {nativeCyclePhaseHash, type NativeCyclePlan} from '@threadnote/workflow-automations/cycle';
import {
  nativeCycleHasBasePlanTransition,
  type NativeCycleRuntime,
} from '@threadnote/workflow-automations/cycle-runtime';
import type {NativeCycleSnapshot} from '@threadnote/workflow-automations/cycle-review';
import {verifyNativeCycleBaseRequalification} from './cycle_git.js';

const fail = (message: string) => WorkflowAutomationError.make({code: 'invalid-rebase-recovery', message});
const readGit = (repo: string, args: readonly string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args], {
    timeoutMs: 30_000,
    maxOutputBytes: 16_384,
  }).pipe(Effect.map(result => S.trim(result.stdout)));

/** Historical objects are verified without resolving the mutable comparison label. */
export const verifyNativeCycleSnapshotEvidence = Effect.fn('workflowAutomation.verifySnapshotEvidence')(function* (
  repo: string,
  snapshot: NativeCycleSnapshot,
) {
  const resolve = (ref: string, kind: 'commit' | 'tree') =>
    readGit(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{${kind}}`]).pipe(
      Effect.mapError(() =>
        WorkflowAutomationError.make({
          code: 'snapshot-evidence-unavailable',
          message: 'Retain exact historical source and comparison objects; do not substitute a moved label.',
        }),
      ),
    );
  const evidence = snapshot.comparisonEvidence;
  const checks: readonly (readonly [string, 'commit' | 'tree', string])[] = [
    [snapshot.head, 'commit', snapshot.head],
    [snapshot.declaredBaseHead, 'commit', snapshot.declaredBaseHead],
    [snapshot.pinnedRef, 'tree', snapshot.tree],
    ...(evidence
      ? [
          [evidence.sourceRef, 'commit', snapshot.head] as const,
          [evidence.baseRef, 'commit', snapshot.declaredBaseHead] as const,
          [snapshot.declaredBaseHead, 'tree', evidence.baseTree] as const,
        ]
      : []),
  ];
  for (const [ref, kind, expected] of checks)
    if ((yield* resolve(ref, kind)) !== expected)
      return yield* WorkflowAutomationError.make({
        code: 'snapshot-evidence-unavailable',
        message: 'Historical source or comparison evidence no longer resolves exactly.',
      });
});

/** An explicit unreviewed recovery proves a rewrite, not equivalence or an accepted prior review. */
export const verifyNativeCycleUnreviewedRebase = Effect.fn('workflowAutomation.verifyUnreviewedRebase')(function* (
  repo: string,
  prior: NativeCycleSnapshot,
  runtime: NativeCycleRuntime,
  phase: NativeCyclePlan['phases'][number],
  authority?: string,
) {
  if (authority !== undefined && !S.trim(authority))
    return yield* fail('Provide explicit caller-provided userAuthority for rebase recovery.');
  yield* verifyNativeCycleSnapshotEvidence(repo, prior);
  const head = yield* readGit(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const base = yield* readGit(repo, ['rev-parse', '--verify', '--end-of-options', phase.baseBranch + '^{commit}']);
  const branch = yield* readGit(repo, ['branch', '--show-current']);
  if (
    branch !== phase.branch ||
    head === prior.head ||
    base === prior.declaredBaseHead ||
    (yield* readGit(repo, ['status', '--porcelain=v1', '--untracked-files=all'])) !== ''
  )
    return yield* fail(
      'Use the declared phase branch with clean committed rewritten source on its changed exact base.',
    );
  const retainedLabels = new Set(
    A.flatMap(runtime.plans, plan =>
      A.map(
        A.filter(
          plan.phases,
          candidate => candidate.id === phase.id && nativeCyclePhaseHash(plan, phase.id) === prior.phaseHash,
        ),
        candidate => candidate.baseBranch,
      ),
    ),
  );
  const earlier = A.filter([...retainedLabels], label => label !== phase.baseBranch);
  const from =
    prior.comparisonEvidence?.baseBranch ??
    (retainedLabels.size === 1 ? [...retainedLabels][0] : earlier.length === 1 ? earlier[0] : undefined);
  if (
    !from ||
    (from !== phase.baseBranch &&
      !nativeCycleHasBasePlanTransition(
        runtime.plans,
        prior,
        runtime.state.phases[phase.id].phaseHash,
        from,
        phase.baseBranch,
      ))
  )
    return yield* fail('Retain the approved predecessor and current base binding before recovery.');
  yield* verifyNativeCycleBaseRequalification(repo, prior.head, head, base, {
    preRebaseHead: prior.head,
    ontoHead: base,
    rebasedHead: head,
    fromBaseBranch: from,
  });
  return {
    version: 1 as const,
    priorHead: prior.head,
    priorBaseHead: prior.declaredBaseHead,
    fromBaseBranch: from,
    toBaseBranch: phase.baseBranch,
    authority: authority ?? '',
    receiptDigest: '',
  };
});

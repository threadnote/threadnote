import {Effect, String as EffectString} from 'effect';
import * as Effect2 from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {NativeCycleState} from '@threadnote/workflow-automations/cycle';
import type {NativeCycleSnapshot} from '@threadnote/workflow-automations/cycle-review';
import {captureNativeCycleSource, nativeCycleIsAncestor} from './cycle_git.js';
import {verifyNativeCycleSameLabelRebasedBaseSource} from './cycle_merge.js';
import {verifyNativeCycleSnapshotEvidence} from './cycle_recovery.js';

const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const git = (repo: string, args: readonly string[], maximum = 1_000_000) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args], {
    timeoutMs: 30_000,
    maxOutputBytes: maximum,
  }).pipe(Effect.map(result => result.stdout));

/** Recheck that the live checkout still holds a retained snapshot's exact source, branch and declared base. */
export const currentNativeCycleSnapshot = Effect.fn('workflowAutomation.cycle.checkSnapshot')(function* (
  repo: string,
  snapshot: NativeCycleSnapshot,
  acceptedHead?: string,
  phase?: NativeCycleState['plan']['phases'][number],
  historicalComparison = false,
) {
  yield* verifyNativeCycleSameLabelRebasedBaseSource(repo, snapshot);
  yield* verifyNativeCycleSnapshotEvidence(repo, snapshot);
  const current = yield* captureNativeCycleSource(repo, snapshot.baseTree);
  if (phase) {
    const base = historicalComparison
      ? snapshot.declaredBaseHead
      : EffectString.trim(
          yield* git(repo, ['rev-parse', '--verify', '--end-of-options', phase.baseBranch + '^{commit}']).pipe(
            Effect.mapError(() =>
              fail(
                'review-stale',
                'The current declared base is unavailable; restore its approved binding before validation or publication.',
              ),
            ),
          ),
        );
    const branch = EffectString.trim(yield* git(repo, ['branch', '--show-current']));
    // A phase on its own base branch advances that base with the commit it accepts; the tree check below binds it.
    const acceptedOwnBase = phase.baseBranch === phase.branch && acceptedHead !== undefined && base === acceptedHead;
    if ((base !== snapshot.declaredBaseHead && !acceptedOwnBase) || branch !== phase.branch)
      return yield* fail(
        'review-stale',
        'Snapshot belongs to a different declared base or phase branch; requalify current source.',
      );
  }
  if (
    current.tree !== snapshot.tree ||
    (current.head !== snapshot.head &&
      (acceptedHead !== current.head ||
        Effect2.pipe(yield* git(repo, ['rev-parse', 'HEAD^{tree}']), EffectString.trim) !== snapshot.tree ||
        !(yield* nativeCycleIsAncestor(repo, snapshot.head, current.head))))
  )
    return yield* fail('source-drift', 'Current HEAD/tree differs from the immutable review snapshot.');
  return current;
});

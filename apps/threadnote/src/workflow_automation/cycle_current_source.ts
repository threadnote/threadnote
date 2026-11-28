import {Array as EffectArray, Effect, String as EffectString} from 'effect';
import * as Effect2 from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {NativeCycleState} from '@threadnote/workflow-automations/cycle';
import type {NativeCycleSnapshot} from '@threadnote/workflow-automations/cycle-review';
import {captureNativeCycleSource, nativeCycleIsAncestor, resolveNativeCycleBase} from './cycle_git.js';
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
      : (yield* resolveNativeCycleBase(repo, phase.baseBranch).pipe(
          Effect.mapError(() =>
            fail(
              'review-stale',
              'The current declared base is unavailable; restore its approved binding before validation or publication.',
            ),
          ),
        )).commit;
    const branch = EffectString.trim(yield* git(repo, ['branch', '--show-current']));
    // A phase on its own base branch advances that base with the commit it accepts; the tree check below binds it.
    const acceptedOwnBase = phase.baseBranch === phase.branch && acceptedHead !== undefined && base === acceptedHead;
    if (branch !== phase.branch)
      return yield* fail(
        'review-stale',
        'Snapshot belongs to a different declared base or phase branch; requalify current source.',
      );
    if (base !== snapshot.declaredBaseHead && !acceptedOwnBase) {
      // Accepting a base advance means validation ran on the older base; pull-request CI is the backstop for the
      // combined tree. The reviewed snapshot is never rewritten, so delivery keeps its reviewed base evidence.
      const recovery =
        ' Merge or rebase the base into the phase branch, then record a new snapshot (reopen the phase first if it is already validated).';
      // Case-folded, NFC-normalized keys so a case-insensitive or normalizing checkout still counts as overlap.
      const pathKey = (path: string) => EffectString.toLowerCase(EffectString.normalize('NFC')(path));
      const reviewed = new Set(EffectArray.map([...snapshot.files, ...snapshot.scopeFiles], pathKey));
      const advance: 'rewritten' | 'unverified' | readonly string[] = historicalComparison
        ? 'rewritten'
        : yield* Effect.gen(function* () {
            if (!(yield* nativeCycleIsAncestor(repo, snapshot.declaredBaseHead, base))) return 'rewritten' as const;
            const output = yield* git(repo, [
              'diff',
              '-z',
              '--name-only',
              '--no-renames',
              '--ignore-submodules=none',
              snapshot.declaredBaseHead,
              base,
              '--',
            ]);
            return EffectArray.filter(
              EffectString.split(output, '\0'),
              path => path !== '' && reviewed.has(pathKey(path)),
            );
          }).pipe(Effect.orElseSucceed(() => 'unverified' as const));
      if (advance === 'rewritten' || advance === 'unverified')
        return yield* fail(
          'review-stale',
          (advance === 'rewritten'
            ? 'The declared base was rewritten or is not an ancestor of the current base.'
            : 'The base advance could not be verified against the reviewed files.') + recovery,
        );
      if (advance.length > 0)
        return yield* fail(
          'review-stale',
          'The base advanced over reviewed files (' +
            EffectArray.join(advance.slice(0, 3), ', ') +
            (advance.length > 3 ? ', ...' : '') +
            ').' +
            recovery,
        );
    }
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

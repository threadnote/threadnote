import {Array as EffectArray, String as EffectString} from 'effect';
import {Effect, Exit, Record as EffectRecord} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {nativeCyclePhaseHash, type NativeCyclePlan} from '@threadnote/workflow-automations/cycle';
import {
  validateNativeCycleMergeOwners,
  type NativeCycleOrdinaryMergeInput,
  type NativeCycleOrdinaryMergeReceipt,
  type NativeCycleSnapshot,
} from '@threadnote/workflow-automations/cycle-review';
import type {NativeCycleRuntime} from '@threadnote/workflow-automations/cycle-runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  readNativeWorkflowState,
  writePreparedNativeWorkflowState,
  type PreparedNativeWorkflowStateWrite,
} from './store.js';
import {captureNativeCycleSource, nativeCycleIsAncestor, readNativeCycleTreeEntries} from './cycle_git.js';

const fail = (message: string) => WorkflowAutomationError.make({code: 'invalid-ordinary-merge', message});
const git = (repo: string, args: readonly string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args], {
    timeoutMs: 30_000,
    maxOutputBytes: 4_000_000,
  }).pipe(Effect.map(result => EffectString.trim(result.stdout)));
const resolve = (repo: string, ref: string, kind: 'commit' | 'tree') =>
  git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{${kind}}`]);
const pin = (binding: string, id: string, purpose: string) =>
  `refs/threadnote/cycles/${purpose}/${sha256HexSync(JSON.stringify([binding, purpose, id]))}`;

/** Ordinary integration is ancestry-preserving; it can never serve as a rebase witness. */
const verifyCommits = Effect.fn('workflowAutomation.cycle.verifyOrdinaryMerge')(function* (
  repo: string,
  proof: Pick<
    NativeCycleOrdinaryMergeReceipt,
    | 'priorHead'
    | 'currentHead'
    | 'currentBaseHead'
    | 'priorDeclaredBaseHead'
    | 'priorDeclaredBaseTree'
    | 'currentBaseTree'
  >,
) {
  for (const commit of [proof.priorHead, proof.currentHead, proof.currentBaseHead, proof.priorDeclaredBaseHead])
    if ((yield* resolve(repo, commit, 'commit')) !== commit) return yield* fail('A witnessed commit is unavailable.');
  if (
    (yield* resolve(repo, proof.priorDeclaredBaseHead, 'tree')) !== proof.priorDeclaredBaseTree ||
    (yield* resolve(repo, proof.currentBaseHead, 'tree')) !== proof.currentBaseTree
  )
    return yield* fail('The witnessed base trees changed.');
  for (const [before, after] of [
    [proof.priorDeclaredBaseHead, proof.currentBaseHead],
    [proof.priorHead, proof.currentHead],
    [proof.currentBaseHead, proof.currentHead],
  ]) {
    if (
      !(yield* nativeCycleIsAncestor(repo, before, after)) ||
      (yield* git(repo, ['merge-base', '--all', before, after])) !== before
    )
      return yield* fail('Ordinary integration requires exact ancestor and merge-base identities.');
  }
});

export const prepareNativeCycleOrdinaryMerge = Effect.fn('workflowAutomation.cycle.prepareOrdinaryMerge')(function* (
  repo: string,
  plan: NativeCyclePlan,
  phase: NativeCyclePlan['phases'][number],
  baseline: NativeCycleRuntime['baselines'][string],
  prior: NativeCycleSnapshot,
  captured: Effect.Success<ReturnType<typeof captureNativeCycleSource>>,
  input: NativeCycleOrdinaryMergeInput,
  identity: {bindingId: string; snapshotId: string; expectedRevision: string; reason: string; authority: string},
) {
  if (
    !EffectString.trim(identity.reason) ||
    !EffectString.trim(identity.authority) ||
    input.priorHead !== prior.head ||
    input.currentHead !== captured.head ||
    input.currentBaseHead === prior.declaredBaseHead ||
    baseline.preservedFiles.length ||
    (yield* resolve(repo, baseline.head, 'tree')) !== baseline.tree ||
    (yield* resolve(repo, captured.head, 'tree')) !== captured.tree ||
    (yield* resolve(repo, phase.baseBranch, 'commit')) !== input.currentBaseHead ||
    (yield* git(repo, ['branch', '--show-current'])) !== phase.branch
  )
    return yield* fail(
      'Use a clean committed ordinary integration, exact bases, predecessor, phase branch and explicit authority.',
    );
  const scope = yield* captureNativeCycleSource(repo, input.currentBaseHead);
  if (scope.head !== captured.head || scope.tree !== captured.tree)
    return yield* fail('Source changed during ordinary merge capture.');
  const changed = EffectRecord.keys(scope.files).sort();
  yield* Effect.try({
    try: () => validateNativeCycleMergeOwners(plan, input, changed),
    catch: () => fail('Supply the complete explicit owner map from the current reviewed plan.'),
  });
  const files = [...new Set([...EffectRecord.keys(captured.files), ...changed])].sort();
  const inherited = EffectArray.filter(files, file => !changed.includes(file));
  const baselineEntries = yield* readNativeCycleTreeEntries(repo, baseline.tree, files);
  const oldBaseEntries = yield* readNativeCycleTreeEntries(repo, prior.declaredBaseHead, files);
  const currentBaseEntries = yield* readNativeCycleTreeEntries(repo, input.currentBaseHead, files);
  const currentEntries = yield* readNativeCycleTreeEntries(repo, captured.tree, files);
  const evidence = (paths: readonly string[]) =>
    EffectArray.map(paths, path => ({
      path,
      baseline: baselineEntries[path],
      oldBase: oldBaseEntries[path],
      currentBase: currentBaseEntries[path],
      head: currentEntries[path],
    }));
  const proof: Omit<NativeCycleOrdinaryMergeReceipt, 'receiptDigest'> = {
    ...input,
    format: 'threadnote-native-ordinary-merge-qualification',
    version: 1,
    priorSnapshotId: prior.snapshotId,
    priorTree: prior.tree,
    priorDeclaredBaseHead: prior.declaredBaseHead,
    priorDeclaredBaseTree: yield* resolve(repo, prior.declaredBaseHead, 'tree'),
    currentBaseTree: scope.baseTree,
    baselineHead: baseline.head,
    toBaseBranch: phase.baseBranch,
    expectedRevision: identity.expectedRevision,
    reason: identity.reason,
    authority: identity.authority,
    capturedBaselinePaths: files,
    currentBaseChangedPaths: changed,
    inheritedUpstreamOnlyPaths: inherited,
    currentBaseEvidence: evidence(changed),
    upstreamEvidence: evidence(inherited),
    mergeBases: {bases: prior.declaredBaseHead, prior: prior.head, current: input.currentBaseHead},
    priorHeadRef: pin(identity.bindingId, identity.snapshotId, 'merge-prior'),
    currentHeadRef: pin(identity.bindingId, identity.snapshotId, 'merge-head'),
    priorBaseRef: pin(identity.bindingId, identity.snapshotId, 'merge-old-base'),
    currentBaseRef: pin(identity.bindingId, identity.snapshotId, 'merge-base'),
  };
  yield* verifyCommits(repo, proof);
  return {
    proof,
    pinnedRef: pin(identity.bindingId, identity.snapshotId, 'snapshot'),
    files,
    scopeBase: scope.baseTree,
    declaredBaseHead: input.currentBaseHead,
    scopeFiles: changed,
    incoming: EffectArray.map(
      EffectArray.filter(inherited, path => !phase.allowedPaths.includes(path)),
      path => ({
        path,
        ...currentBaseEntries[path],
        source: 'upstream' as const,
        tree: scope.baseTree,
        commit: input.currentBaseHead,
      }),
    ),
  };
});

/** Interruptible validation ending at the final source fence; the caller owns the retention/write critical section. */
const prepareMergeRetention = Effect.fn('workflowAutomation.cycle.prepareMergeRetention')(function* (
  repo: string,
  snapshot: NativeCycleSnapshot,
  prior: NativeCycleSnapshot,
  baseline: NativeCycleRuntime['baselines'][string],
  phase: NativeCyclePlan['phases'][number],
) {
  const proof = snapshot.ordinaryMergeQualificationV1!;
  const refs = [
    [proof.priorHeadRef, prior.head],
    [proof.currentHeadRef, snapshot.head],
    [proof.priorBaseRef, prior.declaredBaseHead],
    [proof.currentBaseRef, snapshot.declaredBaseHead],
    [snapshot.pinnedRef, snapshot.tree],
  ];
  const operations: string[] = [];
  const created: {readonly ref: string; readonly object: string}[] = [];
  for (const [ref, object] of refs) {
    const existing = yield* runCommandEffect(
      'git',
      ['--no-optional-locks', '-C', repo, 'show-ref', '--verify', '--hash', ref],
      {allowFailure: true, timeoutMs: 10_000, maxOutputBytes: 4096},
    );
    if (existing.exitCode === 0) {
      if (EffectString.trim(existing.stdout) !== object)
        return yield* fail('An immutable merge pin already names another object.');
      operations.push(`verify ${ref} ${object}`);
    } else if (existing.exitCode === 1 || existing.exitCode === 128) {
      operations.push(`create ${ref} ${object}`);
      created.push({ref, object});
    } else return yield* fail('A merge pin could not be inspected.');
  }
  const baseRef = yield* git(repo, [
    'rev-parse',
    '--symbolic-full-name',
    '--verify',
    '--end-of-options',
    phase.baseBranch,
  ]);
  if (!/^refs\/(?:heads|remotes)\/[^\s]+$/u.test(baseRef))
    return yield* fail('Use a declared branch or remote-tracking base ref.');
  yield* verifyCommits(repo, proof);
  const closing = yield* captureNativeCycleSource(repo, baseline.tree);
  if (
    closing.head !== snapshot.head ||
    closing.tree !== snapshot.tree ||
    (yield* resolve(repo, phase.baseBranch, 'commit')) !== snapshot.declaredBaseHead ||
    (yield* git(repo, ['branch', '--show-current'])) !== phase.branch ||
    (yield* resolve(repo, prior.pinnedRef, 'tree')) !== prior.tree ||
    (yield* resolve(repo, baseline.pinnedRef, 'tree')) !== baseline.tree
  )
    return yield* WorkflowAutomationError.make({
      code: 'source-drift',
      message: 'Source, phase branch, declared base or prior pins changed during ordinary merge qualification.',
    });
  const verified = new Map([
    [baseRef, snapshot.declaredBaseHead],
    [`refs/heads/${phase.branch}`, snapshot.head],
    [prior.pinnedRef, prior.tree],
    [baseline.pinnedRef, baseline.tree],
  ]);
  for (const [ref, object] of verified) operations.push(`verify ${ref} ${object}`);
  return {
    created,
    input: new TextEncoder().encode(EffectArray.join(['start', ...operations, 'prepare', 'commit', ''], '\n')),
  };
});

const recoveryRequired = (message: string) =>
  WorkflowAutomationError.make({
    code: 'ordinary-merge-recovery-required',
    message,
  });

/** A failed write is not proof of non-admission: rename can have committed before its caller observes failure. */
export const persistNativeCycleOrdinaryMerge = Effect.fn('workflowAutomation.cycle.persistOrdinaryMerge')(function* (
  config: RuntimeConfig,
  repo: string,
  snapshot: NativeCycleSnapshot,
  prior: NativeCycleSnapshot,
  baseline: NativeCycleRuntime['baselines'][string],
  phase: NativeCyclePlan['phases'][number],
  prepared: PreparedNativeWorkflowStateWrite,
  expectedRevision: string,
) {
  const {created, input} = yield* prepareMergeRetention(repo, snapshot, prior, baseline, phase);
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      // Mask only the ref transaction and settled persistence/recovery; a late rename must never race rollback.
      yield* runCommandEffect('git', ['--no-optional-locks', '-C', repo, 'update-ref', '--stdin'], {
        input,
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
      });
      const written = yield* Effect.exit(writePreparedNativeWorkflowState(config, prepared, expectedRevision));
      if (Exit.isSuccess(written)) return written.value;
      const observed = yield* Effect.exit(readNativeWorkflowState(config, prepared.state.runId));
      if (Exit.isSuccess(observed) && observed.value?.revision === prepared.revision) return observed.value;
      if (Exit.isFailure(observed) || observed.value?.revision !== expectedRevision)
        return yield* recoveryRequired(
          'Native snapshot admission could not be established after a failed write. Retention pins were kept; inspect this run and snapshot before retrying.',
        );
      if (created.length) {
        // Never delete pre-existing refs or follow a symbolic ref to another target. Expected objects fence replacements.
        const cleanup = yield* Effect.exit(
          runCommandEffect('git', ['--no-optional-locks', '-C', repo, 'update-ref', '--stdin'], {
            input: new TextEncoder().encode(
              EffectArray.join(
                [
                  'start',
                  'option no-deref',
                  ...EffectArray.map(created, item => `delete ${item.ref} ${item.object}`),
                  'prepare',
                  'commit',
                  '',
                ],
                '\n',
              ),
            ),
            timeoutMs: 30_000,
            maxOutputBytes: 4096,
          }),
        );
        if (Exit.isFailure(cleanup))
          return yield* recoveryRequired(
            'Native snapshot was not admitted, but conditional retention-pin cleanup could not be verified. Inspect this run and snapshot refs before retrying.',
          );
      }
      return yield* Effect.failCause(written.cause);
    }),
  );
});

export function hasNativeCycleMergePlanBinding(
  plans: readonly NativeCyclePlan[],
  prior: NativeCycleSnapshot,
  fromBaseBranch: string,
) {
  return EffectArray.some(plans, plan =>
    EffectArray.some(
      plan.phases,
      phase =>
        phase.id === prior.phaseId &&
        nativeCyclePhaseHash(plan, phase.id) === prior.phaseHash &&
        phase.baseBranch === fromBaseBranch,
    ),
  );
}

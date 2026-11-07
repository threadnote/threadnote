import {Array as EffectArray, String as EffectString, Option as EffectOption} from 'effect';
import {Clock, Effect, Exit, FileSystem, Record as EffectRecord} from 'effect';
import {
  CommandExecutor,
  CommandOutputLimitExceeded,
  runCommandEffect,
  type CommandOptions,
  type CommandResult,
  type BinaryCommandResult,
} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {nativeCyclePhaseHash, type NativeCyclePlan} from '@threadnote/workflow-automations/cycle';
import {
  validateNativeCycleMergeOwners,
  nativeCycleQualificationEvidenceDigest,
  nativeCycleQualificationHistory,
  type NativeCycleSameLabelRebasedBaseInput,
  type NativeCycleSameLabelRebasedBaseReceipt,
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

export const nativeCycleSameLabelQualificationLimits = {
  elapsedMs: 30_000,
  commands: 128,
  argumentBytes: 1_048_576,
  outputBytes: 8_388_608,
} as const;

/** Request-local acquisition bounds; retention and settled recovery keep their existing critical section semantics. */
export const withNativeCycleSameLabelQualificationBudget = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const executor = yield* CommandExecutor;
    const started = yield* Clock.monotonicTimeNanos;
    let commands = 0,
      argumentBytes = 0,
      outputBytes = 0;
    let retentionStarted = false;
    const exhausted = () =>
      CommandOutputLimitExceeded.make({
        executable: 'git',
        args: [],
        maxOutputBytes: nativeCycleSameLabelQualificationLimits.outputBytes,
        message: 'Same-label qualification aggregate acquisition budget exhausted.',
      });
    const admit = (args: readonly string[], options?: CommandOptions) =>
      Effect.gen(function* () {
        const remaining =
          nativeCycleSameLabelQualificationLimits.elapsedMs -
          Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000;
        const argumentsSize = EffectArray.reduce(
          args,
          0,
          (total, arg) => total + new TextEncoder().encode(arg).byteLength + 1,
        );
        if (
          remaining <= 0 ||
          commands >= nativeCycleSameLabelQualificationLimits.commands ||
          argumentBytes + argumentsSize > nativeCycleSameLabelQualificationLimits.argumentBytes ||
          outputBytes + 2 > nativeCycleSameLabelQualificationLimits.outputBytes
        )
          return yield* exhausted();
        commands++;
        argumentBytes += argumentsSize;
        return {
          ...options,
          timeoutMs: Math.max(1, Math.min(options?.timeoutMs ?? remaining, remaining)),
          // The executor limits each stream separately; reserving half bounds their combined output.
          maxOutputBytes: Math.min(
            options?.maxOutputBytes || nativeCycleSameLabelQualificationLimits.outputBytes,
            Math.floor((nativeCycleSameLabelQualificationLimits.outputBytes - outputBytes) / 2),
          ),
        };
      });
    const account = (result: CommandResult | BinaryCommandResult) =>
      Effect.gen(function* () {
        outputBytes +=
          (typeof result.stdout === 'string'
            ? new TextEncoder().encode(result.stdout).byteLength
            : result.stdout.byteLength) + new TextEncoder().encode(result.stderr).byteLength;
        if (
          outputBytes > nativeCycleSameLabelQualificationLimits.outputBytes ||
          Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000 >=
            nativeCycleSameLabelQualificationLimits.elapsedMs
        )
          return yield* exhausted();
      });
    const bounded = CommandExecutor.of({
      ...executor,
      execute: (executable, args, options) => {
        // After the closing evidence fence, never strand an admitted ref transaction or its conditional rollback.
        if (retentionStarted) return executor.execute(executable, args, options);
        if (args.includes('update-ref') && args.includes('--stdin'))
          return admit(args, options).pipe(
            Effect.flatMap(() => {
              retentionStarted = true;
              return executor.execute(executable, args, options);
            }),
          );
        return admit(args, options).pipe(
          Effect.flatMap(limits => executor.execute(executable, args, limits)),
          Effect.tap(account),
        );
      },
      ...(executor.executeBytes
        ? {
            executeBytes: (executable: string, args: readonly string[], options?: CommandOptions) =>
              retentionStarted
                ? executor.executeBytes!(executable, args, options)
                : admit(args, options).pipe(
                    Effect.flatMap(limits => executor.executeBytes!(executable, args, limits)),
                    Effect.tap(account),
                  ),
          }
        : {}),
    });
    return yield* program.pipe(Effect.provideService(CommandExecutor, bounded));
  });

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

const canonicalGitIdentity = Effect.fn('workflowAutomation.cycle.canonicalGitIdentity')(function* (repo: string) {
  const fs = yield* FileSystem.FileSystem;
  const worktreeDirectory = yield* fs.realPath(yield* git(repo, ['rev-parse', '--show-toplevel']));
  const commonDirectory = yield* fs.realPath(
    yield* git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  const gitDirectory = yield* fs.realPath(yield* git(repo, ['rev-parse', '--absolute-git-dir']));
  if (worktreeDirectory !== repo || (yield* fs.realPath(repo)) !== repo)
    return yield* fail('Use the original canonical bound worktree, without path aliases.');
  return {worktreeDirectory, commonDirectory, gitDirectory};
});
const verifyRebasedCommits = Effect.fn('workflowAutomation.cycle.verifySameLabelRebasedBase')(function* (
  repo: string,
  proof: Omit<NativeCycleSameLabelRebasedBaseReceipt, 'receiptDigest'>,
) {
  for (const commit of [proof.priorHead, proof.currentHead, proof.currentBaseHead, proof.priorDeclaredBaseHead])
    if ((yield* resolve(repo, commit, 'commit')) !== commit) return yield* fail('A retained commit is unavailable.');
  if (
    (yield* resolve(repo, proof.priorDeclaredBaseHead, 'tree')) !== proof.priorDeclaredBaseTree ||
    (yield* resolve(repo, proof.currentBaseHead, 'tree')) !== proof.currentBaseTree
  )
    return yield* fail('The witnessed base trees changed.');
  for (const [before, after] of [
    [proof.priorHead, proof.currentHead],
    [proof.currentBaseHead, proof.currentHead],
  ])
    if (
      !(yield* nativeCycleIsAncestor(repo, before, after)) ||
      (yield* git(repo, ['merge-base', '--all', before, after])) !== before
    )
      return yield* fail('Retain both the original phase HEAD and exact rewritten base ancestry.');
  const observed = yield* runCommandEffect(
    'git',
    ['--no-optional-locks', '-C', repo, 'merge-base', '--all', proof.priorDeclaredBaseHead, proof.currentBaseHead],
    {allowFailure: true, timeoutMs: 30_000, maxOutputBytes: 32_768},
  );
  if (observed.exitCode !== 0 && observed.exitCode !== 1) return yield* fail('Historical merge bases are unavailable.');
  const historical = EffectString.trim(observed.stdout)
    ? EffectString.split(EffectString.trim(observed.stdout), /\r?\n/u).sort()
    : [];
  if (JSON.stringify(historical) !== JSON.stringify(proof.historicalMergeBases))
    return yield* fail('The historical base observation changed.');
});

export const prepareNativeCycleSameLabelRebasedBase = Effect.fn('workflowAutomation.cycle.prepareSameLabelRebasedBase')(
  function* (
    repo: string,
    plan: NativeCyclePlan,
    phase: NativeCyclePlan['phases'][number],
    runtime: NativeCycleRuntime,
    prior: NativeCycleSnapshot,
    captured: Effect.Success<ReturnType<typeof captureNativeCycleSource>>,
    input: NativeCycleSameLabelRebasedBaseInput,
    identity: {bindingId: string; snapshotId: string; expectedRevision: string; reason: string; authority: string},
  ) {
    const baseline = runtime.baselines[phase.id];
    const priorEntry = EffectOption.getOrUndefined(
      EffectArray.findFirst(runtime.snapshots, item => item.snapshot.snapshotId === prior.snapshotId),
    );
    const priorReview = EffectOption.getOrUndefined(
      EffectArray.findFirst(runtime.reviews, item => item.snapshotId === prior.snapshotId),
    );
    const binding = plan.source.binding;
    const gitIdentity = yield* canonicalGitIdentity(repo);
    if (
      !baseline ||
      baseline.preservedFiles.length ||
      !priorEntry ||
      !priorReview ||
      prior.repo !== repo ||
      baseline.repo !== repo ||
      input.priorSnapshotId !== prior.snapshotId ||
      input.expectedPriorEntryDigest !== nativeCycleQualificationEvidenceDigest('predecessor-entry', priorEntry) ||
      input.expectedPriorReviewDigest !== nativeCycleQualificationEvidenceDigest('predecessor-review', priorReview) ||
      binding.bindingId !== identity.bindingId ||
      input.sameBaseBranch !== phase.baseBranch ||
      !hasNativeCycleMergePlanBinding(runtime.plans, prior, input.sameBaseBranch) ||
      !EffectString.trim(identity.reason) ||
      !EffectString.trim(identity.authority) ||
      input.authorityKind !== 'same-label-upstream-rebase-integration' ||
      input.currentHead !== captured.head ||
      input.currentBaseHead === prior.declaredBaseHead ||
      (yield* resolve(repo, captured.head, 'tree')) !== captured.tree ||
      (yield* resolve(repo, baseline.head, 'tree')) !== baseline.tree ||
      (yield* resolve(repo, prior.pinnedRef, 'tree')) !== prior.tree ||
      (yield* resolve(repo, baseline.pinnedRef, 'tree')) !== baseline.tree ||
      (yield* resolve(repo, phase.baseBranch, 'commit')) !== input.currentBaseHead ||
      (yield* git(repo, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none'])) !== '' ||
      (yield* git(repo, ['branch', '--show-current'])) !== phase.branch
    )
      return yield* fail(
        'Use retained server evidence, exact identities, clean committed source and explicit same-label rewrite authority.',
      );
    const scope = yield* captureNativeCycleSource(repo, input.currentBaseHead);
    // This independent capture includes prior-only staged additions later removed from both base and current source.
    const reconciliation = yield* captureNativeCycleSource(repo, prior.tree);
    if (
      scope.head !== captured.head ||
      scope.tree !== captured.tree ||
      reconciliation.head !== captured.head ||
      reconciliation.tree !== captured.tree
    )
      return yield* fail('Source changed during same-label qualification capture.');
    const changed = EffectRecord.keys(scope.files).sort();
    yield* Effect.try({
      try: () => validateNativeCycleMergeOwners(plan, input, changed),
      catch: () => fail('Supply every explicit current-base path owner from the reviewed plan.'),
    });
    const files = [...new Set([...EffectRecord.keys(captured.files), ...changed])].sort();
    const inherited = EffectArray.filter(files, path => !changed.includes(path));
    const reconciliationPaths = EffectRecord.keys(reconciliation.files).sort();
    const all = [...new Set([...files, ...prior.files, ...prior.scopeFiles, ...reconciliationPaths])].sort();
    const baselineEntries = yield* readNativeCycleTreeEntries(repo, baseline.tree, all);
    const declaredEntries = yield* readNativeCycleTreeEntries(repo, prior.declaredBaseHead, all);
    const priorScopeEntries = yield* readNativeCycleTreeEntries(repo, prior.scopeBase, all);
    const priorEntries = yield* readNativeCycleTreeEntries(repo, prior.tree, all);
    const currentBaseEntries = yield* readNativeCycleTreeEntries(repo, scope.baseTree, all);
    const currentEntries = yield* readNativeCycleTreeEntries(repo, captured.tree, all);
    const evidence = (paths: readonly string[]) =>
      EffectArray.map(paths, path => ({
        path,
        baseline: baselineEntries[path],
        oldBase: priorScopeEntries[path],
        currentBase: currentBaseEntries[path],
        head: currentEntries[path],
      }));
    const observed = yield* runCommandEffect(
      'git',
      ['--no-optional-locks', '-C', repo, 'merge-base', '--all', prior.declaredBaseHead, input.currentBaseHead],
      {allowFailure: true, timeoutMs: 30_000, maxOutputBytes: 32_768},
    );
    if (observed.exitCode !== 0 && observed.exitCode !== 1)
      return yield* fail('Historical merge bases are unavailable.');
    const proof: Omit<NativeCycleSameLabelRebasedBaseReceipt, 'receiptDigest'> = {
      ...input,
      ...gitIdentity,
      format: 'threadnote-native-same-label-rebased-base-integration',
      version: 1,
      independentReviewRequired: true,
      runId: binding.runId,
      generation: binding.generation,
      bindingId: binding.bindingId,
      project: plan.project,
      repo,
      phaseBranch: phase.branch,
      priorHead: prior.head,
      priorTree: prior.tree,
      priorScopeBase: prior.scopeBase,
      priorPinnedRef: prior.pinnedRef,
      priorDeclaredBaseHead: prior.declaredBaseHead,
      priorDeclaredBaseTree: yield* resolve(repo, prior.declaredBaseHead, 'tree'),
      currentBaseTree: scope.baseTree,
      baselineHead: baseline.head,
      baselineTree: baseline.tree,
      baselinePinnedRef: baseline.pinnedRef,
      fromBaseBranch: phase.baseBranch,
      toBaseBranch: phase.baseBranch,
      expectedRevision: identity.expectedRevision,
      reason: identity.reason,
      authority: identity.authority,
      capturedBaselinePaths: files,
      currentBaseChangedPaths: changed,
      inheritedUpstreamOnlyPaths: inherited,
      currentBaseEvidence: evidence(changed),
      upstreamEvidence: evidence(inherited),
      mergeBases: {prior: prior.head, current: input.currentBaseHead},
      historicalMergeBases: EffectString.trim(observed.stdout)
        ? EffectString.split(EffectString.trim(observed.stdout), /\r?\n/u).sort()
        : [],
      history: nativeCycleQualificationHistory(runtime),
      reconciliationPaths,
      sourceEvidence: EffectArray.map(all, path => ({
        path,
        baseline: baselineEntries[path],
        declaredBase: declaredEntries[path],
        priorScope: priorScopeEntries[path],
        prior: priorEntries[path],
        currentBase: currentBaseEntries[path],
        head: currentEntries[path],
      })),
      reconciliationEvidence: EffectArray.map(reconciliationPaths, path => ({
        path,
        baseline: baselineEntries[path],
        declaredBase: declaredEntries[path],
        priorScope: priorScopeEntries[path],
        prior: priorEntries[path],
        currentBase: currentBaseEntries[path],
        head: currentEntries[path],
      })),
      priorHeadRef: pin(identity.bindingId, identity.snapshotId, 'merge-prior'),
      currentHeadRef: pin(identity.bindingId, identity.snapshotId, 'merge-head'),
      priorBaseRef: pin(identity.bindingId, identity.snapshotId, 'merge-old-base'),
      currentBaseRef: pin(identity.bindingId, identity.snapshotId, 'merge-base'),
      priorScopeRef: pin(identity.bindingId, identity.snapshotId, 'merge-scope'),
    };
    yield* verifyRebasedCommits(repo, proof);
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
  },
);
/** Reused by check, review, readiness and delivery through currentSnapshot. */
export const verifyNativeCycleSameLabelRebasedBaseSource = Effect.fn('workflowAutomation.cycle.verifySameLabelSource')(
  function* (repo: string, snapshot: NativeCycleSnapshot) {
    const proof = snapshot.sameLabelRebasedBaseIntegrationV1;
    if (!proof) return;
    const identity = yield* canonicalGitIdentity(repo);
    if (
      identity.commonDirectory !== proof.commonDirectory ||
      identity.gitDirectory !== proof.gitDirectory ||
      identity.worktreeDirectory !== proof.worktreeDirectory ||
      (yield* resolve(repo, 'HEAD', 'commit')) !== snapshot.head ||
      (yield* git(repo, ['branch', '--show-current'])) !== proof.phaseBranch ||
      (yield* resolve(repo, proof.sameBaseBranch, 'commit')) !== proof.currentBaseHead ||
      (yield* git(repo, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none'])) !== ''
    )
      return yield* fail('Retain the exact qualified clean source and original Git worktree identity.');
    for (const [ref, object] of [
      [snapshot.pinnedRef, snapshot.tree],
      [proof.priorPinnedRef, proof.priorTree],
      [proof.baselinePinnedRef, proof.baselineTree],
      [proof.priorScopeRef, proof.priorScopeBase],
    ])
      if ((yield* resolve(repo, ref, 'tree')) !== object) return yield* fail('Qualified source retention changed.');
    for (const [ref, object] of [
      [proof.priorHeadRef, proof.priorHead],
      [proof.currentHeadRef, proof.currentHead],
      [proof.priorBaseRef, proof.priorDeclaredBaseHead],
      [proof.currentBaseRef, proof.currentBaseHead],
    ])
      if ((yield* resolve(repo, ref, 'commit')) !== object) return yield* fail('Qualified commit retention changed.');
    yield* verifyRebasedCommits(repo, proof);
  },
);

/** Interruptible validation ending at the final source fence; the caller owns the retention/write critical section. */
const prepareMergeRetention = Effect.fn('workflowAutomation.cycle.prepareMergeRetention')(function* (
  repo: string,
  snapshot: NativeCycleSnapshot,
  prior: NativeCycleSnapshot,
  baseline: NativeCycleRuntime['baselines'][string],
  phase: NativeCyclePlan['phases'][number],
) {
  const proof = (snapshot.ordinaryMergeQualificationV1 ?? snapshot.sameLabelRebasedBaseIntegrationV1)!;
  const refs = [
    [proof.priorHeadRef, prior.head],
    [proof.currentHeadRef, snapshot.head],
    [proof.priorBaseRef, prior.declaredBaseHead],
    [proof.currentBaseRef, snapshot.declaredBaseHead],
    [snapshot.pinnedRef, snapshot.tree],
    ...(snapshot.sameLabelRebasedBaseIntegrationV1
      ? [[snapshot.sameLabelRebasedBaseIntegrationV1.priorScopeRef, prior.scopeBase]]
      : []),
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
  if (snapshot.sameLabelRebasedBaseIntegrationV1) {
    yield* verifyRebasedCommits(repo, snapshot.sameLabelRebasedBaseIntegrationV1);
    const identity = yield* canonicalGitIdentity(repo);
    const retained = snapshot.sameLabelRebasedBaseIntegrationV1;
    if (
      identity.commonDirectory !== retained.commonDirectory ||
      identity.gitDirectory !== retained.gitDirectory ||
      identity.worktreeDirectory !== retained.worktreeDirectory
    )
      return yield* fail('The bound Git worktree identity changed.');
    if ((yield* git(repo, ['status', '--porcelain=v2', '-z', '--ignore-submodules=none'])) !== '')
      return yield* fail('Same-label qualification requires a clean contributor index and worktree.');
  } else yield* verifyCommits(repo, snapshot.ordinaryMergeQualificationV1!);
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

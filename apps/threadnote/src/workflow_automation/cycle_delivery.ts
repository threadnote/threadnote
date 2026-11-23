import {Cause, Context, Effect, Option, Schema, Array as EffectArray, String as EffectString} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {normalizeGitRemoteUrl} from '@threadnote/remote-memory/git/canonical_store';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {
  NativeCycleDeliverySchema,
  nativeCycleEffectiveParents,
  type NativeCycleDelivery,
  type NativeCycleState,
} from '@threadnote/workflow-automations/cycle';
import {nativeWatchPullRequest, observeNativeWatchPullIdentity} from './watch_provider.js';
import {stableJson} from '../workflow_memory/protocol.js';

const invalid = (reason = 'the base reference could not be verified') =>
  WorkflowAutomationError.make({
    code: 'base-ref-unverified',
    message: `PR base requires an unambiguous standard remote-tracking ref in the same GitHub repository: ${reason}.`,
  });
const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
/** Supplied by the task watch path while its exact terminal readback is locked. */
export const CurrentNativeTerminalDeliveryWatch = Context.Reference<
  ((delivery: NativeCycleDelivery) => Effect.Effect<void, WorkflowAutomationError>) | undefined
>('threadnote/NativeTerminalDeliveryWatch', {defaultValue: () => undefined});

const gitObjectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const remoteName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const supportedURL =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/u;
const sshAliasURL =
  /^(?:git@([A-Za-z0-9][A-Za-z0-9.-]{0,252}):|ssh:\/\/git@([A-Za-z0-9][A-Za-z0-9.-]{0,252})\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u;
const githubSshHosts = new Set(['github.com', 'ssh.github.com']);

const readGit = (repo: string, args: readonly string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-c', 'core.warnAmbiguousRefs=true', '-C', repo, ...args], {
    timeoutMs: 30_000,
    maxOutputBytes: 16_384,
  }).pipe(
    Effect.flatMap(result =>
      EffectString.trim(result.stderr) ? Effect.fail(undefined) : Effect.succeed(EffectString.trim(result.stdout)),
    ),
    Effect.mapError(() => invalid(`git ${args[0]} failed or printed a warning in this checkout`)),
  );

/** Absent configuration is an empty value; any other failure is unverified. */
const readGitConfig = (repo: string, args: readonly string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, 'config', ...args], {
    timeoutMs: 30_000,
    maxOutputBytes: 16_384,
    allowFailure: true,
  }).pipe(
    Effect.flatMap(result =>
      EffectString.trim(result.stderr) || (result.exitCode !== 0 && result.exitCode !== 1)
        ? Effect.fail(undefined)
        : Effect.succeed(result.exitCode === 0 ? EffectString.trim(result.stdout) : ''),
    ),
    Effect.mapError(() => invalid('git config failed or printed a warning in this checkout')),
  );

const fetchMappingFix = (remote: string) =>
  `remote ${remote} must fetch with the standard mapping or none; run git config --replace-all remote.${remote}.fetch '+refs/heads/*:refs/remotes/${remote}/*'`;

const fetchMappingIsStandard = (remote: string, mapping: string) => {
  const standard = `refs/heads/*:refs/remotes/${remote}/*`;
  return mapping === '' || mapping === standard || mapping === '+' + standard;
};

/**
 * The lowercase https GitHub repository a fetch URL reaches, or undefined. An SSH host alias counts only when
 * ssh's own resolved configuration names a GitHub host and no custom ssh command could connect elsewhere.
 */
const githubRepositoryOf = Effect.fn('workflowAutomation.cycle.githubRepositoryOf')(function* (
  repo: string,
  url: string,
) {
  if (supportedURL.test(url)) return EffectString.toLowerCase(`https://${normalizeGitRemoteUrl(url)}`);
  const alias = sshAliasURL.exec(url);
  if (!alias) return undefined;
  const environment = (yield* SystemInfo).environment();
  if (environment.GIT_SSH || environment.GIT_SSH_COMMAND || (yield* readGitConfig(repo, ['--get', 'core.sshCommand'])))
    return undefined;
  const resolved = yield* runCommandEffect('ssh', ['-G', alias[1] ?? alias[2]], {
    timeoutMs: 10_000,
    maxOutputBytes: 65_536,
  }).pipe(Effect.option);
  const hostname = Option.flatMap(resolved, result =>
    Option.fromNullishOr(/^hostname (\S+)$/mu.exec(result.stdout)?.[1]),
  );
  return Option.isSome(hostname) && githubSshHosts.has(EffectString.toLowerCase(hostname.value))
    ? EffectString.toLowerCase(`https://github.com/${alias[3]}`)
    : undefined;
});

const observe = Effect.fn('workflowAutomation.cycle.observeBaseBinding')(function* (
  repo: string,
  comparisonRef: string,
  pr: NonNullable<NativeCycleDelivery['pr']>,
  absentRef?: string,
) {
  const target = yield* Effect.try({
    try: () => nativeWatchPullRequest(pr.url),
    catch: () => invalid('the PR URL is not a GitHub pull request'),
  });
  const repository = EffectString.toLowerCase(`https://github.com/${target.owner}/${target.repo}`);
  const remotes = EffectString.split(yield* readGit(repo, ['remote']), '\n');
  if (remotes.length > 16 || !EffectArray.every(remotes, name => remoteName.test(name)))
    return yield* invalid('this checkout has more than 16 remotes or a remote name that cannot be verified');
  const ref =
    absentRef ??
    (yield* readGit(repo, ['rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', comparisonRef]));
  const candidates = EffectArray.filter(
    remotes,
    remote =>
      ref === `refs/remotes/${remote}/${pr.baseBranch}` &&
      (comparisonRef === `${remote}/${pr.baseBranch}` || comparisonRef === ref),
  );
  if (candidates.length !== 1)
    return yield* invalid(
      `${comparisonRef} must name exactly one remote-tracking branch refs/remotes/<remote>/${pr.baseBranch}`,
    );
  const remote = candidates[0];
  const mappings: string[] = [];
  for (const name of remotes) {
    const mapping = yield* readGitConfig(repo, ['--get-all', `remote.${name}.fetch`]);
    if (!fetchMappingIsStandard(name, mapping)) return yield* invalid(fetchMappingFix(name));
    mappings.push(mapping);
  }
  const url = yield* readGit(repo, ['remote', 'get-url', '--all', remote]);
  if ((yield* githubRepositoryOf(repo, url)) !== repository)
    return yield* invalid(
      `Remote ${remote} must fetch from a single github.com URL, or an SSH alias whose HostName is github.com, for ${target.owner}/${target.repo}`,
    );
  const commit = absentRef
    ? undefined
    : yield* readGit(repo, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']);
  if (commit !== undefined && !gitObjectId.test(commit)) return yield* invalid(`${ref} is not a commit`);
  return {binding: {ref, remote, repository}, witness: JSON.stringify({ref, remotes, mappings, url, commit})};
});

const observeStableBase = Effect.fn('workflowAutomation.cycle.observeStableBase')(function* (
  repo: string,
  comparisonRef: string,
  pr: NonNullable<NativeCycleDelivery['pr']>,
  absentRef?: string,
) {
  return yield* Effect.gen(function* () {
    const before = yield* observe(repo, comparisonRef, pr, absentRef);
    const after = yield* observe(repo, comparisonRef, pr, absentRef);
    if (before.witness !== after.witness)
      return yield* invalid('the remote configuration changed while it was being verified; retry');
    return before.binding;
  }).pipe(
    Effect.timeout('30 seconds'),
    Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(invalid('verifying the remote configuration timed out'))),
  );
});

/** Verify a supplied PR URL belongs to a repository declared by this checkout. */
export const verifyNativeCycleDeliveryRepository = Effect.fn('workflowAutomation.cycle.verifyDeliveryRepository')(
  function* (repo: string, input: unknown) {
    const delivery = yield* Schema.decodeUnknownEffect(NativeCycleDeliverySchema)(input, {
      onExcessProperty: 'error',
    }).pipe(
      Effect.mapError(() =>
        WorkflowAutomationError.make({code: 'invalid-cycle', message: 'Invalid delivery receipt.'}),
      ),
    );
    const pr = delivery.pr;
    if (!pr) return yield* invalid('the delivery has no PR');
    return yield* verifyNativePrRepository(repo, pr.url);
  },
);

/** New receipts receive proof here; stored exact merged replay uses the immutable domain path. */
export const bindNativeCycleDeliveryBase = Effect.fn('workflowAutomation.cycle.bindDeliveryBase')(function* (
  repo: string,
  comparisonRef: string,
  input: unknown,
) {
  const delivery = yield* Schema.decodeUnknownEffect(NativeCycleDeliverySchema)(input, {
    onExcessProperty: 'error',
  }).pipe(
    Effect.mapError(() => WorkflowAutomationError.make({code: 'invalid-cycle', message: 'Invalid delivery receipt.'})),
  );
  const pr = delivery.pr;
  if (pr?.baseRefBinding) return yield* invalid('a base binding cannot be supplied by the caller');
  if (!pr) return delivery;
  if (comparisonRef === pr.baseBranch) {
    const resolved = yield* readGit(repo, [
      'rev-parse',
      '--symbolic-full-name',
      '--verify',
      '--end-of-options',
      comparisonRef,
    ]);
    if (resolved !== `refs/heads/${pr.baseBranch}`)
      return yield* invalid(`${pr.baseBranch} must resolve to the local branch refs/heads/${pr.baseBranch}`);
    return delivery;
  }
  const baseRefBinding = yield* observeStableBase(repo, comparisonRef, pr);
  return {...delivery, pr: {...pr, baseRefBinding}};
});

/** Preserve the canonical original binding when GitHub retargeted and the exact ref was pruned. */
export const verifyNativeRetargetedBaseBinding = Effect.fn('workflowAutomation.cycle.verifyRetargetedBaseBinding')(
  function* (repo: string, comparisonRef: string, receipt: NativeCycleDelivery) {
    const pr = receipt.pr;
    if (!pr) return yield* invalid('the delivery has no PR');
    const binding = pr.baseRefBinding;
    const ref = binding?.ref ?? `refs/heads/${pr.baseBranch}`;
    const verify = (args: readonly string[]) =>
      runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args], {
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
        allowFailure: true,
      }).pipe(Effect.mapError(() => invalid('the historical PR base reference could not be checked')));
    const exists = yield* verify(['show-ref', '--verify', '--quiet', '--', ref]);
    if (exists.exitCode === 0 && !EffectString.trim(exists.stderr)) {
      const {baseRefBinding: _baseRefBinding, ...unboundPr} = pr;
      const rebound = yield* bindNativeCycleDeliveryBase(repo, comparisonRef, {...receipt, pr: unboundPr});
      if (stableJson(rebound.pr?.baseRefBinding) !== stableJson(binding))
        return yield* invalid('the historical PR base no longer matches its canonical receipt');
      return;
    }
    if (exists.exitCode !== 1 || EffectString.trim(exists.stderr))
      return yield* invalid('the historical PR base reference could not be checked');
    const shadow = yield* verify([
      '-c',
      'core.warnAmbiguousRefs=true',
      'rev-parse',
      '--symbolic-full-name',
      '--verify',
      '--quiet',
      '--end-of-options',
      comparisonRef,
    ]);
    if (shadow.exitCode !== 1 || EffectString.trim(shadow.stdout) || EffectString.trim(shadow.stderr))
      return yield* invalid('another reference now resolves the historical PR base');
    if (binding) {
      const verified = yield* observeStableBase(repo, comparisonRef, pr, ref);
      if (stableJson(verified) !== stableJson(binding))
        return yield* invalid('the historical PR base no longer matches its canonical receipt');
    } else if (comparisonRef !== pr.baseBranch) {
      return yield* invalid('the historical PR base no longer matches its canonical receipt');
    }
  },
);

/** Bind a monitor to a repository without requiring a workflow delivery receipt. */
export const verifyNativePrRepository = Effect.fn('workflowAutomation.verifyPrRepository')(function* (
  repo: string,
  prUrl: string,
) {
  const target = yield* Effect.try({
    try: () => nativeWatchPullRequest(prUrl),
    catch: () => invalid('the PR URL is not a GitHub pull request'),
  });
  const repository = EffectString.toLowerCase(`https://github.com/${target.owner}/${target.repo}`);
  const remotes = EffectString.split(yield* readGit(repo, ['remote']), '\n');
  if (remotes.length > 16 || !EffectArray.every(remotes, name => remoteName.test(name)))
    return yield* invalid('this checkout has more than 16 remotes or a remote name that cannot be verified');
  let matchedRepository = false;
  for (const remote of remotes) {
    const urls = EffectString.split(yield* readGit(repo, ['remote', 'get-url', '--all', remote]), '\n');
    const matchingUrls: string[] = [];
    for (const url of urls) if ((yield* githubRepositoryOf(repo, url)) === repository) matchingUrls.push(url);
    if (matchingUrls.length > 0) {
      if (urls.length !== 1 || matchingUrls.length !== 1)
        return yield* invalid(`Remote ${remote} must have exactly one fetch URL`);
      matchedRepository = true;
    }
    const mapping = yield* readGitConfig(repo, ['--get-all', `remote.${remote}.fetch`]);
    if (!fetchMappingIsStandard(remote, mapping)) return yield* invalid(fetchMappingFix(remote));
  }
  if (!matchedRepository)
    return yield* invalid(
      `no remote fetches from github.com/${target.owner}/${target.repo}, directly or through an SSH alias whose HostName is github.com`,
    );
  return {repository};
});

/** Read commit objects directly, without grafts, replacements, a commit-graph cache or lazy fetching. */
const ancestryGit = (checkout: string, args: readonly string[], input?: Uint8Array) =>
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    return yield* runCommandEffect(
      'git',
      [
        '--no-optional-locks',
        '--no-replace-objects',
        '-c',
        'core.commitGraph=false',
        '-c',
        'advice.graftFileDeprecated=false',
        '-C',
        checkout,
        ...args,
      ],
      {
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
        allowFailure: true,
        // Git for Windows maps /dev/null to NUL. An empty path can warn during commit parsing.
        env: {...system.environment(), GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null', GIT_TEST_COMMIT_GRAPH: '0'},
        ...(input ? {input} : {}),
      },
    );
  });

/** Whether `ancestor` is `descendant` or one of its ancestors. Threadnote never fetches a missing commit. */
export const nativeCommitDescends = Effect.fn('workflowAutomation.cycle.commitDescends')(function* (
  checkout: string,
  ancestor: string,
  descendant: string,
) {
  if (ancestor === descendant) return true;
  const shallow = yield* ancestryGit(checkout, ['rev-parse', '--is-shallow-repository']);
  if (shallow.exitCode !== 0 || EffectString.trim(shallow.stdout) !== 'false')
    return yield* fail(
      'merged-head-unavailable',
      'This checkout is shallow, so its commit ancestry is incomplete. Run git fetch --unshallow, then retry; Threadnote does not fetch.',
    );
  for (const commit of [ancestor, descendant])
    if ((yield* ancestryGit(checkout, ['cat-file', '-e', `${commit}^{commit}`])).exitCode !== 0)
      return yield* fail(
        'merged-head-unavailable',
        `Commit ${commit} of the merged PR is not in this checkout. Run git fetch, then retry; Threadnote does not fetch.`,
      );
  const {exitCode} = yield* ancestryGit(checkout, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (exitCode > 1)
    return yield* fail('merged-head-unavailable', 'git merge-base could not compare the phase and merged PR heads.');
  return exitCode === 0;
});

/**
 * A merged PR can end above a phase's own delivered head when later phases or reviewed maintenance pushed to the
 * same PR. The receipt keeps the delivered head and its terminal watch keeps the merged head, which must descend
 * from it in this checkout.
 */
export const verifyNativeMergedPhaseHead = Effect.fn('workflowAutomation.cycle.verifyMergedPhaseHead')(function* (
  checkout: string,
  deliveredHead: string,
  mergedHead: string,
) {
  if (!(yield* nativeCommitDescends(checkout, deliveredHead, mergedHead)))
    return yield* fail(
      'merged-head-mismatch',
      `The phase head ${deliveredHead} is not an ancestor of the merged PR head ${mergedHead}.`,
    );
});

/** Caller fields and opaque refs are evidence to compare, never proof that this observation occurred. */
const observeDeliveryIdentity = (
  checkout: string,
  receipt: NativeCycleDelivery | undefined,
  options: {
    readonly allowMerged?: boolean;
    readonly requireEvidence?: boolean;
    readonly allowRetarget?: boolean;
  },
) =>
  Effect.gen(function* () {
    const allowMerged = options.allowMerged === true;
    if (!receipt?.pr) return yield* fail('invalid-pr-receipt', 'PR delivery evidence is missing.');
    if (
      options.requireEvidence &&
      (!receipt.userAuthority || !EffectString.trim(receipt.userAuthority) || !receipt.providerIdentity)
    )
      return yield* fail(
        'user-authority-required',
        'A first canonical PR delivery requires actual userAuthority and provider evidence, followed by fresh runtime verification.',
      );
    yield* verifyNativeCycleDeliveryRepository(checkout, receipt);
    const observation = yield* observeNativeWatchPullIdentity(receipt.pr.url);
    const {identity} = observation;
    const retargeted = identity.baseBranch !== receipt.pr.baseBranch;
    const target = nativeWatchPullRequest(receipt.pr.url);
    const mayRetarget = options.allowRetarget && identity.state === 'merged' && receipt.pr.state === 'merged';

    // A merged PR reports its final head, which a terminal receipt keeps on its watch.
    const providerHead =
      allowMerged && identity.state === 'merged' && receipt.watch?.state === 'terminal'
        ? receipt.watch.headSha
        : receipt.headSha;
    if (
      EffectString.toLowerCase(identity.headRepository) !== EffectString.toLowerCase(identity.baseRepository) ||
      identity.headSha !== providerHead ||
      identity.headBranch !== receipt.pr.branch ||
      (retargeted &&
        (!mayRetarget ||
          EffectString.toLowerCase(identity.baseRepository) !==
            EffectString.toLowerCase(`${target.owner}/${target.repo}`))) ||
      (identity.state !== receipt.pr.state && !(allowMerged && identity.state === 'merged'))
    )
      return yield* fail(
        'pr-source-mismatch',
        'The remote PR repository, branches, state and exact head must match the validated phase.',
      );
    if (providerHead !== receipt.headSha) yield* verifyNativeMergedPhaseHead(checkout, receipt.headSha, providerHead);
    const retainedIdentity = receipt.providerIdentity;
    if (
      retainedIdentity &&
      stableJson({
        ...identity,
        baseBranch: receipt.pr.baseBranch,
        headSha: receipt.headSha,
        state: allowMerged ? retainedIdentity.state : identity.state,
      }) !== stableJson(retainedIdentity)
    )
      return yield* fail('pr-source-mismatch', 'The provider identity changed from its exact provisional evidence.');
    return {...observation, retargeted};
  });

const unverifiedRetarget = (reason: string) =>
  fail('pr-source-mismatch', `The merged PR's retargeted base could not be verified: ${reason}.`);

const mergedObject = (value: string | undefined) =>
  value !== undefined && gitObjectId.test(value) ? value : undefined;

const requireRetargetCommit = (checkout: string, commit: string) =>
  ancestryGit(
    checkout,
    ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    new TextEncoder().encode(commit + '\n'),
  ).pipe(
    Effect.flatMap(result =>
      result.exitCode === 0 &&
      !EffectString.trim(result.stderr) &&
      EffectString.trim(result.stdout) === `${commit} commit`
        ? Effect.void
        : Effect.fail(
            unverifiedRetarget(`Git could not read commit ${commit} in this checkout; run git fetch, then retry`),
          ),
    ),
  );

const readMergeObject = Effect.fn('workflowAutomation.cycle.readMergeObject')(function* (
  checkout: string,
  commit: string,
  suffix: '^{tree}' | '^1',
) {
  const result = yield* ancestryGit(checkout, ['rev-parse', '--verify', '--end-of-options', commit + suffix]);
  const object = mergedObject(EffectString.trim(result.stdout));
  if (result.exitCode !== 0 || EffectString.trim(result.stderr) || !object)
    return yield* unverifiedRetarget(
      `Git could not read ${commit}${suffix} in this checkout; run git fetch, then retry`,
    );
  return object;
});

const mergedPredecessor = (state: NativeCycleState, current: NativeCycleDelivery) => {
  const parents = nativeCycleEffectiveParents(state.plan, current.phaseId);
  const matching = EffectArray.filter(
    state.plan.phases,
    phase => parents.includes(phase.id) && phase.branch === current.pr?.baseBranch,
  );
  if (matching.length !== 1)
    return Effect.fail(unverifiedRetarget('the original PR base does not name one declared predecessor'));
  const predecessor = state.phases[matching[0].id];
  const {delivery} = predecessor;
  if (predecessor.status !== 'merged' || delivery?.pr?.state !== 'merged' || delivery.pr.url === current.pr?.url)
    return Effect.fail(unverifiedRetarget(`predecessor ${matching[0].id} has no distinct canonical merged PR receipt`));
  return Effect.succeed({...delivery, pr: delivery.pr});
};

export const verifyNativeCyclePrDeliveryIdentity = (
  checkout: string,
  receipt: NativeCycleDelivery | undefined,
  options: {
    readonly allowMerged?: boolean;
    readonly requireEvidence?: boolean;
    /** Canonical state, supplied only while closing a previously published PR. */
    readonly historicalState?: NativeCycleState;
  } = {},
) =>
  Effect.gen(function* () {
    const state = options.historicalState;
    const observed = yield* observeDeliveryIdentity(checkout, receipt, {...options, allowRetarget: !!state});
    const {identity} = observed;
    if (!receipt?.pr || !state || !observed.retargeted) return identity;
    const targetBranch = identity.baseBranch;
    const targetRepository = EffectString.toLowerCase(identity.baseRepository);
    const commit = mergedObject(observed.mergeCommit);
    if (!commit) return yield* unverifiedRetarget('GitHub did not return the merge commit');
    yield* requireRetargetCommit(checkout, commit);
    if ((yield* readMergeObject(checkout, commit, '^{tree}')) !== receipt.validatedTree)
      return yield* unverifiedRetarget('the merge result tree differs from the validated phase tree');

    const predecessor = yield* mergedPredecessor(state, receipt);
    const previous = yield* observeDeliveryIdentity(checkout, predecessor, {allowMerged: true, allowRetarget: true});
    const previousCommit = mergedObject(previous.mergeCommit);
    if (!previousCommit)
      return yield* unverifiedRetarget(`GitHub did not return the merge commit for predecessor ${predecessor.phaseId}`);
    const predecessorTarget = nativeWatchPullRequest(predecessor.pr.url);
    if (
      EffectString.toLowerCase(`${predecessorTarget.owner}/${predecessorTarget.repo}`) !== targetRepository ||
      EffectString.toLowerCase(previous.identity.baseRepository) !== targetRepository ||
      previous.identity.baseBranch !== targetBranch
    )
      return yield* unverifiedRetarget(
        `predecessor ${predecessor.phaseId} did not merge into the same GitHub repository and target branch`,
      );
    // Walk canonical merged receipts to confirm the target belongs to this stack. Earlier
    // retargets already passed terminal delivery. Only the immediate predecessor needs a fresh read.
    let ancestor = predecessor;
    while (ancestor.pr.baseBranch !== targetBranch) {
      ancestor = yield* mergedPredecessor(state, ancestor);
      const origin = nativeWatchPullRequest(ancestor.pr.url);
      if (EffectString.toLowerCase(`${origin.owner}/${origin.repo}`) !== targetRepository)
        return yield* unverifiedRetarget(`predecessor ${ancestor.phaseId} belongs to a different GitHub repository`);
    }
    yield* requireRetargetCommit(checkout, previousCommit);
    const targetParent = yield* readMergeObject(checkout, commit, '^1');
    yield* requireRetargetCommit(checkout, targetParent);
    const shallow = yield* ancestryGit(checkout, ['rev-parse', '--is-shallow-repository']);
    if (shallow.exitCode !== 0 || EffectString.trim(shallow.stderr) || EffectString.trim(shallow.stdout) !== 'false')
      return yield* unverifiedRetarget(
        'this checkout does not have complete commit ancestry; run git fetch --unshallow, then retry',
      );
    const ancestry = yield* ancestryGit(checkout, ['merge-base', '--is-ancestor', previousCommit, targetParent]);
    if (ancestry.exitCode !== 0 || EffectString.trim(ancestry.stderr))
      return yield* unverifiedRetarget(
        `predecessor ${predecessor.phaseId} merge is absent from the merge result’s target-side history`,
      );
    return identity;
  });

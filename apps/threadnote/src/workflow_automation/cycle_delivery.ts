import {Cause, Effect, Schema, Array as EffectArray, String as EffectString} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {normalizeGitRemoteUrl} from '@threadnote/remote-memory/git/canonical_store';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {NativeCycleDeliverySchema, type NativeCycleDelivery} from '@threadnote/workflow-automations/cycle';
import {nativeWatchPullRequest} from './watch_provider.js';

const invalid = () =>
  WorkflowAutomationError.make({
    code: 'base-ref-unverified',
    message: 'PR base requires an unambiguous standard remote-tracking ref in the same GitHub repository.',
  });
const remoteName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const supportedURL =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/u;

const readGit = (repo: string, args: readonly string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-c', 'core.warnAmbiguousRefs=true', '-C', repo, ...args], {
    timeoutMs: 30_000,
    maxOutputBytes: 16_384,
  }).pipe(
    Effect.flatMap(result =>
      EffectString.trim(result.stderr) ? Effect.fail(invalid()) : Effect.succeed(EffectString.trim(result.stdout)),
    ),
    Effect.mapError(invalid),
  );

const observe = Effect.fn('workflowAutomation.cycle.observeBaseBinding')(function* (
  repo: string,
  comparisonRef: string,
  pr: NonNullable<NativeCycleDelivery['pr']>,
) {
  const target = yield* Effect.try({try: () => nativeWatchPullRequest(pr.url), catch: invalid});
  const repository = EffectString.toLowerCase(`https://github.com/${target.owner}/${target.repo}`);
  const remotes = EffectString.split(yield* readGit(repo, ['remote']), '\n');
  if (remotes.length > 16 || !EffectArray.every(remotes, name => remoteName.test(name))) return yield* invalid();
  const ref = yield* readGit(repo, [
    'rev-parse',
    '--symbolic-full-name',
    '--verify',
    '--end-of-options',
    comparisonRef,
  ]);
  const candidates = EffectArray.filter(
    remotes,
    remote =>
      ref === `refs/remotes/${remote}/${pr.baseBranch}` &&
      (comparisonRef === `${remote}/${pr.baseBranch}` || comparisonRef === ref),
  );
  if (candidates.length !== 1) return yield* invalid();
  const remote = candidates[0];
  const mappings: string[] = [];
  for (const name of remotes) {
    const mapping = yield* readGit(repo, ['config', '--get-all', `remote.${name}.fetch`]);
    const standard = `refs/heads/*:refs/remotes/${name}/*`;
    if (mapping !== standard && mapping !== '+' + standard) return yield* invalid();
    mappings.push(mapping);
  }
  const url = yield* readGit(repo, ['remote', 'get-url', '--all', remote]);
  if (!supportedURL.test(url) || EffectString.toLowerCase(`https://${normalizeGitRemoteUrl(url)}`) !== repository)
    return yield* invalid();
  const commit = yield* readGit(repo, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) return yield* invalid();
  return {binding: {ref, remote, repository}, witness: JSON.stringify({ref, remotes, mappings, url, commit})};
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
    if (!pr) return yield* invalid();
    const target = yield* Effect.try({try: () => nativeWatchPullRequest(pr.url), catch: invalid});
    const repository = EffectString.toLowerCase(`https://github.com/${target.owner}/${target.repo}`);
    const remotes = EffectString.split(yield* readGit(repo, ['remote']), '\n');
    if (remotes.length > 16 || !EffectArray.every(remotes, name => remoteName.test(name))) return yield* invalid();
    let matchedRepository = false;
    for (const remote of remotes) {
      const urls = EffectString.split(yield* readGit(repo, ['remote', 'get-url', '--all', remote]), '\n');
      const matchingUrls = EffectArray.filter(
        urls,
        url =>
          supportedURL.test(url) && EffectString.toLowerCase(`https://${normalizeGitRemoteUrl(url)}`) === repository,
      );
      if (matchingUrls.length > 0) {
        if (urls.length !== 1 || matchingUrls.length !== 1) return yield* invalid();
        matchedRepository = true;
      }
      const mapping = yield* readGit(repo, ['config', '--get-all', `remote.${remote}.fetch`]);
      const standard = `refs/heads/*:refs/remotes/${remote}/*`;
      if (mapping !== standard && mapping !== '+' + standard) return yield* invalid();
    }
    if (!matchedRepository) return yield* invalid();
    return {repository};
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
  if (pr?.baseRefBinding) return yield* invalid();
  if (!pr || comparisonRef === pr.baseBranch) return delivery;
  return yield* Effect.gen(function* () {
    const before = yield* observe(repo, comparisonRef, pr);
    const after = yield* observe(repo, comparisonRef, pr);
    if (before.witness !== after.witness) return yield* invalid();
    return {...delivery, pr: {...pr, baseRefBinding: before.binding}};
  }).pipe(
    Effect.timeout('30 seconds'),
    Effect.catchIf(Cause.isTimeoutError, () => Effect.fail(invalid())),
  );
});

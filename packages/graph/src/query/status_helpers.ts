import {Array as EffectArray} from 'effect';
import {Deferred, Effect, Option} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import type {CodeGraphUntrackedStatusCacheOptions} from '../git/status_cache.js';
import {worktreeOverlayState} from '../inventory.js';
import {prepareCodeGraphLocalAssociationObservation} from '../local_provenance.js';
import {withCodeGraphQueryTelemetryStage, type CodeGraphStatusOptions} from './contract.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {
  resolveRepositoryIdentityForExpectation,
  resolveRepositoryIdentityForExpectationAndWorktree,
  startRepositoryWorktreeObservation,
  type RepositoryIdentityMetadata,
} from '../repository.js';
import type {CodeGraphLanguagePackStatus, RepositoryIdentity, RepositoryIdentityExpectation} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function repositoryIdentityObservation(identity: RepositoryIdentity) {
  return {identity, worktreeChanged: undefined as boolean | undefined};
}

const observePostPromotionOnce = Effect.fn('codeGraph.observePostPromotionOnce')(function* (
  identity: RepositoryIdentity,
) {
  // Porcelain v2 reports the exact HEAD and the clean/changed bit in one
  // bounded process. Only a changed worktree pays for the policy-aware overlay
  // observation that distinguishes admitted source from excluded files.
  const result = yield* runCommandEffect(
    'git',
    ['-C', identity.repoRoot, 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'],
    {maxOutputBytes: 1_048_576, timeoutMs: 5_000},
  ).pipe(Effect.option);
  if (Option.isNone(result) || !Effect2.pipe(result.value.stdout, EffectString.endsWith('\0'))) {
    return {headCommit: undefined, overlay: undefined};
  }
  const records = Effect2.pipe(result.value.stdout, __effectPipeInput => {
    const __effectPipeStage0 = Effect2.pipe(__effectPipeInput, EffectString.slice(0, -1));
    const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.split('\0'));
    return __effectPipeStage1;
  });
  const headRecords = EffectArray.filter(records, record =>
    Effect2.pipe(record, EffectString.startsWith('# branch.oid ')),
  );
  const headCommit =
    headRecords.length === 1 ? Effect2.pipe(headRecords[0], EffectString.slice('# branch.oid '.length)) : undefined;
  const expectedLength = identity.objectFormat === 'sha256' ? 64 : 40;
  if (headCommit === undefined || !new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(headCommit)) {
    return {headCommit: undefined, overlay: undefined};
  }
  if (EffectArray.every(records, record => Effect2.pipe(record, EffectString.startsWith('# ')))) {
    return {headCommit, overlay: {dirty: false, fingerprint: undefined}};
  }
  const overlay = yield* worktreeOverlayState(identity).pipe(Effect.option);
  return {headCommit, overlay: Option.getOrUndefined(overlay)};
});

export const postPromotionObservation = Effect.fn('codeGraph.postPromotionObservation')(function* (
  identity: RepositoryIdentity,
) {
  const first = yield* observePostPromotionOnce(identity);
  if (first.headCommit !== undefined && first.overlay !== undefined) return first;
  // A process spawn, bounded output read, or policy-aware overlay observation
  // may fail transiently under host contention. Retry once, then preserve the
  // existing fail-closed result if publication still cannot be proved.
  yield* Effect.yieldNow;
  return yield* observePostPromotionOnce(identity);
});

export function resolvePublishedRepositoryIdentityObservation(
  cwd: string,
  expected: RepositoryIdentityExpectation,
  observeWorktree: boolean,
  cache?: CodeGraphUntrackedStatusCacheOptions,
) {
  return observeWorktree
    ? resolveRepositoryIdentityForExpectationAndWorktree(cwd, expected, cache).pipe(
        Effect.map(observation => ({
          ...observation,
          worktreeChanged: observation.worktreeChanged as boolean | undefined,
        })),
      )
    : resolveRepositoryIdentityForExpectation(cwd, expected).pipe(
        Effect.map(identity => repositoryIdentityObservation(identity)),
      );
}

export function codeGraphLanguagePackStatuses(
  registry: CodeGraphLanguagePackRegistryShape,
): readonly CodeGraphLanguagePackStatus[] {
  return EffectArray.map(registry.packs, pack => ({
    assetCount: pack.assets.length,
    capabilities: [...pack.capabilities].sort(),
    extractorVersion: pack.extractor.version,
    id: pack.id,
    languages: [...new Set(EffectArray.map(pack.files, matcher => matcher.language))].sort(),
    resolutionDomain: pack.resolutionStrategy.domain,
    resolutionVersion: pack.resolutionStrategy.version,
    roles: [...new Set(EffectArray.map(pack.files, matcher => matcher.role))].sort(),
    version: pack.version,
    workspaceDetection: Option.isSome(pack.workspaceDetector),
  }));
}

/** Keep the initial worktree read alive through the caller's scoped status session. */
export const observeCodeGraphStatusSessionIdentity = Effect.fn('codeGraph.observeStatusSessionIdentity')(function* (
  threadnoteHome: string,
  cwd: string,
  expected: RepositoryIdentityExpectation | undefined,
  options: CodeGraphStatusOptions,
) {
  const metadata = yield* Deferred.make<RepositoryIdentityMetadata | undefined>();
  const pendingWorktree =
    expected === undefined && options.observeWorktree !== false && options.afterIdentityObserved === undefined
      ? yield* startRepositoryWorktreeObservation(cwd, {cache: {threadnoteHome}, metadata: Deferred.await(metadata)})
      : undefined;
  const observation = yield* expected === undefined
    ? withCodeGraphQueryTelemetryStage(
        options.telemetry,
        'graph.query.status',
        'query-repository-identity',
        prepareCodeGraphLocalAssociationObservation(
          threadnoteHome,
          cwd,
          pendingWorktree === undefined
            ? undefined
            : observed => Deferred.succeed(metadata, observed).pipe(Effect.asVoid),
        ),
      ).pipe(
        Effect.map(local => ({
          ...repositoryIdentityObservation(local.identity),
          observeTogether: local.observeTogether,
        })),
      )
    : withCodeGraphQueryTelemetryStage(
        options.telemetry,
        'graph.query.status',
        'query-repository-identity',
        resolvePublishedRepositoryIdentityObservation(cwd, expected, options.observeWorktree !== false, {
          threadnoteHome,
        }),
      );
  const identity = observation.identity;
  const changed =
    options.afterIdentityObserved === undefined
      ? pendingWorktree === undefined
        ? observation.worktreeChanged
        : pendingWorktree(identity)
      : undefined;
  return {
    identity,
    worktreeChanged: changed,
    observeTogether:
      'observeTogether' in observation ? observation.observeTogether : <A, E, R>(read: Effect.Effect<A, E, R>) => read,
  };
});

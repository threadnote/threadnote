import {Effect, Option} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {worktreeOverlayState} from '../inventory.js';
import {resolveAndRecordCodeGraphLocalAssociation} from '../local_provenance.js';
import {withCodeGraphQueryTelemetryStage, type CodeGraphStatusOptions} from './contract.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {
  resolveRepositoryIdentityForExpectation,
  resolveRepositoryIdentityForExpectationAndWorktree,
  startRepositoryWorktreeObservation,
} from '../repository.js';
import type {CodeGraphLanguagePackStatus, RepositoryIdentity, RepositoryIdentityExpectation} from '../types.js';

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
  if (Option.isNone(result) || !result.value.stdout.endsWith('\0')) {
    return {headCommit: undefined, overlay: undefined};
  }
  const records = result.value.stdout.slice(0, -1).split('\0');
  const headRecords = records.filter(record => record.startsWith('# branch.oid '));
  const headCommit = headRecords.length === 1 ? headRecords[0].slice('# branch.oid '.length) : undefined;
  const expectedLength = identity.objectFormat === 'sha256' ? 64 : 40;
  if (headCommit === undefined || !new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(headCommit)) {
    return {headCommit: undefined, overlay: undefined};
  }
  if (records.every(record => record.startsWith('# '))) {
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
) {
  return observeWorktree
    ? resolveRepositoryIdentityForExpectationAndWorktree(cwd, expected).pipe(
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
  return registry.packs.map(pack => ({
    assetCount: pack.assets.length,
    capabilities: [...pack.capabilities].sort(),
    extractorVersion: pack.extractor.version,
    id: pack.id,
    languages: [...new Set(pack.files.map(matcher => matcher.language))].sort(),
    resolutionDomain: pack.resolutionStrategy.domain,
    resolutionVersion: pack.resolutionStrategy.version,
    roles: [...new Set(pack.files.map(matcher => matcher.role))].sort(),
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
  const pendingWorktree =
    expected === undefined && options.observeWorktree !== false && options.afterIdentityObserved === undefined
      ? yield* startRepositoryWorktreeObservation(cwd)
      : undefined;
  const observation = yield* expected === undefined
    ? withCodeGraphQueryTelemetryStage(
        options.telemetry,
        'graph.query.status',
        'query-repository-identity',
        resolveAndRecordCodeGraphLocalAssociation(threadnoteHome, cwd),
      ).pipe(Effect.map(local => repositoryIdentityObservation(local.identity)))
    : withCodeGraphQueryTelemetryStage(
        options.telemetry,
        'graph.query.status',
        'query-repository-identity',
        resolvePublishedRepositoryIdentityObservation(cwd, expected, options.observeWorktree !== false),
      );
  const identity = observation.identity;
  const changed =
    options.afterIdentityObserved === undefined
      ? pendingWorktree === undefined
        ? observation.worktreeChanged
        : pendingWorktree(identity)
      : undefined;
  return {identity, worktreeChanged: changed};
});

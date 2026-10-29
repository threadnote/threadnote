import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Crypto, Effect, FileSystem, Path, Schema} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import {
  observeCodeGraphWorktreeReconciliationAuthority,
  type CodeGraphWorktreeReconciliationAuthorityObservation,
  type CodeGraphWorktreeReconciliationAuthorityTarget,
} from './git/worktree/registration.js';
import {
  readCodeGraphWorktreeReconciliationEvidenceCandidate,
  sameCodeGraphWorktreeReconciliationEvidenceCandidate,
  type CodeGraphWorktreeReconciliationEvidenceCandidate,
} from './local_provenance.js';
import {
  codeGraphMaintenanceIntentActive,
  CodeGraphMaintenanceActiveError,
  withCodeGraphTargetWorktreeLock,
} from './maintenance/gate.js';
import {classifyCodeGraphLifecycle, type CodeGraphLifecycleProtection} from './lifecycle/classification.js';
import {resolveRepositoryIdentity} from './repository.js';
import {
  CodeGraphStore,
  type CodeGraphRemovedViewCleanupEvidence,
  type CodeGraphViewRemovalResult,
  type CodeGraphWorktreeReconciliationCandidate,
} from './store.js';
import {CodeGraphStoreBusyError, type RepositoryIdentity} from './types.js';
import {inspectCodeGraphViewDatabaseTarget} from './view_removal.js';
import {reconcileCodeGraphScopeRetirements} from './scope/retirement.js';

export {type CodeGraphWorktreeReconciliationCandidate} from './store.js';

export const CODE_GRAPH_WORKTREE_RECONCILIATION_CANDIDATE_LIMIT = 32;

class CodeGraphWorktreeAuthorityChanged extends Schema.TaggedError<
  CodeGraphWorktreeAuthorityChanged,
  {readonly brand: unique symbol}
>()('CodeGraphWorktreeAuthorityChanged', {message: Schema.String}) {}

export interface CodeGraphWorktreeReconciliationAuthorityInput {
  readonly anchorMatches: boolean;
  readonly evidenceStable: boolean;
  readonly finalRegistryState: 'absent' | 'present' | 'unknown';
  readonly initialRegistryState: 'absent' | 'present' | 'unknown';
  readonly maintenanceActive: boolean;
  readonly missingEvidence: boolean;
  readonly registrationKind: 'linked' | 'main';
  readonly registryRootStable: boolean;
}

export function codeGraphWorktreeReconciliationAuthorized(
  input: CodeGraphWorktreeReconciliationAuthorityInput,
): boolean {
  const authorityProven =
    input.anchorMatches &&
    input.evidenceStable &&
    input.finalRegistryState === 'absent' &&
    input.initialRegistryState === 'absent' &&
    input.missingEvidence &&
    input.registrationKind === 'linked' &&
    input.registryRootStable;
  const protections: CodeGraphLifecycleProtection[] = input.maintenanceActive ? ['active-maintenance'] : [];
  return (
    classifyCodeGraphLifecycle({
      authority: authorityProven ? 'proven-disposable' : 'unproven',
      protections,
      state: 'missing-view',
    }).disposition === 'reclaim'
  );
}

export interface CodeGraphWorktreeReconciliationTick {
  readonly anchorIdentity?: RepositoryIdentity;
  readonly anchorPath?: string;
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly threadnoteHome: string;
  readonly writerLockPath: string;
}

export type CodeGraphWorktreeReconciliationResult =
  | {
      readonly expectedSnapshotId: string;
      readonly nextCursor: string;
      readonly retiredSnapshots: number;
      readonly state: 'removed';
      readonly worktreeId: string;
    }
  | {
      readonly nextCursor?: string;
      readonly reason:
        | 'already-removed'
        | 'anchor-unavailable'
        | 'evidence-changed'
        | 'external-maintenance'
        | 'no-anchor'
        | 'no-candidates'
        | 'no-missing-candidates'
        | 'registered'
        | 'registry-changed'
        | 'stale-target';
      readonly state: 'preserved';
    }
  | {
      readonly nextCursor?: string;
      readonly reason: 'catalog-unavailable' | 'registry-unavailable' | 'target-busy' | 'writer-busy';
      readonly state: 'deferred';
    };

export interface CodeGraphWorktreeReconciliationDependencies {
  readonly retireScopes?: (
    input: CodeGraphWorktreeReconciliationTick,
    candidates: readonly CodeGraphWorktreeReconciliationCandidate[],
  ) => Effect.Effect<
    | {readonly candidate: CodeGraphWorktreeReconciliationCandidate; readonly result: CodeGraphViewRemovalResult}
    | undefined,
    unknown
  >;
  readonly listCandidates: (
    input: CodeGraphWorktreeReconciliationTick,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphWorktreeReconciliationCandidate[], unknown>;
  readonly maintenanceIntentActive: (threadnoteHome: string) => Effect.Effect<boolean, unknown>;
  readonly observeAuthority: (
    identity: Pick<RepositoryIdentity, 'checkoutId' | 'gitCommonDirectory'>,
    targets: readonly CodeGraphWorktreeReconciliationAuthorityTarget[],
  ) => Effect.Effect<CodeGraphWorktreeReconciliationAuthorityObservation, unknown>;
  readonly readEvidenceCandidate: (
    threadnoteHome: string,
    target: {readonly checkoutId: string; readonly repositoryId: string; readonly worktreeId: string},
  ) => Effect.Effect<CodeGraphWorktreeReconciliationEvidenceCandidate, unknown>;
  readonly removeView: (
    input: CodeGraphWorktreeReconciliationTick,
    candidate: CodeGraphWorktreeReconciliationCandidate,
    cleanupEvidence: CodeGraphRemovedViewCleanupEvidence,
  ) => Effect.Effect<CodeGraphViewRemovalResult, unknown>;
  readonly resolveAnchor: (cwd: string) => Effect.Effect<RepositoryIdentity, unknown>;
  readonly withTargetLock: <A, E>(
    input: CodeGraphWorktreeReconciliationTick,
    worktreeId: string,
    effect: Effect.Effect<A, E>,
    scopeId?: string,
  ) => Effect.Effect<A, E | unknown>;
}

export interface CodeGraphWorktreeReconcilerShape {
  readonly tick: (
    input: CodeGraphWorktreeReconciliationTick,
  ) => Effect.Effect<CodeGraphWorktreeReconciliationResult, never>;
}

interface MissingCandidate {
  readonly candidate: CodeGraphWorktreeReconciliationCandidate;
  readonly evidence: Extract<CodeGraphWorktreeReconciliationEvidenceCandidate, {readonly state: 'candidate'}>;
}

export const makeCodeGraphWorktreeReconciler = Effect.fn('codeGraph.makeWorktreeReconciler')(
  (dependencies: CodeGraphWorktreeReconciliationDependencies) =>
    Effect.sync(() => {
      const tick = (input: CodeGraphWorktreeReconciliationTick) =>
        Effect.gen(function* () {
          let expectedAnchor = input.anchorIdentity;
          if (expectedAnchor !== undefined && expectedAnchor.checkoutId !== input.checkoutId) {
            return {reason: 'no-anchor', state: 'preserved'} as const;
          }
          const candidates = yield* dependencies
            .listCandidates(input, CODE_GRAPH_WORKTREE_RECONCILIATION_CANDIDATE_LIMIT)
            .pipe(
              Effect.match({
                onFailure: error => ({error, state: 'failure'}) as const,
                onSuccess: value => ({state: 'success', value}) as const,
              }),
            );
          if (candidates.state === 'failure') {
            if (Schema.is(CodeGraphMaintenanceActiveError)(candidates.error)) {
              return {reason: 'external-maintenance', state: 'preserved'} as const;
            }
            return {
              reason: Schema.is(CodeGraphStoreBusyError)(candidates.error)
                ? ('writer-busy' as const)
                : ('catalog-unavailable' as const),
              state: 'deferred',
            } as const;
          }
          const retiredScope = yield* (dependencies.retireScopes?.(input, candidates.value) ?? succeedUndefined).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (candidates.value.length === 0) return {reason: 'no-candidates', state: 'preserved'} as const;
          const nextCursor = candidates.value.at(-1)!.worktreeId;
          if (retiredScope !== undefined) return removalResult(nextCursor, retiredScope.candidate, retiredScope.result);
          const observedEvidence = yield* Effect.forEach(
            candidates.value,
            candidate =>
              dependencies
                .readEvidenceCandidate(input.threadnoteHome, {
                  checkoutId: input.checkoutId,
                  repositoryId: candidate.repositoryId,
                  worktreeId: candidate.worktreeId,
                })
                .pipe(
                  Effect.map(evidence =>
                    evidence.state === 'candidate' ? ({candidate, evidence} satisfies MissingCandidate) : undefined,
                  ),
                  Effect.orElseSucceed(() => undefined),
                ),
            {concurrency: 1},
          ).pipe(
            Effect.map(values => EffectArray.filter(values, (value): value is MissingCandidate => value !== undefined)),
          );
          if (observedEvidence.length === 0) {
            return {nextCursor, reason: 'no-missing-candidates', state: 'preserved'} as const;
          }

          if (expectedAnchor === undefined) {
            if (input.anchorPath === undefined) return {nextCursor, reason: 'no-anchor', state: 'preserved'} as const;
            const resolved = yield* dependencies.resolveAnchor(input.anchorPath).pipe(Effect.option);
            if (resolved._tag === 'None' || resolved.value.checkoutId !== input.checkoutId) {
              return {nextCursor, reason: 'anchor-unavailable', state: 'preserved'} as const;
            }
            expectedAnchor = resolved.value;
          }
          const evidenceCandidates = EffectArray.filter(
            observedEvidence,
            entry =>
              entry.candidate.worktreeId !== expectedAnchor.worktreeId &&
              entry.candidate.repositoryId === expectedAnchor.repositoryId,
          );
          if (evidenceCandidates.length === 0) {
            return {nextCursor, reason: 'no-missing-candidates', state: 'preserved'} as const;
          }

          const initialAnchor = yield* dependencies.resolveAnchor(expectedAnchor.repoRoot).pipe(Effect.option);
          if (initialAnchor._tag === 'None' || !sameLiveAnchor(initialAnchor.value, expectedAnchor, input.checkoutId)) {
            return {nextCursor, reason: 'anchor-unavailable', state: 'preserved'} as const;
          }

          const initialAuthority = yield* dependencies
            .observeAuthority(
              initialAnchor.value,
              EffectArray.map(evidenceCandidates, entry => authorityTarget(entry.evidence)),
            )
            .pipe(Effect.option);
          if (initialAuthority._tag === 'None' || initialAuthority.value.state === 'unknown') {
            return {nextCursor, reason: 'registry-unavailable', state: 'deferred'} as const;
          }
          const completeInitialAuthority = initialAuthority.value;
          if (
            completeInitialAuthority.pathStates.length !== evidenceCandidates.length ||
            completeInitialAuthority.registryStates.length !== evidenceCandidates.length
          ) {
            return {nextCursor, reason: 'registry-unavailable', state: 'deferred'} as const;
          }
          const targetIndex = EffectOption.getOrElse(
            EffectArray.findFirstIndex(
              evidenceCandidates,
              (_entry, index) =>
                completeInitialAuthority.pathStates[index] === 'missing' &&
                completeInitialAuthority.registryStates[index] === 'absent',
            ),
            () => -1,
          );
          if (targetIndex < 0) {
            return {
              nextCursor,
              reason: completeInitialAuthority.pathStates.includes('missing')
                ? ('registered' as const)
                : ('no-missing-candidates' as const),
              state: 'preserved',
            } as const;
          }
          const target = evidenceCandidates[targetIndex];

          const locked = yield* dependencies
            .withTargetLock(
              input,
              target.candidate.worktreeId,
              Effect.gen(function* () {
                const maintenanceIntent = yield* dependencies
                  .maintenanceIntentActive(input.threadnoteHome)
                  .pipe(Effect.option);
                if (maintenanceIntent._tag === 'None') {
                  return {nextCursor, reason: 'catalog-unavailable', state: 'deferred'} as const;
                }
                if (maintenanceIntent.value) {
                  return {nextCursor, reason: 'external-maintenance', state: 'preserved'} as const;
                }
                const finalEvidence = yield* dependencies
                  .readEvidenceCandidate(input.threadnoteHome, {
                    checkoutId: input.checkoutId,
                    repositoryId: target.candidate.repositoryId,
                    worktreeId: target.candidate.worktreeId,
                  })
                  .pipe(Effect.option);
                if (
                  finalEvidence._tag === 'None' ||
                  finalEvidence.value.state !== 'candidate' ||
                  !sameCodeGraphWorktreeReconciliationEvidenceCandidate(finalEvidence.value, target.evidence)
                ) {
                  return {nextCursor, reason: 'evidence-changed', state: 'preserved'} as const;
                }
                const finalAnchor = yield* dependencies.resolveAnchor(expectedAnchor.repoRoot).pipe(Effect.option);
                if (
                  finalAnchor._tag === 'None' ||
                  !sameLiveAnchor(finalAnchor.value, initialAnchor.value, input.checkoutId) ||
                  finalAnchor.value.worktreeId === target.candidate.worktreeId
                ) {
                  return {nextCursor, reason: 'anchor-unavailable', state: 'preserved'} as const;
                }
                const finalAuthority = yield* dependencies
                  .observeAuthority(finalAnchor.value, [authorityTarget(finalEvidence.value)])
                  .pipe(Effect.option);
                if (finalAuthority._tag === 'None' || finalAuthority.value.state === 'unknown') {
                  return {nextCursor, reason: 'registry-unavailable', state: 'deferred'} as const;
                }
                if (finalAuthority.value.pathStates.length !== 1 || finalAuthority.value.registryStates.length !== 1) {
                  return {nextCursor, reason: 'registry-unavailable', state: 'deferred'} as const;
                }
                if (finalAuthority.value.pathStates[0] !== 'missing') {
                  return {nextCursor, reason: 'evidence-changed', state: 'preserved'} as const;
                }
                if (finalAuthority.value.registryStates[0] === 'present') {
                  return {nextCursor, reason: 'registered', state: 'preserved'} as const;
                }
                if (
                  finalAuthority.value.registryRootKind !== completeInitialAuthority.registryRootKind ||
                  finalAuthority.value.registryRootIdentity !== completeInitialAuthority.registryRootIdentity
                ) {
                  return {nextCursor, reason: 'registry-changed', state: 'preserved'} as const;
                }
                if (
                  !codeGraphWorktreeReconciliationAuthorized({
                    anchorMatches: true,
                    evidenceStable: true,
                    finalRegistryState: finalAuthority.value.registryStates[0],
                    initialRegistryState: completeInitialAuthority.registryStates[targetIndex],
                    maintenanceActive: false,
                    missingEvidence: true,
                    registrationKind: finalEvidence.value.registration.kind,
                    registryRootStable: true,
                  })
                ) {
                  return {nextCursor, reason: 'evidence-changed', state: 'preserved'} as const;
                }
                const postAuthorityAnchor = yield* dependencies
                  .resolveAnchor(expectedAnchor.repoRoot)
                  .pipe(Effect.option);
                if (
                  postAuthorityAnchor._tag === 'None' ||
                  !sameLiveAnchor(postAuthorityAnchor.value, finalAnchor.value, input.checkoutId) ||
                  postAuthorityAnchor.value.worktreeId === target.candidate.worktreeId
                ) {
                  return {nextCursor, reason: 'anchor-unavailable', state: 'preserved'} as const;
                }
                const postAuthorityEvidence = yield* dependencies
                  .readEvidenceCandidate(input.threadnoteHome, {
                    checkoutId: input.checkoutId,
                    repositoryId: target.candidate.repositoryId,
                    worktreeId: target.candidate.worktreeId,
                  })
                  .pipe(Effect.option);
                if (
                  postAuthorityEvidence._tag === 'None' ||
                  postAuthorityEvidence.value.state !== 'candidate' ||
                  !sameCodeGraphWorktreeReconciliationEvidenceCandidate(
                    postAuthorityEvidence.value,
                    finalEvidence.value,
                  )
                ) {
                  return {nextCursor, reason: 'evidence-changed', state: 'preserved'} as const;
                }
                const postAuthorityMaintenanceIntent = yield* dependencies
                  .maintenanceIntentActive(input.threadnoteHome)
                  .pipe(Effect.option);
                if (postAuthorityMaintenanceIntent._tag === 'None') {
                  return {nextCursor, reason: 'catalog-unavailable', state: 'deferred'} as const;
                }
                if (postAuthorityMaintenanceIntent.value) {
                  return {nextCursor, reason: 'external-maintenance', state: 'preserved'} as const;
                }
                return yield* dependencies
                  .removeView(input, target.candidate, {
                    recordDigest: postAuthorityEvidence.value.recordDigest,
                    recordIdentity: postAuthorityEvidence.value.recordIdentity,
                    repositoryId: postAuthorityEvidence.value.repositoryId,
                  })
                  .pipe(
                    Effect.match({
                      onFailure: cause => {
                        if (Schema.is(CodeGraphMaintenanceActiveError)(cause)) {
                          return {nextCursor, reason: 'external-maintenance', state: 'preserved'} as const;
                        }
                        return {
                          nextCursor,
                          reason: Schema.is(CodeGraphStoreBusyError)(cause)
                            ? ('writer-busy' as const)
                            : ('catalog-unavailable' as const),
                          state: 'deferred',
                        } as const;
                      },
                      onSuccess: removed => removalResult(nextCursor, target.candidate, removed),
                    }),
                  );
              }),
              target.candidate.scopeId,
            )
            .pipe(
              Effect.match({
                onFailure: cause => ({
                  nextCursor,
                  reason: Schema.is(CodeGraphStoreBusyError)(cause)
                    ? ('target-busy' as const)
                    : ('catalog-unavailable' as const),
                  state: 'deferred' as const,
                }),
                onSuccess: result => result,
              }),
            );
          return locked;
        });

      return {tick} satisfies CodeGraphWorktreeReconcilerShape;
    }),
);

export const makeLiveCodeGraphWorktreeReconciler = Effect.fn('codeGraph.makeLiveWorktreeReconciler')(function* () {
  const command = yield* CommandExecutor;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const system = yield* SystemInfo;
  const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CommandExecutor, command),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SystemInfo, system),
    );
  const verifyDatabaseAuthority = (input: CodeGraphWorktreeReconciliationTick, operation: string) =>
    Effect.gen(function* () {
      const inspected = yield* provideLive(inspectCodeGraphViewDatabaseTarget(input.threadnoteHome, input.checkoutId));
      if (inspected.state !== 'ready' || inspected.databasePath !== input.databasePath) {
        return yield* CodeGraphWorktreeAuthorityChanged.make({
          message: `Code graph database target changed before ${operation}.`,
        });
      }
      if (yield* provideLive(codeGraphMaintenanceIntentActive(input.threadnoteHome))) {
        return yield* CodeGraphMaintenanceActiveError.of();
      }
    });
  return yield* makeCodeGraphWorktreeReconciler({
    retireScopes: (input, candidates) =>
      provideLive(reconcileCodeGraphScopeRetirements(input, candidates)).pipe(
        Effect.provideService(CodeGraphStore, store),
      ),
    listCandidates: (input, limit) =>
      store.claimWorktreeReconciliationCandidates(input.databasePath, limit, {
        beforeDatabaseOpen: () => verifyDatabaseAuthority(input, 'reconciliation scan'),
        waitTimeoutMilliseconds: 0,
      }),
    maintenanceIntentActive: threadnoteHome => provideLive(codeGraphMaintenanceIntentActive(threadnoteHome)),
    observeAuthority: (identity, targets) =>
      provideLive(observeCodeGraphWorktreeReconciliationAuthority(identity, targets)),
    readEvidenceCandidate: (threadnoteHome, target) =>
      provideLive(readCodeGraphWorktreeReconciliationEvidenceCandidate(threadnoteHome, target)),
    removeView: (input, candidate, cleanupEvidence) =>
      store.removeView(input.databasePath, candidate.worktreeId, candidate.snapshotId, {
        beforeDatabaseOpen: () => verifyDatabaseAuthority(input, 'reconciliation'),
        cleanupEvidence,
        scopeId: candidate.scopeId,
        requireReconciliationSchema: true,
        waitTimeoutMilliseconds: 0,
      }),
    resolveAnchor: cwd => provideLive(resolveRepositoryIdentity(cwd)),
    withTargetLock: (input, worktreeId, effect, scopeId) =>
      provideLive(withCodeGraphTargetWorktreeLock(input.threadnoteHome, input.checkoutId, worktreeId, effect, scopeId)),
  });
});

function sameLiveAnchor(observed: RepositoryIdentity, expected: RepositoryIdentity, checkoutId: string): boolean {
  return (
    observed.checkoutId === checkoutId &&
    observed.checkoutId === expected.checkoutId &&
    observed.repositoryId === expected.repositoryId &&
    observed.worktreeId === expected.worktreeId &&
    observed.repoRoot === expected.repoRoot &&
    observed.gitCommonDirectory === expected.gitCommonDirectory &&
    observed.objectFormat === expected.objectFormat
  );
}

function authorityTarget(
  evidence: Extract<CodeGraphWorktreeReconciliationEvidenceCandidate, {readonly state: 'candidate'}>,
): CodeGraphWorktreeReconciliationAuthorityTarget {
  return {
    adminNameKeys: evidence.registration.adminNameKeys,
    canonicalWorktreePath: evidence.canonicalWorktreePath,
    evidenceToken: evidence.evidenceToken,
  };
}

function removalResult(
  nextCursor: string,
  candidate: CodeGraphWorktreeReconciliationCandidate,
  result: CodeGraphViewRemovalResult,
): CodeGraphWorktreeReconciliationResult {
  if (result.state === 'removed') {
    return {
      expectedSnapshotId: candidate.snapshotId,
      nextCursor,
      retiredSnapshots: result.retiredSnapshots,
      state: 'removed',
      worktreeId: candidate.worktreeId,
    };
  }
  if (result.state === 'already-removed') {
    return {nextCursor, reason: 'already-removed', state: 'preserved'};
  }
  return {nextCursor, reason: 'stale-target', state: 'preserved'};
}

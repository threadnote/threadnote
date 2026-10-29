import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Crypto, Effect, FileSystem, Path, Schema} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {
  observeCodeGraphWorktreeReconciliationAuthority,
  type CodeGraphWorktreeReconciliationAuthorityObservation,
  type CodeGraphWorktreeReconciliationAuthorityTarget,
} from './git/worktree/registration.js';
import {
  cleanupMissingCodeGraphLocalProvenance,
  inspectCodeGraphLocalProvenanceInventory,
  readCodeGraphWorktreeReconciliationEvidenceCandidate,
  sameCodeGraphWorktreeReconciliationEvidenceCandidate,
  type CodeGraphLocalProvenanceCleanupEvidence,
  type CodeGraphLocalProvenanceCleanupResult,
  type CodeGraphLocalProvenanceInventory,
  type CodeGraphWorktreeReconciliationEvidenceCandidate,
} from './local_provenance.js';
import {
  codeGraphMaintenanceIntentActive,
  CodeGraphMaintenanceActiveError,
  withCodeGraphTargetWorktreeLock,
} from './maintenance/gate.js';
import {resolveRepositoryIdentity} from './repository.js';
import {
  CodeGraphStore,
  type CodeGraphOrphanProvenanceCandidatePage,
  type CodeGraphOrphanProvenanceViewObservation,
} from './store.js';
import {CodeGraphStoreBusyError, type RepositoryIdentity} from './types.js';
import {inspectCodeGraphViewDatabaseTarget} from './view_removal.js';
import {
  codeGraphWorktreeReconciliationAuthorized,
  type CodeGraphWorktreeReconciliationTick,
} from './worktree_reconciliation.js';

export const CODE_GRAPH_ORPHAN_PROVENANCE_CANDIDATE_LIMIT = 32;
export const CODE_GRAPH_ORPHAN_PROVENANCE_CURSOR_RECOVERY_DIAGNOSTIC = 'orphan-provenance-cursor-recovered' as const;

class CodeGraphOrphanProvenanceAuthorityChanged extends Schema.TaggedError<
  CodeGraphOrphanProvenanceAuthorityChanged,
  {readonly brand: unique symbol}
>()('CodeGraphOrphanProvenanceAuthorityChanged', {message: Schema.String}) {}

export type CodeGraphOrphanProvenanceCleanupResult =
  | {
      /** Advisory scheduler repair only; deletion still requires every independent authority gate. */
      readonly cursorRecovery?: 'invalid-format';
      readonly state: 'removed';
      readonly worktreeId: string;
    }
  | {
      /** Advisory scheduler repair only; deletion still requires every independent authority gate. */
      readonly cursorRecovery?: 'invalid-format';
      readonly reason:
        | 'active-view'
        | 'already-removed'
        | 'anchor-unavailable'
        | 'evidence-changed'
        | 'external-maintenance'
        | 'no-anchor'
        | 'no-candidates'
        | 'no-missing-candidates'
        | 'registered'
        | 'registry-changed';
      readonly state: 'preserved';
    }
  | {
      /** Advisory scheduler repair only; deletion still requires every independent authority gate. */
      readonly cursorRecovery?: 'invalid-format';
      readonly reason:
        | 'catalog-unavailable'
        | 'inventory-unavailable'
        | 'registry-unavailable'
        | 'sidecar-unavailable'
        | 'target-busy'
        | 'writer-busy';
      readonly state: 'deferred';
    };

export interface CodeGraphOrphanProvenanceCleanupDependencies {
  readonly claimCandidates: (
    input: CodeGraphWorktreeReconciliationTick,
    worktreeIds: readonly string[],
    limit: number,
  ) => Effect.Effect<CodeGraphOrphanProvenanceCandidatePage, unknown>;
  readonly cleanupProvenance: (
    threadnoteHome: string,
    target: {readonly checkoutId: string; readonly worktreeId: string},
    expectedEvidence: CodeGraphLocalProvenanceCleanupEvidence,
  ) => Effect.Effect<CodeGraphLocalProvenanceCleanupResult, unknown>;
  readonly inspectInventory: (
    threadnoteHome: string,
    checkoutId: string,
  ) => Effect.Effect<CodeGraphLocalProvenanceInventory, unknown>;
  readonly maintenanceIntentActive: (threadnoteHome: string) => Effect.Effect<boolean, unknown>;
  readonly observeAuthority: (
    identity: Pick<RepositoryIdentity, 'checkoutId' | 'gitCommonDirectory'>,
    targets: readonly CodeGraphWorktreeReconciliationAuthorityTarget[],
  ) => Effect.Effect<CodeGraphWorktreeReconciliationAuthorityObservation, unknown>;
  readonly observeView: (
    input: CodeGraphWorktreeReconciliationTick,
    worktreeId: string,
  ) => Effect.Effect<CodeGraphOrphanProvenanceViewObservation, unknown>;
  readonly readEvidenceCandidate: (
    threadnoteHome: string,
    target: {readonly checkoutId: string; readonly worktreeId: string},
  ) => Effect.Effect<CodeGraphWorktreeReconciliationEvidenceCandidate, unknown>;
  readonly resolveAnchor: (cwd: string) => Effect.Effect<RepositoryIdentity, unknown>;
  readonly withTargetLock: <A, E>(
    input: CodeGraphWorktreeReconciliationTick,
    worktreeId: string,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | unknown>;
}

export interface CodeGraphOrphanProvenanceCleanerShape {
  readonly tick: (
    input: CodeGraphWorktreeReconciliationTick,
  ) => Effect.Effect<CodeGraphOrphanProvenanceCleanupResult, never>;
}

type ProvenanceCandidate = Extract<CodeGraphWorktreeReconciliationEvidenceCandidate, {readonly state: 'candidate'}>;

export const makeCodeGraphOrphanProvenanceCleaner = Effect.fn('codeGraph.makeOrphanProvenanceCleaner')(
  (dependencies: CodeGraphOrphanProvenanceCleanupDependencies) =>
    Effect.sync(() => {
      const tick = (input: CodeGraphWorktreeReconciliationTick) =>
        Effect.gen(function* () {
          let expectedAnchor = input.anchorIdentity;
          if (expectedAnchor !== undefined && expectedAnchor.checkoutId !== input.checkoutId) {
            return {reason: 'anchor-unavailable', state: 'preserved'} as const;
          }
          const inventory = yield* dependencies
            .inspectInventory(input.threadnoteHome, input.checkoutId)
            .pipe(Effect.orElseSucceed(() => ({state: 'unavailable'}) as const));
          if (inventory.state === 'unavailable') {
            return {reason: 'inventory-unavailable', state: 'deferred'} as const;
          }
          if (inventory.worktreeIds.length === 0) {
            return {reason: 'no-candidates', state: 'preserved'} as const;
          }
          const claimed = yield* dependencies
            .claimCandidates(input, inventory.worktreeIds, CODE_GRAPH_ORPHAN_PROVENANCE_CANDIDATE_LIMIT)
            .pipe(
              Effect.match({
                onFailure: error => ({error, state: 'failure'}) as const,
                onSuccess: value => ({state: 'success', value}) as const,
              }),
            );
          if (claimed.state === 'failure') {
            if (Schema.is(CodeGraphMaintenanceActiveError)(claimed.error)) {
              return {reason: 'external-maintenance', state: 'preserved'} as const;
            }
            return {
              reason: Schema.is(CodeGraphStoreBusyError)(claimed.error) ? 'writer-busy' : 'catalog-unavailable',
              state: 'deferred',
            } as const;
          }
          const cursorRecovery = claimed.value.cursorRecovery;
          const withCursorRecovery = <Result extends CodeGraphOrphanProvenanceCleanupResult>(
            result: Result,
          ): CodeGraphOrphanProvenanceCleanupResult =>
            cursorRecovery === undefined ? result : {...result, cursorRecovery};
          if (claimed.value.worktreeIds.length === 0) {
            return withCursorRecovery({reason: 'no-candidates', state: 'preserved'} as const);
          }
          const evidenceCandidates = yield* readEvidenceCandidates(dependencies, input, claimed.value.worktreeIds);
          if (evidenceCandidates.length === 0) {
            return withCursorRecovery({reason: 'no-candidates', state: 'preserved'} as const);
          }
          if (expectedAnchor === undefined) {
            if (input.anchorPath === undefined) {
              return withCursorRecovery({reason: 'no-anchor', state: 'preserved'} as const);
            }
            const resolved = yield* dependencies.resolveAnchor(input.anchorPath).pipe(Effect.option);
            if (resolved._tag === 'None' || resolved.value.checkoutId !== input.checkoutId) {
              return withCursorRecovery({reason: 'anchor-unavailable', state: 'preserved'} as const);
            }
            expectedAnchor = resolved.value;
          }
          const repositoryCandidates = EffectArray.filter(
            evidenceCandidates,
            candidate =>
              candidate.repositoryId === expectedAnchor.repositoryId &&
              candidate.worktreeId !== expectedAnchor.worktreeId,
          );
          if (repositoryCandidates.length === 0) {
            return withCursorRecovery({reason: 'no-candidates', state: 'preserved'} as const);
          }
          const initialAnchor = yield* dependencies.resolveAnchor(expectedAnchor.repoRoot).pipe(Effect.option);
          if (initialAnchor._tag === 'None' || !sameLiveAnchor(initialAnchor.value, expectedAnchor, input.checkoutId)) {
            return withCursorRecovery({reason: 'anchor-unavailable', state: 'preserved'} as const);
          }
          const initialAuthority = yield* dependencies
            .observeAuthority(initialAnchor.value, EffectArray.map(repositoryCandidates, authorityTarget))
            .pipe(Effect.option);
          if (initialAuthority._tag === 'None' || initialAuthority.value.state === 'unknown') {
            return withCursorRecovery({reason: 'registry-unavailable', state: 'deferred'} as const);
          }
          const completeInitialAuthority = initialAuthority.value;
          if (
            completeInitialAuthority.pathStates.length !== repositoryCandidates.length ||
            completeInitialAuthority.registryStates.length !== repositoryCandidates.length
          ) {
            return withCursorRecovery({reason: 'registry-unavailable', state: 'deferred'} as const);
          }
          const targetIndex = EffectOption.getOrElse(
            EffectArray.findFirstIndex(
              repositoryCandidates,
              (_candidate, index) =>
                completeInitialAuthority.pathStates[index] === 'missing' &&
                completeInitialAuthority.registryStates[index] === 'absent',
            ),
            () => -1,
          );
          if (targetIndex < 0) {
            return withCursorRecovery({
              reason: completeInitialAuthority.pathStates.includes('missing') ? 'registered' : 'no-missing-candidates',
              state: 'preserved',
            } as const);
          }
          const target = repositoryCandidates[targetIndex];
          const result = yield* dependencies
            .withTargetLock(
              input,
              target.worktreeId,
              cleanupLockedTarget(
                dependencies,
                input,
                expectedAnchor,
                initialAnchor.value,
                completeInitialAuthority,
                targetIndex,
                target,
              ),
            )
            .pipe(
              Effect.catch(error =>
                Effect.succeed({
                  reason: Schema.is(CodeGraphStoreBusyError)(error)
                    ? ('target-busy' as const)
                    : ('catalog-unavailable' as const),
                  state: 'deferred' as const,
                }),
              ),
            );
          return withCursorRecovery(result);
        });
      return {tick} satisfies CodeGraphOrphanProvenanceCleanerShape;
    }),
);

const cleanupLockedTarget = (
  dependencies: CodeGraphOrphanProvenanceCleanupDependencies,
  input: CodeGraphWorktreeReconciliationTick,
  expectedAnchor: RepositoryIdentity,
  initialAnchor: RepositoryIdentity,
  initialAuthority: Extract<CodeGraphWorktreeReconciliationAuthorityObservation, {readonly state: 'complete'}>,
  targetIndex: number,
  target: ProvenanceCandidate,
) =>
  Effect.gen(function* () {
    const maintenanceIntent = yield* dependencies.maintenanceIntentActive(input.threadnoteHome).pipe(Effect.option);
    if (maintenanceIntent._tag === 'None') {
      return {reason: 'catalog-unavailable', state: 'deferred'} as const;
    }
    if (maintenanceIntent.value) {
      return {reason: 'external-maintenance', state: 'preserved'} as const;
    }
    const finalEvidence = yield* dependencies
      .readEvidenceCandidate(input.threadnoteHome, {
        checkoutId: input.checkoutId,
        worktreeId: target.worktreeId,
      })
      .pipe(Effect.option);
    if (
      finalEvidence._tag === 'None' ||
      finalEvidence.value.state !== 'candidate' ||
      !sameCodeGraphWorktreeReconciliationEvidenceCandidate(finalEvidence.value, target)
    ) {
      return {reason: 'evidence-changed', state: 'preserved'} as const;
    }
    const finalAnchor = yield* dependencies.resolveAnchor(expectedAnchor.repoRoot).pipe(Effect.option);
    if (
      finalAnchor._tag === 'None' ||
      !sameLiveAnchor(finalAnchor.value, initialAnchor, input.checkoutId) ||
      finalAnchor.value.worktreeId === target.worktreeId
    ) {
      return {reason: 'anchor-unavailable', state: 'preserved'} as const;
    }
    const finalAuthority = yield* dependencies
      .observeAuthority(finalAnchor.value, [authorityTarget(finalEvidence.value)])
      .pipe(Effect.option);
    if (finalAuthority._tag === 'None' || finalAuthority.value.state === 'unknown') {
      return {reason: 'registry-unavailable', state: 'deferred'} as const;
    }
    if (finalAuthority.value.pathStates.length !== 1 || finalAuthority.value.registryStates.length !== 1) {
      return {reason: 'registry-unavailable', state: 'deferred'} as const;
    }
    if (finalAuthority.value.pathStates[0] !== 'missing') {
      return {reason: 'evidence-changed', state: 'preserved'} as const;
    }
    if (finalAuthority.value.registryStates[0] === 'present') {
      return {reason: 'registered', state: 'preserved'} as const;
    }
    if (
      finalAuthority.value.registryRootKind !== initialAuthority.registryRootKind ||
      finalAuthority.value.registryRootIdentity !== initialAuthority.registryRootIdentity
    ) {
      return {reason: 'registry-changed', state: 'preserved'} as const;
    }
    if (
      !codeGraphWorktreeReconciliationAuthorized({
        anchorMatches: true,
        evidenceStable: true,
        finalRegistryState: finalAuthority.value.registryStates[0],
        initialRegistryState: initialAuthority.registryStates[targetIndex],
        maintenanceActive: false,
        missingEvidence: true,
        registrationKind: finalEvidence.value.registration.kind,
        registryRootStable: true,
      })
    ) {
      return {reason: 'evidence-changed', state: 'preserved'} as const;
    }
    const postAuthorityAnchor = yield* dependencies.resolveAnchor(expectedAnchor.repoRoot).pipe(Effect.option);
    if (
      postAuthorityAnchor._tag === 'None' ||
      !sameLiveAnchor(postAuthorityAnchor.value, finalAnchor.value, input.checkoutId) ||
      postAuthorityAnchor.value.worktreeId === target.worktreeId
    ) {
      return {reason: 'anchor-unavailable', state: 'preserved'} as const;
    }
    const postAuthorityEvidence = yield* dependencies
      .readEvidenceCandidate(input.threadnoteHome, {
        checkoutId: input.checkoutId,
        worktreeId: target.worktreeId,
      })
      .pipe(Effect.option);
    if (
      postAuthorityEvidence._tag === 'None' ||
      postAuthorityEvidence.value.state !== 'candidate' ||
      !sameCodeGraphWorktreeReconciliationEvidenceCandidate(postAuthorityEvidence.value, finalEvidence.value)
    ) {
      return {reason: 'evidence-changed', state: 'preserved'} as const;
    }
    const postAuthorityMaintenanceIntent = yield* dependencies
      .maintenanceIntentActive(input.threadnoteHome)
      .pipe(Effect.option);
    if (postAuthorityMaintenanceIntent._tag === 'None') {
      return {reason: 'catalog-unavailable', state: 'deferred'} as const;
    }
    if (postAuthorityMaintenanceIntent.value) {
      return {reason: 'external-maintenance', state: 'preserved'} as const;
    }
    // The target lock is the builder's publication gate. Once this final
    // writer-gated observation is absent, no product path can republish the
    // view before the exact sidecar removal below completes.
    const view = yield* dependencies.observeView(input, target.worktreeId).pipe(
      Effect.match({
        onFailure: error => ({error, state: 'failure'}) as const,
        onSuccess: value => ({state: 'success', value}) as const,
      }),
    );
    if (view.state === 'failure') {
      return {
        reason: Schema.is(CodeGraphStoreBusyError)(view.error)
          ? ('writer-busy' as const)
          : ('catalog-unavailable' as const),
        state: 'deferred',
      } as const;
    }
    if (view.value.state === 'active') {
      return {reason: 'active-view', state: 'preserved'} as const;
    }
    const cleanupEvidence: CodeGraphLocalProvenanceCleanupEvidence = {
      checkoutId: input.checkoutId,
      recordDigest: postAuthorityEvidence.value.recordDigest,
      recordIdentity: postAuthorityEvidence.value.recordIdentity,
      repositoryId: postAuthorityEvidence.value.repositoryId,
      worktreeId: target.worktreeId,
    };
    const cleanup = yield* dependencies
      .cleanupProvenance(
        input.threadnoteHome,
        {checkoutId: input.checkoutId, worktreeId: target.worktreeId},
        cleanupEvidence,
      )
      .pipe(Effect.orElseSucceed(() => ({state: 'unavailable'}) as const));
    return cleanupResult(target.worktreeId, cleanup);
  });

export const makeLiveCodeGraphOrphanProvenanceCleaner = Effect.fn('codeGraph.makeLiveOrphanProvenanceCleaner')(
  function* () {
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
        const inspected = yield* provideLive(
          inspectCodeGraphViewDatabaseTarget(input.threadnoteHome, input.checkoutId),
        );
        if (inspected.state !== 'ready' || inspected.databasePath !== input.databasePath) {
          return yield* CodeGraphOrphanProvenanceAuthorityChanged.make({
            message: `Code graph database target changed before ${operation}.`,
          });
        }
        if (yield* provideLive(codeGraphMaintenanceIntentActive(input.threadnoteHome))) {
          return yield* CodeGraphMaintenanceActiveError.of();
        }
      });
    return yield* makeCodeGraphOrphanProvenanceCleaner({
      claimCandidates: (input, worktreeIds, limit) =>
        store.claimOrphanProvenanceCandidates(input.databasePath, worktreeIds, limit, {
          beforeDatabaseOpen: () => verifyDatabaseAuthority(input, 'orphan provenance scan'),
          waitTimeoutMilliseconds: 0,
        }),
      cleanupProvenance: (threadnoteHome, target, expectedEvidence) =>
        provideLive(cleanupMissingCodeGraphLocalProvenance(threadnoteHome, target, {expectedEvidence})),
      inspectInventory: (threadnoteHome, checkoutId) =>
        provideLive(inspectCodeGraphLocalProvenanceInventory(threadnoteHome, checkoutId)),
      maintenanceIntentActive: threadnoteHome => provideLive(codeGraphMaintenanceIntentActive(threadnoteHome)),
      observeAuthority: (identity, targets) =>
        provideLive(observeCodeGraphWorktreeReconciliationAuthority(identity, targets)),
      observeView: (input, worktreeId) =>
        store.observeOrphanProvenanceView(input.databasePath, worktreeId, {
          beforeDatabaseOpen: () => verifyDatabaseAuthority(input, 'orphan provenance cleanup'),
          waitTimeoutMilliseconds: 0,
        }),
      readEvidenceCandidate: (threadnoteHome, target) =>
        provideLive(readCodeGraphWorktreeReconciliationEvidenceCandidate(threadnoteHome, target)),
      resolveAnchor: cwd => provideLive(resolveRepositoryIdentity(cwd)),
      withTargetLock: (input, worktreeId, effect) =>
        provideLive(withCodeGraphTargetWorktreeLock(input.threadnoteHome, input.checkoutId, worktreeId, effect)),
    });
  },
);

function readEvidenceCandidates(
  dependencies: CodeGraphOrphanProvenanceCleanupDependencies,
  input: CodeGraphWorktreeReconciliationTick,
  worktreeIds: readonly string[],
) {
  return Effect.forEach(
    worktreeIds,
    worktreeId =>
      dependencies
        .readEvidenceCandidate(input.threadnoteHome, {checkoutId: input.checkoutId, worktreeId})
        .pipe(Effect.orElseSucceed(() => ({state: 'invalid'}) as const)),
    {concurrency: 1},
  ).pipe(
    Effect.map(evidence =>
      EffectArray.filter(evidence, (candidate): candidate is ProvenanceCandidate => candidate.state === 'candidate'),
    ),
  );
}

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

function authorityTarget(evidence: ProvenanceCandidate): CodeGraphWorktreeReconciliationAuthorityTarget {
  return {
    adminNameKeys: evidence.registration.adminNameKeys,
    canonicalWorktreePath: evidence.canonicalWorktreePath,
    evidenceToken: evidence.evidenceToken,
  };
}

function cleanupResult(
  worktreeId: string,
  result: CodeGraphLocalProvenanceCleanupResult,
): CodeGraphOrphanProvenanceCleanupResult {
  if (result.state === 'removed') return {state: 'removed', worktreeId};
  if (result.state === 'not-found') return {reason: 'already-removed', state: 'preserved'};
  if (result.state === 'unavailable') return {reason: 'sidecar-unavailable', state: 'deferred'};
  return {reason: 'evidence-changed', state: 'preserved'};
}

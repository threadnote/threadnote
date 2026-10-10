import {Clock, Effect, Path} from 'effect';
import {observeCodeGraphAdmissionEnvironment} from '../admission_freshness.js';
import {codeGraphBuildRequestKey} from '../indexer/build.js';
import {codeGraphIndexEnsuresVectors, type CodeGraphIndexOptions} from '../indexer/types.js';
import {CodeGraphIndexOperationError, WorktreeChangedDuringIndex} from '../indexer/shared.js';
import {inventoryRepository, worktreeBuildRequestState} from '../inventory.js';
import {runIsolatedCodeGraphIndex, type CodeGraphIsolatedBuilderResult} from './builder.js';
import {CodeGraphLanguagePackRegistry} from '../languages/registry.js';
import {codeGraphLayout} from '../layout.js';
import {repositoryIdentityMatchesExpectation, resolveRepositoryIdentity} from '../repository.js';
import {CodeGraphStore} from '../store.js';
import {
  CodeGraphSnapshotUnavailable,
  type CodeGraphIndexSummary,
  type CodeGraphSnapshot,
  type RepositoryIdentity,
} from '../types.js';

export type CodeGraphIsolatedIndexSummary = Pick<CodeGraphIndexSummary, 'durationMs' | 'identity' | 'snapshot'>;

export interface RecoverIsolatedCodeGraphIndexSnapshotOptions<E, R> {
  readonly completedIdentity: RepositoryIdentity;
  readonly currentRequestKey?: string;
  readonly loadReadySnapshot: (snapshotId: string) => Effect.Effect<CodeGraphSnapshot | undefined, E, R>;
  readonly requestedIdentity: RepositoryIdentity;
  readonly requestedRequestKey?: string;
  readonly result: CodeGraphIsolatedBuilderResult;
}

/**
 * Fence the child receipt against the post-build repository observation, then
 * recover the authoritative ready row that downstream workset publication uses.
 */
export function recoverIsolatedCodeGraphIndexSnapshot<E, R>(
  options: RecoverIsolatedCodeGraphIndexSnapshotOptions<E, R>,
): Effect.Effect<Pick<CodeGraphIndexSummary, 'identity' | 'snapshot'>, E | Error, R> {
  return Effect.gen(function* () {
    if (
      !repositoryIdentityMatchesExpectation(options.completedIdentity, options.requestedIdentity) ||
      options.completedIdentity.headCommit !== options.requestedIdentity.headCommit ||
      (options.requestedRequestKey !== undefined &&
        (options.result.requestKey !== options.requestedRequestKey ||
          options.currentRequestKey !== options.requestedRequestKey))
    ) {
      return yield* WorktreeChangedDuringIndex.make({});
    }
    const snapshot = yield* options.loadReadySnapshot(options.result.snapshotId);
    if (
      !snapshot ||
      snapshot.id !== options.result.snapshotId ||
      snapshot.repositoryId !== options.completedIdentity.repositoryId
    ) {
      return yield* CodeGraphSnapshotUnavailable.make({
        message: 'The isolated graph index completed without a readable ready snapshot.',
      });
    }
    if (
      snapshot.commit !== options.completedIdentity.headCommit ||
      snapshot.dirty !== options.result.dirty ||
      snapshot.fileCount !== options.result.files ||
      snapshot.symbolCount !== options.result.symbols ||
      snapshot.edgeCount !== options.result.edges ||
      (snapshot.dirty && snapshot.worktreeId !== options.completedIdentity.worktreeId)
    ) {
      return yield* WorktreeChangedDuringIndex.make({});
    }
    return {identity: options.completedIdentity, snapshot};
  });
}

/**
 * Run one ordinary index request in a child CLI and recover the authoritative
 * snapshot from the repository store. Long-lived UI/server hosts use this
 * instead of owning repository-sized SQLite work in their event loop.
 */
export const runIsolatedCodeGraphIndexSnapshot = Effect.fn('codeGraph.isolatedIndex.snapshot')(function* (
  options: CodeGraphIndexOptions & {
    readonly manifestPath?: string;
    readonly manifestRevision?: string;
    readonly project?: NonNullable<CodeGraphIndexOptions['project']> & {readonly name?: string};
  },
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const languagePacks = yield* CodeGraphLanguagePackRegistry;
  const identity = yield* resolveRepositoryIdentity(options.cwd);
  if (options.expectedIdentity && !repositoryIdentityMatchesExpectation(identity, options.expectedIdentity)) {
    return yield* CodeGraphIndexOperationError.make({
      message: 'Repository identity does not match the requested graph target.',
    });
  }
  const scopedObservation =
    options.project?.graph === undefined
      ? undefined
      : yield* inventoryRepository(identity, {
          includeOverlay: false,
          languagePacks,
          project: options.project,
          scopeObservationOnly: true,
        });
  const scope = scopedObservation?.scope;
  const requestedOverlay = yield* worktreeBuildRequestState(identity, options.threadnoteHome, scope);
  const admissionEnvironment = yield* observeCodeGraphAdmissionEnvironment(identity);
  const ensureVectors = codeGraphIndexEnsuresVectors(options);
  const requestKey = options.force
    ? undefined
    : codeGraphBuildRequestKey(
        identity,
        requestedOverlay,
        languagePacks,
        options.incrementalOverlay,
        ensureVectors,
        admissionEnvironment,
        scope,
      );
  const startedAt = yield* Clock.currentTimeMillis;
  const result = yield* runIsolatedCodeGraphIndex({
    admissionClass: options.admissionClass,
    assertRuntimeSchemaCompatible: databasePath => store.assertRuntimeSchemaCompatible(databasePath),
    cwd: options.cwd,
    full: options.force === true,
    ...(options.manifestPath === undefined ? {} : {manifestPath: options.manifestPath}),
    ...(options.manifestRevision === undefined ? {} : {manifestRevision: options.manifestRevision}),
    noVectors: !ensureVectors,
    onProgress: options.onProgress,
    ...(options.project === undefined ? {} : {project: options.project}),
    requestKey,
    resolveIdentity: () => Effect.succeed(identity),
    ...(scope === undefined ? {} : {scopeId: scope.scopeKey}),
    threadnoteHome: options.threadnoteHome,
  });
  const completedIdentity = yield* resolveRepositoryIdentity(options.cwd);
  const completedEnvironment = yield* observeCodeGraphAdmissionEnvironment(completedIdentity);
  if (completedEnvironment !== admissionEnvironment) return yield* WorktreeChangedDuringIndex.make({});
  const completedRequestKey =
    requestKey === undefined ||
    !repositoryIdentityMatchesExpectation(completedIdentity, identity) ||
    completedIdentity.headCommit !== identity.headCommit
      ? undefined
      : codeGraphBuildRequestKey(
          completedIdentity,
          yield* worktreeBuildRequestState(completedIdentity, options.threadnoteHome, scope),
          languagePacks,
          options.incrementalOverlay,
          ensureVectors,
          completedEnvironment,
          scope,
        );
  const layout = codeGraphLayout(
    path,
    options.threadnoteHome,
    identity.checkoutId,
    identity.worktreeId,
    scope?.scopeKey,
  );
  const recovered = yield* recoverIsolatedCodeGraphIndexSnapshot({
    completedIdentity,
    ...(completedRequestKey === undefined ? {} : {currentRequestKey: completedRequestKey}),
    loadReadySnapshot: snapshotId => store.readySnapshotById(layout.databasePath, snapshotId),
    requestedIdentity: identity,
    ...(requestKey === undefined ? {} : {requestedRequestKey: requestKey}),
    result,
  });
  return {
    durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
    ...recovered,
  } satisfies CodeGraphIsolatedIndexSummary;
});

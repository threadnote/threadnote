import {Effect} from 'effect';
import type {CodeGraphStoreShape} from '../store.js';
import type {CodeGraphSnapshot, RepositoryIdentity} from '../types.js';
import {
  codeGraphQueryScopeSnapshotCompatible,
  type CodeGraphQueryScope,
  type CodeGraphReadyScopeReceipt,
} from './scope.js';

export const selectCompatibleReadyCodeGraphSnapshot = Effect.fn('codeGraph.selectCompatibleReadySnapshot')(
  function* (input: {
    readonly borrowedSnapshotId?: string;
    readonly databasePath: string;
    readonly identity: RepositoryIdentity;
    readonly projectScope?: CodeGraphQueryScope | CodeGraphReadyScopeReceipt;
    readonly store: CodeGraphStoreShape;
  }) {
    const preferredSnapshot = input.borrowedSnapshotId
      ? yield* input.store.readySnapshotById(input.databasePath, input.borrowedSnapshotId)
      : undefined;
    let snapshot = preferredSnapshot;
    let incompatibleSnapshotObserved = false;
    const compatible = (candidate: CodeGraphSnapshot) =>
      Effect.gen(function* () {
        if (candidate.repositoryId !== input.identity.repositoryId) return false;
        const matches = yield* codeGraphQueryScopeSnapshotCompatible(
          input.projectScope,
          input.store,
          input.databasePath,
          input.borrowedSnapshotId ? candidate.worktreeId : input.identity.worktreeId,
          candidate,
        );
        if (!matches) incompatibleSnapshotObserved = true;
        return matches;
      });
    if (snapshot !== undefined && !(yield* compatible(snapshot))) snapshot = undefined;
    if (snapshot === undefined) {
      const active = yield* input.store.readySnapshot(
        input.databasePath,
        input.identity.worktreeId,
        input.projectScope?.scope?.scopeKey,
      );
      if (active !== undefined && (yield* compatible(active))) snapshot = active;
    }
    if (snapshot === undefined && input.borrowedSnapshotId !== undefined) {
      const recent = yield* input.store.recentReadySnapshotsForRepository(
        input.databasePath,
        input.identity.repositoryId,
        input.projectScope?.scope?.scopeKey,
      );
      for (const candidate of recent) {
        if (yield* compatible(candidate)) {
          snapshot = candidate;
          break;
        }
      }
    }
    return {incompatibleSnapshotObserved, snapshot};
  },
);

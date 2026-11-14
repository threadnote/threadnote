import {Effect} from 'effect';
import {CodeGraphStore} from '../store.js';
import {
  CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS,
  CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_RENEWAL_INTERVAL_MILLISECONDS,
  type CodeGraphCheckpointProjectionRequest,
  CodeGraphCheckpointProjectionError,
  attemptProjection,
  validateSelectedSnapshot,
  normalizePageSize,
  validateProjectionIdentity,
  observeExactCleanRepository,
  projectInReadTransaction,
} from './authority.js';
export {
  CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS,
  CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_RENEWAL_INTERVAL_MILLISECONDS,
  CODE_GRAPH_CHECKPOINT_PROJECTION_DEFAULT_PAGE_SIZE,
  CODE_GRAPH_CHECKPOINT_PROJECTION_MAXIMUM_PAGE_SIZE,
  CODE_GRAPH_CHECKPOINT_GIT_PATHSPEC_BYTES_MAXIMUM,
  CodeGraphCheckpointProjectionError,
  codeGraphCheckpointCoverage,
  codeGraphCheckpointGitPathBatches,
  parseGitTreeEntries,
  type CodeGraphCheckpointProjectionRequest,
  type CodeGraphCheckpointProjectionSummary,
} from './authority.js';

export function projectCodeGraphCheckpointV1<E, R>(request: CodeGraphCheckpointProjectionRequest<E, R>) {
  return Effect.gen(function* () {
    const pageSize = yield* attemptProjection('Checkpoint projection request is invalid.', () => {
      validateProjectionIdentity(request.identity);
      return normalizePageSize(request.pageSize);
    });
    const store = yield* CodeGraphStore;
    yield* observeExactCleanRepository(request.identity, 'before');
    const selected = yield* store.readySnapshotById(request.databasePath, request.snapshotId);
    if (selected === undefined) {
      return yield* CodeGraphCheckpointProjectionError.make({
        message: `Ready snapshot ${request.snapshotId} was not found.`,
      });
    }
    yield* attemptProjection('Checkpoint source snapshot is invalid.', () =>
      validateSelectedSnapshot(selected, request.identity),
    );
    const lease = yield* store.acquireSnapshotLease(
      request.databasePath,
      selected.id,
      CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS,
    );
    const renewLease = Effect.sleep(CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_RENEWAL_INTERVAL_MILLISECONDS).pipe(
      Effect.andThen(
        store.renewSnapshotLease(request.databasePath, lease, CODE_GRAPH_CHECKPOINT_PROJECTION_LEASE_MILLISECONDS),
      ),
      Effect.forever,
    );
    const projection = store
      .withSession(request.databasePath, projectInReadTransaction(request, selected, pageSize), {readOnly: true})
      .pipe(Effect.tap(() => observeExactCleanRepository(request.identity, 'after')));
    return yield* Effect.raceFirst(projection, renewLease).pipe(
      Effect.ensuring(store.releaseSnapshotLease(request.databasePath, lease).pipe(Effect.ignore)),
    );
  });
}

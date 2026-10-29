import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Effect} from 'effect';
import {readCodeGraphBuildStatuses} from '../build_status.js';
import type {CodeGraphLayout} from '../layout.js';
import type {CodeGraphStoreShape} from '../store.js';
import type {RepositoryIdentity} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** Reuse the exact snapshot published by a concurrent owner of the same request. */
export const completedConcurrentSnapshot = Effect.fn('codeGraph.completedConcurrentSnapshot')(function* (
  store: CodeGraphStoreShape,
  layout: CodeGraphLayout,
  identity: RepositoryIdentity,
  overlay: {readonly dirty: boolean; readonly fingerprint?: string},
  requestKey: string,
  requireDirectFull: boolean,
) {
  const statuses = yield* readCodeGraphBuildStatuses(layout);
  const completed = EffectOption.getOrUndefined(
    EffectArray.findFirst(statuses, status =>
      Boolean(status.state === 'completed' && status.request?.key === requestKey && status.result?.snapshotId),
    ),
  );
  if (!completed?.result?.snapshotId) return undefined;
  const ready = yield* store.currentLexicalReadySnapshotById(layout.databasePath, completed.result.snapshotId);
  if (
    !ready ||
    ready.commit !== identity.headCommit ||
    ready.dirty !== overlay.dirty ||
    (overlay.dirty &&
      requireDirectFull &&
      (ready.baseSnapshotId !== undefined || !Effect2.pipe(ready.id, EffectString.endsWith('-direct'))))
  ) {
    return undefined;
  }
  return ready;
});

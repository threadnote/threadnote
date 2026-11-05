import {Effect, FileSystem} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {CodeGraphProcessActivity} from '../runtime_ports.js';
import type {CodeGraphBuildResourceCoordinator} from '../build/resources.js';
import type {CodeGraphLayout} from '../layout.js';
import type {CodeGraphRetiredSnapshotCleanupProgress} from '../store.js';
import type {CodeGraphIndexOptions} from './types.js';
import {CODE_GRAPH_LOCK_OPTIONS} from './materialization.js';
import {codeGraphWriterResourceFactory, registerCodeGraphWriterCallbacks} from '../store/writer_gate_scope.js';

export function withCodeGraphProcessLock<A, E, R>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  onContention: () => Effect.Effect<void>,
  builderOperation: string,
  effect: Effect.Effect<A, E, R>,
  coordination?: {
    readonly onAcquired: () => Effect.Effect<void, never>;
    readonly onCompleted: () => Effect.Effect<void, never>;
  },
) {
  return Effect.flatMap(CodeGraphProcessActivity, activity =>
    activity.withActivity(
      'graph-waiter',
      'repository-lock',
      withExclusiveFileLock(
        fs,
        lockPath,
        {
          ...CODE_GRAPH_LOCK_OPTIONS,
          onContention,
          ...(coordination ? {onAcquired: coordination.onAcquired, onCompleted: coordination.onCompleted} : {}),
        },
        activity.withActivity('graph-builder', builderOperation, effect),
      ),
    ),
  );
}

export function writerSessionOptions(
  layout: CodeGraphLayout,
  options: Pick<CodeGraphIndexOptions, 'onProgress' | 'onSqliteWriterConfigured' | 'sqliteWriterTuning'>,
  resumeProgress: () => Effect.Effect<void, unknown>,
  resources?: CodeGraphBuildResourceCoordinator,
) {
  const onWriterAcquired = () =>
    (resources?.acquireWriter ?? Effect.void).pipe(
      Effect.orDie,
      Effect.andThen(Effect.suspend(resumeProgress)),
      Effect.ignore,
    );
  const onWriterReleased = () => (resources?.releaseWriter ?? Effect.void).pipe(Effect.orDie);
  const makeResourceGate = resources === undefined ? undefined : codeGraphWriterResourceFactory(resources);
  // Arbitrary coordinator-like objects and overridden callback pairs retain the opaque legacy path.
  if (resources === undefined || makeResourceGate !== undefined) {
    registerCodeGraphWriterCallbacks(onWriterAcquired, onWriterReleased, scope => {
      const gate = makeResourceGate?.(scope);
      return {
        acquire: (gate?.acquire ?? Effect.void).pipe(
          Effect.orDie,
          Effect.andThen(Effect.interruptible(Effect.suspend(resumeProgress))),
          Effect.ignore,
        ),
        observeRelease: gate?.observeRelease ?? Effect.void,
      };
    });
  }
  return {
    cleanupCompletedBuildRows: true,
    ...(options.onSqliteWriterConfigured ? {onSqliteWriterConfigured: options.onSqliteWriterConfigured} : {}),
    onWriterContention: () =>
      (resources?.assertWriterMayWait ?? Effect.void).pipe(
        Effect.orDie,
        Effect.andThen(
          Effect.interruptible(
            Effect.suspend(() => options.onProgress?.({phase: 'waiting', reason: 'database-writer'}) ?? Effect.void),
          ),
        ),
        Effect.ignore,
      ),
    onWriterAcquired,
    onWriterReleased,
    sqliteWriterTuning: {
      reconstructibleBuildSynchronous: 'normal' as const,
      ...options.sqliteWriterTuning,
    },
    writerLockPath: layout.databaseWriteLockPath,
  } as const;
}

export function retiredSnapshotCleanupReporter(onProgress: CodeGraphIndexOptions['onProgress']) {
  return (progress: CodeGraphRetiredSnapshotCleanupProgress) =>
    (
      onProgress?.({
        completed: progress.snapshotsCompleted,
        pagesCompleted: progress.pagesCompleted,
        phase: 'reclaiming',
        rowsDeleted: progress.rowsDeleted,
        total: progress.snapshotsTotal,
        unit: 'snapshots',
      }) ?? Effect.void
    ).pipe(Effect.ignore);
}

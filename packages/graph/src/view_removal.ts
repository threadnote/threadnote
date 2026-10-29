import {Effect, FileSystem, Option, Path, PlatformError, Schema} from 'effect';
import {
  captureCodeGraphLocalProvenanceCleanupEvidence,
  cleanupMissingCodeGraphLocalProvenance,
} from './local_provenance.js';
import {withCodeGraphTargetWorktreeLock} from './maintenance/gate.js';
import {
  CodeGraphStore,
  type CodeGraphViewObservationResult,
  type CodeGraphViewRemovalResult as CodeGraphStoreViewRemovalResult,
} from './store.js';
import {
  type CodeGraphVectorCleanupWarningCode,
  type CodeGraphVectorPointerCleanupResult,
} from './vector/maintenance.js';
import {CODE_GRAPH_SCHEMA_VERSION} from './types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export class CodeGraphViewRemovalError extends Schema.TaggedError<
  CodeGraphViewRemovalError,
  {readonly brand: unique symbol}
>()('CodeGraphViewRemovalError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const HASH_ID = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/;

export type CodeGraphViewRemovalWarningCode = CodeGraphVectorCleanupWarningCode | 'provenance-cleanup-unavailable';

export interface CodeGraphViewRemovalWarning {
  readonly code: CodeGraphViewRemovalWarningCode;
  readonly message: string;
  readonly occurrences: number;
  readonly retryable: boolean;
}

export interface CodeGraphViewRemovalCleanup {
  readonly provenance: {
    readonly observedState?: string;
    readonly state: 'not-found' | 'preserved' | 'removed' | 'unavailable';
  } | null;
  readonly vectors: Omit<CodeGraphVectorPointerCleanupResult, 'warnings'> | null;
}

export interface CodeGraphViewRemovalActionResult {
  readonly applied: boolean;
  readonly checkoutId: string;
  readonly cleanup: CodeGraphViewRemovalCleanup;
  readonly observedSnapshotId?: string;
  readonly observedState?: 'active' | 'removed';
  readonly retiredSnapshots?: number;
  readonly scopeId?: string;
  readonly snapshotId: string;
  readonly state: 'already-removed' | 'not-found' | 'ready' | 'removed' | 'stale-target';
  readonly type: 'code-graph-view-removal';
  readonly version: 1;
  readonly warnings: readonly CodeGraphViewRemovalWarning[];
  readonly worktreeId: string;
}

export interface CodeGraphViewRemovalTarget {
  readonly checkoutId: string;
  readonly scopeId?: string;
  readonly snapshotId: string;
  readonly worktreeId: string;
}

export interface CodeGraphViewRemovalOptions {
  readonly apply?: boolean;
  /** @internal Deterministic seam after the short provenance lock is released. */
  readonly afterProvenanceEvidenceCapture?: () => Effect.Effect<void, unknown>;
  /** Best-effort residual-maintenance kick, always invoked after the target lock is released. */
  readonly afterRemoval?: (input: {
    readonly checkoutId: string;
    readonly databasePath: string;
    readonly threadnoteHome: string;
    readonly worktreeId: string;
  }) => Effect.Effect<void, unknown>;
  /** @internal Deterministic replacement seam after core removal and before cleanup. */
  readonly beforeProvenanceCleanup?: () => Effect.Effect<void, unknown>;
}

export const removeCodeGraphView = Effect.fn('codeGraph.removeViewAction')(function* (
  threadnoteHome: string,
  target: CodeGraphViewRemovalTarget,
  options: CodeGraphViewRemovalOptions = {},
) {
  yield* validateCodeGraphViewRemovalTarget(target);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const inspected = yield* inspectCodeGraphViewDatabaseTarget(threadnoteHome, target.checkoutId);
  if (inspected.state === 'missing') {
    return actionResult(
      target,
      options.apply === true,
      {expectedSnapshotId: target.snapshotId, state: 'not-found'},
      {provenance: null, vectors: null},
      [],
    );
  }
  if (!options.apply) {
    const observation = yield* store.observeView(
      inspected.databasePath,
      target.worktreeId,
      target.snapshotId,
      target.scopeId,
    );
    return actionResult(target, false, observation, {provenance: null, vectors: null}, []);
  }

  const result = yield* withCodeGraphTargetWorktreeLock(
    inspected.canonicalHome,
    target.checkoutId,
    target.worktreeId,
    Effect.gen(function* () {
      const provenanceEvidence =
        target.scopeId === undefined
          ? yield* captureCodeGraphLocalProvenanceCleanupEvidence(inspected.canonicalHome, {
              checkoutId: target.checkoutId,
              worktreeId: target.worktreeId,
            })
          : undefined;
      yield* options.afterProvenanceEvidenceCapture?.() ?? Effect.void;
      const core = yield* store.removeView(inspected.databasePath, target.worktreeId, target.snapshotId, {
        ...(target.scopeId === undefined ? {} : {scopeId: target.scopeId}),
        beforeDatabaseOpen: () =>
          inspectCodeGraphViewDatabaseTarget(inspected.canonicalHome, target.checkoutId).pipe(
            Effect.flatMap(current =>
              current.state === 'ready' && current.databasePath === inspected.databasePath
                ? Effect.void
                : Effect.fail(
                    CodeGraphViewRemovalError.make({message: 'Code graph database target changed before removal.'}),
                  ),
            ),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
        waitTimeoutMilliseconds: 0,
        ...(provenanceEvidence === undefined
          ? {}
          : {
              cleanupEvidence: {
                recordDigest: provenanceEvidence.recordDigest,
                recordIdentity: provenanceEvidence.recordIdentity,
                repositoryId: provenanceEvidence.repositoryId,
              },
            }),
      });
      if (core.state !== 'removed' && core.state !== 'already-removed') {
        return actionResult(target, true, core, {provenance: null, vectors: null}, []);
      }

      yield* options.beforeProvenanceCleanup?.() ?? Effect.void;
      const provenance =
        core.state === 'already-removed'
          ? ({observedState: 'stale', state: 'preserved'} as const)
          : provenanceEvidence === undefined
            ? ({observedState: 'invalid', state: 'preserved'} as const)
            : yield* cleanupMissingCodeGraphLocalProvenance(
                inspected.canonicalHome,
                {checkoutId: target.checkoutId, worktreeId: target.worktreeId},
                {expectedEvidence: provenanceEvidence},
              );
      const warnings: CodeGraphViewRemovalWarning[] = [];
      if (provenance.state === 'unavailable') {
        warnings.push({
          code: 'provenance-cleanup-unavailable',
          message: 'Local provenance cleanup was unavailable; rerun the command to retry residual cleanup.',
          occurrences: 1,
          retryable: true,
        });
      }
      warnings.sort((left, right) => Effect2.pipe(left.code, EffectString.localeCompare(right.code)));
      return actionResult(
        target,
        true,
        core,
        {
          provenance,
          // Durable residual cleanup owns vector retirement so capacity is
          // acquired before the target worktree lock. Foreground removal must
          // never enter that reservation protocol while already holding it.
          vectors: null,
        },
        warnings,
      );
    }),
    target.scopeId,
  );
  if (result.state === 'removed' || result.state === 'already-removed') {
    yield* (
      options.afterRemoval?.({
        checkoutId: target.checkoutId,
        databasePath: inspected.databasePath,
        threadnoteHome: inspected.canonicalHome,
        worktreeId: target.worktreeId,
      }) ?? Effect.void
    ).pipe(Effect.ignore);
  }
  return result;
});

export type CodeGraphViewDatabaseTargetInspection =
  | {readonly state: 'missing'}
  | {readonly canonicalHome: string; readonly databasePath: string; readonly state: 'ready'};

export const inspectCodeGraphViewDatabaseTarget = Effect.fn('codeGraph.inspectViewDatabaseTarget')(function* (
  threadnoteHome: string,
  checkoutId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (Option.isSome(yield* fs.readLink(threadnoteHome).pipe(Effect.option))) {
    return yield* CodeGraphViewRemovalError.make({
      message: 'Threadnote home is a symbolic link; graph view removal was refused.',
    });
  }
  const homeInfo = yield* optionalFileInfo(fs, threadnoteHome);
  if (Option.isNone(homeInfo)) return {state: 'missing'} as const satisfies CodeGraphViewDatabaseTargetInspection;
  if (homeInfo.value.type !== 'Directory') {
    return yield* CodeGraphViewRemovalError.make({
      message: 'Threadnote home is not a directory; graph view removal was refused.',
    });
  }
  const canonicalHome = yield* fs.realPath(threadnoteHome);
  const segments = [
    'indexes',
    'code-graph',
    'repositories',
    checkoutId,
    `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
  ] as const;
  let current = canonicalHome;
  for (const [index, segment] of segments.entries()) {
    const candidate = path.join(current, segment);
    if (Option.isSome(yield* fs.readLink(candidate).pipe(Effect.option))) {
      return yield* CodeGraphViewRemovalError.make({
        message: 'Code graph database containment contains a symbolic link.',
      });
    }
    const info = yield* optionalFileInfo(fs, candidate);
    if (Option.isNone(info)) return {state: 'missing'} as const satisfies CodeGraphViewDatabaseTargetInspection;
    const final = index === segments.length - 1;
    if ((final && info.value.type !== 'File') || (!final && info.value.type !== 'Directory')) {
      return yield* CodeGraphViewRemovalError.make({
        message: 'Code graph database containment has an invalid entry type.',
      });
    }
    const canonical = yield* fs.realPath(candidate);
    if (canonical !== candidate || path.dirname(canonical) !== current || path.basename(canonical) !== segment) {
      return yield* CodeGraphViewRemovalError.make({
        message: 'Code graph database target escaped its derived-store root.',
      });
    }
    current = canonical;
  }
  return {
    canonicalHome,
    databasePath: current,
    state: 'ready',
  } as const satisfies CodeGraphViewDatabaseTargetInspection;
});

function optionalFileInfo(fs: FileSystem.FileSystem, candidate: string) {
  return fs.stat(candidate).pipe(
    Effect.asSome,
    Effect.catchIf(
      error => error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound',
      () => Effect.succeedNone,
    ),
  );
}

function actionResult(
  target: CodeGraphViewRemovalTarget,
  applied: boolean,
  core: CodeGraphViewObservationResult | CodeGraphStoreViewRemovalResult,
  cleanup: CodeGraphViewRemovalCleanup,
  warnings: readonly CodeGraphViewRemovalWarning[],
): CodeGraphViewRemovalActionResult {
  return {
    applied,
    checkoutId: target.checkoutId,
    cleanup,
    ...('observedSnapshotId' in core ? {observedSnapshotId: core.observedSnapshotId} : {}),
    ...('observedState' in core ? {observedState: core.observedState} : {}),
    ...('retiredSnapshots' in core ? {retiredSnapshots: core.retiredSnapshots} : {}),
    ...(target.scopeId === undefined ? {} : {scopeId: target.scopeId}),
    snapshotId: target.snapshotId,
    state: core.state,
    type: 'code-graph-view-removal',
    version: 1,
    warnings,
    worktreeId: target.worktreeId,
  };
}

const validateCodeGraphViewRemovalTarget = Effect.fn('codeGraph.validateViewRemovalActionTarget')(function* (
  target: CodeGraphViewRemovalTarget,
) {
  if (!HASH_ID.test(target.checkoutId)) {
    return yield* CodeGraphViewRemovalError.make({
      message: 'Code graph checkout identity must be 64 lowercase hexadecimal characters.',
    });
  }
  if (!HASH_ID.test(target.worktreeId)) {
    return yield* CodeGraphViewRemovalError.make({
      message: 'Code graph worktree identity must be 64 lowercase hexadecimal characters.',
    });
  }
  if (!SNAPSHOT_ID.test(target.snapshotId)) {
    return yield* CodeGraphViewRemovalError.make({message: 'Code graph snapshot identity is invalid.'});
  }
  if (target.scopeId !== undefined && !/^code-graph-scope:[0-9a-f]{64}$/u.test(target.scopeId)) {
    return yield* CodeGraphViewRemovalError.make({message: 'Code graph scope identity is invalid.'});
  }
});

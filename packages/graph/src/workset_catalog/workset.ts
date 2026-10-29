import {Array as EffectArray} from 'effect';
import {Cause, Clock, Crypto, Effect, Exit, FileSystem, Path, Ref, Result, Semaphore, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CommandExecutor} from '@threadnote/platform/command';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {requireWorkset} from '@threadnote/workspace/manifest';
import type {ProjectManifest, ResolvedWorkset, RuntimeConfig} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import {resolveCodeGraphCrossRepositoryBridges} from '../cross_repository/resolver.js';
import {readCodeGraphReadySnapshotMonikers} from '../cross_repository/snapshot_monikers.js';
import {
  readPublishedCodeGraphWorksetCatalogBridgeSetSummary,
  replaceCodeGraphWorksetCatalogBridgeSet,
  type CodeGraphCrossRepositoryBridgeSetSummaryV1,
} from '../cross_repository/store.js';
import type {CodeGraphMonikerV1} from '../cross_repository/types.js';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '../indexer.js';
import {runIsolatedCodeGraphIndexSnapshot} from '../isolated/index.js';
import {
  RepositoryMaintenanceInterrupted,
  RepositoryRegistrationLost,
  WorktreeChangedDuringIndex,
} from '../indexer/shared.js';
import {CodeGraphQueryService} from '../query.js';
import {CodeGraphLanguagePackRegistry} from '../languages/registry.js';
import {CodeGraphStore} from '../store.js';
import {CodeGraphObservability} from '../runtime_ports.js';
import {
  CodeGraphRepositoryError,
  isCodeGraphStoreError,
  type CodeGraphIndexSummary,
  type CodeGraphProgress,
  type CodeGraphSnapshot,
  type CodeGraphStatus,
  type CodeGraphStoreFailureCode,
  type CodeGraphStoreRecovery,
  type RepositoryIdentity,
} from '../types.js';
import {stageCodeGraphWorksetRoutingProjectionScoped} from './projection/builder.js';
import {codeGraphWorksetCatalogLayout} from './layout.js';
import {normalizeWorksetScopeReceipt} from './scope_receipt.js';
import {renderCodeGraphWorksetPrepareProgress} from './progress_render.js';
import {
  maintainCodeGraphWorksetCatalogPreparationPage,
  publishCodeGraphWorksetCatalogGeneration,
  readPublishedCodeGraphWorksetCatalogGeneration,
  registerCodeGraphQualifiedRef,
  retireCodeGraphWorksetCatalogPreparation,
  stageCodeGraphWorksetCatalogGenerationFromReceipts,
} from './store.js';
import {CodeGraphWorksetCatalogError} from './types.js';
import type {
  CodeGraphWorksetCatalogGenerationDigestMemberV1,
  CodeGraphWorksetCatalogGenerationReceiptV1,
  CodeGraphWorksetCatalogPublishedGenerationV1,
  CodeGraphWorksetCatalogPublishedMemberV1,
  CodeGraphWorksetScopeReceiptV1,
} from './types.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

export const CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT = 2;
export const CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_MAXIMUM = 8;
export const CODE_GRAPH_WORKSET_PREPARE_MEMBER_ATTEMPTS_MAXIMUM = 2;
const CODE_GRAPH_WORKSET_PREPARE_RETRY_DELAY = '250 millis';
const WORKSET_PREPARE_LOCK_OPTIONS = {
  heartbeatIntervalMilliseconds: 10_000,
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 30_000,
  waitTimeoutMilliseconds: 30_000,
} as const;

export type CodeGraphWorksetPrepareMemberV1 =
  | {
      readonly project: string;
      readonly projectionDigest: string;
      readonly repositoryId: string;
      readonly snapshotId: string;
      readonly state: 'ready';
      readonly symbolCount: number;
    }
  | {
      readonly project: string;
      readonly reason: 'unknown-project';
      readonly state: 'excluded';
    }
  | {
      readonly detail: CodeGraphWorksetPrepareFailureDetailV1;
      readonly project: string;
      readonly reason: 'index-failed' | 'projection-failed';
      readonly state: 'failed';
    }
  | {
      readonly project: string;
      readonly reason: 'missing-path';
      readonly state: 'missing';
    };

export type CodeGraphWorksetPrepareFailureCodeV1 =
  CodeGraphStoreFailureCode | 'catalog' | 'repository' | 'worktree-changed' | 'unknown';

export interface CodeGraphWorksetPrepareFailureDetailV1 {
  readonly code: CodeGraphWorksetPrepareFailureCodeV1;
  readonly errorType: string;
  readonly recovery?: CodeGraphStoreRecovery;
  readonly retryable: boolean;
  /** Authored, path-free diagnostic safe for CLI and Manager receipts. */
  readonly summary: string;
}

export interface CodeGraphWorksetPrepareCoverageV1 {
  readonly complete: boolean;
  readonly excluded: number;
  readonly failed: number;
  readonly missing: number;
  readonly ready: number;
  readonly requested: number;
}

export interface CodeGraphWorksetPrepareResultV1 {
  readonly bridges?: CodeGraphWorksetPrepareBridgeReceiptV1;
  readonly coverage: CodeGraphWorksetPrepareCoverageV1;
  readonly manifestDigest: string;
  readonly members: readonly CodeGraphWorksetPrepareMemberV1[];
  readonly published?: CodeGraphWorksetCatalogGenerationReceiptV1;
  readonly state: 'failed' | 'ready';
  readonly type: 'code-graph-workset-prepare';
  readonly version: 1;
  readonly workset: string;
}

export interface CodeGraphWorksetPrepareBridgeReceiptV1 {
  readonly bridgeCount: number;
  readonly digest: string;
  readonly monikerCount: number;
  readonly rejectionCount: number;
  readonly resolverVersion: number;
  readonly state: 'ready' | 'unavailable';
  readonly unavailableRepositories: readonly string[];
  readonly warnings: readonly string[];
}

export interface CodeGraphWorksetBridgePreparationMemberV1 {
  readonly assertLease: Effect.Effect<void, unknown>;
  readonly identity: Pick<RepositoryIdentity, 'checkoutId' | 'repositoryId' | 'worktreeId'>;
  readonly project: string;
  readonly repositoryId: string;
  readonly snapshotId: string;
}

export type CodeGraphWorksetStatusMemberStateV1 =
  'current' | 'deferred' | 'excluded' | 'failed' | 'missing' | 'stale' | 'uncatalogued';

export interface CodeGraphWorksetStatusMemberV1 {
  readonly projectCoverage?: CodeGraphStatus['projectCoverage'];
  readonly detail?: {
    readonly code: CodeGraphStoreFailureCode | 'repository';
    readonly recovery?: CodeGraphStoreRecovery;
    readonly retryable: boolean;
  };
  readonly project: string;
  readonly reason?:
    | 'catalog-generation-drift'
    | 'checkout-drift'
    | 'identity-drift'
    | 'invalid-repository'
    | 'missing-path'
    | 'no-ready-snapshot'
    | 'not-in-published-generation'
    | 'snapshot-drift'
    | 'scope-drift'
    | 'status-corrupt'
    | 'status-failed'
    | 'status-incompatible'
    | 'status-unavailable'
    | 'unknown-project'
    | 'worktree-drift'
    | 'worktree-stale';
  readonly repositoryId?: string;
  readonly snapshotId?: string;
  readonly state: CodeGraphWorksetStatusMemberStateV1;
}

export interface CodeGraphWorksetStatusResultV1 {
  readonly bridges?: CodeGraphCrossRepositoryBridgeSetSummaryV1;
  readonly catalog: {
    readonly generation?: {readonly digest: string; readonly id: string};
    readonly manifestDigest?: string;
    readonly state: 'missing' | 'ready' | 'stale';
  };
  readonly coverage: {
    readonly current: number;
    readonly requested: number;
    readonly states: Readonly<Record<CodeGraphWorksetStatusMemberStateV1, number>>;
  };
  readonly manifestDigest: string;
  readonly members: readonly CodeGraphWorksetStatusMemberV1[];
  readonly type: 'code-graph-workset-status';
  readonly version: 1;
  readonly warnings: readonly string[];
  readonly workset: string;
}

export interface PrepareCodeGraphWorksetOptionsV1 {
  readonly concurrency?: number;
  /** @internal Keep a long-lived Manager host out of repository-sized SQLite work. */
  readonly isolateBuilds?: boolean;
  readonly onProgress?: (progress: CodeGraphWorksetPrepareProgressV1) => Effect.Effect<void, unknown>;
}

export type CodeGraphWorksetPreparePhaseV1 =
  | 'bridging'
  | 'cataloging'
  | 'completed'
  | 'failed'
  | 'indexing'
  | 'projecting'
  | 'publishing'
  | 'starting'
  | 'waiting';

export interface CodeGraphWorksetPrepareIndexActivityV1 {
  readonly completed?: number;
  readonly phase: CodeGraphProgress['phase'];
  readonly reason?: Extract<CodeGraphProgress, {readonly phase: 'waiting'}>['reason'];
  readonly subphase?: string;
  readonly total?: number;
  readonly unit?: 'files' | 'snapshots' | 'symbols';
}

export interface CodeGraphWorksetPrepareProgressV1 {
  readonly activity?: CodeGraphWorksetPrepareIndexActivityV1;
  readonly attempt?: number;
  readonly completed: number;
  readonly elapsedMilliseconds: number;
  readonly maxAttempts?: number;
  readonly member?: CodeGraphWorksetPrepareMemberV1;
  readonly message: string;
  readonly phase: CodeGraphWorksetPreparePhaseV1;
  readonly project?: string;
  readonly resultState?: CodeGraphWorksetPrepareResultV1['state'];
  readonly total: number;
  readonly type: 'code-graph-workset-progress';
  readonly version: 1;
  readonly workset: string;
}

export {renderCodeGraphWorksetPrepareProgress} from './progress_render.js';

interface CodeGraphWorksetPrepareProgressInputV1 {
  readonly activity?: CodeGraphWorksetPrepareIndexActivityV1;
  readonly attempt?: number;
  readonly completed?: number;
  readonly maxAttempts?: number;
  readonly member?: CodeGraphWorksetPrepareMemberV1;
  readonly phase: CodeGraphWorksetPreparePhaseV1;
  readonly project?: string;
  readonly resultState?: CodeGraphWorksetPrepareResultV1['state'];
}

export function codeGraphWorksetManifestDigest(workset: ResolvedWorkset): string {
  const projects = EffectArray.map(
    workset.projects,
    project =>
      [
        project.name,
        project.path,
        project.uri,
        ...(project.graph === undefined
          ? []
          : [
              JSON.stringify({
                closure: project.graph.closure,
                roots: [...new Set(project.graph.roots)].sort(compareText),
                include: [...new Set(project.graph.include ?? [])].sort(compareText),
              }),
            ]),
      ] as const,
  ).sort(compareProjectDigestEntry);
  const unresolved = [...workset.unresolvedProjects].sort(compareText);
  return sha256HexSync(
    JSON.stringify(['threadnote-code-graph-workset-manifest-v1', workset.name, projects, unresolved]),
  );
}

/**
 * Attempt every configured member, derive routing-only projections for the
 * ready subset, and atomically publish that non-empty subset. Missing or failed
 * members remain explicit receipts; an incomplete projection never reaches the
 * generation pointer.
 */
const prepareCodeGraphWorksetScoped = Effect.fn('codeGraphWorkset.prepareScoped')(function* (
  config: RuntimeConfig,
  worksetName: string,
  options: PrepareCodeGraphWorksetOptionsV1 = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const indexer = yield* CodeGraphIndexer;
  const workset = yield* requireWorkset(config.manifestPath, worksetName);
  const concurrency = yield* Effect.try({
    try: () => prepareConcurrency(options.concurrency),
    catch: cause =>
      CodeGraphWorksetCatalogError.of('invalid-input', cause instanceof Error ? cause.message : String(cause), {
        cause,
      }),
  });
  const manifestDigest = codeGraphWorksetManifestDigest(workset);
  const total = workset.projects.length + workset.unresolvedProjects.length;
  const startedAt = yield* Clock.currentTimeMillis;
  const completed = yield* Ref.make(0);
  const progressGate = yield* Semaphore.make(1);
  const telemetry = yield* (yield* CodeGraphObservability).makeWorksetReporter;
  const reportAt = (input: CodeGraphWorksetPrepareProgressInputV1) =>
    progressGate.withPermit(
      Effect.all([Clock.currentTimeMillis, Ref.get(completed)]).pipe(
        Effect.flatMap(([now, completedMembers]) =>
          reportCodeGraphWorksetPrepareProgress(options.onProgress, telemetry.progress, {
            ...input,
            completed: input.completed ?? completedMembers,
            elapsedMilliseconds: Math.max(0, now - startedAt),
            message: '',
            total,
            type: 'code-graph-workset-progress',
            version: 1,
            workset: workset.name,
          }),
        ),
        Effect.ignoreCause,
      ),
    );
  const completeMember = (phase: 'indexing' | 'projecting', member: CodeGraphWorksetPrepareMemberV1) =>
    Ref.updateAndGet(completed, value => Math.min(total, value + 1)).pipe(
      Effect.flatMap(count => reportAt({completed: count, member, phase, project: member.project})),
    );
  yield* reportAt({phase: 'starting'});
  const unresolved: readonly PreparedMemberWithProjection[] = EffectArray.map(
    workset.unresolvedProjects,
    project =>
      ({
        project: safeLabel(project),
        reason: 'unknown-project',
        state: 'excluded',
      }) as const satisfies CodeGraphWorksetPrepareMemberV1,
  );
  yield* Effect.forEach(unresolved, member => completeMember('indexing', member), {discard: true});
  const indexed = yield* Effect.forEach(
    workset.projects,
    project =>
      prepareConfiguredSnapshot(config, project, fs, indexer, options.isolateBuilds === true, reportAt, completeMember),
    {concurrency},
  );
  const projectionDigests = new Set<string>();
  let stagedGenerationId: string | undefined;
  const critical = Effect.gen(function* () {
    yield* assertCurrentWorksetManifest(config, workset.name, manifestDigest);
    yield* reportAt({phase: 'cataloging'});
    yield* drainCodeGraphWorksetCatalogCleanup(config.agentContextHome);
    // Projection reads and catalog appends are deliberately serial: at most one
    // normalized symbol page is live across the complete preparation.
    const configured: readonly PreparedMemberWithProjection[] = yield* Effect.forEach(
      indexed,
      member =>
        stageConfiguredMember(config, member, reportAt, completeMember).pipe(
          Effect.tap(prepared =>
            Effect.sync(() => {
              if (prepared.state === 'ready') projectionDigests.add(prepared.projectionDigest);
            }),
          ),
        ),
      {concurrency: 1},
    );
    const members: readonly PreparedMemberWithProjection[] = [...configured, ...unresolved];
    const generationMembers = EffectArray.flatMap(members, member =>
      member.state === 'ready' ? [preparedGenerationMember(member)] : [],
    );
    if (generationMembers.length === 0) {
      return prepareResult(workset.name, manifestDigest, members, undefined);
    }
    yield* assertPreparedMemberLeases(members);
    const staged = yield* stageCodeGraphWorksetCatalogGenerationFromReceipts(config.agentContextHome, {
      manifestDigest,
      members: generationMembers,
      worksetName: workset.name,
    });
    stagedGenerationId = staged.state === 'staging' ? staged.id : undefined;
    const bridgeMembers = EffectArray.filter(
      members,
      (member): member is PreparedReadyMember => member.state === 'ready',
    );
    yield* reportAt({completed: yield* Ref.get(completed), phase: 'bridging'});
    const bridges = yield* prepareCodeGraphWorksetBridgesForGeneration(config, staged.id, bridgeMembers);
    yield* assertPreparedMemberLeases(members);
    yield* reportAt({completed: yield* Ref.get(completed), phase: 'publishing'});
    const published = yield* publishCodeGraphWorksetCatalogGeneration(config.agentContextHome, {
      beforePointerSwap: () =>
        assertPreparedMemberLeases(members).pipe(
          Effect.andThen(assertCurrentWorksetManifest(config, workset.name, manifestDigest)),
        ),
      generationId: staged.id,
      worksetName: workset.name,
    });
    stagedGenerationId = undefined;
    return prepareResult(workset.name, manifestDigest, members, published, bridges);
  }).pipe(
    Effect.onExit(exit =>
      (Exit.isSuccess(exit)
        ? drainCodeGraphWorksetCatalogCleanup(config.agentContextHome)
        : retireCodeGraphWorksetCatalogPreparation(config.agentContextHome, {
            ...(stagedGenerationId === undefined ? {} : {generationId: stagedGenerationId}),
            projectionDigests: [...projectionDigests],
          }).pipe(Effect.andThen(drainCodeGraphWorksetCatalogCleanup(config.agentContextHome)))
      ).pipe(Effect.ignoreCause),
    ),
  );
  const layout = codeGraphWorksetCatalogLayout(path, config.agentContextHome);
  yield* reportAt({completed: yield* Ref.get(completed), phase: 'waiting'});
  return yield* withExclusiveFileLock(fs, layout.prepareLockPath, WORKSET_PREPARE_LOCK_OPTIONS, critical).pipe(
    Effect.mapError(cause =>
      Schema.is(CodeGraphWorksetCatalogError)(cause)
        ? cause
        : CodeGraphWorksetCatalogError.of(
            isFileLockTimeout(cause) ? 'busy' : 'storage',
            isFileLockTimeout(cause)
              ? 'Timed out waiting to prepare the home-global workset catalog.'
              : 'Unable to serialize home-global workset preparation.',
            {cause},
          ),
    ),
    Effect.tap(result =>
      reportAt({completed: total, phase: 'completed', resultState: result.state}).pipe(
        Effect.andThen(telemetry.terminal(result)),
      ),
    ),
    Effect.onExit(exit =>
      Exit.isFailure(exit)
        ? Ref.get(completed).pipe(
            Effect.flatMap(count =>
              reportAt({completed: count, phase: 'failed'}).pipe(
                Effect.andThen(telemetry.failure(Cause.squash(exit.cause), count, total)),
              ),
            ),
          )
        : Effect.void,
    ),
  );
});

function reportCodeGraphWorksetPrepareProgress(
  reporter: PrepareCodeGraphWorksetOptionsV1['onProgress'],
  telemetryReporter: (progress: CodeGraphWorksetPrepareProgressV1) => Effect.Effect<void>,
  progress: CodeGraphWorksetPrepareProgressV1,
) {
  const event = {...progress, message: renderCodeGraphWorksetPrepareProgress(progress)};
  return Effect.all([reporter?.(event) ?? Effect.void, telemetryReporter(event)], {discard: true}).pipe(
    Effect.ignoreCause,
  );
}

function codeGraphWorksetPrepareIndexActivity(progress: CodeGraphProgress): CodeGraphWorksetPrepareIndexActivityV1 {
  const measured =
    'completed' in progress && 'total' in progress
      ? {
          completed: progress.completed,
          total: progress.total,
          ...('unit' in progress ? {unit: progress.unit} : {}),
        }
      : {};
  return {
    ...measured,
    phase: progress.phase,
    ...(progress.phase === 'waiting' && progress.reason !== undefined ? {reason: progress.reason} : {}),
    ...('subphase' in progress && progress.subphase !== undefined ? {subphase: progress.subphase} : {}),
  };
}

function assertCurrentWorksetManifest(config: RuntimeConfig, worksetName: string, expectedDigest: string) {
  return requireWorkset(config.manifestPath, worksetName).pipe(
    Effect.flatMap(current =>
      codeGraphWorksetManifestDigest(current) === expectedDigest
        ? Effect.void
        : Effect.fail(
            CodeGraphWorksetCatalogError.of(
              'stale',
              'The workset definition changed while its catalog generation was preparing.',
            ),
          ),
    ),
    Effect.mapError(cause =>
      Schema.is(CodeGraphWorksetCatalogError)(cause)
        ? cause
        : CodeGraphWorksetCatalogError.of(
            'stale',
            'The workset definition changed while its catalog generation was preparing.',
            {cause},
          ),
    ),
  );
}

export const prepareCodeGraphWorkset = Effect.fn('codeGraphWorkset.prepare')(function* (
  config: RuntimeConfig,
  worksetName: string,
  options: PrepareCodeGraphWorksetOptionsV1 = {},
) {
  // Every member projection lease remains registered in this shared scope until
  // the complete generation has been atomically published (or preparation
  // fails), so an early projection cannot disappear while later members build.
  return yield* prepareCodeGraphWorksetScoped(config, worksetName, options).pipe(Effect.scoped);
});

/** Read manifest, ready-snapshot, and published-catalog drift without cold indexing. */
export const inspectCodeGraphWorksetStatus = Effect.fn('codeGraphWorkset.status')(function* (
  config: RuntimeConfig,
  worksetName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const query = yield* CodeGraphQueryService;
  const workset = yield* requireWorkset(config.manifestPath, worksetName);
  const manifestDigest = codeGraphWorksetManifestDigest(workset);
  const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(config.agentContextHome, workset.name);
  const bridges =
    published === undefined
      ? undefined
      : yield* readPublishedCodeGraphWorksetCatalogBridgeSetSummary(config.agentContextHome, published.id).pipe(
          Effect.orElseSucceed(() => undefined),
        );
  const publishedByProject = new Map(
    EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(published?.members), __effectArrayReceiver =>
        EffectArray.map(__effectArrayReceiver, member => [member.repositoryKey, member]),
      ),
    ) ?? [],
  );
  const configured = yield* Effect.forEach(
    workset.projects,
    project => inspectConfiguredMember(config, project, publishedByProject.get(safeLabel(project.name)), fs, query),
    {concurrency: CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT},
  );
  const unresolved = EffectArray.map(
    workset.unresolvedProjects,
    project =>
      ({
        project: safeLabel(project),
        reason: 'unknown-project',
        state: 'excluded',
      }) as const satisfies CodeGraphWorksetStatusMemberV1,
  );
  let members: readonly CodeGraphWorksetStatusMemberV1[] = [...configured, ...unresolved];
  const generationDrift =
    published !== undefined && !codeGraphWorksetCatalogGenerationMatches(workset, manifestDigest, published);
  if (generationDrift) {
    members = EffectArray.map(members, member =>
      member.state === 'current' ? {...member, reason: 'catalog-generation-drift', state: 'stale'} : member,
    );
  }
  const states = statusStateCounts(members);
  const catalogState =
    published === undefined ? 'missing' : generationDrift || states.current !== members.length ? 'stale' : 'ready';
  const warnings = [
    ...(published === undefined ? ['No published routing catalog exists; run `threadnote workset prepare`.'] : []),
    ...(states.uncatalogued > 0
      ? [
          `${states.uncatalogued} member(s) have a ready repository snapshot but are absent from the published workset generation; prepare the workset and review its member receipts.`,
        ]
      : []),
    ...(states.deferred > 0
      ? [
          `${states.deferred} member(s) need a ready repository snapshot; workset preparation will index them explicitly.`,
        ]
      : []),
    ...(states.failed > 0
      ? [`${states.failed} member status check(s) failed; review the typed recovery detail below.`]
      : []),
    ...(states.missing > 0
      ? [`${states.missing} configured member path(s) are missing; correct the project path or restore the checkout.`]
      : []),
    ...(states.stale > 0
      ? [`${states.stale} member(s) no longer match the published generation; prepare the workset again.`]
      : []),
    ...(generationDrift ? ['The published catalog generation does not match the current workset manifest.'] : []),
    ...(unresolved.length > 0 ? ['The workset names projects that are absent from the seed manifest.'] : []),
    ...(published !== undefined && bridges === undefined
      ? ['The published workset generation has no readable cross-repository bridge receipt.']
      : []),
    ...(bridges !== undefined && bridges.coverage.state !== 'complete'
      ? ['Cross-repository bridge coverage is incomplete; path and impact will not infer missing edges.']
      : []),
  ];
  return {
    ...(bridges === undefined ? {} : {bridges}),
    catalog: {
      ...(published === undefined ? {} : {generation: {digest: published.digest, id: published.id}}),
      ...(published === undefined ? {} : {manifestDigest: published.manifestDigest}),
      state: catalogState,
    },
    coverage: {current: states.current, requested: members.length, states},
    manifestDigest,
    members,
    type: 'code-graph-workset-status',
    version: 1,
    warnings,
    workset: workset.name,
  } as const satisfies CodeGraphWorksetStatusResultV1;
});

function prepareConfiguredSnapshot(
  config: RuntimeConfig,
  project: ProjectManifest,
  fs: FileSystem.FileSystem,
  indexer: CodeGraphIndexerShape,
  isolateBuild: boolean,
  report: (progress: CodeGraphWorksetPrepareProgressInputV1) => Effect.Effect<void>,
  completeMember: (phase: 'indexing' | 'projecting', member: CodeGraphWorksetPrepareMemberV1) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const cwd = yield* expandPath(project.path);
    if (!(yield* fs.exists(cwd))) {
      const missing = failedPrepareMember(project.name, 'missing-path');
      yield* completeMember('indexing', missing);
      return missing;
    }
    const projectName = safeLabel(project.name);
    type IsolatedIndexRequirements =
      | CodeGraphLanguagePackRegistry
      | CodeGraphStore
      | CommandExecutor
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | SystemInfo;
    const indexAttempt = (
      attempt: number,
    ): Effect.Effect<Pick<CodeGraphIndexSummary, 'identity' | 'snapshot'>, unknown, IsolatedIndexRequirements> => {
      const indexOptions = {
        manifestPath: config.manifestPath,
        project,
        cwd,
        ensureVectors: false,
        onProgress: (progress: CodeGraphProgress) =>
          report({
            activity: codeGraphWorksetPrepareIndexActivity(progress),
            attempt,
            maxAttempts: CODE_GRAPH_WORKSET_PREPARE_MEMBER_ATTEMPTS_MAXIMUM,
            phase: 'indexing',
            project: projectName,
          }),
        threadnoteHome: config.agentContextHome,
      };
      const selectIndexResult = (
        summary: Pick<CodeGraphIndexSummary, 'identity' | 'snapshot'>,
      ): Pick<CodeGraphIndexSummary, 'identity' | 'snapshot'> => ({
        identity: summary.identity,
        snapshot: summary.snapshot,
      });
      const index: Effect.Effect<
        Pick<CodeGraphIndexSummary, 'identity' | 'snapshot'>,
        unknown,
        IsolatedIndexRequirements
      > = isolateBuild
        ? runIsolatedCodeGraphIndexSnapshot(indexOptions).pipe(Effect.map(selectIndexResult))
        : indexer.index(indexOptions).pipe(Effect.map(selectIndexResult));
      return report({
        attempt,
        maxAttempts: CODE_GRAPH_WORKSET_PREPARE_MEMBER_ATTEMPTS_MAXIMUM,
        phase: 'indexing',
        project: projectName,
      }).pipe(
        Effect.andThen(index),
        Effect.catchIf(
          error =>
            attempt < CODE_GRAPH_WORKSET_PREPARE_MEMBER_ATTEMPTS_MAXIMUM &&
            codeGraphWorksetPrepareFailureDetail(error, 'index').retryable,
          () => Effect.sleep(CODE_GRAPH_WORKSET_PREPARE_RETRY_DELAY).pipe(Effect.andThen(indexAttempt(attempt + 1))),
        ),
      );
    };
    const outcome = yield* Effect.result(indexAttempt(1));
    if (Result.isFailure(outcome)) {
      const failed = failedPrepareMember(project.name, 'index-failed', outcome.failure);
      yield* completeMember('indexing', failed);
      return failed;
    }
    const indexed = outcome.success;
    return {
      indexed: {identity: indexed.identity, snapshot: indexed.snapshot},
      project: projectName,
      state: 'indexed',
    } as const;
  }).pipe(
    Effect.catch(error => {
      const failed = failedPrepareMember(project.name, 'index-failed', error);
      return completeMember('indexing', failed).pipe(Effect.as(failed));
    }),
  );
}

function stageConfiguredMember(
  config: RuntimeConfig,
  member: PreparedSnapshotMember,
  report: (progress: CodeGraphWorksetPrepareProgressInputV1) => Effect.Effect<void>,
  completeMember: (phase: 'indexing' | 'projecting', member: CodeGraphWorksetPrepareMemberV1) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    if (member.state !== 'indexed') return member;
    yield* report({phase: 'projecting', project: member.project});
    const outcome = yield* Effect.result(
      stageCodeGraphWorksetRoutingProjectionScoped({
        identity: member.indexed.identity,
        scopeId: member.indexed.snapshot.scopeId,
        snapshotId: member.indexed.snapshot.id,
        threadnoteHome: config.agentContextHome,
      }),
    );
    if (Result.isFailure(outcome)) {
      const failed = failedPrepareMember(member.project, 'projection-failed', outcome.failure);
      yield* completeMember('projecting', failed);
      return failed;
    }
    const built = outcome.success;
    const ready = {
      scope: normalizeWorksetScopeReceipt(built.receipt),
      assertLease: built.assertLease,
      identity: member.indexed.identity,
      project: member.project,
      projectionDigest: built.receipt.projectionDigest,
      repositoryId: built.receipt.repositoryId,
      snapshotId: built.receipt.snapshotId,
      state: 'ready' as const,
      symbolCount: built.receipt.symbolCount,
    };
    yield* completeMember('projecting', publicPrepareMember(ready));
    return ready;
  });
}

function inspectConfiguredMember(
  config: RuntimeConfig,
  project: ProjectManifest,
  published: CodeGraphWorksetCatalogPublishedMemberV1 | undefined,
  fs: FileSystem.FileSystem,
  query: {
    readonly status: (
      threadnoteHome: string,
      cwd: string,
      options?: {readonly requestMaintenance?: boolean; readonly project?: string; readonly manifestPath?: string},
    ) => Effect.Effect<CodeGraphStatus, unknown>;
  },
) {
  return Effect.gen(function* () {
    const cwd = yield* expandPath(project.path);
    if (!(yield* fs.exists(cwd))) {
      return {project: safeLabel(project.name), reason: 'missing-path', state: 'missing'} as const;
    }
    const status = yield* query.status(config.agentContextHome, cwd, {
      requestMaintenance: false,
      project: project.name,
      manifestPath: config.manifestPath,
    });
    return classifyCodeGraphWorksetStatusMember(project.name, status, published);
  }).pipe(Effect.catch(error => Effect.succeed(classifyCodeGraphWorksetStatusFailure(project.name, error))));
}

/** Convert status failures to bounded pathless diagnostics without erasing typed storage causes. */
export function classifyCodeGraphWorksetStatusFailure(project: string, error: unknown): CodeGraphWorksetStatusMemberV1 {
  if (Schema.is(CodeGraphRepositoryError)(error)) {
    return {
      detail: {code: 'repository', retryable: false},
      project: safeLabel(project),
      reason: 'invalid-repository',
      state: 'failed',
    };
  }
  if (isCodeGraphStoreError(error)) {
    const reason =
      error.code === 'confirmed-corruption'
        ? 'status-corrupt'
        : error.code === 'incompatible-schema' || error.code === 'schema-additive'
          ? 'status-incompatible'
          : error.code === 'busy' || error.code === 'transient-io'
            ? 'status-unavailable'
            : 'status-failed';
    return {
      detail: {code: error.code, recovery: error.recovery, retryable: error.retryable},
      project: safeLabel(project),
      reason,
      state: 'failed',
    };
  }
  return {
    detail: {code: 'unknown', retryable: false},
    project: safeLabel(project),
    reason: 'status-failed',
    state: 'failed',
  };
}

export function classifyCodeGraphWorksetStatusMember(
  project: string,
  status: Pick<CodeGraphStatus, 'identity' | 'readySnapshot' | 'stale' | 'projectCoverage'>,
  published: CodeGraphWorksetCatalogPublishedMemberV1 | undefined,
): CodeGraphWorksetStatusMemberV1 {
  const common = {
    ...(status.projectCoverage === undefined ? {} : {projectCoverage: status.projectCoverage}),
    project: safeLabel(project),
    repositoryId: status.identity.repositoryId,
    ...(status.readySnapshot === undefined ? {} : {snapshotId: status.readySnapshot.id}),
  };
  if (status.readySnapshot === undefined) return {...common, reason: 'no-ready-snapshot', state: 'deferred'};
  if (published === undefined) return {...common, reason: 'not-in-published-generation', state: 'uncatalogued'};
  if (published.repositoryId !== status.identity.repositoryId)
    return {...common, reason: 'identity-drift', state: 'stale'};
  if (published.checkoutId !== status.identity.checkoutId) return {...common, reason: 'checkout-drift', state: 'stale'};
  if (published.worktreeId !== status.identity.worktreeId) return {...common, reason: 'worktree-drift', state: 'stale'};
  if (published.snapshotId !== status.readySnapshot.id) return {...common, reason: 'snapshot-drift', state: 'stale'};
  try {
    if (normalizeWorksetScopeReceipt(published).scopeId !== (status.readySnapshot.scopeId ?? 'full-repository')) {
      return {...common, reason: 'scope-drift', state: 'stale'};
    }
  } catch {
    return {...common, reason: 'scope-drift', state: 'stale'};
  }
  if (status.stale) return {...common, reason: 'worktree-stale', state: 'stale'};
  return {...common, state: 'current'};
}

/**
 * Validate both the digest receipt and a unique non-empty subset of configured
 * project keys. Coverage gaps remain queryable facts without allowing unknown
 * or duplicated catalog members to pass solely on a manifest digest.
 */
export function codeGraphWorksetCatalogGenerationMatches(
  workset: ResolvedWorkset,
  manifestDigest: string,
  published: CodeGraphWorksetCatalogPublishedGenerationV1,
): boolean {
  if (published.manifestDigest !== manifestDigest) return false;
  const expected = new Set(EffectArray.map(workset.projects, project => safeLabel(project.name)));
  const actual = EffectArray.map(published.members, member => member.repositoryKey);
  if (actual.length === 0 || new Set(actual).size !== actual.length) return false;
  return EffectArray.every(published.members, member => {
    if (!expected.has(member.repositoryKey)) return false;
    const project = EffectOption.getOrUndefined(
      EffectArray.findFirst(workset.projects, candidate => safeLabel(candidate.name) === member.repositoryKey),
    )!;
    const scopeId = project.graph === undefined ? 'full-repository' : `code-graph-scope:${sha256HexSync(project.uri)}`;
    try {
      return normalizeWorksetScopeReceipt(member).scopeId === scopeId;
    } catch {
      return false;
    }
  });
}

function preparedGenerationMember(member: PreparedReadyMember): CodeGraphWorksetCatalogGenerationDigestMemberV1 {
  return {
    ...member.scope,
    projectionDigest: member.projectionDigest,
    repositoryId: member.repositoryId,
    repositoryKey: member.project,
    snapshotId: member.snapshotId,
  };
}

type PreparedReadyMember = Extract<CodeGraphWorksetPrepareMemberV1, {readonly state: 'ready'}> & {
  readonly scope: CodeGraphWorksetScopeReceiptV1;
  readonly assertLease: Effect.Effect<void, unknown>;
  readonly identity: Pick<RepositoryIdentity, 'checkoutId' | 'repositoryId' | 'worktreeId'>;
};

type PreparedSnapshotMember =
  | {
      readonly indexed: {readonly identity: RepositoryIdentity; readonly snapshot: CodeGraphSnapshot};
      readonly project: string;
      readonly state: 'indexed';
    }
  | Exclude<CodeGraphWorksetPrepareMemberV1, {readonly state: 'ready'}>;

type PreparedMemberWithProjection =
  PreparedReadyMember | Exclude<CodeGraphWorksetPrepareMemberV1, {readonly state: 'ready'}>;

function failedPrepareMember(
  project: string,
  reason: 'index-failed' | 'missing-path' | 'projection-failed',
  error?: unknown,
): Exclude<CodeGraphWorksetPrepareMemberV1, {readonly state: 'excluded' | 'ready'}> {
  if (reason === 'missing-path') return {project: safeLabel(project), reason, state: 'missing'};
  return {
    detail: codeGraphWorksetPrepareFailureDetail(error, reason === 'index-failed' ? 'index' : 'projection'),
    project: safeLabel(project),
    reason,
    state: 'failed',
  };
}

export function codeGraphWorksetPrepareFailureDetail(
  error: unknown,
  stage: 'index' | 'projection',
): CodeGraphWorksetPrepareFailureDetailV1 {
  if (isCodeGraphStoreError(error)) {
    return {
      code: error.code,
      errorType: safePrepareErrorType(error),
      recovery: error.recovery,
      retryable: error.retryable,
      summary: worksetStoreRecoverySummary(error.recovery),
    };
  }
  if (Schema.is(CodeGraphRepositoryError)(error)) {
    return {
      code: 'repository',
      errorType: error.name,
      retryable: false,
      summary: 'The configured project path is not a readable Git repository.',
    };
  }
  if (
    Schema.is(WorktreeChangedDuringIndex)(error) ||
    Schema.is(RepositoryMaintenanceInterrupted)(error) ||
    Schema.is(RepositoryRegistrationLost)(error)
  ) {
    return {
      code: 'worktree-changed',
      errorType: error.name,
      retryable: true,
      summary: Schema.is(RepositoryMaintenanceInterrupted)(error)
        ? 'Graph maintenance superseded indexing; retry after maintenance completes.'
        : 'The repository changed while indexing; retry when the checkout is stable.',
    };
  }
  if (Schema.is(CodeGraphWorksetCatalogError)(error)) {
    return {
      code: 'catalog',
      errorType: error.name,
      retryable: error.reason === 'busy',
      summary:
        error.reason === 'capacity'
          ? 'The routing projection exceeded a bounded catalog capacity; inspect catalog storage diagnostics.'
          : 'The routing catalog could not stage this member; inspect catalog diagnostics and retry.',
    };
  }
  return {
    code: 'unknown',
    errorType: safePrepareErrorType(error),
    retryable: false,
    summary:
      stage === 'index'
        ? 'Repository indexing failed; run graph diagnostics for this project and retry.'
        : 'Routing projection failed; run graph diagnostics for this project and retry.',
  };
}

function safePrepareErrorType(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(name) ? name : 'UnknownError';
}

function worksetStoreRecoverySummary(recovery: CodeGraphStoreRecovery): string {
  const summaries: Readonly<Record<CodeGraphStoreRecovery, string>> = {
    defer: 'Graph storage is busy; wait for the active operation and retry.',
    diagnose: 'Graph storage failed; run graph diagnostics for this project.',
    'fix-permissions': 'Graph storage is not writable; fix its permissions and retry.',
    'free-space': 'Graph storage is out of safe disk capacity; free space and retry.',
    'manual-migration': 'Graph storage needs a compatible Threadnote runtime or manual migration.',
    'manual-rebuild': 'Graph storage is corrupt; diagnose and rebuild this project graph.',
    'migrate-additive': 'Graph storage needs its additive schema migration before retrying.',
    'reconnect-runtime': 'Reconnect this Threadnote runtime after the graph schema upgrade.',
    'retry-read-only': 'Graph storage hit transient I/O; retry after the filesystem settles.',
  };
  return summaries[recovery];
}

export function codeGraphWorksetPrepareCoverage(
  members: readonly CodeGraphWorksetPrepareMemberV1[],
): CodeGraphWorksetPrepareCoverageV1 {
  const coverage = {excluded: 0, failed: 0, missing: 0, ready: 0};
  for (const member of members) coverage[member.state] += 1;
  return {
    ...coverage,
    complete: coverage.ready === members.length,
    requested: members.length,
  };
}

function prepareResult(
  workset: string,
  manifestDigest: string,
  members: readonly PreparedMemberWithProjection[],
  published: CodeGraphWorksetCatalogGenerationReceiptV1 | undefined,
  bridges?: CodeGraphWorksetPrepareBridgeReceiptV1,
): CodeGraphWorksetPrepareResultV1 {
  const publicMembers = EffectArray.map(members, publicPrepareMember);
  return {
    ...(bridges === undefined ? {} : {bridges}),
    coverage: codeGraphWorksetPrepareCoverage(publicMembers),
    manifestDigest,
    members: publicMembers,
    ...(published === undefined ? {} : {published}),
    state: published === undefined ? 'failed' : 'ready',
    type: 'code-graph-workset-prepare',
    version: 1,
    workset,
  };
}

function publicPrepareMember(member: PreparedMemberWithProjection): CodeGraphWorksetPrepareMemberV1 {
  if (member.state !== 'ready') return member;
  const {assertLease: _assertLease, identity: _identity, scope: _scope, ...receipt} = member;
  return receipt;
}

export const prepareCodeGraphWorksetBridgesForGeneration = Effect.fn('codeGraphWorkset.prepareBridgesForGeneration')(
  function* (config: RuntimeConfig, generationId: string, ready: readonly CodeGraphWorksetBridgePreparationMemberV1[]) {
    const loaded = yield* Effect.forEach(
      ready,
      member =>
        readCodeGraphReadySnapshotMonikers({
          identity: member.identity,
          snapshotId: member.snapshotId,
          threadnoteHome: config.agentContextHome,
        }).pipe(
          Effect.map(monikers => ({member, monikers, state: 'ready' as const})),
          Effect.orElseSucceed(() => ({member, state: 'unavailable' as const})),
        ),
      {concurrency: CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT},
    );
    const unavailableRepositories = EffectArray.map(
      EffectArray.filter(loaded, value => value.state === 'unavailable'),
      value => value.member.project,
    ).sort(compareText);
    if (unavailableRepositories.length > 0) {
      const stored = yield* replaceCodeGraphWorksetCatalogBridgeSet(config.agentContextHome, {
        bridges: [],
        coverage: {
          diagnostics: ['moniker-read-failed'],
          failedRepositoryCount: unavailableRepositories.length,
          rejectionCount: 0,
          repositoriesRead: ready.length - unavailableRepositories.length,
          state: ready.length === unavailableRepositories.length ? 'failed' : 'partial',
        },
        generationId,
      });
      return {
        bridgeCount: 0,
        digest: stored.digest,
        monikerCount: 0,
        rejectionCount: 0,
        resolverVersion: stored.resolverVersion,
        state: 'unavailable' as const,
        unavailableRepositories,
        warnings: [
          'Cross-repository bridges were withheld because one or more ready snapshots had no readable canonical moniker surface.',
        ],
      } satisfies CodeGraphWorksetPrepareBridgeReceiptV1;
    }
    const repositories = EffectArray.map(loaded, value => {
      if (value.state !== 'ready') throw new Error('Unreachable bridge preparation state.');
      return {
        monikers: value.monikers,
        repositoryId: value.member.repositoryId,
        repositoryKey: value.member.project,
        snapshotId: value.member.snapshotId,
      };
    });
    const resolution = yield* Effect.result(
      Effect.try({
        try: () => resolveCodeGraphCrossRepositoryBridges(repositories),
        catch: cause =>
          CodeGraphWorksetCatalogError.of('invalid-input', cause instanceof Error ? cause.message : String(cause), {
            cause,
          }),
      }),
    );
    if (Result.isFailure(resolution)) {
      const stored = yield* replaceCodeGraphWorksetCatalogBridgeSet(config.agentContextHome, {
        bridges: [],
        coverage: {
          diagnostics: ['resolver-failed'],
          failedRepositoryCount: ready.length,
          rejectionCount: 0,
          repositoriesRead: 0,
          state: 'failed',
        },
        generationId,
      });
      return {
        bridgeCount: 0,
        digest: stored.digest,
        monikerCount: EffectArray.reduce(repositories, 0, (total, value) => total + value.monikers.length),
        rejectionCount: 0,
        resolverVersion: stored.resolverVersion,
        state: 'unavailable' as const,
        unavailableRepositories: EffectArray.map(ready, value => value.project).sort(compareText),
        warnings: ['Cross-repository bridges were withheld because deterministic resolution failed.'],
      } satisfies CodeGraphWorksetPrepareBridgeReceiptV1;
    }
    yield* registerBridgeQualifiedRefs(config.agentContextHome, repositories);
    yield* assertBridgeMemberLeases(ready);
    const stored = yield* replaceCodeGraphWorksetCatalogBridgeSet(config.agentContextHome, {
      bridges: resolution.success.bridges,
      coverage: {
        diagnostics: resolution.success.rejections.length === 0 ? [] : ['resolver-rejections'],
        failedRepositoryCount: 0,
        rejectionCount: resolution.success.rejections.length,
        repositoriesRead: ready.length,
        state: 'complete',
      },
      generationId,
    });
    return {
      bridgeCount: stored.bridgeCount,
      digest: stored.digest,
      monikerCount: EffectArray.reduce(repositories, 0, (total, value) => total + value.monikers.length),
      rejectionCount: resolution.success.rejections.length,
      resolverVersion: stored.resolverVersion,
      state: 'ready' as const,
      unavailableRepositories: [],
      warnings:
        resolution.success.rejections.length === 0
          ? []
          : [
              `${resolution.success.rejections.length} cross-repository import${resolution.success.rejections.length === 1 ? ' was' : 's were'} rejected as ambiguous or version-incompatible.`,
            ],
    } satisfies CodeGraphWorksetPrepareBridgeReceiptV1;
  },
);

function registerBridgeQualifiedRefs(
  threadnoteHome: string,
  repositories: readonly {
    readonly monikers: readonly CodeGraphMonikerV1[];
    readonly repositoryId: string;
  }[],
) {
  const refs = new Map<string, {readonly nodeId: string; readonly repositoryId: string}>();
  for (const repository of repositories) {
    for (const moniker of repository.monikers) {
      if (moniker.scheme !== 'protobuf') continue;
      const candidate = {nodeId: moniker.symbolId, repositoryId: repository.repositoryId};
      refs.set(`${candidate.repositoryId}\0${candidate.nodeId}`, candidate);
    }
  }
  return Effect.forEach(
    [...refs.values()].sort(
      (left, right) => compareText(left.repositoryId, right.repositoryId) || compareText(left.nodeId, right.nodeId),
    ),
    ref => registerCodeGraphQualifiedRef(threadnoteHome, ref),
    {concurrency: 1, discard: true},
  );
}

function assertPreparedMemberLeases(members: readonly PreparedMemberWithProjection[]) {
  return Effect.forEach(members, member => (member.state === 'ready' ? member.assertLease : Effect.void), {
    concurrency: CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT,
    discard: true,
  });
}

function assertBridgeMemberLeases(members: readonly CodeGraphWorksetBridgePreparationMemberV1[]) {
  return Effect.forEach(members, member => member.assertLease, {
    concurrency: CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT,
    discard: true,
  });
}

function drainCodeGraphWorksetCatalogCleanup(threadnoteHome: string) {
  return Effect.gen(function* () {
    for (;;) {
      const page = yield* maintainCodeGraphWorksetCatalogPreparationPage(threadnoteHome);
      if (!page.pendingCleanup) return;
      yield* Effect.yieldNow;
    }
  });
}

function statusStateCounts(
  members: readonly CodeGraphWorksetStatusMemberV1[],
): Record<CodeGraphWorksetStatusMemberStateV1, number> {
  const counts: Record<CodeGraphWorksetStatusMemberStateV1, number> = {
    current: 0,
    deferred: 0,
    excluded: 0,
    failed: 0,
    missing: 0,
    stale: 0,
    uncatalogued: 0,
  };
  for (const member of members) counts[member.state] += 1;
  return counts;
}

function prepareConcurrency(value: number | undefined): number {
  const concurrency = value ?? CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_DEFAULT;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_MAXIMUM
  ) {
    throw new Error(
      `Workset prepare concurrency must be an integer from 1 to ${CODE_GRAPH_WORKSET_PREPARE_CONCURRENCY_MAXIMUM}.`,
    );
  }
  return concurrency;
}

function safeLabel(value: string): string {
  const normalized = Effect2.pipe(value, EffectString.replace(/[\r\n\t\0]/gu, ' '), EffectString.trim);
  return Effect2.pipe(normalized, EffectString.slice(0, 256)) || 'unknown';
}

function compareProjectDigestEntry(
  left: readonly [string, string, string, ...string[]],
  right: readonly [string, string, string, ...string[]],
): number {
  return compareText(left[0], right[0]) || compareText(left[1], right[1]) || compareText(left[2], right[2]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

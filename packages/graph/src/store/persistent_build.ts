import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';
import {Clock, DateTime, Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {saturatingCapacityAdd} from '../disk/capacity.js';
import {compareCodeUnits} from '../ordering.js';
import {
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphPersistentBuildClaim,
  type CodeGraphRetiredSnapshotCleanupProgressCallback,
  type CodeGraphStagingProgressCallback,
  type CodeGraphStagingStage,
} from './models.js';
import {configureConnection} from './session.js';
import {type CodeGraphSnapshot, type RepositoryIdentity, CodeGraphStoreError} from '../types.js';
import {type CodeGraphWorkspace} from '../languages/types.js';
import {
  type ActivationStagingObserver,
  assertPersistentBuildOwner,
  assertPersistentMaterializationComplete,
  CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
  type CodeGraphWriterGate,
  type PersistentReexportAliasRow,
  persistentSnapshotBuildIdentityMatches,
  type PreparedPersistedFullWorkspace,
  registerPersistentMaterializationPlan,
} from './build/core.js';
import {persistentSnapshotMatchesLogicalIdentity} from './maintenance_core.js';
import {initializeSchema} from './schema/initialization.js';
import {type SnapshotRow} from './internal_models.js';
import {snapshotFromRow} from './rows.js';
import {lastStatementChangeCount} from './activation/core.js';
import {pruneRetiredSnapshotRows} from './retirement.js';
import {chunk, uniqueBy, upsertRepository} from './utilities.js';
import {
  makeRetiredSnapshotReclamationPage,
  REEXPORT_CLOSURE_PAGE_MAXIMUM_ROWS,
  REEXPORT_CLOSURE_SEED_PAGE_ROWS,
  stageActivationMonikers,
  stageSnapshotMonikers,
} from './staging_core.js';
import {persistentReexportAliasCapacityBoundary, type ReexportClosureRow} from './resolution/core.js';

/** @internal Exposed for deterministic SQLite snapshot-contract tests. */

const claimPersistentSnapshotBuild = Effect.fn('codeGraph.claimPersistentSnapshotBuild')(function* (
  identity: RepositoryIdentity,
  snapshot: CodeGraphSnapshot,
  ownerToken: string,
  claim: CodeGraphPersistentBuildClaim,
  writerGate?: CodeGraphWriterGate,
) {
  const sql = yield* SqlClient.SqlClient;
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  if (
    !/^[0-9a-f-]{16,64}$/u.test(claim.owner.buildId) ||
    !Number.isSafeInteger(claim.owner.processId) ||
    claim.owner.processId <= 0 ||
    (claim.owner.processStartIdentity !== undefined &&
      (claim.owner.processStartIdentity.length === 0 || claim.owner.processStartIdentity.length > 256)) ||
    !/^cgsn_[0-9a-f]{40}$/u.test(claim.logicalSnapshotId) ||
    (/^cgsn_[0-9a-f]{40}/u.test(snapshot.id) &&
      !persistentSnapshotMatchesLogicalIdentity(snapshot.id, claim.logicalSnapshotId))
  ) {
    return yield* CodeGraphStoreError.of('Persistent build owner identity is invalid.');
  }
  yield* runWrite(initializeSchema(sql));
  const retiredUnusableReady = yield* runWrite(
    sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<SnapshotRow>`SELECT * FROM snapshots WHERE id = ${snapshot.id} LIMIT 1`;
        const current = existing[0] ? snapshotFromRow(existing[0]) : undefined;
        if (
          current === undefined ||
          current.state !== 'ready' ||
          !persistentSnapshotBuildIdentityMatches(current, snapshot)
        ) {
          return false;
        }
        const compatible = yield* sql<{readonly count: number}>`
          SELECT COUNT(*) AS count
          FROM lexical_storage_formats
          WHERE snapshot_id = ${snapshot.id}
            AND format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
        `;
        if (Number(compatible[0]?.count ?? 0) === 1) return false;
        yield* sql`
          UPDATE snapshots
          SET state = 'retired',
              completed_at = COALESCE(completed_at, ${DateTime.formatIso(yield* DateTime.now)}),
              failure_summary = COALESCE(
                failure_summary,
                'Compact lexical storage receipt changed; rebuild required.'
              )
          WHERE id = ${snapshot.id} AND state = 'ready'
            AND NOT EXISTS (
              SELECT 1 FROM lexical_storage_formats
              WHERE snapshot_id = snapshots.id
                AND format_version = ${CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION}
            )
        `;
        const retired = yield* lastStatementChangeCount(sql);
        if (retired === 1) yield* sql`DELETE FROM active_snapshots WHERE snapshot_id = ${snapshot.id}`;
        return retired === 1;
      }),
    ),
  );
  const prior = yield* sql<{readonly state: CodeGraphSnapshot['state']}>`
    SELECT state FROM snapshots WHERE id = ${snapshot.id} LIMIT 1
  `;
  if (retiredUnusableReady || prior[0]?.state === 'retired') {
    // Owner-aware failure first publishes `retired`, then reclaims rows in
    // bounded transactions. A process may die at that exact boundary. The
    // deterministic snapshot identity must remain retryable without requiring
    // doctor/repair, so finish that targeted reclamation before claiming it.
    yield* pruneRetiredSnapshotRows(runWrite, snapshot.id);
  }
  yield* runWrite(
    Effect.gen(function* () {
      // Revalidate the schema in the same checkout-writer critical section
      // that publishes this build. A cold build may defer global query indexes
      // after this claim's initial schema check but before its snapshot row is
      // visible; publishing without this second check leaves the new build able
      // to reach endpoint validation while those indexes are absent.
      yield* initializeSchema(sql);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* upsertRepository(sql, identity);
          const existing = yield* sql<SnapshotRow>`SELECT * FROM snapshots WHERE id = ${snapshot.id} LIMIT 1`;
          if (existing[0]) {
            const current = snapshotFromRow(existing[0]);
            if (
              !persistentSnapshotBuildIdentityMatches(current, snapshot) ||
              !['building', 'failed'].includes(current.state)
            ) {
              return yield* CodeGraphStoreError.of(
                'Persistent build claim does not match the existing snapshot identity.',
              );
            }
          } else {
            yield* sql`
          INSERT INTO snapshots (
            id, repository_id, worktree_id, scope_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
            dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.repositoryId}, ${snapshot.worktreeId}, ${snapshot.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY}, ${snapshot.commit},
            ${snapshot.graphContentId ?? snapshot.id}, ${snapshot.baseSnapshotId ?? null},
            ${snapshot.extractorSet}, ${snapshot.dirty ? 1 : 0},
            ${snapshot.overlayFingerprint ?? null}, 'building', 0, 0, 0, ${DateTime.formatIso(yield* DateTime.now)}
          )
        `;
          }
          yield* sql`
          INSERT INTO snapshot_build_owners (snapshot_id, owner_token, claimed_at)
          VALUES (${snapshot.id}, ${ownerToken}, ${DateTime.formatIso(yield* DateTime.now)})
          ON CONFLICT(snapshot_id) DO UPDATE SET
            owner_token = excluded.owner_token,
            claimed_at = excluded.claimed_at
        `;
          yield* sql`
          INSERT INTO snapshot_build_owner_instances (
            snapshot_id, owner_token, build_id, process_id, process_start_identity, logical_snapshot_id
          ) VALUES (
            ${snapshot.id}, ${ownerToken}, ${claim.owner.buildId}, ${claim.owner.processId},
            ${claim.owner.processStartIdentity ?? null}, ${claim.logicalSnapshotId}
          )
          ON CONFLICT(snapshot_id) DO UPDATE SET
            owner_token = excluded.owner_token,
            build_id = excluded.build_id,
            process_id = excluded.process_id,
            process_start_identity = excluded.process_start_identity,
            logical_snapshot_id = excluded.logical_snapshot_id
        `;
        }),
      );
    }),
  );
});

const retireIncompleteWorktreeSnapshots = Effect.fn('codeGraph.retireIncompleteWorktreeSnapshots')(function* (
  repositoryId: string,
  worktreeId: string,
  retainedSnapshotIds: ReadonlySet<string>,
  writerGate?: CodeGraphWriterGate,
  onProgress?: CodeGraphRetiredSnapshotCleanupProgressCallback,
  cleanupMode: 'deferred' | 'required' = 'required',
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const runWrite: CodeGraphWriterGate = writerGate ?? (effect => effect);
  const retained = [...retainedSnapshotIds];
  const result = yield* runWrite(
    sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const retire = () =>
          retained.length === 0
            ? sql<{readonly id: string}>`
                UPDATE snapshots
                SET state = 'retired', completed_at = COALESCE(completed_at, ${new Date().toISOString()})
                WHERE repository_id = ${repositoryId}
                  AND worktree_id = ${worktreeId}
                  AND scope_id = ${scopeId}
                  AND state IN ('building', 'failed')
                  AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
                  AND id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
                  AND id NOT IN (
                    SELECT base_snapshot_id
                    FROM snapshots
                    WHERE base_snapshot_id IS NOT NULL
                      AND id IN (
                        SELECT snapshot_id FROM active_snapshots
                        UNION
                        SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
                      )
                  )
                RETURNING id
              `
            : sql<{readonly id: string}>`
                UPDATE snapshots
                SET state = 'retired', completed_at = COALESCE(completed_at, ${new Date().toISOString()})
                WHERE repository_id = ${repositoryId}
                  AND worktree_id = ${worktreeId}
                  AND scope_id = ${scopeId}
                  AND state IN ('building', 'failed')
                  AND NOT (${sql.in('id', retained)})
                  AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
                  AND id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
                  AND id NOT IN (
                    SELECT base_snapshot_id
                    FROM snapshots
                    WHERE base_snapshot_id IS NOT NULL
                      AND id IN (
                        SELECT snapshot_id FROM active_snapshots
                        UNION
                        SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
                      )
                  )
                RETURNING id
              `;
        const retired = yield* retire();
        // Retention only protects resumable building/failed identities above.
        // A ready snapshot may have retired the logical or direct sibling that
        // appears in the next run's candidate set; keeping that already-retired
        // row would leak its full graph forever across mode switches.
        const reclaimable = yield* sql<{readonly id: string}>`
          SELECT id
          FROM snapshots AS candidate
          WHERE candidate.repository_id = ${repositoryId}
            AND candidate.scope_id = ${scopeId}
            AND candidate.state = 'retired'
            AND candidate.id NOT IN (SELECT snapshot_id FROM active_snapshots)
            AND candidate.id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
            AND candidate.id NOT IN (
              SELECT base_snapshot_id
              FROM snapshots
              WHERE base_snapshot_id IS NOT NULL
                AND id IN (
                  SELECT snapshot_id FROM active_snapshots
                  UNION
                  SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now}
                )
            )
          ORDER BY id
        `;
        const reclaimableIds = [...new Set(reclaimable.map(snapshot => snapshot.id))].sort(compareCodeUnits);
        for (const snapshotIds of chunk(reclaimableIds, 100)) {
          yield* sql`DELETE FROM snapshot_build_owners WHERE ${sql.in('snapshot_id', snapshotIds)}`;
        }
        return {reclaimable: reclaimableIds, retired: retired.length};
      }),
    ),
  );
  const targets = cleanupMode === 'required' ? result.reclaimable : result.reclaimable.slice(0, 100);
  if (targets.length > 0) {
    yield* onProgress?.({
      pagesCompleted: 0,
      rowsDeleted: 0,
      snapshotsCompleted: 0,
      snapshotsTotal: result.reclaimable.length,
    }) ?? Effect.void;
    let pagesCompleted = 0;
    let rowsDeleted = 0;
    let snapshotsCompleted = 0;
    for (const batch of chunk(targets, 100)) {
      const reclaimPage = makeRetiredSnapshotReclamationPage(sql, batch);
      for (;;) {
        const page = yield* runWrite(reclaimPage);
        pagesCompleted += 1;
        rowsDeleted += page.rowsDeleted;
        if (page.complete) snapshotsCompleted += batch.length;
        yield* onProgress?.({
          pagesCompleted,
          rowsDeleted,
          snapshotsCompleted,
          snapshotsTotal: result.reclaimable.length,
        }) ?? Effect.void;
        if (page.complete || cleanupMode === 'deferred') break;
        yield* Effect.yieldNow;
      }
    }
  }
  return {reclaimable: result.reclaimable.length, retired: result.retired, spoolCleanupSnapshotIds: targets};
});

const finalizePersistentMaterializationPlan = Effect.fn('codeGraph.finalizePersistentMaterializationPlan')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  expectedBatchCount: number,
) {
  if (!Number.isSafeInteger(expectedBatchCount) || expectedBatchCount < 0) {
    return yield* CodeGraphStoreError.of('Persistent materialization batch count is invalid.');
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
      const rows = yield* sql<{
        readonly analysis_count: number;
        readonly analysis_maximum: number | null;
        readonly analysis_minimum: number | null;
        readonly expected_batch_count: number | null;
        readonly materialization_count: number;
        readonly materialization_maximum: number | null;
        readonly materialization_minimum: number | null;
      }>`
        SELECT owner.expected_batch_count,
          (SELECT COUNT(*) FROM building_materialization_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_count,
          (SELECT MIN(batch_index) FROM building_materialization_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_minimum,
          (SELECT MAX(batch_index) FROM building_materialization_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS materialization_maximum,
          (SELECT COUNT(*) FROM building_analysis_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_count,
          (SELECT MIN(batch_index) FROM building_analysis_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_minimum,
          (SELECT MAX(batch_index) FROM building_analysis_batches AS receipt
           WHERE receipt.snapshot_id = owner.snapshot_id) AS analysis_maximum
        FROM snapshot_build_owners AS owner
        WHERE owner.snapshot_id = ${snapshotId} AND owner.owner_token = ${ownerToken}
        LIMIT 1
      `;
      const row = rows[0];
      const registered = row?.expected_batch_count;
      const contiguous = (count: number, minimum: number | null, maximum: number | null) =>
        expectedBatchCount === 0
          ? count === 0 && minimum === null && maximum === null
          : count === expectedBatchCount && Number(minimum) === 0 && Number(maximum) === expectedBatchCount - 1;
      if (
        row === undefined ||
        (registered !== null && Number(registered) !== expectedBatchCount) ||
        !contiguous(Number(row.materialization_count), row.materialization_minimum, row.materialization_maximum) ||
        !contiguous(Number(row.analysis_count), row.analysis_minimum, row.analysis_maximum)
      ) {
        return yield* CodeGraphStoreError.of(
          'Persistent full-build materialization has incomplete or non-contiguous receipts.',
        );
      }
      yield* registerPersistentMaterializationPlan(sql, snapshotId, ownerToken, expectedBatchCount);
      yield* assertPersistentMaterializationComplete(sql, snapshotId, ownerToken);
    }),
  );
});

const failBuildingSnapshot = Effect.fn('codeGraph.failBuildingSnapshot')(function* (
  snapshotId: string,
  summary: string,
  ownerToken?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const now = yield* Clock.currentTimeMillis;
  const targetState = ownerToken === undefined ? 'failed' : 'retired';
  const changed = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        UPDATE snapshots
        SET state = ${targetState}, failure_summary = COALESCE(failure_summary, ${summary.slice(0, 2_000)}),
          completed_at = ${DateTime.formatIso(yield* DateTime.now)}
        WHERE id = ${snapshotId}
          AND state = 'building'
          AND id NOT IN (SELECT snapshot_id FROM active_snapshots)
          AND id NOT IN (SELECT snapshot_id FROM snapshot_leases WHERE expires_at > ${now})
          AND (
            ${ownerToken ?? null} IS NULL OR EXISTS (
              SELECT 1 FROM snapshot_build_owners AS owner
              WHERE owner.snapshot_id = snapshots.id AND owner.owner_token = ${ownerToken ?? null}
            )
          )
      `;
      const changes = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
      if (Number(changes[0]?.count ?? 0) > 0 && ownerToken !== undefined) {
        yield* sql`
          DELETE FROM snapshot_build_owners
          WHERE snapshot_id = ${snapshotId} AND owner_token = ${ownerToken}
        `;
      }
      return Number(changes[0]?.count ?? 0);
    }),
  );
  return changed;
});

const releasePersistentSnapshotBuild = Effect.fn('codeGraph.releasePersistentSnapshotBuild')(function* (
  snapshotId: string,
  summary: string,
  ownerToken: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const released = yield* sql<{readonly id: string}>`
        UPDATE snapshots
        SET failure_summary = COALESCE(failure_summary, ${summary.slice(0, 2_000)})
        WHERE id = ${snapshotId}
          AND state = 'building'
          AND EXISTS (
            SELECT 1 FROM snapshot_build_owners AS owner
            WHERE owner.snapshot_id = snapshots.id AND owner.owner_token = ${ownerToken}
          )
        RETURNING id
      `;
      if (released.length === 0) return;
      yield* sql`
        DELETE FROM snapshot_build_owners
        WHERE snapshot_id = ${snapshotId} AND owner_token = ${ownerToken}
      `;
    }),
  );
});

// Stay comfortably below SQLite's cross-platform parameter ceiling while
// avoiding thousands of statement preparations on production-sized graphs.

function activationStagingObserver(
  sql: SqlClient.SqlClient,
  onProgress: CodeGraphStagingProgressCallback | undefined,
  storageDatabase: 'main' | 'temp' = 'temp',
): ActivationStagingObserver {
  const startedAt = performance.now();
  const elapsedByStage = new Map<Exclude<CodeGraphStagingStage, 'committed'>, number>();
  const rowsByStage = new Map<CodeGraphStagingStage, number>();
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let lastStorageSampleAt = Number.NEGATIVE_INFINITY;
  let lastStage: CodeGraphStagingStage | undefined;
  let lastTimingAt = startedAt;
  let lastTimingStage: Exclude<CodeGraphStagingStage, 'committed'> | undefined;
  return (stage, chunkRows, force = false) =>
    Effect.gen(function* () {
      const rowsCompleted = (rowsByStage.get(stage) ?? 0) + chunkRows;
      rowsByStage.set(stage, rowsCompleted);
      const now = performance.now();
      const timingStage = stage === 'committed' ? 'committing' : stage;
      if (lastTimingStage === timingStage) {
        elapsedByStage.set(timingStage, (elapsedByStage.get(timingStage) ?? 0) + Math.max(0, now - lastTimingAt));
      }
      lastTimingAt = now;
      lastTimingStage = timingStage;
      const shouldReport = force || stage !== lastStage || now - lastReportAt >= 500;
      if (onProgress && shouldReport) {
        let allocatedDatabaseBytes: number | undefined;
        if (stage === 'committed' || now - lastStorageSampleAt >= 1_000) {
          const pageCountRows = yield* sql.unsafe<{readonly page_count: number}>(
            `PRAGMA ${storageDatabase}.page_count`,
          );
          const pageSizeRows = yield* sql.unsafe<{readonly page_size: number}>(`PRAGMA ${storageDatabase}.page_size`);
          const pageCount = Number(pageCountRows[0]?.page_count ?? 0);
          const pageSize = Number(pageSizeRows[0]?.page_size ?? 0);
          if (Number.isSafeInteger(pageCount) && pageCount >= 0 && Number.isSafeInteger(pageSize) && pageSize > 0) {
            allocatedDatabaseBytes = pageCount * pageSize;
          }
          lastStorageSampleAt = now;
        }
        yield* onProgress({
          chunkRows,
          elapsedMilliseconds: Math.max(0, now - startedAt),
          rowsCompleted,
          stage,
          stageElapsedMilliseconds: elapsedByStage.get(timingStage) ?? 0,
          ...(allocatedDatabaseBytes === undefined
            ? {}
            : storageDatabase === 'main'
              ? {durableDatabaseBytes: allocatedDatabaseBytes}
              : {temporaryDatabaseBytes: allocatedDatabaseBytes}),
        });
        lastReportAt = now;
        lastStage = stage;
      }
      // Bun's SQLite calls are synchronous. Explicitly yield between bounded
      // statements so the independent build heartbeat can run even when the
      // current materialization batch is expensive.
      yield* Effect.yieldNow;
    });
}

function stageActivationWorkspace(workspace: CodeGraphWorkspace) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const scope of workspace.workspaces) {
      yield* sql`
        INSERT OR REPLACE INTO activation_workspace_scopes (
          id, build_system, name, root, provenance, diagnostics_json
        ) VALUES (
          ${scope.id}, ${scope.buildSystem}, ${scope.name}, ${scope.root},
          ${scope.provenance}, ${JSON.stringify(scope.diagnostics)}
        )
      `;
    }
    for (const component of workspace.projects) {
      yield* sql`
        INSERT OR REPLACE INTO activation_workspace_components (
          id, workspace_id, build_system, kind, name, root, resolution_domain,
          languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
        ) VALUES (
          ${component.id}, ${component.workspaceId}, ${component.buildSystem}, ${component.kind},
          ${component.name}, ${component.root}, ${component.resolutionDomain},
          ${JSON.stringify(component.languages)}, ${JSON.stringify(component.sourceRoots)},
          ${JSON.stringify(component.workspaceRoots)}, ${component.provenance},
          ${JSON.stringify(component.diagnostics)}
        )
      `;
      for (const dependency of component.dependencyDetails) {
        yield* sql`
          INSERT OR REPLACE INTO activation_workspace_dependencies (
            source_component_id, target_component_id, provenance, evidence
          ) VALUES (
            ${component.id}, ${dependency.targetId}, ${dependency.provenance}, ${dependency.evidence ?? null}
          )
        `;
      }
      for (const dependency of component.externalDependencies ?? []) {
        yield* sql`
          INSERT OR REPLACE INTO activation_workspace_external_dependencies (
            source_component_id, ecosystem, package_name, import_alias, dependency_kind,
            version_constraint, evidence_path, evidence_span_json
          ) VALUES (
            ${component.id}, ${dependency.ecosystem}, ${dependency.name}, ${dependency.importAlias}, ${dependency.kind},
            ${dependency.versionConstraint}, ${dependency.evidence.path},
            ${dependency.evidence.span === undefined ? null : JSON.stringify(dependency.evidence.span)}
          )
        `;
      }
      yield* stageActivationMonikers(sql, component.monikers ?? [], 'upsert');
    }
    yield* sql`INSERT OR REPLACE INTO activation_state (key, value) VALUES ('workspace_catalog_staged', '1')`;
  });
}

const stagePersistedFullWorkspace = Effect.fn('codeGraph.stagePersistedFullWorkspace')(function* (
  sql: SqlClient.SqlClient,
  snapshotId: string,
  ownerToken: string,
  workspace: PreparedPersistedFullWorkspace,
) {
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* assertPersistentBuildOwner(sql, snapshotId, ownerToken);
      for (const entry of workspace.workspaces) {
        const {scope} = entry;
        yield* sql`
          INSERT OR REPLACE INTO workspace_scopes (
            snapshot_id, id, build_system, name, root, provenance, diagnostics_json
          ) VALUES (
            ${snapshotId}, ${scope.id}, ${scope.buildSystem}, ${scope.name}, ${scope.root},
            ${scope.provenance}, ${entry.diagnosticsJson}
          )
        `;
      }
      for (const entry of workspace.projects) {
        const {project: component} = entry;
        yield* sql`
          INSERT OR REPLACE INTO workspace_components (
            snapshot_id, id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          ) VALUES (
            ${snapshotId}, ${component.id}, ${component.workspaceId}, ${component.buildSystem},
            ${component.kind}, ${component.name}, ${component.root}, ${component.resolutionDomain},
            ${entry.languagesJson}, ${entry.sourceRootsJson},
            ${entry.workspaceRootsJson}, ${component.provenance},
            ${entry.diagnosticsJson}
          )
        `;
        for (const dependency of component.dependencyDetails) {
          yield* sql`
            INSERT OR REPLACE INTO workspace_component_dependencies (
              snapshot_id, source_component_id, target_component_id, provenance, evidence
            ) VALUES (
              ${snapshotId}, ${component.id}, ${dependency.targetId},
              ${dependency.provenance}, ${dependency.evidence ?? null}
            )
          `;
        }
        for (const dependency of component.externalDependencies ?? []) {
          yield* sql`
            INSERT OR REPLACE INTO workspace_external_dependencies (
              snapshot_id, source_component_id, ecosystem, package_name, import_alias, dependency_kind,
              version_constraint, evidence_path, evidence_span_json
            ) VALUES (
              ${snapshotId}, ${component.id}, ${dependency.ecosystem}, ${dependency.name},
              ${dependency.importAlias}, ${dependency.kind},
              ${dependency.versionConstraint}, ${dependency.evidence.path},
              ${dependency.evidence.span === undefined ? null : JSON.stringify(dependency.evidence.span)}
            )
          `;
        }
        yield* stageSnapshotMonikers(sql, snapshotId, component.monikers ?? [], 'upsert');
      }
    }),
  );
});

/**
 * Resolves TypeScript barrel topology once from durable provenance, then seeds
 * exact scoped aliases before the general reference scan. Deep chains therefore
 * do not require one repository-wide unresolved pass per barrel. Seed pages,
 * a bounded closure result, and the ordinary writer fence keep this optional
 * acceleration from becoming a repository-size rejection or an unbounded write.
 * Pages whose branching closure exceeds the budget safely fall back to the
 * existing reference resolver.
 */
const expandTransitiveReexportAliases = Effect.fn('codeGraph.expandTransitiveReexportAliases')(function* (
  sql: SqlClient.SqlClient,
  mode:
    | {readonly baseSnapshotId: string; readonly mode: 'persisted-delta'}
    | {readonly mode: 'persisted-full'; readonly ownerToken: string; readonly snapshotId: string}
    | undefined,
  writerGate?: CodeGraphWriterGate,
  persistentCapacityProtector?: CodeGraphDirectPersistentCapacityProtector,
  onProgress?: (aliasesDiscovered: number) => Effect.Effect<void, never>,
) {
  if (mode?.mode === 'persisted-delta') return 0;
  const persistent = mode?.mode === 'persisted-full';
  const snapshotId = persistent ? mode.snapshotId : undefined;
  const provenanceTable = persistent ? 'snapshot_reexport_provenance' : 'activation_reexport_provenance';
  yield* sql.unsafe(`
    CREATE TEMP TABLE IF NOT EXISTS activation_reexport_closure_page (
      source_path TEXT NOT NULL,
      local_name TEXT NOT NULL,
      target_path TEXT NOT NULL,
      imported_name TEXT NOT NULL,
      source_key_component TEXT NOT NULL,
      target_key_component TEXT NOT NULL,
      PRIMARY KEY (source_path, local_name, target_path, imported_name)
    ) WITHOUT ROWID
  `);
  let aliases = 0;
  let cursorPath = '';
  let cursorName = '';
  for (;;) {
    const seeds = yield* sql.unsafe<{readonly local_name: string; readonly source_path: string}>(
      `SELECT DISTINCT source_path, local_name
       FROM ${provenanceTable}
       WHERE ${persistent ? 'snapshot_id = ? AND ' : ''}
         (source_path > ? OR (source_path = ? AND local_name > ?))
       ORDER BY source_path, local_name
       LIMIT ${REEXPORT_CLOSURE_SEED_PAGE_ROWS}`,
      [...(persistent ? [snapshotId] : []), cursorPath, cursorPath, cursorName],
    );
    if (seeds.length === 0) break;
    yield* onProgress?.(aliases) ?? Effect.void;
    yield* Effect.yieldNow;
    const closure = yield* sql.unsafe<ReexportClosureRow>(
      `WITH RECURSIVE
       requested(source_path, local_name) AS (
         VALUES ${seeds.map(() => '(?, ?)').join(', ')}
       ),
       closure(source_path, local_name, target_path, imported_name) AS (
         SELECT provenance.source_path, provenance.local_name,
           provenance.target_path, provenance.imported_name
         FROM requested
         CROSS JOIN ${provenanceTable} AS provenance
           ON ${persistent ? 'provenance.snapshot_id = ? AND ' : ''}
              requested.source_path = provenance.source_path
          AND requested.local_name = provenance.local_name
         UNION
         SELECT closure.source_path, closure.local_name,
           provenance.target_path, provenance.imported_name
         FROM closure
         CROSS JOIN ${provenanceTable} AS provenance
           ON ${persistent ? 'provenance.snapshot_id = ? AND ' : ''}
              closure.target_path = provenance.source_path
          AND closure.imported_name = provenance.local_name
       )
       SELECT closure.source_path, closure.local_name,
         closure.target_path, closure.imported_name
       FROM closure
       WHERE NOT EXISTS (
         SELECT 1 FROM ${provenanceTable} AS next
         WHERE ${persistent ? 'next.snapshot_id = ? AND ' : ''}
           next.source_path = closure.target_path
           AND next.local_name = closure.imported_name
       )
       ORDER BY closure.source_path, closure.local_name, closure.target_path, closure.imported_name
       LIMIT ${REEXPORT_CLOSURE_PAGE_MAXIMUM_ROWS + 1}`,
      [
        ...seeds.flatMap(seed => [seed.source_path, seed.local_name]),
        ...(persistent ? [snapshotId, snapshotId, snapshotId] : []),
      ],
    );
    cursorPath = seeds.at(-1)!.source_path;
    cursorName = seeds.at(-1)!.local_name;
    if (closure.length > REEXPORT_CLOSURE_PAGE_MAXIMUM_ROWS) {
      yield* onProgress?.(aliases) ?? Effect.void;
      yield* Effect.yieldNow;
      continue;
    }
    const encoded = uniqueBy(
      closure.map(row => ({
        ...row,
        sourceKeyComponent: `path:${encodeURIComponent(row.source_path)}:name:${encodeURIComponent(row.local_name)}`,
        targetKeyComponent: `path:${encodeURIComponent(row.target_path)}:name:${encodeURIComponent(row.imported_name)}`,
      })),
      row => `${row.source_path}\0${row.local_name}\0${row.target_path}\0${row.imported_name}`,
    );
    if (encoded.length === 0) {
      yield* onProgress?.(aliases) ?? Effect.void;
      yield* Effect.yieldNow;
      continue;
    }
    yield* sql.unsafe('DELETE FROM activation_reexport_closure_page');
    for (const batch of chunk(encoded, 400)) {
      yield* sql.unsafe(
        `INSERT INTO activation_reexport_closure_page (
           source_path, local_name, target_path, imported_name,
           source_key_component, target_key_component
         ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flatMap(row => [
          row.source_path,
          row.local_name,
          row.target_path,
          row.imported_name,
          row.sourceKeyComponent,
          row.targetKeyComponent,
        ]),
      );
    }
    const symbolTable = persistent ? 'symbols' : 'activation_symbols';
    const lookupTable = persistent ? 'snapshot_symbol_lookup' : 'activation_symbol_lookup';
    const symbolSnapshotPredicate = persistent ? 'symbol.snapshot_id = ? AND' : '';
    const targetSnapshotPredicate = persistent ? 'target.snapshot_id = ? AND' : '';
    const symbolPathIndex = persistent ? 'INDEXED BY symbols_path' : '';
    const lookupSnapshotPredicate = persistent ? 'lookup.snapshot_id = candidate.snapshot_id AND' : '';
    // Freeze the exact rows before capacity admission. The guarded transaction
    // inserts only this immutable page, so no writer that arrives between the
    // preflight read and receipt acquisition can expand its physical demand.
    const aliasRows = yield* sql.unsafe<PersistentReexportAliasRow>(
      `
          WITH
          source_scopes AS (
            SELECT closure.source_path, closure.local_name,
              MIN(symbol.resolution_scope_id) AS resolution_scope_id
            FROM activation_reexport_closure_page AS closure
            CROSS JOIN ${symbolTable} AS symbol ${symbolPathIndex}
              ON ${symbolSnapshotPredicate} symbol.path = closure.source_path
             AND symbol.resolution_domain = 'typescript'
            GROUP BY closure.source_path, closure.local_name
            HAVING COUNT(DISTINCT COALESCE(symbol.resolution_scope_id, '')) = 1
          ),
          candidate_targets AS MATERIALIZED (
            SELECT closure.source_path, closure.local_name,
              target.id AS symbol_id, target.exported,
              ${persistent ? 'target.snapshot_id' : "''"} AS snapshot_id,
              'typescript:' ||
                CASE WHEN target.resolution_scope_id IS NULL THEN '' ELSE target.resolution_scope_id || ':' END ||
                closure.target_key_component || ':implementation' AS implementation_key,
              'typescript:' ||
                CASE WHEN target.resolution_scope_id IS NULL THEN '' ELSE target.resolution_scope_id || ':' END ||
                closure.target_key_component || ':merge-canonical' AS merge_key,
              'typescript:' ||
                CASE WHEN target.resolution_scope_id IS NULL THEN '' ELSE target.resolution_scope_id || ':' END ||
                closure.target_key_component AS base_key
            FROM activation_reexport_closure_page AS closure
            CROSS JOIN ${symbolTable} AS target ${symbolPathIndex}
              ON ${targetSnapshotPredicate} target.path = closure.target_path
             AND target.name = closure.imported_name
             AND target.resolution_domain = 'typescript'
             AND target.exported = 1
          ),
          candidate_matches AS (
            SELECT candidate.source_path, candidate.local_name,
              candidate.symbol_id, candidate.exported,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM ${lookupTable} AS lookup
                  WHERE ${lookupSnapshotPredicate}
                    lookup.lookup_key = candidate.implementation_key
                    AND lookup.symbol_id = candidate.symbol_id
                    AND lookup.provenance = 'symbol'
                ) THEN 0
                WHEN EXISTS (
                  SELECT 1 FROM ${lookupTable} AS lookup
                  WHERE ${lookupSnapshotPredicate}
                    lookup.lookup_key = candidate.merge_key
                    AND lookup.symbol_id = candidate.symbol_id
                    AND lookup.provenance = 'symbol'
                ) THEN 1
                ELSE 2
              END AS priority
            FROM candidate_targets AS candidate
            WHERE EXISTS (
              SELECT 1 FROM ${lookupTable} AS lookup
              WHERE ${lookupSnapshotPredicate}
                lookup.lookup_key IN (candidate.implementation_key, candidate.merge_key, candidate.base_key)
                AND lookup.symbol_id = candidate.symbol_id
                AND lookup.provenance = 'symbol'
            )
          ),
          first_priorities AS (
            SELECT source_path, local_name, MIN(priority) AS priority
            FROM candidate_matches
            GROUP BY source_path, local_name
          ),
          unique_targets AS (
            SELECT candidate.source_path, candidate.local_name,
              MIN(candidate.symbol_id) AS symbol_id, MIN(candidate.exported) AS exported
            FROM candidate_matches AS candidate
            JOIN first_priorities AS first
              ON first.source_path = candidate.source_path
             AND first.local_name = candidate.local_name
             AND first.priority = candidate.priority
            GROUP BY candidate.source_path, candidate.local_name
            HAVING COUNT(DISTINCT candidate.symbol_id) = 1
          ),
          alias_rows(lookup_key, symbol_id, exported, evidence_path) AS (
            SELECT 'typescript:' ||
                CASE WHEN source.resolution_scope_id IS NULL THEN '' ELSE source.resolution_scope_id || ':' END ||
                closure.source_key_component || ':implementation',
              target.symbol_id, target.exported, closure.source_path
            FROM activation_reexport_closure_page AS closure
            JOIN source_scopes AS source
              ON source.source_path = closure.source_path AND source.local_name = closure.local_name
            JOIN unique_targets AS target
              ON target.source_path = closure.source_path AND target.local_name = closure.local_name
            UNION
            SELECT 'typescript:' ||
                CASE WHEN source.resolution_scope_id IS NULL THEN '' ELSE source.resolution_scope_id || ':' END ||
                closure.source_key_component,
              target.symbol_id, target.exported, closure.source_path
            FROM activation_reexport_closure_page AS closure
            JOIN source_scopes AS source
              ON source.source_path = closure.source_path AND source.local_name = closure.local_name
            JOIN unique_targets AS target
              ON target.source_path = closure.source_path AND target.local_name = closure.local_name
          )
          SELECT lookup_key, symbol_id, exported, evidence_path
          FROM alias_rows
          ORDER BY lookup_key, symbol_id
        `,
      persistent ? [mode.snapshotId, mode.snapshotId] : [],
    );
    if (aliasRows.length === 0) {
      yield* onProgress?.(aliases) ?? Effect.void;
      yield* Effect.yieldNow;
      continue;
    }
    const transaction = sql.withTransaction(
      Effect.gen(function* () {
        if (persistent) yield* assertPersistentBuildOwner(sql, mode.snapshotId, mode.ownerToken);
        let inserted = 0;
        for (const batch of chunk(aliasRows, 500)) {
          if (persistent) {
            yield* sql.unsafe(
              `INSERT OR IGNORE INTO snapshot_symbol_lookup (
                 snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
                 provenance, evidence_edge_id, evidence_path
               ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
              batch.flatMap(row => [
                mode.snapshotId,
                row.lookup_key,
                row.symbol_id,
                'typescript',
                row.exported,
                'alias',
                null,
                row.evidence_path,
              ]),
            );
          } else {
            yield* sql.unsafe(
              `INSERT OR IGNORE INTO activation_symbol_lookup (
                 lookup_key, symbol_id, resolution_domain, exported,
                 provenance, evidence_edge_id, evidence_path
               ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
              batch.flatMap(row => [
                row.lookup_key,
                row.symbol_id,
                'typescript',
                row.exported,
                'alias',
                null,
                row.evidence_path,
              ]),
            );
          }
          const changed = yield* sql.unsafe<{readonly count: number}>('SELECT changes() AS count');
          inserted = saturatingCapacityAdd(inserted, Number(changed[0]?.count ?? 0));
        }
        return inserted;
      }),
    );
    const gatedTransaction = persistent && writerGate ? writerGate(transaction) : transaction;
    aliases += yield* persistentCapacityProtector
      ? persistentCapacityProtector(
          persistentReexportAliasCapacityBoundary(persistent ? mode.snapshotId : 'temporary', aliasRows, !persistent),
          gatedTransaction,
        )
      : gatedTransaction;
    yield* onProgress?.(aliases) ?? Effect.void;
    yield* Effect.yieldNow;
  }
  yield* sql.unsafe('DELETE FROM activation_reexport_closure_page');
  return aliases;
});

export {
  expandTransitiveReexportAliases,
  claimPersistentSnapshotBuild,
  retireIncompleteWorktreeSnapshots,
  finalizePersistentMaterializationPlan,
  failBuildingSnapshot,
  releasePersistentSnapshotBuild,
  activationStagingObserver,
  stageActivationWorkspace,
  stagePersistedFullWorkspace,
};

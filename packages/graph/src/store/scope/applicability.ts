import {Effect, Predicate} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  canonicalCodeGraphScopeReceiptIds,
  CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
  CODE_GRAPH_SCOPE_RECEIPT_IDS_JSON_BYTES_MAXIMUM,
  encodeCodeGraphScopeReceiptIds,
  type ResolvedCodeGraphIndexScope,
} from '../../index_scope.js';
import {type CodeGraphScopeApplicabilityEvidence} from '../../scope/applicability.js';
import type {
  StoredCodeGraphScopeApplicability,
  StoredCodeGraphScopeReceipt,
} from '../../scope/applicability_store_types.js';
import {CodeGraphStoreError} from '../../types.js';
import {tableExists} from '../session.js';
import {codeGraphWorktreeReconciliationSchemaCompatible} from '../reconciliation.js';

function decodeEvidence(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function decodeCanonicalIds(value: string | null): readonly string[] | undefined {
  if (value === null || new TextEncoder().encode(value).byteLength > CODE_GRAPH_SCOPE_RECEIPT_IDS_JSON_BYTES_MAXIMUM) {
    return undefined;
  }
  try {
    return canonicalCodeGraphScopeReceiptIds(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function validEvidence(value: unknown): value is CodeGraphScopeApplicabilityEvidence {
  if (!Predicate.isObject(value)) return false;
  const fields = [
    'repositoryId',
    'worktreeId',
    'scopeKey',
    'definitionDigest',
    'closureDigest',
    'inventoryFingerprint',
    'extractorSet',
    'policyFingerprint',
    'observedCommit',
    'catalogFingerprint',
  ] as const;
  return (
    fields.every(field => typeof value[field] === 'string' && value[field].length > 0 && value[field].length <= 1024) &&
    /^[0-9a-f]{64}$/u.test(String(value.repositoryId)) &&
    /^[0-9a-f]{64}$/u.test(String(value.worktreeId)) &&
    (value.scopeKey === CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY ||
      /^code-graph-scope:[0-9a-f]{64}$/u.test(String(value.scopeKey))) &&
    (value.overlayFingerprint === undefined ||
      (typeof value.overlayFingerprint === 'string' && value.overlayFingerprint.length <= 1024))
  );
}

function canonicalEvidence(value: CodeGraphScopeApplicabilityEvidence): CodeGraphScopeApplicabilityEvidence {
  return {
    repositoryId: value.repositoryId,
    worktreeId: value.worktreeId,
    scopeKey: value.scopeKey,
    definitionDigest: value.definitionDigest,
    closureDigest: value.closureDigest,
    inventoryFingerprint: value.inventoryFingerprint,
    extractorSet: value.extractorSet,
    policyFingerprint: value.policyFingerprint,
    observedCommit: value.observedCommit,
    catalogFingerprint: value.catalogFingerprint,
    ...(value.overlayFingerprint === undefined ? {} : {overlayFingerprint: value.overlayFingerprint}),
  };
}

export const selectScopeApplicability = Effect.fn('codeGraph.selectScopeApplicability')(function* (
  worktreeId: string,
  scopeId: string = CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists(sql, 'scope_applicability'))) return undefined;
  const rows = yield* sql<{
    readonly active_snapshot_id: string;
    readonly evidence: string | null;
    readonly repository_id: string;
    readonly extractor_set: string;
  }>`
    SELECT applicability.active_snapshot_id, snapshot.repository_id, snapshot.extractor_set,
      CASE WHEN length(CAST(applicability.admission_evidence_json AS BLOB)) <= 16384
        THEN applicability.admission_evidence_json ELSE NULL END AS evidence
    FROM scope_applicability AS applicability
    JOIN active_snapshots AS active ON active.worktree_id = applicability.worktree_id
      AND active.scope_id = applicability.scope_id AND active.snapshot_id = applicability.active_snapshot_id
    JOIN snapshots AS snapshot ON snapshot.id = active.snapshot_id AND snapshot.state = 'ready'
      AND snapshot.scope_id = active.scope_id AND snapshot.extractor_set = applicability.extractor_set
    WHERE applicability.worktree_id = ${worktreeId} AND applicability.scope_id = ${scopeId}
      AND NOT EXISTS (SELECT 1 FROM removed_views AS removed
        WHERE removed.worktree_id = active.worktree_id AND removed.scope_id = active.scope_id
          AND removed.expected_snapshot_id = active.snapshot_id)
    LIMIT 1`;
  const row = rows[0];
  if (row?.evidence == null) return undefined;
  const evidence = decodeEvidence(row.evidence);
  if (
    !validEvidence(evidence) ||
    evidence.worktreeId !== worktreeId ||
    evidence.scopeKey !== scopeId ||
    evidence.repositoryId !== row.repository_id ||
    evidence.extractorSet !== row.extractor_set
  )
    return undefined;
  return {
    ...canonicalEvidence(evidence),
    snapshotId: row.active_snapshot_id,
  } satisfies StoredCodeGraphScopeApplicability;
});

export const selectSnapshotScopeReceipt = Effect.fn('codeGraph.selectSnapshotScopeReceipt')(function* (
  snapshotId: string,
  scopeId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* tableExists(sql, 'snapshot_scope_receipts'))) return undefined;
  const rows = yield* sql<{
    readonly closure_digest: string | null;
    readonly completeness: string;
    readonly definition_digest: string | null;
    readonly included_component_ids_json: string | null;
    readonly included_root_ids_json: string | null;
    readonly scope_id: string;
  }>`
    SELECT scope_id, definition_digest, closure_digest, completeness,
      CASE WHEN length(CAST(included_root_ids_json AS BLOB)) <= 4194304
        THEN included_root_ids_json ELSE NULL END AS included_root_ids_json,
      CASE WHEN length(CAST(included_component_ids_json AS BLOB)) <= 4194304
        THEN included_component_ids_json ELSE NULL END AS included_component_ids_json
    FROM snapshot_scope_receipts
    WHERE snapshot_id = ${snapshotId} AND scope_id = ${scopeId}
    LIMIT 1`;
  const row = rows[0];
  const definitionDigest = row?.definition_digest;
  const closureDigest = row?.closure_digest;
  const rootProjectIds = decodeCanonicalIds(row?.included_root_ids_json ?? null);
  const includedProjectIds = decodeCanonicalIds(row?.included_component_ids_json ?? null);
  if (
    row === undefined ||
    row.scope_id !== scopeId ||
    !/^code-graph-scope:[0-9a-f]{64}$/u.test(row.scope_id) ||
    typeof definitionDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(definitionDigest) ||
    typeof closureDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(closureDigest) ||
    (row.completeness !== 'complete' && row.completeness !== 'partial') ||
    rootProjectIds === undefined ||
    includedProjectIds === undefined
  ) {
    return undefined;
  }
  return {
    closureDigest,
    completeness: row.completeness,
    definitionDigest,
    includedProjectIds,
    rootProjectIds,
    scopeKey: row.scope_id,
    snapshotId,
  } satisfies StoredCodeGraphScopeReceipt;
});

export const recordScopeApplicability = Effect.fn('codeGraph.recordScopeApplicability')(function* (
  snapshotId: string,
  evidence: CodeGraphScopeApplicabilityEvidence,
  scope?: ResolvedCodeGraphIndexScope,
) {
  const rootProjectIdsJson = scope === undefined ? undefined : encodeCodeGraphScopeReceiptIds(scope.rootProjectIds);
  const includedProjectIdsJson =
    scope === undefined ? undefined : encodeCodeGraphScopeReceiptIds(scope.includedProjectIds);
  if (
    !validEvidence(evidence) ||
    (scope !== undefined &&
      (scope.scopeKey !== evidence.scopeKey ||
        scope.definitionDigest !== evidence.definitionDigest ||
        scope.closureDigest !== evidence.closureDigest ||
        rootProjectIdsJson === undefined ||
        includedProjectIdsJson === undefined))
  ) {
    return yield* CodeGraphStoreError.of('Code graph scope applicability evidence is invalid.');
  }
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* codeGraphWorktreeReconciliationSchemaCompatible(sql))) {
        return yield* CodeGraphStoreError.of('Code graph scope applicability authority schema is unavailable.');
      }
      const active = yield* sql`SELECT 1 FROM active_snapshots AS active
      JOIN snapshots AS snapshot ON snapshot.id = active.snapshot_id
      WHERE active.worktree_id = ${evidence.worktreeId} AND active.scope_id = ${evidence.scopeKey}
        AND active.snapshot_id = ${snapshotId} AND snapshot.scope_id = ${evidence.scopeKey}
        AND snapshot.repository_id = ${evidence.repositoryId} AND snapshot.extractor_set = ${evidence.extractorSet}
        AND snapshot.state = 'ready'
        AND NOT EXISTS (SELECT 1 FROM removed_views AS removed
          WHERE removed.worktree_id = active.worktree_id AND removed.scope_id = active.scope_id
            AND removed.expected_snapshot_id = active.snapshot_id)
      LIMIT 1`;
      if (active.length !== 1) return yield* CodeGraphStoreError.of('Code graph scope applicability pointer changed.');
      yield* sql`INSERT INTO scope_applicability (worktree_id, scope_id, observed_commit, overlay_fingerprint,
      active_snapshot_id, definition_digest, closure_digest, inventory_fingerprint, extractor_set, admission_evidence_json)
      VALUES (${evidence.worktreeId}, ${evidence.scopeKey}, ${evidence.observedCommit}, ${evidence.overlayFingerprint ?? null},
        ${snapshotId}, ${evidence.definitionDigest}, ${evidence.closureDigest}, ${evidence.inventoryFingerprint},
        ${evidence.extractorSet}, ${JSON.stringify(canonicalEvidence(evidence))})
      ON CONFLICT(worktree_id, scope_id) DO UPDATE SET observed_commit = excluded.observed_commit,
        overlay_fingerprint = excluded.overlay_fingerprint, active_snapshot_id = excluded.active_snapshot_id,
        definition_digest = excluded.definition_digest, closure_digest = excluded.closure_digest,
        inventory_fingerprint = excluded.inventory_fingerprint, extractor_set = excluded.extractor_set,
        admission_evidence_json = excluded.admission_evidence_json`;
      if (scope === undefined) return;
      const receipt = yield* sql<{readonly definition_digest: string | null; readonly closure_digest: string | null}>`
      SELECT definition_digest, closure_digest FROM snapshot_scope_receipts WHERE snapshot_id = ${snapshotId}`;
      if (
        receipt[0]?.definition_digest != null &&
        (receipt[0].definition_digest !== scope.definitionDigest || receipt[0].closure_digest !== scope.closureDigest)
      ) {
        return yield* CodeGraphStoreError.of('Code graph immutable snapshot scope receipt changed.');
      }
      yield* sql`INSERT INTO snapshot_scope_receipts (snapshot_id, scope_id, definition_digest, closure_digest,
      included_root_ids_json, included_component_ids_json, completeness, diagnostics_json)
      VALUES (${snapshotId}, ${scope.scopeKey}, ${scope.definitionDigest}, ${scope.closureDigest},
        ${rootProjectIdsJson}, ${includedProjectIdsJson},
        ${scope.completeness}, ${JSON.stringify(scope.diagnostics.slice(0, 32).map(diagnostic => diagnostic.slice(0, 512)))})
      ON CONFLICT(snapshot_id) DO UPDATE SET definition_digest = excluded.definition_digest,
        closure_digest = excluded.closure_digest, included_root_ids_json = excluded.included_root_ids_json,
        included_component_ids_json = excluded.included_component_ids_json, completeness = excluded.completeness,
        diagnostics_json = excluded.diagnostics_json`;
    }),
  );
});

import type {Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CODE_GRAPH_SCHEMA_VERSION} from './types.js';
import {codeGraphScopeViewKey} from './scope/identity.js';

export interface CodeGraphLayout {
  readonly scopeId?: string;
  readonly checkoutId: string;
  readonly databaseWriteLockPath: string;
  readonly databasePath: string;
  readonly lockPath: string;
  readonly repositoryRoot: string;
  readonly staleMarkerPath: string;
  readonly vectorRoot: string;
  readonly worktreeLockRoot: string;
  readonly worktreeId: string;
}

export function codeGraphMaintenanceLockPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'maintenance.lock');
}

export function codeGraphMaintenanceIntentPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'maintenance.intent');
}

export function codeGraphMaintenanceStatusPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'maintenance-status-v1.json');
}

/** One local host owns the bounded automatic-compaction inventory at a time. */
export function codeGraphAutomaticCompactionSchedulerLockPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'automatic-compaction-scheduler.lock');
}

/** Home-global receipts coordinate capacity before any checkout writer is acquired. */
export function codeGraphDiskReservationRoot(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'disk-capacity-reservations');
}

/** The ledger lock is a sibling so scanning the receipt directory has a closed grammar. */
export function codeGraphDiskReservationLockPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'disk-capacity-reservations.lock');
}

export function codeGraphBuilderAdmissionRoot(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'builder-admission');
}

export function codeGraphBuilderAdmissionLockPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'builder-admission.lock');
}

export function codeGraphBuilderAdmissionSlotPath(path: Path.Path, threadnoteHome: string, slot: 0 | 1): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'builder-slots', `${slot}.lock`);
}

export function codeGraphPreparedSpoolBudgetRoot(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'prepared-spool-budget');
}

export function codeGraphPreparedSpoolBudgetLockPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'prepared-spool-budget.lock');
}

export function codeGraphRetainedBaseReservationRoot(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'retained-base-reservations');
}

export function codeGraphRetainedBaseReservationLockPath(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'retained-base-reservations.lock');
}

export function codeGraphRepositoriesRoot(path: Path.Path, threadnoteHome: string): string {
  return path.join(threadnoteHome, 'indexes', 'code-graph', 'repositories');
}

export function codeGraphRepositoryRoot(path: Path.Path, threadnoteHome: string, checkoutId: string): string {
  assertCheckoutId(checkoutId);
  return path.join(codeGraphRepositoriesRoot(path, threadnoteHome), checkoutId);
}

export function codeGraphRepositoryLockPath(path: Path.Path, threadnoteHome: string, checkoutId: string): string {
  assertCheckoutId(checkoutId);
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', `${checkoutId}.lock`);
}

export function codeGraphDatabaseWriteLockPath(path: Path.Path, threadnoteHome: string, checkoutId: string): string {
  assertCheckoutId(checkoutId);
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'database-writes', `${checkoutId}.lock`);
}

export function codeGraphSnapshotBuildLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  logicalSnapshotId: string,
): string {
  assertCheckoutId(checkoutId);
  if (!/^cgsn_[0-9a-f]{40}$/.test(logicalSnapshotId)) {
    throw new Error('Code graph logical snapshot identity is invalid.');
  }
  return path.join(
    threadnoteHome,
    'locks',
    'indexes',
    'code-graph',
    'snapshot-builds',
    checkoutId,
    `${logicalSnapshotId}.lock`,
  );
}

export function codeGraphRequestBuildLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  requestKey: string,
): string {
  assertCheckoutId(checkoutId);
  if (!/^[0-9a-f]{64}$/.test(requestKey)) throw new Error('Code graph build request identity is invalid.');
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'requests', checkoutId, `${requestKey}.lock`);
}

export function codeGraphWorktreeLockRoot(path: Path.Path, threadnoteHome: string, checkoutId: string): string {
  assertCheckoutId(checkoutId);
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'worktrees', checkoutId);
}

export function codeGraphVectorWriteLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  modelKey: string,
): string {
  assertCheckoutId(checkoutId);
  if (!/^[0-9a-f]{64}$/.test(modelKey)) throw new Error('Code graph vector model identity is invalid.');
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'vector-writes', checkoutId, `${modelKey}.lock`);
}

/** Durable ordinary-retirement cursor serialization outside the replaceable vector root. */
export function codeGraphVectorRetirementCursorLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
): string {
  assertCheckoutId(checkoutId);
  return path.join(threadnoteHome, 'locks', 'indexes', 'code-graph', 'vector-retirement-cursors', `${checkoutId}.lock`);
}

export function codeGraphLocalProvenanceLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
): string {
  assertCheckoutId(checkoutId);
  assertWorktreeId(worktreeId);
  return path.join(
    threadnoteHome,
    'locks',
    'indexes',
    'code-graph',
    'local-provenance',
    checkoutId,
    `${worktreeId}.lock`,
  );
}

export function codeGraphWorktreeLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  scopeId?: string,
): string {
  assertCheckoutId(checkoutId);
  assertWorktreeId(worktreeId);
  return path.join(
    codeGraphWorktreeLockRoot(path, threadnoteHome, checkoutId),
    `${codeGraphScopeViewKey(worktreeId, scopeId)}.lock`,
  );
}

/**
 * Serializes the observe-then-spawn window across MCP hosts. This must remain
 * distinct from the repository lock acquired by the spawned indexer.
 */
export function codeGraphWorktreeSpawnLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  scopeId?: string,
): string {
  assertCheckoutId(checkoutId);
  assertWorktreeId(worktreeId);
  return path.join(
    threadnoteHome,
    'locks',
    'indexes',
    'code-graph',
    'worktree-spawns',
    checkoutId,
    `${codeGraphScopeViewKey(worktreeId, scopeId)}.lock`,
  );
}

/** Bounded, reconstructible per-worktree scheduling intent; never publication state. */
export function codeGraphRefreshDemandPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  scopeId?: string,
): string {
  assertCheckoutId(checkoutId);
  assertWorktreeId(worktreeId);
  if (scopeId !== undefined) {
    return path.join(
      threadnoteHome,
      'refresh-demands',
      checkoutId,
      `${sha256HexSync(codeGraphScopeViewKey(worktreeId, scopeId))}.json`,
    );
  }
  return path.join(
    threadnoteHome,
    `.code-graph-refresh-demand-v1-${checkoutId}-${codeGraphScopeViewKey(worktreeId, scopeId)}.json`,
  );
}

export function codeGraphRefreshDemandLockPath(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  scopeId?: string,
): string {
  assertCheckoutId(checkoutId);
  assertWorktreeId(worktreeId);
  if (scopeId !== undefined) {
    return path.join(
      threadnoteHome,
      'refresh-demands',
      checkoutId,
      `${sha256HexSync(codeGraphScopeViewKey(worktreeId, scopeId))}.lock`,
    );
  }
  return path.join(
    threadnoteHome,
    `.code-graph-refresh-demand-v1-${checkoutId}-${codeGraphScopeViewKey(worktreeId, scopeId)}.lock`,
  );
}

export function codeGraphLayout(
  path: Path.Path,
  threadnoteHome: string,
  checkoutId: string,
  worktreeId: string,
  scopeId?: string,
): CodeGraphLayout {
  const repositoryRoot = codeGraphRepositoryRoot(path, threadnoteHome, checkoutId);
  const worktreeLockRoot = codeGraphWorktreeLockRoot(path, threadnoteHome, checkoutId);
  return {
    ...(scopeId === undefined ? {} : {scopeId}),
    checkoutId,
    databaseWriteLockPath: codeGraphDatabaseWriteLockPath(path, threadnoteHome, checkoutId),
    databasePath: path.join(repositoryRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`),
    lockPath: codeGraphWorktreeLockPath(path, threadnoteHome, checkoutId, worktreeId, scopeId),
    repositoryRoot,
    staleMarkerPath: path.join(repositoryRoot, 'stale', `${codeGraphScopeViewKey(worktreeId, scopeId)}.stale`),
    vectorRoot: path.join(repositoryRoot, 'vectors'),
    worktreeLockRoot,
    worktreeId,
  };
}

function assertCheckoutId(checkoutId: string): void {
  if (!/^[0-9a-f]{64}$/.test(checkoutId)) throw new Error('Code graph checkout identity is invalid.');
}

function assertWorktreeId(worktreeId: string): void {
  if (!/^[0-9a-f]{64}$/.test(worktreeId)) throw new Error('Code graph worktree identity is invalid.');
}

/** One detached embedding worker per canonical home. */
export function codeGraphEmbeddingWorkerLockPath(path: Path.Path, home: string): string {
  return path.join(home, 'locks', 'indexes', 'code-graph', 'embedding-worker.lock');
}
export function codeGraphEmbeddingWorkerReceiptPath(path: Path.Path, home: string): string {
  return path.join(home, 'locks', 'indexes', 'code-graph', 'embedding-worker-v1.json');
}

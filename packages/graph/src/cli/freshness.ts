import type {CodeGraphQueryOptions, CodeGraphStatus} from '../types.js';

export type CodeGraphCliFreshnessPolicy = 'allow-stale' | 'current' | 'ready';

export interface CodeGraphCliReadPlan {
  readonly refresh: boolean;
  readonly strictFreshness: boolean;
  readonly unavailable: boolean;
}

export const CODE_GRAPH_CLI_READ_TIMEOUT_MILLISECONDS = 25_000;
export const CODE_GRAPH_CLI_READ_RETRY_MILLISECONDS = 1_000;

export function codeGraphCliReadPlan(
  policy: CodeGraphCliFreshnessPolicy,
  status: Pick<CodeGraphStatus, 'readySnapshot' | 'stale'>,
): CodeGraphCliReadPlan {
  const hasReadySnapshot = status.readySnapshot !== undefined;
  const strictFreshness = policy === 'current';
  const unavailable = policy === 'allow-stale' && !hasReadySnapshot;
  return {
    refresh: !unavailable && (!hasReadySnapshot || (status.stale && strictFreshness)),
    strictFreshness,
    unavailable,
  };
}

/** A fresh worktree may immediately read same-commit shared evidence without accepting older source as current. */
export function codeGraphCliUsesBorrowedContinuity(
  policy: CodeGraphCliFreshnessPolicy,
  operation: CodeGraphQueryOptions['operation'],
  status: Pick<CodeGraphStatus, 'identity' | 'readySnapshot' | 'stale'>,
  borrowedSnapshot: boolean,
  worktreeClean: boolean,
): boolean {
  return (
    policy === 'current' &&
    borrowedSnapshot &&
    worktreeClean &&
    status.readySnapshot !== undefined &&
    status.readySnapshot.commit === status.identity.headCommit &&
    status.stale &&
    operation !== 'impact' &&
    operation !== 'path'
  );
}

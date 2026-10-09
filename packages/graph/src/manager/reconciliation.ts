import type {
  CodeGraphLifecycleOpportunityResult,
  CodeGraphLifecycleOpportunityTarget,
} from '../lifecycle/opportunity.js';

export type ManagerGraphReconciliationStatus =
  | {readonly reason: 'active-build' | 'maintenance'; readonly state: 'deferred'}
  | {readonly state: 'unavailable'}
  | {
      readonly blockedRepositories: number;
      readonly checkedAt: string;
      readonly pendingRepositories: number;
      readonly viewCleanupAdvanced: boolean;
      readonly repositoryCount: number;
      readonly state: 'observed';
      readonly unavailableRepositories: number;
      readonly viewsTruncated: boolean;
    };

export interface ManagerGraphReconciliationObservation {
  readonly repositoryCount: number;
  readonly lifecycleTargets: readonly CodeGraphLifecycleOpportunityTarget[];
  readonly unavailableRepositories: number;
  readonly viewsTruncated: boolean;
}

export function projectManagerGraphReconciliationStatus(input: {
  readonly activeBuild: boolean;
  readonly checkedAt: string;
  readonly lifecycleResult?: CodeGraphLifecycleOpportunityResult;
  readonly maintenance: boolean;
  readonly observation?: ManagerGraphReconciliationObservation;
}): ManagerGraphReconciliationStatus {
  if (input.activeBuild) return {reason: 'active-build', state: 'deferred'};
  if (input.maintenance) return {reason: 'maintenance', state: 'deferred'};
  if (input.observation === undefined) return {state: 'unavailable'};

  const pending = input.observation.lifecycleTargets.filter(target => target.reconciliationPending === true);
  const blockedRepositories = pending.filter(
    target => target.anchorIdentity === undefined && target.anchorPath === undefined,
  ).length;
  const viewCleanupAdvanced =
    input.lifecycleResult?.state === 'completed' &&
    input.lifecycleResult.result.state === 'completed' &&
    input.lifecycleResult.result.cleanup === 'removed-worktree-view';

  return {
    blockedRepositories,
    checkedAt: input.checkedAt,
    pendingRepositories: pending.length,
    viewCleanupAdvanced,
    repositoryCount: input.observation.repositoryCount,
    state: 'observed',
    unavailableRepositories: input.observation.unavailableRepositories,
    viewsTruncated: input.observation.viewsTruncated,
  };
}

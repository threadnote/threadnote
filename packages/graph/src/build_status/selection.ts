import {Array as EffectArray, Option} from 'effect';
import type {CodeGraphBuildStatusSelection, ObservedCodeGraphBuildStatus} from './contracts.js';

export function compareObservedBuildStatus(
  left: ObservedCodeGraphBuildStatus,
  right: ObservedCodeGraphBuildStatus,
): number {
  const priority = (status: ObservedCodeGraphBuildStatus) => {
    if (status.coordination?.role === 'owner') return 0;
    if (status.observation.liveness === 'active') return status.state === 'running' ? 1 : 2;
    if (status.observation.liveness === 'completed') return 3;
    if (status.observation.liveness === 'failed') return 4;
    if (status.observation.liveness === 'stalled') return status.state === 'running' ? 5 : 6;
    return 7;
  };
  return (
    priority(left) - priority(right) || Date.parse(right.timestamps.updatedAt) - Date.parse(left.timestamps.updatedAt)
  );
}

export function selectCodeGraphBuildStatuses(
  statuses: readonly ObservedCodeGraphBuildStatus[],
): CodeGraphBuildStatusSelection {
  const byWorktree = new Map<string, ObservedCodeGraphBuildStatus[]>();
  for (const status of statuses) {
    const key = `${status.identity.checkoutId}\0${status.identity.worktreeId}\0${status.identity.scopeId ?? ''}`;
    const current = byWorktree.get(key) ?? [];
    current.push(status);
    byWorktree.set(key, current);
  }
  const builds: ObservedCodeGraphBuildStatus[] = [];
  const waiters: ObservedCodeGraphBuildStatus[] = [];
  for (const group of byWorktree.values()) {
    group.sort(compareObservedBuildStatus);
    const owner = Option.getOrUndefined(EffectArray.findFirst(group, status => status.coordination?.role === 'owner'));
    builds.push(owner ?? group[0]);
    waiters.push(
      ...EffectArray.filter(
        group,
        status =>
          status.coordination?.role === 'waiter' &&
          (status.observation.liveness === 'active' || status.observation.liveness === 'stalled'),
      ),
    );
  }
  return {
    builds: builds.sort(compareObservedBuildStatus),
    waiters: waiters.sort(compareObservedBuildStatus),
  };
}

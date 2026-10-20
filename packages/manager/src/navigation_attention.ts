import {useCallback, useEffect, useState} from 'react';
import type {ManagerContextMaintenanceStatusV2} from './attention/contracts.js';
import type {SharingConflict} from './sharing_contracts.js';
import {api} from './ui/support.js';

export interface NavigationAttention {
  readonly shares?: number;
  readonly 'context-health'?: number;
}

interface ContextHealthDecisionCount {
  readonly project: string;
  readonly count: number;
}

/** A mounted Health view owns its projection; clearing one project never clears another. */
export function useContextHealthDecisionCount(): readonly [
  ContextHealthDecisionCount | undefined,
  (project: string, count: number | undefined) => void,
] {
  const [snapshot, setSnapshot] = useState<ContextHealthDecisionCount>();
  const update = useCallback((project: string, count: number | undefined) => {
    setSnapshot(current =>
      count === undefined
        ? current?.project === project
          ? undefined
          : current
        : current?.project === project && current.count === count
          ? current
          : {project, count},
    );
  }, []);
  return [snapshot, update];
}

/** Counts come from the complete queues, not the currently visible page of findings. */
export function useNavigationAttention(
  project: string,
  refreshGeneration: number,
  panel: string,
  enabled: boolean,
  contextHealthDecisionCount?: ContextHealthDecisionCount,
): NavigationAttention {
  const [snapshot, setSnapshot] = useState<{project: string; counts: NavigationAttention}>();
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      const options = {signal: controller.signal, timeoutMilliseconds: 10_000};
      const [shares, health] = await Promise.allSettled([
        api<{readonly conflicts: readonly SharingConflict[]}>('/api/shares/conflicts', undefined, options),
        project
          ? api<ManagerContextMaintenanceStatusV2>(
              `/api/attention/context-maintenance?project=${encodeURIComponent(project)}&limit=1`,
              undefined,
              options,
            )
          : Promise.resolve(undefined),
      ]);
      if (!controller.signal.aborted)
        setSnapshot({
          project,
          counts: {
            shares:
              shares.status === 'fulfilled' && Array.isArray(shares.value.conflicts)
                ? new Set(shares.value.conflicts.map(item => item.id)).size
                : undefined,
            'context-health': health.status === 'fulfilled' ? health.value?.counts?.decisionMemories : undefined,
          },
        });
      running = false;
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const onVisible = () => void refresh();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [project, refreshGeneration, panel, enabled]);
  if (!enabled) return {};
  const counts = snapshot?.project === project ? snapshot.counts : {};
  // The mounted Health panel reconciles confirmed writes against complete queue totals.
  // Its scoped projection must also win over late, stale navigation polls.
  return panel === 'context-health' && contextHealthDecisionCount?.project === project
    ? {...counts, 'context-health': contextHealthDecisionCount.count}
    : counts;
}

export function navigationAttentionLabel(panel: string, count: number, project: string): string {
  return panel === 'shares'
    ? `${count} unresolved sharing ${count === 1 ? 'conflict' : 'conflicts'}`
    : `${count} ${count === 1 ? 'memory needs' : 'memories need'} attention in ${project}`;
}

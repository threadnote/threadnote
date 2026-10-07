import {useEffect, useState} from 'react';
import type {ManagerContextMaintenanceStatusV2} from './attention/contracts.js';
import type {SharingConflict} from './sharing_contracts.js';
import {api} from './ui/support.js';

export interface NavigationAttention {
  readonly shares?: number;
  readonly 'context-health'?: number;
}

/** Counts come from the complete queues, not the currently visible page of findings. */
export function useNavigationAttention(
  project: string,
  refreshGeneration: number,
  panel: string,
  enabled: boolean,
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
  return enabled && snapshot?.project === project ? snapshot.counts : {};
}

export function navigationAttentionLabel(panel: string, count: number, project: string): string {
  return panel === 'shares'
    ? `${count} unresolved sharing ${count === 1 ? 'conflict' : 'conflicts'}`
    : `${count} ${count === 1 ? 'memory needs' : 'memories need'} attention in ${project}`;
}

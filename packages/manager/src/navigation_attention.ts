import {isConflictsResponse2, isManagerContextMaintenanceStatusV2} from './api/response_guards.js';
import {Array as EffectArray} from 'effect';
import {isReadonlyArray} from '@threadnote/platform/readonly-array';
import {useCallback, useEffect, useState} from 'react';
import type {ManagerContextMaintenanceStatusV2} from './attention/contracts.js';
import type {SharingConflict} from './sharing_contracts.js';
import {api} from './ui/support.js';
import {useManagerLiveQuery, useManagerLiveResource} from './live/provider.js';

const readMaintenance = (project: string) => (signal: AbortSignal) =>
  api<ManagerContextMaintenanceStatusV2>(
    `/api/attention/context-maintenance?project=${encodeURIComponent(project)}`,
    undefined,
    {signal, timeoutMilliseconds: 10_000},
    isManagerContextMaintenanceStatusV2,
  );

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
  const reader = useCallback(readMaintenance(project), [project]);
  const live = useManagerLiveResource(
    'context-maintenance',
    enabled ? project : '',
    reader,
    isManagerContextMaintenanceStatusV2,
  );
  const sharesLive = useManagerLiveQuery<{readonly conflicts: readonly SharingConflict[]}>(
    enabled ? {topic: 'share-conflicts', scope: 'account'} : undefined,
    'conflicts',
    signal => api('/api/shares/conflicts', undefined, {signal, timeoutMilliseconds: 10_000}, isConflictsResponse2),
    isConflictsResponse2,
  );
  const legacyShares = !sharesLive.active || sharesLive.snapshot.status === 'unsupported';
  const legacyHealth = !live.active || live.snapshot.status === 'unsupported';
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      const options = {signal: controller.signal, timeoutMilliseconds: 10_000};
      const [shares, health] = await Promise.allSettled([
        legacyShares
          ? api<{readonly conflicts: readonly SharingConflict[]}>(
              '/api/shares/conflicts',
              undefined,
              options,
              isConflictsResponse2,
            )
          : Promise.resolve(undefined),
        project && legacyHealth
          ? api<ManagerContextMaintenanceStatusV2>(
              `/api/attention/context-maintenance?project=${encodeURIComponent(project)}`,
              undefined,
              options,
              isManagerContextMaintenanceStatusV2,
            )
          : Promise.resolve(undefined),
      ]);
      if (!controller.signal.aborted)
        setSnapshot({
          project,
          counts: {
            shares:
              shares.status === 'fulfilled' && shares.value && isReadonlyArray(shares.value.conflicts)
                ? new Set(EffectArray.map(shares.value.conflicts, item => item.id)).size
                : undefined,
            'context-health': health.status === 'fulfilled' ? health.value?.counts?.decisionMemories : undefined,
          },
        });
      running = false;
    };
    void refresh();
    const timer = legacyShares || legacyHealth ? window.setInterval(() => void refresh(), 15_000) : undefined;
    const onVisible = () => void refresh();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [project, refreshGeneration, panel, enabled, legacyHealth, legacyShares]);
  if (!enabled) return {};
  const counts = snapshot?.project === project ? snapshot.counts : {};
  const liveCount = !legacyHealth && 'data' in live.snapshot ? live.snapshot.data?.counts?.decisionMemories : undefined;
  const liveShares =
    !legacyShares && 'data' in sharesLive.snapshot && isReadonlyArray(sharesLive.snapshot.data?.conflicts)
      ? new Set(EffectArray.map(sharesLive.snapshot.data.conflicts, item => item.id)).size
      : undefined;
  const projected = {
    ...counts,
    shares: legacyShares ? counts.shares : liveShares,
    'context-health': legacyHealth ? counts['context-health'] : liveCount,
  };
  // The mounted Health panel reconciles confirmed writes against complete queue totals.
  // Its scoped projection must also win over late, stale navigation polls.
  return panel === 'context-health' && contextHealthDecisionCount?.project === project
    ? {...projected, 'context-health': contextHealthDecisionCount.count}
    : projected;
}

export function navigationAttentionLabel(panel: string, count: number, project: string): string {
  return panel === 'shares'
    ? `${count} unresolved sharing ${count === 1 ? 'conflict' : 'conflicts'}`
    : `${count} ${count === 1 ? 'memory needs' : 'memories need'} attention in ${project}`;
}

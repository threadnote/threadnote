import {isGraphCatalog, isStatus, isStatusResponse} from '../api/response_guards.js';
import {useEffect, useRef, type Dispatch, type RefObject, type SetStateAction} from 'react';
import {
  graphBuildIsActive,
  graphCatalogRequiresAuthoritativeRefresh,
  graphCompletedBuildResultIdentity,
  graphDiagnosticsRequiresCatalogRefresh,
  graphStatusPollDelay,
  graphStatusRequiresCatalogRefresh,
  mergeGraphCatalogStatus,
  type GraphCatalog,
} from '../graph.js';
import {useManagerLiveConnection, useManagerLiveQuery} from '../live/provider.js';
import {GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS, api, errorMessage} from './support.js';
import {Array as EffectArray} from 'effect';

type Status = Pick<
  GraphCatalog,
  'automaticCompaction' | 'builds' | 'catalogRevision' | 'lifecyclePending' | 'maintenance' | 'waiterCount' | 'waiters'
>;

export function useManagerRuntimeConnection(options: {
  readonly runtime: 'connecting' | 'connected' | 'disconnected';
  readonly onLost: () => void;
  readonly onReady: () => void;
  readonly onRecovery: () => void;
}): void {
  const connection = useManagerLiveConnection();
  useEffect(() => {
    if (connection !== 'unsupported' && connection !== 'stopped') return;
    const timer = window.setInterval(() => {
      void api<{readonly status: 'ok'}>('/api/health', undefined, undefined, isStatusResponse).then(
        () => {
          if (options.runtime === 'disconnected') options.onRecovery();
        },
        () => options.onLost(),
      );
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [options.runtime, connection]);
  useEffect(() => {
    if (connection === 'connected') options.onReady();
    else if (connection === 'stale') options.onLost();
  }, [connection]);
}

export function useGraphLiveStatus(options: {
  readonly enabled: boolean;
  readonly catalog: RefObject<GraphCatalog | undefined>;
  readonly authoritative: RefObject<boolean>;
  readonly diagnosticsRevision: RefObject<string | undefined>;
  readonly setCatalog: Dispatch<SetStateAction<GraphCatalog | undefined>>;
  readonly setError: Dispatch<SetStateAction<string>>;
  readonly refreshDiagnostics: (revision: string | undefined, signal: AbortSignal) => Promise<unknown>;
}): void {
  const live = useManagerLiveQuery<Status>(
    options.enabled ? {topic: 'graph-status', scope: 'account'} : undefined,
    'status',
    signal =>
      api<Status>(
        '/api/graphs/status',
        undefined,
        {
          signal,
          timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
        },
        isStatus,
      ),
    isStatus,
  );
  const fallback = !live.active || live.snapshot.status === 'unsupported';
  const observed = useRef({activeBuild: false, activeMaintenance: false, acknowledged: new Set<string>()});
  const liveQueue = useRef<{active: boolean; running: boolean; pending?: Status; controller?: AbortController}>({
    active: false,
    running: false,
  });
  async function apply(status: Status, cancelled: () => boolean, signal: AbortSignal): Promise<void> {
    const activeBuild = EffectArray.some(status.builds, graphBuildIsActive);
    const activeMaintenance = status.maintenance !== undefined;
    const previous = observed.current;
    const refreshCatalog =
      graphCatalogRequiresAuthoritativeRefresh(options.authoritative.current, status.maintenance) ||
      (!activeMaintenance &&
        ((previous.activeBuild && !activeBuild) ||
          (previous.activeMaintenance && !activeMaintenance) ||
          graphStatusRequiresCatalogRefresh(
            options.catalog.current,
            status.builds,
            previous.acknowledged,
            status.catalogRevision,
          )));
    if (refreshCatalog) {
      const refreshed = await api<GraphCatalog>(
        '/api/graphs',
        undefined,
        {
          signal,
          timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
        },
        isGraphCatalog,
      );
      if (cancelled()) return;
      const merged = mergeGraphCatalogStatus(refreshed, status);
      options.authoritative.current = true;
      options.catalog.current = merged;
      options.setCatalog(merged);
      options.setError('');
      for (const build of status.builds) {
        const identity = graphCompletedBuildResultIdentity(build);
        if (identity) previous.acknowledged.add(identity);
      }
    } else {
      const merged = mergeGraphCatalogStatus(options.catalog.current, status);
      options.catalog.current = merged;
      options.setCatalog(merged);
    }
    if (
      graphDiagnosticsRequiresCatalogRefresh(
        options.diagnosticsRevision.current,
        status.catalogRevision,
        status.maintenance,
      )
    ) {
      await options.refreshDiagnostics(status.catalogRevision, signal);
      if (cancelled()) return;
    }
    previous.activeBuild = activeBuild;
    previous.activeMaintenance = activeMaintenance;
  }
  useEffect(() => {
    const queue = liveQueue.current;
    queue.active = options.enabled && !fallback;
    if (queue.active) return;
    queue.controller?.abort();
    queue.pending = undefined;
    return () => undefined;
  }, [options.enabled, fallback]);
  useEffect(
    () => () => {
      liveQueue.current.active = false;
      liveQueue.current.controller?.abort();
      liveQueue.current.pending = undefined;
    },
    [],
  );
  useEffect(() => {
    if (!options.enabled || fallback || live.snapshot.status !== 'ready') return;
    const queue = liveQueue.current;
    queue.pending = live.snapshot.data;
    if (queue.running) return;
    const process = async () => {
      queue.running = true;
      try {
        while (queue.active && queue.pending) {
          const status = queue.pending;
          queue.pending = undefined;
          const controller = new AbortController();
          queue.controller = controller;
          try {
            await apply(status, () => !queue.active || controller.signal.aborted, controller.signal);
          } catch (cause) {
            if (queue.active && !controller.signal.aborted) options.setError(errorMessage(cause));
          } finally {
            if (queue.controller === controller) queue.controller = undefined;
          }
        }
      } finally {
        queue.running = false;
        if (queue.active && queue.pending) void process();
      }
    };
    void process();
  }, [options.enabled, fallback, live.snapshot]);
  useEffect(() => {
    if (!options.enabled || !fallback) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await api<Status>(
          '/api/graphs/status',
          undefined,
          {
            signal: controller.signal,
            timeoutMilliseconds: GRAPH_CATALOG_REQUEST_TIMEOUT_MILLISECONDS,
          },
          isStatus,
        );
        if (cancelled) return;
        await apply(status, () => cancelled, controller.signal);
        if (!cancelled)
          timer = window.setTimeout(
            () => void poll(),
            graphStatusPollDelay(
              status.builds,
              status.maintenance,
              status.lifecyclePending,
              status.automaticCompaction,
            ),
          );
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 15_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [options.enabled, fallback]);
}

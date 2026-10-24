import React, {createContext, useContext, useEffect, useMemo, useRef, useState} from 'react';
import type {ManagerProcessDiagnostics} from './contracts.js';
import {api, errorMessage} from '../ui/support.js';
import {useManagerLiveQuery} from '../live/provider.js';

interface ProcessInventory {
  readonly diagnostics?: ManagerProcessDiagnostics;
  readonly loadError: string;
  readonly load: (signal?: AbortSignal) => Promise<void>;
}

const ProcessInventoryContext = createContext<ProcessInventory | undefined>(undefined);

function useProcessInventory(enabled: boolean): ProcessInventory {
  const [diagnostics, setDiagnostics] = useState<ManagerProcessDiagnostics>();
  const [loadError, setLoadError] = useState('');
  const [displayNow, setDisplayNow] = useState(() => Date.now());
  const sample = useRef<{data?: ManagerProcessDiagnostics; at: number}>({at: Date.now()});
  const live = useManagerLiveQuery<ManagerProcessDiagnostics>(
    enabled ? {topic: 'processes', scope: 'account'} : undefined,
    'diagnostics',
    signal => api<ManagerProcessDiagnostics>('/api/processes', undefined, {signal, timeoutMilliseconds: 8_000}),
  );
  const fallback = !live.active || live.snapshot.status === 'unsupported';
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setDisplayNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  const load = async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await api<ManagerProcessDiagnostics>('/api/processes', undefined, {
        signal,
        timeoutMilliseconds: 8_000,
      });
      if (signal?.aborted) return;
      setDiagnostics(next);
      setLoadError('');
      live.invalidate();
    } catch (cause) {
      if (!signal?.aborted) setLoadError(errorMessage(cause));
    }
  };
  useEffect(() => {
    if (!enabled || !fallback) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      await load(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, fallback]);
  const current = !fallback ? (live.snapshot.data ?? diagnostics) : diagnostics;
  if (current !== sample.current.data) sample.current = {data: current, at: Date.now()};
  const displayed = useMemo(
    () =>
      current && Array.isArray(current.processes)
        ? {
            ...current,
            processes: current.processes.map(process => ({
              ...process,
              ageMilliseconds: process.ageMilliseconds + Math.max(0, displayNow - sample.current.at),
            })),
          }
        : current,
    [current, displayNow],
  );
  return {
    diagnostics: displayed,
    loadError: !fallback && live.snapshot.status === 'error' ? errorMessage(live.snapshot.error) : loadError,
    load,
  };
}

export function ManagerProcessesProvider({children}: {readonly children: React.ReactNode}): React.ReactElement {
  const inventory = useProcessInventory(true);
  return <ProcessInventoryContext.Provider value={inventory}>{children}</ProcessInventoryContext.Provider>;
}

export function useManagerProcesses(): ProcessInventory {
  const shared = useContext(ProcessInventoryContext);
  const local = useProcessInventory(shared === undefined);
  return shared ?? local;
}

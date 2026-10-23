import React, {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {useManagerLiveQuery} from './live/provider.js';
import {api} from './ui/support.js';
import type {ModelSetupStatus} from './model_setup_contracts.js';

interface ModelSetupState {
  readonly status?: ModelSetupStatus;
  readonly error: string;
  readonly busy: boolean;
  readonly readyVersion: number;
  readonly setup: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly setPolicy: (policy: 'automatic' | 'off') => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly changeDemand: (delta: number) => void;
}
const endpoint = '/api/models/setup';
const noop = async () => undefined;
const empty: ModelSetupState = {
  error: '',
  busy: false,
  readyVersion: 0,
  setup: noop,
  retry: noop,
  setPolicy: noop,
  refresh: noop,
  changeDemand: () => undefined,
};
const Context = createContext<ModelSetupState>(empty);

export function ModelSetupProvider({children}: {readonly children: React.ReactNode}): React.ReactElement {
  const [demand, setDemand] = useState(0);
  const changeDemand = useCallback((delta: number) => setDemand(value => Math.max(0, value + delta)), []);
  const live = useManagerLiveQuery<ModelSetupStatus>(
    demand > 0 ? {topic: 'model-setup', scope: 'account'} : undefined,
    'status',
    signal => api<ModelSetupStatus>(endpoint, undefined, {signal, timeoutMilliseconds: 10_000}),
  );
  const fallback = !live.active || live.snapshot.status === 'unsupported';
  const [status, setStatus] = useState<ModelSetupStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [readyVersion, setReadyVersion] = useState(0);
  const [pollTrigger, setPollTrigger] = useState({generation: 0, immediate: true});
  const mountedDemand = useRef(false);
  const statusRef = useRef<ModelSetupStatus | undefined>(undefined);
  const busyRef = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const fallbackRead = useRef<AbortController | undefined>(undefined);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commandGeneration = useRef(0);
  const accept = (next: ModelSetupStatus) => {
    const becameReady = next.artifactReady && !statusRef.current?.artifactReady;
    setReadyVersion(value => value + Number(becameReady));
    statusRef.current = next;
    setStatus(next);
    setError('');
  };
  useEffect(() => {
    if (fallback) return;
    if (live.snapshot.status === 'ready') accept(live.snapshot.data);
    else if (live.snapshot.status === 'error') setError('Model setup status is unavailable.');
  }, [fallback, live.snapshot]);
  useEffect(() => {
    if (demand === 0 || !fallback) {
      mountedDemand.current = false;
      return;
    }
    const freshMount = !mountedDemand.current;
    mountedDemand.current = true;
    const controller = new AbortController();
    const generation = commandGeneration.current;
    fallbackRead.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const poll = async () => {
      if (controller.signal.aborted || busyRef.current || generation !== commandGeneration.current) return;
      try {
        const next = await api<ModelSetupStatus>(endpoint, undefined, {
          signal: controller.signal,
          timeoutMilliseconds: 10_000,
        });
        if (controller.signal.aborted || busyRef.current || generation !== commandGeneration.current) return;
        failures = 0;
        accept(next);
        if (['pending', 'downloading', 'verifying', 'retry-wait'].includes(next.phase)) {
          const delay =
            next.phase === 'retry-wait'
              ? Math.min(30_000, Math.max(1_500, (next.nextAttemptAt ?? 0) - Date.now()))
              : 1_500;
          timer = setTimeout(() => void poll(), delay);
        }
      } catch {
        if (controller.signal.aborted || busyRef.current || generation !== commandGeneration.current) return;
        setError('Model setup status is unavailable. Retrying…');
        failures = Math.min(failures + 1, 6);
        timer = setTimeout(() => void poll(), Math.min(30_000, 1_500 * 2 ** (failures - 1)));
      }
    };
    if (freshMount || pollTrigger.immediate) void poll();
    else if (
      statusRef.current &&
      ['pending', 'downloading', 'verifying', 'retry-wait'].includes(statusRef.current.phase)
    )
      timer = setTimeout(() => void poll(), 1_500);
    return () => {
      controller.abort();
      if (fallbackRead.current === controller) fallbackRead.current = undefined;
      clearTimeout(timer);
    };
  }, [fallback, demand > 0, pollTrigger.generation]);
  useEffect(
    () => () => {
      request.current?.abort();
      clearTimeout(recoveryTimer.current);
    },
    [],
  );
  const refresh = async () => {
    if (busyRef.current) return;
    if (!fallback) {
      live.invalidate();
      return;
    }
    // Restart the same abortable fallback read lifecycle. A command aborts its controller,
    // so a late pre-command refresh can never replace the command's status or intent epoch.
    setPollTrigger(value => ({generation: value.generation + 1, immediate: true}));
  };
  const action = async (body: {action: 'setup' | 'retry'} | {action: 'policy'; policy: 'automatic' | 'off'}) => {
    if (!statusRef.current || busyRef.current) return;
    clearTimeout(recoveryTimer.current);
    recoveryTimer.current = undefined;
    const generation = ++commandGeneration.current;
    fallbackRead.current?.abort();
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await api<ModelSetupStatus>(
        endpoint,
        {...body, confirm: true, expectedEpoch: statusRef.current.intentEpoch},
        {signal: controller.signal, timeoutMilliseconds: 10_000},
      );
      if (!controller.signal.aborted) {
        accept(next);
        live.invalidate();
        // The fallback effect uses current coverage; this command may have started
        // before live support was lost or recovered.
        setPollTrigger(value => ({generation: value.generation + 1, immediate: false}));
      }
    } catch {
      if (!controller.signal.aborted) {
        setError('Could not change model setup. Refreshing its current status…');
        recoveryTimer.current = setTimeout(() => {
          recoveryTimer.current = undefined;
          if (!busyRef.current && commandGeneration.current === generation)
            setPollTrigger(value => ({generation: value.generation + 1, immediate: true}));
        }, 1_500);
        live.invalidate();
      }
    } finally {
      if (request.current === controller) request.current = undefined;
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Context.Provider
      value={{
        status,
        error,
        busy,
        readyVersion,
        setup: () => action({action: 'setup'}),
        retry: () => action({action: 'retry'}),
        setPolicy: policy => action({action: 'policy', policy}),
        refresh,
        changeDemand,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useModelSetup(enabled = true): ModelSetupState {
  const state = useContext(Context);
  useEffect(() => {
    if (!enabled) return;
    state.changeDemand(1);
    return () => state.changeDemand(-1);
  }, [enabled, state.changeDemand]);
  return enabled ? state : empty;
}

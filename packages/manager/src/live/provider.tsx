import {isTicketResponse} from '../api/response_guards.js';
import React, {createContext, useContext, useEffect, useMemo, useSyncExternalStore} from 'react';
import {createManagerLiveClient} from './client.js';
import {createManagerLiveSnapshotProjection} from './snapshot_projection.js';
import type {ManagerLiveResource} from './contracts.js';
import {MANAGER_LIVE_SNAPSHOT_HEADER, MANAGER_LIVE_SUPPORTED_TOPICS} from './contracts.js';
import type {ManagerLiveSnapshot} from './store.js';
import {api} from '../ui/support.js';

type Client = ReturnType<typeof createManagerLiveClient>;
const LiveContext = createContext<Client | undefined>(undefined);
const loading: {readonly status: 'loading'} = {status: 'loading'};

/** A Manager tab owns one socket. Account changes dispose the old cache and socket. */
export function ManagerLiveProvider(props: {
  readonly account?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const client = useMemo(
    () =>
      props.account
        ? createManagerLiveClient({
            origin: window.location.origin,
            scopeKey: props.account,
            requestTicket: signal =>
              api<{ticket: string}>(
                '/api/live-session',
                {topics: [...MANAGER_LIVE_SUPPORTED_TOPICS]},
                {
                  signal,
                  headers: {[MANAGER_LIVE_SNAPSHOT_HEADER]: 'processes,graph-status'},
                },
                isTicketResponse,
              ),
          })
        : undefined,
    [props.account],
  );
  useEffect(() => {
    client?.start();
    return () => client?.stop();
  }, [client]);
  useEffect(() => {
    if (!client) return;
    const revalidate = () => client.revalidate();
    const visible = () => {
      if (document.visibilityState === 'visible') revalidate();
    };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [client]);
  return <LiveContext.Provider value={client}>{props.children}</LiveContext.Provider>;
}

export function useManagerLiveResource<T>(
  topic: 'context-health' | 'context-maintenance',
  project: string,
  reader: (signal: AbortSignal) => Promise<T>,
  isData: (value: unknown) => value is T,
): {
  readonly snapshot: ManagerLiveSnapshot<T>;
  readonly active: boolean;
  readonly invalidate: () => void;
} {
  const resource = useMemo<ManagerLiveResource | undefined>(
    () => (project ? {topic, project} : undefined),
    [topic, project],
  );
  return useManagerLiveQuery(resource, '', reader, isData);
}

export function useManagerLiveQuery<T>(
  resource: ManagerLiveResource | undefined,
  queryKey: string,
  reader: (signal: AbortSignal) => Promise<T>,
  isData: (value: unknown) => value is T,
) {
  const client = useContext(LiveContext);
  const projectSnapshot = useMemo(() => createManagerLiveSnapshotProjection<T>(), []);
  const readerRef = React.useRef(reader);
  readerRef.current = reader;
  const resourceKey = resource === undefined ? '' : JSON.stringify(resource);
  const stableResource = useMemo(() => resource, [resourceKey]);
  const subscribe = React.useCallback(
    (listener: () => void) =>
      client && stableResource
        ? client.subscribeQuery(stableResource, queryKey, signal => readerRef.current(signal), listener)
        : () => undefined,
    [client, stableResource, queryKey],
  );
  const getSnapshot = React.useCallback(
    () =>
      projectSnapshot(client && stableResource ? client.getQuerySnapshot(stableResource, queryKey) : loading, isData),
    [client, stableResource, queryKey, projectSnapshot, isData],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const invalidate = React.useCallback(() => {
    if (client && stableResource) client.invalidate(stableResource, queryKey);
  }, [client, stableResource, queryKey]);
  return {snapshot, active: !!client && !!stableResource, invalidate};
}

export function useManagerLiveConnection() {
  const client = useContext(LiveContext);
  const subscribe = React.useCallback(
    (listener: () => void) => client?.subscribeConnection(listener) ?? (() => undefined),
    [client],
  );
  const getSnapshot = React.useCallback(() => client?.getConnectionSnapshot() ?? 'stopped', [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

import React, {createContext, useContext, useEffect, useMemo, useSyncExternalStore} from 'react';
import {createManagerLiveClient} from './client.js';
import type {ManagerLiveResource, ManagerLiveTopic} from './contracts.js';
import type {ManagerLiveSnapshot} from './store.js';
import {api} from '../ui/support.js';

type Client = ReturnType<typeof createManagerLiveClient>;
const LiveContext = createContext<Client | undefined>(undefined);
const loading: ManagerLiveSnapshot = {status: 'loading'};

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
            requestTicket: signal => api<{ticket: string}>('/api/live-session', {}, {signal}),
          })
        : undefined,
    [props.account],
  );
  useEffect(() => {
    client?.start();
    return () => client?.stop();
  }, [client]);
  return <LiveContext.Provider value={client}>{props.children}</LiveContext.Provider>;
}

export function useManagerLiveResource<T>(
  topic: ManagerLiveTopic,
  project: string,
  reader: (signal: AbortSignal) => Promise<T>,
): {
  readonly snapshot: ManagerLiveSnapshot<T>;
  readonly active: boolean;
  readonly invalidate: () => void;
} {
  const client = useContext(LiveContext);
  const resource = useMemo<ManagerLiveResource | undefined>(
    () => (project ? {topic, project} : undefined),
    [topic, project],
  );
  const subscribe = React.useCallback(
    (listener: () => void) => (client && resource ? client.subscribe(resource, reader, listener) : () => undefined),
    [client, resource, reader],
  );
  const getSnapshot = React.useCallback(
    () => (client && resource ? client.getSnapshot<T>(resource) : (loading as ManagerLiveSnapshot<T>)),
    [client, resource],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const invalidate = React.useCallback(() => {
    if (client && resource) client.invalidate(resource);
  }, [client, resource]);
  return {snapshot, active: !!client && !!resource, invalidate};
}

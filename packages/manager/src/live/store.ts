import {Array as EffectArray} from 'effect';
import {MANAGER_LIVE_LIMITS, managerLiveResourceKey, type ManagerLiveResource} from './contracts.js';

export type ManagerLiveSnapshot<T = unknown> =
  | {readonly status: 'loading' | 'unsupported'; readonly data?: T}
  | {readonly status: 'ready' | 'stale'; readonly data: T}
  | {readonly status: 'error'; readonly data?: T; readonly error: unknown};

export interface ManagerLiveEntry<T = unknown> {
  readonly resource: ManagerLiveResource;
  readonly key: string;
  readonly queryKey: string;
  readonly listeners: Set<() => void>;
  read: (signal: AbortSignal) => Promise<T>;
  snapshot: ManagerLiveSnapshot<T>;
  controller?: AbortController;
  reading: boolean;
  dirty: boolean;
  available: boolean;
  version: number;
}

interface ResourceGroup {
  readonly resource: ManagerLiveResource;
  readonly queries: Map<string, ManagerLiveEntry>;
}

/** One wire group may own several independently fenced local REST queries. */
export class ManagerLiveStore {
  private readonly groups = new Map<string, ResourceGroup>();
  private queryCount = 0;

  get(resource: ManagerLiveResource, queryKey = ''): ManagerLiveEntry | undefined {
    return this.groups.get(managerLiveResourceKey(resource))?.queries.get(queryKey);
  }

  values(): readonly ManagerLiveEntry[] {
    return EffectArray.flatMap([...this.groups.values()], group => [...group.queries.values()]);
  }

  resources(): readonly ManagerLiveResource[] {
    return EffectArray.map([...this.groups.values()], group => group.resource);
  }

  queries(resource: ManagerLiveResource): readonly ManagerLiveEntry[] {
    return [...(this.groups.get(managerLiveResourceKey(resource))?.queries.values() ?? [])];
  }

  has(resource: ManagerLiveResource): boolean {
    return this.groups.has(managerLiveResourceKey(resource));
  }

  add<T>(
    resource: ManagerLiveResource,
    queryKey: string,
    read: (signal: AbortSignal) => Promise<T>,
    listener: () => void,
  ): ManagerLiveEntry {
    const key = managerLiveResourceKey(resource);
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= MANAGER_LIVE_LIMITS.subscriptions) throw new Error('Too many live resources');
      group = {resource, queries: new Map()};
      this.groups.set(key, group);
    }
    let entry = group.queries.get(queryKey);
    if (!entry) {
      if (this.queryCount >= MANAGER_LIVE_LIMITS.queries) {
        if (group.queries.size === 0) this.groups.delete(key);
        throw new Error('Too many live queries');
      }
      entry = {
        resource,
        key,
        queryKey,
        read,
        listeners: new Set(),
        snapshot: {status: 'loading'},
        reading: false,
        dirty: false,
        available: group.queries.values().next().value?.available ?? true,
        version: 0,
      };
      group.queries.set(queryKey, entry);
      this.queryCount++;
    }
    entry.read = read;
    entry.listeners.add(listener);
    return entry;
  }

  remove(entry: ManagerLiveEntry, listener: () => void): boolean {
    const group = this.groups.get(entry.key);
    if (group?.queries.get(entry.queryKey) !== entry) return false;
    entry.listeners.delete(listener);
    if (entry.listeners.size) return false;
    entry.version++;
    entry.controller?.abort();
    group.queries.delete(entry.queryKey);
    this.queryCount--;
    if (group.queries.size) return false;
    this.groups.delete(entry.key);
    return true;
  }

  update<T>(entry: ManagerLiveEntry<T>, snapshot: ManagerLiveSnapshot<T>): void {
    entry.snapshot = snapshot;
    for (const listener of [...entry.listeners]) listener();
  }

  clear(): void {
    for (const entry of this.values()) {
      entry.version++;
      entry.controller?.abort();
      entry.listeners.clear();
    }
    this.groups.clear();
    this.queryCount = 0;
  }
}

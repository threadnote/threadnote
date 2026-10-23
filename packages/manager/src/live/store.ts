import {managerLiveResourceKey, type ManagerLiveResource} from './contracts.js';

export type ManagerLiveSnapshot<T = unknown> =
  | {readonly status: 'loading' | 'unsupported'; readonly data?: T}
  | {readonly status: 'ready' | 'stale'; readonly data: T}
  | {readonly status: 'error'; readonly data?: T; readonly error: unknown};

export interface ManagerLiveEntry<T = unknown> {
  readonly resource: ManagerLiveResource;
  readonly key: string;
  readonly listeners: Set<() => void>;
  read: (signal: AbortSignal) => Promise<T>;
  snapshot: ManagerLiveSnapshot<T>;
  controller?: AbortController;
  reading: boolean;
  dirty: boolean;
  available: boolean;
  version: number;
}

/** A tab-scoped, bounded registry. Entries disappear with their last subscriber. */
export class ManagerLiveStore {
  private readonly entries = new Map<string, ManagerLiveEntry>();

  get(resource: ManagerLiveResource): ManagerLiveEntry | undefined {
    return this.entries.get(managerLiveResourceKey(resource));
  }

  values(): readonly ManagerLiveEntry[] {
    return [...this.entries.values()];
  }

  add<T>(
    resource: ManagerLiveResource,
    read: (signal: AbortSignal) => Promise<T>,
    listener: () => void,
  ): ManagerLiveEntry<T> {
    const key = managerLiveResourceKey(resource);
    let entry = this.entries.get(key) as ManagerLiveEntry<T> | undefined;
    if (!entry) {
      if (this.entries.size >= 32) throw new Error('Too many live resources');
      entry = {
        resource,
        key,
        read,
        listeners: new Set(),
        snapshot: {status: 'loading'},
        reading: false,
        dirty: false,
        available: true,
        version: 0,
      };
      this.entries.set(key, entry);
    }
    entry.listeners.add(listener);
    return entry;
  }

  remove(entry: ManagerLiveEntry, listener: () => void): boolean {
    if (this.entries.get(entry.key) !== entry) return false;
    entry.listeners.delete(listener);
    if (entry.listeners.size) return false;
    entry.version++;
    entry.controller?.abort();
    this.entries.delete(entry.key);
    return true;
  }

  update<T>(entry: ManagerLiveEntry<T>, snapshot: ManagerLiveSnapshot<T>): void {
    entry.snapshot = snapshot;
    for (const listener of [...entry.listeners]) listener();
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.version++;
      entry.controller?.abort();
      entry.listeners.clear();
    }
    this.entries.clear();
  }
}

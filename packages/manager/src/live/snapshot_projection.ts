import type {ManagerLiveSnapshot} from './store.js';

type DataGuard<T> = (value: unknown) => value is T;
interface CachedProjection<T> {
  guard: DataGuard<T>;
  readonly valid: boolean;
  readonly snapshot: ManagerLiveSnapshot<T>;
}

function projectSnapshot<T>(source: ManagerLiveSnapshot, guard: DataGuard<T>): CachedProjection<T> {
  const invalid = (): CachedProjection<T> => ({
    guard,
    valid: false,
    snapshot: {status: 'error', error: new Error('Could not read live status. Reload the page.')},
  });
  if (source.status === 'ready' || source.status === 'stale') {
    const data = source.data;
    return guard(data) ? {guard, valid: true, snapshot: {...source, data}} : invalid();
  }
  if (source.data === undefined) {
    const snapshot: ManagerLiveSnapshot<T> =
      source.status === 'error'
        ? 'data' in source
          ? {status: source.status, error: source.error, data: undefined}
          : {status: source.status, error: source.error}
        : 'data' in source
          ? {status: source.status, data: undefined}
          : {status: source.status};
    return {guard, valid: true, snapshot};
  }
  const data = source.data;
  return guard(data) ? {guard, valid: true, snapshot: {...source, data}} : invalid();
}

/** A consumer validates raw cache data while keeping stable views for unchanged snapshots. */
export function createManagerLiveSnapshotProjection<T>() {
  const projections = new WeakMap<ManagerLiveSnapshot, CachedProjection<T>>();
  return (source: ManagerLiveSnapshot, guard: DataGuard<T>): ManagerLiveSnapshot<T> => {
    const previous = projections.get(source);
    if (previous?.guard === guard) return previous.snapshot;
    const next = projectSnapshot(source, guard);
    if (previous?.valid === next.valid) {
      previous.guard = guard;
      return previous.snapshot;
    }
    projections.set(source, next);
    return next.snapshot;
  };
}

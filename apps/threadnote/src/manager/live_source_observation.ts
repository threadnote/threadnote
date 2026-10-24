import {
  Clock,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import {
  managerLiveResourceKey,
  type ManagerLiveResource,
  type ManagerLiveTopic,
} from '@threadnote/manager/live/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runtimeTextDirectoryNamePage} from '@threadnote/platform/system';
import {modelSetupFileIdentity} from '@threadnote/inference/models/setup';

class ManagerSourceObservationError extends Schema.TaggedError<ManagerSourceObservationError>()(
  'ManagerSourceObservationError',
  {message: Schema.String},
) {}

export interface ManagerSourceProbe {
  readonly revision: string;
  readonly directories: readonly string[];
  readonly nextChangeAt?: number;
}

export interface ManagerSourceCallbacks {
  readonly onInvalidate: (resource: ManagerLiveResource, revision: string) => Effect.Effect<void>;
  readonly onAvailability: (resource: ManagerLiveResource, available: boolean) => Effect.Effect<void>;
}

/** Metadata only: never opens a graph database, model payload or report. */
export const managerSourceFileIdentity = Effect.fn('manager.sourceLive.fileIdentity')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option)))
    return yield* ManagerSourceObservationError.make({message: 'Linked live source'});
  const stat = yield* fs.stat(file).pipe(
    Effect.catchIf(
      error => PlatformError.isPlatformError(error) && error.reason._tag === 'NotFound',
      () => Effect.void,
    ),
  );
  if (!stat) return 'absent';
  if (stat.type !== 'File') return yield* ManagerSourceObservationError.make({message: 'Invalid live source'});
  return [
    stat.size.toString(),
    Option.getOrUndefined(stat.ino)?.toString(),
    Option.getOrUndefined(stat.mtime)?.getTime(),
  ].join(':');
});

/** Enumerate before allocation with a fixed cap; absence is a stable, watched source. */
export const managerSourceDirectoryFiles = Effect.fn('manager.sourceLive.directoryFiles')(function* (
  directory: string,
  select: (name: string) => boolean,
  limit = 512,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (Option.isSome(yield* fs.readLink(directory).pipe(Effect.option)))
    return yield* ManagerSourceObservationError.make({message: 'Linked source directory'});
  if (!(yield* fs.exists(directory))) return [] as string[];
  const page = yield* runtimeTextDirectoryNamePage(directory, limit);
  if (page.overflow)
    return yield* ManagerSourceObservationError.make({message: 'Live source directory budget exceeded'});
  return page.names
    .filter(select)
    .sort()
    .map(name => path.join(directory, name));
});

export const managerSourceFilesProbe = Effect.fn('manager.sourceLive.filesProbe')(function* (
  files: readonly string[],
  directories: readonly string[] = [],
  nativeArtifactFiles: readonly string[] = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (files.length > 1024)
    return yield* ManagerSourceObservationError.make({message: 'Live source file budget exceeded'});
  const sorted = [...new Set(files)].sort();
  const artifacts = new Set(nativeArtifactFiles);
  const identities = yield* Effect.forEach(
    sorted,
    file =>
      artifacts.has(file)
        ? Effect.gen(function* () {
            if (!(yield* fs.exists(file))) return 'absent';
            const identity = yield* modelSetupFileIdentity(file);
            if (identity === undefined)
              return yield* ManagerSourceObservationError.make({message: 'Invalid model artifact source'});
            return JSON.stringify(identity);
          })
        : managerSourceFileIdentity(file),
    {concurrency: 4},
  );
  const watched = new Set([...directories, ...sorted.map(file => path.dirname(file))]);
  for (const directory of [...watched]) {
    let ancestor = path.dirname(directory);
    while (!(yield* fs.exists(ancestor)) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    watched.add(ancestor);
  }
  return {
    revision: sha256HexSync(JSON.stringify(sorted.map((file, index) => [file, identities[index]]))),
    directories: [...watched],
  } satisfies ManagerSourceProbe;
});

interface Entry {
  readonly resource: ManagerLiveResource;
  available: boolean;
  revision?: string;
  directories: readonly string[];
  deadline?: number;
}

/** One scoped, bounded reconciliation loop; watch loss never implies unchanged. */
export const makeManagerSourceObservation = Effect.fn('manager.sourceLive.observe')(function* <R>(
  topics: readonly ManagerLiveTopic[],
  callbacks: ManagerSourceCallbacks,
  observe: (resource: ManagerLiveResource) => Effect.Effect<ManagerSourceProbe | void, unknown, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  const environment = yield* Effect.context<R>();
  const gate = yield* Semaphore.make(1);
  const wake = yield* Queue.dropping<void>(1);
  const signal = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  const entries = new Map<string, Entry>();
  const connections = new Map<string, readonly ManagerLiveResource[]>();
  const watches = new Map<string, Fiber.Fiber<void>>();
  let nextReconcile = Infinity;
  const availability = (entry: Entry, available: boolean) =>
    Effect.gen(function* () {
      if (entry.available === available) return;
      entry.available = available;
      yield* callbacks.onAvailability(entry.resource, available);
    });
  const updateWatches = Effect.gen(function* () {
    const desired = new Set([...entries.values()].flatMap(entry => entry.directories));
    if (desired.size > 128) {
      for (const entry of entries.values()) {
        entry.directories = [];
        yield* availability(entry, false);
      }
      desired.clear();
    }
    for (const [directory, fiber] of watches)
      if (!desired.has(directory)) {
        watches.delete(directory);
        yield* Fiber.interrupt(fiber);
      }
    for (const directory of desired)
      if (!watches.has(directory)) {
        const watch = Effect.forever(
          fs.watch(directory, {recursive: false}).pipe(
            Stream.runForEach(() => signal),
            Effect.ignoreCause,
            Effect.andThen(Effect.sleep('2 seconds')),
          ),
        );
        watches.set(directory, yield* watch.pipe(Effect.forkIn(scope)));
      }
  });
  const check = (entry: Entry) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const deadlinePassed = entry.deadline !== undefined && entry.deadline <= now;
      entry.deadline = undefined;
      const probe = yield* observe(entry.resource).pipe(
        Effect.provide(environment),
        Effect.timeoutOption('10 seconds'),
        Effect.map(Option.getOrUndefined),
        Effect.catchCause(() => Effect.void),
      );
      if (entries.get(managerLiveResourceKey(entry.resource)) !== entry) return;
      if (!probe || probe.directories.length > 128) {
        entry.directories = [];
        yield* availability(entry, false);
        return;
      }
      const prior = entry.revision;
      entry.directories = probe.directories;
      if (new Set([...entries.values()].flatMap(value => value.directories)).size > 128) {
        entry.directories = [];
        yield* availability(entry, false);
        return;
      }
      entry.revision = probe.revision;
      entry.deadline = probe.nextChangeAt !== undefined && probe.nextChangeAt > now ? probe.nextChangeAt : undefined;
      if (entry.available && (deadlinePassed || prior !== probe.revision))
        yield* callbacks.onInvalidate(entry.resource, probe.revision);
      yield* availability(entry, true);
    });
  const reconcile = Effect.gen(function* () {
    // Includes a modest debounce for atomic rename bursts. A single read follows all hints queued during it.
    yield* Effect.forEach(entries.values(), check, {concurrency: 2, discard: true});
    nextReconcile = entries.size ? (yield* Clock.currentTimeMillis) + 30_000 : Infinity;
    yield* updateWatches;
  }).pipe(gate.withPermit);
  yield* Effect.forever(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const due = Math.min(nextReconcile, ...[...entries.values()].map(entry => entry.deadline ?? Infinity));
      if (Number.isFinite(due)) yield* Effect.race(Queue.take(wake), Effect.sleep(Math.max(1, due - now)));
      else yield* Queue.take(wake);
      yield* Effect.sleep('25 millis');
      yield* reconcile;
    }),
  ).pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() => Queue.shutdown(wake));
  const prune = Effect.gen(function* () {
    const retained = new Map(
      [...connections.values()].flat().map(resource => [managerLiveResourceKey(resource), resource]),
    );
    for (const key of entries.keys()) if (!retained.has(key)) entries.delete(key);
    for (const [key, resource] of retained)
      if (!entries.has(key) && entries.size < 32) entries.set(key, {resource, available: false, directories: []});
    yield* updateWatches;
    if (!entries.size) nextReconcile = Infinity;
    yield* signal;
  });
  return {
    topics,
    subscribe: (connection: string, requested: readonly ManagerLiveResource[]) =>
      Effect.gen(function* () {
        const supported = requested.filter(resource => topics.includes(resource.topic));
        connections.set(connection, supported);
        yield* prune;
        yield* Effect.forEach(
          supported,
          resource => {
            const entry = entries.get(managerLiveResourceKey(resource));
            return entry ? check(entry) : Effect.void;
          },
          {concurrency: 2, discard: true},
        );
        yield* updateWatches;
        return supported.filter(resource => !entries.get(managerLiveResourceKey(resource))?.available);
      }).pipe(gate.withPermit),
    release: (connection: string) =>
      Effect.sync(() => connections.delete(connection)).pipe(Effect.andThen(prune), gate.withPermit),
    invalidate: (resource: ManagerLiveResource, revision: string) =>
      Effect.suspend(() =>
        entries.get(managerLiveResourceKey(resource))?.available
          ? callbacks.onInvalidate(resource, revision)
          : Effect.void,
      ),
    wake: signal,
    hasResource: (resource: ManagerLiveResource) => entries.has(managerLiveResourceKey(resource)),
    reconcileNow: reconcile,
    diagnostics: Effect.sync(() => ({resources: entries.size, connections: connections.size, watches: watches.size})),
  };
});

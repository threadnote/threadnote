import {Array as EffectArray} from 'effect';
import {
  Clock,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Queue,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import {
  managerLiveResourceKey,
  type ManagerLiveResource,
  type ManagerLiveTopic,
} from '@threadnote/manager/live/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  readBoundedProcessRegistrationNames,
  readManageableThreadnoteProcessDiagnostics,
  type ManageableThreadnoteProcessDiagnostics,
} from '../process/diagnostics.js';
import {observeLiveWorktree} from '@threadnote/graph/live_observation';
import {codeGraphWorksetCatalogLayout} from '@threadnote/graph/workset_catalog/layout';
import {parseSeedManifest} from '@threadnote/workspace/manifest';
import {expandPath} from '@threadnote/platform/paths';
import {CommandExecutor} from '@threadnote/platform/command';
import {observeManagerGraphSources} from './live_graph_observation.js';
import {modelSetupFileIdentity} from '@threadnote/inference/models/setup';

const RECONCILE_MILLISECONDS = 30_000;
const PROCESS_SAMPLE_MILLISECONDS = 3_000;
const MAX_WATCHES = 128;
const MAX_RESOURCES = 32;

type Probe = {readonly revision: string; readonly directories: readonly string[]} | undefined;
export interface ManagerLiveConsumerAdapter {
  readonly topics: readonly ManagerLiveTopic[];
  readonly subscribe: (
    connectionKey: string,
    resources: readonly ManagerLiveResource[],
  ) => Effect.Effect<readonly ManagerLiveResource[], never>;
  readonly release: (connectionKey: string) => Effect.Effect<void, never>;
  readonly processChanged?: Effect.Effect<void, never>;
  readonly processAvailability?: (available: boolean) => Effect.Effect<void, never>;
}
type Entry = {
  readonly resource: ManagerLiveResource;
  available: boolean;
  revision?: string;
  directories: readonly string[];
  needsRecovery?: boolean;
};

/** A live topic is listed only when this broker has complete owner coverage. */
export const MANAGER_CONSUMER_OBSERVED_TOPICS: readonly ManagerLiveTopic[] = [
  'share-conflicts',
  'processes',
  'citation-repair-jobs',
  'model-setup',
  'runtime-updates',
  'worksets',
];

export const ManagerLiveConsumerChangeHints = Context.Reference<{
  readonly publish: (resource: ManagerLiveResource) => Effect.Effect<void, never>;
}>('threadnote/ManagerLiveConsumerChangeHints', {
  defaultValue: () => ({publish: () => Effect.void}),
});

/** Scoped and coalesced observer for cheap durable metadata and one OS liveness sample. */
export const makeManagerLiveConsumerObservation = Effect.fn('manager.consumerLive.observe')(function* (
  config: RuntimeConfig,
  callbacks: {
    readonly onInvalidate: (resource: ManagerLiveResource, revision: string) => Effect.Effect<void, never>;
    readonly onAvailability: (resource: ManagerLiveResource, available: boolean) => Effect.Effect<void, never>;
  },
  options: {
    readonly modelPaths?: readonly [string, string, string];
    readonly runtimePaths?: readonly [string, string];
    readonly adapters?: readonly ManagerLiveConsumerAdapter[];
    readonly watchLimit?: number;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* Effect.context<FileSystem.FileSystem | Path.Path | SystemInfo | CommandExecutor>();
  const scope = yield* Scope.Scope;
  const gate = yield* Semaphore.make(1);
  const wake = yield* Queue.dropping<void>(1);
  const signal = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  const entries = new Map<string, Entry>();
  const connections = new Map<string, readonly ManagerLiveResource[]>();
  const watches = new Map<string, Fiber.Fiber<void>>();
  let nextPeriodic = 0;
  let nextProcess = 0;
  let hinted = false;
  let changeSequence = 0;
  let processSnapshot: ManageableThreadnoteProcessDiagnostics | undefined;
  const topics = EffectArray.filter(
    MANAGER_CONSUMER_OBSERVED_TOPICS,
    topic =>
      (topic !== 'model-setup' || options.modelPaths !== undefined) &&
      (topic !== 'runtime-updates' || options.runtimePaths !== undefined),
  );
  const adapters = options.adapters ?? [];
  const watchLimit = options.watchLimit ?? MAX_WATCHES;
  const allTopics = [...new Set([...topics, ...EffectArray.flatMap(adapters, adapter => adapter.topics)])];

  const statIdentity = (file: string, maximumBytes = 1_048_576) =>
    Effect.gen(function* () {
      const stat = yield* fs.stat(file).pipe(
        Effect.catchIf(
          error => PlatformError.isPlatformError(error) && error.reason._tag === 'NotFound',
          () => Effect.void,
        ),
      );
      if (stat === undefined) return 'absent';
      if (stat.type !== 'File' || Number(stat.size) > maximumBytes)
        return yield* Effect.die(new Error('Unsupported live source'));
      return EffectArray.join(
        EffectArray.map(
          [
            Number(stat.size),
            Option.getOrUndefined(stat.mtime)?.getTime() ?? '',
            Option.getOrUndefined(stat.ino) ?? '',
          ],
          item => (item === null || item === undefined ? '' : String(item)),
        ),
        ':',
      );
    });

  const readBoundedText = (file: string, maximumBytes: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(file, {flag: 'r'});
        const before = yield* handle.stat;
        if (before.type !== 'File' || Number(before.size) > maximumBytes) return undefined;
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (length <= maximumBytes) {
          const chunk = yield* handle.readAlloc(Math.min(64 * 1024, maximumBytes + 1 - length));
          if (Option.isNone(chunk)) break;
          length += chunk.value.length;
          if (length > maximumBytes) return undefined;
          chunks.push(chunk.value);
        }
        const after = yield* handle.stat;
        if (
          Number(after.size) !== Number(before.size) ||
          Option.getOrUndefined(after.mtime)?.getTime() !== Option.getOrUndefined(before.mtime)?.getTime() ||
          length !== Number(before.size)
        )
          return undefined;
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      }),
    );

  const shareProbe = Effect.gen(function* () {
    const directory = path.join(config.agentContextHome, 'share');
    const teams = path.join(directory, 'teams.json');
    const pending = path.join(directory, 'auto-sync-pending-reindexes.json');
    const teamIdentity = yield* statIdentity(teams);
    const pendingIdentity = yield* statIdentity(pending);
    return {
      revision: sha256HexSync(JSON.stringify([teamIdentity, pendingIdentity])),
      directories: [directory],
    } satisfies Probe;
  });

  const processProbe = Effect.gen(function* () {
    const directory = path.join(config.agentContextHome, 'runtime', 'processes');
    const names = yield* readBoundedProcessRegistrationNames(directory);
    if (names.truncated) return undefined;
    const snapshot = yield* readManageableThreadnoteProcessDiagnostics(config);
    if (snapshot.truncated) return undefined;
    processSnapshot = snapshot;
    // Age and RSS are display clocks, not process membership or action state.
    const revision = sha256HexSync(
      JSON.stringify(
        EffectArray.map(snapshot.processes, process => ({
          activityRole: process.activityRole,
          currentOperation: process.currentOperation,
          parentProcessId: process.parentProcessId,
          processId: process.processId,
          processRef: process.processRef,
          releaseVersion: process.releaseVersion,
          role: process.role,
          startedAt: process.startedAt,
          terminable: process.terminable,
          terminationBlockedReason: process.terminationBlockedReason,
        })),
      ),
    );
    return {revision, directories: [directory]} satisfies Probe;
  });

  const modelProbe = Effect.gen(function* () {
    if (!options.modelPaths) return undefined;
    const artifact = options.modelPaths[2];
    const artifactExists = yield* fs.exists(artifact);
    const artifactIdentity = artifactExists ? yield* modelSetupFileIdentity(artifact) : undefined;
    if (artifactExists && artifactIdentity === undefined) return undefined;
    const identities = [
      yield* statIdentity(options.modelPaths[0]),
      yield* statIdentity(options.modelPaths[1]),
      artifactIdentity ?? 'absent',
    ];
    return {
      revision: sha256HexSync(JSON.stringify(identities)),
      directories: [...new Set(EffectArray.map(options.modelPaths, file => path.dirname(file)))],
    } satisfies Probe;
  });

  const runtimeProbe = Effect.gen(function* () {
    if (!options.runtimePaths) return undefined;
    const identities = yield* Effect.forEach(options.runtimePaths, file => statIdentity(file));
    return {
      revision: sha256HexSync(JSON.stringify(identities)),
      directories: [...new Set(EffectArray.map(options.runtimePaths, file => path.dirname(file)))],
    } satisfies Probe;
  });

  const worksetProbe = Effect.gen(function* () {
    const manifestIdentity = yield* statIdentity(config.manifestPath);
    if (manifestIdentity === 'absent') return undefined;
    const raw = yield* readBoundedText(config.manifestPath, 1_048_576);
    if (raw === undefined) return undefined;
    const manifest = parseSeedManifest(raw, config.manifestPath);
    // A bounded passive worktree observation is required by the status GET's
    // stale/current classification. Larger accounts retain the REST fallback.
    if (manifest.projects.length > 8) return undefined;
    const worktrees = yield* Effect.forEach(
      manifest.projects,
      project =>
        Effect.gen(function* () {
          const cwd = yield* expandPath(project.path);
          const observation = yield* observeLiveWorktree(cwd, {
            timeoutMs: 3_000,
            maxGitOutputBytes: 131_072,
            maxChangedFiles: 64,
            maxReadBytes: 1_048_576,
          });
          return {cwd, observation};
        }),
      {concurrency: 2},
    );
    if (EffectArray.some(worktrees, ({observation}) => observation.state !== 'complete')) return undefined;
    const graph = yield* observeManagerGraphSources(config);
    const catalog = codeGraphWorksetCatalogLayout(path, config.agentContextHome);
    const database = yield* statIdentity(catalog.databasePath, Infinity);
    const wal = yield* statIdentity(catalog.databasePath + '-wal', Infinity);
    const directorySet = new Set([
      path.dirname(config.manifestPath),
      catalog.root,
      ...graph.directories,
      ...EffectArray.flatMap(worktrees, ({cwd, observation}) =>
        observation.state === 'complete' ? [cwd, ...observation.watchDirectories] : [],
      ),
    ]);
    if (directorySet.size > MAX_WATCHES) return undefined;
    return {
      revision: sha256HexSync(
        JSON.stringify([
          manifestIdentity,
          database,
          wal,
          graph.revision,
          EffectArray.map(worktrees, ({observation}) => (observation.state === 'complete' ? observation.revision : '')),
        ]),
      ),
      directories: [...directorySet],
    } satisfies Probe;
  });

  const probe = (resource: ManagerLiveResource) =>
    resource.topic === 'share-conflicts'
      ? shareProbe
      : resource.topic === 'processes'
        ? processProbe
        : resource.topic === 'model-setup'
          ? modelProbe
          : resource.topic === 'runtime-updates'
            ? runtimeProbe
            : resource.topic === 'worksets'
              ? worksetProbe
              : Effect.die(new Error('Unsupported observer resource'));
  const availability = (entry: Entry, available: boolean) =>
    Effect.gen(function* () {
      if (entry.available === available) return;
      entry.available = available;
      yield* callbacks.onAvailability(entry.resource, available);
    });
  const desiredWatchDirectories = (candidate?: Entry, directories: readonly string[] = []) =>
    Effect.gen(function* () {
      const desired = new Set<string>();
      if (entries.size > 0) desired.add(config.agentContextHome);
      for (const entry of entries.values()) {
        const sources = entry === candidate ? directories : entry.available ? entry.directories : [];
        for (const directory of sources) desired.add(directory);
      }
      for (const directory of [...desired]) {
        let ancestor = directory;
        while (
          !(yield* fs.exists(ancestor).pipe(Effect.orElseSucceed(() => false))) &&
          path.dirname(ancestor) !== ancestor
        )
          ancestor = path.dirname(ancestor);
        desired.add(ancestor);
      }
      return desired;
    });
  const reportProcessCoverage = (available: boolean, changed: boolean) =>
    Effect.gen(function* () {
      for (const adapter of adapters) {
        yield* adapter.processAvailability?.(available) ?? Effect.void;
        if (available && changed) yield* adapter.processChanged ?? Effect.void;
      }
    });
  const check = (entry: Entry) =>
    Effect.gen(function* () {
      const result = yield* probe(entry.resource).pipe(
        Effect.provide(environment),
        Effect.timeoutOption('10 seconds'),
        Effect.catchCause(() => Effect.succeedNone),
      );
      if (entries.get(managerLiveResourceKey(entry.resource)) !== entry) return;
      const observed = Option.getOrUndefined(result);
      if (observed === undefined) {
        if (entry.resource.topic === 'processes') processSnapshot = undefined;
        entry.directories = [];
        entry.needsRecovery = true;
        yield* availability(entry, false);
        if (entry.resource.topic === 'processes') yield* reportProcessCoverage(false, false);
        return;
      }
      const desired = yield* desiredWatchDirectories(entry, observed.directories);
      if (desired.size > watchLimit) {
        entry.directories = [];
        entry.needsRecovery = true;
        yield* availability(entry, false);
        if (entry.resource.topic === 'processes') yield* reportProcessCoverage(false, false);
        return;
      }
      entry.directories = observed.directories;
      const prior = entry.revision;
      const wasAvailable = entry.available;
      const needsRecovery = entry.needsRecovery === true;
      entry.revision = observed.revision;
      entry.needsRecovery = false;
      if (entry.available && prior !== observed.revision)
        yield* callbacks.onInvalidate(entry.resource, observed.revision);
      yield* availability(entry, true);
      if (entry.resource.topic === 'processes')
        yield* reportProcessCoverage(true, needsRecovery || (wasAvailable && prior !== observed.revision));
    });

  const watchDirectory = (directory: string) =>
    Effect.forever(
      fs.watch(directory, {recursive: false}).pipe(
        Stream.runForEach(() =>
          Effect.sync(() => {
            hinted = true;
          }).pipe(Effect.andThen(signal)),
        ),
        Effect.catchCause(() => signal),
        Effect.andThen(Effect.sleep('2 seconds')),
      ),
    );
  const updateWatches = Effect.gen(function* () {
    const desired = yield* desiredWatchDirectories();
    for (const [directory, fiber] of watches) {
      if (desired.has(directory)) continue;
      watches.delete(directory);
      yield* Fiber.interrupt(fiber);
    }
    for (const directory of desired) {
      if (watches.has(directory)) continue;
      watches.set(directory, yield* watchDirectory(directory).pipe(Effect.forkIn(scope)));
    }
  });
  const admitRetained = Effect.gen(function* () {
    const retained = new Map(
      EffectArray.map([...connections.values()].flat(), resource => [managerLiveResourceKey(resource), resource]),
    );
    for (const key of entries.keys()) if (!retained.has(key)) entries.delete(key);
    const added: Entry[] = [];
    for (const [key, resource] of retained) {
      if (entries.has(key) || entries.size >= MAX_RESOURCES) continue;
      const entry: Entry = {resource, available: false, directories: []};
      entries.set(key, entry);
      added.push(entry);
    }
    for (const entry of added) {
      if (entry.resource.topic === 'citation-repair-jobs') yield* availability(entry, true);
      else yield* check(entry);
    }
    if (
      EffectArray.some([...retained.values()], resource => resource.topic === 'processes') &&
      !entries.has(managerLiveResourceKey({topic: 'processes', scope: 'account'}))
    )
      yield* reportProcessCoverage(false, false);
    yield* updateWatches;
    return new Set(EffectArray.map(added, entry => managerLiveResourceKey(entry.resource)));
  });
  const reconcile = (force = false) =>
    Effect.gen(function* () {
      const added = yield* admitRetained;
      const now = yield* Clock.currentTimeMillis;
      const periodic = now >= nextPeriodic;
      const sampleProcesses = now >= nextProcess;
      const changed = hinted;
      hinted = false;
      if (periodic) nextPeriodic = now + RECONCILE_MILLISECONDS;
      if (sampleProcesses) nextProcess = now + PROCESS_SAMPLE_MILLISECONDS;
      for (const entry of entries.values()) {
        if (added.has(managerLiveResourceKey(entry.resource))) continue;
        if (entry.resource.topic === 'citation-repair-jobs') continue;
        if (
          force ||
          (entry.resource.topic === 'processes' ? sampleProcesses || periodic || changed : periodic || changed)
        )
          yield* check(entry);
      }
      yield* updateWatches;
    }).pipe(gate.withPermit);
  yield* Effect.forever(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const processActive = EffectArray.some([...entries.values()], entry => entry.resource.topic === 'processes');
      const due = Math.min(nextPeriodic, processActive ? nextProcess : Infinity);
      yield* Effect.race(Queue.take(wake), Effect.sleep(Math.max(1, due - now)));
      yield* reconcile();
    }),
  ).pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() => Queue.shutdown(wake));

  return {
    topics: allTopics,
    processSnapshot: Effect.sync(() =>
      entries.get(managerLiveResourceKey({topic: 'processes', scope: 'account'}))?.available
        ? processSnapshot
        : undefined,
    ),
    hints: {
      publish: (resource: ManagerLiveResource) =>
        Effect.gen(function* () {
          const entry = entries.get(managerLiveResourceKey(resource));
          if (!entry || !entry.available) return;
          changeSequence++;
          yield* callbacks.onInvalidate(resource, String(changeSequence));
        }),
    },
    subscribe: (connection: string, requested: readonly ManagerLiveResource[]) =>
      Effect.gen(function* () {
        const supported = EffectArray.filter(
          requested,
          (resource, __effectArrayIndex) => __effectArrayIndex in requested && topics.includes(resource.topic),
        );
        const graphProcessSource =
          EffectArray.some(requested, resource => resource.topic === 'graph-status') &&
          EffectArray.some(adapters, adapter => adapter.processChanged !== undefined)
            ? [{topic: 'processes' as const, scope: 'account' as const}]
            : [];
        const local = [...supported, ...graphProcessSource];
        connections.set(connection, local);
        const added = yield* admitRetained;
        for (const resource of local) {
          const entry = entries.get(managerLiveResourceKey(resource));
          if (
            entry !== undefined &&
            resource.topic !== 'citation-repair-jobs' &&
            !added.has(managerLiveResourceKey(resource))
          )
            yield* check(entry);
        }
        yield* updateWatches;
        yield* signal;
        const externalUnavailable = yield* Effect.forEach(adapters, adapter =>
          adapter.subscribe(connection, requested),
        );
        return [
          ...EffectArray.filter(
            requested,
            (resource, __effectArrayIndex) =>
              __effectArrayIndex in requested &&
              topics.includes(resource.topic) &&
              !entries.get(managerLiveResourceKey(resource))?.available,
          ),
          ...externalUnavailable.flat(),
        ];
      }).pipe(gate.withPermit),
    release: (connection: string) =>
      Effect.sync(() => connections.delete(connection)).pipe(
        Effect.andThen(admitRetained),
        Effect.andThen(Effect.forEach(adapters, adapter => adapter.release(connection), {discard: true})),
        Effect.andThen(signal),
        gate.withPermit,
      ),
    diagnostics: Effect.sync(() => ({connections: connections.size, resources: entries.size, watches: watches.size})),
    reconcileNow: reconcile(true),
  };
});

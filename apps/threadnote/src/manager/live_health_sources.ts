import {Array as EffectArray} from 'effect';
import {
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Queue,
  Scope,
  Stream,
} from 'effect';
import {makeCodeGraphCitationRepositoryRouteObservation} from '@threadnote/graph/citation/recovery';
import {observeLiveWorktree} from '@threadnote/graph/live_observation';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {candidateReviewObservationPaths} from '@threadnote/memory/candidate';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {guidanceHealthObservationPaths} from '../guidance/index.js';
import {makeManagerLive, type ManagerLive, type ManagerLiveOptions} from './live.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const LIMITS = {
  projects: 8,
  sources: 32,
  watches: 128,
  files: 600,
  fileBytes: 16 * 1_048_576,
  totalBytes: 64 * 1_048_576,
};
const RECONCILE_MS = 30_000;

export const makeHealthEnabledManagerLive = Effect.fn('manager.healthLive.connect')(function* (
  config: RuntimeConfig,
  options: Omit<ManagerLiveOptions, 'health'>,
) {
  const liveRef: {current?: ManagerLive} = {};
  const sources = yield* makeManagerHealthLiveSources(config, {
    onInvalidate: (project, revision) =>
      Effect.suspend(
        () => liveRef.current?.publishResource({topic: 'context-health', project}, revision) ?? Effect.void,
      ),
    onAvailability: (project, available) =>
      Effect.suspend(() => liveRef.current?.publishAvailability(project, available) ?? Effect.void),
  });
  const live = yield* makeManagerLive({...options, health: sources});
  liveRef.current = live;
  return {live, healthHints: sources.hints};
});

export interface ManagerHealthObservation {
  readonly cwd: string;
  readonly citations: readonly Pick<MemoryCodeCitationV1, 'repositoryId' | 'sourceCommit'>[];
  readonly nextChangeAt?: number;
}

/** The report registers already-loaded inputs. It never starts a second health scan. */
export const ManagerHealthObservationHints = Context.Reference<{
  readonly register: (project: string, observation: ManagerHealthObservation) => Effect.Effect<void>;
}>('threadnote/ManagerHealthObservationHints', {
  defaultValue: () => ({register: () => Effect.void}),
});

export interface ManagerHealthProbe {
  readonly revision: string;
  readonly directories: readonly string[];
}

interface Registration {
  input?: ManagerHealthObservation;
  identity?: string;
  revision?: string;
  available: boolean;
  dirty: boolean;
  version: number;
  deadline?: number;
  directories: readonly string[];
  cancel: Deferred.Deferred<void>;
}

/** Finite subscription-owned state; a failed observation never means unchanged. */
export const makeManagerHealthLiveRegistry = Effect.fn('manager.healthLive.registry')(function* (options: {
  readonly observe: (project: string, input: ManagerHealthObservation) => Effect.Effect<ManagerHealthProbe | void>;
  readonly onInvalidate: (project: string, revision: string) => Effect.Effect<void>;
  readonly onAvailability: (project: string, available: boolean) => Effect.Effect<void>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  const wake = yield* Queue.dropping<void>(1);
  const connections = new Map<string, readonly string[]>();
  const projects = new Map<string, Registration>();
  const watches = new Map<string, Fiber.Fiber<void>>();
  const signal = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  let nextReconcile = 0;
  const availability = (project: string, entry: Registration, next: boolean) =>
    Effect.gen(function* () {
      if (entry.available === next) return;
      entry.available = next;
      yield* options.onAvailability(project, next);
    });
  const updateWatches = Effect.gen(function* () {
    const desired = new Set(EffectArray.flatMap([...projects.values()], entry => entry.directories));
    if (desired.size > LIMITS.watches) {
      for (const [project, entry] of projects) yield* availability(project, entry, false);
      return;
    }
    for (const [directory, fiber] of watches) {
      if (desired.has(directory)) continue;
      watches.delete(directory);
      yield* Fiber.interrupt(fiber);
    }
    for (const directory of desired) {
      if (watches.has(directory)) continue;
      const dirty = Effect.sync(() => {
        for (const entry of projects.values()) {
          if (!entry.directories.includes(directory)) continue;
          entry.dirty = true;
          entry.version++;
        }
      }).pipe(Effect.andThen(signal));
      const fiber = yield* Effect.forever(
        fs.watch(directory, {recursive: false}).pipe(
          Stream.runForEach(() => dirty),
          Effect.ignoreCause,
          Effect.andThen(Effect.sleep('2 seconds')),
        ),
      ).pipe(Effect.forkIn(scope));
      watches.set(directory, fiber);
    }
  });
  const reconcile = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const periodic = now >= nextReconcile;
    if (periodic) nextReconcile = now + RECONCILE_MS;
    for (const [project, entry] of projects) {
      if (entry.deadline !== undefined && entry.deadline <= now) {
        entry.deadline = undefined;
        yield* options.onInvalidate(project, `clock:${now}`);
      }
    }
    yield* Effect.forEach(
      [...projects],
      ([project, entry]) =>
        Effect.gen(function* () {
          if (entry.input === undefined || (!entry.dirty && !periodic)) return;
          const version = entry.version;
          const result = yield* options.observe(project, entry.input).pipe(
            Effect.raceFirst(Deferred.await(entry.cancel).pipe(Effect.as(undefined))),
            Effect.timeoutOption('20 seconds'),
            Effect.map(Option.getOrUndefined),
            Effect.catchCause(() => Effect.void),
          );
          if (projects.get(project) !== entry || entry.version !== version) return;
          entry.dirty = false;
          if (!result) {
            yield* availability(project, entry, false);
            return;
          }
          entry.directories = result.directories;
          const allDirectories = new Set(EffectArray.flatMap([...projects.values()], value => value.directories));
          if (allDirectories.size > LIMITS.watches) {
            entry.directories = [];
            yield* availability(project, entry, false);
            return;
          }
          const prior = entry.revision;
          entry.revision = result.revision;
          if (entry.available && prior !== result.revision) yield* options.onInvalidate(project, result.revision);
          yield* availability(project, entry, true);
        }),
      {concurrency: 2, discard: true},
    );
    yield* updateWatches;
  });
  yield* Effect.forever(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const nextDeadline = Math.min(
        nextReconcile,
        ...EffectArray.map([...projects.values()], entry => entry.deadline ?? Infinity),
      );
      yield* Effect.race(Queue.take(wake), Effect.sleep(Math.max(1, nextDeadline - now)));
      yield* reconcile;
    }),
  ).pipe(Effect.forkScoped);
  yield* Effect.addFinalizer(() => Queue.shutdown(wake));

  const prune = Effect.gen(function* () {
    const retained = new Set([...connections.values()].flat());
    for (const [project, entry] of projects) {
      if (retained.has(project)) continue;
      projects.delete(project);
      yield* Deferred.succeed(entry.cancel, undefined);
    }
    // A previously over-budget subscriber can recover when another tab releases capacity.
    for (const project of retained) {
      if (projects.has(project) || projects.size >= LIMITS.projects) continue;
      projects.set(project, {
        available: false,
        dirty: true,
        version: 0,
        directories: [],
        cancel: Deferred.makeUnsafe<void>(),
      });
    }
    yield* updateWatches;
    yield* signal;
  });
  return {
    subscribe: (connection: string, requested: readonly string[]) =>
      Effect.gen(function* () {
        connections.set(connection, [...new Set(requested)]);
        yield* prune;
        yield* signal;
        return EffectArray.filter(requested, project => !projects.get(project)?.available);
      }),
    release: (connection: string) => Effect.sync(() => connections.delete(connection)).pipe(Effect.andThen(prune)),
    hints: {
      register: (project: string, input: ManagerHealthObservation) =>
        Effect.gen(function* () {
          const entry = projects.get(project);
          if (entry === undefined) return;
          const citations = [
            ...new Map(
              EffectArray.map(input.citations, citation => [
                `${citation.repositoryId}:${citation.sourceCommit}`,
                citation,
              ]),
            ).values(),
          ].sort((a, b) =>
            Effect2.pipe(
              `${a.repositoryId}:${a.sourceCommit}`,
              EffectString.localeCompare(`${b.repositoryId}:${b.sourceCommit}`),
            ),
          );
          const identity = JSON.stringify([input.cwd, citations]);
          entry.deadline = input.nextChangeAt;
          if (entry.identity !== identity) {
            yield* Deferred.succeed(entry.cancel, undefined);
            entry.cancel = Deferred.makeUnsafe<void>();
            entry.input = {...input, citations};
            entry.identity = identity;
            entry.dirty = true;
            entry.version++;
            yield* availability(project, entry, false);
          }
          yield* signal;
        }),
    },
    diagnostics: Effect.sync(() => ({projects: projects.size, connections: connections.size, watches: watches.size})),
  };
});

/** Reads only registered health sources; revisions are invalidation hints, never write proofs. */
export const makeManagerHealthLiveSources = Effect.fn('manager.healthLive.sources')(function* (
  config: RuntimeConfig,
  callbacks: Pick<Parameters<typeof makeManagerHealthLiveRegistry>[0], 'onInvalidate' | 'onAvailability'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const query = yield* CodeGraphQueryService;
  const environment = yield* Effect.context<
    | Crypto.Crypto
    | Effect.Services<ReturnType<typeof observeLiveWorktree>>
    | Effect.Services<ReturnType<typeof guidanceHealthObservationPaths>>
    | Effect.Services<ReturnType<typeof makeCodeGraphCitationRepositoryRouteObservation>>
  >();
  const observe = (project: string, input: ManagerHealthObservation) =>
    Effect.gen(function* () {
      if (input.citations.length > LIMITS.sources) return undefined;
      const canonicalCwd = yield* fs.realPath(input.cwd);
      const resolve = yield* makeCodeGraphCitationRepositoryRouteObservation({
        threadnoteHome: config.agentContextHome,
        callerCwd: canonicalCwd,
      });
      const routes = yield* Effect.forEach(input.citations, citation => resolve(citation), {concurrency: 2});
      // The resolver deliberately stops at its verified preferred caller and
      // labels global discovery incomplete. That one selected route is fully
      // observable here; incomplete discovery without it must use fallback.
      if (
        EffectArray.some(
          routes,
          route =>
            !route.complete &&
            !(route.routes.length === 1 && !route.ambiguous && route.routes[0].identity.repoRoot === canonicalCwd),
        )
      )
        return undefined;
      const roots = [
        ...new Set([
          canonicalCwd,
          ...EffectArray.flatMap(routes, route => EffectArray.map(route.routes, value => value.identity.repoRoot)),
        ]),
      ].sort();
      if (roots.length > LIMITS.sources) return undefined;
      const directories = new Set<string>();
      const revisions: unknown[] = [
        EffectArray.map(routes, route => [
          route.generation,
          EffectArray.map(route.routes, value => value.identity.repoRoot),
        ]),
      ];
      for (const root of roots) {
        const worktree = yield* observeLiveWorktree(root);
        if (worktree.state !== 'complete') return undefined;
        directories.add(root);
        for (const directory of worktree.watchDirectories) directories.add(directory);
        const status = yield* query.status(config.agentContextHome, root, {
          manifestPath: config.manifestPath,
          ...(root === canonicalCwd ? {project} : {}),
          observeWorktree: false,
          requestMaintenance: false,
        });
        revisions.push([
          root,
          worktree.revision,
          status.identity,
          status.readySnapshot,
          status.languagePacks,
          status.projectCoverage,
          status.freshness,
          status.stale,
        ]);
      }
      const candidates = yield* candidateReviewObservationPaths(config.agentContextHome);
      if (candidates.state !== 'ready') return undefined;
      directories.add(candidates.directory);
      const guidance = yield* guidanceHealthObservationPaths(config, project, input.cwd);
      const files = [
        ...new Set([
          ...candidates.files,
          ...EffectArray.flatMap(guidance, row => [row.targetPath, ...row.receiptPaths]),
          path.join(
            config.agentContextHome,
            'context-maintenance',
            'evidence',
            `${sha256HexSync(`${project}\0${input.cwd}`)}.json`,
          ),
        ]),
      ].sort();
      if (files.length > LIMITS.files) return undefined;
      let spent = 0;
      for (const file of files) {
        directories.add(path.dirname(file));
        const identity = yield* Effect.scoped(
          Effect.gen(function* () {
            const stat = yield* fs.stat(file).pipe(
              Effect.catchIf(
                error => PlatformError.isPlatformError(error) && error.reason._tag === 'NotFound',
                () => Effect.void,
              ),
            );
            if (stat === undefined) return 'absent';
            const size = Number(stat.size);
            if (stat.type !== 'File' || size > LIMITS.fileBytes || size + spent > LIMITS.totalBytes) return undefined;
            // A bounded descriptor read prevents a concurrent append from allocating beyond the budget.
            const handle = yield* fs.open(file, {flag: 'r'});
            const bytes = new Uint8Array(size + 1);
            let offset = 0;
            while (offset < bytes.length) {
              const count = Number(yield* handle.read(bytes.subarray(offset)));
              if (count === 0) break;
              offset += count;
            }
            const after = yield* fs.stat(file);
            if (
              offset !== size ||
              after.size !== stat.size ||
              Option.getOrUndefined(after.ino) !== Option.getOrUndefined(stat.ino) ||
              Option.getOrUndefined(after.mtime)?.getTime() !== Option.getOrUndefined(stat.mtime)?.getTime()
            )
              return undefined;
            spent += size;
            return sha256HexSync(bytes.subarray(0, size));
          }),
        );
        if (identity === undefined) return undefined;
        revisions.push([file, identity]);
      }
      return {revision: sha256HexSync(JSON.stringify(revisions)), directories: [...directories]};
    }).pipe(
      Effect.provide(environment),
      Effect.catchCause(() => Effect.void),
    );
  return yield* makeManagerHealthLiveRegistry({...callbacks, observe});
});

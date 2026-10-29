import {Context, Crypto, Effect, FileSystem, Option, Path, PlatformError, Queue, Ref, Result, Stream} from 'effect';
import {resourceAccountMutationGenerationPath} from '@threadnote/store/resource/lock';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import {readSettledCanonicalMutationGeneration} from '@threadnote/store/resource/settled_revision';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

export type ManagerObservedTopic = 'context-health' | 'context-maintenance';

export interface ManagerLiveChangeHintsService {
  readonly canonical: Effect.Effect<void, never>;
  readonly maintenance: Effect.Effect<void, never>;
}

const NOOP_HINTS: ManagerLiveChangeHintsService = {
  canonical: Effect.void,
  maintenance: Effect.void,
};

/** Optional post-durable hooks. Non-Manager writers use the no-op default. */
export const ManagerLiveChangeHints = Context.Reference<ManagerLiveChangeHintsService>(
  'threadnote/ManagerLiveChangeHints',
  {defaultValue: () => NOOP_HINTS},
);

export interface ManagerLiveSourceDiagnostics {
  readonly canonicalDirty: boolean;
  readonly canonicalRevision: string | undefined;
  readonly canonicalFenceAttempts: number;
  readonly canonicalFenceFailures: number;
  readonly maintenanceRevision: string | undefined;
  readonly watchRestarts: number;
}

interface CanonicalState {
  readonly observed: string | undefined;
  readonly dirty: boolean;
  readonly hintSequence: number;
  readonly fenceAttempts: number;
  readonly fenceFailures: number;
}

/**
 * A small, independently testable state machine. Only its caller runs reconcile;
 * hints can arrive concurrently. A failed fence, or a hint during an in-flight
 * fence, leaves the source dirty even when the raw marker is unchanged.
 */
export const makeCanonicalRevisionObservation = Effect.fn('managerLive.makeCanonicalRevisionObservation')(function* <
  RH,
  RS,
>(
  readHint: Effect.Effect<string, unknown, RH>,
  readSettled: Effect.Effect<string, unknown, RS>,
  publish: (revision: string) => Effect.Effect<void, never>,
) {
  const state = yield* Ref.make<CanonicalState>({
    observed: undefined,
    dirty: true,
    hintSequence: 0,
    fenceAttempts: 0,
    fenceFailures: 0,
  });
  const hint = Ref.update(state, current => ({
    ...current,
    dirty: true,
    hintSequence: current.hintSequence + 1,
  }));
  const reconcile = Effect.gen(function* () {
    const raw = yield* readHint.pipe(Effect.result);
    if (Result.isFailure(raw)) {
      yield* Ref.update(state, current => ({...current, dirty: true}));
      return;
    }
    yield* Ref.update(state, current => (current.observed !== raw.success ? {...current, dirty: true} : current));
    const before = yield* Ref.get(state);
    if (!before.dirty) return;
    yield* Ref.update(state, current => ({...current, fenceAttempts: current.fenceAttempts + 1}));
    const settled = yield* readSettled.pipe(Effect.result);
    if (Result.isFailure(settled)) {
      yield* Ref.update(state, current => ({...current, dirty: true, fenceFailures: current.fenceFailures + 1}));
      return;
    }
    // A failed initial fence can outlive subscriber bootstrap. Its first
    // eventual success must invalidate that potentially stale REST snapshot.
    if (before.observed !== settled.success) {
      const delivered = yield* publish(settled.success).pipe(Effect.result);
      if (Result.isFailure(delivered)) {
        yield* Ref.update(state, current => ({...current, dirty: true}));
        return;
      }
    }
    yield* Ref.update(state, current => ({
      ...current,
      observed: settled.success,
      dirty: current.hintSequence !== before.hintSequence,
    }));
  });
  return {hint, reconcile, state: Ref.get(state)} as const;
});

export interface ManagerLiveSourcesOptions {
  readonly home: string;
  readonly account: string;
  readonly maintenanceStatePath: string;
  readonly manifestPath?: string;
  readonly onScopeChange?: Effect.Effect<void, never>;
  readonly onInvalidate: (topics: readonly ManagerObservedTopic[], revision: string) => Effect.Effect<void, never>;
}

export const makeManagerLiveSources = Effect.fn('managerLive.makeSources')(function* (
  options: ManagerLiveSourcesOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const canonicalPath = resourceAccountMutationGenerationPath(path, options.home, options.account);
  const canonical = yield* makeCanonicalRevisionObservation(
    readCanonicalMutationGeneration(fs, path, options.home, options.account),
    readSettledCanonicalMutationGeneration(fs, path, options.home, options.account),
    revision => options.onInvalidate(['context-health', 'context-maintenance'], revision),
  );
  const maintenanceRevision = yield* Ref.make<string | undefined>(undefined);
  let initialReconcileComplete = false;
  // These writers atomically replace files independently
  // of canonical memory mutations. Stat only these registered locations.
  const metadataSources = [
    {file: path.join(options.home, 'threadnote', 'semantic-reviews', 'v1.json'), scope: false},
    ...(options.manifestPath ? [{file: options.manifestPath, scope: true}] : []),
  ];
  const metadataRevisions = new Map<string, string>();
  const watchRestarts = yield* Ref.make(0);
  const wake = yield* Queue.dropping<void>(1);
  const signal = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  const hints: ManagerLiveChangeHintsService = {
    canonical: canonical.hint.pipe(Effect.andThen(signal)),
    maintenance: signal,
  };

  const reconcileMaintenance = Effect.gen(function* () {
    // Atomic rename changes the inode even when payload size and timestamp
    // coincide. Missing files have a stable revision and are retried cheaply.
    const stat = yield* fs.stat(options.maintenanceStatePath).pipe(
      Effect.catchIf(
        error => PlatformError.isPlatformError(error) && error.reason._tag === 'NotFound',
        () => Effect.void,
      ),
    );
    const identity =
      stat !== undefined
        ? `${Number(stat.size)}:${Option.getOrUndefined(stat.mtime)?.getTime() ?? ''}:${Option.getOrUndefined(stat.ino) ?? ''}`
        : 'absent';
    const revision = EffectArray.join(
      Array.from(yield* crypto.digest('SHA-256', new TextEncoder().encode(identity)), byte =>
        Effect2.pipe(byte.toString(16), EffectString.padStart(2, '0')),
      ),
      '',
    );
    const old = yield* Ref.get(maintenanceRevision);
    if ((initialReconcileComplete || old !== undefined) && old !== revision) {
      yield* options.onInvalidate(['context-maintenance', 'context-health'], revision);
    }
    yield* Ref.set(maintenanceRevision, revision);
  });

  const reconcileMetadata = Effect.forEach(
    metadataSources,
    source =>
      Effect.gen(function* () {
        const stat = yield* fs.stat(source.file).pipe(
          Effect.catchIf(
            error => PlatformError.isPlatformError(error) && error.reason._tag === 'NotFound',
            () => Effect.void,
          ),
        );
        const revision =
          stat === undefined
            ? 'absent'
            : `${Number(stat.size)}:${Option.getOrUndefined(stat.mtime)?.getTime() ?? ''}:${Option.getOrUndefined(stat.ino) ?? ''}`;
        const prior = metadataRevisions.get(source.file);
        if (initialReconcileComplete && prior !== revision) {
          if (source.scope) yield* options.onScopeChange ?? Effect.void;
          yield* options.onInvalidate(['context-health', 'context-maintenance'], revision);
        }
        metadataRevisions.set(source.file, revision);
      }).pipe(Effect.ignore),
    {discard: true},
  );

  // A transient maintenance I/O error is not evidence of an absent state.
  // Preserve the previous revision and retry on the next wake or interval.
  const reconcile = canonical.reconcile.pipe(
    Effect.andThen(reconcileMaintenance.pipe(Effect.ignore)),
    Effect.andThen(reconcileMetadata),
    Effect.ignore,
  );
  // Establish both baselines before consumers can subscribe. Failure to get
  // the account lock remains dirty; the background loop keeps retrying.
  yield* reconcile;
  initialReconcileComplete = true;

  const observeDirectory = (file: string, onEvent: Effect.Effect<void, never>) =>
    Effect.forever(
      fs.watch(path.dirname(file), {recursive: false}).pipe(
        Stream.filter(event => {
          const name = path.basename(event.path);
          const target = path.basename(file);
          return name === target || Effect2.pipe(name, EffectString.startsWith(`${target}.`));
        }),
        Stream.runForEach(() => onEvent),
        Effect.catchCause(() => Ref.update(watchRestarts, count => count + 1)),
        Effect.andThen(Effect.sleep('2 seconds')),
      ),
    );
  yield* observeDirectory(canonicalPath, hints.canonical).pipe(Effect.forkScoped);
  yield* observeDirectory(options.maintenanceStatePath, hints.maintenance).pipe(Effect.forkScoped);
  for (const source of metadataSources) yield* observeDirectory(source.file, signal).pipe(Effect.forkScoped);
  yield* Effect.forever(Effect.race(Queue.take(wake), Effect.sleep('2 seconds')).pipe(Effect.andThen(reconcile))).pipe(
    Effect.forkScoped,
  );

  return {
    hints,
    diagnostics: Effect.all({
      canonical: canonical.state,
      maintenanceRevision: Ref.get(maintenanceRevision),
      watchRestarts: Ref.get(watchRestarts),
    }).pipe(
      Effect.map(
        ({canonical: state, maintenanceRevision: maintenance, watchRestarts: restarts}) =>
          ({
            canonicalDirty: state.dirty,
            canonicalRevision: state.observed,
            canonicalFenceAttempts: state.fenceAttempts,
            canonicalFenceFailures: state.fenceFailures,
            maintenanceRevision: maintenance,
            watchRestarts: restarts,
          }) satisfies ManagerLiveSourceDiagnostics,
      ),
    ),
  } as const;
});

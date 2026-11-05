import {Array as EffectArray} from 'effect';
import {Clock, Context, Effect, FileSystem, Option, Path, Predicate} from 'effect';
import {
  canonicalMutationInvalidationIsCurrent,
  type CanonicalMutationGenerationTransition,
} from '@threadnote/store/resource/mutation_generation';
import {withExclusiveFileLock, type ExclusiveFileLockOptions} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {mergeRecallIndexCanonicalMutationContinuity} from './freshness.js';
import {stripRecallAnchor} from './lexical.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const RECALL_STALE_MARKER_VERSION = 1;
const MAX_RECALL_INVALIDATED_URIS = 1_024;
let staleMarkerGenerationCounter = 0;

interface PublicationFence {
  readonly lockPath: string;
  readonly admissionAccount?: string;
  active: boolean;
}
const CurrentPublicationFence = Context.Reference<PublicationFence | undefined>('threadnote/RecallPublicationFence', {
  defaultValue: () => undefined,
});

export const recallPublicationFenceHeld = (lockPath: string) =>
  Effect.gen(function* () {
    const fence = yield* CurrentPublicationFence;
    if (!fence?.active) return false;
    const fs = yield* FileSystem.FileSystem;
    const canonicalLockPath = yield* fs.realPath(lockPath).pipe(Effect.option);
    return Option.isSome(canonicalLockPath) && fence.lockPath === canonicalLockPath.value;
  });

/** Mint only under the real lexical lock; descendants lose authority when its scope ends. */
export function withRecallPublicationLock<A, E, R>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  options: ExclusiveFileLockOptions,
  effect: Effect.Effect<A, E, R>,
  admissionAccount?: string,
) {
  return withExclusiveFileLock(
    fs,
    lockPath,
    options,
    Effect.acquireUseRelease(
      fs.realPath(lockPath).pipe(
        Effect.map((canonicalLockPath): PublicationFence => ({
          lockPath: canonicalLockPath,
          admissionAccount,
          active: true,
        })),
      ),
      fence => effect.pipe(Effect.provideService(CurrentPublicationFence, fence)),
      fence =>
        Effect.sync(() => {
          fence.active = false;
        }),
    ),
  );
}

function withStaleMarkerPublication<A, E, R>(
  fs: FileSystem.FileSystem,
  databasePath: string,
  transition: CanonicalMutationGenerationTransition | undefined,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = path.dirname(path.dirname(path.dirname(databasePath)));
    const lockPath = path.join(home, 'locks', 'indexes', 'lexical', `${path.basename(databasePath)}.lock`);
    const fence = yield* CurrentPublicationFence;
    const held = yield* recallPublicationFenceHeld(lockPath);
    // Refresh owns the lexical lock already. Native commits additionally prove a real canonical mutation.
    if (
      held &&
      fence !== undefined &&
      (fence.admissionAccount === undefined ||
        (yield* canonicalMutationInvalidationIsCurrent(home, fence.admissionAccount, transition)))
    )
      return yield* effect;
    return yield* withRecallPublicationLock(
      fs,
      lockPath,
      {
        category: 'recall-index',
        heartbeatIntervalMilliseconds: 10_000,
        retryIntervalMilliseconds: 100,
        staleAfterMilliseconds: 60_000,
        // Marker publication stays prompt; account -> lexical must never wait.
        waitTimeoutMilliseconds: 0,
      },
      effect,
    );
  });
}

export interface RecallStaleMarker {
  readonly canonicalMutationGeneration?: string;
  readonly forceRefresh: boolean;
  readonly generation: string;
  readonly invalidatedUris: readonly string[];
  readonly previousCanonicalMutationGeneration?: string;
  readonly version: typeof RECALL_STALE_MARKER_VERSION;
}

export function readRecallStaleMarker(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<RecallStaleMarker | undefined, never> {
  return Effect.gen(function* () {
    const stalePath = `${path}.stale`;
    if (!(yield* fs.exists(stalePath).pipe(Effect.orElseSucceed(() => false)))) {
      return undefined;
    }
    const raw = yield* fs.readFileString(stalePath).pipe(Effect.orElseSucceed(() => 'present'));
    const legacyGeneration = Effect2.pipe(raw, EffectString.trim) || 'present';
    const value = Option.getOrUndefined(Option.liftThrowable((content: string): unknown => JSON.parse(content))(raw));
    const marker = toRecallStaleMarker(value);
    if (marker !== undefined) {
      return {
        ...(marker.canonicalMutationGeneration === undefined
          ? {}
          : {canonicalMutationGeneration: marker.canonicalMutationGeneration}),
        forceRefresh: marker.forceRefresh,
        generation: marker.generation,
        invalidatedUris: [...new Set(EffectArray.map(marker.invalidatedUris, stripRecallAnchor))],
        ...(marker.previousCanonicalMutationGeneration === undefined
          ? {}
          : {previousCanonicalMutationGeneration: marker.previousCanonicalMutationGeneration}),
        version: RECALL_STALE_MARKER_VERSION,
      };
    }
    return {
      forceRefresh: true,
      generation: legacyGeneration,
      invalidatedUris: [],
      version: RECALL_STALE_MARKER_VERSION,
    };
  });
}

function toRecallStaleMarker(value: unknown): RecallStaleMarker | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const record = value;
  if (
    record.version !== RECALL_STALE_MARKER_VERSION ||
    typeof record.generation !== 'string' ||
    record.generation.length === 0 ||
    typeof record.forceRefresh !== 'boolean' ||
    !EffectArray.isArray(record.invalidatedUris) ||
    !EffectArray.every(record.invalidatedUris, uri => typeof uri === 'string') ||
    (record.canonicalMutationGeneration !== undefined && typeof record.canonicalMutationGeneration !== 'string') ||
    (record.previousCanonicalMutationGeneration !== undefined &&
      typeof record.previousCanonicalMutationGeneration !== 'string')
  ) {
    return undefined;
  }
  return {
    ...(record.canonicalMutationGeneration === undefined
      ? {}
      : {canonicalMutationGeneration: record.canonicalMutationGeneration}),
    forceRefresh: record.forceRefresh,
    generation: record.generation,
    invalidatedUris: record.invalidatedUris,
    ...(record.previousCanonicalMutationGeneration === undefined
      ? {}
      : {previousCanonicalMutationGeneration: record.previousCanonicalMutationGeneration}),
    version: RECALL_STALE_MARKER_VERSION,
  };
}

const writeRecallStaleGenerationUnlocked = Effect.fn('recall.writeStaleGeneration')(function* (
  fs: FileSystem.FileSystem,
  path: string,
  invalidatedUris?: readonly string[],
  canonicalMutationGeneration?: CanonicalMutationGenerationTransition,
) {
  const system = yield* SystemInfo;
  const counter = yield* nextStaleMarkerGenerationCounter;
  const generation = `${yield* Clock.currentTimeMillis}:${system.processId}:${counter}`;
  const stalePath = `${path}.stale`;
  const previous = yield* readRecallStaleMarker(fs, path);
  const mergedInvalidatedUris = [
    ...new Set(
      EffectArray.filter(
        EffectArray.map(
          EffectArray.map([...(previous?.invalidatedUris ?? []), ...(invalidatedUris ?? [])], stripRecallAnchor),
          uri => Effect2.pipe(uri, EffectString.replace(/\/+$/, '')),
        ),
        Boolean,
      ),
    ),
  ];
  const previousHasPendingInvalidations =
    previous !== undefined && (previous.forceRefresh || previous.invalidatedUris.length > 0);
  const mutationContinuity = mergeRecallIndexCanonicalMutationContinuity(
    previous === undefined
      ? undefined
      : {
          ...(previous.canonicalMutationGeneration === undefined
            ? {}
            : {currentGeneration: previous.canonicalMutationGeneration}),
          pending: previousHasPendingInvalidations,
          ...(previous.previousCanonicalMutationGeneration === undefined
            ? {}
            : {previousGeneration: previous.previousCanonicalMutationGeneration}),
        },
    canonicalMutationGeneration,
  );
  const forceRefresh =
    invalidatedUris === undefined ||
    previous?.forceRefresh === true ||
    mergedInvalidatedUris.length > MAX_RECALL_INVALIDATED_URIS ||
    !mutationContinuity.continuous;
  const marker: RecallStaleMarker = {
    ...(mutationContinuity.currentGeneration === undefined
      ? {}
      : {canonicalMutationGeneration: mutationContinuity.currentGeneration}),
    forceRefresh,
    generation,
    invalidatedUris: forceRefresh ? [] : mergedInvalidatedUris,
    ...(mutationContinuity.previousGeneration === undefined
      ? {}
      : {previousCanonicalMutationGeneration: mutationContinuity.previousGeneration}),
    version: RECALL_STALE_MARKER_VERSION,
  };
  const temporaryPath = `${stalePath}.${system.processId}.${counter}.tmp`;
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(marker)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, stalePath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
  return generation;
});

const clearRecallStaleMarkerInvalidationsUnlocked = Effect.fn('recall.clearStaleMarkerInvalidations')(function* (
  fs: FileSystem.FileSystem,
  path: string,
  observed: RecallStaleMarker,
) {
  const current = yield* readRecallStaleMarker(fs, path);
  if (current?.generation !== observed.generation) {
    return;
  }
  const system = yield* SystemInfo;
  const counter = yield* nextStaleMarkerGenerationCounter;
  const stalePath = `${path}.stale`;
  const temporaryPath = `${stalePath}.${system.processId}.${counter}.tmp`;
  const cleared: RecallStaleMarker = {
    ...(observed.canonicalMutationGeneration === undefined
      ? {}
      : {canonicalMutationGeneration: observed.canonicalMutationGeneration}),
    forceRefresh: false,
    generation: observed.generation,
    invalidatedUris: [],
    ...(observed.canonicalMutationGeneration === undefined
      ? {}
      : {previousCanonicalMutationGeneration: observed.canonicalMutationGeneration}),
    version: RECALL_STALE_MARKER_VERSION,
  };
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(cleared)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporaryPath, stalePath)
    .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
});

export function writeRecallStaleGeneration(
  fs: FileSystem.FileSystem,
  path: string,
  invalidatedUris?: readonly string[],
  transition?: CanonicalMutationGenerationTransition,
) {
  return withStaleMarkerPublication(
    fs,
    path,
    transition,
    writeRecallStaleGenerationUnlocked(fs, path, invalidatedUris, transition),
  );
}

export function clearRecallStaleMarkerInvalidations(
  fs: FileSystem.FileSystem,
  path: string,
  observed: RecallStaleMarker,
) {
  return withStaleMarkerPublication(
    fs,
    path,
    undefined,
    clearRecallStaleMarkerInvalidationsUnlocked(fs, path, observed),
  );
}

const nextStaleMarkerGenerationCounter = Effect.sync(() => {
  staleMarkerGenerationCounter += 1;
  return staleMarkerGenerationCounter;
});

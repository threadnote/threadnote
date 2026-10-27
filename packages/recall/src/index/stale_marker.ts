import {Clock, Effect, FileSystem, Option, Predicate} from 'effect';
import type {CanonicalMutationGenerationTransition} from '@threadnote/store/resource/mutation_generation';
import {SystemInfo} from '@threadnote/platform/system';
import {mergeRecallIndexCanonicalMutationContinuity} from './freshness.js';
import {stripRecallAnchor} from './lexical.js';

const RECALL_STALE_MARKER_VERSION = 1;
const MAX_RECALL_INVALIDATED_URIS = 1_024;
let staleMarkerGenerationCounter = 0;

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
    const legacyGeneration = raw.trim() || 'present';
    const value = Option.getOrUndefined(Option.liftThrowable((content: string): unknown => JSON.parse(content))(raw));
    const marker = toRecallStaleMarker(value);
    if (marker !== undefined) {
      return {
        ...(marker.canonicalMutationGeneration === undefined
          ? {}
          : {canonicalMutationGeneration: marker.canonicalMutationGeneration}),
        forceRefresh: marker.forceRefresh,
        generation: marker.generation,
        invalidatedUris: [...new Set(marker.invalidatedUris.map(stripRecallAnchor))],
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
    !Array.isArray(record.invalidatedUris) ||
    !record.invalidatedUris.every(uri => typeof uri === 'string') ||
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

export const writeRecallStaleGeneration = Effect.fn('recall.writeStaleGeneration')(function* (
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
      [...(previous?.invalidatedUris ?? []), ...(invalidatedUris ?? [])]
        .map(stripRecallAnchor)
        .map(uri => uri.replace(/\/+$/, ''))
        .filter(Boolean),
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

export const clearRecallStaleMarkerInvalidations = Effect.fn('recall.clearStaleMarkerInvalidations')(function* (
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

const nextStaleMarkerGenerationCounter = Effect.sync(() => {
  staleMarkerGenerationCounter += 1;
  return staleMarkerGenerationCounter;
});

/** Independent continuity: clearing identity hints never consumes pending lexical hints. */
export const identityStaleMarkerBasePath = (lexicalBasePath: string): string => `${lexicalBasePath}.identity`;

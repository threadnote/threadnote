import {Array as EffectArray, Effect, FileSystem, Option, Path, PlatformError, Predicate, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {readPathFileSystemIdentity, runtimeLstat} from '@threadnote/platform/system';
import {ApplicationError, fromPromise} from '@threadnote/platform/errors';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import type {RecallIndexConfig} from '../index.js';
import {recallResourcePolicyInputProof} from './canonical_resource.js';
import {recallLogicalScope} from './freshness.js';
import {loadRecallMetadata} from './read_policy.js';
import {readRecallStaleMarker} from './stale_marker.js';

export class RecallIndexSourceChanged extends Schema.TaggedError<
  RecallIndexSourceChanged,
  {readonly brand: unique symbol}
>()('RecallIndexSourceChanged', {message: Schema.String}) {}

export const recallRefreshSuperseded = () =>
  RecallIndexSourceChanged.make({
    message: 'Lexical preparation was superseded by changed source or publication state; retain demand and retry.',
  });

export const recallMetadataCut = (metadata: ReadonlyMap<string, string>) => JSON.stringify([...metadata].sort());

/** Only source-local disappearance is supersession; permission/IO failures and defects retain their channel. */
export function normalizeRecallHydrationChanges<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.catchIf(
      error => {
        if (PlatformError.isPlatformError(error) && error.reason._tag === 'NotFound') return true;
        const cause = Schema.is(ApplicationError)(error) ? error.cause : error;
        return Predicate.isObject(cause) && 'code' in cause && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR');
      },
      () => Effect.fail(recallRefreshSuperseded()),
    ),
  );
}

/** Nanosecond metadata includes same-size writes that restore the visible mtime. */
export const captureRecallSourceInput = Effect.fn('recall.captureSourceInput')(function* (filename: string) {
  const info = yield* fromPromise('recall.source-metadata', () => runtimeLstat(filename)).pipe(
    Effect.catchIf(
      error => Predicate.isObject(error.cause) && 'code' in error.cause && error.cause.code === 'ENOENT',
      () => Effect.void,
    ),
  );
  return {
    info,
    key:
      info === undefined
        ? 'missing'
        : JSON.stringify(
            EffectArray.map(
              [info.dev, info.ino, info.birthtimeNs, info.mode, info.size, info.mtimeNs, info.ctimeNs],
              String,
            ),
          ),
  };
});

export function verifyRecallSourceInputs(inputs: ReadonlyMap<string, string>) {
  return Effect.forEach(
    [...inputs],
    ([filename, key]) =>
      captureRecallSourceInput(filename).pipe(
        Effect.flatMap(current => (current.key === key ? Effect.void : Effect.fail(recallRefreshSuperseded()))),
      ),
    {concurrency: 16, discard: true},
  );
}

/** Caller holds lexical then canonical fences; this captures metadata, never corpus bodies. */
export const captureRecallRefreshCut = Effect.fn('recall.captureRefreshCut')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RecallIndexConfig,
  includeInactive: boolean,
  location: {
    readonly databasePath: string;
    readonly activeDatabasePath: string;
    readonly pointerPath: string;
    readonly staleMarkerBasePath: string;
  },
) {
  const identity = (filename: string) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* fs.readLink(filename).pipe(Effect.option))) return yield* recallRefreshSuperseded();
      const file = yield* readPathFileSystemIdentity(filename, yield* fs.stat(filename), 'File');
      if (Option.isNone(file)) return yield* recallRefreshSuperseded();
      return `${file.value.dev}:${file.value.ino}`;
    });
  let pointer = '';
  if (yield* fs.exists(location.pointerPath)) {
    if (Option.isSome(yield* fs.readLink(location.pointerPath).pipe(Effect.option)))
      return yield* recallRefreshSuperseded();
    const info = yield* fs.stat(location.pointerPath);
    if (info.type !== 'File' || Number(info.size) > 4096) return yield* recallRefreshSuperseded();
    pointer = yield* fs.readFileString(location.pointerPath);
  }
  const physicalHome = yield* fs.realPath(config.agentContextHome);
  const databaseIdentity = yield* identity(location.databasePath);
  const activeIdentity = yield* identity(location.activeDatabasePath);
  const metadata = yield* loadRecallMetadata(sql);
  const staleMarker = yield* readRecallStaleMarker(fs, location.staleMarkerBasePath);
  const canonicalMutationGeneration = yield* readCanonicalMutationGeneration(
    fs,
    path,
    config.agentContextHome,
    config.account,
  );
  const policyInputProof = yield* recallResourcePolicyInputProof(config);
  return {
    metadata,
    staleMarker,
    canonicalMutationGeneration,
    policyInputProof,
    seal: JSON.stringify([
      physicalHome,
      recallLogicalScope(config, includeInactive),
      location.databasePath,
      databaseIdentity,
      location.activeDatabasePath,
      activeIdentity,
      pointer,
      recallMetadataCut(metadata),
      staleMarker,
      canonicalMutationGeneration,
      policyInputProof ?? null,
    ]),
  };
});

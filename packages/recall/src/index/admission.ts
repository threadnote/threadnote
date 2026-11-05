import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {FileLockTimeout, fileLockBusyMessage} from '@threadnote/platform/file/lock';
import {readPathFileSystemIdentity} from '@threadnote/platform/system';
import {
  CanonicalMutationGenerationInvalid,
  readCanonicalMutationGeneration,
} from '@threadnote/store/resource/mutation_generation';
import {
  Array as EffectArray,
  Cause,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Schema,
} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {SqlError} from 'effect/sql/SqlError';
import {recallIndexForegroundRefreshRequired, recallInventoryPolicyIsCurrent} from './freshness.js';
import {recallIndexMetadataIsCurrent} from './identity.js';
import {readRecallStaleMarker} from './stale_marker.js';

export class RecallIdentityAdmissionBusy extends Schema.TaggedError<
  RecallIdentityAdmissionBusy,
  {readonly brand: unique symbol}
>()('RecallIdentityAdmissionBusy', {message: Schema.String}) {}

const busy = (timeout?: FileLockTimeout) =>
  RecallIdentityAdmissionBusy.make({
    message: timeout
      ? fileLockBusyMessage(timeout)
      : 'Recall identity evidence changed or is busy; retry the same intent.',
  });
const CurrentIdentityPreparation = Context.Reference<number | undefined>('threadnote/RecallIdentityPreparation', {
  defaultValue: () => undefined,
});
export const failFastIdentityPreparation = Effect.gen(function* () {
  return (yield* CurrentIdentityPreparation) === (yield* Effect.fiberId);
});

/** Normalize at the recall boundary, before domain validators classify identity conflicts. */
export function normalizeRecallIdentityPreparation<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    if (!(yield* failFastIdentityPreparation)) return yield* effect;
    return yield* effect.pipe(
      Effect.catchCauseIf(
        cause => {
          if (Cause.hasInterrupts(cause)) return false;
          const error = Cause.squash(cause);
          return (
            Schema.is(FileLockTimeout)(error) ||
            (Schema.is(SqlError)(error) && error.reason._tag === 'LockTimeoutError')
          );
        },
        cause => {
          const error = Cause.squash(cause);
          return Effect.fail(busy(Schema.is(FileLockTimeout)(error) ? error : undefined));
        },
      ),
    );
  });
}

/** Internal native entry policy; it grants no freshness proof or acquisition allowance. */
export function withRecallIdentityPreparation<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const owner = yield* Effect.fiberId;
    return yield* effect.pipe(
      normalizeRecallIdentityPreparation,
      Effect.provideService(CurrentIdentityPreparation, owner),
    );
  });
}

type Check = Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;

/** The mode is private, fiber-bound and restored before the caller takes its memory locks. */
export function withPreparedRecallIdentityAdmission<A, E, R, EPrepare, RPrepare, RWarm>(
  warm: Effect.Effect<void, unknown, RWarm>,
  readCut: Effect.Effect<string, unknown, FileSystem.FileSystem | Path.Path>,
  prepare: Effect.Effect<void, EPrepare, RPrepare>,
  use: (check: Check) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const owner = yield* Effect.fiberId;
      return yield* Effect.gen(function* () {
        yield* warm;
        const before = yield* readCut;
        yield* prepare;
        if ((yield* readCut) !== before) return yield* busy();
        return {cut: before, owner, active: true, consumed: false};
      }).pipe(withRecallIdentityPreparation);
    }).pipe(Effect.interruptible),
    admission =>
      use(
        Effect.gen(function* () {
          if (!admission.active || admission.consumed || (yield* Effect.fiberId) !== admission.owner)
            return yield* busy();
          admission.consumed = true;
          if ((yield* readCut) !== admission.cut) return yield* busy();
        }),
      ),
    admission =>
      Effect.sync(() => {
        admission.active = false;
      }),
  );
}

interface AdmissionLocation {
  readonly account: string;
  readonly home: string;
  readonly databasePath: Effect.Effect<string, unknown>;
  readonly pointerPath: string;
  readonly fixedDatabasePath: string;
  readonly schemaVersion: number;
  readonly logicalScope: string;
}

/** Read only bounded readiness metadata; no initialization, corpus scan, repair or SQLite busy wait. */
export function readRecallIdentityAdmissionCut(location: AdmissionLocation) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pointer = yield* readPointer(fs, location.pointerPath);
    const databasePath = yield* location.databasePath;
    if (Option.isSome(yield* fs.readLink(databasePath).pipe(Effect.option))) return yield* busy();
    const file = yield* readPathFileSystemIdentity(databasePath, yield* fs.stat(databasePath), 'File');
    if (Option.isNone(file)) return yield* busy();
    const metadata = yield* Effect.scoped(
      Layer.build(
        SqliteClient.layer({
          create: false,
          disableWAL: true,
          filename: databasePath,
          readonly: true,
          readwrite: false,
          busyTimeout: 0,
        }),
      ).pipe(
        Effect.flatMap(context =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{readonly key: string; readonly value: string}>`SELECT key, value FROM metadata`;
            return new Map(EffectArray.map(rows, row => [row.key, row.value] as const));
          }).pipe(Effect.provide(context)),
        ),
      ),
    );
    const canonical = yield* readCanonicalMutationGeneration(fs, path, location.home, location.account);
    const stale = yield* readRecallStaleMarker(fs, location.fixedDatabasePath);
    if (
      metadata.get('schema_version') !== String(location.schemaVersion) ||
      !metadata.get('content_generation') ||
      !recallInventoryPolicyIsCurrent(metadata) ||
      metadata.get('logical_scope') !== location.logicalScope ||
      metadata.get('logical_scope_content_generation') !== metadata.get('content_generation') ||
      recallIndexForegroundRefreshRequired({
        forceRefresh: false,
        initialized: metadata.get('initialized') === 'true',
        integrityCurrent: recallIndexMetadataIsCurrent(metadata),
        observedCanonicalMutationGeneration: canonical,
        persistedCanonicalMutationGeneration: metadata.get('canonical_mutation_generation') ?? '',
        observedStaleGeneration: stale?.generation ?? '',
        persistedStaleGeneration: metadata.get('stale_generation') ?? '',
      })
    )
      return yield* busy();
    const current = yield* readPathFileSystemIdentity(databasePath, yield* fs.stat(databasePath), 'File');
    if (
      Option.isNone(current) ||
      current.value.dev !== file.value.dev ||
      current.value.ino !== file.value.ino ||
      (yield* readPointer(fs, location.pointerPath)) !== pointer ||
      (yield* readCanonicalMutationGeneration(fs, path, location.home, location.account)) !== canonical ||
      (yield* readRecallStaleMarker(fs, location.fixedDatabasePath))?.generation !== stale?.generation
    )
      return yield* busy();
    return JSON.stringify([
      databasePath,
      `${file.value.dev}:${file.value.ino}`,
      pointer,
      [...metadata].sort(),
      canonical,
      stale,
    ]);
  }).pipe(
    Effect.catchIf(
      error =>
        PlatformError.isPlatformError(error) ||
        Schema.is(SqlError)(error) ||
        Schema.is(CanonicalMutationGenerationInvalid)(error),
      () => Effect.fail(busy()),
    ),
  );
}

function readPointer(fs: FileSystem.FileSystem, pointerPath: string) {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(pointerPath))) return '';
    if (Option.isSome(yield* fs.readLink(pointerPath).pipe(Effect.option))) return yield* busy();
    const info = yield* fs.stat(pointerPath);
    if (info.type !== 'File' || Number(info.size) > 4096) return yield* busy();
    return yield* fs.readFileString(pointerPath);
  });
}

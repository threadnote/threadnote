import {
  Array as EffectArray,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  String as EffectString,
  pipe as EffectArrayPipe,
} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import type {SqlError} from 'effect/sql/SqlError';
import type {RecallEligibilityPolicy} from '../eligibility.js';

// This private marker permits candidate selection, never returning an authorized result.
const pendingExternalAuthorization = Symbol('recall.pendingExternalAuthorization');
export const DEFAULT_RECALL_QUERY_RESULT_LIMIT = 100;
export const MAX_READY_RECALL_SOURCE_CHECKS = 4_096;
export interface RecallReadyExactWindow {
  readonly scope: string;
  readonly term: string;
  readonly uris: readonly string[];
  readonly complete: boolean;
}
export function normalizeRecallExactTerms(terms: readonly string[]): readonly string[] {
  return [
    ...new Map(
      EffectArray.map(
        EffectArray.filter(EffectArray.map(terms, EffectString.trim), Boolean),
        term => [EffectString.toLocaleLowerCase()(term), term] as const,
      ),
    ).values(),
  ];
}
export class RecallReadyReadIncomplete extends Schema.TaggedError<
  RecallReadyReadIncomplete,
  {readonly brand: unique symbol}
>()('RecallReadyReadIncomplete', {
  message: Schema.String,
  maintenance: Schema.optionalKey(Schema.Literals(['refresh', 'reconcile'])),
}) {}

export function readyRecallSelectionPolicy(policy: RecallEligibilityPolicy | undefined) {
  const base = policy ?? ({kind: 'candidate-policy', authority: 'any', projects: {mode: 'unrestricted'}} as const);
  return {...base, [pendingExternalAuthorization]: true};
}

export function recallSelectionDefersExternalAuthorization(policy: RecallEligibilityPolicy | undefined): boolean {
  return (
    policy !== undefined && pendingExternalAuthorization in policy && policy[pendingExternalAuthorization] === true
  );
}

export function useRecallDatabaseReadOnly<A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
): Effect.Effect<A, E | SqlError, Exclude<R, SqlClient.SqlClient>> {
  return Effect.scoped(
    Layer.build(
      SqliteClient.layer({
        create: false,
        busyTimeout: 50,
        disableWAL: true,
        filename: databasePath,
        readonly: true,
        readwrite: false,
      }).pipe(Layer.orDie),
    ).pipe(
      Effect.flatMap(context =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.withTransaction(effect);
        }).pipe(Effect.provide(context)),
      ),
    ),
  );
}

export interface RecallMetadataRow {
  readonly key: string;
  readonly value: string;
}

export function loadRecallMetadata(sql: SqlClient.SqlClient) {
  return sql<RecallMetadataRow>`SELECT key, value FROM metadata`.pipe(
    Effect.map(rows => new Map(EffectArray.map(rows, row => [row.key, row.value]))),
  );
}

export function numericMetadata(metadata: ReadonlyMap<string, string>, key: string): number {
  const value = Number(metadata.get(key) ?? '0');
  return Number.isFinite(value) ? value : 0;
}

export function chunkRecallValues<Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] {
  const chunks: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export const readRecallPublishedMetadataHint = Effect.fn('recall.publishedMetadataHint')(function* (config: {
  readonly root: string;
  readonly pointer: string;
  readonly fixed: string;
  readonly pointerVersion: number;
  readonly schemaVersion: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = yield* resolveNegativeHintDatabasePath(fs, path, config);
  if (databasePath === undefined) return undefined;
  if (!(yield* fs.exists(databasePath))) return undefined;
  return yield* useRecallDatabaseReadOnly(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql.unsafe<{readonly name: string; readonly pk: number}>("PRAGMA table_info('metadata')");
      if (
        columns.length !== 2 ||
        columns[0]?.name !== 'key' ||
        columns[0].pk !== 1 ||
        columns[1]?.name !== 'value' ||
        columns[1].pk !== 0
      )
        return undefined;
      const rows = yield* sql<{readonly key: string; readonly value: string | null}>`SELECT key,
        CASE WHEN typeof(value) = 'text' THEN CASE WHEN octet_length(value) <= 65536 THEN value END END AS value FROM metadata
      WHERE key IN ('schema_version', 'initialized', 'content_generation') LIMIT 3`;
      const metadata = new Map(EffectArray.map(rows, row => [row.key, row.value]));
      const generation = metadata.get('content_generation');
      return metadata.get('schema_version') === String(config.schemaVersion) &&
        metadata.get('initialized') === 'true' &&
        typeof generation === 'string' &&
        generation.length > 0 &&
        generation.length <= 65536
        ? generation
        : undefined;
    }),
  );
});

// Optional negative metadata must not add an unbounded pointer read before useful recall.
const resolveNegativeHintDatabasePath = Effect.fn('recall.resolveNegativeHintDatabasePath')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: {readonly root: string; readonly pointer: string; readonly fixed: string; readonly pointerVersion: number},
) {
  const pointerPath = config.pointer;
  if (!(yield* fs.exists(pointerPath))) return config.fixed;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(pointerPath);
      const info = yield* file.stat;
      if (info.type !== 'File' || info.size > 8192n) return undefined;
      const bytes = yield* file.readAlloc(8193);
      if (Option.isNone(bytes) || bytes.value.length !== Number(info.size) || bytes.value.length > 8192)
        return undefined;
      const raw = yield* Effect.try(() => new TextDecoder('utf-8', {fatal: true}).decode(bytes.value));
      const pointer = yield* Effect.try(() => JSON.parse(raw) as unknown);
      if (!Predicate.isObject(pointer)) return undefined;
      const relative =
        typeof pointer.database === 'string'
          ? EffectArrayPipe(pointer.database, EffectString.replaceAll('\\', '/'))
          : undefined;
      if (
        pointer.version !== config.pointerVersion ||
        !relative ||
        !EffectArrayPipe(relative, EffectString.startsWith('generations/')) ||
        EffectArray.some(
          EffectArrayPipe(relative, EffectString.split('/')),
          segment => segment === '' || segment === '.' || segment === '..',
        ) ||
        !EffectArrayPipe(relative, EffectString.endsWith('.sqlite'))
      )
        return undefined;
      const databasePath = path.join(config.root, ...EffectArrayPipe(relative, EffectString.split('/')));
      return (yield* fs.exists(databasePath)) ? databasePath : undefined;
    }),
  );
});

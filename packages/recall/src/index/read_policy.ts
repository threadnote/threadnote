import {Array as EffectArray, Effect, Layer, Schema, String as EffectString} from 'effect';
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

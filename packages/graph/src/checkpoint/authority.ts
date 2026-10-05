import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Effect, FileSystem, Layer, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  codeGraphExtractorSetIdentityFromPackProvenance,
  createCodeGraphContentIdentityAccumulator,
} from '../graph_identity.js';
import type {CodeGraphLanguagePackProvenance} from '../store/models.js';
import type {
  CodeGraphCheckpointHeaderV1,
  CodeGraphCheckpointPackProvenanceRecordV1,
  CodeGraphCheckpointRecordV1,
} from './schema.js';
import {checkpointTerminalText} from './terminal_text.js';

const AUTHORITY_INSERT_ROWS = 1_000;
const AUTHORITY_READ_ROWS = 1_000;

export class CodeGraphCheckpointAuthorityError extends Schema.TaggedError<CodeGraphCheckpointAuthorityError>()(
  'CodeGraphCheckpointAuthorityError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

/**
 * Binds source identity, ABI provenance, and logical records before any target
 * graph database is opened. A private SQLite spool preserves the product's
 * UTF-16 inventory ordering without retaining a repository-sized file list.
 */
export function withCodeGraphCheckpointAuthorityVerification<A, E, R>(
  header: CodeGraphCheckpointHeaderV1,
  consume: (
    accept: (records: readonly CodeGraphCheckpointRecordV1[]) => Effect.Effect<void, CodeGraphCheckpointAuthorityError>,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const expectedPacks = header.abi.input.languagePacks;
      const extractorSet = codeGraphExtractorSetIdentityFromPackProvenance(expectedPacks);
      if (extractorSet !== header.source.extractorSet) {
        return yield* authorityFailure('Checkpoint source extractor identity does not match its ABI language packs.');
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-checkpoint-authority-'});
      const databasePath = path.join(directory, 'authority.sqlite');
      return yield* Layer.build(SqliteClient.layer({disableWAL: true, filename: databasePath})).pipe(
        Effect.flatMap(sqliteContext =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe(
              `CREATE TABLE authority_files (
             sort_key TEXT PRIMARY KEY NOT NULL,
             path TEXT UNIQUE NOT NULL,
             content_hash TEXT NOT NULL,
             language TEXT NOT NULL,
             mode TEXT NOT NULL
           ) WITHOUT ROWID`,
            );
            const remainingPacks = new Map(expectedPacks.map(pack => [pack.id, pack] as const));
            const result = yield* sql.withTransaction(
              consume(records =>
                Effect.gen(function* () {
                  const files = records.filter(record => record.kind === 'file');
                  for (let offset = 0; offset < files.length; offset += AUTHORITY_INSERT_ROWS) {
                    const batch = files.slice(offset, offset + AUTHORITY_INSERT_ROWS);
                    const parameters = batch.flatMap(file => [
                      utf16SortKey(file.path),
                      file.path,
                      file.contentHash,
                      file.language,
                      file.mode,
                    ]);
                    const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ');
                    yield* sql.unsafe(
                      `INSERT INTO authority_files (sort_key, path, content_hash, language, mode) VALUES ${placeholders}`,
                      parameters,
                    );
                  }
                  for (const record of records) {
                    if (record.kind !== 'pack-provenance') continue;
                    const expected = remainingPacks.get(record.id);
                    if (expected === undefined || !samePackProvenance(record, expected)) {
                      return yield* authorityFailure(
                        `Checkpoint pack provenance does not match its ABI declaration: ${checkpointTerminalText(record.id)}`,
                      );
                    }
                    remainingPacks.delete(record.id);
                  }
                }).pipe(Effect.mapError(authorityError)),
              ),
            );
            if (remainingPacks.size > 0) {
              return yield* authorityFailure('Checkpoint records do not cover every ABI language pack.');
            }
            const accumulator = createCodeGraphContentIdentityAccumulator(extractorSet);
            let cursor = '';
            for (;;) {
              const rows = yield* sql.unsafe<{
                readonly content_hash: string;
                readonly language: string;
                readonly mode: string;
                readonly path: string;
                readonly sort_key: string;
              }>(
                `SELECT sort_key, path, content_hash, language, mode
             FROM authority_files
             WHERE sort_key > ?
             ORDER BY sort_key
             LIMIT ?`,
                [cursor, AUTHORITY_READ_ROWS],
              );
              for (const row of rows) {
                accumulator.update({
                  contentHash: row.content_hash,
                  language: row.language,
                  mode: row.mode,
                  path: row.path,
                });
              }
              if (rows.length < AUTHORITY_READ_ROWS) break;
              cursor = rows.at(-1)!.sort_key;
            }
            if (accumulator.digest() !== header.source.graphContentId) {
              return yield* authorityFailure(
                'Checkpoint graph content identity does not match its canonical file inventory.',
              );
            }
            return result;
          }).pipe(Effect.provide(sqliteContext)),
        ),
        Effect.mapError(authorityError),
      );
    }),
  );
}

function samePackProvenance(
  record: CodeGraphCheckpointPackProvenanceRecordV1,
  expected: CodeGraphLanguagePackProvenance,
): boolean {
  return (
    record.cacheIdentity === expected.cacheIdentity &&
    record.derivationIdentity === expected.derivationIdentity &&
    record.id === expected.id &&
    record.resolutionDomain === expected.resolutionDomain &&
    record.resolutionVersion === expected.resolutionVersion
  );
}

function utf16SortKey(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    output += value.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return output;
}

function authorityFailure(message: string): Effect.Effect<never, CodeGraphCheckpointAuthorityError> {
  return Effect.fail(CodeGraphCheckpointAuthorityError.make({message: message}));
}

function authorityError(cause: unknown): CodeGraphCheckpointAuthorityError {
  return Schema.is(CodeGraphCheckpointAuthorityError)(cause)
    ? cause
    : CodeGraphCheckpointAuthorityError.make({cause, message: 'Checkpoint authority verification failed.'});
}

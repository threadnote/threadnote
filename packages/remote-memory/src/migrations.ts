import {Array as EffectArray, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';
import {remoteMemoryError} from './errors.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const STANDALONE_REMOTE_MEMORY_MIGRATION_DIRECTORY = 'remote-memory/migrations';

export function standaloneMigrationFilePath(executablePath: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/u.test(name)) {
    throw remoteMemoryError('invalid_request', 'Remote memory migration file name is invalid.');
  }
  const trimmed = trimTrailingCharacters(executablePath, '/\\');
  const separator =
    Effect.pipe(trimmed, EffectString.includes('\\')) && !Effect.pipe(trimmed, EffectString.includes('/')) ? '\\' : '/';
  const slash = Effect.pipe(
    trimmed,
    EffectString.lastIndexOf(separator),
    Effect.Option.getOrElse(() => -1),
  );
  const root = slash <= 0 ? trimmed : Effect.pipe(trimmed, EffectString.slice(0, slash));
  return EffectArray.join(
    [root, ...Effect.pipe(STANDALONE_REMOTE_MEMORY_MIGRATION_DIRECTORY, EffectString.split('/')), name],
    separator,
  );
}

function migrationFile(name: string, executablePath: string | undefined): string | URL {
  if (typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE) {
    if (!executablePath) {
      throw remoteMemoryError(
        'service_unavailable',
        'Standalone remote memory migrations require the executable path.',
      );
    }
    return standaloneMigrationFilePath(executablePath, name);
  }
  return new URL(`./migrations/${name}`, import.meta.url);
}

const MIGRATIONS = [
  {name: '001_initial.sql', version: 1},
  {name: '002_git_canonical_pointers.sql', version: 2},
  {name: '003_git_ingest_observations.sql', version: 3},
  {name: '004_durable_memory_proposals.sql', version: 4},
  {name: '005_code_link_backlinks.sql', version: 5},
  {name: '006_identity_client_grant_expiry.sql', version: 6},
  {name: '007_cloud_admission_profile.sql', version: 7},
  {name: '008_hosted_context_health.sql', version: 8},
  {name: '009_hosted_context_ci.sql', version: 9},
] as const;
const MIGRATION_LOCK = 7_427_190_041;

export function remoteMemoryMigrationVersions(): readonly number[] {
  return EffectArray.map(MIGRATIONS, migration => migration.version);
}

interface RemoteMemoryMigrationConnection {
  (template: TemplateStringsArray, ...values: readonly (number | string)[]): PromiseLike<readonly unknown[]>;
  release(): void;
  unsafe(query: string): PromiseLike<readonly unknown[]>;
}

interface RemoteMemoryMigrationDatabase {
  reserve(): Promise<RemoteMemoryMigrationConnection>;
}

export async function migrateRemoteMemoryDatabase(
  sql: RemoteMemoryMigrationDatabase,
  options: {readonly executablePath?: string} = {},
): Promise<void> {
  const connection = await sql.reserve();
  await connection`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
  try {
    await connection.unsafe(
      'CREATE SCHEMA IF NOT EXISTS remote_memory; CREATE TABLE IF NOT EXISTS remote_memory.schema_migrations ' +
        '(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const migration of MIGRATIONS) {
      const source = await Bun.file(migrationFile(migration.name, options.executablePath)).text();
      const checksum = sha256HexSync(source);
      const applied = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({checksum: Schema.String})))(
        await connection`
          SELECT checksum FROM remote_memory.schema_migrations WHERE version = ${migration.version}
        `,
      );
      if (applied[0]) {
        if (applied[0].checksum !== checksum) {
          throw remoteMemoryError(
            'service_unavailable',
            `Remote memory migration ${migration.version} changed after apply.`,
          );
        }
        continue;
      }
      await connection.unsafe('BEGIN');
      try {
        await connection.unsafe(source);
        await connection`
          INSERT INTO remote_memory.schema_migrations(version, checksum)
          VALUES (${migration.version}, ${checksum})
          ON CONFLICT (version) DO NOTHING
        `;
        const recorded = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({checksum: Schema.String})))(
          await connection`
            SELECT checksum FROM remote_memory.schema_migrations WHERE version = ${migration.version}
          `,
        );
        if (recorded[0]?.checksum !== checksum) {
          throw remoteMemoryError(
            'service_unavailable',
            `Remote memory migration ${migration.version} changed while applying.`,
          );
        }
        await connection.unsafe('COMMIT');
      } catch (cause) {
        await connection.unsafe('ROLLBACK');
        throw cause;
      }
    }
  } finally {
    try {
      await connection`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    } finally {
      connection.release();
    }
  }
}

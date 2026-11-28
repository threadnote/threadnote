import {Database} from 'bun:sqlite';
import {Context, Effect, Schema} from 'effect';

/** The free-page rule of vector compaction. Production keeps the defaults; a test supplies a small file's values. */
export interface RecallVectorCompactionThresholds {
  readonly minimumReclaimableBytes: number;
  readonly minimumReclaimableRatio: number;
  /** Free disk space kept on top of what VACUUM writes. */
  readonly safetyMarginBytes: number;
}
export const RecallVectorCompactionThresholds = Context.Reference<RecallVectorCompactionThresholds>(
  '@threadnote/recall/vector/CompactionThresholds',
  {
    defaultValue: () => ({
      minimumReclaimableBytes: 512 * 1024 * 1024,
      minimumReclaimableRatio: 0.2,
      safetyMarginBytes: 64 * 1024 * 1024,
    }),
  },
);

export class RecallVectorPageStorageUnavailable extends Schema.TaggedError<
  RecallVectorPageStorageUnavailable,
  {readonly brand: unique symbol}
>()('RecallVectorPageStorageUnavailable', {message: Schema.String}) {}

/** Page counters of the last committed snapshot, WAL included. */
export interface SqlitePageStorage {
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistCount: number;
}

export interface SqliteCompactionRecommendation {
  readonly liveBytes: number;
  readonly reclaimableBytes: number;
  readonly recommended: boolean;
}

/** VACUUM earns its write cost only when free pages pass both the absolute and the relative threshold. */
export function sqliteCompactionRecommendation(
  storage: SqlitePageStorage,
  thresholds: Pick<RecallVectorCompactionThresholds, 'minimumReclaimableBytes' | 'minimumReclaimableRatio'>,
): SqliteCompactionRecommendation {
  const freePages = Math.min(storage.freelistCount, storage.pageCount);
  const reclaimableBytes = storage.pageSize * freePages;
  const ratio = storage.pageCount === 0 ? 0 : freePages / storage.pageCount;
  return {
    liveBytes: storage.pageSize * (storage.pageCount - freePages),
    reclaimableBytes,
    recommended: reclaimableBytes >= thresholds.minimumReclaimableBytes && ratio >= thresholds.minimumReclaimableRatio,
  };
}

/**
 * Free bytes VACUUM needs on each filesystem: one copy of the live pages in the SQLite temporary directory and the
 * same pages again through the WAL, plus the WAL that exists and a margin. One filesystem holds both writes.
 */
export function sqliteCompactionFreeSpace(input: {
  readonly liveBytes: number;
  readonly walBytes: number;
  readonly marginBytes: number;
  readonly sameFilesystem: boolean;
}) {
  const database = input.liveBytes + input.walBytes + input.marginBytes;
  return input.sameFilesystem
    ? {database: database + input.liveBytes, temporary: database + input.liveBytes}
    : {database, temporary: input.liveBytes + input.marginBytes};
}

const counter = (database: Database, pragma: 'page_size' | 'page_count' | 'freelist_count') => {
  const value = Number(database.query<Record<string, number | bigint>, []>(`PRAGMA ${pragma}`).get()?.[pragma] ?? 0);
  if (!Number.isSafeInteger(value) || value < 0)
    throw RecallVectorPageStorageUnavailable.make({message: `SQLite ${pragma} is invalid.`});
  return value;
};

/** Reads the page counters read-only with a short busy timeout; it never writes or checkpoints the file. */
export const readSqlitePageStorage = (databasePath: string) =>
  Effect.try({
    try: (): SqlitePageStorage => {
      const database = new Database(databasePath, {readonly: true, strict: true});
      try {
        database.exec('PRAGMA busy_timeout = 50');
        return {
          pageSize: counter(database, 'page_size'),
          pageCount: counter(database, 'page_count'),
          freelistCount: counter(database, 'freelist_count'),
        };
      } finally {
        database.close(false);
      }
    },
    catch: cause =>
      Schema.is(RecallVectorPageStorageUnavailable)(cause)
        ? cause
        : RecallVectorPageStorageUnavailable.make({message: `Could not read SQLite page storage: ${String(cause)}`}),
  });

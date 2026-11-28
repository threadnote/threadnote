import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {
  readSqlitePageStorage,
  sqliteCompactionFreeSpace,
  sqliteCompactionRecommendation,
} from '../../src/vector/sqlite-pages.js';

describe('vector SQLite page storage', () => {
  effectIt.layer(BunServices.layer)(it => {
    it.effect('reports the free pages of a file and recommends compaction only when both thresholds pass', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(yield* fs.makeTempDirectoryScoped({prefix: 'vector-sqlite-pages-'}), 'data.sqlite');
        const database = new Database(file);
        database.exec('PRAGMA page_size = 4096; PRAGMA journal_mode = WAL; CREATE TABLE rows (body BLOB)');
        const insert = database.query('INSERT INTO rows VALUES (?)');
        for (let row = 0; row < 64; row++) insert.run(new Uint8Array(16 * 1024));
        database.exec('DELETE FROM rows WHERE rowid > 16');
        database.close();

        const storage = yield* readSqlitePageStorage(file);
        expect(storage.freelistCount).toBeGreaterThan(0);
        const at = (minimumReclaimableBytes: number, minimumReclaimableRatio: number) =>
          sqliteCompactionRecommendation(storage, {minimumReclaimableBytes, minimumReclaimableRatio});
        const report = at(0, 0);
        expect(report.reclaimableBytes).toBe(storage.freelistCount * storage.pageSize);
        expect(report.liveBytes + report.reclaimableBytes).toBe(storage.pageCount * storage.pageSize);
        const ratio = storage.freelistCount / storage.pageCount;
        // Exactly at both thresholds compacts; one byte or one point more on either side does not.
        expect(at(report.reclaimableBytes, ratio).recommended).toBe(true);
        expect(at(report.reclaimableBytes + 1, ratio).recommended).toBe(false);
        expect(at(report.reclaimableBytes, Math.min(1, ratio + 0.01)).recommended).toBe(false);
        expect(at(0, Math.min(1, ratio + 0.01)).recommended).toBe(false);
      }),
    );

    it.effect('needs both VACUUM writes on one filesystem and splits them across two', () =>
      Effect.sync(() => {
        const input = {liveBytes: 100, walBytes: 7, marginBytes: 10};
        expect(sqliteCompactionFreeSpace({...input, sameFilesystem: true})).toEqual({database: 217, temporary: 217});
        expect(sqliteCompactionFreeSpace({...input, sameFilesystem: false})).toEqual({database: 117, temporary: 110});
      }),
    );
  });
});

import {Database} from 'bun:sqlite';
import {describe, expect, it} from 'vitest';
import {
  assessVectorDatabaseStorage,
  createCompactedSqliteSnapshot,
  VECTOR_DATABASE_INCREMENTAL_COMPACTED_BYTES_MAXIMUM,
} from '../../../../scripts/recall-vector-storage-budget.js';
import {join, mkdtemp, rm, stat} from '../helpers/effect-filesystem.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('recall vector storage budget', () => {
  it('separates copy-on-write file growth from compacted database growth', async () => {
    const directory = await mkdtemp('threadnote-vector-storage-budget-');
    try {
      const databasePath = join(directory, 'vectors.sqlite');
      const initialSnapshotPath = join(directory, 'initial.compacted.sqlite');
      const incrementalSnapshotPath = join(directory, 'incremental.compacted.sqlite');
      const database = new Database(databasePath, {strict: true});
      database.exec(`
        PRAGMA page_size = 4096;
        CREATE TABLE chunks (
          generation TEXT NOT NULL,
          key TEXT NOT NULL,
          payload BLOB NOT NULL,
          PRIMARY KEY (generation, key)
        ) WITHOUT ROWID
      `);
      const insert = database.prepare('INSERT INTO chunks (generation, key, payload) VALUES (?, ?, ?)');
      const insertGeneration = database.transaction((generation: string) => {
        for (let index = 0; index < 1_000; index += 1) {
          insert.run(generation, Effect.pipe(String(index), EffectString.padStart(6, '0')), new Uint8Array(512));
        }
      });

      insertGeneration('old');
      createCompactedSqliteSnapshot(databasePath, initialSnapshotPath);
      const initial = {
        compactedBytes: (await stat(initialSnapshotPath)).size,
        databaseBytes: (await stat(databasePath)).size,
      };
      database.transaction(() => {
        insertGeneration('new');
        database.run("DELETE FROM chunks WHERE generation = 'old'");
      })();
      database.close(false);
      createCompactedSqliteSnapshot(databasePath, incrementalSnapshotPath);
      const incremental = {
        compactedBytes: (await stat(incrementalSnapshotPath)).size,
        databaseBytes: (await stat(databasePath)).size,
      };
      const budget = assessVectorDatabaseStorage(1_000, initial, incremental);

      expect(incremental.databaseBytes - initial.databaseBytes).toBeGreaterThan(
        VECTOR_DATABASE_INCREMENTAL_COMPACTED_BYTES_MAXIMUM,
      );
      expect(budget.incrementalCompactedBytes).toBeLessThanOrEqual(VECTOR_DATABASE_INCREMENTAL_COMPACTED_BYTES_MAXIMUM);
      expect(budget.incrementalCompactedBytesWithinBudget).toBe(true);
      expect(budget.databaseBytesWithinBudget).toBe(true);
    } finally {
      await rm(directory, {force: true, recursive: true});
    }
  });

  it('still rejects excessive compacted growth and excessive physical allocation', () => {
    const excessiveCompacted = assessVectorDatabaseStorage(
      1,
      {compactedBytes: 4_096, databaseBytes: 4_096},
      {
        compactedBytes: 4_096 + VECTOR_DATABASE_INCREMENTAL_COMPACTED_BYTES_MAXIMUM + 1,
        databaseBytes: 4_096,
      },
    );
    const excessivePhysical = assessVectorDatabaseStorage(
      1,
      {compactedBytes: 4_096, databaseBytes: 4_096},
      {compactedBytes: 4_096, databaseBytes: excessiveCompacted.databaseBytesMaximum + 1},
    );

    expect(excessiveCompacted.incrementalCompactedBytesWithinBudget).toBe(false);
    expect(excessivePhysical.databaseBytesWithinBudget).toBe(false);
  });
});

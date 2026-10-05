import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Database} from 'bun:sqlite';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {
  type CodeGraphVectorRetirementCapacityProtector,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_FIXED_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_BYTES,
  CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS,
  admitOneCodeGraphVectorRetirementWithCapacity,
  codeGraphVectorRetirementLegacyPointerProbeStatement,
  codeGraphVectorRetirementMarkerPageStatement,
  codeGraphVectorRetirementPageStatement,
  deleteCodeGraphVectorPointerWithRetirement,
  commitCodeGraphVectorRetirementAdmission,
  planCodeGraphVectorRetirementAdmission,
  planCodeGraphVectorRetirementPage,
  prepareCodeGraphVectorRetirement,
  retireCodeGraphVectorPointerWithCapacity,
  retireCodeGraphVectorGenerationPage,
} from '@threadnote/graph/vector/maintenance';
import {
  CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
  admitOneCodeGraphVectorRetirement,
  deleteCodeGraphVectorPointerWithRetirementSql,
  inspectCodeGraphVectorRetirementWork,
} from '@threadnote/graph/vector/retirement';

const VectorRetirementTestLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const identityCapacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => transaction;
const capacityOptions = {capacityProtector: identityCapacityProtector} as const;
const STORED_POINTER_GENERATION_INDEX_SQL =
  'CREATE INDEX vector_pointer_generation_lookup ON vector_pointers (generation)';

describe('code graph vector retirement schema', () => {
  effectIt.layer(VectorRetirementTestLayer)(layerIt => {
    layerIt.effect('adds retirement authority to v2 without rewriting existing vectors or pointers', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-schema-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation: 'generation-live', snapshotId: 'snapshot-live', vectorCount: 3}],
              pointers: [{generation: 'generation-live', worktreeId: 'a'.repeat(64)}],
            }),
          );
          const before = yield* Effect.sync(() => readLegacyState(databasePath));
          const boundaries: Array<{
            readonly finalFactBytes: number;
            readonly operation: string;
            readonly rowCount: number;
          }> = [];
          const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (boundary, transaction) => {
            boundaries.push({...boundary});
            return transaction;
          };

          const states = yield* prepareUntilReady(databasePath, capacityProtector);
          const idempotent = yield* prepareCodeGraphVectorRetirement(databasePath, capacityOptions);

          expect(states.at(-1)).toBe('ready');
          expect(states.every(state => state === 'prepared' || state === 'ready')).toBe(true);
          expect(states.length).toBeLessThanOrEqual(16);
          expect(idempotent).toEqual({state: 'ready'});
          expect(boundaries).toEqual([
            {
              finalFactBytes: CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_BYTES,
              operation: 'prepare code graph vector retirement schema',
              rowCount: CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_ROWS,
            },
          ]);
          expect(yield* Effect.sync(() => readLegacyState(databasePath))).toEqual(before);
          expect(yield* Effect.sync(() => readRetirementSchemaState(databasePath))).toMatchObject({
            retirementRows: [],
            sequenceRows: [
              {
                name: 'vector_generation_retirements',
                seq: 0,
                sequence_type: 'integer',
              },
            ],
            tableCount: 1,
            userVersion: 2,
          });
        }),
      ),
    );

    layerIt.effect('publishes the released-v2 missing pointer index under one bounded capacity protector', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-legacy-index-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          const generation = 'generation-legacy';
          const pointerCount = 8_192;
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation, snapshotId: 'snapshot-legacy', vectorCount: 3}],
              pointers: Array.from({length: pointerCount}, (_, index) => ({
                generation,
                worktreeId: index.toString(16).padStart(64, '0'),
              })),
            }),
          );
          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              database.exec('DROP INDEX vector_pointer_generation_lookup');
            }),
          );
          const before = yield* Effect.sync(() => readLegacyState(databasePath));
          const boundaries: Array<{
            readonly finalFactBytes: number;
            readonly operation: string;
            readonly rowCount: number;
          }> = [];
          let writerProbes = 0;
          const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (boundary, transaction) =>
            Effect.sync(() => {
              boundaries.push({...boundary});
              expect(readIndexSql(databasePath)).toBeUndefined();
              expect(readRetirementTableCount(databasePath)).toBe(0);
              probeImmediateWriter(databasePath);
              writerProbes += 1;
            }).pipe(Effect.andThen(transaction));

          const states = yield* prepareUntilReady(databasePath, capacityProtector);

          expect(states.at(-1)).toBe('ready');
          expect(boundaries).toEqual([
            {
              finalFactBytes:
                CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_BYTES +
                pointerCount * (64 + new TextEncoder().encode(generation).byteLength) +
                new TextEncoder().encode(STORED_POINTER_GENERATION_INDEX_SQL).byteLength,
              operation: 'prepare code graph vector retirement schema',
              rowCount: CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_ROWS + pointerCount + 1,
            },
          ]);
          expect(writerProbes).toBe(1);
          expect(readIndexSql(databasePath)).toBe(STORED_POINTER_GENERATION_INDEX_SQL);
          expect(yield* Effect.sync(() => readLegacyState(databasePath))).toEqual(before);
          expect(yield* fs.exists(`${databasePath}-wal`)).toBe(false);
          expect(yield* fs.exists(`${databasePath}-shm`)).toBe(false);
        }),
      ),
    );

    layerIt.effect('rejects a released-v2 N+1 pointer index build before capacity or writer admission', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-index-cap-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          const generation = 'generation-over-cap';
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation, snapshotId: 'snapshot-over-cap'}],
              pointers: Array.from({length: 8_193}, (_, index) => ({
                generation,
                worktreeId: index.toString(16).padStart(64, '0'),
              })),
            }),
          );
          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              database.exec('DROP INDEX vector_pointer_generation_lookup');
            }),
          );
          const before = yield* Effect.sync(() => readVectorSurfaceState(databasePath));
          const beforeSize = Number((yield* fs.stat(databasePath)).size);
          let protectors = 0;
          const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => {
            protectors += 1;
            return transaction;
          };

          const result = yield* prepareCodeGraphVectorRetirement(databasePath, {capacityProtector}).pipe(Effect.exit);

          expect(result._tag).toBe('Failure');
          expect(protectors).toBe(0);
          expect(yield* Effect.sync(() => readVectorSurfaceState(databasePath))).toEqual(before);
          expect(Number((yield* fs.stat(databasePath)).size)).toBe(beforeSize);
          expect(yield* fs.exists(`${databasePath}-wal`)).toBe(false);
          expect(yield* fs.exists(`${databasePath}-shm`)).toBe(false);
        }),
      ),
    );

    layerIt.effect('fails before capacity when canonical r1 loses its pointer-generation index', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-r1-index-loss-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          const retiredWorktree = 'a'.repeat(64);
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [
                {generation: 'generation-retired', snapshotId: 'snapshot-retired'},
                {generation: 'generation-live', snapshotId: 'snapshot-live'},
              ],
              pointers: [
                {generation: 'generation-retired', worktreeId: retiredWorktree},
                {generation: 'generation-live', worktreeId: 'b'.repeat(64)},
              ],
            }),
          );
          yield* prepareUntilReady(databasePath);
          yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
            expectedSnapshotId: 'snapshot-retired',
            worktreeId: retiredWorktree,
          });
          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              database.exec('DROP INDEX vector_pointer_generation_lookup');
            }),
          );
          const before = yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath));
          const beforeSize = Number((yield* fs.stat(databasePath)).size);
          let protectors = 0;
          const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => {
            protectors += 1;
            return transaction;
          };

          const error = yield* prepareCodeGraphVectorRetirement(databasePath, {capacityProtector}).pipe(Effect.flip);

          expectPathFreeError(error, databasePath);
          expect(before.retirements).toHaveLength(1);
          expect(protectors).toBe(0);
          expect(yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath))).toEqual(before);
          expect(Number((yield* fs.stat(databasePath)).size)).toBe(beforeSize);
          expect(yield* fs.exists(`${databasePath}-wal`)).toBe(false);
          expect(yield* fs.exists(`${databasePath}-shm`)).toBe(false);
        }),
      ),
    );

    layerIt.effect('does not heal damaged r1 or stray sequence authority through legacy index preparation', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-partial-r1-'});
          const scenarios = [
            {kind: 'damaged-r1', name: 'lost-singleton-and-sequence'},
            {kind: 'stray-sequence', name: 'exact-sequence', sequenceName: 'vector_generation_retirements'},
            {kind: 'stray-sequence', name: 'case-sequence', sequenceName: 'VECTOR_GENERATION_RETIREMENTS'},
            {
              kind: 'stray-sequence',
              name: 'blob-sequence',
              sequenceName: new TextEncoder().encode('vector_generation_retirements'),
            },
          ] as const;

          yield* Effect.forEach(
            scenarios,
            scenario =>
              Effect.gen(function* () {
                const databasePath = path.join(root, `${scenario.name}.sqlite`);
                const worktreeId = 'a'.repeat(64);
                yield* Effect.sync(() =>
                  seedVectorDatabase(databasePath, {
                    generations: [{generation: 'generation-retired', snapshotId: 'snapshot-retired'}],
                    pointers: [{generation: 'generation-retired', worktreeId}],
                  }),
                );
                if (scenario.kind === 'damaged-r1') {
                  yield* prepareUntilReady(databasePath);
                  yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
                    expectedSnapshotId: 'snapshot-retired',
                    worktreeId,
                  });
                }
                yield* Effect.sync(() =>
                  withWritableDatabase(databasePath, database => {
                    database.exec('DROP INDEX vector_pointer_generation_lookup');
                    if (scenario.kind === 'damaged-r1') {
                      database.exec(`
                        DELETE FROM vector_retirement_state;
                        DELETE FROM sqlite_sequence WHERE name = 'vector_generation_retirements';
                      `);
                      return;
                    }
                    database.exec(`
                      CREATE TABLE sequence_seed (id INTEGER PRIMARY KEY AUTOINCREMENT);
                      DROP TABLE sequence_seed;
                    `);
                    database.query('INSERT INTO sqlite_sequence (name, seq) VALUES (?, 0)').run(scenario.sequenceName);
                  }),
                );
                const before = yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath));
                const beforeSize = Number((yield* fs.stat(databasePath)).size);
                let protectors = 0;
                const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => {
                  protectors += 1;
                  return transaction;
                };

                const error = yield* prepareCodeGraphVectorRetirement(databasePath, {capacityProtector}).pipe(
                  Effect.flip,
                );

                expectPathFreeError(error, databasePath);
                expect(before.retirements, scenario.name).toHaveLength(scenario.kind === 'damaged-r1' ? 1 : 0);
                expect(before.sequence, scenario.name).toHaveLength(scenario.kind === 'damaged-r1' ? 0 : 1);
                expect(protectors, scenario.name).toBe(0);
                expect(
                  yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath)),
                  scenario.name,
                ).toEqual(before);
                expect(Number((yield* fs.stat(databasePath)).size), scenario.name).toBe(beforeSize);
                expect(yield* fs.exists(`${databasePath}-wal`), scenario.name).toBe(false);
                expect(yield* fs.exists(`${databasePath}-shm`), scenario.name).toBe(false);
              }),
            {concurrency: 1, discard: true},
          );
        }),
      ),
    );

    layerIt.effect('rechecks absent retirement authority after the capacity protector and before publication', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-prepare-drift-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation: 'generation-live', snapshotId: 'snapshot-live'}],
              pointers: [{generation: 'generation-live', worktreeId: 'a'.repeat(64)}],
            }),
          );
          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              database.exec('DROP INDEX vector_pointer_generation_lookup');
            }),
          );
          let protectors = 0;
          let driftedState: ReturnType<typeof readVectorMigrationAuthorityState> | undefined;
          let driftedSize: number | undefined;
          const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) =>
            Effect.sync(() => {
              protectors += 1;
              withWritableDatabase(databasePath, database => {
                database.exec(CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL);
                database.exec('INSERT INTO vector_retirement_state (singleton, admission_cursor) VALUES (1, NULL)');
              });
              driftedState = readVectorMigrationAuthorityState(databasePath);
              driftedSize = Number(Bun.file(databasePath).size);
            }).pipe(Effect.andThen(transaction));

          const error = yield* prepareCodeGraphVectorRetirement(databasePath, {capacityProtector}).pipe(Effect.flip);

          expectPathFreeError(error, databasePath);
          expect(protectors).toBe(1);
          expect(driftedState).toBeDefined();
          expect(yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath))).toEqual(driftedState);
          expect(Number((yield* fs.stat(databasePath)).size)).toBe(driftedSize);
          expect(yield* Effect.sync(() => readIndexSql(databasePath))).toBeUndefined();
          expect(yield* Effect.sync(() => readRetirementTableCount(databasePath))).toBe(0);
          expect(yield* Effect.sync(() => readSchemaObjectCount(databasePath, 'vector_retirement_state'))).toBe(1);
          expect(yield* fs.exists(`${databasePath}-wal`)).toBe(false);
          expect(yield* fs.exists(`${databasePath}-shm`)).toBe(false);
        }),
      ),
    );

    layerIt.effect('rechecks frozen storage after the capacity protector and before any schema publication', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-storage-drift-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation: 'generation-live', snapshotId: 'snapshot-live'}],
              pointers: [{generation: 'generation-live', worktreeId: 'a'.repeat(64)}],
            }),
          );
          const plannedState = yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath));
          let protectors = 0;
          let driftedState: ReturnType<typeof readVectorMigrationAuthorityState> | undefined;
          let driftedSize: number | undefined;
          const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) =>
            Effect.sync(() => {
              protectors += 1;
              withWritableDatabase(databasePath, database => {
                database.exec(`
                  CREATE TABLE vector_storage_drift (payload BLOB NOT NULL);
                  INSERT INTO vector_storage_drift (payload) VALUES (zeroblob(65536));
                  DROP TABLE vector_storage_drift;
                `);
              });
              driftedState = readVectorMigrationAuthorityState(databasePath);
              driftedSize = Number(Bun.file(databasePath).size);
            }).pipe(Effect.andThen(transaction));

          const error = yield* prepareCodeGraphVectorRetirement(databasePath, {capacityProtector}).pipe(Effect.flip);

          expectPathFreeError(error, databasePath);
          expect(protectors).toBe(1);
          expect(driftedState).toBeDefined();
          expect(driftedState?.storage.freelistCount).toBeGreaterThan(plannedState.storage.freelistCount);
          expect(yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath))).toEqual(driftedState);
          expect(Number((yield* fs.stat(databasePath)).size)).toBe(driftedSize);
          expect(yield* Effect.sync(() => readIndexSql(databasePath))).toBe(STORED_POINTER_GENERATION_INDEX_SQL);
          expect(yield* Effect.sync(() => readRetirementTableCount(databasePath))).toBe(0);
          expect(yield* Effect.sync(() => readSchemaObjectCount(databasePath, 'vector_retirement_state'))).toBe(0);
          expect(yield* fs.exists(`${databasePath}-wal`)).toBe(false);
          expect(yield* fs.exists(`${databasePath}-shm`)).toBe(false);
        }),
      ),
    );

    layerIt.effect(
      'fails closed on lost or corrupt AUTOINCREMENT authority and rolls back safe-integer exhaustion',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-sequence-'});
            const corruptions = [
              {
                mutate: (database: Database) =>
                  database.exec("DELETE FROM sqlite_sequence WHERE name = 'vector_generation_retirements'"),
                name: 'missing',
              },
              {
                mutate: (database: Database) =>
                  database
                    .query('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)')
                    .run('vector_generation_retirements', 0),
                name: 'duplicate',
              },
              {
                mutate: (database: Database) =>
                  database.exec("UPDATE sqlite_sequence SET seq = X'01' WHERE name = 'vector_generation_retirements'"),
                name: 'blob',
              },
              {
                mutate: (database: Database) =>
                  database
                    .query('UPDATE sqlite_sequence SET seq = ? WHERE name = ?')
                    .run(Number.MAX_SAFE_INTEGER + 1, 'vector_generation_retirements'),
                name: 'unsafe',
              },
            ] as const;

            yield* Effect.forEach(
              corruptions,
              corruption =>
                Effect.gen(function* () {
                  const databasePath = path.join(root, `${corruption.name}.sqlite`);
                  yield* Effect.sync(() =>
                    seedVectorDatabase(databasePath, {
                      generations: [
                        {generation: 'generation-live', snapshotId: 'snapshot-live'},
                        {generation: 'generation-new', snapshotId: 'snapshot-new'},
                      ],
                      pointers: [{generation: 'generation-live', worktreeId: 'a'.repeat(64)}],
                    }),
                  );
                  yield* prepareUntilReady(databasePath);
                  yield* Effect.sync(() => withWritableDatabase(databasePath, corruption.mutate));
                  const before = yield* Effect.sync(() => readAuthorityState(databasePath));

                  yield* Effect.sync(() =>
                    withWritableDatabase(databasePath, database => {
                      expect(() => upsertVectorPointer(database, 'a'.repeat(64), 'generation-new')).toThrow();
                    }),
                  );
                  expect(yield* Effect.sync(() => readAuthorityState(databasePath)), corruption.name).toEqual(before);

                  const result = yield* prepareCodeGraphVectorRetirement(databasePath, capacityOptions).pipe(
                    Effect.exit,
                  );

                  expect(result._tag, corruption.name).toBe('Failure');
                  expect(yield* Effect.sync(() => readAuthorityState(databasePath)), corruption.name).toEqual(before);
                }),
              {concurrency: 1, discard: true},
            );

            const exhaustedPath = path.join(root, 'exhausted.sqlite');
            const worktreeId = 'b'.repeat(64);
            yield* Effect.sync(() =>
              seedVectorDatabase(exhaustedPath, {
                generations: [
                  {generation: 'generation-exhausted', snapshotId: 'snapshot-exhausted'},
                  {generation: 'generation-new', snapshotId: 'snapshot-new'},
                ],
                pointers: [{generation: 'generation-exhausted', worktreeId}],
              }),
            );
            yield* prepareUntilReady(exhaustedPath);
            yield* Effect.sync(() =>
              withWritableDatabase(exhaustedPath, database => {
                database
                  .query('UPDATE sqlite_sequence SET seq = ? WHERE name = ?')
                  .run(Number.MAX_SAFE_INTEGER, 'vector_generation_retirements');
              }),
            );
            const beforeExhausted = yield* Effect.sync(() => readAuthorityState(exhaustedPath));

            yield* Effect.sync(() =>
              withWritableDatabase(exhaustedPath, database => {
                expect(() => upsertVectorPointer(database, worktreeId, 'generation-new')).toThrow();
              }),
            );

            expect(yield* Effect.sync(() => readAuthorityState(exhaustedPath))).toEqual(beforeExhausted);

            const behindPath = path.join(root, 'behind-maximum.sqlite');
            const retiredWorktree = 'c'.repeat(64);
            const liveWorktree = 'd'.repeat(64);
            yield* Effect.sync(() =>
              seedVectorDatabase(behindPath, {
                generations: [
                  {generation: 'generation-retired', snapshotId: 'snapshot-retired'},
                  {generation: 'generation-live', snapshotId: 'snapshot-live'},
                  {generation: 'generation-next', snapshotId: 'snapshot-next'},
                ],
                pointers: [
                  {generation: 'generation-retired', worktreeId: retiredWorktree},
                  {generation: 'generation-live', worktreeId: liveWorktree},
                ],
              }),
            );
            yield* prepareUntilReady(behindPath);
            yield* deleteCodeGraphVectorPointerWithRetirement(behindPath, {
              expectedSnapshotId: 'snapshot-retired',
              worktreeId: retiredWorktree,
            });
            yield* Effect.sync(() =>
              withWritableDatabase(behindPath, database => {
                database
                  .query('UPDATE sqlite_sequence SET seq = 0 WHERE name = ?')
                  .run('vector_generation_retirements');
              }),
            );
            const beforeBehind = yield* Effect.sync(() => readAuthorityState(behindPath));

            yield* Effect.sync(() =>
              withWritableDatabase(behindPath, database => {
                expect(() => upsertVectorPointer(database, liveWorktree, 'generation-next')).toThrow();
              }),
            );
            const behindResult = yield* prepareCodeGraphVectorRetirement(behindPath, capacityOptions).pipe(Effect.exit);

            expect(behindResult._tag).toBe('Failure');
            expect(yield* Effect.sync(() => readAuthorityState(behindPath))).toEqual(beforeBehind);
          }),
        ),
    );

    layerIt.effect('marks the last pointer displaced by published UPDATE and UPSERT writers', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-pointer-'});
          const worktreeId = 'a'.repeat(64);
          const scenarios = [
            {
              mutate: (database: Database) =>
                database
                  .query('UPDATE vector_pointers SET generation = ? WHERE worktree_id = ?')
                  .run('generation-new', worktreeId),
              name: 'update',
            },
            {
              mutate: (database: Database) =>
                database
                  .query(
                    `INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)
                     ON CONFLICT(worktree_id) DO UPDATE SET generation = excluded.generation`,
                  )
                  .run(worktreeId, 'generation-new'),
              name: 'upsert',
            },
          ] as const;

          yield* Effect.forEach(
            scenarios,
            scenario =>
              Effect.gen(function* () {
                const databasePath = path.join(root, `${scenario.name}.sqlite`);
                yield* Effect.sync(() =>
                  seedVectorDatabase(databasePath, {
                    generations: [
                      {generation: 'generation-old', snapshotId: 'snapshot-old', vectorCount: 3},
                      {generation: 'generation-new', snapshotId: 'snapshot-new'},
                    ],
                    pointers: [{generation: 'generation-old', worktreeId}],
                  }),
                );
                yield* prepareUntilReady(databasePath);

                yield* Effect.sync(() => withWritableDatabase(databasePath, scenario.mutate));

                const markers = yield* Effect.sync(() => readRetirementRows(databasePath));
                expect(markers, scenario.name).toHaveLength(1);
                expect(Object.values(markers[0]), scenario.name).toEqual(
                  expect.arrayContaining(['generation-old', 'snapshot-old', worktreeId]),
                );
              }),
            {concurrency: 1, discard: true},
          );
        }),
      ),
    );

    layerIt.effect('waits for the last shared pointer displacement and binds the marker to that writer', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-shared-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          const firstWorktree = 'a'.repeat(64);
          const lastWorktree = 'b'.repeat(64);
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [
                {generation: 'generation-shared', snapshotId: 'snapshot-shared', vectorCount: 2},
                {generation: 'generation-new', snapshotId: 'snapshot-new'},
              ],
              pointers: [
                {generation: 'generation-shared', worktreeId: firstWorktree},
                {generation: 'generation-shared', worktreeId: lastWorktree},
              ],
            }),
          );
          yield* prepareUntilReady(databasePath);

          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              database
                .query('UPDATE vector_pointers SET generation = ? WHERE worktree_id = ?')
                .run('generation-new', firstWorktree);
            }),
          );
          expect(yield* Effect.sync(() => readRetirementRows(databasePath))).toEqual([]);

          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              database
                .query(
                  `INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)
                   ON CONFLICT(worktree_id) DO UPDATE SET generation = excluded.generation`,
                )
                .run(lastWorktree, 'generation-new');
            }),
          );
          const markers = yield* Effect.sync(() => readRetirementRows(databasePath));
          expect(markers).toHaveLength(1);
          expect(Object.values(markers[0])).toEqual(
            expect.arrayContaining(['generation-shared', 'snapshot-shared', lastWorktree]),
          );
        }),
      ),
    );

    layerIt.effect('rolls back an unapproved broad old-writer pointer delete without creating markers', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-broad-delete-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation: 'generation-shared', snapshotId: 'snapshot-shared'}],
              pointers: Array.from({length: 128}, (_, index) => ({
                generation: 'generation-shared',
                worktreeId: index.toString(16).padStart(64, '0'),
              })),
            }),
          );
          yield* prepareUntilReady(databasePath);
          const before = yield* Effect.sync(() => readLegacyState(databasePath));

          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              expect(() => database.exec('DELETE FROM vector_pointers')).toThrow();
            }),
          );

          expect(yield* Effect.sync(() => readLegacyState(databasePath))).toEqual(before);
          expect(yield* Effect.sync(() => readRetirementRows(databasePath))).toEqual([]);
        }),
      ),
    );

    layerIt.effect('authorizes one exact pointer deletion and clears the single-use authority while marking', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-exact-delete-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          const worktreeId = 'a'.repeat(64);
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation: 'generation-exact', snapshotId: 'snapshot-exact'}],
              pointers: [{generation: 'generation-exact', worktreeId}],
            }),
          );
          yield* prepareUntilReady(databasePath);
          const beforeWrongSnapshot = yield* Effect.sync(() => readAuthorityState(databasePath));

          yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
            expectedSnapshotId: 'snapshot-other',
            worktreeId,
          });
          expect(yield* Effect.sync(() => readAuthorityState(databasePath))).toEqual(beforeWrongSnapshot);

          yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
            expectedSnapshotId: 'snapshot-exact',
            worktreeId,
          });

          const after = yield* Effect.sync(() => readLegacyState(databasePath));
          expect(after.pointers).toEqual([]);
          const markers = yield* Effect.sync(() => readRetirementRows(databasePath));
          expect(markers).toHaveLength(1);
          expect(Object.values(markers[0])).toEqual(
            expect.arrayContaining(['generation-exact', 'snapshot-exact', worktreeId]),
          );
          expect(yield* Effect.sync(() => readPointerDeleteAuthority(databasePath))).toEqual({
            generation: null,
            snapshot: null,
            worktree: null,
          });
        }),
      ),
    );

    layerIt.effect('rejects a marker with live pointers before pointer-retirement capacity admission', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-pointer-marker-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          const generation = 'generation-corrupt-marker';
          const snapshotId = 'snapshot-corrupt-marker';
          const worktreeId = 'a'.repeat(64);
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation, snapshotId}],
              pointers: [
                {generation, worktreeId},
                {generation, worktreeId: 'b'.repeat(64)},
              ],
            }),
          );
          yield* prepareUntilReady(databasePath);
          yield* Effect.sync(() =>
            insertCorruptRetirementMarker(databasePath, {deleteAuthorized: 0, generation, snapshotId}),
          );
          const before = yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath));
          let protectors = 0;
          const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => {
            protectors += 1;
            return transaction;
          };

          const error = yield* retireCodeGraphVectorPointerWithCapacity(
            databasePath,
            {expectedSnapshotId: snapshotId, worktreeId},
            {capacityProtector},
          ).pipe(Effect.flip);

          expectPathFreeError(error, databasePath);
          expect(before.legacy.pointers).toHaveLength(2);
          expect(before.retirements).toHaveLength(1);
          expect(protectors).toBe(0);
          expect(yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath))).toEqual(before);
          expect(yield* fs.exists(`${databasePath}-wal`)).toBe(false);
          expect(yield* fs.exists(`${databasePath}-shm`)).toBe(false);
        }),
      ),
    );

    layerIt.effect('rolls back every generation mutation when the exact revision is exhausted', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-revision-max-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [
                {generation: 'generation-delete', snapshotId: 'snapshot-delete'},
                {generation: 'generation-update', snapshotId: 'snapshot-update'},
              ],
              pointers: [{generation: 'generation-update', worktreeId: 'a'.repeat(64)}],
            }),
          );
          yield* prepareUntilReady(databasePath);
          expect(yield* admitOneCodeGraphVectorRetirementWithCapacity(databasePath, capacityOptions)).toMatchObject({
            generation: 'generation-delete',
            state: 'admitted',
          });
          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              database.exec(
                `UPDATE vector_generation_retirements
                 SET delete_authorized = 1
                 WHERE generation = 'generation-delete'`,
              );
              database
                .query('UPDATE vector_retirement_state SET generation_revision = ? WHERE singleton = 1')
                .run(Number.MAX_SAFE_INTEGER);
            }),
          );
          const before = yield* Effect.sync(() => readRetirementDataState(databasePath));

          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              expect(() => insertGeneration(database, 'generation-insert', 'snapshot-insert', 0)).toThrow(
                /generation revision is exhausted/i,
              );
            }),
          );
          expect(yield* Effect.sync(() => readRetirementDataState(databasePath))).toEqual(before);

          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              expect(() =>
                database.exec(
                  `UPDATE vector_generations
                   SET snapshot_id = 'snapshot-update-changed'
                   WHERE generation = 'generation-update'`,
                ),
              ).toThrow(/generation revision is exhausted/i);
            }),
          );
          expect(yield* Effect.sync(() => readRetirementDataState(databasePath))).toEqual(before);

          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              expect(() =>
                database.exec("DELETE FROM vector_generations WHERE generation = 'generation-delete'"),
              ).toThrow(/generation revision is exhausted/i);
            }),
          );
          expect(yield* Effect.sync(() => readRetirementDataState(databasePath))).toEqual(before);
        }),
      ),
    );

    layerIt.effect('publishes clean revisions under capacity and preserves them without generation mutation', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-clean-revision-'});
          const emptyPath = path.join(root, 'empty.sqlite');
          yield* Effect.sync(() => seedVectorDatabase(emptyPath, {generations: []}));
          yield* prepareUntilReady(emptyPath);
          let emptyProtectors = 0;
          const emptyCapacity: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => {
            emptyProtectors += 1;
            return transaction;
          };

          expect(
            yield* admitOneCodeGraphVectorRetirementWithCapacity(emptyPath, {capacityProtector: emptyCapacity}),
          ).toEqual({state: 'wrapped'});
          const emptyClean = yield* Effect.sync(() => readRetirementDataState(emptyPath));
          expect(emptyClean.state).toEqual([
            {
              admission_cursor: null,
              admission_scan_revision: null,
              clean_generation_revision: 0,
              generation_revision: 0,
              pointer_delete_generation: null,
              pointer_delete_snapshot_id: null,
              pointer_delete_worktree_id: null,
              singleton: 1,
            },
          ]);
          expect(yield* inspectCodeGraphVectorRetirementWork(emptyPath)).toEqual({state: 'clean'});
          expect(
            yield* admitOneCodeGraphVectorRetirementWithCapacity(emptyPath, {capacityProtector: emptyCapacity}),
          ).toEqual({state: 'empty'});
          expect(emptyProtectors).toBe(1);
          expect(yield* Effect.sync(() => readRetirementDataState(emptyPath))).toEqual(emptyClean);

          const scannedPath = path.join(root, 'scanned.sqlite');
          yield* Effect.sync(() =>
            seedVectorDatabase(scannedPath, {
              generations: [
                {generation: 'generation-a', snapshotId: 'snapshot-a'},
                {generation: 'generation-z', snapshotId: 'snapshot-z'},
              ],
              pointers: [
                {generation: 'generation-a', worktreeId: 'a'.repeat(64)},
                {generation: 'generation-z', worktreeId: 'b'.repeat(64)},
              ],
            }),
          );
          yield* prepareUntilReady(scannedPath);
          expect(yield* admitOneCodeGraphVectorRetirementWithCapacity(scannedPath, capacityOptions)).toMatchObject({
            generation: 'generation-a',
            state: 'advanced',
          });
          expect(yield* admitOneCodeGraphVectorRetirementWithCapacity(scannedPath, capacityOptions)).toMatchObject({
            generation: 'generation-z',
            state: 'advanced',
          });
          expect(yield* admitOneCodeGraphVectorRetirementWithCapacity(scannedPath, capacityOptions)).toEqual({
            state: 'wrapped',
          });
          const scannedClean = yield* Effect.sync(() => readRetirementDataState(scannedPath));
          expect(scannedClean.state[0]).toMatchObject({
            admission_cursor: null,
            admission_scan_revision: null,
            clean_generation_revision: 0,
            generation_revision: 0,
          });
          expect(yield* inspectCodeGraphVectorRetirementWork(scannedPath)).toEqual({state: 'clean'});
          expect(yield* admitOneCodeGraphVectorRetirementWithCapacity(scannedPath, capacityOptions)).toEqual({
            state: 'empty',
          });
          expect(yield* Effect.sync(() => readRetirementDataState(scannedPath))).toEqual(scannedClean);
        }),
      ),
    );

    layerIt.effect('restarts an active admission scan after insert, update, or authorized delete', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-scan-revision-'});
          const scenarios = ['insert', 'update', 'delete'] as const;

          for (const scenario of scenarios) {
            const databasePath = path.join(root, `${scenario}.sqlite`);
            yield* Effect.sync(() =>
              seedVectorDatabase(databasePath, {
                generations: [
                  {generation: 'generation-a', snapshotId: 'snapshot-a'},
                  ...(scenario === 'insert' ? [] : [{generation: 'generation-z', snapshotId: 'snapshot-z'}]),
                ],
                pointers: [
                  {generation: 'generation-a', worktreeId: 'a'.repeat(64)},
                  ...(scenario === 'update' ? [{generation: 'generation-z', worktreeId: 'b'.repeat(64)}] : []),
                ],
              }),
            );
            yield* prepareUntilReady(databasePath);
            if (scenario === 'delete') {
              yield* Effect.sync(() =>
                withWritableDatabase(databasePath, database => {
                  database.exec(
                    `INSERT INTO vector_generation_retirements (
                       generation, snapshot_id, retired_by_worktree_id
                     ) VALUES ('generation-z', 'snapshot-z', NULL);
                     UPDATE vector_generation_retirements
                     SET delete_authorized = 1
                     WHERE generation = 'generation-z';`,
                  );
                }),
              );
            }
            expect(yield* admitOneCodeGraphVectorRetirementWithCapacity(databasePath, capacityOptions)).toMatchObject({
              generation: 'generation-a',
              state: 'advanced',
            });

            yield* Effect.sync(() =>
              withWritableDatabase(databasePath, database => {
                if (scenario === 'insert') {
                  insertGeneration(database, 'generation-0', 'snapshot-0', 0);
                } else if (scenario === 'update') {
                  database.exec(
                    `UPDATE vector_generations
                     SET snapshot_id = 'snapshot-z-updated'
                     WHERE generation = 'generation-z'`,
                  );
                } else {
                  database.exec("DELETE FROM vector_generations WHERE generation = 'generation-z'");
                }
              }),
            );

            const resetPlan = yield* planCodeGraphVectorRetirementAdmission(databasePath);
            expect(resetPlan.state, scenario).toBe('planned');
            if (resetPlan.state !== 'planned')
              return yield* Effect.die(TestError.make({message: 'Expected a revision reset plan.'}));
            expect(yield* commitCodeGraphVectorRetirementAdmission(databasePath, resetPlan), scenario).toEqual({
              state: 'restarted',
            });
            const state = yield* Effect.sync(() => readRetirementDataState(databasePath).state[0]);
            expect(state, scenario).toMatchObject({
              admission_cursor: null,
              admission_scan_revision: null,
              clean_generation_revision: null,
              generation_revision: 1,
            });
            expect((yield* planCodeGraphVectorRetirementAdmission(databasePath)).state, scenario).toBe('planned');
            expect(yield* inspectCodeGraphVectorRetirementWork(databasePath), scenario).toEqual({state: 'admission'});
          }
        }),
      ),
    );

    layerIt.effect('rejects impossible clean and active-scan revision relationships before capacity', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-corrupt-revision-'});
          const scenarios = [
            {
              cleanRevision: 0,
              generationRevision: 0,
              name: 'active-clean-current',
              scanRevision: 0,
            },
            {
              cleanRevision: 2,
              generationRevision: 3,
              name: 'clean-after-scan',
              scanRevision: 1,
            },
          ] as const;

          for (const scenario of scenarios) {
            const databasePath = path.join(root, `${scenario.name}.sqlite`);
            yield* Effect.sync(() =>
              seedVectorDatabase(databasePath, {
                generations: [{generation: 'generation-a', snapshotId: 'snapshot-a'}],
                pointers: [{generation: 'generation-a', worktreeId: 'a'.repeat(64)}],
              }),
            );
            yield* prepareUntilReady(databasePath);
            yield* Effect.sync(() =>
              withWritableDatabase(databasePath, database => {
                database.exec('PRAGMA ignore_check_constraints = ON');
                try {
                  database
                    .query(
                      `UPDATE vector_retirement_state
                       SET admission_cursor = 'generation-a',
                           admission_scan_revision = ?,
                           clean_generation_revision = ?,
                           generation_revision = ?
                       WHERE singleton = 1`,
                    )
                    .run(scenario.scanRevision, scenario.cleanRevision, scenario.generationRevision);
                } finally {
                  database.exec('PRAGMA ignore_check_constraints = OFF');
                }
              }),
            );
            const before = yield* Effect.sync(() => readRetirementDataState(databasePath));
            yield* Effect.sync(() =>
              withWritableDatabase(databasePath, database => {
                if (scenario.name === 'active-clean-current') {
                  expect(() => insertGeneration(database, 'generation-b', 'snapshot-b', 0)).toThrow(
                    /marker authority is incompatible/i,
                  );
                } else {
                  expect(() =>
                    database.exec(
                      `UPDATE vector_generations
                       SET snapshot_id = 'snapshot-a-changed'
                       WHERE generation = 'generation-a'`,
                    ),
                  ).toThrow(/marker authority is incompatible/i);
                }
              }),
            );
            expect(yield* Effect.sync(() => readRetirementDataState(databasePath)), scenario.name).toEqual(before);
            let protectors = 0;
            const error = yield* admitOneCodeGraphVectorRetirementWithCapacity(databasePath, {
              capacityProtector: (_boundary, transaction) => {
                protectors += 1;
                return transaction;
              },
            }).pipe(Effect.flip);

            expectPathFreeError(error, databasePath);
            expect(protectors, scenario.name).toBe(0);
            expect(yield* Effect.sync(() => readRetirementDataState(databasePath)), scenario.name).toEqual(before);
          }
        }),
      ),
    );

    layerIt.effect('rejects mismatched or delete-authorized admission markers before capacity or cursor advance', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-admit-marker-'});
          const scenarios = [
            {deleteAuthorized: 0 as const, markerSnapshotId: 'snapshot-mismatch', name: 'snapshot-mismatch'},
            {deleteAuthorized: 1 as const, markerSnapshotId: 'snapshot-live', name: 'delete-authorized'},
          ];

          yield* Effect.forEach(
            scenarios,
            scenario =>
              Effect.gen(function* () {
                const databasePath = path.join(root, `${scenario.name}.sqlite`);
                const generation = 'generation-live';
                yield* Effect.sync(() =>
                  seedVectorDatabase(databasePath, {
                    generations: [{generation, snapshotId: 'snapshot-live'}],
                  }),
                );
                yield* prepareUntilReady(databasePath);
                yield* Effect.sync(() =>
                  insertCorruptRetirementMarker(databasePath, {
                    deleteAuthorized: scenario.deleteAuthorized,
                    generation,
                    snapshotId: scenario.markerSnapshotId,
                  }),
                );
                const before = yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath));
                let protectors = 0;
                const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => {
                  protectors += 1;
                  return transaction;
                };

                const error = yield* admitOneCodeGraphVectorRetirementWithCapacity(databasePath, {
                  capacityProtector,
                }).pipe(Effect.flip);

                expectPathFreeError(error, databasePath);
                expect(before.retirements).toHaveLength(1);
                expect(before.state).toEqual([
                  {
                    admission_cursor: null,
                    admission_scan_revision: null,
                    clean_generation_revision: null,
                    generation_revision: 0,
                    pointer_delete_generation: null,
                    pointer_delete_snapshot_id: null,
                    pointer_delete_worktree_id: null,
                    singleton: 1,
                  },
                ]);
                expect(protectors, scenario.name).toBe(0);
                expect(
                  yield* Effect.sync(() => readVectorMigrationAuthorityState(databasePath)),
                  scenario.name,
                ).toEqual(before);
                expect(yield* fs.exists(`${databasePath}-wal`), scenario.name).toBe(false);
                expect(yield* fs.exists(`${databasePath}-shm`), scenario.name).toBe(false);
              }),
            {concurrency: 1, discard: true},
          );
        }),
      ),
    );

    layerIt.effect('rechecks retirement authority inside admission before mutating its marker or cursor', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-admit-drift-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation: 'generation-orphan', snapshotId: 'snapshot-orphan'}],
            }),
          );
          yield* prepareUntilReady(databasePath);
          const before = yield* Effect.sync(() => readRetirementDataState(databasePath));
          let transactionStarts = 0;

          const error = yield* useVectorSqlClient(databasePath, sql =>
            admitOneCodeGraphVectorRetirement(
              beforeTransactionSqlClient(sql, () => {
                transactionStarts += 1;
                withWritableDatabase(databasePath, database => {
                  database.exec('DROP TRIGGER vector_retirement_pointer_update_mark');
                });
              }),
            ),
          ).pipe(Effect.flip);

          expectPathFreeError(error, databasePath);
          expect(transactionStarts).toBe(1);
          expect(yield* Effect.sync(() => readRetirementDataState(databasePath))).toEqual(before);
        }),
      ),
    );

    layerIt.effect('rechecks retirement authority inside an exact pointer-delete transaction', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-delete-drift-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          const worktreeId = 'a'.repeat(64);
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation: 'generation-live', snapshotId: 'snapshot-live'}],
              pointers: [{generation: 'generation-live', worktreeId}],
            }),
          );
          yield* prepareUntilReady(databasePath);
          const before = yield* Effect.sync(() => readRetirementDataState(databasePath));
          let transactionStarts = 0;

          const error = yield* useVectorSqlClient(databasePath, sql =>
            deleteCodeGraphVectorPointerWithRetirementSql(
              beforeTransactionSqlClient(sql, () => {
                transactionStarts += 1;
                withWritableDatabase(databasePath, database => {
                  database.exec('DROP TRIGGER vector_retirement_pointer_delete_guard');
                });
              }),
              {expectedSnapshotId: 'snapshot-live', worktreeId},
            ),
          ).pipe(Effect.flip);

          expectPathFreeError(error, databasePath);
          expect(transactionStarts).toBe(1);
          expect(yield* Effect.sync(() => readRetirementDataState(databasePath))).toEqual(before);
        }),
      ),
    );

    layerIt.effect('rolls back every published old-writer generation deletion while authority is unmarked', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-old-writer-'});
          const statements = [
            'DELETE FROM vector_generations',
            "DELETE FROM vector_generations WHERE state = 'building'",
            `DELETE FROM vector_generations
             WHERE NOT EXISTS (
               SELECT 1 FROM vector_pointers
               WHERE vector_pointers.generation = vector_generations.generation
             )`,
          ] as const;

          yield* Effect.forEach(
            statements,
            (statement, index) =>
              Effect.gen(function* () {
                const databasePath = path.join(root, `old-writer-${index}.sqlite`);
                yield* Effect.sync(() =>
                  seedVectorDatabase(databasePath, {
                    generations: [
                      {
                        generation: 'generation-building',
                        snapshotId: 'snapshot-building',
                        state: 'building',
                        vectorCount: 2,
                      },
                      {generation: 'generation-ready', snapshotId: 'snapshot-ready', vectorCount: 2},
                    ],
                    pointers: [{generation: 'generation-ready', worktreeId: 'a'.repeat(64)}],
                  }),
                );
                yield* prepareUntilReady(databasePath);
                const before = yield* Effect.sync(() => readLegacyState(databasePath));

                yield* Effect.sync(() =>
                  withWritableDatabase(databasePath, database => {
                    expect(() => database.exec(statement)).toThrow();
                  }),
                );

                expect(yield* Effect.sync(() => readLegacyState(databasePath))).toEqual(before);
                expect(yield* Effect.sync(() => readRetirementRows(databasePath))).toEqual([]);
              }),
            {concurrency: 1, discard: true},
          );
        }),
      ),
    );

    layerIt.effect('rejects pointer, vector, metadata, and ready-state mutation of a marked generation', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-reactivation-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          const retiredWorktree = 'a'.repeat(64);
          const liveWorktree = 'b'.repeat(64);
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [
                {generation: 'generation-retiring', snapshotId: 'snapshot-retiring', vectorCount: 2},
                {generation: 'generation-live', snapshotId: 'snapshot-live', vectorCount: 1},
              ],
              pointers: [
                {generation: 'generation-retiring', worktreeId: retiredWorktree},
                {generation: 'generation-live', worktreeId: liveWorktree},
              ],
            }),
          );
          yield* prepareUntilReady(databasePath);
          yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
            expectedSnapshotId: 'snapshot-retiring',
            worktreeId: retiredWorktree,
          });
          const before = yield* Effect.sync(() => readLegacyState(databasePath));

          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              const attempts = [
                () =>
                  database
                    .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
                    .run('c'.repeat(64), 'generation-retiring'),
                () =>
                  database
                    .query('UPDATE vector_pointers SET generation = ? WHERE worktree_id = ?')
                    .run('generation-retiring', liveWorktree),
                () =>
                  database
                    .query(
                      `INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)
                       ON CONFLICT(worktree_id) DO UPDATE SET generation = excluded.generation`,
                    )
                    .run(liveWorktree, 'generation-retiring'),
                () =>
                  database
                    .query('INSERT INTO vectors (generation, symbol_id, fingerprint, vector) VALUES (?, ?, ?, ?)')
                    .run('generation-retiring', 'late-symbol', 'late-fingerprint', new Uint8Array(16)),
                () =>
                  database
                    .query('UPDATE vectors SET generation = ? WHERE generation = ?')
                    .run('generation-retiring', 'generation-live'),
                () =>
                  database
                    .query(
                      `UPDATE vector_generations
                       SET snapshot_id = ?, model_id = ?, model_sha256 = ?, dimensions = ?,
                           template_version = ?, count = ?, created_at = ?
                       WHERE generation = ?`,
                    )
                    .run(
                      'snapshot-rewritten',
                      'model-rewritten',
                      'e'.repeat(64),
                      768,
                      2,
                      99,
                      '2000-01-01T00:00:00.000Z',
                      'generation-retiring',
                    ),
                () => {
                  database.exec('PRAGMA foreign_keys = OFF');
                  try {
                    return database
                      .query('UPDATE vector_generations SET generation = ? WHERE generation = ?')
                      .run('generation-renamed', 'generation-retiring');
                  } finally {
                    database.exec('PRAGMA foreign_keys = ON');
                  }
                },
                () =>
                  database
                    .query("UPDATE vector_generations SET state = 'ready' WHERE generation = ?")
                    .run('generation-retiring'),
              ];
              for (const attempt of attempts) expect(attempt).toThrow();
            }),
          );

          expect(yield* Effect.sync(() => readLegacyState(databasePath))).toEqual(before);
          expect(yield* Effect.sync(() => readRetirementRows(databasePath))).toHaveLength(1);
        }),
      ),
    );

    layerIt.effect(
      'rejects corrupt zero-vector generation manifests before capacity or writer admission',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-manifest-'});
            const blob = new Uint8Array(1024 * 1024);
            const text = 'x'.repeat(1024 * 1024);
            const corruptions = [
              {column: 'generation', name: 'generation-text', value: text},
              {column: 'snapshot_id', name: 'snapshot-blob', value: blob},
              {column: 'model_id', name: 'model-id-blob', value: blob},
              {column: 'model_id', name: 'model-id-text', value: text},
              {column: 'model_sha256', name: 'model-sha-blob', value: blob},
              {column: 'model_sha256', name: 'model-sha-uppercase', value: 'F'.repeat(64)},
              {column: 'dimensions', name: 'dimensions-blob', value: blob},
              {column: 'template_version', name: 'template-version-blob', value: blob},
              {column: 'count', name: 'count-blob', value: blob},
              {column: 'state', name: 'state-blob', value: blob},
              {column: 'created_at', name: 'created-at-blob', value: blob},
              {column: 'created_at', name: 'created-at-text', value: text},
            ] as const;

            yield* Effect.forEach(
              corruptions,
              corruption =>
                Effect.gen(function* () {
                  const databasePath = path.join(root, `${corruption.name}.sqlite`);
                  const generation = 'generation-corrupt';
                  const worktreeId = 'a'.repeat(64);
                  yield* Effect.sync(() =>
                    seedVectorDatabase(databasePath, {
                      generations: [{generation, snapshotId: 'snapshot-corrupt'}],
                      pointers: [{generation, worktreeId}],
                    }),
                  );
                  yield* prepareUntilReady(databasePath);
                  yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
                    expectedSnapshotId: 'snapshot-corrupt',
                    worktreeId,
                  });
                  const epoch = retirementEpoch((yield* Effect.sync(() => readRetirementRows(databasePath)))[0]);
                  yield* Effect.sync(() =>
                    corruptMarkedGeneration(databasePath, corruption.column, corruption.value, generation),
                  );
                  const before = yield* Effect.sync(() => readRetirementDataState(databasePath));
                  let protectors = 0;
                  const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => {
                    protectors += 1;
                    return transaction;
                  };

                  const error = yield* retireCodeGraphVectorGenerationPage(
                    databasePath,
                    {epoch, generation, requestedLimit: 1_000},
                    {capacityProtector},
                  ).pipe(Effect.flip);

                  expectPathFreeError(error, databasePath);
                  expect(protectors, corruption.name).toBe(0);
                  expect(yield* Effect.sync(() => readRetirementDataState(databasePath)), corruption.name).toEqual(
                    before,
                  );
                }),
              {concurrency: 1, discard: true},
            );
          }),
        ),
      90_000,
    );

    layerIt.effect('rejects unexpected vector indexes and cascading child tables before any retirement receipt', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-surface-'});
          const scenarios = [
            {
              apply: (database: Database) =>
                database.exec('CREATE INDEX unexpected_vector_fingerprint_index ON vectors (fingerprint)'),
              name: 'extra-index',
              objectName: 'unexpected_vector_fingerprint_index',
            },
            {
              apply: (database: Database) => {
                database.exec(`
                  CREATE TABLE unexpected_vector_children (
                    child_id TEXT PRIMARY KEY,
                    generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE
                  )
                `);
                database
                  .query('INSERT INTO unexpected_vector_children (child_id, generation) VALUES (?, ?)')
                  .run('child-live', 'generation-live');
              },
              extraTable: 'unexpected_vector_children',
              name: 'cascade-child',
              objectName: 'unexpected_vector_children',
            },
          ] as const;

          yield* Effect.forEach(
            scenarios,
            scenario =>
              Effect.gen(function* () {
                const databasePath = path.join(root, `${scenario.name}.sqlite`);
                const generation = 'generation-live';
                const worktreeId = 'a'.repeat(64);
                yield* Effect.sync(() =>
                  seedVectorDatabase(databasePath, {
                    generations: [{generation, snapshotId: 'snapshot-live', vectorCount: 3}],
                    pointers: [{generation, worktreeId}],
                  }),
                );
                yield* prepareUntilReady(databasePath);
                yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
                  expectedSnapshotId: 'snapshot-live',
                  worktreeId,
                });
                const epoch = retirementEpoch((yield* Effect.sync(() => readRetirementRows(databasePath)))[0]);
                yield* Effect.sync(() =>
                  withWritableDatabase(databasePath, database => {
                    scenario.apply(database);
                  }),
                );
                const extraTable = 'extraTable' in scenario ? scenario.extraTable : undefined;
                const before = yield* Effect.sync(() => readRetirementDataState(databasePath, extraTable));
                let protectors = 0;
                const capacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => {
                  protectors += 1;
                  return transaction;
                };

                const prepareError = yield* prepareCodeGraphVectorRetirement(databasePath, {
                  capacityProtector,
                }).pipe(Effect.flip);
                const planError = yield* planCodeGraphVectorRetirementPage(databasePath, {
                  epoch,
                  generation,
                  requestedLimit: 1_000,
                }).pipe(Effect.flip);
                const pageError = yield* retireCodeGraphVectorGenerationPage(
                  databasePath,
                  {epoch, generation, requestedLimit: 1_000},
                  {capacityProtector},
                ).pipe(Effect.flip);

                expectPathFreeError(prepareError, databasePath);
                expectPathFreeError(planError, databasePath);
                expectPathFreeError(pageError, databasePath);
                expect(protectors, scenario.name).toBe(0);
                expect(
                  yield* Effect.sync(() => readRetirementDataState(databasePath, extraTable)),
                  scenario.name,
                ).toEqual(before);
                expect(yield* Effect.sync(() => readSchemaObjectCount(databasePath, scenario.objectName))).toBe(1);
              }),
            {concurrency: 1, discard: true},
          );
        }),
      ),
    );

    layerIt.effect('deletes at most one thousand vector rows per page and fences same-name epoch ABA', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-page-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          const worktreeId = 'a'.repeat(64);
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation: 'generation-reused', snapshotId: 'snapshot-reused', vectorCount: 2_005}],
              pointers: [{generation: 'generation-reused', worktreeId}],
            }),
          );
          yield* prepareUntilReady(databasePath);
          yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
            expectedSnapshotId: 'snapshot-reused',
            worktreeId,
          });
          const firstMarker = (yield* Effect.sync(() => readRetirementRows(databasePath)))[0];
          const firstEpoch = retirementEpoch(firstMarker);
          const expectedFirstPageBytes = yield* Effect.sync(() =>
            readVectorRetirementPageBytes(databasePath, 'generation-reused', 1_000),
          );
          const expectedGenerationBytes = yield* Effect.sync(() =>
            readVectorGenerationFactBytes(databasePath, 'generation-reused'),
          );
          const pageBoundaries: Array<{
            readonly finalFactBytes: number;
            readonly operation: string;
            readonly rowCount: number;
          }> = [];
          const firstPageProtector: CodeGraphVectorRetirementCapacityProtector = (boundary, transaction) =>
            Effect.sync(() => {
              pageBoundaries.push({...boundary});
              expect(readGenerationCounts(databasePath, 'generation-reused').vectors).toBe(2_005);
              expect(readRetirementRows(databasePath)).toEqual([firstMarker]);
              probeImmediateWriter(databasePath);
            }).pipe(Effect.andThen(transaction));

          const first = yield* retireCodeGraphVectorGenerationPage(
            databasePath,
            {
              epoch: firstEpoch,
              generation: 'generation-reused',
              requestedLimit: 10_000,
            },
            {capacityProtector: firstPageProtector},
          );
          const progressedMarker = (yield* Effect.sync(() => readRetirementRows(databasePath)))[0];
          const second = yield* retireCodeGraphVectorGenerationPage(
            databasePath,
            {
              epoch: firstEpoch,
              generation: 'generation-reused',
              requestedLimit: 10_000,
            },
            capacityOptions,
          );
          const third = yield* retireCodeGraphVectorGenerationPage(
            databasePath,
            {
              epoch: firstEpoch,
              generation: 'generation-reused',
              requestedLimit: 10_000,
            },
            capacityOptions,
          );

          expect(first).toMatchObject({remaining: true, rowsDeleted: 1_000, state: 'progress'});
          expect(pageBoundaries).toEqual([
            {
              finalFactBytes:
                expectedFirstPageBytes +
                expectedGenerationBytes +
                new TextEncoder().encode('generation-reused').byteLength +
                new TextEncoder().encode('snapshot-reused').byteLength +
                64 +
                256,
              operation: 'retire code graph vector generation',
              rowCount: 1_000 + CODE_GRAPH_VECTOR_RETIREMENT_PAGE_FIXED_ROWS,
            },
          ]);
          expect(progressedMarker).not.toEqual(firstMarker);
          expect(retirementEpoch(progressedMarker)).toBe(firstEpoch);
          expect(second).toMatchObject({remaining: true, rowsDeleted: 1_000, state: 'progress'});
          expect(third).toEqual({remaining: false, rowsDeleted: 5, state: 'complete'});
          expect(yield* Effect.sync(() => readGenerationCounts(databasePath, 'generation-reused'))).toEqual({
            generations: 0,
            retirements: 0,
            vectors: 0,
          });

          yield* Effect.sync(() =>
            withWritableDatabase(databasePath, database => {
              insertGeneration(database, 'generation-reused', 'snapshot-reused', 0);
              database
                .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
                .run(worktreeId, 'generation-reused');
            }),
          );
          yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
            expectedSnapshotId: 'snapshot-reused',
            worktreeId,
          });
          const secondMarker = (yield* Effect.sync(() => readRetirementRows(databasePath)))[0];
          const secondEpoch = retirementEpoch(secondMarker);
          expect(secondEpoch).toBeGreaterThan(firstEpoch);
          const beforeStale = yield* Effect.sync(() => ({
            legacy: readLegacyState(databasePath),
            retirements: readRetirementRows(databasePath),
          }));
          let staleProtectors = 0;
          const staleCapacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => {
            staleProtectors += 1;
            return transaction;
          };

          expect(
            yield* retireCodeGraphVectorGenerationPage(
              databasePath,
              {
                epoch: firstEpoch,
                generation: 'generation-reused',
                requestedLimit: 1_000,
              },
              {capacityProtector: staleCapacityProtector},
            ),
          ).toMatchObject({rowsDeleted: 0, state: 'stale'});
          expect(staleProtectors).toBe(0);
          expect(
            yield* Effect.sync(() => ({
              legacy: readLegacyState(databasePath),
              retirements: readRetirementRows(databasePath),
            })),
          ).toEqual(beforeStale);
        }),
      ),
    );

    layerIt.effect('keeps one vector retirement page within the thirty-two MiB payload budget', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-bytes-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          const worktreeId = 'a'.repeat(64);
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [
                {
                  generation: 'generation-bytes',
                  snapshotId: 'snapshot-bytes',
                  vectorBytes: 1024 * 1024,
                  vectorCount: 35,
                },
              ],
              pointers: [{generation: 'generation-bytes', worktreeId}],
            }),
          );
          yield* prepareUntilReady(databasePath);
          yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
            expectedSnapshotId: 'snapshot-bytes',
            worktreeId,
          });
          const marker = (yield* Effect.sync(() => readRetirementRows(databasePath)))[0];
          const epoch = retirementEpoch(marker);
          const before = yield* Effect.sync(() => readVectorPayload(databasePath, 'generation-bytes'));

          const result = yield* retireCodeGraphVectorGenerationPage(
            databasePath,
            {
              epoch,
              generation: 'generation-bytes',
              requestedLimit: 1_000,
            },
            capacityOptions,
          );
          const after = yield* Effect.sync(() => readVectorPayload(databasePath, 'generation-bytes'));

          expect(result).toMatchObject({
            remaining: true,
            rowsDeleted: before.rows - after.rows,
            state: 'progress',
          });
          expect(result.rowsDeleted).toBeGreaterThan(0);
          expect(result.rowsDeleted).toBeLessThanOrEqual(32);
          expect(before.bytes - after.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
        }),
      ),
    );

    layerIt.effect('uses the generation primary key for the exact bounded vector page without a temporary sort', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-plan-'});
          const databasePath = path.join(root, 'vectors-v2.sqlite');
          yield* Effect.sync(() =>
            seedVectorDatabase(databasePath, {
              generations: [{generation: 'generation-plan', snapshotId: 'snapshot-plan', vectorCount: 2_001}],
            }),
          );
          yield* prepareUntilReady(databasePath);
          const legacyProbe = codeGraphVectorRetirementLegacyPointerProbeStatement();
          const legacyPlan = yield* Effect.sync(() => explain(databasePath, legacyProbe));
          const statement = codeGraphVectorRetirementPageStatement('generation-plan', 10_000);
          const plan = yield* Effect.sync(() => explain(databasePath, statement));
          const authorityPlans = yield* Effect.sync(() => explainRetirementAuthority(databasePath));

          expect(legacyProbe.parameters).toEqual([8_193]);
          expect(legacyPlan).toContainEqual(expect.stringContaining('USING INDEX sqlite_autoindex_vector_pointers_1'));
          expect(legacyPlan.some(detail => detail.includes('USE TEMP B-TREE'))).toBe(false);
          expect(statement.parameters).toContain(1_000);
          expect(statement.parameters).not.toContain(10_000);
          expect(plan).toContainEqual(expect.stringContaining('SEARCH vectors USING PRIMARY KEY (generation='));
          expect(plan.some(detail => detail.includes('SCAN vectors'))).toBe(false);
          expect(plan.some(detail => detail.includes('USE TEMP B-TREE'))).toBe(false);
          expect(authorityPlans.pointer).toContainEqual(
            expect.stringContaining(
              'SEARCH vector_pointers USING COVERING INDEX vector_pointer_generation_lookup (generation=?)',
            ),
          );
          expect(authorityPlans.markerUsesAssociationIndex).toBe(true);
          expect(
            authorityPlans.globalMarker.some(
              detail =>
                detail.includes('SEARCH vector_generation_retirements USING') &&
                detail.includes('sqlite_autoindex_vector_generation_retirements_1'),
            ),
          ).toBe(true);
          expect(
            [...authorityPlans.pointer, ...authorityPlans.marker, ...authorityPlans.globalMarker].some(detail =>
              detail.includes('SCAN '),
            ),
          ).toBe(false);
          expect(
            [...authorityPlans.pointer, ...authorityPlans.marker, ...authorityPlans.globalMarker].some(detail =>
              detail.includes('USE TEMP B-TREE'),
            ),
          ).toBe(false);
        }),
      ),
    );
  });
});

function prepareUntilReady(
  databasePath: string,
  capacityProtector: CodeGraphVectorRetirementCapacityProtector = identityCapacityProtector,
) {
  return Effect.gen(function* () {
    const states: string[] = [];
    for (let step = 0; step < 16; step += 1) {
      const result = yield* prepareCodeGraphVectorRetirement(databasePath, {capacityProtector});
      states.push(result.state);
      if (result.state === 'ready') return states;
    }
    return yield* Effect.die(
      TestError.make({message: 'Vector retirement schema did not become ready within sixteen steps.'}),
    );
  });
}

interface VectorDatabaseSeed {
  readonly generations: readonly {
    readonly generation: string;
    readonly snapshotId: string;
    readonly state?: 'building' | 'ready';
    readonly vectorCount?: number;
    readonly vectorBytes?: number;
  }[];
  readonly pointers?: readonly {readonly generation: string; readonly worktreeId: string}[];
}

function seedVectorDatabase(databasePath: string, seed: VectorDatabaseSeed): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA user_version = 2;
      CREATE TABLE vector_generations (
        generation TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_sha256 TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        template_version INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK(count >= 0),
        state TEXT NOT NULL CHECK(state IN ('building', 'ready')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE vector_pointers (
        worktree_id TEXT PRIMARY KEY,
        generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE
      );
      CREATE INDEX vector_pointer_generation_lookup ON vector_pointers (generation);
      CREATE TABLE vectors (
        generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
        symbol_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (generation, symbol_id)
      ) WITHOUT ROWID;
      CREATE INDEX vector_reuse_lookup ON vectors (generation, symbol_id, fingerprint);
    `);
    const insertGeneration = database.prepare(
      `INSERT INTO vector_generations
       (generation, snapshot_id, model_id, model_sha256, dimensions, template_version, count, state, created_at)
       VALUES (?, ?, 'model-test', ?, 384, 1, ?, ?, ?)`,
    );
    const insertVector = database.prepare(
      'INSERT INTO vectors (generation, symbol_id, fingerprint, vector) VALUES (?, ?, ?, ?)',
    );
    const insertPointer = database.prepare('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)');
    database.transaction(() => {
      for (const generation of seed.generations) {
        const vectorCount = generation.vectorCount ?? 0;
        insertGeneration.run(
          generation.generation,
          generation.snapshotId,
          'f'.repeat(64),
          vectorCount,
          generation.state ?? 'ready',
          '1970-01-01T00:00:00.000Z',
        );
        const payload = new Uint8Array(generation.vectorBytes ?? 16);
        for (let index = 0; index < vectorCount; index += 1) {
          const symbolId = `symbol-${index.toString().padStart(6, '0')}`;
          insertVector.run(generation.generation, symbolId, `fingerprint-${symbolId}`, payload);
        }
      }
      for (const pointer of seed.pointers ?? []) insertPointer.run(pointer.worktreeId, pointer.generation);
    })();
  } finally {
    database.close(false);
  }
}

function readLegacyState(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      generations: database.query('SELECT * FROM vector_generations ORDER BY generation').all(),
      pointers: database.query('SELECT * FROM vector_pointers ORDER BY worktree_id').all(),
      vectors: database
        .query(
          'SELECT generation, symbol_id, fingerprint, length(vector) AS bytes FROM vectors ORDER BY generation, symbol_id',
        )
        .all(),
    };
  } finally {
    database.close(false);
  }
}

function readVectorSurfaceState(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      legacy: readLegacyState(databasePath),
      schema: database
        .query(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name LIKE 'vector_%'
              OR name LIKE 'sqlite_autoindex_vector_%'
           ORDER BY type, name`,
        )
        .all(),
      userVersion: database.query('PRAGMA user_version').get(),
    };
  } finally {
    database.close(false);
  }
}

function readVectorMigrationAuthorityState(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const hasTable = (name: string) =>
      Number(
        (
          database.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as {
            readonly count: number;
          }
        ).count,
      ) === 1;
    const hasRetirementState = hasTable('vector_retirement_state');
    const hasRetirements = hasTable('vector_generation_retirements');
    const hasSequence = hasTable('sqlite_sequence');
    return {
      legacy: readLegacyState(databasePath),
      retirements: hasRetirements
        ? database.query('SELECT * FROM vector_generation_retirements ORDER BY retirement_id').all()
        : [],
      schema: database.query('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name').all(),
      sequence: hasSequence
        ? database
            .query(
              `SELECT rowid,
                      typeof(name) AS name_type,
                      hex(CAST(name AS BLOB)) AS name_hex,
                      typeof(seq) AS seq_type,
                      seq
               FROM sqlite_sequence
               ORDER BY rowid`,
            )
            .all()
        : [],
      storage: {
        freelistCount: Number(
          (database.query('PRAGMA freelist_count').get() as {readonly freelist_count: number}).freelist_count,
        ),
        journalMode: (database.query('PRAGMA journal_mode').get() as {readonly journal_mode: string}).journal_mode,
        pageCount: Number((database.query('PRAGMA page_count').get() as {readonly page_count: number}).page_count),
        pageSize: Number((database.query('PRAGMA page_size').get() as {readonly page_size: number}).page_size),
      },
      state: hasRetirementState ? database.query('SELECT * FROM vector_retirement_state ORDER BY singleton').all() : [],
      userVersion: database.query('PRAGMA user_version').get(),
    };
  } finally {
    database.close(false);
  }
}

function readIndexSql(databasePath: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'vector_pointer_generation_lookup'")
      .get() as {readonly sql: string} | null;
    return row?.sql;
  } finally {
    database.close(false);
  }
}

function readRetirementTableCount(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return Number(
      (
        database
          .query(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'vector_generation_retirements'",
          )
          .get() as {readonly count: number}
      ).count,
    );
  } finally {
    database.close(false);
  }
}

function probeImmediateWriter(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK');
  } finally {
    database.close(false);
  }
}

function readRetirementSchemaState(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      retirementRows: database.query('SELECT * FROM vector_generation_retirements').all(),
      sequenceRows: database
        .query(
          `SELECT name, typeof(seq) AS sequence_type, seq
           FROM sqlite_sequence
           WHERE name = 'vector_generation_retirements'
           ORDER BY rowid`,
        )
        .all(),
      tableCount: Number(
        (
          database
            .query(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'vector_generation_retirements'",
            )
            .get() as {readonly count: number}
        ).count,
      ),
      userVersion: Number(
        (database.query('PRAGMA user_version').get() as {readonly user_version: number}).user_version,
      ),
    };
  } finally {
    database.close(false);
  }
}

function readAuthorityState(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      legacy: readLegacyState(databasePath),
      retirements: database.query('SELECT * FROM vector_generation_retirements ORDER BY generation').all(),
      schema: database
        .query(
          `SELECT type, name, tbl_name, sql
           FROM sqlite_master
           WHERE name LIKE 'vector_retirement_%'
              OR name LIKE 'vector_generation_retirement%'
           ORDER BY type, name`,
        )
        .all(),
      sequence: database
        .query(
          `SELECT rowid, name, typeof(seq) AS sequence_type, seq
           FROM sqlite_sequence
           WHERE name = 'vector_generation_retirements'
           ORDER BY rowid`,
        )
        .all(),
    };
  } finally {
    database.close(false);
  }
}

function readRetirementRows(databasePath: string): readonly Record<string, unknown>[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database.query('SELECT * FROM vector_generation_retirements').all() as readonly Record<string, unknown>[];
  } finally {
    database.close(false);
  }
}

function retirementEpoch(marker: Readonly<Record<string, unknown>>): number {
  const candidates = Object.entries(marker).filter(
    ([key, value]) =>
      /epoch|retirement.*id/i.test(key) && typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  );
  expect(candidates).toHaveLength(1);
  return candidates[0][1] as number;
}

function withWritableDatabase<A>(databasePath: string, use: (database: Database) => A): A {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = ON');
    return use(database);
  } finally {
    database.close(false);
  }
}

function useVectorSqlClient<A, E, R>(databasePath: string, use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* use(sql);
  }).pipe(
    provideTestLayer(
      SqliteClient.layer({
        create: false,
        disableWAL: true,
        filename: databasePath,
        readwrite: true,
      }),
    ),
  );
}

function beforeTransactionSqlClient(sql: SqlClient.SqlClient, before: () => void): SqlClient.SqlClient {
  return new Proxy(sql, {
    get(target, property, receiver) {
      if (property !== 'withTransaction') return Reflect.get(target, property, receiver) as unknown;
      return <R, E, A>(transaction: Effect.Effect<A, E, R>) =>
        Effect.sync(before).pipe(Effect.andThen(target.withTransaction(transaction)));
    },
  });
}

function expectPathFreeError(error: unknown, databasePath: string): void {
  expect(error).toBeInstanceOf(Error);
  const message = error instanceof Error ? error.message : String(error);
  expect(message.length).toBeGreaterThan(0);
  expect(message).not.toContain(databasePath);
}

function readRetirementDataState(databasePath: string, extraTable?: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      extraRows: extraTable === undefined ? [] : database.query(`SELECT * FROM ${extraTable} ORDER BY rowid`).all(),
      legacy: readLegacyState(databasePath),
      retirements: database.query('SELECT * FROM vector_generation_retirements ORDER BY retirement_id').all(),
      sequence: database
        .query(
          `SELECT rowid, name, typeof(seq) AS sequence_type, seq
           FROM sqlite_sequence
           WHERE name = 'vector_generation_retirements'
           ORDER BY rowid`,
        )
        .all(),
      state: database.query('SELECT * FROM vector_retirement_state WHERE singleton = 1').all(),
    };
  } finally {
    database.close(false);
  }
}

function readSchemaObjectCount(databasePath: string, name: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database.query('SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?').get(name) as {
      readonly count: number;
    };
    return Number(row.count);
  } finally {
    database.close(false);
  }
}

function corruptMarkedGeneration(
  databasePath: string,
  column: string,
  value: string | Uint8Array,
  generation: string,
): void {
  const trigger = CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS.find(
    candidate => candidate.name === 'vector_retirement_generation_update_guard',
  );
  if (trigger === undefined)
    throw TestError.make({message: 'Vector retirement generation-update guard is unavailable.'});
  withWritableDatabase(databasePath, database => {
    database.exec('DROP TRIGGER vector_retirement_generation_update_guard');
    try {
      database.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON');
      database.query(`UPDATE vector_generations SET ${column} = ? WHERE generation = ?`).run(value, generation);
    } finally {
      database.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON');
      database.exec(trigger.sql);
    }
  });
}

function insertCorruptRetirementMarker(
  databasePath: string,
  input: {
    readonly deleteAuthorized: 0 | 1;
    readonly generation: string;
    readonly snapshotId: string;
  },
): void {
  const trigger = CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS.find(
    candidate => candidate.name === 'vector_retirement_marker_insert_guard',
  );
  if (trigger === undefined) throw TestError.make({message: 'Vector retirement marker-insert guard is unavailable.'});
  withWritableDatabase(databasePath, database => {
    database.exec('DROP TRIGGER vector_retirement_marker_insert_guard');
    try {
      database
        .query(
          `INSERT INTO vector_generation_retirements (
             generation, snapshot_id, retired_by_worktree_id, delete_authorized
           ) VALUES (?, ?, NULL, ?)`,
        )
        .run(input.generation, input.snapshotId, input.deleteAuthorized);
    } finally {
      database.exec(trigger.sql);
    }
  });
}

function upsertVectorPointer(database: Database, worktreeId: string, generation: string): void {
  database
    .query(
      `INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)
       ON CONFLICT(worktree_id) DO UPDATE SET generation = excluded.generation`,
    )
    .run(worktreeId, generation);
}

function readPointerDeleteAuthority(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const columns = (
      database.query("PRAGMA table_info('vector_retirement_state')").all() as readonly {readonly name: string}[]
    ).map(column => column.name);
    const generation = requiredSemanticColumn(columns, /^pointer_delete_generation$/i);
    const snapshot = requiredSemanticColumn(columns, /^pointer_delete_snapshot_id$/i);
    const worktree = requiredSemanticColumn(columns, /^pointer_delete_worktree_id$/i);
    return database
      .query(
        `SELECT ${generation} AS generation, ${snapshot} AS snapshot, ${worktree} AS worktree
         FROM vector_retirement_state WHERE singleton = 1`,
      )
      .get() as {readonly generation: unknown; readonly snapshot: unknown; readonly worktree: unknown};
  } finally {
    database.close(false);
  }
}

function insertGeneration(
  database: Database,
  generation: string,
  snapshotId: string,
  vectorCount: number,
  state: 'building' | 'ready' = 'ready',
): void {
  database
    .query(
      `INSERT INTO vector_generations
       (generation, snapshot_id, model_id, model_sha256, dimensions, template_version, count, state, created_at)
       VALUES (?, ?, 'model-test', ?, 384, 1, ?, ?, ?)`,
    )
    .run(generation, snapshotId, 'f'.repeat(64), vectorCount, state, '1970-01-01T00:00:00.000Z');
}

function readGenerationCounts(databasePath: string, generation: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const count = (table: string) =>
      Number(
        (
          database.query(`SELECT COUNT(*) AS count FROM ${table} WHERE generation = ?`).get(generation) as {
            readonly count: number;
          }
        ).count,
      );
    return {
      generations: count('vector_generations'),
      retirements: count('vector_generation_retirements'),
      vectors: count('vectors'),
    };
  } finally {
    database.close(false);
  }
}

function readVectorPayload(databasePath: string, generation: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query('SELECT COUNT(*) AS rows, COALESCE(SUM(length(vector)), 0) AS bytes FROM vectors WHERE generation = ?')
      .get(generation) as {readonly bytes: number; readonly rows: number};
    return {bytes: Number(row.bytes), rows: Number(row.rows)};
  } finally {
    database.close(false);
  }
}

function readVectorGenerationFactBytes(databasePath: string, generation: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query(
        `SELECT generation, snapshot_id, model_id, model_sha256, state, created_at
         FROM vector_generations WHERE generation = ?`,
      )
      .get(generation) as Record<string, unknown>;
    const values = ['generation', 'snapshot_id', 'model_id', 'model_sha256', 'state', 'created_at'].map(column => {
      const value = row[column];
      if (typeof value !== 'string') throw TestError.make({message: `Vector generation ${column} is invalid.`});
      return value;
    });
    const encoder = new TextEncoder();
    return values.reduce((total, value) => total + encoder.encode(value).byteLength, 128);
  } finally {
    database.close(false);
  }
}

function readVectorRetirementPageBytes(databasePath: string, generation: string, limit: number): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const rows = database
      .query(
        `SELECT symbol_id, fingerprint, length(vector) AS vector_bytes
         FROM vectors
         WHERE generation = ?
         ORDER BY symbol_id
         LIMIT ?`,
      )
      .all(generation, limit) as readonly {
      readonly fingerprint: string;
      readonly symbol_id: string;
      readonly vector_bytes: number;
    }[];
    const encoder = new TextEncoder();
    const generationBytes = encoder.encode(generation).byteLength;
    return rows.reduce(
      (sum, row) =>
        sum +
        encoder.encode(row.symbol_id).byteLength +
        encoder.encode(row.fingerprint).byteLength +
        Number(row.vector_bytes) +
        generationBytes +
        64,
      0,
    );
  } finally {
    database.close(false);
  }
}

function explain(
  databasePath: string,
  statement: {readonly parameters: readonly (number | string)[]; readonly text: string},
): readonly string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return (
      database.query(`EXPLAIN QUERY PLAN ${statement.text}`).all(...statement.parameters) as readonly {
        readonly detail: string;
      }[]
    ).map(row => row.detail);
  } finally {
    database.close(false);
  }
}

function explainRetirementAuthority(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const marker = codeGraphVectorRetirementMarkerPageStatement({
      afterGeneration: 'generation-plan',
      retiredByWorktreeId: 'a'.repeat(64),
      snapshotId: 'snapshot-plan',
    });
    const globalMarker = codeGraphVectorRetirementMarkerPageStatement({afterGeneration: 'generation-plan'});
    if ([...marker.parameters, ...globalMarker.parameters].some(parameter => parameter === undefined)) {
      throw TestError.make({message: 'Production vector retirement marker statement retained an undefined binding.'});
    }
    const boundMarker = marker as {readonly parameters: readonly (number | string)[]; readonly text: string};
    const boundGlobalMarker = globalMarker as {
      readonly parameters: readonly (number | string)[];
      readonly text: string;
    };
    const pointer = database
      .query(
        `EXPLAIN QUERY PLAN
         SELECT 1 FROM vector_pointers WHERE generation = ? LIMIT 1`,
      )
      .all('generation-plan') as readonly {readonly detail: string}[];
    const markerDetails = explain(databasePath, boundMarker);
    return {
      globalMarker: explain(databasePath, boundGlobalMarker),
      marker: markerDetails,
      markerUsesAssociationIndex: markerDetails.some(
        detail =>
          detail.includes('SEARCH vector_generation_retirements USING') &&
          detail.includes('(retired_by_worktree_id=? AND snapshot_id=? AND generation>?)'),
      ),
      pointer: pointer.map(row => row.detail),
    };
  } finally {
    database.close(false);
  }
}

function requiredSemanticColumn(columns: readonly string[], pattern: RegExp): string {
  const column = columns.find(candidate => pattern.test(candidate));
  if (column === undefined || !/^[a-z_]+$/.test(column))
    throw TestError.make({message: `Missing safe vector retirement column ${pattern}.`});
  return column;
}

import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Array as EffectArray, Effect, FileSystem, Option, Path, String as EffectString} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {describe, expect, vi} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {RECALL_CHUNKER_VERSION} from '../../src/chunker.js';
import {recallIndexDatabaseFilename, readRecallPublishedGenerationHint} from '../../src/index.js';
import {recallVectorStorage} from '../../src/vector-index.js';
import {negativeSemanticReadinessHint} from '../../src/vector/negative-readiness.js';

const manifest = Option.getOrThrow(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, value => value.id === 'bge-small-en-v1.5-q8'),
);
const generation = '1-abc';
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'negative-metadata-'});
  const root = path.join(home, 'indexes/lexical');
  yield* fs.makeDirectory(root, {recursive: true});
  const fixed = path.join(root, recallIndexDatabaseFilename(false));
  const pointer = path.join(
    root,
    EffectString.replace(/\.sqlite$/, '.pointer.json')(recallIndexDatabaseFilename(false)),
  );
  const vector = recallVectorStorage.databasePath(path, home, manifest.id);
  yield* fs.makeDirectory(path.dirname(vector), {recursive: true});
  yield* Effect.acquireUseRelease(
    Effect.sync(() => new Database(fixed)),
    db =>
      Effect.sync(() => {
        db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
        db.query('INSERT INTO metadata VALUES (?, ?)').run('schema_version', '13');
        db.query('INSERT INTO metadata VALUES (?, ?)').run('initialized', 'true');
        db.query('INSERT INTO metadata VALUES (?, ?)').run('content_generation', 'new-corpus');
      }),
    db => Effect.sync(() => db.close()),
  );
  yield* recallVectorStorage.use(
    vector,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* recallVectorStorage.initialize(sql);
      yield* sql`INSERT INTO vector_generations
      (generation, job_id, corpus_generation, model_id, model_sha256, dimensions, embedding_recipe,
       chunker_version, normalized, chunk_count, state, created_at, scope_mapping_version)
      VALUES (${generation}, ${EffectString.repeat(64)('a')}, 'old-corpus', ${manifest.id}, ${manifest.sha256},
       ${manifest.dimensions}, ${recallVectorStorage.recipe(manifest)}, ${RECALL_CHUNKER_VERSION}, 'l2', 0, 'ready', 'now', 1)`;
      yield* sql`INSERT INTO vector_pointer VALUES (1, ${generation})`;
    }),
  );
  return {
    fs,
    path,
    home,
    root,
    pointer,
    fixed,
    vector,
    config: {account: 'local', user: 'test', agentContextHome: home},
  };
});
const useDatabase = <A>(filename: string, use: (db: Database) => A) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Database(filename)),
    db => Effect.sync(() => use(db)),
    db => Effect.sync(() => db.close()),
  );
describe('negative metadata access bounds', () => {
  effectIt.layer(BunServices.layer)(it => {
    it.effect('guards the pointer before one PK lookup and never scans content', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.acquireUseRelease(
          Effect.sync(() => vi.spyOn(Database.prototype, 'query')),
          spy =>
            Effect.gen(function* () {
              expect(yield* negativeSemanticReadinessHint(f.config, manifest, recallVectorStorage)).toBe('stale');
              const queries = EffectArray.map(spy.mock.calls, call => String(call[0]));
              const pointer = Option.getOrThrow(
                EffectArray.findFirstIndex(queries, sql => /FROM vector_pointer/.test(sql)),
              );
              const selected = Option.getOrThrow(
                EffectArray.findFirstIndex(queries, sql => /FROM vector_generations/.test(sql)),
              );
              expect(pointer).toBeGreaterThanOrEqual(0);
              expect(selected).toBeGreaterThan(pointer);
              expect(EffectArray.filter(queries, sql => /FROM vector_generations/.test(sql))).toHaveLength(1);
              expect(
                EffectArray.some(queries, sql =>
                  /COUNT\(|FROM (?:documents|vector_chunks|vector_values|vector_aliases)|substr\(|CAST\(/i.test(sql),
                ),
              ).toBe(false);
              expect(queries[selected]).not.toContain("state = 'ready'");
            }),
          spy => Effect.sync(() => spy.mockRestore()),
        );
        yield* useDatabase(f.vector, db =>
          db.query('UPDATE vector_pointer SET generation=?').run(EffectString.repeat(65537)('x')),
        );
        yield* Effect.acquireUseRelease(
          Effect.sync(() => vi.spyOn(Database.prototype, 'query')),
          spy =>
            Effect.gen(function* () {
              expect(yield* negativeSemanticReadinessHint(f.config, manifest, recallVectorStorage)).toBe('unknown');
              expect(EffectArray.some(spy.mock.calls, call => /FROM vector_generations/.test(String(call[0])))).toBe(
                false,
              );
            }),
          spy => Effect.sync(() => spy.mockRestore()),
        );
      }),
    );

    for (const column of [
      'corpus_generation',
      'job_id',
      'created_at',
      'model_id',
      'model_sha256',
      'embedding_recipe',
      'normalized',
      'state',
      'dimensions',
      'chunk_count',
      'chunker_version',
      'scope_mapping_version',
    ] as const) {
      it.effect(`rejects oversized or wrong-type ${column} before payload projection`, () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* Effect.acquireUseRelease(
            Effect.sync(() => vi.spyOn(Database.prototype, 'query')),
            spy =>
              Effect.gen(function* () {
                expect(yield* negativeSemanticReadinessHint(f.config, manifest, recallVectorStorage)).toBe('stale');
                const query = EffectArray.findFirst(
                  EffectArray.map(spy.mock.calls, call => String(call[0])),
                  sql => /FROM vector_generations/.test(sql),
                );
                const source = Option.getOrThrow(query);
                yield* useDatabase(f.vector, db => {
                  db.exec('PRAGMA ignore_check_constraints=ON');
                  db.query(`UPDATE vector_generations SET ${column}=?`).run(EffectString.repeat(65537)('é'));
                  let payloadReads = 0;
                  db.function('payload_trap', (_value: unknown) => {
                    payloadReads++;
                    throw new Error('Rejected payload must not be evaluated');
                  });
                  // Reuse the actual predicate; instrument only its accepted branch independently.
                  const guarded = EffectString.replace(
                    `THEN ${column} END`,
                    `THEN payload_trap(${column}) END`,
                  )(source);
                  expect(guarded).not.toBe(source);
                  db.query(guarded).get(generation);
                  expect(payloadReads).toBe(0);
                });
                expect(yield* negativeSemanticReadinessHint(f.config, manifest, recallVectorStorage)).toBe('unknown');
              }),
            spy => Effect.sync(() => spy.mockRestore()),
          );
        }),
      );
    }

    fcEffectProp(
      it,
      'the actual lexical guard follows UTF8 byte count and rejects blobs',
      {
        text: fc
          .array(fc.constantFrom('a', 'é', '\u0000', '😀'), {minLength: 0, maxLength: 30})
          .map(chars => EffectArray.join(chars, '')),
        padding: fc.constantFrom(0, 65520, 65536, 65537),
        blob: fc.boolean(),
      },
      ({text, padding, blob}) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const value = text + EffectString.repeat(padding)('a');
          const bytes = new TextEncoder().encode(value);
          yield* useDatabase(f.fixed, db =>
            db.query("UPDATE metadata SET value=? WHERE key='content_generation'").run(blob ? bytes : value),
          );
          const actual = yield* readRecallPublishedGenerationHint(f.config);
          expect(actual).toBe(!blob && bytes.length > 0 && bytes.length <= 65536 ? value : undefined);
        }),
      {fastCheck: {numRuns: 64}},
    );

    for (const state of ['valid', 'oversized', 'malformed', 'escape', 'partial', 'growing'] as const) {
      it.effect(`bounds ${state} lexical pointers before parsing or DB access`, () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const target = f.path.join(f.root, 'generations/test.sqlite');
          yield* f.fs.makeDirectory(f.path.dirname(target), {recursive: true});
          yield* f.fs.copyFile(f.fixed, target);
          const raw =
            state === 'oversized'
              ? EffectString.repeat(8193)('x')
              : state === 'malformed'
                ? '{'
                : JSON.stringify({
                    version: 1,
                    database: state === 'escape' ? 'generations/../test.sqlite' : 'generations/test.sqlite',
                  });
          yield* f.fs.writeFileString(f.pointer, raw);
          const order: string[] = [];
          let closedRead: (() => Effect.Effect<Option.Option<Uint8Array>, unknown>) | undefined;
          const observed = FileSystem.FileSystem.of({
            ...f.fs,
            readFileString: () => Effect.die('No whole pointer read'),
            open: (...args) =>
              f.fs.open(...args).pipe(
                Effect.flatMap(file =>
                  Effect.gen(function* () {
                    const original = file.readAlloc.bind(file);
                    closedRead = () => original(1);
                    const spy = vi.spyOn(file, 'readAlloc').mockImplementation((size, options) => {
                      order.push(`read:${size}`);
                      return original(size, options).pipe(
                        Effect.map(bytes =>
                          state === 'partial'
                            ? Option.map(bytes, value => value.slice(1))
                            : state === 'growing'
                              ? Option.some(new Uint8Array(8193))
                              : bytes,
                        ),
                      );
                    });
                    const originalStat = file.stat;
                    const statSpy = vi
                      .spyOn(file, 'stat', 'get')
                      .mockReturnValue(
                        originalStat.pipe(Effect.tap(stat => Effect.sync(() => order.push(`stat:${stat.size}`)))),
                      );
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() => {
                        order.push('finalize');
                        spy.mockRestore();
                        statSpy.mockRestore();
                      }),
                    );
                    return file;
                  }),
                ),
              ),
          });
          yield* Effect.acquireUseRelease(
            Effect.sync(() => vi.spyOn(Database.prototype, 'query')),
            spy =>
              Effect.gen(function* () {
                const result = yield* readRecallPublishedGenerationHint(f.config).pipe(
                  Effect.provideService(FileSystem.FileSystem, observed),
                  Effect.option,
                );
                expect(Option.getOrUndefined(result)).toBe(state === 'valid' ? 'new-corpus' : undefined);
                expect(EffectArray.some(spy.mock.calls, call => /FROM metadata/.test(String(call[0])))).toBe(
                  state === 'valid',
                );
              }),
            spy => Effect.sync(() => spy.mockRestore()),
          );
          expect(order).toEqual([
            `stat:${new TextEncoder().encode(raw).length}`,
            ...(state === 'oversized' ? [] : ['read:8193']),
            'finalize',
          ]);
          if (!closedRead) return yield* Effect.die('Expected scoped pointer FD');
          expect((yield* closedRead().pipe(Effect.result))._tag).toBe('Failure');
        }),
      );
    }
  });
});

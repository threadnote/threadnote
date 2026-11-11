import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {Array as EffectArray, Effect, FileSystem, Layer, Path, String as EffectString} from 'effect';
import {describe, expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {nativeVectorTestsEnabled} from '@threadnote/testing/native-vector-fixture';
import {loadNativeVectorReader} from '../../src/vector/native-reader-payload.js';
import {runNativeVectorRead} from '../../src/vector/native-reader.js';
import type {NativeVectorReadRequest} from '../../src/vector/native-reader-contract.js';
import {sha256HexSync} from '@threadnote/platform/sha256';

const platform = Layer.mergeAll(
  BunServices.layer,
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: environment => environment,
          sanitizeExternal: environment => environment,
        }),
      ),
    ),
  ),
);
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(platform).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const hash = EffectString.repeat(64)('a');
interface Row {
  readonly id: string;
  readonly uri: string;
  readonly vector: readonly number[];
}
interface Hit {
  readonly id: string;
  readonly uri: string;
  readonly score: number;
}
const compare = (left: Hit, right: Hit) =>
  right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

// Frozen pre-native oracle, test-only: ordered scalar arithmetic and JS's real
// pinned Array.sort, including the historical 400-row page and merge topology.
function legacy(
  rows: readonly Row[],
  query: readonly number[],
  limit: number,
): readonly {uri: string; score: number}[] {
  let best: Hit[] = [];
  const end = Math.min(rows.length, limit);
  for (let start = 0; start < rows.length; start += 400) {
    const page = EffectArray.map(rows.slice(start, start + 400), row => {
      let score = 0;
      for (const [index, value] of row.vector.entries()) score += query[index] * Math.fround(value);
      return {id: row.id, uri: row.uri, score: Math.max(-1, Math.min(1, score))};
    })
      .sort(compare)
      .slice(0, Math.min(end, Math.min(400, rows.length - start)));
    best = [...best, ...page].sort(compare).slice(0, end);
  }
  const scores = new Map<string, number>();
  for (const hit of best) scores.set(hit.uri, Math.max(scores.get(hit.uri) ?? 0, Math.max(0, hit.score)));
  if (scores.has('representative'))
    scores.set('alias', Math.max(scores.get('alias') ?? 0, scores.get('representative')!));
  return EffectArray.map([...scores], ([uri, score]) => ({uri, score}));
}
const fixture = (rows: readonly Row[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'native-reader-parity-'});
    const filename = path.join(home, 'vectors.sqlite');
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(filename)),
      db => Effect.sync(() => db.close()),
    );
    db.exec(`PRAGMA user_version=5;
    CREATE TABLE vector_aliases(generation TEXT,uri TEXT,representative_uri TEXT);
    CREATE TABLE vector_chunks(generation TEXT,chunk_id TEXT,uri TEXT,fingerprint TEXT,project TEXT,approved_authoritative INTEGER,vector_id INTEGER,PRIMARY KEY(generation,chunk_id));
    CREATE TABLE vector_generations(generation TEXT,job_id TEXT,corpus_generation TEXT,model_id TEXT,model_sha256 TEXT,dimensions INTEGER,embedding_recipe TEXT,chunker_version INTEGER,normalized TEXT,chunk_count INTEGER,state TEXT,created_at TEXT,scope_mapping_version INTEGER);
    CREATE TABLE vector_pointer(singleton INTEGER,generation TEXT);
    CREATE TABLE vector_values(id INTEGER,vector_key TEXT,vector BLOB);`);
    const dimensions = rows[0]?.vector.length ?? 1;
    db.query("INSERT INTO vector_generations VALUES('1-ab',?,'corpus','model',?,?,?,1,'l2',?,'ready','created',1)").run(
      hash,
      hash,
      dimensions,
      hash,
      rows.length,
    );
    db.exec(
      "INSERT INTO vector_pointer VALUES(1,'1-ab'); INSERT INTO vector_aliases VALUES('1-ab','alias','representative');",
    );
    db.transaction(() => {
      for (const [index, row] of rows.entries()) {
        db.query('INSERT INTO vector_values VALUES(?,?,?)').run(
          index,
          String(index),
          new Uint8Array(new Float32Array(row.vector).buffer),
        );
        db.query("INSERT INTO vector_chunks VALUES('1-ab',?,?,?,NULL,0,?)").run(row.id, row.uri, 'fingerprint', index);
      }
    })();
    const predicate = {sql: '1=1', params: []};
    const request: NativeVectorReadRequest = {
      dbPath: filename,
      generation: '1-ab',
      model: {id: 'model', sha256: hash, dimensions, embeddingRecipe: hash, chunkerVersion: 1},
      expectedPreparationJobId: `idle-recall-v2:${hash}`,
      preparationIdentitySuffix: EffectString.slice(1)(JSON.stringify(['authorization', 'model', hash, 1])),
      corpusGeneration: 'corpus',
      limit: 25,
      selection: predicate,
      aliasScope: predicate,
      aliasEligibility: predicate,
    };
    const system = yield* SystemInfo;
    const binding = yield* Effect.promise(() => loadNativeVectorReader(system));
    if (binding === undefined) throw new Error('Required actual native reader is missing.');
    const read = (request_: NativeVectorReadRequest, query: readonly number[] | undefined) =>
      runNativeVectorRead(binding, request_, query);
    return {db, request, read};
  });

describe.skipIf(!nativeVectorTestsEnabled)('required actual native numeric compatibility', () => {
  effectIt.effect(
    'matches 400/401/801 page topology, mixed NaN/finite scores, duplicate representatives and every top-k cutoff',
    () =>
      Effect.gen(function* () {
        const dimensions = 384;
        const query = Array.from({length: dimensions}, () => Number.MAX_VALUE);
        const nan = [...Array.from({length: 383}, () => Math.fround(-Math.sqrt(0.0035 / 383))), Math.fround(1.0001)];
        const positive = Array.from({length: dimensions}, () => Math.fround(1 / Math.sqrt(dimensions)));
        const negative = EffectArray.map(positive, value => -value);
        for (const count of [2, 7, 8, 64, 65, 400, 401, 801]) {
          for (const duplicates of [false, true]) {
            const rows = Array.from({length: count}, (_, index) => ({
              id: EffectString.padStart(6, '0')(String(index)),
              uri: duplicates ? (index % 3 === 0 ? 'representative' : `uri${index % 17}`) : `unique${index}`,
              vector: [nan, positive, negative][(index * 31 + Math.floor(index / 9)) % 3],
            }));
            const f = yield* fixture(rows);
            for (const limit of [0, 1, 2, 7, 17, 400, 401, count, 1.9, -1, Infinity, NaN]) {
              const result = yield* f.read({...f.request, limit}, query);
              expect(result.status).toBe('success');
              if (result.status === 'success') expect(result.scores).toEqual(legacy(rows, query, limit));
            }
          }
        }
        const reverse = [
          {id: 'a', uri: 'positive', vector: positive},
          {id: 'b', uri: 'nan', vector: nan},
        ];
        const f = yield* fixture(reverse);
        const result = yield* f.read({...f.request, limit: 1}, query);
        expect(result.status === 'success' && result.scores).toEqual(legacy(reverse, query, 1));
      }).pipe(provide),
  );

  effectIt.effect('preserves ordered non-FMA accumulation, signed infinities and UTF16 cutoff order', () =>
    Effect.gen(function* () {
      const first = Math.fround(0.6),
        second = Math.fround(0.8);
      const query = [-second / first, 1 + Number.EPSILON];
      const rows = [{id: 'a', uri: 'representative', vector: [first, second]}];
      const f = yield* fixture(rows);
      const result = yield* f.read(f.request, query);
      expect(result.status === 'success' && result.scores).toEqual(legacy(rows, query, 25));
      for (const sign of [-1, 1]) {
        const overflow = yield* f.read(f.request, [sign * Number.MAX_VALUE, sign * Number.MAX_VALUE]);
        expect(overflow.status === 'success' && overflow.scores).toEqual(
          legacy(rows, [sign * Number.MAX_VALUE, sign * Number.MAX_VALUE], 25),
        );
      }
      const tied = [
        {id: '\ue000', uri: 'later', vector: [1]},
        {id: '\u{10000}', uri: 'first', vector: [1]},
      ];
      const tie = yield* fixture(tied);
      const selected = yield* tie.read({...tie.request, limit: 1}, [1]);
      expect(selected.status === 'success' && selected.scores).toEqual([{uri: 'first', score: 1}]);
    }).pipe(provide),
  );

  effectIt.effect(
    'distinguishes lossless expected metadata from SQL surrogate replacement and embedded NUL parameters',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture([{id: 'chunk', uri: 'representative', vector: [1]}]);
        for (const value of ['a\ud800b', 'a\0b', '😀']) {
          f.db.query('UPDATE vector_chunks SET project=?').run(value);
          const bound = yield* f.read({...f.request, selection: {sql: 'chunk.project=?', params: [value]}}, [1]);
          expect(bound.status === 'success' && bound.scores?.length).toBe(2);
          f.db.query('UPDATE vector_generations SET model_id=?').run(value);
          const metadata = yield* f.read({...f.request, model: {...f.request.model, id: value}}, [1]);
          expect(metadata.status).toBe(EffectString.includes('\ud800')(value) ? 'absent' : 'success');
          f.db.query("UPDATE vector_generations SET model_id='model',corpus_generation=?").run(value);
          const corpus = yield* f.read({...f.request, corpusGeneration: value}, [1]);
          expect(corpus.status).toBe(EffectString.includes('\ud800')(value) ? 'corpus-changed' : 'success');
          f.db.exec("UPDATE vector_generations SET corpus_generation='corpus'");
        }
      }).pipe(provide),
  );

  effectIt.effect('validates prepared metadata against the pinned active corpus when no corpus is requested', () =>
    Effect.gen(function* () {
      const f = yield* fixture([{id: 'chunk', uri: 'representative', vector: [1]}]);
      const corpus = 'changed\0\n"\\😀';
      const job =
        'idle-recall-v2:' +
        sha256HexSync(JSON.stringify(['idle-recall-v2', corpus, 'authorization', 'model', hash, 1]));
      f.db.query('UPDATE vector_generations SET corpus_generation=?,job_id=?').run(corpus, job);
      const result = yield* f.read({...f.request, corpusGeneration: undefined}, [1]);
      expect(result.status).toBe('success');
      const mismatch = yield* f.read({...f.request, corpusGeneration: 'corpus'}, [1]);
      expect(mismatch.status).toBe('absent');
    }).pipe(provide),
  );

  effectIt.effect('validates all rows at k0 and preserves schema/count/preparation/corpus/query error precedence', () =>
    Effect.gen(function* () {
      const f = yield* fixture([
        {id: 'a', uri: 'representative', vector: [1]},
        {id: 'z', uri: 'last', vector: [1]},
      ]);
      f.db.exec('UPDATE vector_values SET vector=zeroblob(4) WHERE id=1');
      const corrupt = yield* f.read({...f.request, limit: 0}, [1]);
      expect(corrupt.status).toBe('corrupt');
      f.db.exec('UPDATE vector_generations SET chunk_count=3');
      const count = yield* f.read({...f.request, generation: 'other', corpusGeneration: 'other'}, []);
      expect(count.status).toBe('operation-error');
      expect(count.corpusCheckRequired).toBe(false);
    }).pipe(provide),
  );
});

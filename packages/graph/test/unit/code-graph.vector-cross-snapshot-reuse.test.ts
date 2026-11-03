import * as BunServices from '@effect/platform-bun/BunServices';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Context, Effect, FileSystem, Layer, Path, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {executeCodeGraphVectorGeneration} from '../../src/embedding.js';
import {codeGraphLayout} from '../../src/layout.js';
import type {CodeGraphSnapshot, CodeGraphSymbol} from '../../src/types.js';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import {
  claimCodeGraphGeneration,
  copyCodeGraphCompatiblePrefix,
  estimateCodeGraphCompatibleCopyBytes,
  CODE_GRAPH_REUSE_BYTE_LIMIT,
  CODE_GRAPH_REUSE_PAYLOAD_ROWS,
  initializeCodeGraphGenerationSchema,
} from '../../src/vector/generation.js';
import {
  CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
  CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL,
  CODE_GRAPH_VECTORS_TABLE_SQL,
  CODE_GRAPH_VECTOR_REUSE_INDEX_SQL,
  CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL,
  initializeCodeGraphVectorRetirementSchema,
} from '../../src/vector/retirement.js';

const digest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const vector = new Uint8Array([0, 0, 128, 63, 0, 0, 0, 0]);
const fixture = Effect.gen(function* () {
  const context = yield* Layer.build(SqliteClient.layer({filename: ':memory:'}));
  const sql = Context.get(context, SqlClient.SqlClient);
  for (const definition of [
    CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
    CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL,
    CODE_GRAPH_VECTORS_TABLE_SQL,
    CODE_GRAPH_VECTOR_REUSE_INDEX_SQL,
    CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL,
  ])
    yield* sql.unsafe(definition);
  yield* initializeCodeGraphVectorRetirementSchema(sql);
  yield* initializeCodeGraphGenerationSchema(sql);
  yield* sql.unsafe(
    "INSERT INTO vector_generations VALUES ('target','target-snapshot','model',?,2,1,0,'building','now')",
    [digest],
  );
  yield* claimCodeGraphGeneration(sql, {generation: 'target', ownerToken: 'owner', requestEpoch: 'target-snapshot'});
  const source = (id: string, sha = digest, template = 1, dimensions = 2) =>
    sql.unsafe("INSERT INTO vector_generations VALUES (?,?,'model',?,?,?,1,'ready','now')", [
      id,
      id + '-snapshot',
      sha,
      dimensions,
      template,
    ]);
  const payload = (generation: string, symbol: string, bytes: Uint8Array = vector, fingerprint = symbol) =>
    sql.unsafe('INSERT INTO vectors VALUES (?,?,?,?)', [generation, symbol, fingerprint, bytes]);
  const copy = (ids: readonly string[], expectedOffset = 0, expectedCursor: string | null = null, dimensions = 2) =>
    copyCodeGraphCompatiblePrefix(sql, {
      generation: 'target',
      ownerToken: 'owner',
      worktreeId: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      expectedCursor,
      expectedOffset,
      modelId: 'model',
      modelSha256: digest,
      dimensions,
      templateVersion: 1,
      raw: EffectArray.map(ids, id => ({id, fingerprint: id, cursor: id})),
      decode: value =>
        value instanceof Uint8Array &&
        value.byteLength === dimensions * 4 &&
        new DataView(value.buffer, value.byteOffset, value.byteLength).getFloat32(0, true) === 1
          ? value
          : undefined,
    });
  return {sql, source, payload, copy};
});

const productionManifest = {...BUILTIN_MODEL_MANIFESTS[0], role: 'embedding' as const, dimensions: 2};
effectIt.layer(Layer.mergeAll(citationPlatformLayer, LocalModelCatalog.layer([productionManifest])))(it => {
  it.effect('production worktree reuse embeds only changed symbols and equals a clean generation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const catalog = yield* LocalModelCatalog;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'graph-vector-worktree-reuse-'});
      yield* selectLocalModel(home, catalog, 'embedding', productionManifest.id);
      const calls: string[] = [];
      const unexpected = () => Effect.die(new Error('Unexpected model operation.'));
      const installation = {
        bytes: productionManifest.size,
        installed: true,
        verified: true,
        partialBytes: 0,
        modelId: productionManifest.id,
        path: path.join(home, 'fake.gguf'),
      };
      const modelStore = LocalModelStore.of({
        install: unexpected,
        remove: () => Effect.succeed(false),
        path: () => installation.path,
        status: () => Effect.succeed(installation),
        verify: () => Effect.succeed(installation),
      });
      const runtime = LocalModelRuntime.of({
        diagnostics: Effect.succeed({backend: 'fixture', buildType: 'prebuilt', cpuMathCores: 1}),
        embedMany: ({inputs}) =>
          Effect.sync(() => {
            calls.push(...inputs);
            return EffectArray.map(inputs, text => [
              1,
              EffectArray.reduce(Array.from(new TextEncoder().encode(text)), 0, (sum, byte) => sum + byte) % 31,
            ]);
          }),
        generate: unexpected,
        rerank: unexpected,
      });
      const original: readonly CodeGraphSymbol[] = EffectArray.map(['Alpha', 'Beta'], (name, index) => ({
        id: name,
        contentHash: EffectString.repeat(64)(String(index)),
        documentation: 'Original ' + name,
        exported: true,
        kind: 'class',
        language: 'typescript',
        name,
        path: name + '.ts',
        qualifiedName: name,
        span: {line: 1, column: 1, endLine: 1, endColumn: 2},
      }));
      const changed = [
        original[0],
        {...original[1], documentation: 'Changed Beta', contentHash: EffectString.repeat(64)('f')},
      ];
      const snapshot = (id: string, view: string): CodeGraphSnapshot => ({
        id,
        commit: EffectString.repeat(40)('c'),
        repositoryId: EffectString.repeat(64)('a'),
        worktreeId: EffectString.repeat(64)(view),
        dirty: false,
        extractorSet: 'fixture',
        state: 'ready',
        fileCount: 2,
        symbolCount: 2,
        edgeCount: 0,
      });
      const run = (target: CodeGraphSnapshot, symbols: readonly CodeGraphSymbol[], force = false) =>
        Effect.gen(function* () {
          const layout = codeGraphLayout(path, home, target.repositoryId, target.worktreeId);
          for (let step = 0; step < 12; step++) {
            const status = yield* executeCodeGraphVectorGeneration({
              catalog,
              fs,
              path,
              layout,
              modelStore,
              runtime,
              force,
              snapshot: target,
              symbols,
              threadnoteHome: home,
              ownerToken: 'owner-' + target.worktreeId,
              maximumSteps: 1,
              maximumInferenceSymbolsPerStep: 1,
              inferenceBatchSize: 1,
              publication: {validate: Effect.void, attach: commit => commit},
            });
            if (status.ready) return status;
          }
          return yield* Effect.die(new Error('Bounded graph generation did not converge.'));
        });
      const first = yield* run(snapshot('snapshot-a', 'b'), original);
      expect(first).toMatchObject({embedded: 2, reused: 0, ready: true});
      calls.length = 0;
      const second = yield* run(snapshot('snapshot-b', 'd'), changed);
      expect(second).toMatchObject({embedded: 1, reused: 1, ready: true});
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('Changed Beta');
      const clean = yield* run(snapshot('snapshot-clean', 'e'), changed, true);
      expect(clean).toMatchObject({embedded: 2, reused: 0, ready: true});
      const layout = codeGraphLayout(path, home, EffectString.repeat(64)('a'), EffectString.repeat(64)('b'));
      const context = yield* Layer.build(
        SqliteClient.layer({filename: path.join(layout.vectorRoot, productionManifest.id, 'vectors-v2.sqlite')}),
      );
      const sql = Context.get(context, SqlClient.SqlClient);
      const payload = (worktree: string) =>
        sql.unsafe(
          'SELECT v.symbol_id,v.fingerprint,hex(v.vector) AS bytes FROM vectors v JOIN vector_pointers p ON p.generation=v.generation WHERE p.worktree_id=? ORDER BY v.symbol_id',
          [worktree],
        );
      expect(yield* payload(EffectString.repeat(64)('d'))).toEqual(yield* payload(EffectString.repeat(64)('e')));
    }).pipe(TestClock.withLive),
  );
});
function providePlatform<A, E, R>(program: Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Layer.build(BunServices.layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))),
  );
}

describe('bounded graph vector reuse across snapshots', () => {
  effectIt.effect('copies a matching prefix across multiple ready sources and checkpoints before a missing input', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.source('source-a');
      yield* f.source('source-b');
      yield* f.payload('source-a', 'one');
      yield* f.payload('source-b', 'two');
      const copied = yield* f.copy(['one', 'two', 'missing', 'one']);
      expect(copied).toMatchObject({
        consumed: 2,
        copiedBytes: 16,
        candidates: 2,
        progress: {array_offset: 2, reused: 2, embedded: 0},
      });
      expect(
        yield* f.sql.unsafe(
          'SELECT symbol_id, fingerprint, hex(vector) AS bytes FROM vectors WHERE generation = ? ORDER BY symbol_id',
          ['target'],
        ),
      ).toEqual([
        {symbol_id: 'one', fingerprint: 'one', bytes: '0000803F00000000'},
        {symbol_id: 'two', fingerprint: 'two', bytes: '0000803F00000000'},
      ]);
      expect((yield* f.copy(['missing'], 2, 'two')).consumed).toBe(0);
    }).pipe(providePlatform),
  );

  effectIt.effect('bounds raw metadata before compatibility filtering and prefers the own active source', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (let index = 0; index < 100; index++) {
        const id = 'a-' + EffectString.padStart(4, '0')(String(index));
        yield* f.source(id, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
        yield* f.sql.unsafe('INSERT INTO vector_pointers VALUES (?,?)', [
          EffectString.padStart(64, '0')(index.toString(16)),
          id,
        ]);
      }
      yield* f.source('z-compatible');
      yield* f.payload('z-compatible', 'one');
      expect(yield* f.copy(['one'])).toMatchObject({
        consumed: 0,
        candidates: 0,
        rawPointerReferences: 16,
        rawGenerationReferences: 32,
        probes: 0,
      });
      yield* f.sql.unsafe('INSERT INTO vector_pointers VALUES (?,?)', [
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        'z-compatible',
      ]);
      expect(yield* f.copy(['one'])).toMatchObject({
        consumed: 1,
        candidates: 1,
        rawPointerReferences: 16,
        rawGenerationReferences: 32,
      });
      const plan = yield* f.sql.unsafe<{detail: string}>(
        'EXPLAIN QUERY PLAN SELECT vector FROM vectors WHERE generation=? AND symbol_id=? AND fingerprint=? AND length(vector)=? LIMIT 1',
        ['z-compatible', 'one', 'one', 8],
      );
      expect(EffectArray.some(plan, row => /SEARCH vectors USING (?:PRIMARY KEY|INDEX)/u.test(row.detail))).toBe(true);
      expect(EffectArray.some(plan, row => /SCAN vectors/u.test(row.detail))).toBe(false);
    }).pipe(providePlatform),
  );

  effectIt.effect('excludes retired and recipe-mismatched sources and rejects malformed vector payloads', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.source('retired');
      yield* f.payload('retired', 'one');
      yield* f.sql.unsafe('INSERT INTO vector_generation_retirements(generation,snapshot_id) VALUES (?,?)', [
        'retired',
        'retired-snapshot',
      ]);
      yield* f.source('wrong-template', digest, 2);
      yield* f.payload('wrong-template', 'one');
      yield* f.source('wrong-dimensions', digest, 1, 1);
      yield* f.payload('wrong-dimensions', 'one');
      yield* f.source('corrupt');
      yield* f.payload('corrupt', 'one', new Uint8Array(8));
      expect(yield* f.copy(['one'])).toMatchObject({consumed: 0, copiedBytes: 0, candidates: 1});
      expect(yield* f.sql.unsafe("SELECT COUNT(*) AS count FROM vectors WHERE generation='target'")).toEqual([
        {count: 0},
      ]);
    }).pipe(providePlatform),
  );

  effectIt.effect('bounds all transported rows including corrupt candidate payloads', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const ids = Array.from({length: 60}, (_, index) => 'symbol-' + String(index));
      for (let source = 0; source < 8; source++) {
        const generation = 'source-' + String(source);
        yield* f.source(generation);
        for (const id of ids) yield* f.payload(generation, id, source === 7 ? vector : new Uint8Array(8));
      }
      const copied = yield* f.copy(ids);
      expect(copied.transportedRows).toBe(CODE_GRAPH_REUSE_PAYLOAD_ROWS);
      expect(copied.consumed).toBe(CODE_GRAPH_REUSE_PAYLOAD_ROWS / 8);
      expect(copied.copiedBytes).toBe(copied.consumed * 8);
      expect(copied.progress.array_offset).toBe(copied.consumed);
      expect(copied.consumed).toBeLessThan(ids.length);
    }).pipe(providePlatform),
  );

  effectIt.effect('bounds transported bytes even when rejected candidates exceed copied bytes', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const dimensions = 128 * 1024;
      const valid = new Uint8Array(dimensions * 4);
      new DataView(valid.buffer).setFloat32(0, 1, true);
      yield* f.sql.unsafe("UPDATE vector_generations SET dimensions=? WHERE generation='target'", [dimensions]);
      yield* f.source('a-corrupt', digest, 1, dimensions);
      yield* f.source('b-valid', digest, 1, dimensions);
      const ids = Array.from({length: 10}, (_, index) => 'symbol-' + String(index));
      for (const id of ids) {
        yield* f.payload('a-corrupt', id, new Uint8Array(valid.byteLength));
        yield* f.payload('b-valid', id, valid);
      }
      const copied = yield* f.copy(ids, 0, null, dimensions);
      expect(copied.transportedBytes).toBe(CODE_GRAPH_REUSE_BYTE_LIMIT);
      expect(copied.copiedBytes).toBe(CODE_GRAPH_REUSE_BYTE_LIMIT / 2);
      expect(copied.consumed).toBe(4);
      expect(copied.progress.array_offset).toBe(4);
    }).pipe(providePlatform),
  );

  effectIt.effect('reserves UTF-8 metadata and cursor bytes in addition to the bounded payload', () =>
    Effect.sync(() => {
      const raw = [
        {
          id: EffectString.repeat(100)('符号'),
          fingerprint: EffectString.repeat(100)('é'),
          cursor: EffectString.repeat(100)('索引'),
        },
      ];
      const utf8 = new TextEncoder();
      const metadata = EffectArray.reduce(
        raw,
        utf8.encode(raw[0].cursor).length,
        (sum, row) => sum + utf8.encode(row.id).length + utf8.encode(row.fingerprint).length,
      );
      expect(estimateCodeGraphCompatibleCopyBytes(raw, 2)).toBeGreaterThanOrEqual(metadata + vector.byteLength);
      expect(estimateCodeGraphCompatibleCopyBytes(raw, CODE_GRAPH_REUSE_BYTE_LIMIT)).toBeGreaterThanOrEqual(
        metadata + CODE_GRAPH_REUSE_BYTE_LIMIT,
      );
    }),
  );

  fcEffectProp(
    effectIt,
    'copied bytes equal the independent union oracle up to the first absent symbol',
    {
      locations: fc.array(fc.integer({min: -1, max: 2}), {minLength: 1, maxLength: 24}),
    },
    ({locations}) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const source of ['source-0', 'source-1', 'source-2']) yield* f.source(source);
        const ids = EffectArray.map(locations, (_location, index) => 'symbol-' + String(index));
        for (const [index, location] of locations.entries())
          if (location >= 0) yield* f.payload('source-' + String(location), ids[index]);
        let prefix = 0;
        while (prefix < locations.length && locations[prefix] >= 0) prefix++;
        const result = yield* f.copy(ids);
        expect(result.consumed).toBe(prefix);
        expect(result.progress.array_offset).toBe(prefix);
        expect(result.progress.reused).toBe(prefix);
        const actual = yield* f.sql.unsafe<{symbol_id: string; bytes: string}>(
          "SELECT symbol_id,hex(vector) AS bytes FROM vectors WHERE generation='target' ORDER BY symbol_id",
        );
        expect(actual).toEqual(
          EffectArray.map(ids.slice(0, prefix), id => ({symbol_id: id, bytes: '0000803F00000000'})).sort((a, b) =>
            a.symbol_id < b.symbol_id ? -1 : a.symbol_id > b.symbol_id ? 1 : 0,
          ),
        );
      }).pipe(providePlatform),
    {fastCheck: {numRuns: 24}},
  );
});

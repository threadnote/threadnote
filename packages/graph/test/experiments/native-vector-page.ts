import {BunRuntime} from '@effect/platform-bun';
import * as BunServices from '@effect/platform-bun/BunServices';
import {codeGraphLayout} from '@threadnote/graph/layout';
import type {CodeGraphSnapshot} from '@threadnote/graph/types';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {selectLocalModelForPurpose} from '@threadnote/inference/models/selection';
import {Database} from 'bun:sqlite';
import {
  Array as EffectArray,
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  String as EffectString,
} from 'effect';
import assert from 'node:assert/strict';
import {arch, cpus, platform} from 'node:os';
import {isAbsolute} from 'node:path';
import {provideScriptLayer} from '../../../../scripts/effect/errors.js';
import {ScriptSystemInfoLayer} from '../../../../scripts/effect/system-layer.js';
import {
  openRustValidator,
  pageDecoder,
  registerOptimizedSearch,
  validateTypeScriptPage,
  type Arm,
} from './native-vector-page-adapter.js';

const arms = ['stock', 'typescript', 'rust'] as const;
const isArm = (value: string): value is Arm => EffectArray.some(arms, arm => arm === value);
const [mode, ...args] = process.argv.slice(2);
const functional = mode === '--functional';
const [arm, library, rowCount, warmCount, output] = functional ? ['rust', args[0], '803', '0', args[1]] : args;

if (
  !(functional ? args.length === 2 : mode === '--timing' && args.length === 5) ||
  !isArm(arm) ||
  !library ||
  !isAbsolute(library) ||
  !output ||
  !(functional || [16, 10_000, 100_000].includes(Number(rowCount))) ||
  !Number.isInteger(Number(warmCount)) ||
  Number(warmCount) < 0 ||
  Number(warmCount) > 30
) {
  throw new Error(
    'Usage: --functional <absolute library> <output> | --timing <stock|typescript|rust> <absolute library> <16|10000|100000> <0..30> <output>',
  );
}

const documents = Number(rowCount);
const warmCalls = Number(warmCount);
const checkSubstitution = arm !== 'stock' ? registerOptimizedSearch() : undefined;
const {CodeGraphEmbeddingIndex} = await import('@threadnote/graph/embedding');
checkSubstitution?.();

const manifest = Option.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'embeddinggemma-2-q8'),
);
if (!manifest || manifest.dimensions !== 768) throw new Error('Gemma 768-dimensional manifest missing');
const dimensions = manifest.dimensions;
const cutoff = 0.7313320191591935;
const limit = 20;
const seedSymbol = 'seed';
const queryVector = functional
  ? Array.from({length: dimensions}, (_, index) => (index % 2 === 0 ? 1 : -1))
  : [1, ...Array<number>(dimensions - 1).fill(0)];
const id = (index: number) => 'vector-' + EffectString.padStart(6, '0')(String(index));
const bytesFor = (first: number, last = 0) => {
  const bytes = new Uint8Array(dimensions * 4);
  const view = new DataView(bytes.buffer);
  view.setFloat32(0, first, true);
  view.setFloat32(bytes.length - 4, last, true);
  return bytes;
};
const templates = Array.from({length: 64}, (_, index) => {
  const target =
    index === 0 && functional ? cutoff - 1e-5 : index === 1 && functional ? cutoff + 1e-5 : 0.65 + index * 0.005;
  const score = Math.fround(target);
  const tail = Math.sqrt((1 - score ** 2) / (dimensions - 1));
  const bytes = new Uint8Array(dimensions * 4);
  const view = new DataView(bytes.buffer);
  if (functional) {
    const unit = 1 / Math.sqrt(dimensions);
    const perpendicular = Math.sqrt(1 - score ** 2);
    let dot = 0;
    for (let axis = 0; axis < dimensions; axis++) {
      const across = axis % 4 < 2 ? 1 : -1;
      const queryComponent = queryVector[axis] * unit;
      const stored = Math.fround(queryComponent * (score + across * perpendicular));
      view.setFloat32(axis * 4, stored, true);
      dot += queryComponent * stored;
    }
    return {bytes, score: dot};
  }
  view.setFloat32(0, score, true);
  for (let axis = 1; axis < dimensions; axis++) {
    view.setFloat32(axis * 4, (axis + index) % 3 ? tail : -tail, true);
  }
  return {bytes, score};
});

function sourceCommit() {
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD']);
  if (head.exitCode !== 0) throw new Error('Could not read source commit');
  const commit = EffectString.trim(head.stdout.toString());
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Expected a full commit SHA');
  return commit;
}

function seedFixture(databasePath: string) {
  const database = new Database(databasePath, {strict: true});
  try {
    const active = database.query<{generation: string}, []>('SELECT generation FROM vector_pointers').get();
    assert.ok(active, 'Production setup must publish a vector generation');
    const insert = database.query('INSERT INTO vectors(generation,symbol_id,fingerprint,vector) VALUES(?,?,?,?)');
    const expected: [string, number][] = [];
    database.transaction(() => {
      database.query('DELETE FROM vectors WHERE generation=? AND symbol_id=?').run(active.generation, seedSymbol);
      for (let index = 0; index < documents; index++) {
        const symbol = id(index);
        const template = templates[(index * 29) % templates.length];
        insert.run(active.generation, symbol, symbol, template.bytes);
        if (template.score >= cutoff) expected.push([symbol, template.score]);
      }
      database.query('UPDATE vector_generations SET count=? WHERE generation=?').run(documents, active.generation);
    })();
    assert.ok(expected.length > 0, 'Synthetic fixture must exercise the hit path');
    return expected.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  } finally {
    database.close();
  }
}

function updateVectors(databasePath: string, updates: ReadonlyArray<readonly [number, Uint8Array | string]>) {
  const database = new Database(databasePath, {strict: true});
  try {
    const update = database.query('UPDATE vectors SET vector = ? WHERE symbol_id = ?');
    database.transaction(() => {
      for (const [index, value] of updates) {
        assert.equal(update.run(value, id(index)).changes, 1);
      }
    })();
  } finally {
    database.close();
  }
}

const graphLayer = CodeGraphEmbeddingIndex.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS),
      ScriptSystemInfoLayer,
      Layer.succeed(
        LocalModelRuntime,
        LocalModelRuntime.of({
          diagnostics: Effect.succeed({backend: 'synthetic', buildType: 'prebuilt', cpuMathCores: 1}),
          embedMany: ({inputs}) => Effect.succeed(EffectArray.map(inputs, () => queryVector)),
          generate: () => Effect.die('Unexpected generation'),
          rerank: () => Effect.die('Unexpected reranking'),
        }),
      ),
      Layer.succeed(
        LocalModelStore,
        LocalModelStore.of({
          install: () => Effect.die('Unexpected install'),
          path: () => 'synthetic-vector',
          remove: () => Effect.succeed(false),
          status: () => Effect.die('Unexpected status'),
          verify: () =>
            Effect.succeed({
              bytes: manifest.size,
              installed: true,
              modelId: manifest.id,
              partialBytes: 0,
              path: 'synthetic-vector',
              verified: true,
            }),
        }),
      ),
    ),
  ),
);

const hash = (bytes: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const program = Effect.scoped(
  Effect.gen(function* () {
    const source = sourceCommit();
    const firstRssBytes = process.memoryUsage.rss();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'tn-graph-vector-page-'});
    const catalog = yield* LocalModelCatalog;
    const vectors = yield* CodeGraphEmbeddingIndex;
    const layout = codeGraphLayout(path, home, EffectString.repeat(64)('a'), EffectString.repeat(64)('b'));
    const snapshot: CodeGraphSnapshot = {
      commit: source,
      dirty: false,
      edgeCount: 0,
      extractorSet: 'synthetic-vector-probe',
      fileCount: 1,
      id: 'synthetic-vector-probe',
      repositoryId: layout.checkoutId,
      state: 'ready',
      symbolCount: 1,
      worktreeId: layout.worktreeId,
    };
    yield* selectLocalModelForPurpose(home, catalog, 'graph', manifest.id);
    const seeded = yield* vectors.ensure(home, layout, snapshot, [
      {
        contentHash: EffectString.repeat(64)('a'),
        documentation: 'Synthetic graph vector fixture seed.',
        exported: true,
        id: seedSymbol,
        kind: 'class',
        language: 'typescript',
        name: 'Seed',
        path: 'src/seed.ts',
        qualifiedName: 'Seed',
        span: {column: 1, endColumn: 2, endLine: 1, line: 1},
      },
    ]);
    assert.ok(seeded.ready && seeded.embedded === 1, 'Expected one published seed vector');
    const databasePath = path.join(layout.vectorRoot, manifest.id, 'vectors-v2.sqlite');
    const expectedAll = seedFixture(databasePath);
    const expected = expectedAll.slice(0, limit);
    const afterSetupRssBytes = process.memoryUsage.rss();
    const rust =
      arm === 'rust'
        ? yield* Effect.acquireRelease(
            Effect.sync(() => openRustValidator(library)),
            handle => Effect.sync(handle.close),
          )
        : undefined;
    const decodeTypescript = pageDecoder(validateTypeScriptPage);
    const decodeRust = rust && pageDecoder(rust.validate);
    const select = (selected: Arm) => {
      if (selected === 'rust') assert.ok(decodeRust, 'Missing Rust validator');
      globalThis.threadnoteGraphVectorPrototypeDecode =
        selected === 'typescript' ? decodeTypescript : selected === 'rust' ? decodeRust : undefined;
    };
    yield* Effect.addFinalizer(() => Effect.sync(() => select('stock')));
    const search = (resultLimit = limit) => vectors.search(home, layout, snapshot.id, 'synthetic query', resultLimit);
    const capture = Effect.gen(function* () {
      const rssBeforeBytes = process.memoryUsage.rss();
      const cpuStarted = process.cpuUsage();
      const started = performance.now();
      const result = yield* search();
      const wallMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStarted);
      const rssAfterBytes = process.memoryUsage.rss();
      assert.deepEqual([...result], expected, 'Search differs from ordered exact oracle');
      return {wallMs, cpuMs: (cpu.user + cpu.system) / 1000, rssBeforeBytes, rssAfterBytes};
    });

    let evidence;
    if (functional) {
      assert.ok(rust);
      const offsetBytes = new Uint8Array(dimensions * 4 + 7).fill(0xff);
      const unaligned = offsetBytes.subarray(1, dimensions * 4 + 1);
      unaligned.set(bytesFor(0.9981, -0));
      assert.equal(rust.validate(unaligned, dimensions), 0, 'Read only the unaligned typed-array extent');
      assert.equal(rust.validate(offsetBytes, dimensions), -2_147_483_648, 'Reject invalid raw ABI length');
      for (const selected of arms) {
        select(selected);
        yield* capture;
        assert.deepEqual([...(yield* search(1))], expectedAll.slice(0, 1));
        assert.deepEqual([...(yield* search(documents))], expectedAll);
      }
      assert.ok(cutoff - templates[0].score < 0.00002 && templates[0].score < cutoff);
      assert.ok(templates[1].score - cutoff < 0.00002 && templates[1].score > cutoff);
      const nonfinite = 'Stored vector contains a non-finite component.';
      const norm = 'Stored vector is not L2-normalized.';
      const width = 'Stored vector has 4 bytes; expected 3072.';
      const binary = 'Stored vector is not a binary SQLite value.';
      const cases = [
        {
          name: 'nonfinite-before-later-size',
          message: nonfinite,
          updates: [
            [400, bytesFor(2, NaN)],
            [401, new Uint8Array(4)],
          ],
        },
        {
          name: 'size-before-later-nonfinite',
          message: width,
          updates: [
            [400, new Uint8Array(4)],
            [401, bytesFor(1, Infinity)],
          ],
        },
        {
          name: 'norm-before-later-nonfinite',
          message: norm,
          updates: [
            [400, bytesFor(0.9979)],
            [401, bytesFor(1, -Infinity)],
          ],
        },
        {
          name: 'binary-before-later-nonfinite',
          message: binary,
          updates: [
            [400, 'not a blob'],
            [401, bytesFor(1, NaN)],
          ],
        },
        {
          name: 'first-page-before-later-page',
          message: norm,
          updates: [
            [399, bytesFor(1.0021)],
            [400, new Uint8Array(4)],
          ],
        },
      ] as const;
      for (const {message, updates} of cases) {
        updateVectors(databasePath, updates);
        for (const selected of arms) {
          select(selected);
          const exit = yield* Effect.exit(search());
          assert.ok(Exit.isFailure(exit), `${selected} accepted ${message}`);
          const failure = Cause.squash(exit.cause);
          assert.ok(failure instanceof Error);
          assert.equal(failure.name, 'CodeGraphEmbeddingError');
          assert.equal(failure.message, message);
        }
        updateVectors(
          databasePath,
          EffectArray.map(updates, ([index]) => [index, templates[(index * 29) % templates.length].bytes]),
        );
      }
      evidence = {
        status: 'pass',
        arms,
        unalignedExtent: true,
        denseQueryLimits: [1, limit, documents],
        malformedCases: EffectArray.map(cases, test => test.name),
      };
    } else {
      select(arm);
      const first = yield* capture;
      const warm = [];
      for (let run = 0; run < warmCalls; run++) warm.push(yield* capture);
      evidence = {status: 'pass', arm, first, warm};
    }

    assert.equal(sourceCommit(), source);
    const harness = yield* fs.readFile(import.meta.path);
    const adapter = yield* fs.readFile(path.join(import.meta.dir, 'native-vector-page-adapter.ts'));
    const artifact = {
      source,
      harnessSha256: hash(harness),
      adapterSha256: hash(adapter),
      librarySha256: rust ? hash(yield* fs.readFile(library)) : null,
      runtime: {bun: Bun.version, platform: platform(), architecture: arch(), cpu: cpus()[0]?.model},
      fixture: {
        documents,
        dimensions,
        modelMetadata: manifest.id,
        queryInference: 'synthetic',
        encoding: 'Float32LE',
        pageSize: 400,
        limit,
        cutoff,
        oracle: functional
          ? 'ordered scalar dot product of dense Float32 vectors with cutoff and exact global ID tie-breaking'
          : 'analytic first-coordinate scores with exact global ID tie-breaking',
        oracleSha256: hash(JSON.stringify(expected)),
        oracleCount: expected.length,
      },
      firstRssBytes,
      afterSetupRssBytes,
      maxRssKiB: process.resourceUsage().maxRSS,
      ...evidence,
    };
    yield* fs.writeFileString(output, JSON.stringify(artifact, null, 2) + '\n');
  }),
);

BunRuntime.runMain(provideScriptLayer(program, graphLayer.pipe(Layer.provideMerge(BunServices.layer))));

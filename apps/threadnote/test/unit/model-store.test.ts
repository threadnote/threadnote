import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {createHash} from '@threadnote/testing/node-crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {createServer, type Server} from '@threadnote/testing/node-http';
import {tmpdir} from '@threadnote/testing/node-os';
import {dirname, join} from '@threadnote/testing/node-path';
import {Effect, Result} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {BUILTIN_MODEL_MANIFESTS, CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';
import {assertSufficientModelDiskSpace, LocalModelStore, modelDownloadUrl} from '@threadnote/inference/models/store';
import type {LocalModelManifest} from '@threadnote/inference/models/catalog';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    EffectArray.map(servers.splice(0), server => new Promise<void>(resolve => server.close(() => resolve()))),
  );
  await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
});

describe('LocalModelStore', () => {
  it('downloads the core embedding model from its immutable GitHub release asset', () => {
    const coreModel = EffectOption.getOrUndefined(
      EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === CORE_EMBEDDING_MODEL_ID),
    );
    const nonCoreModel = EffectOption.getOrUndefined(
      EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-m3-q8'),
    );

    if (!coreModel || !nonCoreModel) throw TestError.make({message: 'Missing built-in model fixture.'});
    expect(modelDownloadUrl(coreModel)).toBe(
      `https://github.com/threadnote/threadnote/releases/download/v4.1.1/${coreModel.sha256}.gguf`,
    );
    expect(modelDownloadUrl(nonCoreModel)).toBe(
      `https://huggingface.co/ggml-org/bge-m3-Q8_0-GGUF/resolve/${nonCoreModel.revision}/bge-m3-q8_0.gguf`,
    );
  });

  effectIt.effect('fails disk-space preflight before a model download can start', () =>
    Effect.gen(function* () {
      const manifest = fixtureManifest(Buffer.from('fixture'));
      const result = yield* assertSufficientModelDiskSpace(manifest, manifest.size, manifest.size).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe('InsufficientDiskSpace');
        expect(result.failure.requiredBytes).toBe(manifest.size * 2);
      }
    }),
  );

  it('resumes a partial download, verifies SHA-256, and atomically promotes it', async () => {
    const bytes = Buffer.from('small deterministic GGUF fixture');
    const manifest = fixtureManifest(bytes);
    const ranges: Array<string | undefined> = [];
    const sourceUrl = await serve(bytes, ranges);
    const home = await mkdtemp(join(tmpdir(), 'threadnote-model-store-'));
    homes.push(home);

    const installedPath = await runEffect(
      Effect.gen(function* () {
        const store = yield* LocalModelStore;
        return store.path(home, manifest);
      }),
    );
    await mkdir(dirname(installedPath), {recursive: true});
    await writeFile(`${installedPath}.partial`, bytes.subarray(0, 6));

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* LocalModelStore;
        return yield* store.install(home, manifest, {sourceUrl});
      }),
    );

    expect(result.resumed).toBe(true);
    expect(result.verified).toBe(true);
    expect(ranges).toEqual(['bytes=6-']);
    expect(await readFile(installedPath)).toEqual(bytes);
    await expect(readFile(`${installedPath}.partial`)).rejects.toThrow();
  });

  it('removes a checksum-invalid completed download instead of promoting it', async () => {
    const expected = Buffer.from('expected model bytes');
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    const actual = Buffer.from('x'.repeat(expected.length));
    expect(actual.length).toBe(expected.length);
    const manifest = fixtureManifest(expected);
    const sourceUrl = await serve(actual, []);
    const home = await mkdtemp(join(tmpdir(), 'threadnote-model-store-checksum-'));
    homes.push(home);

    const result = await runEffect(
      Effect.gen(function* () {
        const store = yield* LocalModelStore;
        return yield* Effect.result(store.install(home, manifest, {sourceUrl}));
      }),
    );

    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure') {
      expect(result.failure._tag).toBe('ModelChecksumMismatch');
    }
    const installedPath = await runEffect(
      Effect.gen(function* () {
        const store = yield* LocalModelStore;
        return store.path(home, manifest);
      }),
    );
    await expect(readFile(installedPath)).rejects.toThrow();
    await expect(readFile(`${installedPath}.partial`)).rejects.toThrow();
  });

  it('repairs a corrupt installed model inside the installation lock', async () => {
    const bytes = Buffer.from('verified model replacement bytes');
    const manifest = fixtureManifest(bytes);
    const ranges: Array<string | undefined> = [];
    const sourceUrl = await serve(bytes, ranges);
    const home = await mkdtemp(join(tmpdir(), 'threadnote-model-store-repair-'));
    homes.push(home);
    const store = await runEffect(LocalModelStore);
    const installedPath = store.path(home, manifest);
    await runEffect(store.install(home, manifest, {sourceUrl}));
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
    await writeFile(installedPath, Buffer.from('x'.repeat(bytes.length)));

    const repaired = await runEffect(store.install(home, manifest, {sourceUrl}));

    expect(repaired.verified).toBe(true);
    expect(await readFile(installedPath)).toEqual(bytes);
    expect(ranges).toEqual([undefined, undefined]);
  });

  it('reuses a verified model while its file identity is unchanged', async () => {
    const bytes = Buffer.from('verified model cache fixture');
    const manifest = fixtureManifest(bytes);
    const home = await mkdtemp(join(tmpdir(), 'threadnote-model-store-cache-'));
    homes.push(home);
    let verifyLocks = 0;
    const layer = LocalModelStore.layerWith({
      onModelLockAcquired: event =>
        Effect.sync(() => {
          if (event.operation === 'verify') verifyLocks += 1;
        }),
    });

    const results = await runEffect(
      Effect.gen(function* () {
        const store = yield* LocalModelStore;
        const installedPath = store.path(home, manifest);
        yield* Effect.promise(() => mkdir(dirname(installedPath), {recursive: true}));
        yield* Effect.promise(() => writeFile(installedPath, bytes));
        return yield* Effect.all([store.verify(home, manifest), store.verify(home, manifest)], {concurrency: 1});
      }).pipe(provideTestLayer(layer)),
    );

    expect(EffectArray.every(results, result => result.verified)).toBe(true);
    expect(verifyLocks).toBe(1);
  });

  it('serializes removal behind an in-progress installation of the same model', async () => {
    const bytes = Buffer.from('barrier-controlled model bytes');
    const manifest = fixtureManifest(bytes);
    const controlled = await serveControlled(bytes);
    const home = await mkdtemp(join(tmpdir(), 'threadnote-model-store-lock-'));
    homes.push(home);
    const completionOrder: string[] = [];
    let signalRemoveContention = () => {};
    const removeContended = new Promise<void>(resolve => {
      signalRemoveContention = resolve;
    });
    const layer = LocalModelStore.layerWith({
      onModelLockCompleted: event =>
        Effect.sync(() => {
          completionOrder.push(event.operation);
        }),
      onModelLockContention: event =>
        Effect.sync(() => {
          if (event.operation === 'remove') signalRemoveContention();
        }),
    });
    const [installStore, removeStore] = await Promise.all([
      runEffect(LocalModelStore.pipe(provideTestLayer(layer))),
      runEffect(LocalModelStore.pipe(provideTestLayer(layer))),
    ]);
    const installedPath = installStore.path(home, manifest);

    const install = runEffect(installStore.install(home, manifest, {sourceUrl: controlled.sourceUrl}));
    await controlled.requestStarted;
    const remove = runEffect(removeStore.remove(home, manifest));
    await removeContended;
    controlled.release();

    await expect(install).resolves.toMatchObject({installed: true, verified: true});
    await expect(remove).resolves.toBe(true);
    expect(completionOrder).toEqual(['install', 'remove']);
    await expect(readFile(installedPath)).rejects.toThrow();
  });
});

function fixtureManifest(bytes: Uint8Array): LocalModelManifest {
  return {
    architecture: 'bert',
    contextLimit: 512,
    dimensions: 384,
    file: 'fixture.gguf',
    id: 'fixture-embedding',
    license: 'test-only',
    minimumRamBytes: 1,
    normalization: 'l2',
    promptPrefixes: {document: '', query: ''},
    quantization: 'F32',
    repository: 'threadnote/fixtures',
    revision: Effect2.pipe('a', EffectString.repeat(40)),
    role: 'embedding',
    runtime: {nodeLlamaCpp: '3.19.1'},
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    task: 'retrieval',
    version: 1,
  };
}

async function serve(bytes: Buffer, ranges: Array<string | undefined>): Promise<string> {
  const server = createServer((request, response) => {
    const range = request.headers.range;
    ranges.push(range);
    const offset = range ? Number.parseInt(Effect2.pipe(range, EffectString.replace(/^bytes=(\d+)-.*$/, '$1')), 10) : 0;
    const body = bytes.subarray(Number.isFinite(offset) ? offset : 0);
    response.writeHead(range ? 206 : 200, {
      'Content-Length': body.length,
      'Content-Type': 'application/octet-stream',
      ...(range ? {'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`} : {}),
    });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw TestError.make({message: 'Could not resolve test model server address.'});
  return `http://127.0.0.1:${address.port}/model.gguf`;
}

async function serveControlled(bytes: Buffer): Promise<{
  readonly release: () => void;
  readonly requestStarted: Promise<void>;
  readonly sourceUrl: string;
}> {
  let release = () => {};
  let markStarted = () => {};
  const requestStarted = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  const server = createServer((_request, response) => {
    markStarted();
    release = () => {
      response.writeHead(200, {
        'Content-Length': bytes.length,
        'Content-Type': 'application/octet-stream',
      });
      response.end(bytes);
    };
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw TestError.make({message: 'Could not resolve test model server address.'});
  return {
    release: () => release(),
    requestStarted,
    sourceUrl: `http://127.0.0.1:${address.port}/model.gguf`,
  };
}

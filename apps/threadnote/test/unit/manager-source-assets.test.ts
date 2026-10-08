import {it as effectIt} from '@effect/vitest';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import * as BunHttpServer from '@effect/platform-bun/BunHttpServer';
import {Console, Context, Effect, FileSystem, Layer, Result} from 'effect';
import * as HttpServer from 'effect/http/HttpServer';
import * as TestClock from 'effect/testing/TestClock';
import * as FC from 'fast-check';
import {expect, vi} from 'vitest';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import * as installation from '@threadnote/workspace/installation';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runManage} from '@threadnote/threadnote/manager/server';
import {assertManagerSourceAssets} from '../../src/manager/source_assets.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

vi.mock('@threadnote/workspace/installation', async importOriginal => {
  const actual = await importOriginal<typeof import('@threadnote/workspace/installation')>();
  return {...actual, toolRoot: vi.fn(actual.toolRoot)};
});

const sourceAssetTest = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-manager-source-assets-'});
  vi.mocked(installation.toolRoot).mockImplementation(() => Effect.succeed(root));
  vi.stubGlobal('THREADNOTE_STANDALONE', false);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      vi.mocked(installation.toolRoot).mockReset();
      vi.unstubAllGlobals();
    }),
  );
  return {fs, root};
});

const sourceAssetLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, TestSystemInfoLayer);

effectIt.effect('rejects a directory in place of the source bundle without creating files', () =>
  Effect.gen(function* () {
    const {fs, root} = yield* sourceAssetTest();
    yield* fs.makeDirectory(`${root}/dist/manager/app.js`, {recursive: true});
    const result = yield* Effect.result(assertManagerSourceAssets());
    expect(result).toMatchObject({failure: {_tag: 'ManagerOperationError'}});
    expect(yield* fs.readDirectory(`${root}/dist/manager/app.js`)).toEqual([]);
  }).pipe(provideTestLayer(sourceAssetLayer)),
);

effectIt.effect('skips source asset lookup in standalone mode', () =>
  Effect.gen(function* () {
    yield* sourceAssetTest();
    vi.stubGlobal('THREADNOTE_STANDALONE', true);
    vi.mocked(installation.toolRoot).mockImplementation(() => Effect.die('Unexpected standalone source lookup'));
    yield* assertManagerSourceAssets();
    expect(installation.toolRoot).not.toHaveBeenCalled();
  }).pipe(provideTestLayer(sourceAssetLayer)),
);

fcEffectProp(
  effectIt,
  'accepts source bundle files without changing any bundle bytes or siblings',
  {bytes: FC.uint8Array({maxLength: 256}), sibling: FC.uint8Array({maxLength: 256})},
  ({bytes, sibling}) =>
    Effect.gen(function* () {
      const {fs, root} = yield* sourceAssetTest();
      const directory = `${root}/dist/manager`;
      yield* fs.makeDirectory(directory, {recursive: true});
      yield* fs.writeFile(`${directory}/app.js`, bytes);
      yield* fs.writeFile(`${directory}/app.css`, sibling);
      yield* assertManagerSourceAssets();
      expect(Array.from(yield* fs.readFile(`${directory}/app.js`))).toEqual(Array.from(bytes));
      expect(Array.from(yield* fs.readFile(`${directory}/app.css`))).toEqual(Array.from(sibling));
      expect((yield* fs.readDirectory(directory)).sort()).toEqual(['app.css', 'app.js']);
    }).pipe(provideTestLayer(sourceAssetLayer)),
  {fastCheck: {numRuns: 8}},
);

effectIt.effect('rejects missing source UI assets before binding, printing a Manager URL or touching its home', () =>
  Effect.gen(function* () {
    const {fs, root} = yield* sourceAssetTest();
    const reserved = Context.get(
      yield* Layer.build(BunHttpServer.layer({hostname: '127.0.0.1', port: 0})),
      HttpServer.HttpServer,
    );
    if (reserved.address._tag === 'UnixPathAddress') throw new Error('Expected a loopback listener');
    const reservedPort = reserved.address.port;
    let urlPrinted = false;
    const result = yield* Console.consoleWith(parent =>
      runManage(
        {
          account: 'local',
          agentContextHome: `${root}/home`,
          agentId: 'threadnote',
          manifestPath: `${root}/manifest.yaml`,
          user: 'synthetic',
        },
        {open: false, uiPort: reservedPort},
      ).pipe(
        Effect.provideService(Console.Console, {
          ...parent,
          log: (...args) => {
            urlPrinted ||= String(args[0]).startsWith('Threadnote manager:');
          },
        }),
        Effect.timeout('2 seconds'),
        Effect.result,
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error('Expected missing Manager bundle failure');
    expect(result.failure).toMatchObject({
      _tag: 'ManagerOperationError',
      message: expect.stringContaining('bun run build'),
    });
    expect(urlPrinted).toBe(false);
    expect(yield* fs.exists(`${root}/home`)).toBe(false);
  }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

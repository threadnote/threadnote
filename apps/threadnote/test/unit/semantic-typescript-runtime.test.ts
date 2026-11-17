import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Config, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
/* oxlint-disable effecttsgo/node-builtin-import -- The construction receipt readback is a Promise filesystem boundary. */
import {mkdir, mkdtemp, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {Observation} from '@threadnote/semantic/contracts';
import {makeLspClient, spawnLspWire} from '../../src/semantic/lsp_transport.js';
import {semanticTreeDigest} from '../../src/semantic/fingerprint.js';
import {makeTypeScriptRuntime} from '../../src/semantic/providers/typescript_runtime.js';
import {makeTypeScriptSession} from '../../src/semantic/providers/typescript.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  readNativeTypeScriptConstructionReceipt,
  typescriptNativeBuildRecipe,
} from '../../../../tools/semantic/build-typescript-native.js';

describe.skipIf(process.platform === 'win32')('TypeScript continuous host plugin policy', () => {
  effectIt.effect(
    'blocks an eligible plugin initially, through inheritance and after a watched config change',
    () =>
      Effect.gen(function* () {
        const runtimeCommand = yield* Config.String('THREADNOTE_SEMANTIC_NODE_TEST_RUNTIME').pipe(
          Config.withDefault(process.execPath),
        );
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn6-ts-policy-'}));
        const home = path.join(root, 'host');
        const project = path.join(root, 'project');
        yield* fs.makeDirectory(home, {mode: 0o700});
        yield* fs.makeDirectory(project);
        const resolveFrom = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
        // Never mutate the selected installation. Put the marker plugin in a private SDK ancestor that is actually eligible.
        const sdk = path.join(home, 'sdk');
        yield* fs.copy(path.dirname(Bun.resolveSync('typescript/package.json', resolveFrom)), sdk);
        const plugin = path.join(home, 'node_modules', 'threadnote-marker-plugin');
        yield* fs.makeDirectory(plugin, {recursive: true});
        const marker = path.join(root, 'plugin-executed');
        yield* fs.writeFileString(
          path.join(plugin, 'package.json'),
          JSON.stringify({name: 'threadnote-marker-plugin', version: '1.0.0', main: 'index.js'}),
        );
        yield* fs.writeFileString(
          path.join(plugin, 'index.js'),
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports = () => ({create: info => info.languageService});`,
        );
        const pluginOptions = {plugins: [{name: 'threadnote-marker-plugin'}]};
        const config = path.join(project, 'tsconfig.json');
        yield* fs.writeFileString(config, JSON.stringify({compilerOptions: pluginOptions, files: ['main.ts']}));
        const source = 'export const answer = 42;\nlet nullable: string = null;\nanswer;\n';
        const file = path.join(project, 'main.ts');
        yield* fs.writeFileString(file, source);
        const uri = (yield* path.toFileUrl(project)).href;
        const fileUri = (yield* path.toFileUrl(file)).href;
        const connect = Effect.gen(function* () {
          const wire = yield* spawnLspWire({
            command: runtimeCommand,
            args: [Bun.resolveSync('typescript-language-server/lib/cli.mjs', resolveFrom), '--stdio'],
            cwd: project,
            environment: {},
          });
          return yield* makeLspClient(wire);
        });
        const control = yield* connect;
        yield* control.request(
          'initialize',
          {
            processId: null,
            rootUri: uri,
            capabilities: {},
            initializationOptions: {
              disableAutomaticTypingAcquisition: true,
              plugins: [],
              tsserver: {
                path: path.join(sdk, 'lib/tsserver.js'),
                fallbackPath: path.join(sdk, 'lib/tsserver.js'),
                useSyntaxServer: 'never',
              },
            },
          },
          10000,
        );
        yield* control.notify('initialized', {});
        yield* control.notify('textDocument/didOpen', {
          textDocument: {uri: fileUri, version: 1, languageId: 'typescript', text: source},
        });
        yield* control.request(
          'workspace/executeCommand',
          {
            command: 'typescript.tsserverRequest',
            arguments: ['projectInfo', {file: fileUri, needFileNameList: true}, {expectsResult: true, isAsync: false}],
          },
          10000,
        );
        expect(yield* fs.exists(marker)).toBe(true);
        expect((yield* control.close).drained).toBe(true);
        yield* fs.remove(marker);
        const runtime = yield* makeTypeScriptRuntime({
          home,
          sdkDirectory: sdk,
          sdkTreeDigest: yield* semanticTreeDigest(sdk),
          worktree: project,
        });
        const basis: Observation = {
          version: 1,
          repository: 'fixture',
          worktree: uri,
          project: uri,
          configuration: sha256HexSync('configuration'),
          toolchain: sha256HexSync('sdk'),
          provider: {id: 'typescript-language-server', version: '6.0.2', generation: 1},
          view: {kind: 'disk', id: 'fixture', owner: 'fixture', epoch: 0},
          uri: fileUri,
          content: sha256HexSync(source),
          documentVersion: null,
          projectEpoch: 0,
        };
        const guarded = yield* connect;
        const session = yield* makeTypeScriptSession(guarded, {
          basis,
          tsserver: runtime.launcher,
          compiler: runtime.compiler,
          sourceRoot: runtime.sourceRoot,
          verifyPolicy: runtime.verify,
          challenge: Effect.succeed(sha256HexSync('fixture-challenge')),
          maxMemoryMb: 256,
          startupMilliseconds: 10000,
        });
        const observed = yield* session.upsert(basis, source, 'typescript', 10000);
        expect((yield* session.query('definition', observed, {line: 2, character: 1}, 10000)).status).toBe('ok');
        expect(yield* fs.exists(marker)).toBe(false);
        // Move plugin settings to an inherited base; wait for strict diagnostics to prove the config watcher actually reloaded it.
        yield* fs.writeFileString(
          path.join(project, 'base.json'),
          JSON.stringify({compilerOptions: {...pluginOptions, strict: true}}),
        );
        yield* fs.writeFileString(config, JSON.stringify({extends: './base.json', files: ['main.ts']}));
        let reloaded = false;
        for (let attempt = 0; attempt < 12 && !reloaded; attempt++) {
          yield* Effect.sleep(250);
          const diagnostics = yield* session.diagnostics(observed, 5000);
          reloaded = EffectArray.some(diagnostics.items, diagnostic => diagnostic.code === 2322);
        }
        expect(reloaded).toBe(true);
        expect(yield* fs.exists(marker)).toBe(false);
        expect((yield* session.query('symbols', observed, undefined, 5000)).status).toBe('ok');
        expect((yield* guarded.close).drained).toBe(true);
        yield* runtime.verify;
        // Reuse requires exact immutable bytes; a changed launcher is rejected rather than overwritten.
        yield* fs.chmod(runtime.launcher, 0o600);
        yield* fs.writeFileString(runtime.launcher, '// changed');
        expect(
          (yield* makeTypeScriptRuntime({
            home,
            sdkDirectory: sdk,
            sdkTreeDigest: yield* semanticTreeDigest(sdk),
            worktree: project,
          }).pipe(Effect.exit))._tag,
        ).toBe('Failure');
        expect(yield* fs.readFileString(runtime.launcher)).toBe('// changed');
      }).pipe(
        provideTestLayer(Layer.merge(BunServices.layer, TestSystemInfoLayer)),
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: env => env,
          preserveIntendedChild: env => env,
        }),
        TestClock.withLive,
      ),
    45000,
  );
});

const {upstream, orderedOverlayDigest, toolchain, runtimeAsset} = typescriptNativeBuildRecipe;
const hostArchive = Option.getOrUndefined(
  EffectArray.findFirst(
    toolchain.archives,
    item =>
      item.os === (process.platform === 'win32' ? 'windows' : process.platform) &&
      item.arch === (process.arch === 'x64' ? 'amd64' : process.arch),
  ),
);
/** A tiny stand-in payload whose receipt is built only from recipe values; no construction runs. */
async function writeConstructionPayload(payload: string, schema: 'v1' | 'v2') {
  const executable = runtimeAsset.executableName();
  const binary = new TextEncoder().encode('#!/bin/sh\nexit 0\n');
  await mkdir(payload, {mode: 0o700});
  await writeFile(join(payload, executable), binary, {mode: 0o755});
  const probeConfig = `${JSON.stringify(
    {
      id: 'typescript-native',
      version: upstream.version,
      command: schema === 'v2' ? executable : join(payload, executable),
      args: ['--lsp', '--stdio'],
      language: 'typescript',
    },
    null,
    2,
  )}\n`;
  await writeFile(join(payload, 'probe-config.json'), probeConfig, {mode: 0o600});
  const raceSupported = process.platform !== 'win32' || process.arch === 'x64';
  const receipt = {
    kind: `threadnote-native-typescript-source-construction-${schema}`,
    version: upstream.version,
    sourceCommit: upstream.commit,
    sourceTree: upstream.tree,
    orderedOverlaySha256: orderedOverlayDigest,
    goArchiveSha256: hostArchive?.sha256,
    goVersion: toolchain.version,
    host: `${process.platform}-${process.arch}`,
    binarySha256: sha256HexSync(binary),
    binaryBytes: binary.byteLength,
    probeConfigSha256: sha256HexSync(probeConfig),
    completedChecks: [
      'module-verify',
      'focused-go',
      raceSupported ? 'race-go' : 'race-unsupported-windows-arm64',
      'build',
      'version',
    ],
  };
  await writeFile(join(payload, 'construction-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {mode: 0o600});
  return {executable, binarySha256: receipt.binarySha256};
}

describe.skipIf(hostArchive === undefined)('native TypeScript construction receipt relocation', () => {
  it('derives the command for a moved v2 payload and refuses a moved v1 payload as stale', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'tn-ts71-receipt-')));
    try {
      const v2 = await writeConstructionPayload(join(root, 'v2-built'), 'v2');
      await rename(join(root, 'v2-built'), join(root, 'v2-moved'));
      await expect(readNativeTypeScriptConstructionReceipt(join(root, 'v2-moved'))).resolves.toEqual({
        host: `${process.platform}-${process.arch}`,
        binarySha256: v2.binarySha256,
        command: join(root, 'v2-moved', v2.executable),
      });
      const v1 = await writeConstructionPayload(join(root, 'v1-built'), 'v1');
      expect((await readNativeTypeScriptConstructionReceipt(join(root, 'v1-built'))).command).toBe(
        join(root, 'v1-built', v1.executable),
      );
      await rename(join(root, 'v1-built'), join(root, 'v1-moved'));
      await expect(readNativeTypeScriptConstructionReceipt(join(root, 'v1-moved'))).rejects.toThrow(/stale/u);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

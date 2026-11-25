import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {TestClock} from 'effect/testing';
import {describe, expect, vi} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {CommandExecutor} from '@threadnote/platform/command';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeOwnedProviderLaunch} from '@threadnote/platform/system';
import {
  nativeTypeScriptExecutableIdentity,
  nativeTypeScriptHostKey,
} from '@threadnote/graph/typescript_native_asset_pins';
import type {Observation} from '@threadnote/semantic/contracts';
import {makeSemanticCoordinator} from '../../src/semantic/coordinator.js';
import {spawnLspWire} from '../../src/semantic/lsp_transport.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {native, nativeTypeScriptTestCandidate} from '../helpers/native-typescript-asset.js';

/**
 * The semantic LSP path must hand the expected Darwin image to the owned-process spawn: the coordinator derives it
 * from the pre-spawn recheck and the transport passes it through. Every launch is recorded and still performed.
 */
const launches = vi.hoisted((): Pick<RuntimeOwnedProviderLaunch, 'command' | 'expectedDarwinImage'>[] => []);
vi.mock('@threadnote/platform/system', async importOriginal => {
  const real = await importOriginal<typeof import('@threadnote/platform/system')>();
  return {
    ...real,
    runtimeSpawnOwnedProviderTree: (options: RuntimeOwnedProviderLaunch) => {
      launches.push({command: options.command, expectedDarwinImage: options.expectedDarwinImage});
      return real.runtimeSpawnOwnedProviderTree(options);
    },
  };
});

const io = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, cryptoLayer, TestSystemInfoLayer);
const policy = {
  sanitizeExternal: (env: NodeJS.ProcessEnv) => env,
  preserveIntendedChild: (env: NodeJS.ProcessEnv) => env,
};
const versionProbe = CommandExecutor.of({
  execute: () => Effect.succeed({exitCode: 0, stdout: 'v24.19.0\n', stderr: ''}),
  executeStreaming: () => Effect.die('Unexpected streaming execution'),
});
const image = {cdhash: EffectString.repeat(40)('a'), requireRuntime: true};

describe('semantic native TypeScript launch image', () => {
  effectIt.effect('passes the expected Darwin image from the LSP transport to the owned-process spawn', () =>
    Effect.gen(function* () {
      launches.length = 0;
      // The launch itself is refused (a missing executable, or the option off Darwin); only the hand-off matters.
      const fault = yield* spawnLspWire({
        command: '/threadnote-missing-native-compiler',
        args: ['--lsp', '--stdio'],
        cwd: '/',
        environment: {},
        expectedDarwinImage: image,
      }).pipe(Effect.scoped, Effect.flip);
      expect(fault).toMatchObject({code: 'prerequisite'});
      expect(launches).toEqual([{command: '/threadnote-missing-native-compiler', expectedDarwinImage: image}]);
    }).pipe(Effect.provideService(ChildEnvironmentPolicy, policy)),
  );

  native(effectIt.effect)(
    'starts the native provider with the image of the accepted compiler identity',
    () =>
      Effect.gen(function* () {
        launches.length = 0;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({directory: '/tmp', prefix: 'tn6-image-'}));
        const candidate = yield* nativeTypeScriptTestCandidate();
        const coordinator = yield* makeSemanticCoordinator({enabled: true, dataHome: root, nativeCandidate: candidate});
        const repo = path.join(root, 'repo');
        yield* fs.makeDirectory(repo);
        yield* fs.writeFileString(path.join(repo, 'tsconfig.json'), '{"files":["main.ts"]}');
        const source = 'const x: number = 1;\nx;\n';
        yield* fs.writeFileString(path.join(repo, 'main.ts'), source);
        const uri = (yield* path.toFileUrl(repo)).href;
        const observation: Observation = {
          version: 1,
          repository: 'test-repository',
          worktree: uri,
          project: uri,
          configuration: EffectString.repeat(64)('a'),
          toolchain: EffectString.repeat(64)('b'),
          provider: {id: 'typescript-native', version: '7.1.0-beta', generation: 0},
          view: {kind: 'overlay', id: 'test-view', owner: 'test-owner', epoch: 0},
          uri: `${uri}/main.ts`,
          content: sha256HexSync(source),
          documentVersion: 1,
          projectEpoch: 0,
        };
        yield* coordinator.attach(observation, source, 'typescript');
        const expected = nativeTypeScriptExecutableIdentity(nativeTypeScriptHostKey(process.platform, process.arch));
        const compiler = EffectArray.filter(launches, launch => launch.command === candidate.executable);
        expect(compiler.length).toBeGreaterThan(0);
        for (const launch of compiler) expect(launch.expectedDarwinImage).toEqual(expected?.image);
        // The darwin-arm64 reviewed binary is linker-signed, so source mode binds its pinned cdhash.
        if (process.platform === 'darwin' && process.arch === 'arm64')
          expect(compiler[0].expectedDarwinImage).toEqual({
            cdhash: expect.stringMatching(/^[0-9a-f]{40}$/u),
            requireRuntime: false,
          });
      }).pipe(
        Effect.provideService(CommandExecutor, versionProbe),
        Effect.provideService(ChildEnvironmentPolicy, policy),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow real provider and filesystem test entrypoint.
        Effect.provide(io),
        TestClock.withLive,
      ),
    30000,
  );
});

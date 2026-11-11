import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, String as EffectString} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {
  nativeVectorReaderBuildEnvironmentSha256,
  loadNativeVectorReader,
  verifyNativeVectorReaderPayload,
} from '@threadnote/recall/vector/native-reader-payload';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {platformPathFor} from '@threadnote/platform/system';

describe('native reader filesystem payload boundary', () => {
  it('requires explicit developer bootstrap before source reads', async () => {
    await expect(
      loadNativeVectorReader({
        platform: 'darwin',
        architecture: 'arm64',
        executablePath: '/usr/bin/bun',
        environment: () => ({}),
      }),
    ).rejects.toThrow('native:bootstrap');
  });
  it('rejects missing advertised source artifacts', async () => {
    await expect(
      loadNativeVectorReader({
        platform: 'darwin',
        architecture: 'arm64',
        executablePath: '/usr/bin/bun',
        environment: () => ({THREADNOTE_NATIVE_VECTOR_READER_MANIFEST: '/nonexistent/threadnote-native-manifest.json'}),
      }),
    ).rejects.toThrow('manifest is missing');
  });
  effectIt.layer(BunServices.layer)(layerIt => {
    layerIt.effect('verifies final bytes and fails a modified advertised binary', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-payload-'});
        const path = platformPathFor(process.platform);
        const manifestPath = path.join(directory, 'manifest.json');
        const binary = path.join(directory, 'threadnote-vector-reader.node');
        yield* fs.writeFileString(binary, 'test-native-bytes');
        const manifest = {
          schemaVersion: 1,
          binary: 'threadnote-vector-reader.node',
          binarySha256: sha256HexSync('test-native-bytes'),
          bunTarget: 'bun-darwin-arm64',
          development: true,
          buildEnvironment: {compiler: 'fixture'},
          sourceRoot: '/test-checkout',
          buildInfo: {
            protocolVersion: 2,
            napiVersion: 6,
            crateVersion: '0.1.0',
            sqliteVersion: '3.54.1',
            sqliteSourceId: 'id',
            target: 'aarch64-apple-darwin',
            rustVersion: '1.89.0',
            buildEnvironmentSha256: nativeVectorReaderBuildEnvironmentSha256({compiler: 'fixture'}),
            crtStatic: false,
            deploymentTarget: '13.0',
            sourceCommit: EffectString.repeat(40)('a'),
            sourceTree: EffectString.repeat(40)('b'),
            lockSha256: EffectString.repeat(64)('c'),
            toolchainSha256: EffectString.repeat(64)('c'),
            sourceSha256: EffectString.repeat(64)('d'),
          },
        };
        yield* fs.writeFileString(manifestPath, JSON.stringify(manifest));
        expect(yield* Effect.promise(() => verifyNativeVectorReaderPayload(manifestPath))).toEqual(manifest);
        yield* fs.writeFileString(binary, 'signed-or-corrupted-different-bytes');
        yield* Effect.promise(() =>
          expect(verifyNativeVectorReaderPayload(manifestPath)).rejects.toThrow('digest mismatch'),
        );
      }),
    );
  });
});

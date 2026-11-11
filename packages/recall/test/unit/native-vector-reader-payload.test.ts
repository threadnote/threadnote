import {Array as EffectArray, Record as EffectRecord, String as EffectString} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  loadNativeVectorReader,
  nativeVectorReaderTarget,
  parseNativeVectorReaderManifest,
  nativeVectorReaderBuildEnvironmentSha256,
  sameNativeVectorReaderBuildInfo,
} from '../../src/vector/native-reader-payload.js';

const buildInfo = {
  protocolVersion: 2,
  napiVersion: 6,
  crtStatic: false,
  deploymentTarget: '13.0',
  crateVersion: '0.1.0',
  sqliteVersion: '3.54.1',
  sqliteSourceId: 'sqlite-source-id',
  target: 'aarch64-apple-darwin',
  rustVersion: '1.89.0',
  sourceCommit: EffectString.repeat(40)('a'),
  sourceTree: EffectString.repeat(40)('b'),
  lockSha256: EffectString.repeat(64)('c'),
  toolchainSha256: EffectString.repeat(64)('c'),
  buildEnvironmentSha256: nativeVectorReaderBuildEnvironmentSha256({compiler: 'fixture'}),
  sourceSha256: EffectString.repeat(64)('d'),
} as const;
const manifest = {
  schemaVersion: 1,
  binary: 'threadnote-vector-reader.node',
  binarySha256: EffectString.repeat(64)('e'),
  bunTarget: 'bun-darwin-arm64',
  development: true,
  sourceRoot: '/test-checkout',
  buildEnvironment: {compiler: 'fixture'},
  buildInfo,
};

describe('native vector payload contract', () => {
  it('fails missing required source capability before attempting native execution', async () => {
    const system = {
      platform: 'darwin' as const,
      architecture: 'arm64',
      executablePath: '/test/bun',
      environment: () => ({}),
    };
    await expect(loadNativeVectorReader(system)).rejects.toThrow('Required native vector reader');
  });
  it('maps all eight verified target profiles and keeps GNU distinct from musl', () => {
    expect(
      EffectArray.map(
        [
          'bun-darwin-arm64',
          'bun-darwin-x64',
          'bun-linux-arm64',
          'bun-linux-arm64-musl',
          'bun-linux-x64-baseline',
          'bun-linux-x64-baseline-musl',
          'bun-windows-arm64',
          'bun-windows-x64-baseline',
        ],
        nativeVectorReaderTarget,
      ),
    ).toEqual([
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
      'aarch64-unknown-linux-gnu',
      'aarch64-unknown-linux-musl',
      'x86_64-unknown-linux-gnu',
      'x86_64-unknown-linux-musl',
      'aarch64-pc-windows-msvc',
      'x86_64-pc-windows-msvc',
    ]);
    expect(nativeVectorReaderTarget('unknown')).toBeUndefined();
  });
  it('requires target, ABI, source and binary identity', () => {
    expect(parseNativeVectorReaderManifest(manifest)).toEqual(manifest);
    for (const changed of [
      {...manifest, binary: '../reader.node'},
      {...manifest, binarySha256: 'bad'},
      {...manifest, bunTarget: 'bun-linux-x64-baseline'},
      {...manifest, development: undefined},
      ...EffectArray.map(
        [
          {napiVersion: 5},
          {protocolVersion: 1},
          {rustVersion: '1.90.0'},
          {sqliteVersion: '3.54.0'},
          {sourceCommit: 'development'},
          {lockSha256: ''},
        ],
        change => ({...manifest, buildInfo: {...buildInfo, ...change}}),
      ),
    ])
      expect(() => parseNativeVectorReaderManifest(changed)).toThrow();
  });
  it('compares build metadata by keys regardless of export object order', () => {
    expect(
      sameNativeVectorReaderBuildInfo(EffectRecord.fromEntries(EffectRecord.toEntries(buildInfo).reverse()), buildInfo),
    ).toBe(true);
    expect(sameNativeVectorReaderBuildInfo({...buildInfo, target: 'x86_64-unknown-linux-gnu'}, buildInfo)).toBe(false);
    expect(sameNativeVectorReaderBuildInfo({...buildInfo, unexpected: true}, buildInfo)).toBe(false);
  });
});

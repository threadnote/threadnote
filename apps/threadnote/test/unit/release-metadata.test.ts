import {expect, it} from 'vitest';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {releaseMetadataText} from '../../../../scripts/build.js';

const common = {
  codeGraphAssets: {manifest: 'assets/code-graph/manifest.json', version: 1},
  codeSignature: 'none',
  executable: 'threadnote',
  devSkills: {digest: EffectString.repeat(64)('d'), manifest: 'config/dev-skills.json', protocol: 1},
  nativeRuntime: 'runtime/node-llama-cpp.js',
  nativeRuntimePackage: '@node-llama-cpp/linux-x64',
  runtime: 'bun-1.4.4',
  target: 'bun-linux-x64-baseline',
  sourceIdentity: {
    commit: EffectString.repeat(40)('c'),
    tree: EffectString.repeat(40)('t'),
    target: 'bun-linux-x64-baseline',
  },
  version: '6.0.0',
};
const typescriptNativeAsset = {
  manifest: 'runtime/typescript/manifest.json',
  sdk: 'runtime/typescript/sdk',
  frontend: 'runtime/typescript/frontend',
  sdkTreeDigest: EffectString.repeat(64)('s'),
  version: '7.1.0-beta',
  provenance: 'private-source-overlay',
};

it('writes host-completed staging byte-identically to a build that staged the asset itself', () => {
  const staged = releaseMetadataText({...common, typescriptNativeAsset});
  // The GNU container's pending record, then the host step's rewrite with the staged asset in its place.
  const pending: Record<string, unknown> = JSON.parse(
    releaseMetadataText({...common, typescriptNativeAssetPending: true}),
  );
  const {typescriptNativeAssetPending: _pending, ...rest} = pending;
  expect(releaseMetadataText({...rest, typescriptNativeAsset})).toBe(staged);
  // The asset keeps its position after nativeRuntime, as the build has always written it.
  expect(EffectRecord.keys(JSON.parse(staged))).toEqual([
    'codeGraphAssets',
    'codeSignature',
    'executable',
    'devSkills',
    'nativeRuntime',
    'typescriptNativeAsset',
    'nativeRuntimePackage',
    'runtime',
    'target',
    'sourceIdentity',
    'version',
  ]);
  expect(() => releaseMetadataText({...common, unexpected: true})).toThrow('unexpected has no declared position');
});

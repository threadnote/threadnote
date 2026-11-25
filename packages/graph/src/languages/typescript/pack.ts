import {Effect, Option} from 'effect';
import typescriptPackage from 'typescript/package.json' with {type: 'json'};
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {extractNativeFileFacts} from '../../extractor.js';
import {NativeTypeScriptSessionService} from '../../typescript_runtime.js';
import {nativeTypeScriptAssetPins} from '../../typescript_native_asset_pins.js';
import {CodeGraphLanguagePackError, type CodeGraphLanguagePack} from '../types.js';

const EXTRACTOR_POLICY_VERSION = 'typescript-native-7.1-v2-full-utf16-finite-navigation-proofs';

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [],
  capabilities: new Set(['calls', 'declarations', 'imports', 'inheritance']),
  extractor: {
    extract: file =>
      Effect.gen(function* () {
        const selected = yield* Effect.serviceOption(NativeTypeScriptSessionService);
        if (Option.isNone(selected))
          return yield* CodeGraphLanguagePackError.make({message: 'Native TypeScript parser session is unavailable.'});
        return yield* fromPromiseInterruptible(
          () => extractNativeFileFacts(file, selected.value),
          cause =>
            CodeGraphLanguagePackError.make({message: `Could not extract TypeScript facts from ${file.path}.`, cause}),
        );
      }),
    // The reviewed asset pins (binaries, SDK, patch, bundle, provenance) are part of the extractor identity, so a pin
    // change invalidates every cached fact and navigation proof produced by the previous asset.
    version: sha256HexSync(
      `${EXTRACTOR_POLICY_VERSION}\ntypescript:${typescriptPackage.version}\nasset:${JSON.stringify(nativeTypeScriptAssetPins)}`,
    ),
  },
  files: [
    {kind: 'extension', language: 'typescript', role: 'source', value: '.ts'},
    {kind: 'extension', language: 'typescript', role: 'source', value: '.tsx'},
    {kind: 'extension', language: 'typescript', role: 'source', value: '.mts'},
    {kind: 'extension', language: 'typescript', role: 'source', value: '.cts'},
    {kind: 'extension', language: 'javascript', role: 'source', value: '.js'},
    {kind: 'extension', language: 'javascript', role: 'source', value: '.jsx'},
    {kind: 'extension', language: 'javascript', role: 'source', value: '.mjs'},
    {kind: 'extension', language: 'javascript', role: 'source', value: '.cjs'},
  ],
  id: 'typescript',
  resolutionStrategy: {domain: 'typescript', version: 'typescript-modules-v2-published-surface'},
  version: '1.0.0',
  workspaceDetector: Option.none(),
};

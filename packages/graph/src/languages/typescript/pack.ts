import {Effect, Option} from 'effect';
import typescriptPackage from 'typescript-compiler/package.json' with {type: 'json'};
import {sha256HexSync} from '@threadnote/platform/sha256';
import {extractFileFacts} from '../../extractor.js';
import {CodeGraphLanguagePackError, type CodeGraphLanguagePack} from '../types.js';

const EXTRACTOR_POLICY_VERSION = 'typescript-compiler-v9-finite-navigation-proofs';

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [],
  capabilities: new Set(['calls', 'declarations', 'imports', 'inheritance']),
  extractor: {
    extract: file =>
      Effect.try({
        try: () => extractFileFacts(file),
        catch: cause =>
          CodeGraphLanguagePackError.make({message: `Could not extract TypeScript facts from ${file.path}.`, cause}),
      }),
    version: sha256HexSync(`${EXTRACTOR_POLICY_VERSION}\ntypescript:${typescriptPackage.version}`),
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

import {Effect, Option} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {discoverBazelWorkspace} from '../../workspace.js';
import {CodeGraphLanguagePackError, type CodeGraphFileMatcher, type CodeGraphLanguagePack} from '../types.js';
import {extractBazelFacts} from './extractor.js';
import {Array as EffectArray} from 'effect';

const FILES = [
  {kind: 'basename', language: 'bazel-build', role: 'manifest', value: 'BUILD'},
  {kind: 'basename', language: 'bazel-build', role: 'manifest', value: 'BUILD.bazel'},
  {kind: 'basename', language: 'bazel-workspace', role: 'workspace', value: 'WORKSPACE'},
  {kind: 'basename', language: 'bazel-workspace', role: 'workspace', value: 'WORKSPACE.bazel'},
  {kind: 'basename', language: 'bazel-module', role: 'workspace', value: 'MODULE.bazel'},
  {kind: 'extension', language: 'starlark', role: 'source', value: '.bzl'},
  {kind: 'extension', language: 'starlark', role: 'source', value: '.axl'},
  {kind: 'extension', language: 'bazelrc', role: 'workspace', value: '.bazelrc'},
] as const satisfies readonly CodeGraphFileMatcher[];

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [],
  capabilities: new Set(['calls', 'declarations', 'dependencies', 'imports', 'workspace']),
  extractor: {
    extract: (file, context) =>
      Effect.try({
        try: () => extractBazelFacts(file, context),
        catch: cause =>
          CodeGraphLanguagePackError.make({
            message: `Could not extract bounded Bazel/Starlark facts from ${file.path}.`,
            cause,
          }),
      }),
    version: sha256HexSync('threadnote-bazel-starlark-static-extractor-v1'),
  },
  files: FILES,
  id: 'bazel',
  resolutionStrategy: {domain: 'bazel', version: 'bazel-labels-static-v1'},
  version: '1.1.0',
  workspaceDetector: Option.some({
    contextFiles: EffectArray.filter(FILES, file => file.role === 'workspace' || file.role === 'manifest'),
    detect: files => Effect.succeed(discoverBazelWorkspace(files)),
  }),
};

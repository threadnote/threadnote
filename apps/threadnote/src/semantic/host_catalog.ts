import {Array as EffectArray, Schema, String as EffectString} from 'effect';
import {Digest} from '@threadnote/semantic/contracts';
import {nativeTypeScriptAssetPins} from '@threadnote/graph/typescript_native_asset_pins';
import {PythonEnvironment} from './providers/python_project.js';
import {JavaEnvironment} from './providers/java_project.js';
import {JavaRuntimeCandidate} from './providers/java_runtime.js';

/** Host-owned finite configuration. Repository and public query input never supply this catalog. */
export const TypeScriptHostCandidate = Schema.Struct({
  runtime: Schema.String,
  runtimeDigest: Digest,
  runtimeVersion: Schema.Literal('24.19.0'),
  serverDirectory: Schema.String,
  serverTreeDigest: Digest,
  sdkDirectory: Schema.String,
  sdkTreeDigest: Digest,
});
export type TypeScriptHostCandidate = typeof TypeScriptHostCandidate.Type;
/** Source-overlay native 7.1 host selection; provenance is checked against the staged executable bytes. */
export const NativeTypeScriptHostCandidate = Schema.Struct({
  executable: Schema.String,
  executableDigest: Digest,
  version: Schema.Literal(nativeTypeScriptAssetPins.version),
  sdkDirectory: Schema.String,
  sdkTreeDigest: Digest,
  sourceCommit: Schema.Literal(nativeTypeScriptAssetPins.provenance.sourceCommit),
  sourceTree: Schema.Literal(nativeTypeScriptAssetPins.provenance.sourceTree),
  overlaySha256: Schema.Literal(nativeTypeScriptAssetPins.provenance.overlaySha256),
});
export type NativeTypeScriptHostCandidate = typeof NativeTypeScriptHostCandidate.Type;
export const SdkHostCandidate = Schema.Struct({
  executable: Schema.String,
  executableDigest: Digest,
  sdkDirectory: Schema.String,
  sdkTreeDigest: Digest,
});
export const PythonHostCandidate = Schema.Struct({
  runtime: Schema.String,
  runtimeDigest: Digest,
  runtimeVersion: Schema.Literal('24.19.0'),
  serverDirectory: Schema.String,
  serverTreeDigest: Digest,
  environments: Schema.Array(PythonEnvironment).check(Schema.isMaxLength(16)),
});
export type PythonHostCandidate = typeof PythonHostCandidate.Type;
export const JavaHostCandidate = Schema.Struct({
  runtimeCandidate: JavaRuntimeCandidate,
  environments: Schema.Array(JavaEnvironment).check(Schema.isBetweenLength(1, 16)),
});
export type JavaHostCandidate = typeof JavaHostCandidate.Type;
export const SemanticHostCatalog = Schema.Struct({
  candidate: Schema.optional(TypeScriptHostCandidate),
  nativeCandidate: Schema.optional(NativeTypeScriptHostCandidate),
  python: Schema.optional(PythonHostCandidate),
  go: Schema.optional(SdkHostCandidate),
  rust: Schema.optional(SdkHostCandidate),
  java: Schema.optional(JavaHostCandidate),
});
export type SemanticHostCatalog = typeof SemanticHostCatalog.Type;

export const semanticHostSelection = {
  typescript: {provider: 'typescript-native', slot: 'nativeCandidate'},
  typescriptreact: {provider: 'typescript-native', slot: 'nativeCandidate'},
  javascript: {provider: 'typescript-native', slot: 'nativeCandidate'},
  javascriptreact: {provider: 'typescript-native', slot: 'nativeCandidate'},
  python: {provider: 'basedpyright', slot: 'python'},
  go: {provider: 'gopls', slot: 'go'},
  rust: {provider: 'rust-analyzer', slot: 'rust'},
  java: {provider: 'jdtls', slot: 'java'},
} as const;

export const semanticCandidateKey = (candidate: TypeScriptHostCandidate) =>
  JSON.stringify([
    candidate.runtime,
    candidate.runtimeDigest,
    candidate.runtimeVersion,
    candidate.serverDirectory,
    candidate.serverTreeDigest,
    candidate.sdkDirectory,
    candidate.sdkTreeDigest,
  ]);

export const nativeTypeScriptCandidateKey = (candidate: NativeTypeScriptHostCandidate) =>
  JSON.stringify([
    candidate.executable,
    candidate.executableDigest,
    candidate.version,
    candidate.sdkDirectory,
    candidate.sdkTreeDigest,
    candidate.sourceCommit,
    candidate.sourceTree,
    candidate.overlaySha256,
  ]);

/** Preserve the existing catalog identity, including environment order independence. */
export const semanticCatalogKey = (options: SemanticHostCatalog) =>
  JSON.stringify([
    options.candidate ? semanticCandidateKey(options.candidate) : null,
    options.python
      ? [
          options.python.runtime,
          options.python.runtimeDigest,
          options.python.runtimeVersion,
          options.python.serverDirectory,
          options.python.serverTreeDigest,
          EffectArray.map(
            [...options.python.environments].sort((a, b) => EffectString.localeCompare(b.id)(a.id)),
            e => [e.id, e.metadataFile, e.metadataDigest],
          ),
        ]
      : null,
    ...EffectArray.map([options.go, options.rust], candidate =>
      candidate
        ? [candidate.executable, candidate.executableDigest, candidate.sdkDirectory, candidate.sdkTreeDigest]
        : null,
    ),
    options.java
      ? [
          options.java.runtimeCandidate.serverDirectory,
          options.java.runtimeCandidate.serverTreeDigest,
          options.java.runtimeCandidate.runtimeJavaHome,
          options.java.runtimeCandidate.runtimeSdkDigest,
          options.java.runtimeCandidate.projectJavaHome,
          options.java.runtimeCandidate.projectSdkDigest,
          EffectArray.map(
            [...options.java.environments].sort((a, b) => EffectString.localeCompare(b.id)(a.id)),
            environment => [environment.id, environment.metadataFile, environment.metadataDigest],
          ),
        ]
      : null,
    ...(options.nativeCandidate ? [nativeTypeScriptCandidateKey(options.nativeCandidate)] : []),
  ]);

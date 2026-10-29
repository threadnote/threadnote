import {Effect, Option, Schema} from 'effect';
import type {TreeSitterRuntime} from '../tree_sitter/runtime.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../types.js';
import {CodeGraphExternalDependencySchemaV1, CodeGraphMonikerSchemaV1} from '../cross_repository/types.js';
import type {CodeGraphExternalDependencyV1, CodeGraphMonikerV1} from '../cross_repository/types.js';

export type CodeGraphFileRole = 'corpus' | 'documentation' | 'manifest' | 'source' | 'workspace';
export type CodeGraphCapability =
  | 'assets'
  | 'calls'
  | 'corpus'
  | 'declarations'
  | 'dependencies'
  | 'documentation'
  | 'imports'
  | 'inheritance'
  | 'workspace';

export type CodeGraphFileMatcher =
  | {
      readonly kind: 'basename';
      readonly language: string;
      readonly role: CodeGraphFileRole;
      readonly value: string;
    }
  | {
      /** Basename glob with one or more non-empty `*` segments. */
      readonly kind: 'basename-pattern';
      readonly language: string;
      readonly role: CodeGraphFileRole;
      readonly value: string;
    }
  | {
      readonly kind: 'extension';
      readonly language: string;
      readonly role: CodeGraphFileRole;
      readonly value: string;
    }
  | {
      readonly kind: 'path-suffix';
      readonly language: string;
      readonly role: CodeGraphFileRole;
      readonly value: string;
    };

export interface VerifiedLanguageAsset {
  readonly abi: number;
  readonly developmentRelativePath?: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly source: string;
  readonly version: string;
}

export interface CodeGraphExtractionContext {
  readonly packageName: Option.Option<string>;
  readonly project: Option.Option<CodeGraphWorkspaceProject>;
}

export interface CodeGraphWorkspaceProject {
  readonly buildSystem: CodeGraphWorkspaceBuildSystem;
  readonly dependencies: readonly string[];
  readonly dependencyDetails: readonly CodeGraphWorkspaceDependency[];
  readonly externalDependencies?: readonly CodeGraphExternalDependencyV1[];
  readonly diagnostics: readonly string[];
  readonly id: string;
  readonly kind: CodeGraphWorkspaceComponentKind;
  readonly languages: readonly string[];
  readonly monikers?: readonly CodeGraphMonikerV1[];
  readonly name: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly resolutionDomain: string;
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly workspaceId: string;
  readonly workspaceRoots: readonly string[];
}

export type CodeGraphWorkspaceBuildSystem =
  'bazel' | 'gradle' | 'inferred' | 'maven' | 'node' | 'nx' | 'pnpm' | 'swiftpm' | 'typescript' | 'xcode';
export type CodeGraphWorkspaceComponentKind = 'module' | 'package' | 'project' | 'target';
export type CodeGraphWorkspaceProvenance = 'declared' | 'inferred';

export interface CodeGraphWorkspaceDependency {
  readonly evidence?: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly targetId: string;
}

export interface CodeGraphBuildWorkspace {
  readonly buildSystem: CodeGraphWorkspaceBuildSystem;
  readonly diagnostics: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly root: string;
}

export interface CodeGraphWorkspace {
  readonly diagnostics: readonly string[];
  readonly fingerprint: string;
  readonly projects: readonly CodeGraphWorkspaceProject[];
  readonly workspaces: readonly CodeGraphBuildWorkspace[];
}

/** Runtime validator for workspaces loaded from persisted cache and reuse receipts. */
export const CodeGraphWorkspaceSchema = Schema.Struct({
  diagnostics: Schema.Array(Schema.String),
  fingerprint: Schema.String,
  projects: Schema.Array(
    Schema.Struct({
      buildSystem: Schema.Literals([
        'bazel',
        'gradle',
        'inferred',
        'maven',
        'node',
        'nx',
        'pnpm',
        'swiftpm',
        'typescript',
        'xcode',
      ]),
      dependencies: Schema.Array(Schema.String),
      dependencyDetails: Schema.Array(
        Schema.Struct({
          evidence: Schema.optionalKey(Schema.String),
          provenance: Schema.Literals(['declared', 'inferred']),
          targetId: Schema.String,
        }),
      ),
      externalDependencies: Schema.optionalKey(Schema.Array(CodeGraphExternalDependencySchemaV1)),
      diagnostics: Schema.Array(Schema.String),
      id: Schema.String,
      kind: Schema.Literals(['module', 'package', 'project', 'target']),
      languages: Schema.Array(Schema.String),
      monikers: Schema.optionalKey(Schema.Array(CodeGraphMonikerSchemaV1)),
      name: Schema.String,
      provenance: Schema.Literals(['declared', 'inferred']),
      resolutionDomain: Schema.String,
      root: Schema.String,
      sourceRoots: Schema.Array(Schema.String),
      workspaceId: Schema.String,
      workspaceRoots: Schema.Array(Schema.String),
    }),
  ),
  workspaces: Schema.Array(
    Schema.Struct({
      buildSystem: Schema.Literals([
        'bazel',
        'gradle',
        'inferred',
        'maven',
        'node',
        'nx',
        'pnpm',
        'swiftpm',
        'typescript',
        'xcode',
      ]),
      diagnostics: Schema.Array(Schema.String),
      id: Schema.String,
      name: Schema.String,
      provenance: Schema.Literals(['declared', 'inferred']),
      root: Schema.String,
    }),
  ),
});

export interface CodeGraphWorkspaceDetector {
  readonly contextFiles: readonly CodeGraphFileMatcher[];
  readonly detect: (
    files: readonly CodeGraphInventoryFile[],
  ) => Effect.Effect<CodeGraphWorkspace, CodeGraphLanguagePackError>;
}

export interface CodeGraphResolutionStrategy {
  readonly domain: string;
  readonly version: string;
}

export interface CodeGraphExtractor {
  readonly version: string;
  readonly extract: (
    file: CodeGraphInventoryFile,
    context: CodeGraphExtractionContext,
  ) => Effect.Effect<CodeGraphFileFacts, CodeGraphLanguagePackError, TreeSitterRuntime>;
}

export interface CodeGraphLanguagePack {
  readonly assets: readonly VerifiedLanguageAsset[];
  readonly capabilities: ReadonlySet<CodeGraphCapability>;
  readonly extractor: CodeGraphExtractor;
  readonly files: readonly CodeGraphFileMatcher[];
  readonly id: string;
  readonly resolutionStrategy: CodeGraphResolutionStrategy;
  readonly version: string;
  readonly workspaceDetector: Option.Option<CodeGraphWorkspaceDetector>;
}

export interface CodeGraphLanguageMatch {
  readonly cacheIdentity: string;
  readonly language: string;
  readonly pack: CodeGraphLanguagePack;
  readonly role: CodeGraphFileRole;
}

export class CodeGraphLanguagePackError extends Schema.TaggedError<
  CodeGraphLanguagePackError,
  {readonly brand: unique symbol}
>()('CodeGraphLanguagePackError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

import {Array as EffectArray} from 'effect';
import {parseCodeGraphMonikerV1} from '../cross_repository/monikers.js';
import type {CodeGraphExternalDependencyV1, CodeGraphMonikerV1} from '../cross_repository/types.js';
import type {
  CodeGraphBuildWorkspace,
  CodeGraphWorkspace,
  CodeGraphWorkspaceDependency,
  CodeGraphWorkspaceProject,
} from '../languages/types.js';
import {parseCodeGraphFileFacts} from '../fact/validation.js';
import {
  CODE_GRAPH_CHECKPOINT_FORMAT_VERSION,
  CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION,
  CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
} from '../store/schema/revision.js';
import type {CodeGraphFileFacts} from '../types.js';
import {canonicalJson} from './canonical_json.js';
import {codeGraphCheckpointFileFactCacheIdentity} from './file_fact_identity.js';
import {Predicate, Schema} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_CHECKPOINT_SCHEMA = 'threadnote.code-graph-checkpoint' as const;
export const CODE_GRAPH_CHECKPOINT_MEDIA_TYPE = 'application/vnd.threadnote.code-graph-checkpoint.v1' as const;
export {
  CODE_GRAPH_CHECKPOINT_FORMAT_VERSION,
  CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION,
  CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
};
export const CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE = 'threadnote-gzip-v1' as const;
export const CODE_GRAPH_CHECKPOINT_PATH_POLICY = 'repository-relative-posix-v1' as const;
export const CODE_GRAPH_CHECKPOINT_ATTRIBUTION_FILES_MAXIMUM = 10_000;
export const CODE_GRAPH_CHECKPOINT_ATTRIBUTION_CONTENT_BYTES_MAXIMUM = 16 * 1_048_576;
export const CODE_GRAPH_CHECKPOINT_ATTRIBUTION_SOURCE_BYTES_MAXIMUM = 64 * 1_048_576;

export const CODE_GRAPH_CHECKPOINT_RECORD_KINDS = [
  'file',
  'file-fact',
  'workspace-scope',
  'workspace-component',
  'workspace-dependency',
  'workspace-external-dependency',
  'symbol',
  'symbol-lookup',
  'reexport',
  'edge',
  'moniker',
  'lexical',
  'pack-provenance',
] as const;

export type CodeGraphCheckpointRecordKind = (typeof CODE_GRAPH_CHECKPOINT_RECORD_KINDS)[number];
export type CodeGraphCheckpointSha256 = `sha256:${string}`;

const RECORD_KIND_ORDER = new Map(
  EffectArray.map(CODE_GRAPH_CHECKPOINT_RECORD_KINDS, (kind, ordinal) => [kind, ordinal]),
);
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GRAPH_CONTENT_ID = /^cgc_[0-9a-f]{40}$/u;
const MATERIALIZED_FACT_IDENTITY = /^cgfd_[0-9a-f]{40}$/u;
const MAXIMUM_ARRAY_LENGTH = 1_000_000;
const MAXIMUM_SHORT_TEXT_LENGTH = 16_384;
const MAXIMUM_PATH_LENGTH = 4_096;
const UTF8 = new TextEncoder();

export class CodeGraphCheckpointSchemaError extends Schema.TaggedError<
  CodeGraphCheckpointSchemaError,
  {readonly brand: unique symbol}
>()('CodeGraphCheckpointSchemaError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export interface CodeGraphCheckpointDigestV1 {
  readonly algorithm: 'sha256';
  readonly digest: string;
}

export interface CodeGraphCheckpointDescriptorV1 {
  readonly digest: CodeGraphCheckpointSha256;
  readonly mediaType: typeof CODE_GRAPH_CHECKPOINT_MEDIA_TYPE;
  readonly size: number;
}

export interface CodeGraphCheckpointSpanV1 {
  readonly column: number;
  readonly endColumn: number;
  readonly endLine: number;
  readonly line: number;
}

export interface CodeGraphCheckpointLanguagePackV1 {
  readonly cacheIdentity: string;
  readonly derivationIdentity: string;
  readonly id: string;
  readonly resolutionDomain: string;
  readonly resolutionVersion: string;
}

export interface CodeGraphCheckpointAbiInputV1 {
  readonly checkpointSemanticVersion: 1 | typeof CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION;
  readonly graphSchemaVersion: number;
  readonly inventoryPolicyVersion: number;
  readonly languagePacks: readonly CodeGraphCheckpointLanguagePackV1[];
  readonly lexicalLogicalFormatVersion: number;
  readonly pathPolicy: typeof CODE_GRAPH_CHECKPOINT_PATH_POLICY;
  readonly referenceResolutionVersion: string;
  readonly workspaceModelVersion: string;
}

export interface CodeGraphCheckpointAbiV1 {
  readonly algorithm: 'sha256';
  readonly digest: string;
  readonly input: CodeGraphCheckpointAbiInputV1;
}

export interface CodeGraphCheckpointCoverageReasonV1 {
  readonly bytes: number;
  readonly code: string;
  readonly files: number;
}

export interface CodeGraphCheckpointCoverageV1 {
  readonly eligibleFiles: number;
  readonly excludedFiles: number;
  readonly reasons: readonly CodeGraphCheckpointCoverageReasonV1[];
  readonly state: 'complete' | 'partial';
}

export interface CodeGraphCheckpointAttributionFileV1 {
  readonly blobId: string;
  /** Exact byte size of the source Git blob before deterministic context compaction. */
  readonly blobSize: number;
  readonly contentHash: string;
  readonly language: string;
  readonly mode: string;
  readonly path: string;
  readonly size: number;
  readonly source: 'commit';
}

export interface CodeGraphCheckpointPolicyExclusionReasonV1 {
  readonly bytes: number;
  readonly files: number;
  readonly reason: string;
}

export interface CodeGraphCheckpointPolicyExclusionsV1 {
  readonly bytes: number;
  readonly files: number;
  readonly policyVersion: number;
  readonly reasons: readonly CodeGraphCheckpointPolicyExclusionReasonV1[];
}

export interface CodeGraphCheckpointPortableInventoryV1 {
  readonly attributionFiles: readonly CodeGraphCheckpointAttributionFileV1[];
  readonly contract: string;
  readonly diagnostics?: readonly string[];
  readonly includeOpaqueCorpusAssets: boolean;
  readonly policyExclusions: CodeGraphCheckpointPolicyExclusionsV1;
  readonly skipped: number;
  readonly version: number;
  readonly workspace: CodeGraphWorkspace;
}

export interface CodeGraphCheckpointReuseV1 {
  readonly fileSetFingerprint: string;
  readonly formatVersion: number;
  readonly inventory?: CodeGraphCheckpointPortableInventoryV1;
  readonly resolutionSurfaceVersion: number;
  readonly workspaceFingerprint: string;
}

export interface CodeGraphCheckpointMetadataV1 {
  readonly abi: CodeGraphCheckpointAbiInputV1;
  readonly coverage: CodeGraphCheckpointCoverageV1;
  readonly repository: {
    readonly caseMode: 'insensitive' | 'sensitive';
    readonly displayName: string;
    readonly objectFormat: 'sha1' | 'sha256';
    readonly repositoryId: string;
  };
  readonly reuse?: CodeGraphCheckpointReuseV1;
  readonly source: {
    readonly commit: string;
    readonly extractorSet: string;
    readonly graphContentId: string;
  };
}

export interface CodeGraphCheckpointChunkDescriptorV1 {
  readonly compressedBytes: number;
  readonly digest: CodeGraphCheckpointDigestV1;
  readonly ordinal: number;
  readonly recordCount: number;
  readonly uncompressedBytes: number;
}

export type CodeGraphCheckpointCountsV1 = Readonly<Record<CodeGraphCheckpointRecordKind, number>>;

export type CodeGraphCheckpointPackKindV1 = 'checkpoint' | 'delta';

export interface CodeGraphCheckpointDeltaBaseV1 {
  readonly commit: string;
  readonly logicalDigest: CodeGraphCheckpointDigestV1;
  readonly snapshotId: string;
}

export interface CodeGraphCheckpointHeaderV1 {
  readonly abi: CodeGraphCheckpointAbiV1;
  readonly base?: CodeGraphCheckpointDeltaBaseV1;
  readonly chunks: readonly CodeGraphCheckpointChunkDescriptorV1[];
  readonly compressionProfile: typeof CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE;
  readonly counts: CodeGraphCheckpointCountsV1;
  readonly coverage: CodeGraphCheckpointCoverageV1;
  readonly deletions?: readonly CodeGraphCheckpointRecordOrderKeyV1[];
  readonly formatVersion: typeof CODE_GRAPH_CHECKPOINT_FORMAT_VERSION;
  readonly logical: CodeGraphCheckpointDigestV1;
  readonly mediaType: typeof CODE_GRAPH_CHECKPOINT_MEDIA_TYPE;
  readonly packKind?: CodeGraphCheckpointPackKindV1;
  readonly recordSchemaVersion: typeof CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION;
  readonly repository: CodeGraphCheckpointMetadataV1['repository'];
  readonly reuse?: CodeGraphCheckpointReuseV1;
  readonly schema: typeof CODE_GRAPH_CHECKPOINT_SCHEMA;
  readonly source: CodeGraphCheckpointMetadataV1['source'];
}

export interface CodeGraphCheckpointFileRecordV1 {
  readonly blobId: string;
  readonly contentHash: string;
  readonly kind: 'file';
  readonly language: string;
  readonly mode: string;
  readonly path: string;
  readonly rawContentHash?: string;
  readonly size: number;
  readonly source: 'commit';
}

export interface CodeGraphCheckpointFileFactRecordV1 {
  readonly cacheIdentity: string;
  readonly factRole: 'materialized';
  readonly facts: CodeGraphFileFacts;
  readonly kind: 'file-fact';
  readonly path: string;
}

export interface CodeGraphCheckpointWorkspaceScopeRecordV1 {
  readonly buildSystem: string;
  readonly diagnostics: readonly string[];
  readonly id: string;
  readonly kind: 'workspace-scope';
  readonly name: string;
  readonly provenance: 'declared' | 'inferred';
  readonly root: string;
}

export interface CodeGraphCheckpointWorkspaceComponentRecordV1 {
  readonly buildSystem: string;
  readonly componentKind: 'module' | 'package' | 'project' | 'target';
  readonly diagnostics: readonly string[];
  readonly id: string;
  readonly kind: 'workspace-component';
  readonly languages: readonly string[];
  readonly name: string;
  readonly provenance: 'declared' | 'inferred';
  readonly resolutionDomain: string;
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly workspaceId: string;
  readonly workspaceRoots: readonly string[];
}

export interface CodeGraphCheckpointWorkspaceDependencyRecordV1 {
  readonly evidence?: string;
  readonly kind: 'workspace-dependency';
  readonly provenance: 'declared' | 'inferred';
  readonly sourceComponentId: string;
  readonly targetComponentId: string;
}

export interface CodeGraphCheckpointWorkspaceExternalDependencyRecordV1 {
  readonly dependencyKind: 'development' | 'optional' | 'peer' | 'runtime';
  readonly ecosystem: 'npm';
  readonly evidencePath: string;
  readonly evidenceSpan?: CodeGraphCheckpointSpanV1;
  readonly importAlias: string;
  readonly kind: 'workspace-external-dependency';
  readonly packageName: string;
  readonly sourceComponentId: string;
  readonly versionConstraint: string;
}

export interface CodeGraphCheckpointSymbolRecordV1 {
  readonly arity?: number;
  readonly contentHash: string;
  readonly documentation?: string;
  readonly exported: boolean;
  readonly id: string;
  readonly kind: 'symbol';
  readonly language: string;
  readonly lookupKeys?: readonly string[];
  readonly name: string;
  readonly packageName?: string;
  readonly path: string;
  readonly qualifiedName: string;
  readonly resolutionDomain?: string;
  readonly resolutionScopeId?: string;
  readonly signature?: string;
  readonly span: CodeGraphCheckpointSpanV1;
  readonly symbolKind: string;
}

export interface CodeGraphCheckpointSymbolLookupRecordV1 {
  readonly evidenceEdgeId?: string;
  readonly evidencePath?: string;
  readonly exported: boolean;
  readonly kind: 'symbol-lookup';
  readonly lookupKey: string;
  readonly provenance: 'alias' | 'symbol';
  readonly resolutionDomain: string;
  readonly symbolId: string;
}

export interface CodeGraphCheckpointReexportRecordV1 {
  readonly importedName: string;
  readonly kind: 'reexport';
  readonly localName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

export interface CodeGraphCheckpointEdgeRecordV1 {
  readonly confidence: number;
  readonly evidencePath: string;
  readonly evidenceSpan: CodeGraphCheckpointSpanV1;
  readonly id: string;
  readonly kind: 'edge';
  readonly provenance: 'declared' | 'heuristic' | 'model' | 'resolved' | 'syntactic';
  readonly relation:
    | 'calls'
    | 'configures'
    | 'constructs'
    | 'contains'
    | 'declares'
    | 'depends_on'
    | 'documents'
    | 'exports'
    | 'extends'
    | 'implements'
    | 'imports'
    | 'overrides'
    | 'reads_or_writes'
    | 'references'
    | 'reexports'
    | 'semantic_association'
    | 'tests';
  readonly sourceId?: string;
  readonly sourceName: string;
  readonly targetId?: string;
  readonly targetName: string;
}

export interface CodeGraphCheckpointMonikerRecordV1 {
  readonly componentId?: string;
  readonly dependencyKind?: 'development' | 'optional' | 'peer' | 'runtime';
  readonly evidencePath: string;
  readonly evidenceSpan: CodeGraphCheckpointSpanV1;
  readonly id: string;
  readonly identity: string;
  readonly importPath?: string;
  readonly kind: 'moniker';
  readonly monikerKind: string;
  readonly packageName?: string;
  readonly packageVersion?: string;
  readonly qualifiedName?: string;
  readonly resolutionDomain: string;
  readonly role: 'export' | 'import';
  readonly scheme: 'package' | 'protobuf';
  readonly symbolId?: string;
  readonly version: number;
}

export interface CodeGraphCheckpointLexicalRecordV1 {
  readonly kind: 'lexical';
  readonly symbolId: string;
  readonly term: string;
  readonly weight: number;
}

export interface CodeGraphCheckpointPackProvenanceRecordV1 {
  readonly cacheIdentity: string;
  readonly derivationIdentity: string;
  readonly id: string;
  readonly kind: 'pack-provenance';
  readonly resolutionDomain: string;
  readonly resolutionVersion: string;
}

export type CodeGraphCheckpointRecordV1 =
  | CodeGraphCheckpointFileRecordV1
  | CodeGraphCheckpointFileFactRecordV1
  | CodeGraphCheckpointWorkspaceScopeRecordV1
  | CodeGraphCheckpointWorkspaceComponentRecordV1
  | CodeGraphCheckpointWorkspaceDependencyRecordV1
  | CodeGraphCheckpointWorkspaceExternalDependencyRecordV1
  | CodeGraphCheckpointSymbolRecordV1
  | CodeGraphCheckpointSymbolLookupRecordV1
  | CodeGraphCheckpointReexportRecordV1
  | CodeGraphCheckpointEdgeRecordV1
  | CodeGraphCheckpointMonikerRecordV1
  | CodeGraphCheckpointLexicalRecordV1
  | CodeGraphCheckpointPackProvenanceRecordV1;

export interface CodeGraphCheckpointRecordOrderKeyV1 {
  readonly identity: readonly string[];
  readonly kind: CodeGraphCheckpointRecordKind;
}

export function emptyCodeGraphCheckpointCounts(): Record<CodeGraphCheckpointRecordKind, number> {
  return {
    edge: 0,
    file: 0,
    'file-fact': 0,
    lexical: 0,
    moniker: 0,
    'pack-provenance': 0,
    reexport: 0,
    symbol: 0,
    'symbol-lookup': 0,
    'workspace-component': 0,
    'workspace-dependency': 0,
    'workspace-external-dependency': 0,
    'workspace-scope': 0,
  };
}

export function parseCodeGraphCheckpointMetadataV1(value: unknown): CodeGraphCheckpointMetadataV1 {
  const input = object(value, 'Checkpoint metadata');
  canonicalJson(input);
  exactKeys(input, ['abi', 'coverage', 'repository', 'source'], ['reuse'], 'Checkpoint metadata');
  const metadata: CodeGraphCheckpointMetadataV1 = {
    abi: parseAbiInput(input.abi),
    coverage: parseCoverage(input.coverage),
    repository: parseRepository(input.repository),
    ...(input.reuse === undefined ? {} : {reuse: parseReuse(input.reuse)}),
    source: parseSource(input.source),
  };
  canonicalJson(metadata);
  return metadata;
}

export function parseCodeGraphCheckpointHeaderV1(value: unknown): CodeGraphCheckpointHeaderV1 {
  const input = object(value, 'Checkpoint header');
  canonicalJson(input);
  exactKeys(
    input,
    [
      'abi',
      'chunks',
      'compressionProfile',
      'counts',
      'coverage',
      'formatVersion',
      'logical',
      'mediaType',
      'recordSchemaVersion',
      'repository',
      'schema',
      'source',
    ],
    ['base', 'deletions', 'packKind', 'reuse'],
    'Checkpoint header',
  );
  literal(input.schema, CODE_GRAPH_CHECKPOINT_SCHEMA, 'Checkpoint schema');
  literal(input.mediaType, CODE_GRAPH_CHECKPOINT_MEDIA_TYPE, 'Checkpoint media type');
  literal(input.formatVersion, CODE_GRAPH_CHECKPOINT_FORMAT_VERSION, 'Checkpoint format version');
  literal(input.recordSchemaVersion, CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION, 'Checkpoint record schema version');
  literal(input.compressionProfile, CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE, 'Checkpoint compression profile');
  const packKind = parsePackKind(input.packKind);
  const abi = parseAbi(input.abi);
  const metadata = parseCodeGraphCheckpointMetadataV1({
    abi: abi.input,
    coverage: input.coverage,
    repository: input.repository,
    ...(input.reuse === undefined ? {} : {reuse: input.reuse}),
    source: input.source,
  });
  const chunks = EffectArray.map(array(input.chunks, 'Checkpoint chunks'), (chunk, ordinal) =>
    parseChunk(chunk, ordinal),
  );
  const counts = parseCounts(input.counts);
  const chunkRecords = checkedSum(
    EffectArray.map(chunks, chunk => chunk.recordCount),
    'Checkpoint chunk record count',
  );
  const countedRecords = checkedSum(EffectRecord.values(counts), 'Checkpoint record count');
  if (chunkRecords !== countedRecords) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Checkpoint chunk and kind counts do not match.'});
  }
  if (packKind !== 'delta' && counts.file !== metadata.coverage.eligibleFiles) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Checkpoint file count does not match eligible coverage.'});
  }
  if (packKind === 'delta') {
    if (input.base === undefined || input.deletions === undefined) {
      throw CodeGraphCheckpointSchemaError.make({message: 'Delta pack header is missing its base envelope.'});
    }
  } else if (input.base !== undefined || input.deletions !== undefined) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Checkpoint pack header contains a delta envelope.'});
  }
  return {
    abi,
    chunks,
    compressionProfile: CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE,
    counts,
    coverage: metadata.coverage,
    formatVersion: CODE_GRAPH_CHECKPOINT_FORMAT_VERSION,
    logical: parseDigest(input.logical, 'Checkpoint logical digest'),
    mediaType: CODE_GRAPH_CHECKPOINT_MEDIA_TYPE,
    recordSchemaVersion: CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION,
    repository: metadata.repository,
    ...(metadata.reuse === undefined ? {} : {reuse: metadata.reuse}),
    schema: CODE_GRAPH_CHECKPOINT_SCHEMA,
    source: metadata.source,
    ...(packKind === undefined ? {} : {packKind}),
    ...(packKind === 'delta'
      ? {
          base: parseDeltaBase(input.base),
          deletions: parseSortedDeletions(input.deletions),
        }
      : {}),
  };
}

export function parseCodeGraphCheckpointRecordV1(value: unknown): CodeGraphCheckpointRecordV1 {
  const input = object(value, 'Checkpoint record');
  canonicalJson(input);
  const kind = text(input.kind, 'Checkpoint record kind');
  switch (kind) {
    case 'file':
      exactKeys(
        input,
        ['blobId', 'contentHash', 'kind', 'language', 'mode', 'path', 'size', 'source'],
        ['rawContentHash'],
        'File record',
      );
      gitObjectId(input.blobId, 'File blob ID');
      return {
        blobId: gitObjectId(input.blobId, 'File blob ID'),
        contentHash: sha256(input.contentHash, 'File content hash'),
        kind: 'file',
        language: shortText(input.language, 'File language'),
        mode: mode(input.mode, 'File mode'),
        path: repositoryPath(input.path, 'File path'),
        ...(input.rawContentHash === undefined
          ? {}
          : {rawContentHash: sha256(input.rawContentHash, 'File raw content hash')}),
        size: nonNegativeInteger(input.size, 'File size'),
        source: literal(input.source, 'commit', 'File source'),
      };
    case 'file-fact': {
      exactKeys(input, ['cacheIdentity', 'factRole', 'facts', 'kind', 'path'], [], 'File-fact record');
      if (typeof input.cacheIdentity !== 'string' || !MATERIALIZED_FACT_IDENTITY.test(input.cacheIdentity)) {
        throw CodeGraphCheckpointSchemaError.make({
          message: 'File-fact cache identity is not a materialized derivation ID.',
        });
      }
      const factRole = literal(input.factRole, 'materialized', 'File-fact role');
      const path = repositoryPath(input.path, 'File-fact path');
      const facts = parseFileFacts(input.facts, path);
      if (input.cacheIdentity !== codeGraphCheckpointFileFactCacheIdentity(facts)) {
        throw CodeGraphCheckpointSchemaError.make({message: 'File-fact cache identity does not match its payload.'});
      }
      return {cacheIdentity: input.cacheIdentity, factRole, facts, kind: 'file-fact', path};
    }
    case 'workspace-scope': {
      exactKeys(
        input,
        ['buildSystem', 'diagnostics', 'id', 'kind', 'name', 'provenance', 'root'],
        [],
        'Workspace-scope record',
      );
      const root = workspaceRoot(input.root, 'Workspace root');
      return {
        buildSystem: workspaceBuildSystem(input.buildSystem, 'Workspace build system'),
        diagnostics: stringArray(input.diagnostics, 'Workspace diagnostics'),
        id: shortText(input.id, 'Workspace ID'),
        kind: 'workspace-scope',
        name: workspaceName(input.name, root, 'Workspace name'),
        provenance: workspaceProvenance(input.provenance, 'Workspace provenance'),
        root,
      };
    }
    case 'workspace-component':
      exactKeys(
        input,
        [
          'buildSystem',
          'componentKind',
          'diagnostics',
          'id',
          'kind',
          'languages',
          'name',
          'provenance',
          'resolutionDomain',
          'root',
          'sourceRoots',
          'workspaceId',
          'workspaceRoots',
        ],
        [],
        'Workspace-component record',
      );
      return {
        buildSystem: workspaceBuildSystem(input.buildSystem, 'Component build system'),
        componentKind: oneOf(input.componentKind, ['module', 'package', 'project', 'target'], 'Component kind'),
        diagnostics: stringArray(input.diagnostics, 'Component diagnostics'),
        id: shortText(input.id, 'Component ID'),
        kind: 'workspace-component',
        languages: stringArray(input.languages, 'Component languages'),
        name: shortText(input.name, 'Component name'),
        provenance: workspaceProvenance(input.provenance, 'Component provenance'),
        resolutionDomain: shortText(input.resolutionDomain, 'Component resolution domain'),
        root: workspaceRoot(input.root, 'Component root'),
        sourceRoots: pathArray(input.sourceRoots, 'Component source roots', true),
        workspaceId: shortText(input.workspaceId, 'Component workspace ID'),
        workspaceRoots: pathArray(input.workspaceRoots, 'Component workspace roots', true),
      };
    case 'workspace-dependency':
      exactKeys(
        input,
        ['kind', 'provenance', 'sourceComponentId', 'targetComponentId'],
        ['evidence'],
        'Workspace-dependency record',
      );
      return {
        ...(input.evidence === undefined ? {} : {evidence: shortText(input.evidence, 'Workspace dependency evidence')}),
        kind: 'workspace-dependency',
        provenance: workspaceProvenance(input.provenance, 'Workspace dependency provenance'),
        sourceComponentId: shortText(input.sourceComponentId, 'Workspace dependency source'),
        targetComponentId: shortText(input.targetComponentId, 'Workspace dependency target'),
      };
    case 'workspace-external-dependency':
      exactKeys(
        input,
        [
          'dependencyKind',
          'ecosystem',
          'evidencePath',
          'importAlias',
          'kind',
          'packageName',
          'sourceComponentId',
          'versionConstraint',
        ],
        ['evidenceSpan'],
        'Workspace external-dependency record',
      );
      return {
        dependencyKind: dependencyKind(input.dependencyKind, 'External dependency kind'),
        ecosystem: literal(input.ecosystem, 'npm', 'External dependency ecosystem'),
        evidencePath: repositoryPath(input.evidencePath, 'External dependency evidence path'),
        ...(input.evidenceSpan === undefined
          ? {}
          : {evidenceSpan: parseSpan(input.evidenceSpan, 'External dependency evidence span')}),
        importAlias: shortText(input.importAlias, 'External dependency alias'),
        kind: 'workspace-external-dependency',
        packageName: shortText(input.packageName, 'External dependency package'),
        sourceComponentId: shortText(input.sourceComponentId, 'External dependency component'),
        versionConstraint: shortText(input.versionConstraint, 'External dependency version'),
      };
    case 'symbol':
      return parseSymbol(input);
    case 'symbol-lookup':
      exactKeys(
        input,
        ['exported', 'kind', 'lookupKey', 'provenance', 'resolutionDomain', 'symbolId'],
        ['evidenceEdgeId', 'evidencePath'],
        'Symbol-lookup record',
      );
      return {
        ...(input.evidenceEdgeId === undefined
          ? {}
          : {evidenceEdgeId: shortText(input.evidenceEdgeId, 'Symbol lookup evidence edge')}),
        ...(input.evidencePath === undefined
          ? {}
          : {evidencePath: repositoryPath(input.evidencePath, 'Symbol lookup evidence path')}),
        exported: boolean(input.exported, 'Symbol lookup exported'),
        kind: 'symbol-lookup',
        lookupKey: shortText(input.lookupKey, 'Symbol lookup key'),
        provenance: oneOf(input.provenance, ['alias', 'symbol'], 'Symbol lookup provenance'),
        resolutionDomain: shortText(input.resolutionDomain, 'Symbol lookup resolution domain'),
        symbolId: shortText(input.symbolId, 'Symbol lookup symbol ID'),
      };
    case 'reexport':
      exactKeys(input, ['importedName', 'kind', 'localName', 'sourcePath', 'targetPath'], [], 'Reexport record');
      return {
        importedName: shortText(input.importedName, 'Reexport imported name'),
        kind: 'reexport',
        localName: shortText(input.localName, 'Reexport local name'),
        sourcePath: repositoryPath(input.sourcePath, 'Reexport source path'),
        targetPath: repositoryPath(input.targetPath, 'Reexport target path'),
      };
    case 'edge':
      return parseEdge(input);
    case 'moniker':
      return parseMoniker(input);
    case 'lexical':
      exactKeys(input, ['kind', 'symbolId', 'term', 'weight'], [], 'Lexical record');
      return {
        kind: 'lexical',
        symbolId: shortText(input.symbolId, 'Lexical symbol ID'),
        term: shortText(input.term, 'Lexical term'),
        weight: positiveInteger(input.weight, 'Lexical weight', 1_000),
      };
    case 'pack-provenance':
      exactKeys(
        input,
        ['cacheIdentity', 'derivationIdentity', 'id', 'kind', 'resolutionDomain', 'resolutionVersion'],
        [],
        'Pack-provenance record',
      );
      return {
        cacheIdentity: sha256(input.cacheIdentity, 'Pack cache identity'),
        derivationIdentity: sha256(input.derivationIdentity, 'Pack derivation identity'),
        id: shortText(input.id, 'Pack ID'),
        kind: 'pack-provenance',
        resolutionDomain: shortText(input.resolutionDomain, 'Pack resolution domain'),
        resolutionVersion: shortText(input.resolutionVersion, 'Pack resolution version'),
      };
    default:
      throw CodeGraphCheckpointSchemaError.make({message: `Unknown checkpoint record kind: ${kind}.`});
  }
}

export function codeGraphCheckpointRecordIdentity(record: CodeGraphCheckpointRecordV1): string {
  return canonicalJson([record.kind, ...codeGraphCheckpointRecordIdentityTuple(record)]);
}

export function codeGraphCheckpointRecordIdentityTuple(record: CodeGraphCheckpointRecordV1): readonly string[] {
  switch (record.kind) {
    case 'file':
      return [record.path];
    case 'file-fact':
      return [record.path, record.cacheIdentity];
    case 'workspace-scope':
    case 'workspace-component':
    case 'symbol':
    case 'edge':
    case 'moniker':
    case 'pack-provenance':
      return [record.id];
    case 'workspace-dependency':
      return [record.sourceComponentId, record.targetComponentId, record.provenance];
    case 'workspace-external-dependency':
      return [
        record.sourceComponentId,
        record.ecosystem,
        record.packageName,
        record.importAlias,
        record.dependencyKind,
        record.versionConstraint,
        record.evidencePath,
      ];
    case 'symbol-lookup':
      return [record.lookupKey, record.symbolId];
    case 'reexport':
      return [record.sourcePath, record.localName, record.targetPath, record.importedName];
    case 'lexical':
      return [record.term, record.symbolId];
  }
}

export function compareCodeGraphCheckpointRecords(
  left: CodeGraphCheckpointRecordV1,
  right: CodeGraphCheckpointRecordV1,
): number {
  return compareCodeGraphCheckpointRecordOrderKeys(
    codeGraphCheckpointRecordOrderKey(left),
    codeGraphCheckpointRecordOrderKey(right),
  );
}

export function codeGraphCheckpointRecordOrderKey(
  record: CodeGraphCheckpointRecordV1,
): CodeGraphCheckpointRecordOrderKeyV1 {
  return {identity: codeGraphCheckpointRecordIdentityTuple(record), kind: record.kind};
}

export function compareCodeGraphCheckpointRecordOrderKeys(
  left: CodeGraphCheckpointRecordOrderKeyV1,
  right: CodeGraphCheckpointRecordOrderKeyV1,
): number {
  const kind = RECORD_KIND_ORDER.get(left.kind)! - RECORD_KIND_ORDER.get(right.kind)!;
  if (kind !== 0) return kind;
  for (let index = 0; index < left.identity.length; index += 1) {
    const order = compareUtf8(left.identity[index], right.identity[index]);
    if (order !== 0) return order;
  }
  return left.identity.length - right.identity.length;
}

export function isSafeCodeGraphCheckpointPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAXIMUM_PATH_LENGTH ||
    Effect.pipe(value, EffectString.startsWith('/')) ||
    Effect.pipe(value, EffectString.startsWith('\\')) ||
    /^[A-Za-z]:/u.test(value) ||
    Effect.pipe(value, EffectString.includes('\\')) ||
    containsControlCharacter(value)
  ) {
    return false;
  }
  return !EffectArray.some(
    Effect.pipe(value, EffectString.split('/')),
    segment => segment === '' || segment === '.' || segment === '..',
  );
}

const CONTROL_CHARACTER = /[^\u0020-\u007e\u0080-\u{10ffff}]/u;

function containsControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

function parseAbiInput(value: unknown): CodeGraphCheckpointAbiInputV1 {
  const input = object(value, 'Checkpoint ABI input');
  exactKeys(
    input,
    [
      'checkpointSemanticVersion',
      'graphSchemaVersion',
      'inventoryPolicyVersion',
      'languagePacks',
      'lexicalLogicalFormatVersion',
      'pathPolicy',
      'referenceResolutionVersion',
      'workspaceModelVersion',
    ],
    [],
    'Checkpoint ABI input',
  );
  if (
    input.checkpointSemanticVersion !== 1 &&
    input.checkpointSemanticVersion !== CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION
  ) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Checkpoint semantic version is invalid.'});
  }
  const checkpointSemanticVersion = input.checkpointSemanticVersion;
  const graphSchemaVersion = nonNegativeInteger(input.graphSchemaVersion, 'Graph schema version');
  const inventoryPolicyVersion = nonNegativeInteger(input.inventoryPolicyVersion, 'Inventory policy version');
  const languagePacks = EffectArray.map(array(input.languagePacks, 'ABI language packs'), parseLanguagePack);
  ensureSortedUnique(languagePacks, pack => pack.id, 'ABI language packs');
  const lexicalLogicalFormatVersion = nonNegativeInteger(
    input.lexicalLogicalFormatVersion,
    'Lexical logical format version',
  );
  const pathPolicy = literal(input.pathPolicy, CODE_GRAPH_CHECKPOINT_PATH_POLICY, 'Checkpoint path policy');
  const referenceResolutionVersion = shortText(input.referenceResolutionVersion, 'Reference resolution version');
  const workspaceModelVersion = shortText(input.workspaceModelVersion, 'Workspace model version');
  return {
    checkpointSemanticVersion,
    graphSchemaVersion,
    inventoryPolicyVersion,
    languagePacks,
    lexicalLogicalFormatVersion,
    pathPolicy,
    referenceResolutionVersion,
    workspaceModelVersion,
  };
}

function parseAbi(value: unknown): CodeGraphCheckpointAbiV1 {
  const input = object(value, 'Checkpoint ABI');
  exactKeys(input, ['algorithm', 'digest', 'input'], [], 'Checkpoint ABI');
  const algorithm = literal(input.algorithm, 'sha256', 'Checkpoint ABI algorithm');
  const digest = sha256(input.digest, 'Checkpoint ABI digest');
  return {algorithm, digest, input: parseAbiInput(input.input)};
}

function parseLanguagePack(value: unknown): CodeGraphCheckpointLanguagePackV1 {
  const input = object(value, 'ABI language pack');
  exactKeys(
    input,
    ['cacheIdentity', 'derivationIdentity', 'id', 'resolutionDomain', 'resolutionVersion'],
    [],
    'ABI language pack',
  );
  return {
    cacheIdentity: sha256(input.cacheIdentity, 'Language-pack cache identity'),
    derivationIdentity: sha256(input.derivationIdentity, 'Language-pack derivation identity'),
    id: shortText(input.id, 'Language-pack ID'),
    resolutionDomain: shortText(input.resolutionDomain, 'Language-pack resolution domain'),
    resolutionVersion: shortText(input.resolutionVersion, 'Language-pack resolution version'),
  };
}

function parseRepository(value: unknown): CodeGraphCheckpointMetadataV1['repository'] {
  const input = object(value, 'Checkpoint repository');
  exactKeys(input, ['caseMode', 'displayName', 'objectFormat', 'repositoryId'], [], 'Checkpoint repository');
  return {
    caseMode: oneOf(input.caseMode, ['insensitive', 'sensitive'], 'Repository case mode'),
    displayName: shortText(input.displayName, 'Repository display name'),
    objectFormat: oneOf(input.objectFormat, ['sha1', 'sha256'], 'Repository object format'),
    repositoryId: sha256(input.repositoryId, 'Repository ID'),
  };
}

function parseSource(value: unknown): CodeGraphCheckpointMetadataV1['source'] {
  const input = object(value, 'Checkpoint source');
  exactKeys(input, ['commit', 'extractorSet', 'graphContentId'], [], 'Checkpoint source');
  const graphContentId = text(input.graphContentId, 'Checkpoint graph content ID');
  if (!GRAPH_CONTENT_ID.test(graphContentId)) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Checkpoint graph content ID is invalid.'});
  }
  return {
    commit: gitObjectId(input.commit, 'Checkpoint commit'),
    extractorSet: shortText(input.extractorSet, 'Checkpoint extractor set'),
    graphContentId,
  };
}

function parseCoverage(value: unknown): CodeGraphCheckpointCoverageV1 {
  const input = object(value, 'Checkpoint coverage');
  exactKeys(input, ['eligibleFiles', 'excludedFiles', 'reasons', 'state'], [], 'Checkpoint coverage');
  const eligibleFiles = nonNegativeInteger(input.eligibleFiles, 'Coverage eligible files');
  const excludedFiles = nonNegativeInteger(input.excludedFiles, 'Coverage excluded files');
  const reasons = EffectArray.map(array(input.reasons, 'Coverage reasons'), reason => {
    const candidate = object(reason, 'Coverage reason');
    exactKeys(candidate, ['bytes', 'code', 'files'], [], 'Coverage reason');
    return {
      bytes: nonNegativeInteger(candidate.bytes, 'Coverage reason bytes'),
      code: shortText(candidate.code, 'Coverage reason code'),
      files: nonNegativeInteger(candidate.files, 'Coverage reason files'),
    };
  });
  ensureSortedUnique(reasons, reason => reason.code, 'Coverage reasons');
  const state = oneOf(input.state, ['complete', 'partial'], 'Coverage state');
  const explainedFiles = checkedSum(
    EffectArray.map(reasons, reason => reason.files),
    'Coverage reason file count',
  );
  if (explainedFiles !== excludedFiles) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Coverage reasons do not account for every excluded file.'});
  }
  if ((excludedFiles === 0) !== (state === 'complete')) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Coverage state does not match the excluded-file count.'});
  }
  return {eligibleFiles, excludedFiles, reasons, state};
}

function parsePackKind(value: unknown): CodeGraphCheckpointPackKindV1 | undefined {
  if (value === undefined) return undefined;
  return oneOf(value, ['checkpoint', 'delta'], 'Checkpoint pack kind');
}

function parseDeltaBase(value: unknown): CodeGraphCheckpointDeltaBaseV1 {
  const input = object(value, 'Checkpoint delta base');
  exactKeys(input, ['commit', 'logicalDigest', 'snapshotId'], [], 'Checkpoint delta base');
  return {
    commit: gitObjectId(input.commit, 'Delta base commit'),
    logicalDigest: parseDigest(input.logicalDigest, 'Delta base logical digest'),
    snapshotId: shortText(input.snapshotId, 'Delta base snapshot ID'),
  };
}

function parseRecordOrderKey(value: unknown, label: string): CodeGraphCheckpointRecordOrderKeyV1 {
  const input = object(value, label);
  exactKeys(input, ['identity', 'kind'], [], label);
  const kind = oneOf(input.kind, CODE_GRAPH_CHECKPOINT_RECORD_KINDS, `${label} kind`);
  const identity = EffectArray.map(array(input.identity, `${label} identity`), (entry, index) =>
    shortText(entry, `${label} identity ${index}`),
  );
  return {identity, kind};
}

function parseSortedDeletions(value: unknown): readonly CodeGraphCheckpointRecordOrderKeyV1[] {
  const deletions = EffectArray.map(array(value, 'Checkpoint deletions'), (deletion, index) =>
    parseRecordOrderKey(deletion, `Checkpoint deletion ${index}`),
  );
  for (let index = 1; index < deletions.length; index += 1) {
    const previous = deletions[index - 1];
    const current = deletions[index];
    if (previous === undefined || current === undefined) {
      throw CodeGraphCheckpointSchemaError.make({message: 'Checkpoint deletions are not in canonical order.'});
    }
    if (compareCodeGraphCheckpointRecordOrderKeys(previous, current) >= 0) {
      throw CodeGraphCheckpointSchemaError.make({message: 'Checkpoint deletions are not in canonical order.'});
    }
  }
  return deletions;
}

function parseReuse(value: unknown): CodeGraphCheckpointReuseV1 {
  const input = object(value, 'Checkpoint reuse');
  exactKeys(
    input,
    ['fileSetFingerprint', 'formatVersion', 'resolutionSurfaceVersion', 'workspaceFingerprint'],
    ['inventory'],
    'Checkpoint reuse',
  );
  const fileSetFingerprint = sha256(input.fileSetFingerprint, 'Reuse file-set fingerprint');
  const formatVersion = positiveInteger(input.formatVersion, 'Reuse format version');
  const resolutionSurfaceVersion = positiveInteger(input.resolutionSurfaceVersion, 'Reuse resolution-surface version');
  const workspaceFingerprint = sha256(input.workspaceFingerprint, 'Reuse workspace fingerprint');
  const inventory = input.inventory === undefined ? undefined : parsePortableInventory(input.inventory);
  if (inventory !== undefined) {
    if (inventory.workspace.fingerprint !== workspaceFingerprint) {
      throw CodeGraphCheckpointSchemaError.make({
        message: 'Portable workspace fingerprint does not match reuse metadata.',
      });
    }
  }
  return {
    fileSetFingerprint,
    formatVersion,
    ...(inventory === undefined ? {} : {inventory}),
    resolutionSurfaceVersion,
    workspaceFingerprint,
  };
}

function parsePortableInventory(value: unknown): CodeGraphCheckpointPortableInventoryV1 {
  const input = object(value, 'Portable inventory');
  exactKeys(
    input,
    [
      'attributionFiles',
      'contract',
      'includeOpaqueCorpusAssets',
      'policyExclusions',
      'skipped',
      'version',
      'workspace',
    ],
    ['diagnostics'],
    'Portable inventory',
  );
  const attributionFiles = EffectArray.map(array(input.attributionFiles, 'Attribution files'), parseAttributionFile);
  if (attributionFiles.length > CODE_GRAPH_CHECKPOINT_ATTRIBUTION_FILES_MAXIMUM) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Attribution file count exceeds the portable boundary.'});
  }
  ensureSortedUnique(attributionFiles, file => file.path, 'Attribution files');
  const attributionContentBytes = checkedSum(
    EffectArray.map(attributionFiles, file => file.size),
    'Attribution compact content bytes',
  );
  const attributionSourceBytes = checkedSum(
    EffectArray.map(attributionFiles, file => file.blobSize),
    'Attribution source bytes',
  );
  if (
    attributionContentBytes > CODE_GRAPH_CHECKPOINT_ATTRIBUTION_CONTENT_BYTES_MAXIMUM ||
    attributionSourceBytes > CODE_GRAPH_CHECKPOINT_ATTRIBUTION_SOURCE_BYTES_MAXIMUM
  ) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Attribution context exceeds the portable byte boundary.'});
  }
  const contract = sha256(input.contract, 'Inventory contract');
  const diagnostics =
    input.diagnostics === undefined ? undefined : stringArray(input.diagnostics, 'Inventory diagnostics');
  const includeOpaqueCorpusAssets = boolean(input.includeOpaqueCorpusAssets, 'Inventory opaque-corpus policy');
  const policyExclusions = parsePolicyExclusions(input.policyExclusions);
  const skipped = nonNegativeInteger(input.skipped, 'Inventory skipped files');
  const version = positiveInteger(input.version, 'Inventory version');
  const workspace = parseWorkspace(input.workspace);
  return {
    attributionFiles,
    contract,
    ...(diagnostics === undefined ? {} : {diagnostics}),
    includeOpaqueCorpusAssets,
    policyExclusions,
    skipped,
    version,
    workspace,
  };
}

function parseAttributionFile(value: unknown): CodeGraphCheckpointAttributionFileV1 {
  const input = object(value, 'Attribution file');
  exactKeys(
    input,
    ['blobId', 'blobSize', 'contentHash', 'language', 'mode', 'path', 'size', 'source'],
    [],
    'Attribution file',
  );
  return {
    blobId: gitObjectId(input.blobId, 'Attribution blob ID'),
    blobSize: nonNegativeInteger(input.blobSize, 'Attribution blob size'),
    contentHash: sha256(input.contentHash, 'Attribution content hash'),
    language: shortText(input.language, 'Attribution language'),
    mode: mode(input.mode, 'Attribution mode'),
    path: repositoryPath(input.path, 'Attribution path'),
    size: nonNegativeInteger(input.size, 'Attribution size'),
    source: literal(input.source, 'commit', 'Attribution source'),
  };
}

function parsePolicyExclusions(value: unknown): CodeGraphCheckpointPolicyExclusionsV1 {
  const input = object(value, 'Policy exclusions');
  exactKeys(input, ['bytes', 'files', 'policyVersion', 'reasons'], [], 'Policy exclusions');
  const bytes = nonNegativeInteger(input.bytes, 'Policy exclusion bytes');
  const files = nonNegativeInteger(input.files, 'Policy exclusion files');
  const policyVersion = positiveInteger(input.policyVersion, 'Policy exclusion version');
  const reasons = EffectArray.map(array(input.reasons, 'Policy exclusion reasons'), value => {
    const reason = object(value, 'Policy exclusion reason');
    exactKeys(reason, ['bytes', 'files', 'reason'], [], 'Policy exclusion reason');
    return {
      bytes: nonNegativeInteger(reason.bytes, 'Policy exclusion reason bytes'),
      files: nonNegativeInteger(reason.files, 'Policy exclusion reason files'),
      reason: shortText(reason.reason, 'Policy exclusion reason'),
    };
  });
  ensureSortedUnique(reasons, reason => reason.reason, 'Policy exclusion reasons');
  return {bytes, files, policyVersion, reasons};
}

function parseWorkspace(value: unknown): CodeGraphWorkspace {
  const input = object(value, 'Portable workspace');
  exactKeys(input, ['diagnostics', 'fingerprint', 'projects', 'workspaces'], [], 'Portable workspace');
  const diagnostics = stringArray(input.diagnostics, 'Workspace diagnostics');
  const fingerprint = sha256(input.fingerprint, 'Workspace fingerprint');
  const projects = EffectArray.map(array(input.projects, 'Workspace projects'), parseWorkspaceProject);
  const workspaces = EffectArray.map(array(input.workspaces, 'Build workspaces'), parseBuildWorkspace);
  ensureSortedUnique(projects, project => project.id, 'Workspace projects');
  ensureSortedUnique(workspaces, workspace => workspace.id, 'Build workspaces');
  canonicalJson(input);
  return {diagnostics, fingerprint, projects, workspaces};
}

function parseWorkspaceProject(value: unknown): CodeGraphWorkspaceProject {
  const input = object(value, 'Workspace project');
  exactKeys(
    input,
    [
      'buildSystem',
      'dependencies',
      'dependencyDetails',
      'diagnostics',
      'id',
      'kind',
      'languages',
      'name',
      'provenance',
      'resolutionDomain',
      'root',
      'sourceRoots',
      'workspaceId',
      'workspaceRoots',
    ],
    ['externalDependencies', 'monikers'],
    'Workspace project',
  );
  const buildSystem = workspaceBuildSystem(input.buildSystem, 'Project build system');
  const dependencies = stringArray(input.dependencies, 'Project dependencies');
  const dependencyDetails: readonly CodeGraphWorkspaceDependency[] = EffectArray.map(
    array(input.dependencyDetails, 'Project dependency details'),
    detail => {
      const candidate = object(detail, 'Project dependency detail');
      exactKeys(candidate, ['provenance', 'targetId'], ['evidence'], 'Project dependency detail');
      const evidence =
        candidate.evidence === undefined ? undefined : shortText(candidate.evidence, 'Project dependency evidence');
      return {
        ...(evidence === undefined ? {} : {evidence}),
        provenance: workspaceProvenance(candidate.provenance, 'Project dependency provenance'),
        targetId: shortText(candidate.targetId, 'Project dependency target'),
      };
    },
  );
  const diagnostics = stringArray(input.diagnostics, 'Project diagnostics');
  const id = shortText(input.id, 'Project ID');
  const kind = oneOf(input.kind, ['module', 'package', 'project', 'target'], 'Project kind');
  const languages = stringArray(input.languages, 'Project languages');
  const name = shortText(input.name, 'Project name');
  const provenance = workspaceProvenance(input.provenance, 'Project provenance');
  const resolutionDomain = shortText(input.resolutionDomain, 'Project resolution domain');
  const root = workspaceRoot(input.root, 'Project root');
  const sourceRoots = pathArray(input.sourceRoots, 'Project source roots', true);
  const workspaceId = shortText(input.workspaceId, 'Project workspace ID');
  const workspaceRoots = pathArray(input.workspaceRoots, 'Project workspace roots', true);
  const externalDependencies =
    input.externalDependencies === undefined
      ? undefined
      : EffectArray.map(array(input.externalDependencies, 'Project external dependencies'), parseExternalDependency);
  const monikers: readonly CodeGraphMonikerV1[] | undefined =
    input.monikers === undefined
      ? undefined
      : EffectArray.map(array(input.monikers, 'Project monikers'), parseCodeGraphMonikerV1);
  return {
    buildSystem,
    dependencies,
    dependencyDetails,
    diagnostics,
    ...(externalDependencies === undefined ? {} : {externalDependencies}),
    id,
    kind,
    languages,
    ...(monikers === undefined ? {} : {monikers}),
    name,
    provenance,
    resolutionDomain,
    root,
    sourceRoots,
    workspaceId,
    workspaceRoots,
  };
}

function parseExternalDependency(value: unknown): CodeGraphExternalDependencyV1 {
  const input = object(value, 'Project external dependency');
  exactKeys(
    input,
    ['ecosystem', 'evidence', 'importAlias', 'kind', 'name', 'versionConstraint'],
    [],
    'Project external dependency',
  );
  const evidenceInput = object(input.evidence, 'Project external dependency evidence');
  exactKeys(evidenceInput, ['path'], ['span'], 'Project external dependency evidence');
  const span =
    evidenceInput.span === undefined ? undefined : parseSpan(evidenceInput.span, 'Project external dependency span');
  return {
    ecosystem: literal(input.ecosystem, 'npm', 'Project external dependency ecosystem'),
    evidence: {
      path: repositoryPath(evidenceInput.path, 'Project external dependency path'),
      ...(span === undefined ? {} : {span}),
    },
    importAlias: shortText(input.importAlias, 'Project external dependency alias'),
    kind: dependencyKind(input.kind, 'Project external dependency kind'),
    name: shortText(input.name, 'Project external dependency name'),
    versionConstraint: shortText(input.versionConstraint, 'Project external dependency version'),
  };
}

function parseBuildWorkspace(value: unknown): CodeGraphBuildWorkspace {
  const input = object(value, 'Build workspace');
  exactKeys(input, ['buildSystem', 'diagnostics', 'id', 'name', 'provenance', 'root'], [], 'Build workspace');
  const root = workspaceRoot(input.root, 'Build workspace root');
  return {
    buildSystem: workspaceBuildSystem(input.buildSystem, 'Build workspace system'),
    diagnostics: stringArray(input.diagnostics, 'Build workspace diagnostics'),
    id: shortText(input.id, 'Build workspace ID'),
    name: workspaceName(input.name, root, 'Build workspace name'),
    provenance: workspaceProvenance(input.provenance, 'Build workspace provenance'),
    root,
  };
}

function parseChunk(value: unknown, expectedOrdinal: number): CodeGraphCheckpointChunkDescriptorV1 {
  const input = object(value, 'Checkpoint chunk');
  exactKeys(
    input,
    ['compressedBytes', 'digest', 'ordinal', 'recordCount', 'uncompressedBytes'],
    [],
    'Checkpoint chunk',
  );
  const compressedBytes = positiveInteger(input.compressedBytes, 'Chunk compressed bytes');
  const digest = parseDigest(input.digest, 'Chunk digest');
  const ordinal = nonNegativeInteger(input.ordinal, 'Chunk ordinal');
  if (ordinal !== expectedOrdinal)
    throw CodeGraphCheckpointSchemaError.make({message: 'Chunk ordinals are not contiguous.'});
  const recordCount = positiveInteger(input.recordCount, 'Chunk record count');
  const uncompressedBytes = positiveInteger(input.uncompressedBytes, 'Chunk uncompressed bytes');
  return {compressedBytes, digest, ordinal, recordCount, uncompressedBytes};
}

function parseCounts(value: unknown): CodeGraphCheckpointCountsV1 {
  const input = object(value, 'Checkpoint counts');
  exactKeys(input, [...CODE_GRAPH_CHECKPOINT_RECORD_KINDS], [], 'Checkpoint counts');
  const counts = emptyCodeGraphCheckpointCounts();
  for (const kind of CODE_GRAPH_CHECKPOINT_RECORD_KINDS) {
    counts[kind] = nonNegativeInteger(input[kind], `${kind} count`);
  }
  return counts;
}

function parseDigest(value: unknown, label: string): CodeGraphCheckpointDigestV1 {
  const input = object(value, label);
  exactKeys(input, ['algorithm', 'digest'], [], label);
  return {
    algorithm: literal(input.algorithm, 'sha256', `${label} algorithm`),
    digest: sha256(input.digest, label),
  };
}

function parseFileFacts(value: unknown, expectedPath: string): CodeGraphFileFacts {
  let facts: CodeGraphFileFacts;
  try {
    facts = parseCodeGraphFileFacts(value);
  } catch (cause) {
    throw CodeGraphCheckpointSchemaError.make({cause, message: 'File-fact payload is invalid.'});
  }
  if (facts.path !== expectedPath)
    throw CodeGraphCheckpointSchemaError.make({message: 'File-fact payload path does not match its key.'});
  canonicalJson(facts);
  return facts;
}

function parseSymbol(input: Record<string, unknown>): CodeGraphCheckpointSymbolRecordV1 {
  exactKeys(
    input,
    ['contentHash', 'exported', 'id', 'kind', 'language', 'name', 'path', 'qualifiedName', 'span', 'symbolKind'],
    ['arity', 'documentation', 'lookupKeys', 'packageName', 'resolutionDomain', 'resolutionScopeId', 'signature'],
    'Symbol record',
  );
  return {
    ...(input.arity === undefined ? {} : {arity: nonNegativeInteger(input.arity, 'Symbol arity')}),
    contentHash: sha256(input.contentHash, 'Symbol content hash'),
    ...(input.documentation === undefined ? {} : {documentation: text(input.documentation, 'Symbol documentation')}),
    exported: boolean(input.exported, 'Symbol exported'),
    id: shortText(input.id, 'Symbol ID'),
    kind: 'symbol',
    language: shortText(input.language, 'Symbol language'),
    ...(input.lookupKeys === undefined ? {} : {lookupKeys: stringArray(input.lookupKeys, 'Symbol lookup keys')}),
    name: shortText(input.name, 'Symbol name'),
    ...(input.packageName === undefined ? {} : {packageName: shortText(input.packageName, 'Symbol package name')}),
    path: repositoryPath(input.path, 'Symbol path'),
    qualifiedName: shortText(input.qualifiedName, 'Symbol qualified name'),
    ...(input.resolutionDomain === undefined
      ? {}
      : {resolutionDomain: shortText(input.resolutionDomain, 'Symbol resolution domain')}),
    ...(input.resolutionScopeId === undefined
      ? {}
      : {resolutionScopeId: shortText(input.resolutionScopeId, 'Symbol resolution scope')}),
    ...(input.signature === undefined ? {} : {signature: text(input.signature, 'Symbol signature')}),
    span: parseSpan(input.span, 'Symbol span'),
    symbolKind: shortText(input.symbolKind, 'Symbol kind'),
  };
}

function parseEdge(input: Record<string, unknown>): CodeGraphCheckpointEdgeRecordV1 {
  exactKeys(
    input,
    ['confidence', 'evidencePath', 'evidenceSpan', 'id', 'kind', 'provenance', 'relation', 'sourceName', 'targetName'],
    ['sourceId', 'targetId'],
    'Edge record',
  );
  return {
    confidence: finiteRange(input.confidence, 'Edge confidence', 0, 1),
    evidencePath: repositoryPath(input.evidencePath, 'Edge evidence path'),
    evidenceSpan: parseSpan(input.evidenceSpan, 'Edge evidence span'),
    id: shortText(input.id, 'Edge ID'),
    kind: 'edge',
    provenance: oneOf(input.provenance, ['declared', 'heuristic', 'model', 'resolved', 'syntactic'], 'Edge provenance'),
    relation: oneOf(
      input.relation,
      [
        'calls',
        'configures',
        'constructs',
        'contains',
        'declares',
        'depends_on',
        'documents',
        'exports',
        'extends',
        'implements',
        'imports',
        'overrides',
        'reads_or_writes',
        'references',
        'reexports',
        'semantic_association',
        'tests',
      ],
      'Edge relation',
    ),
    ...(input.sourceId === undefined ? {} : {sourceId: shortText(input.sourceId, 'Edge source ID')}),
    sourceName: shortText(input.sourceName, 'Edge source name'),
    ...(input.targetId === undefined ? {} : {targetId: shortText(input.targetId, 'Edge target ID')}),
    targetName: shortText(input.targetName, 'Edge target name'),
  };
}

function parseMoniker(input: Record<string, unknown>): CodeGraphCheckpointMonikerRecordV1 {
  exactKeys(
    input,
    [
      'evidencePath',
      'evidenceSpan',
      'id',
      'identity',
      'kind',
      'monikerKind',
      'resolutionDomain',
      'role',
      'scheme',
      'version',
    ],
    ['componentId', 'dependencyKind', 'importPath', 'packageName', 'packageVersion', 'qualifiedName', 'symbolId'],
    'Moniker record',
  );
  const componentId =
    input.componentId === undefined ? undefined : shortText(input.componentId, 'Moniker component ID');
  const dependencyKindValue =
    input.dependencyKind === undefined ? undefined : dependencyKind(input.dependencyKind, 'Moniker dependency kind');
  const importPath =
    input.importPath === undefined ? undefined : repositoryPath(input.importPath, 'Moniker import path');
  const packageName =
    input.packageName === undefined ? undefined : shortText(input.packageName, 'Moniker package name');
  const packageVersion =
    input.packageVersion === undefined ? undefined : shortText(input.packageVersion, 'Moniker package version');
  const qualifiedName =
    input.qualifiedName === undefined ? undefined : shortText(input.qualifiedName, 'Moniker qualified name');
  const scheme = oneOf(input.scheme, ['package', 'protobuf'], 'Moniker scheme');
  const symbolId = input.symbolId === undefined ? undefined : shortText(input.symbolId, 'Moniker symbol ID');
  if (scheme === 'package' && (componentId === undefined || packageName === undefined)) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Package moniker is missing component or package identity.'});
  }
  if (scheme === 'protobuf' && symbolId === undefined) {
    throw CodeGraphCheckpointSchemaError.make({message: 'Protobuf moniker is missing its symbol identity.'});
  }
  return {
    ...(componentId === undefined ? {} : {componentId}),
    ...(dependencyKindValue === undefined ? {} : {dependencyKind: dependencyKindValue}),
    evidencePath: repositoryPath(input.evidencePath, 'Moniker evidence path'),
    evidenceSpan: parseSpan(input.evidenceSpan, 'Moniker evidence span'),
    id: shortText(input.id, 'Moniker ID'),
    identity: shortText(input.identity, 'Moniker identity'),
    ...(importPath === undefined ? {} : {importPath}),
    kind: 'moniker',
    monikerKind: shortText(input.monikerKind, 'Moniker kind'),
    ...(packageName === undefined ? {} : {packageName}),
    ...(packageVersion === undefined ? {} : {packageVersion}),
    ...(qualifiedName === undefined ? {} : {qualifiedName}),
    resolutionDomain: shortText(input.resolutionDomain, 'Moniker resolution domain'),
    role: oneOf(input.role, ['export', 'import'], 'Moniker role'),
    scheme,
    ...(symbolId === undefined ? {} : {symbolId}),
    version: positiveInteger(input.version, 'Moniker version'),
  };
}

function parseSpan(value: unknown, label: string): CodeGraphCheckpointSpanV1 {
  const input = object(value, label);
  exactKeys(input, ['column', 'endColumn', 'endLine', 'line'], [], label);
  const column = positiveInteger(input.column, `${label} column`);
  const endColumn = positiveInteger(input.endColumn, `${label} end column`);
  const endLine = positiveInteger(input.endLine, `${label} end line`);
  const line = positiveInteger(input.line, `${label} line`);
  if (endLine < line || (endLine === line && endColumn < column)) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} ends before it starts.`});
  }
  return {column, endColumn, endLine, line};
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} must be an object.`});
  }
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!EffectArray.isArray(value) || value.length > MAXIMUM_ARRAY_LENGTH) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} must be a bounded array.`});
  }
  return value;
}

function exactKeys(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!EffectRecord.has(input, key))
      throw CodeGraphCheckpointSchemaError.make({message: `${label} is missing ${key}.`});
  }
  for (const key of EffectRecord.keys(input)) {
    if (!allowed.has(key))
      throw CodeGraphCheckpointSchemaError.make({message: `${label} contains unknown field ${key}.`});
  }
}

function literal<T extends boolean | number | string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw CodeGraphCheckpointSchemaError.make({message: `${label} is invalid.`});
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, options: T, label: string): T[number] {
  if (typeof value !== 'string' || !EffectArray.some(options, option => option === value)) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} is invalid.`});
  }
  return value;
}

function text(value: unknown, label: string, maximum = 8 * 1_048_576): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} must be a bounded string.`});
  }
  return value;
}

function shortText(value: unknown, label: string): string {
  const result = text(value, label, MAXIMUM_SHORT_TEXT_LENGTH);
  if (result.length === 0) throw CodeGraphCheckpointSchemaError.make({message: `${label} cannot be empty.`});
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw CodeGraphCheckpointSchemaError.make({message: `${label} must be boolean.`});
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} must be a non-negative safe integer.`});
  }
  return value;
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} must be a bounded positive safe integer.`});
  }
  return value;
}

function finiteRange(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw CodeGraphCheckpointSchemaError.make({
      message: `${label} must be a finite number between ${minimum} and ${maximum}.`,
    });
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} must be a lowercase SHA-256 digest.`});
  }
  return value;
}

function gitObjectId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !GIT_OBJECT_ID.test(value)) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} must be a lowercase Git object ID.`});
  }
  return value;
}

function mode(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{6}$/u.test(value)) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} is invalid.`});
  }
  return value;
}

function repositoryPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isSafeCodeGraphCheckpointPath(value)) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} must be a safe repository-relative POSIX path.`});
  }
  return value;
}

function workspaceRoot(value: unknown, label: string): string {
  // The workspace model uses the empty repository-relative path as its
  // canonical repository root. Keep `.` readable for older/projected models,
  // but never rewrite either representation at the checkpoint boundary.
  if (value === '' || value === '.') return value;
  if (typeof value !== 'string' || !isSafeCodeGraphCheckpointPath(value)) {
    throw CodeGraphCheckpointSchemaError.make({message: `${label} must be a safe repository-relative POSIX root.`});
  }
  return value;
}

function workspaceName(value: unknown, root: string, label: string): string {
  // Existing workspace receipts represent the repository-wide build scope as
  // the pair {root: '', name: ''}. Admit only that paired empty identity;
  // nested workspace names remain non-empty bounded text.
  if (value === '' && root === '') return value;
  return shortText(value, label);
}

function stringArray(value: unknown, label: string): readonly string[] {
  return EffectArray.map(array(value, label), entry => text(entry, `${label} entry`, MAXIMUM_SHORT_TEXT_LENGTH));
}

function pathArray(value: unknown, label: string, allowRoot: boolean): readonly string[] {
  return EffectArray.map(array(value, label), entry =>
    allowRoot ? workspaceRoot(entry, `${label} entry`) : repositoryPath(entry, `${label} entry`),
  );
}

function workspaceBuildSystem(value: unknown, label: string): CodeGraphWorkspaceProject['buildSystem'] {
  return oneOf(
    value,
    ['bazel', 'gradle', 'inferred', 'maven', 'node', 'nx', 'pnpm', 'swiftpm', 'typescript', 'xcode'],
    label,
  );
}

function workspaceProvenance(value: unknown, label: string): CodeGraphWorkspaceProject['provenance'] {
  return oneOf(value, ['declared', 'inferred'], label);
}

function dependencyKind(value: unknown, label: string): CodeGraphExternalDependencyV1['kind'] {
  return oneOf(value, ['development', 'optional', 'peer', 'runtime'], label);
}

function ensureSortedUnique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  let previous: string | undefined;
  for (const value of values) {
    const current = key(value);
    if (previous !== undefined && current <= previous) {
      throw CodeGraphCheckpointSchemaError.make({message: `${label} must be strictly sorted and unique.`});
    }
    previous = current;
  }
}

function checkedSum(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total)
      throw CodeGraphCheckpointSchemaError.make({message: `${label} overflows.`});
    total += value;
  }
  return total;
}

function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  const leftBytes = UTF8.encode(left);
  const rightBytes = UTF8.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

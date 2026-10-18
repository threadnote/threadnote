import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  assertMemoryCodeCitation,
  formatMemoryCodeCitationLines,
  MAX_MEMORY_CODE_CITATIONS,
  type MemoryCodeCitationV1,
} from './code/citation.js';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  parseMemoryDocument,
  type MemoryRecord,
} from './document.js';
import {buildConsolidationProvenanceV2} from './consolidation.js';
import {
  isCodeTopicMaintenanceManifest,
  validateTopicMaintenanceManifest,
  type TopicMaintenanceCodeManifestV3,
} from './topic-maintenance.js';

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const nodeId = Schema.String.check(Schema.isPattern(/^cgs_(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/u));
const bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096), Schema.isPattern(/^\P{Cc}+$/u));
const commit = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
export const TOPIC_EXPANSION_KINDS = [
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
] as const;
export const TOPIC_EXPANSION_PROVENANCES = ['declared', 'heuristic', 'model', 'resolved', 'syntactic'] as const;
const kind = Schema.Literals(TOPIC_EXPANSION_KINDS);
const provenance = Schema.Literals(TOPIC_EXPANSION_PROVENANCES);
const direction = Schema.Literals(['both', 'incoming', 'outgoing']);
const paths = Schema.Array(bounded).check(Schema.isMaxLength(8));
const requestSchema = Schema.Struct({
  version: Schema.Literal(1),
  depth: Schema.Literal(1),
  project: bounded,
  root: bounded,
  configDigest: hash,
  seeds: Schema.Array(nodeId).check(Schema.isMaxLength(4)),
  direction: Schema.optionalKey(direction),
  kinds: Schema.Array(kind).check(Schema.isMinLength(1), Schema.isMaxLength(TOPIC_EXPANSION_KINDS.length)),
  provenances: Schema.Array(provenance).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  minConfidence: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  nodeLimit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(64)),
  edgeLimit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(128)),
  selectedNodeIds: Schema.Array(nodeId).check(Schema.isMaxLength(8)),
  configurationPaths: paths,
});
export type TopicDependencyExpansionInput = typeof requestSchema.Type;
export type TopicDependencyExpansionRequest = TopicDependencyExpansionInput & {
  readonly direction: 'both' | 'incoming' | 'outgoing';
};
const strict = {onExcessProperty: 'error' as const};
function sorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}
export function topicExpansionPath(path: string): boolean {
  return (
    path.length <= 2048 &&
    !/[\p{Cc}\\]/u.test(path) &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/u.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  );
}
export function validateTopicDependencyExpansionInput(input: unknown): TopicDependencyExpansionRequest {
  const value = Schema.decodeUnknownSync(requestSchema, strict)(input);
  if (
    !value.root.startsWith('/') ||
    /\p{Cc}/u.test(value.root) ||
    value.root.split('/').includes('..') ||
    value.configurationPaths.some(path => !topicExpansionPath(path))
  )
    throw new Error('Expansion requires an absolute root and exact repository-relative configuration paths.');
  if (!value.seeds.length && value.selectedNodeIds.length)
    throw new Error('Selected graph endpoints require explicit seeds.');
  return {
    ...value,
    direction: value.direction ?? 'outgoing',
    seeds: sorted(value.seeds),
    kinds: sorted(value.kinds),
    provenances: sorted(value.provenances),
    selectedNodeIds: sorted(value.selectedNodeIds),
    configurationPaths: sorted(value.configurationPaths),
  };
}
/** Sorted object keys and set-normalized selections make approval independent of transport order. */
export function topicExpansionDigest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : item;
  return sha256HexSync(JSON.stringify(canonical(value)));
}
const nodeSchema = Schema.Struct({id: nodeId, path: bounded, contentHash: hash});
const edgeSchema = Schema.Struct({
  id: bounded,
  sourceId: nodeId,
  targetId: nodeId,
  kind,
  provenance,
  confidence: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
});
const readSchema = Schema.Struct({
  seedId: nodeId,
  nodes: Schema.Array(nodeSchema).check(Schema.isMaxLength(64)),
  edges: Schema.Array(edgeSchema).check(Schema.isMaxLength(128)),
  coverage: Schema.Struct({
    status: Schema.Literal('exhaustive'),
    limitsReached: Schema.Array(Schema.String).check(Schema.isMaxLength(0)),
    requestedDepth: Schema.Literal(1),
    completedDepth: Schema.Literal(1),
    direction,
    nodeLimit: Schema.Int,
    edgeLimit: Schema.Int,
    allowedProvenances: Schema.Array(provenance),
    omittedNodes: Schema.Literal(0),
    missingNodes: Schema.Literal(0),
    unresolvedEdges: Schema.Literal(0),
    visitedNodes: Schema.Int,
    inspectedEdges: Schema.Int,
  }),
});
const proofSchema = Schema.Struct({
  version: Schema.Literal(1),
  repositoryId: hash,
  worktreeId: bounded,
  sourceCommit: commit,
  sourceFenceDigest: hash,
  project: bounded,
  root: bounded,
  configDigest: hash,
  snapshot: Schema.Struct({id: bounded, commit, graphContentId: bounded, extractorSet: bounded}),
  profileDigest: hash,
  scopeDigest: hash,
  scopeReceiptJson: bounded,
  completeProject: Schema.Literal(true),
  reads: Schema.Array(readSchema).check(Schema.isMaxLength(4)),
});
export type TopicDependencyExpansionProof = typeof proofSchema.Type;
export interface TopicDependencyExpansionAddition {
  readonly kind: 'configuration' | 'dependency';
  readonly ref: string;
  readonly citation: MemoryCodeCitationV1;
}
export interface TopicDependencyExpansionOmission {
  readonly kind: 'advisory' | 'self-loop' | 'cycle' | 'duplicate' | 'excluded' | 'unselected';
  readonly id: string;
}
const operationSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(8)),
  predecessorRevision: hash,
  predecessorApprovalDigest: hash,
});
export type TopicDependencyExpansionOperation = typeof operationSchema.Type;
export interface TopicDependencyExpansionPreview {
  readonly version: 1;
  readonly targetUri: string;
  readonly callerCwd: string;
  readonly beforeContent: string;
  readonly beforeContentHash: string;
  readonly previousManifestHash: string;
  readonly operation?: TopicDependencyExpansionOperation;
  readonly input: TopicDependencyExpansionRequest;
  readonly proof: TopicDependencyExpansionProof;
  readonly proofDigest: string;
  readonly revision: string;
  readonly approvalDigest: string;
  readonly additions: readonly TopicDependencyExpansionAddition[];
  readonly omissions: readonly TopicDependencyExpansionOmission[];
  readonly manifest: TopicMaintenanceCodeManifestV3;
  readonly content: string;
  readonly contentHash: string;
  readonly metadataDiff: readonly {readonly field: string; readonly beforeHash: string; readonly afterHash: string}[];
}
export function validateTopicDependencyExpansionProof(
  input: unknown,
  request: TopicDependencyExpansionRequest,
): TopicDependencyExpansionProof {
  const proof = Schema.decodeUnknownSync(proofSchema, strict)(input);
  if (
    proof.project !== request.project ||
    proof.root !== request.root ||
    proof.configDigest !== request.configDigest ||
    topicExpansionDigest(proof.reads.map(read => read.seedId).sort()) !== topicExpansionDigest(request.seeds)
  )
    throw new Error('Expansion scope or exact seed proof differs from the explicit request.');
  const identities = new Map<string, string>();
  const relationships = new Map<string, string>();
  for (const read of proof.reads) {
    const c = read.coverage;
    if (
      c.direction !== request.direction ||
      c.nodeLimit !== request.nodeLimit ||
      c.edgeLimit !== request.edgeLimit ||
      c.visitedNodes !== read.nodes.length ||
      c.visitedNodes > c.nodeLimit ||
      c.inspectedEdges > c.edgeLimit ||
      c.inspectedEdges < read.edges.length ||
      !read.nodes.some(node => node.id === read.seedId) ||
      new Set(read.nodes.map(node => node.id)).size !== read.nodes.length ||
      new Set(read.edges.map(edge => edge.id)).size !== read.edges.length ||
      read.nodes.some(node => !topicExpansionPath(node.path))
    )
      throw new Error('Expansion neighborhood proof is incomplete or inconsistent.');
    for (const node of read.nodes) {
      const prior = identities.get(node.id);
      const digest = topicExpansionDigest(node);
      if (prior && prior !== digest) throw new Error('Expansion node identity collides across seeds.');
      identities.set(node.id, digest);
    }
    for (const edge of read.edges) {
      const prior = relationships.get(edge.id);
      const digest = topicExpansionDigest(edge);
      if (prior && prior !== digest) throw new Error('Expansion edge identity collides across seeds.');
      relationships.set(edge.id, digest);
    }
    if (
      ![
        'declared' as const,
        'resolved' as const,
        'syntactic' as const,
        ...(request.provenances.includes('heuristic') ? ['heuristic' as const] : []),
        ...(request.provenances.includes('model') ? ['model' as const] : []),
      ].every(p => c.allowedProvenances.includes(p)) ||
      c.allowedProvenances.length !==
        3 + Number(request.provenances.includes('heuristic')) + Number(request.provenances.includes('model'))
    )
      throw new Error('Expansion provenance coverage differs from the requested neighborhood.');
    const nodes = new Set(read.nodes.map(node => node.id));
    if (read.edges.some(edge => !nodes.has(edge.sourceId) || !nodes.has(edge.targetId)))
      throw new Error('Expansion edge has an unresolved endpoint.');
  }
  return proof;
}
export function topicDependencyExpansionChoices(
  request: TopicDependencyExpansionRequest,
  proof: TopicDependencyExpansionProof,
) {
  validateTopicDependencyExpansionProof(proof, request);
  const eligible = new Map<string, typeof nodeSchema.Type>();
  const omissions: TopicDependencyExpansionOmission[] = [];
  const seeds = new Set(request.seeds);
  const seen = new Set<string>();
  for (const read of proof.reads)
    for (const edge of read.edges) {
      if (seen.has(edge.id)) {
        omissions.push({kind: 'duplicate', id: edge.id});
        continue;
      }
      seen.add(edge.id);
      if (edge.sourceId === edge.targetId) {
        omissions.push({kind: 'self-loop', id: edge.id});
        continue;
      }
      if (seeds.has(edge.sourceId) && seeds.has(edge.targetId)) {
        omissions.push({kind: 'cycle', id: edge.id});
        continue;
      }
      if (edge.provenance !== 'declared' && edge.provenance !== 'resolved') {
        omissions.push({kind: 'advisory', id: edge.id});
        continue;
      }
      if (
        !request.kinds.includes(edge.kind) ||
        !request.provenances.includes(edge.provenance) ||
        edge.confidence < request.minConfidence
      ) {
        omissions.push({kind: 'excluded', id: edge.id});
        continue;
      }
      const ids = [
        ...(request.direction !== 'incoming' && edge.sourceId === read.seedId ? [edge.targetId] : []),
        ...(request.direction !== 'outgoing' && edge.targetId === read.seedId ? [edge.sourceId] : []),
      ];
      for (const id of ids) {
        const node = read.nodes.find(node => node.id === id)!;
        const old = eligible.get(id);
        if (old && (old.path !== node.path || old.contentHash !== node.contentHash))
          throw new Error('Expansion node identity collides.');
        if (old) omissions.push({kind: 'duplicate', id});
        eligible.set(id, node);
      }
    }
  for (const id of request.selectedNodeIds)
    if (!eligible.has(id))
      throw new Error('A selected endpoint lacks an admitted declared/resolved one-hop dependency.');
  for (const id of eligible.keys()) if (!request.selectedNodeIds.includes(id)) omissions.push({kind: 'unselected', id});
  return {
    eligible: [...eligible.values()].sort((a, b) => a.id.localeCompare(b.id)),
    omissions: omissions.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
  };
}
/** Pure monotone metadata extension. No body, support, role, scope, origin or prior mapping is rewritten. */
export function prepareTopicDependencyExpansion(
  record: MemoryRecord,
  callerCwd: string,
  input: unknown,
  proofInput: unknown,
  additionsInput: readonly TopicDependencyExpansionAddition[],
  operationInput?: TopicDependencyExpansionOperation,
): TopicDependencyExpansionPreview {
  assertMemoryDocumentSchemaWritable(record.content);
  if (
    record.headerTitle !== 'MEMORY' ||
    record.metadata.kind !== 'durable' ||
    record.metadata.status !== 'active' ||
    !record.uri.startsWith('threadnote://user/') ||
    record.metadata.visibility === 'shared' ||
    record.metadata.obsidianEvidence ||
    record.metadata.sourceEvidence ||
    record.metadata.topicMaintenanceError ||
    !record.metadata.topicMaintenance
  )
    throw new Error('Expansion requires one enrolled private code topic.');
  const old = validateTopicMaintenanceManifest(record.metadata.topicMaintenance, record);
  if (!isCodeTopicMaintenanceManifest(old)) throw new Error('Imported topics cannot expand code dependencies.');
  const operation =
    operationInput === undefined ? undefined : Schema.decodeSync(operationSchema, strict)(operationInput);
  const request = validateTopicDependencyExpansionInput(input);
  const proof = validateTopicDependencyExpansionProof(proofInput, request);
  const choices = topicDependencyExpansionChoices(request, proof);
  if (proof.repositoryId !== old.repositoryId) throw new Error('Expansion cannot cross repositories.');
  const selected = [
    ...request.selectedNodeIds.map(ref => ({kind: 'dependency' as const, ref})),
    ...request.configurationPaths.map(ref => ({kind: 'configuration' as const, ref})),
  ].sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`));
  if (!selected.length)
    throw new Error('Choose at least one exact addition; empty selection never adds all suggestions.');
  const additions = [...additionsInput].sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`));
  if (topicExpansionDigest(selected) !== topicExpansionDigest(additions.map(({kind, ref}) => ({kind, ref}))))
    throw new Error('Captured selections differ from the explicit approval.');
  const citations = new Map((record.metadata.codeCitations ?? []).map(citation => [citation.id, citation]));
  const newIds: string[] = [];
  for (const item of additions) {
    const citation = assertMemoryCodeCitation(item.citation);
    const node = choices.eligible.find(node => node.id === item.ref);
    if (
      citation.sourceDirty ||
      citation.evidenceRetention !== 'capsule-retained' ||
      citation.repositoryId !== proof.repositoryId ||
      citation.sourceSnapshotId !== proof.snapshot.id ||
      citation.sourceCommit !== proof.snapshot.commit ||
      citation.extractorSet !== proof.snapshot.extractorSet ||
      citation.sourceGraphContentId !== proof.snapshot.graphContentId ||
      (item.kind === 'configuration'
        ? citation.target.kind !== 'file' || citation.path !== item.ref
        : !node ||
          citation.path !== node.path ||
          citation.fileContentHash.value !== node.contentHash ||
          (citation.target.kind === 'symbol' && citation.target.nodeId !== node.id))
    )
      throw new Error('Expansion selection has missing or mismatched exact code proof.');
    const prior = citations.get(citation.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(citation))
      throw new Error('Expansion cannot overwrite an immutable citation.');
    if (!prior) newIds.push(citation.id);
    citations.set(citation.id, citation);
  }
  if (citations.size > MAX_MEMORY_CODE_CITATIONS)
    throw new Error('Expansion exceeds the eight retained origin/accepted/new citation limit.');
  const before = canonicalMemoryDocumentContent(record.content);
  const beforeContentHash = sha256HexSync(before);
  const previousManifestHash = topicExpansionDigest(old);
  const proofDigest = topicExpansionDigest(proof);
  const requestDigest = topicExpansionDigest(request);
  const revision = topicExpansionDigest({
    targetUri: record.uri,
    beforeContentHash,
    previousManifestHash,
    proofDigest,
    requestDigest,
    ...(operation === undefined ? {} : {operation}),
    additions,
  });
  const declared = new Set([
    ...old.paragraphs.flatMap(paragraph => paragraph.citationIds),
    ...old.additionalDependencies.map(item => item.citationId),
  ]);
  const additional = [...old.additionalDependencies];
  const mappings =
    old.version === 1
      ? [...declared].sort().map(citationId => ({citationId, acceptedCitationId: citationId}))
      : [...old.acceptedSources];
  for (const item of additions)
    if (!declared.has(item.citation.id)) {
      additional.push({kind: item.kind, citationId: item.citation.id});
      mappings.push({citationId: item.citation.id, acceptedCitationId: item.citation.id});
      declared.add(item.citation.id);
    }
  if (!newIds.length && additional.length === old.additionalDependencies.length)
    throw new Error('Every selected dependency is already declared.');
  const receipt = {
    version: 1 as const,
    revision,
    proofDigest,
    requestDigest,
    previousManifestHash,
    sourceCommit: proof.sourceCommit,
    citationIds: sorted(additions.map(item => item.citation.id)),
  };
  const manifest: TopicMaintenanceCodeManifestV3 = {
    ...old,
    version: 3,
    sourceKind: 'code',
    originCitationIds:
      old.version === 1 ? (record.metadata.codeCitations ?? []).map(c => c.id).sort() : old.originCitationIds,
    acceptedSources: mappings.sort((a, b) => a.citationId.localeCompare(b.citationId)),
    additionalDependencies: additional,
    dependencyExpansions: [...(old.version === 3 ? (old.dependencyExpansions ?? []) : []), receipt],
  };
  const consolidation =
    record.metadata.consolidation?.version === 1
      ? buildConsolidationProvenanceV2(record.metadata.consolidation, record.body, record.body, manifest, {
          reviewId: `review-${revision.slice(0, 24)}`,
          targetBeforeHash: beforeContentHash,
          packetDigest: proofDigest,
          observationRevision: requestDigest,
        })
      : record.metadata.consolidation;
  const split = /\r?\n\r?\n/u.exec(before)!;
  if (!split) throw new Error('Expansion requires an intact canonical header.');
  const header = before.slice(0, split.index);
  const ending = header.includes('\r\n') ? '\r\n' : '\n';
  const lines = header
    .split(/\r?\n/u)
    .map(line =>
      /^topic_maintenance:/u.test(line)
        ? `topic_maintenance: ${JSON.stringify(manifest)}`
        : consolidation && /^consolidation:/u.test(line)
          ? `consolidation: ${JSON.stringify(consolidation)}`
          : line,
    );
  lines.push(...formatMemoryCodeCitationLines([...citations.values()].filter(c => newIds.includes(c.id))));
  const content = lines.join(ending) + before.slice(split.index);
  const parsed = parseMemoryDocument(record.uri, content);
  if (
    !parsed ||
    parsed.body !== record.body ||
    parsed.metadata.topicMaintenanceError ||
    parsed.metadata.consolidationError ||
    parsed.metadata.citationErrors?.length
  )
    throw new Error('Expansion would produce invalid provenance.');
  const metadataDiff = [
    {field: 'topic_maintenance', beforeHash: previousManifestHash, afterHash: topicExpansionDigest(manifest)},
    ...newIds.sort().map(id => ({
      field: `code_citation:${id}`,
      beforeHash: sha256HexSync(''),
      afterHash: topicExpansionDigest(citations.get(id)),
    })),
    ...(consolidation !== record.metadata.consolidation
      ? [
          {
            field: 'consolidation',
            beforeHash: topicExpansionDigest(record.metadata.consolidation),
            afterHash: topicExpansionDigest(consolidation),
          },
        ]
      : []),
  ];
  const base = {
    version: 1 as const,
    targetUri: record.uri,
    callerCwd,
    beforeContent: before,
    beforeContentHash,
    previousManifestHash,
    ...(operation === undefined ? {} : {operation}),
    input: request,
    proof,
    proofDigest,
    revision,
    additions,
    omissions: choices.omissions,
    manifest,
    content,
    contentHash: sha256HexSync(content),
    metadataDiff,
  };
  if (new TextEncoder().encode(JSON.stringify(base)).byteLength > 256 * 1024)
    throw new Error('Expansion preview exceeds 256 KiB.');
  return {...base, approvalDigest: topicExpansionDigest(base)};
}
/** Persisted previews and writer authorization are reproduced from the original bytes, never trusted casts. */
export function validateTopicDependencyExpansionPreview(input: unknown): TopicDependencyExpansionPreview {
  const shape = Schema.decodeUnknownSync(
    Schema.Struct({
      version: Schema.Literal(1),
      targetUri: bounded,
      callerCwd: bounded,
      beforeContent: Schema.String,
      beforeContentHash: hash,
      previousManifestHash: hash,
      operation: Schema.optionalKey(operationSchema),
      input: Schema.Unknown,
      proof: Schema.Unknown,
      proofDigest: hash,
      revision: hash,
      approvalDigest: hash,
      additions: Schema.Array(
        Schema.Struct({kind: Schema.Literals(['dependency', 'configuration']), ref: bounded, citation: Schema.Unknown}),
      ).check(Schema.isMaxLength(8)),
      omissions: Schema.Unknown,
      manifest: Schema.Unknown,
      content: Schema.String,
      contentHash: hash,
      metadataDiff: Schema.Unknown,
    }),
    strict,
  )(input);
  const record = parseMemoryDocument(shape.targetUri, shape.beforeContent);
  if (!record) throw new Error('Expansion baseline is missing.');
  const additions = shape.additions.map(item => ({...item, citation: assertMemoryCodeCitation(item.citation)}));
  const rebuilt = prepareTopicDependencyExpansion(
    record,
    shape.callerCwd,
    shape.input,
    shape.proof,
    additions,
    shape.operation,
  );
  if (topicExpansionDigest(rebuilt) !== topicExpansionDigest(input))
    throw new Error('Expansion preview differs from its exact deterministic proof.');
  return rebuilt;
}
export interface TopicDependencyExpansionSuccessor {
  readonly operation: TopicDependencyExpansionOperation;
  readonly revision: string;
  readonly approvalDigest: string;
  readonly createdAt: string;
}
/** At most eight explicit restarts; each receipt keeps only its direct successor identity. */
export function restartTopicDependencyExpansionPreview(
  preview: TopicDependencyExpansionPreview,
  operation: TopicDependencyExpansionOperation,
): TopicDependencyExpansionPreview {
  if (
    operation.predecessorRevision !== preview.revision ||
    operation.predecessorApprovalDigest !== preview.approvalDigest ||
    operation.generation !== (preview.operation?.generation ?? 0) + 1
  )
    throw new Error('Expansion restart does not match its exact predecessor.');
  const record = parseMemoryDocument(preview.targetUri, preview.beforeContent);
  if (!record) throw new Error('Expansion restart baseline is unavailable.');
  return prepareTopicDependencyExpansion(
    record,
    preview.callerCwd,
    preview.input,
    preview.proof,
    preview.additions,
    operation,
  );
}
export interface TopicDependencyExpansionJournal {
  readonly version: 1;
  readonly stage: 'preview' | 'prepared' | 'written' | 'conflict' | 'superseded';
  readonly preview: TopicDependencyExpansionPreview;
  readonly successor?: TopicDependencyExpansionSuccessor;
}
export function validateTopicDependencyExpansionJournal(input: unknown): TopicDependencyExpansionJournal {
  const value = Schema.decodeUnknownSync(
    Schema.Struct({
      version: Schema.Literal(1),
      stage: Schema.Literals(['preview', 'prepared', 'written', 'conflict', 'superseded']),
      preview: Schema.Unknown,
      successor: Schema.optionalKey(
        Schema.Struct({operation: operationSchema, revision: hash, approvalDigest: hash, createdAt: bounded}),
      ),
    }),
    strict,
  )(input);
  const preview = validateTopicDependencyExpansionPreview(value.preview);
  if ((value.stage === 'superseded') !== (value.successor !== undefined))
    throw new Error('Expansion supersession receipt is missing or misplaced.');
  if (value.successor) {
    const fresh = restartTopicDependencyExpansionPreview(preview, value.successor.operation);
    const time = Date.parse(value.successor.createdAt);
    if (
      !Number.isFinite(time) ||
      new Date(time).toISOString() !== value.successor.createdAt ||
      fresh.revision !== value.successor.revision ||
      fresh.approvalDigest !== value.successor.approvalDigest
    )
      throw new Error('Expansion successor differs from its exact recorded operation.');
  }
  return {...value, preview};
}

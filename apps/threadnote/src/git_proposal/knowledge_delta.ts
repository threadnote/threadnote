import {Schema} from 'effect';

import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {uriSegment} from '@threadnote/workspace/manifest';
import {
  canonicalMemoryDocumentContent,
  declaresTopicMaintenanceHeader,
  parseMemoryDocument,
  type MemoryRelation,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {
  memoryCodeCitationContentSharingBlocker,
  memoryCodeCitationSharingBlockerMessage,
} from '@threadnote/memory/code/citation-policy';
import {memoryIdFromIdentityAlias, isMemoryId} from '@threadnote/memory/identity-alias';
import type {KnowledgeDeltaItemV1, KnowledgeDeltaV1} from '@threadnote/memory/knowledge_delta';
import {
  assertSafeShareRelativePath,
  setMemoryVisibility,
  stripPersonalProvenanceForSharedPublication,
} from '../share/core.js';
import {scrubberBlocker} from '@threadnote/platform/scrubber';
import {parseResourceId, validatePortableSegment} from '@threadnote/store/resource-id';

const GIT_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVIEW_ID = /^review-[0-9a-f]{16}$/u;
const MAXIMUM_ARTIFACT_BYTES = 256 * 1_024;

export class KnowledgeDeltaGitProposalError extends Schema.TaggedError<KnowledgeDeltaGitProposalError>()(
  'KnowledgeDeltaGitProposalError',
  {message: Schema.String},
) {}

export interface ReviewedSharedMemoryMutationV1 {
  readonly approval: {
    readonly expectedSourceContentHash: string;
    readonly reviewId: string;
    readonly revision: number;
    readonly share: true;
  };
  readonly candidateId: string;
  readonly expectedTarget:
    | {readonly state: 'absent'}
    | {
        readonly content: string;
        readonly contentHash: string;
        readonly state: 'present';
      };
  readonly operation: 'create' | 'replace';
  readonly sourceContent: string;
  readonly sourceUri: string;
}

export interface KnowledgeDeltaGitProposalInputV1 {
  readonly baseCommit: string;
  readonly delta: KnowledgeDeltaV1;
  readonly mutations: readonly ReviewedSharedMemoryMutationV1[];
  readonly project: string;
  readonly target: {
    /** Credential-free, portable repository identity hash. */
    readonly repositoryId: string;
    readonly team: string;
  };
}

export interface KnowledgeDeltaGitProposalFileV1 {
  readonly approval: {
    readonly candidateId: string;
    readonly expectedSourceContentHash: string;
    readonly expectedSourceMemoryId: string;
    readonly reviewId: string;
    readonly revision: number;
    readonly scope: 'shared';
  };
  readonly content: string;
  readonly contentHash: string;
  readonly memory: {
    readonly id: string;
    readonly relations: readonly MemoryRelation[];
    readonly topic: string;
  };
  readonly operation: 'create' | 'replace';
  readonly path: string;
  readonly targetPrecondition:
    | {readonly state: 'absent'}
    | {
        readonly expectedContentHash: string;
        readonly expectedMemoryId: string;
        readonly state: 'present';
      };
}

export interface KnowledgeDeltaGitProposalV1 {
  readonly base: {readonly expectedCommit: string};
  readonly branch: {readonly name: string};
  readonly commit: {readonly message: string};
  readonly files: readonly KnowledgeDeltaGitProposalFileV1[];
  readonly knowledgeDelta: {
    readonly expectedHash: string;
    readonly expectedRevision: number;
    readonly reviewId: string;
  };
  readonly project: string;
  readonly proposalHash: string;
  readonly target: {
    readonly repositoryId: string;
    readonly team: string;
  };
  readonly type: 'knowledge-delta-git-proposal';
  readonly version: 1;
}

export interface KnowledgeDeltaGitProposalBuildV1 {
  /** Canonical JSON plus one trailing newline; callers choose whether to print or persist it. */
  readonly artifact: string;
  readonly proposal: KnowledgeDeltaGitProposalV1;
}

/**
 * Build a reproducible, provider-neutral Git plan. This function is deliberately pure: it reads no files, runs no
 * Git commands, and performs no writes. Callers must collect the exact reviewed source and target bytes first.
 */
export function buildKnowledgeDeltaGitProposalV1(
  input: KnowledgeDeltaGitProposalInputV1,
): KnowledgeDeltaGitProposalBuildV1 {
  const project = portableSegment(input.project, 'project');
  const baseCommit = requireGitCommit(input.baseCommit);
  const target = {
    repositoryId: requirePattern(input.target.repositoryId, SHA256, 'target repository ID'),
    team: portableSegment(input.target.team, 'target team'),
  };
  const delta = validateKnowledgeDelta(input.delta, project);
  if (input.mutations.length === 0) invalid('A Git proposal requires at least one explicitly shared mutation.');
  if (input.mutations.length > 3) invalid('A Git proposal can contain at most three Knowledge Delta mutations.');
  if (delta.noAction) invalid('A no-action Knowledge Delta cannot produce a Git mutation proposal.');

  const itemsById = new Map(delta.items.map(item => [item.candidateId, item] as const));
  if (itemsById.size !== delta.items.length) invalid('Knowledge Delta candidate IDs must be unique.');
  const files = [...input.mutations]
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    .map(mutation => proposalFile(project, delta, itemsById, mutation));
  assertUnique(
    files.map(file => file.approval.candidateId),
    'approved candidate',
  );
  assertUnique(
    files.map(file => file.path),
    'target path',
  );

  const normalizedDelta = {...delta, items: [...delta.items].sort(compareCandidate)};
  const expectedHash = sha256HexSync(canonicalJson(normalizedDelta));
  const contentSetHash = sha256HexSync(
    canonicalJson({
      baseCommit,
      expectedHash,
      files,
      project,
      reviewId: delta.reviewId,
      revision: delta.revision,
      target,
    }),
  );
  const unsigned = {
    base: {expectedCommit: baseCommit},
    branch: {name: `threadnote/knowledge-delta/${delta.reviewId}-${contentSetHash.slice(0, 12)}`},
    commit: {message: `threadnote: propose ${project} knowledge delta ${delta.reviewId}`},
    files,
    knowledgeDelta: {
      expectedHash,
      expectedRevision: delta.revision,
      reviewId: delta.reviewId,
    },
    project,
    target,
    type: 'knowledge-delta-git-proposal' as const,
    version: 1 as const,
  };
  const proposal: KnowledgeDeltaGitProposalV1 = {
    ...unsigned,
    proposalHash: sha256HexSync(canonicalJson(unsigned)),
  };
  const artifact = `${canonicalJson(proposal)}\n`;
  if (new TextEncoder().encode(artifact).byteLength > MAXIMUM_ARTIFACT_BYTES) {
    invalid(`Git proposal artifact exceeds ${MAXIMUM_ARTIFACT_BYTES} UTF-8 bytes.`);
  }
  return {artifact, proposal};
}

/** Re-encode a typed proposal after checking its deterministic hash and all embedded content hashes. */
export function knowledgeDeltaGitProposalArtifactV1(proposal: KnowledgeDeltaGitProposalV1): string {
  verifyKnowledgeDeltaGitProposalV1(proposal);
  const artifact = `${canonicalJson(proposal)}\n`;
  if (new TextEncoder().encode(artifact).byteLength > MAXIMUM_ARTIFACT_BYTES) {
    invalid(`Git proposal artifact exceeds ${MAXIMUM_ARTIFACT_BYTES} UTF-8 bytes.`);
  }
  return artifact;
}

export function verifyKnowledgeDeltaGitProposalV1(proposal: KnowledgeDeltaGitProposalV1): void {
  if (proposal.type !== 'knowledge-delta-git-proposal' || proposal.version !== 1) {
    invalid('Git proposal type or version is unsupported.');
  }
  portableSegment(proposal.project, 'project');
  requireGitCommit(proposal.base.expectedCommit);
  requirePattern(proposal.target.repositoryId, SHA256, 'target repository ID');
  portableSegment(proposal.target.team, 'target team');
  requirePattern(proposal.knowledgeDelta.expectedHash, SHA256, 'Knowledge Delta hash');
  requireReview(proposal.knowledgeDelta.reviewId, proposal.knowledgeDelta.expectedRevision);
  if (proposal.files.length === 0 || proposal.files.length > 3) invalid('Git proposal file count is out of bounds.');
  if (proposal.branch.name !== expectedBranchName(proposal)) invalid('Git proposal branch name is not reproducible.');
  if (
    proposal.commit.message !==
    `threadnote: propose ${proposal.project} knowledge delta ${proposal.knowledgeDelta.reviewId}`
  ) {
    invalid('Git proposal commit message is not reproducible.');
  }
  assertUnique(
    proposal.files.map(file => file.approval.candidateId),
    'approved candidate',
  );
  assertUnique(
    proposal.files.map(file => file.path),
    'target path',
  );
  const ordered = [...proposal.files].sort(compareFile);
  if (ordered.some((file, index) => file !== proposal.files[index])) invalid('Git proposal files are not canonical.');
  for (const file of proposal.files) {
    const record = verifyProposalFile(proposal, file);
    if (record.metadata.topicMaintenance !== undefined)
      invalid('Enrolled topic Git proposals require the maintenance variant and its source/policy fences.');
    if (record.metadata.authority !== 'user_approved' || record.metadata.trust !== 'approved')
      invalid(`Git proposal file ${file.path} does not carry reviewed publication authority.`);
  }

  const {proposalHash: _proposalHash, ...unsigned} = proposal;
  const expected = sha256HexSync(canonicalJson(unsigned));
  if (proposal.proposalHash !== expected) invalid('Git proposal hash does not match its canonical plan.');
}

function proposalFile(
  project: string,
  delta: KnowledgeDeltaV1,
  itemsById: ReadonlyMap<string, KnowledgeDeltaItemV1>,
  mutation: ReviewedSharedMemoryMutationV1,
): KnowledgeDeltaGitProposalFileV1 {
  const item = itemsById.get(mutation.candidateId);
  if (!item) invalid(`Candidate ${mutation.candidateId} is not part of ${delta.reviewId}.`);
  if (item.state !== 'applied') invalid(`Candidate ${mutation.candidateId} is not an applied reviewed mutation.`);
  if (item.truncated || item.mutationPreview.truncated) {
    invalid(`Candidate ${mutation.candidateId} is truncated and cannot produce an exact Git proposal.`);
  }
  if (item.proposedDestination.kind !== 'durable') {
    invalid(`Candidate ${mutation.candidateId} is not a shareable durable memory.`);
  }
  if (item.proposedDestination.project !== project) {
    invalid(`Candidate ${mutation.candidateId} belongs to another project.`);
  }
  requireShareApproval(delta, mutation);

  const citationBlocker = memoryCodeCitationContentSharingBlocker(mutation.sourceUri, mutation.sourceContent);
  if (citationBlocker) {
    invalid(
      `Candidate ${mutation.candidateId} cannot be shared: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
    );
  }
  const canonicalSource = canonicalMemoryDocumentContent(mutation.sourceContent);
  const sourceContentHash = sha256HexSync(canonicalSource);
  if (sourceContentHash !== mutation.approval.expectedSourceContentHash) {
    invalid(`Candidate ${mutation.candidateId} approved source content changed.`);
  }
  const source = parseMemoryDocument(mutation.sourceUri, canonicalSource);
  if (!source) invalid(`Candidate ${mutation.candidateId} source is not a memory document.`);
  if (source.metadata.topicMaintenance !== undefined) {
    invalid(
      'Enrolled topics require the reviewed existing-target maintenance proposal path; generic publication cannot project their provenance.',
    );
  }
  if (source.headerTitle !== 'MEMORY' || source.metadata.kind !== 'durable' || source.metadata.status !== 'active') {
    invalid(`Candidate ${mutation.candidateId} source is not an active durable memory.`);
  }
  if (source.metadata.authority !== 'user_approved' || source.metadata.trust !== 'approved') {
    invalid(`Candidate ${mutation.candidateId} source does not carry reviewed approval metadata.`);
  }
  if (source.metadata.candidateId !== mutation.candidateId) {
    invalid(`Candidate ${mutation.candidateId} source approval identity does not match.`);
  }
  if (source.metadata.project !== project || source.metadata.topic !== item.proposedDestination.topic) {
    invalid(`Candidate ${mutation.candidateId} source is outside its reviewed project/topic.`);
  }
  assertPersonalSourceUri(source.uri, project, source.metadata.topic, mutation.candidateId);
  const memoryId = source.metadata.memoryId;
  if (memoryId === undefined || !isMemoryId(memoryId)) {
    invalid(`Candidate ${mutation.candidateId} source has no stable memory identity.`);
  }
  const relations = canonicalRelations(source.metadata.relations ?? [], mutation.candidateId);
  const topic = portableSegment(source.metadata.topic, `candidate ${mutation.candidateId} topic`);
  const path = sharedDurablePath(project, topic);
  const target = buildTargetPrecondition(project, topic, memoryId, mutation);
  if (
    relations.some(relation => {
      const relatedMemoryId = memoryIdFromIdentityAlias(relation.uri);
      return relatedMemoryId === memoryId || relatedMemoryId === target.memoryId;
    })
  ) {
    invalid(`Candidate ${mutation.candidateId} shared projection would relate to itself.`);
  }
  const content = setMemoryId(
    setMemoryVisibility(stripPersonalProvenanceForSharedPublication(canonicalSource), 'shared'),
    target.memoryId,
  );
  const blocker = scrubberBlocker(content);
  if (blocker) invalid(`Candidate ${mutation.candidateId} shared content is blocked by the ${blocker} scrubber.`);
  const published = parseMemoryDocument(mutation.sourceUri, content);
  if (!published || published.metadata.memoryId !== target.memoryId || published.metadata.project !== project) {
    invalid(`Candidate ${mutation.candidateId} shared projection changed its stable identity or project.`);
  }
  if (
    canonicalJson(canonicalRelations(published.metadata.relations ?? [], mutation.candidateId)) !==
    canonicalJson(relations)
  ) {
    invalid(`Candidate ${mutation.candidateId} shared projection did not preserve its reviewed relations.`);
  }
  return {
    approval: {
      candidateId: mutation.candidateId,
      expectedSourceContentHash: sourceContentHash,
      expectedSourceMemoryId: memoryId,
      reviewId: delta.reviewId,
      revision: delta.revision,
      scope: 'shared',
    },
    content,
    contentHash: sha256HexSync(content),
    memory: {id: target.memoryId, relations, topic},
    operation: mutation.operation,
    path,
    targetPrecondition: target.precondition,
  };
}

function buildTargetPrecondition(
  project: string,
  topic: string,
  memoryId: string,
  mutation: ReviewedSharedMemoryMutationV1,
): {
  readonly memoryId: string;
  readonly precondition: KnowledgeDeltaGitProposalFileV1['targetPrecondition'];
} {
  if (mutation.operation === 'create') {
    if (mutation.expectedTarget.state !== 'absent') invalid('Create proposals require an absent target precondition.');
    return {memoryId, precondition: {state: 'absent'}};
  }
  if (mutation.expectedTarget.state !== 'present') invalid('Replace proposals require a present target precondition.');
  requirePattern(mutation.expectedTarget.contentHash, SHA256, 'target content hash');
  if (sha256HexSync(mutation.expectedTarget.content) !== mutation.expectedTarget.contentHash) {
    invalid('Replacement target content does not match its expected hash.');
  }
  if (declaresTopicMaintenanceHeader(mutation.expectedTarget.content))
    invalid('Legacy V1 proposals cannot replace an enrolled shared target; use the reviewed maintenance variant.');
  const target = parseMemoryDocument('threadnote://proposal/target', mutation.expectedTarget.content);
  if (
    !target ||
    target.headerTitle !== 'MEMORY' ||
    target.metadata.kind !== 'durable' ||
    target.metadata.status !== 'active' ||
    target.metadata.visibility !== 'shared' ||
    target.metadata.project !== project ||
    target.metadata.topic !== topic
  ) {
    invalid('Replacement target is outside the proposed durable project/topic.');
  }
  const targetMemoryId = target.metadata.memoryId;
  if (targetMemoryId === undefined || !isMemoryId(targetMemoryId)) {
    invalid('Replacement target has no stable memory identity.');
  }
  return {
    memoryId: targetMemoryId,
    precondition: {
      expectedContentHash: mutation.expectedTarget.contentHash,
      expectedMemoryId: targetMemoryId,
      state: 'present',
    },
  };
}

function requireShareApproval(delta: KnowledgeDeltaV1, mutation: ReviewedSharedMemoryMutationV1): void {
  const approval = mutation.approval;
  if (approval.share !== true) invalid(`Candidate ${mutation.candidateId} has no explicit shared approval.`);
  requirePattern(approval.expectedSourceContentHash, SHA256, 'approved source content hash');
  if (approval.reviewId !== delta.reviewId || approval.revision !== delta.revision) {
    invalid(`Candidate ${mutation.candidateId} shared approval is stale.`);
  }
}

function validateKnowledgeDelta(delta: KnowledgeDeltaV1, project: string): KnowledgeDeltaV1 {
  if (delta.type !== 'knowledge-delta' || delta.version !== 1)
    invalid('Knowledge Delta type or version is unsupported.');
  requireReview(delta.reviewId, delta.revision);
  if (delta.items.length > 3) invalid('Knowledge Delta item count is out of bounds.');
  for (const item of delta.items) {
    if (!new RegExp(`^${delta.reviewId}-[1-3]$`, 'u').test(item.candidateId)) {
      invalid(`Knowledge Delta ${delta.reviewId} has a malformed candidate identity.`);
    }
    if (item.proposedDestination.project !== project) invalid(`Knowledge Delta ${delta.reviewId} crosses projects.`);
  }
  return delta;
}

export function verifyProposalFile(
  proposal: Pick<KnowledgeDeltaGitProposalV1, 'knowledgeDelta' | 'project'>,
  file: KnowledgeDeltaGitProposalFileV1,
): MemoryRecord {
  if (file.approval.scope !== 'shared') invalid('Git proposal file does not carry explicit shared approval.');
  if (
    file.approval.reviewId !== proposal.knowledgeDelta.reviewId ||
    file.approval.revision !== proposal.knowledgeDelta.expectedRevision
  ) {
    invalid('Git proposal file approval does not match the Knowledge Delta precondition.');
  }
  requirePattern(file.approval.expectedSourceContentHash, SHA256, 'approved source content hash');
  if (!isMemoryId(file.approval.expectedSourceMemoryId)) {
    invalid(`Git proposal file ${file.path} has an invalid source memory identity.`);
  }
  requirePattern(file.contentHash, SHA256, 'file content hash');
  if (sha256HexSync(file.content) !== file.contentHash) invalid(`Git proposal file ${file.path} content hash changed.`);
  if (!isMemoryId(file.memory.id)) invalid(`Git proposal file ${file.path} has an invalid memory identity.`);
  const topic = portableSegment(file.memory.topic, `file ${file.path} topic`);
  const expectedPath = sharedDurablePath(proposal.project, topic);
  if (file.path !== expectedPath) invalid(`Git proposal file ${file.path} crosses its project/topic boundary.`);
  const record = parseMemoryDocument('threadnote://proposal/file', file.content);
  if (
    !record ||
    record.headerTitle !== 'MEMORY' ||
    record.metadata.kind !== 'durable' ||
    record.metadata.status !== 'active' ||
    record.metadata.visibility !== 'shared' ||
    record.metadata.project !== proposal.project ||
    record.metadata.topic !== topic ||
    record.metadata.memoryId !== file.memory.id
  ) {
    invalid(`Git proposal file ${file.path} does not match its shared memory receipt.`);
  }
  const relations = canonicalRelations(record.metadata.relations ?? [], file.approval.candidateId);
  if (
    relations.some(relation => {
      const relatedMemoryId = memoryIdFromIdentityAlias(relation.uri);
      return relatedMemoryId === file.approval.expectedSourceMemoryId || relatedMemoryId === file.memory.id;
    })
  ) {
    invalid(`Git proposal file ${file.path} relates to itself.`);
  }
  if (canonicalJson(relations) !== canonicalJson(file.memory.relations)) {
    invalid(`Git proposal file ${file.path} relation receipt changed.`);
  }
  const blocker = scrubberBlocker(file.content);
  if (blocker) invalid(`Git proposal file ${file.path} is blocked by the ${blocker} scrubber.`);
  const citationBlocker = memoryCodeCitationContentSharingBlocker('threadnote://proposal/file', file.content);
  if (citationBlocker) {
    invalid(
      `Git proposal file ${file.path} cannot be shared: ${memoryCodeCitationSharingBlockerMessage(citationBlocker)}.`,
    );
  }
  if (file.operation === 'create' && file.targetPrecondition.state !== 'absent') {
    invalid(`Git proposal create ${file.path} does not require an absent target.`);
  }
  if (file.operation === 'create' && file.memory.id !== file.approval.expectedSourceMemoryId) {
    invalid(`Git proposal create ${file.path} changed the approved source memory identity.`);
  }
  if (file.operation === 'replace') {
    if (file.targetPrecondition.state !== 'present') {
      invalid(`Git proposal replace ${file.path} has no target CAS precondition.`);
    }
    requirePattern(file.targetPrecondition.expectedContentHash, SHA256, 'target content hash');
    if (file.targetPrecondition.expectedMemoryId !== file.memory.id) {
      invalid(`Git proposal replace ${file.path} changes stable memory identity.`);
    }
  }
  return record;
}

export function canonicalRelations(
  relations: readonly MemoryRelation[],
  candidateId: string,
): readonly MemoryRelation[] {
  for (const relation of relations) {
    if (memoryIdFromIdentityAlias(relation.uri) === undefined) {
      invalid(`Candidate ${candidateId} has a non-portable reviewed relation.`);
    }
  }
  const canonical = [...relations].sort(
    (left, right) => left.type.localeCompare(right.type) || left.uri.localeCompare(right.uri),
  );
  assertUnique(
    canonical.map(relation => `${relation.type}\n${relation.uri}`),
    'memory relation',
  );
  return canonical;
}

function setMemoryId(content: string, memoryId: string): string {
  const lines = content.split('\n');
  const headerEnd = lines.findIndex(line => line.trim() === '');
  if (headerEnd === -1) invalid('Shared memory projection has no header boundary.');
  const memoryIdIndexes = lines
    .slice(0, headerEnd)
    .flatMap((line, index) => (line.startsWith('memory_id:') ? [index] : []));
  if (memoryIdIndexes.length !== 1) invalid('Shared memory projection must have exactly one stable memory identity.');
  lines[memoryIdIndexes[0]] = `memory_id: ${memoryId}`;
  return lines.join('\n');
}

function assertPersonalSourceUri(uri: string, project: string, topic: string, candidateId: string): void {
  let resource;
  try {
    resource = parseResourceId(uri);
  } catch {
    return invalid(`Candidate ${candidateId} source URI is invalid.`);
  }
  if (
    resource.anchor !== undefined ||
    resource.namespace !== 'user' ||
    resource.segments.length !== 6 ||
    resource.segments[1] !== 'memories' ||
    resource.segments[2] !== 'durable' ||
    resource.segments[3] !== 'projects' ||
    resource.segments[4] !== uriSegment(project) ||
    resource.segments[5] !== `${uriSegment(topic)}.md`
  ) {
    invalid(`Candidate ${candidateId} source URI is outside its personal durable project/topic.`);
  }
}

export function sharedDurablePath(project: string, topic: string): string {
  return assertSafeShareRelativePath(`durable/projects/${uriSegment(project)}/${uriSegment(topic)}.md`);
}

export function expectedBranchName(
  proposal: Pick<KnowledgeDeltaGitProposalV1, 'base' | 'knowledgeDelta' | 'files' | 'project' | 'target'> & {
    readonly maintenance?: unknown;
  },
): string {
  const contentSetHash = sha256HexSync(
    canonicalJson({
      baseCommit: proposal.base.expectedCommit,
      expectedHash: proposal.knowledgeDelta.expectedHash,
      files: proposal.files,
      project: proposal.project,
      reviewId: proposal.knowledgeDelta.reviewId,
      revision: proposal.knowledgeDelta.expectedRevision,
      target: proposal.target,
      ...(proposal.maintenance === undefined ? {} : {maintenance: proposal.maintenance}),
    }),
  );
  return `threadnote/knowledge-delta/${proposal.knowledgeDelta.reviewId}-${contentSetHash.slice(0, 12)}`;
}

function requireReview(reviewId: string, revision: number): void {
  requirePattern(reviewId, REVIEW_ID, 'review ID');
  if (!Number.isSafeInteger(revision) || revision < 1) invalid('Review revision must be a positive safe integer.');
}

function portableSegment(value: string, label: string): string {
  try {
    return validatePortableSegment(value);
  } catch {
    return invalid(`${label} is not a portable path segment.`);
  }
}

function requirePattern(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) invalid(`${label} is malformed.`);
  return value;
}

function requireGitCommit(value: string): string {
  requirePattern(value, GIT_COMMIT, 'base commit');
  if (/^0+$/u.test(value)) invalid('base commit must identify an existing Git object.');
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`Git proposal contains a duplicate ${label}.`);
}

function compareCandidate(left: KnowledgeDeltaItemV1, right: KnowledgeDeltaItemV1): number {
  return left.candidateId.localeCompare(right.candidateId);
}

function compareFile(left: KnowledgeDeltaGitProposalFileV1, right: KnowledgeDeltaGitProposalFileV1): number {
  return left.approval.candidateId.localeCompare(right.approval.candidateId) || left.path.localeCompare(right.path);
}

function invalid(message: string): never {
  throw KnowledgeDeltaGitProposalError.make({message});
}

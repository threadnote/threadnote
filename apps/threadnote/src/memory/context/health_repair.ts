import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  assertMemoryDocumentSchemaWritable,
  canonicalMemoryDocumentContent,
  isSharedMemoryUri,
  parseMemoryDocument,
  type MemoryRecord,
  type MemoryRelation,
} from '@threadnote/memory/document';
import type {
  ContextHealthFindingCategoryV1,
  ContextHealthFindingV1,
  ContextHealthRepairDescriptorV1,
  ContextHealthReportV1,
} from '@threadnote/context/health';
import {isMemoryId, memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {parseResourceId} from '@threadnote/store/resource-id';
import {
  KNOWLEDGE_DELTA_V1_MAX_ITEMS,
  type KnowledgeDeltaItemV1,
  type KnowledgeDeltaV1,
} from '@threadnote/memory/knowledge_delta';
import {
  formatMemoryCodeCitation,
  formatMemoryCodeCitationLines,
  preserveMemoryCodeCitationAnchor,
  type MemoryCodeCitationV1,
} from '@threadnote/memory/code/citation';
import type {ContextHealthSelectorV1} from './health_selector.js';

export const CONTEXT_HEALTH_REPAIR_VERSION = 1 as const;
export const DEFAULT_CONTEXT_HEALTH_REPAIR_PROPOSAL_LIMIT = 100 as const;
export const MAXIMUM_CONTEXT_HEALTH_REPAIR_PROPOSAL_LIMIT = 500 as const;

const MAXIMUM_CONTEXT_HEALTH_REPAIR_SUMMARY_CHARACTERS = 2_000;

export interface ContextHealthRepairRecordPreconditionV1 {
  readonly expectedContentHash: string;
  readonly expectedProject: string;
  readonly uri: string;
}

export type ContextHealthRepairMutationV1 =
  | {
      readonly citationId: string;
      readonly expectedResultContentHash: string;
      readonly kind: 'replace-citation';
      readonly replacement: MemoryCodeCitationV1;
      readonly subjectUri: string;
    }
  | {
      readonly kind: 'archive-memory';
      readonly subjectUri: string;
      readonly survivorUri?: string;
    }
  | {
      readonly expectedResultContentHash: string;
      readonly kind: 'remove-relations';
      readonly subjectUri: string;
      readonly targetPrecondition:
        {readonly state: 'absent'} | {readonly expectedContentHash: string; readonly state: 'inactive'};
      readonly targetUri: string;
    }
  | {
      readonly kind: 'review-only';
      readonly reason: string;
      readonly repairKind: ContextHealthRepairDescriptorV1['kind'];
      readonly suggestedMutation?: ContextHealthSupersedeReviewV1;
      readonly subjectUri?: string;
      readonly targetUri?: string;
    };

export interface ContextHealthSupersedeReviewV1 {
  readonly archivedFrom: string;
  readonly designation: ContextHealthSemanticDirectionV1;
  readonly kind: 'supersede-memory';
  readonly preservedMemoryId: string;
  readonly status: 'superseded';
  readonly subjectUri: string;
  readonly supersededByMemoryId: string;
  readonly supersededByUri: string;
}

/** Explicit reviewer direction for one exact semantic contradiction report revision. */
export interface ContextHealthSemanticDirectionV1 {
  readonly contradictionId: string;
  readonly currentUri: string;
  readonly reportRevision: string;
  readonly staleUri: string;
  readonly type: 'context-health-semantic-direction';
  readonly version: 1;
}

export interface ContextHealthRepairProposalV1 {
  readonly category: ContextHealthFindingCategoryV1;
  readonly findingId: string;
  readonly mutation: ContextHealthRepairMutationV1;
  readonly preconditions: readonly ContextHealthRepairRecordPreconditionV1[];
  readonly project: string;
  readonly proposalId: string;
  /** Exact revision of the proposal, including every record-content precondition. */
  readonly revision: string;
  /** Exact normalized discovery selector; omitted for an unfiltered preview. */
  readonly selector?: ContextHealthSelectorV1;
  readonly summary: string;
  readonly version: typeof CONTEXT_HEALTH_REPAIR_VERSION;
}

export interface ContextHealthRepairPlanV1 {
  readonly knowledgeDelta: KnowledgeDeltaV1;
  readonly nextCursor?: string;
  readonly omittedProposals: number;
  readonly project: string;
  readonly proposals: readonly ContextHealthRepairProposalV1[];
  /** Exact revision of the source health report, independent of finding order. */
  readonly reportRevision: string;
  readonly sourceOmittedFindings: number;
  readonly version: typeof CONTEXT_HEALTH_REPAIR_VERSION;
}

export interface ContextHealthRepairApplyReceiptV1 {
  readonly proposalId: string;
  readonly resultHash: string;
  readonly revision: string;
  readonly version: typeof CONTEXT_HEALTH_REPAIR_VERSION;
}

export type ContextHealthRepairConflictCodeV1 =
  | 'invalid-proposal'
  | 'precondition-failed'
  | 'project-mismatch'
  | 'receipt-mismatch'
  | 'revision-mismatch'
  | 'shared-mutation-blocked'
  | 'subject-missing';

export interface ContextHealthRepairConflictV1 {
  readonly code: ContextHealthRepairConflictCodeV1;
  /** Stable for the same proposal, expected revision, code, and observed record hashes. */
  readonly conflictId: string;
  readonly message: string;
}

export type ContextHealthRepairApplyResultV1 =
  | {
      readonly records: readonly MemoryRecord[];
      readonly receipt: ContextHealthRepairApplyReceiptV1;
      readonly status: 'applied' | 'already-applied';
    }
  | {
      readonly conflict: ContextHealthRepairConflictV1;
      readonly records: readonly MemoryRecord[];
      readonly status: 'conflict';
    }
  | {
      readonly records: readonly MemoryRecord[];
      readonly status: 'review-required';
    };

export interface ApplyContextHealthRepairProposalInputV1 {
  /** Direct target URIs that storage proved do not exist; unreadable resources are not considered absent. */
  readonly absentTargetUris?: readonly string[];
  readonly expectedRevision: string;
  readonly proposal: ContextHealthRepairProposalV1;
  /** A receipt returned by an earlier successful application of this exact revision. */
  readonly receipt?: ContextHealthRepairApplyReceiptV1;
  /** The caller's current bounded memory snapshot. Unrelated projects remain untouched. */
  readonly records: readonly MemoryRecord[];
}

/**
 * Pure, provider-neutral preview. It derives proposals only from supplied health
 * evidence and record snapshots and never writes or mutates either input.
 */
export function previewContextHealthRepairPlanV1(
  report: ContextHealthReportV1,
  records: readonly MemoryRecord[],
  options: {
    readonly absentTargetUris?: readonly string[];
    readonly citationReplacements?: ReadonlyMap<string, MemoryCodeCitationV1>;
    readonly limit?: number;
    readonly selector?: ContextHealthSelectorV1;
    readonly semanticDirection?: ContextHealthSemanticDirectionV1;
  } = {},
): ContextHealthRepairPlanV1 {
  const recordsByUri = uniqueRecordsByUri(records);
  const absentTargetUris = new Set(options.absentTargetUris ?? []);
  const reportRevision = contextHealthReportRevisionV1(report);
  const semanticDirection = validateSemanticDirection(report, reportRevision, options.semanticDirection);
  const proposals = [...report.findings]
    .sort((left, right) => compareText(left.id, right.id))
    .map(finding =>
      proposalForFinding(
        report.project,
        finding,
        recordsByUri,
        absentTargetUris,
        options.citationReplacements ?? new Map(),
        semanticDirection,
        options.selector,
      ),
    )
    .sort((left, right) => compareText(left.proposalId, right.proposalId));
  const limit = proposalLimit(options.limit);
  const selected = proposals.slice(0, limit);
  return {
    knowledgeDelta: projectContextHealthRepairKnowledgeDeltaV1(reportRevision, selected, recordsByUri),
    ...(report.nextCursor === undefined ? {} : {nextCursor: report.nextCursor}),
    omittedProposals: Math.max(0, proposals.length - limit),
    project: report.project,
    proposals: selected,
    reportRevision,
    sourceOmittedFindings: report.omittedFindings,
    version: CONTEXT_HEALTH_REPAIR_VERSION,
  };
}

/**
 * Applies one proposal to an immutable record snapshot. Storage adapters use the
 * returned records/receipt as the exact postcondition for their own atomic CAS.
 */
export function applyContextHealthRepairProposalV1(
  input: ApplyContextHealthRepairProposalInputV1,
): ContextHealthRepairApplyResultV1 {
  const {proposal, records} = input;
  const canonicalRevision = contextHealthRepairProposalRevisionV1(proposal);
  if (canonicalRevision !== proposal.revision || contextHealthRepairProposalIdV1(proposal) !== proposal.proposalId) {
    return conflict(input, 'invalid-proposal', 'The repair proposal identity or revision is invalid.');
  }
  if (input.expectedRevision !== proposal.revision) {
    return conflict(
      input,
      'revision-mismatch',
      `Repair proposal revision changed: expected ${input.expectedRevision}, current ${proposal.revision}.`,
    );
  }
  if (proposal.mutation.kind === 'review-only') {
    return {records, status: 'review-required'};
  }
  if (input.receipt !== undefined) {
    if (
      input.receipt.version !== CONTEXT_HEALTH_REPAIR_VERSION ||
      input.receipt.proposalId !== proposal.proposalId ||
      input.receipt.revision !== proposal.revision ||
      input.receipt.resultHash !== expectedReceiptResultHash(proposal)
    ) {
      return conflict(input, 'receipt-mismatch', 'The apply receipt belongs to another repair proposal revision.');
    }
    return {records, receipt: input.receipt, status: 'already-applied'};
  }

  const mutation = proposal.mutation;
  const subjectUri = mutation.subjectUri;
  if (isSharedMemoryUri(subjectUri)) {
    return conflict(input, 'shared-mutation-blocked', 'Local health repair never mutates a shared memory.');
  }
  const subject = uniqueRecord(records, subjectUri);
  if (subject?.metadata.project !== undefined && subject.metadata.project !== proposal.project) {
    return conflict(input, 'project-mismatch', `Repair subject ${subjectUri} belongs to another project.`);
  }
  if (mutation.kind === 'remove-relations' && subject !== undefined) {
    const resultContent = relationRepairContent(subject, mutation.targetUri);
    if (
      subject.metadata.relations?.some(relation => relation.uri === mutation.targetUri) !== true &&
      memoryContentHash(subject.content) === mutation.expectedResultContentHash &&
      resultContent !== undefined
    ) {
      return {
        records,
        receipt: applyReceipt(proposal, mutation.expectedResultContentHash),
        status: 'already-applied',
      };
    }
  }
  if (mutation.kind === 'replace-citation' && subject !== undefined) {
    const citations = subject.metadata.codeCitations ?? [];
    if (
      !citations.some(citation => citation.id === mutation.citationId) &&
      citations.some(citation => citation.id === mutation.replacement.id) &&
      memoryContentHash(subject.content) === mutation.expectedResultContentHash
    ) {
      return {
        records,
        receipt: applyReceipt(proposal, mutation.expectedResultContentHash),
        status: 'already-applied',
      };
    }
  }
  if (subject === undefined) {
    return conflict(input, 'subject-missing', `Repair subject ${subjectUri} is missing from the current snapshot.`);
  }

  const observed = observedPreconditionHashes(records, proposal.preconditions);
  if (observed.some(item => item.project !== null && item.project !== item.expectedProject)) {
    return conflict(input, 'project-mismatch', 'A repair precondition resolved outside the proposal project.');
  }
  if (observed.some(item => item.contentHash !== item.expectedContentHash)) {
    return conflict(input, 'precondition-failed', 'Memory content changed after the repair proposal was previewed.');
  }

  if (
    mutation.kind === 'remove-relations' &&
    !relationTargetPreconditionMatches(mutation, records, new Set(input.absentTargetUris ?? []))
  ) {
    return conflict(
      input,
      'precondition-failed',
      'The relation target state changed after the repair proposal was previewed.',
    );
  }

  if (mutation.kind === 'archive-memory') {
    const nextRecords = records.filter(record => record.uri !== mutation.subjectUri);
    return {
      records: nextRecords,
      receipt: applyReceipt(proposal, memoryContentHash(subject.content)),
      status: 'applied',
    };
  }

  const nextContent =
    mutation.kind === 'remove-relations'
      ? relationRepairContent(subject, mutation.targetUri)
      : citationRepairContent(subject, mutation.citationId, mutation.replacement);
  if (nextContent === undefined) {
    return conflict(input, 'invalid-proposal', 'The repair cannot safely rewrite this memory schema.');
  }
  if (memoryContentHash(nextContent) !== mutation.expectedResultContentHash) {
    return conflict(input, 'precondition-failed', 'The repair postcondition no longer matches its preview.');
  }
  const nextRecord = parseMemoryDocument(subject.uri, nextContent);
  if (nextRecord === undefined || nextRecord.metadata.project !== proposal.project) {
    return conflict(input, 'invalid-proposal', 'The repair would produce an invalid project memory.');
  }
  return {
    records: records.map(record => (record === subject ? nextRecord : record)),
    receipt: applyReceipt(proposal, mutation.expectedResultContentHash),
    status: 'applied',
  };
}

export function contextHealthReportRevisionV1(report: ContextHealthReportV1): string {
  return sha256HexSync(
    JSON.stringify({
      findings: [...report.findings]
        .sort((left, right) => compareText(left.id, right.id))
        .map(finding => ({
          category: finding.category,
          confidence: finding.confidence,
          id: finding.id,
          repair: {
            kind: finding.repair.kind,
            subjectUri: finding.repair.subjectUri ?? null,
            summary: finding.repair.summary,
            targetUri: finding.repair.targetUri ?? null,
          },
          repairability: finding.repairability,
          semanticEvidence:
            finding.semanticEvidence === undefined
              ? null
              : {
                  basisFingerprint: finding.semanticEvidence.basisFingerprint,
                  contradictionId: finding.semanticEvidence.contradictionId,
                  left: finding.semanticEvidence.left,
                  right: finding.semanticEvidence.right,
                  similarityMilli: finding.semanticEvidence.similarityMilli,
                },
          severity: finding.severity,
          summary: finding.summary,
          uris: [...finding.uris].sort(compareText),
        })),
      limit: report.limit,
      nextCursor: report.nextCursor ?? null,
      omittedFindings: report.omittedFindings,
      project: report.project,
      recordsScanned: report.recordsScanned,
      remainingFindings: report.remainingFindings ?? null,
      semanticCompleteness: {
        ...report.semanticCompleteness,
        unknownReasons: [...report.semanticCompleteness.unknownReasons].sort((left, right) =>
          compareText(left.reason, right.reason),
        ),
      },
      status: report.status,
      version: report.version,
    }),
  );
}

function validateSemanticDirection(
  report: ContextHealthReportV1,
  reportRevision: string,
  direction: ContextHealthSemanticDirectionV1 | undefined,
): ContextHealthSemanticDirectionV1 | undefined {
  if (direction === undefined) return undefined;
  if (
    direction.type !== 'context-health-semantic-direction' ||
    direction.version !== 1 ||
    !/^[0-9a-f]{64}$/u.test(direction.contradictionId) ||
    !/^[0-9a-f]{64}$/u.test(direction.reportRevision)
  ) {
    throw new Error('Semantic direction has an invalid type, version, contradiction ID, or report revision.');
  }
  if (direction.reportRevision !== reportRevision) {
    throw new Error('Semantic direction belongs to another context-health report revision.');
  }
  const matching = report.findings.filter(
    finding =>
      finding.category === 'semantic-contradiction' &&
      finding.repair.kind === 'review-memory' &&
      finding.semanticEvidence?.contradictionId === direction.contradictionId,
  );
  if (matching.length !== 1) {
    throw new Error('Semantic direction must identify exactly one analyzer contradiction in the current report.');
  }
  const evidence = matching[0]?.semanticEvidence;
  if (evidence === undefined) {
    throw new Error('Semantic direction requires analyzer evidence from the current report.');
  }
  if (
    direction.staleUri === direction.currentUri ||
    !isCanonicalPersonalMemoryUri(direction.staleUri) ||
    !isCanonicalPersonalMemoryUri(direction.currentUri) ||
    !isSamePersonalMemoryScope(direction.staleUri, direction.currentUri)
  ) {
    throw new Error('Semantic direction requires two distinct canonical memories in the same personal scope.');
  }
  const expectedUris = [evidence.left.recordUri, evidence.right.recordUri].sort(compareText);
  const directedUris = [direction.staleUri, direction.currentUri].sort(compareText);
  if (
    compareText(expectedUris[0] ?? '', directedUris[0] ?? '') !== 0 ||
    compareText(expectedUris[1] ?? '', directedUris[1] ?? '') !== 0
  ) {
    throw new Error('Semantic direction URIs do not match the selected analyzer contradiction.');
  }
  return direction;
}

export function contextHealthRepairProposalRevisionV1(
  proposal: Omit<ContextHealthRepairProposalV1, 'revision'> | ContextHealthRepairProposalV1,
): string {
  return sha256HexSync(JSON.stringify(proposalRevisionPayload(proposal)));
}

function proposalForFinding(
  project: string,
  finding: ContextHealthFindingV1,
  recordsByUri: ReadonlyMap<string, MemoryRecord | undefined>,
  absentTargetUris: ReadonlySet<string>,
  citationReplacements: ReadonlyMap<string, MemoryCodeCitationV1>,
  semanticDirection: ContextHealthSemanticDirectionV1 | undefined,
  selector: ContextHealthSelectorV1 | undefined,
): ContextHealthRepairProposalV1 {
  const mutation = mutationForFinding(
    project,
    finding,
    recordsByUri,
    absentTargetUris,
    citationReplacements,
    semanticDirection,
  );
  const preconditions = mutationPreconditions(project, mutation, recordsByUri);
  const base = {
    category: finding.category,
    findingId: finding.id,
    mutation,
    preconditions,
    project,
    proposalId: '',
    ...(selector === undefined ? {} : {selector}),
    summary: boundedSummary(finding.repair.summary),
    version: CONTEXT_HEALTH_REPAIR_VERSION,
  } satisfies Omit<ContextHealthRepairProposalV1, 'revision'>;
  const withIdentity = {...base, proposalId: contextHealthRepairProposalIdV1(base)};
  return {...withIdentity, revision: contextHealthRepairProposalRevisionV1(withIdentity)};
}

function mutationForFinding(
  project: string,
  finding: ContextHealthFindingV1,
  recordsByUri: ReadonlyMap<string, MemoryRecord | undefined>,
  absentTargetUris: ReadonlySet<string>,
  citationReplacements: ReadonlyMap<string, MemoryCodeCitationV1>,
  semanticDirection: ContextHealthSemanticDirectionV1 | undefined,
): ContextHealthRepairMutationV1 {
  const directedFinding =
    finding.semanticEvidence?.contradictionId === semanticDirection?.contradictionId ? semanticDirection : undefined;
  const subjectUri = directedFinding?.staleUri ?? finding.repair.subjectUri;
  const targetUri = directedFinding?.currentUri ?? finding.repair.targetUri;
  const subject = subjectUri === undefined ? undefined : recordsByUri.get(subjectUri);
  const target = targetUri === undefined ? undefined : recordsByUri.get(targetUri);
  const subjectMemoryId = subject?.metadata.memoryId;
  const targetMemoryId = target?.metadata.memoryId;
  if (subjectUri !== undefined && isSharedMemoryUri(subjectUri)) {
    return {
      kind: 'review-only',
      reason: 'Shared memories require a separate reviewed Git proposal and are never mutated by local health repair.',
      repairKind: finding.repair.kind,
      subjectUri,
      ...(targetUri === undefined ? {} : {targetUri}),
    };
  }
  if (
    finding.category === 'semantic-contradiction' &&
    finding.repair.kind === 'review-memory' &&
    directedFinding !== undefined &&
    subjectUri !== undefined &&
    targetUri !== undefined &&
    subjectUri !== targetUri &&
    subject?.metadata.kind === 'durable' &&
    target?.metadata.kind === 'durable' &&
    subject.metadata.project === project &&
    target.metadata.project === project &&
    subject.metadata.status === 'active' &&
    target.metadata.status === 'active' &&
    !isSharedMemoryUri(subjectUri) &&
    !isSharedMemoryUri(targetUri) &&
    subjectMemoryId !== undefined &&
    targetMemoryId !== undefined &&
    isMemoryId(subjectMemoryId) &&
    isMemoryId(targetMemoryId) &&
    archiveRewriteBlocker(subject) === undefined &&
    archiveRewriteBlocker(target) === undefined
  ) {
    return {
      kind: 'review-only',
      reason:
        'The explicit stale/current designation is revision-bound and review-only; applying it must preserve the stale identity in superseded history.',
      repairKind: finding.repair.kind,
      suggestedMutation: {
        archivedFrom: subjectUri,
        designation: directedFinding,
        kind: 'supersede-memory',
        preservedMemoryId: subjectMemoryId,
        status: 'superseded',
        subjectUri,
        supersededByMemoryId: targetMemoryId,
        supersededByUri: targetUri,
      },
      subjectUri,
      targetUri,
    };
  }
  if (
    finding.repair.kind === 'repair-citation' &&
    (finding.category === 'citation-changed' ||
      finding.category === 'citation-missing' ||
      finding.category === 'citation-unknown') &&
    subject !== undefined &&
    subject.metadata.project === project &&
    subject.metadata.status === 'active' &&
    targetUri !== undefined
  ) {
    const citationId = citationIdFromTargetUri(targetUri);
    const replacement = citationReplacements.get(finding.id);
    const current = subject.metadata.codeCitations?.find(citation => citation.id === citationId);
    if (
      citationId !== undefined &&
      replacement !== undefined &&
      current?.repositoryId === replacement.repositoryId &&
      current.repositoryIdentityKind === replacement.repositoryIdentityKind
    ) {
      const resultContent = citationRepairContent(subject, citationId, replacement);
      if (resultContent !== undefined) {
        return {
          citationId,
          expectedResultContentHash: memoryContentHash(resultContent),
          kind: 'replace-citation',
          replacement,
          subjectUri: subject.uri,
        };
      }
    }
  }
  if (
    subject !== undefined &&
    (finding.repair.kind === 'archive-memory' || finding.repair.kind === 'deduplicate-memory') &&
    archiveRewriteBlocker(subject) !== undefined
  ) {
    return {
      kind: 'review-only',
      reason: archiveRewriteBlocker(subject) ?? 'The memory cannot be safely rewritten for archival.',
      repairKind: finding.repair.kind,
      subjectUri: subject.uri,
      ...(targetUri === undefined ? {} : {targetUri}),
    };
  }
  if (
    subject !== undefined &&
    (finding.repair.kind === 'archive-memory' || finding.repair.kind === 'deduplicate-memory') &&
    !isArchiveRepairableKind(subject.metadata.kind)
  ) {
    return {
      kind: 'review-only',
      reason: `Automatic health repair cannot archive ${subject.metadata.kind} memories.`,
      repairKind: finding.repair.kind,
      subjectUri: subject.uri,
      ...(targetUri === undefined ? {} : {targetUri}),
    };
  }
  if (
    finding.repairability === 'reviewable' &&
    finding.repair.kind === 'archive-memory' &&
    subjectUri !== undefined &&
    subject?.metadata.project === project &&
    subject.metadata.status === 'active'
  ) {
    return {kind: 'archive-memory', subjectUri};
  }
  if (
    finding.repairability === 'reviewable' &&
    finding.repair.kind === 'deduplicate-memory' &&
    subjectUri !== undefined &&
    targetUri !== undefined &&
    !isSharedMemoryUri(targetUri) &&
    subject?.metadata.project === project &&
    subject.metadata.status === 'active' &&
    recordsByUri.get(targetUri)?.metadata.project === project &&
    recordsByUri.get(targetUri)?.metadata.status === 'active'
  ) {
    return {kind: 'archive-memory', subjectUri, survivorUri: targetUri};
  }
  if (
    finding.repairability === 'reviewable' &&
    finding.repair.kind === 'repair-relation' &&
    (finding.category === 'relation-target-inactive' || finding.category === 'relation-target-missing') &&
    subjectUri !== undefined &&
    targetUri !== undefined &&
    isAutomaticRelationRepairTargetV1(subjectUri, targetUri) &&
    subject?.metadata.project === project &&
    subject.metadata.status === 'active' &&
    subject.metadata.relations?.some(relation => relation.uri === targetUri) === true
  ) {
    const target = relationTargetRecord(recordsByUri, targetUri);
    const targetAliasMemoryId = memoryIdFromIdentityAlias(targetUri);
    const targetIdentityIsAbsent =
      targetAliasMemoryId === undefined
        ? !recordsByUri.has(targetUri)
        : ![...recordsByUri.values()].some(record => record?.metadata.memoryId === targetAliasMemoryId);
    const targetPrecondition =
      finding.category === 'relation-target-missing' && targetIdentityIsAbsent && absentTargetUris.has(targetUri)
        ? ({state: 'absent'} as const)
        : finding.category === 'relation-target-inactive' && target !== undefined && target.metadata.status !== 'active'
          ? ({expectedContentHash: memoryContentHash(target.content), state: 'inactive'} as const)
          : undefined;
    if (targetPrecondition === undefined) {
      return {
        kind: 'review-only',
        reason: 'The relation target does not have an exact direct-URI state that automatic repair can bind.',
        repairKind: finding.repair.kind,
        subjectUri,
        targetUri,
      };
    }
    const resultContent = relationRepairContent(subject, targetUri);
    if (resultContent === undefined) {
      return {
        kind: 'review-only',
        reason: 'The memory schema cannot be safely rewritten by automatic health repair.',
        repairKind: finding.repair.kind,
        subjectUri,
        targetUri,
      };
    }
    return {
      expectedResultContentHash: memoryContentHash(resultContent),
      kind: 'remove-relations',
      subjectUri,
      targetPrecondition,
      targetUri,
    };
  }
  return {
    kind: 'review-only',
    reason:
      finding.repairability === 'reviewable'
        ? 'The supplied project snapshot does not contain enough exact evidence for an automatic mutation.'
        : `The finding is ${finding.repairability.replace('-', ' ')}.`,
    repairKind: finding.repair.kind,
    ...(subjectUri === undefined ? {} : {subjectUri}),
    ...(targetUri === undefined ? {} : {targetUri}),
  };
}

/** True only for personal targets whose absence can be proven from storage or stable identity. */
export function isAutomaticRelationRepairTargetV1(subjectUri: string, targetUri: string): boolean {
  if (isSharedMemoryUri(subjectUri) || isSharedMemoryUri(targetUri)) return false;
  return memoryIdFromIdentityAlias(targetUri) !== undefined || isSamePersonalMemoryScope(subjectUri, targetUri);
}

function mutationPreconditions(
  project: string,
  mutation: ContextHealthRepairMutationV1,
  recordsByUri: ReadonlyMap<string, MemoryRecord | undefined>,
): readonly ContextHealthRepairRecordPreconditionV1[] {
  if (mutation.kind === 'review-only') {
    if (mutation.suggestedMutation?.kind !== 'supersede-memory') return [];
    return [mutation.suggestedMutation.subjectUri, mutation.suggestedMutation.supersededByUri]
      .flatMap(uri => {
        const record = recordsByUri.get(uri);
        return record === undefined
          ? []
          : [{expectedContentHash: memoryContentHash(record.content), expectedProject: project, uri}];
      })
      .sort((left, right) => compareText(left.uri, right.uri));
  }
  const inactiveRelationTarget =
    mutation.kind === 'remove-relations' && mutation.targetPrecondition.state === 'inactive'
      ? relationTargetRecord(recordsByUri, mutation.targetUri)?.uri
      : undefined;
  const uris = [
    mutation.subjectUri,
    ...(mutation.kind === 'archive-memory' && mutation.survivorUri !== undefined ? [mutation.survivorUri] : []),
    ...(inactiveRelationTarget === undefined ? [] : [inactiveRelationTarget]),
  ];
  return uris
    .flatMap(uri => {
      const record = recordsByUri.get(uri);
      return record === undefined
        ? []
        : [{expectedContentHash: memoryContentHash(record.content), expectedProject: project, uri}];
    })
    .sort((left, right) => compareText(left.uri, right.uri));
}

function uniqueRecordsByUri(records: readonly MemoryRecord[]): ReadonlyMap<string, MemoryRecord | undefined> {
  const grouped = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    grouped.set(record.uri, [...(grouped.get(record.uri) ?? []), record]);
  }
  return new Map([...grouped].map(([uri, matches]) => [uri, matches.length === 1 ? matches[0] : undefined]));
}

function relationTargetRecord(
  recordsByUri: ReadonlyMap<string, MemoryRecord | undefined>,
  targetUri: string,
): MemoryRecord | undefined {
  const direct = recordsByUri.get(targetUri);
  if (direct !== undefined) return direct;
  const targetMemoryId = memoryIdFromIdentityAlias(targetUri);
  if (targetMemoryId === undefined) return undefined;
  return [...recordsByUri.values()].find(record => record?.metadata.memoryId === targetMemoryId);
}

function memoryContentWithoutTargetRelations(record: MemoryRecord, targetUri: string): string {
  const relations = (record.metadata.relations ?? []).filter(relation => relation.uri !== targetUri);
  if (relations.length === (record.metadata.relations ?? []).length)
    return canonicalMemoryDocumentContent(record.content);
  return memoryContentWithRelations(record.content, relations);
}

function relationRepairContent(record: MemoryRecord, targetUri: string): string | undefined {
  try {
    return memoryContentWithoutTargetRelations(record, targetUri);
  } catch {
    return undefined;
  }
}

function citationIdFromTargetUri(targetUri: string): string | undefined {
  const marker = targetUri.lastIndexOf('#');
  const citationId = marker === -1 ? '' : targetUri.slice(marker + 1);
  return /^tncc_[0-9a-f]{40}$/u.test(citationId) ? citationId : undefined;
}

function citationRepairContent(
  record: MemoryRecord,
  citationId: string,
  replacement: MemoryCodeCitationV1,
): string | undefined {
  try {
    assertMemoryDocumentSchemaWritable(record.content);
    if ((record.metadata.citationErrors?.length ?? 0) > 0) return undefined;
    const citations = record.metadata.codeCitations ?? [];
    if (citations.filter(citation => citation.id === citationId).length !== 1) return undefined;
    const current = citations.find(citation => citation.id === citationId);
    if (current === undefined) return undefined;
    const anchoredReplacement = preserveMemoryCodeCitationAnchor(current, replacement);
    const next = citations.map(citation => (citation.id === citationId ? anchoredReplacement : citation));
    formatMemoryCodeCitationLines(next);
    const canonical = canonicalMemoryDocumentContent(record.content).replace(/\r\n?/gu, '\n');
    const separatorIndex = canonical.indexOf('\n\n');
    const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
    const body = separatorIndex === -1 ? '' : canonical.slice(separatorIndex + 2);
    const currentLine = `code_citation: ${formatMemoryCodeCitation(current)}`;
    const replacementLine = `code_citation: ${formatMemoryCodeCitation(anchoredReplacement)}`;
    let replacements = 0;
    const headerLines = header.split('\n').map(line => {
      if (line !== currentLine) return line;
      replacements += 1;
      return replacementLine;
    });
    return replacements === 1 ? [...headerLines, '', body].join('\n').trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Rewrite several independently reviewed citations in one memory revision. */
export function memoryContentWithCitationReplacementsV1(
  record: MemoryRecord,
  replacements: readonly {readonly citationId: string; readonly replacement: MemoryCodeCitationV1}[],
): string | undefined {
  try {
    assertMemoryDocumentSchemaWritable(record.content);
    if (replacements.length === 0 || (record.metadata.citationErrors?.length ?? 0) > 0) return undefined;
    const citations = record.metadata.codeCitations ?? [];
    const replacementById = new Map(replacements.map(item => [item.citationId, item.replacement] as const));
    if (replacementById.size !== replacements.length) return undefined;
    if ([...replacementById.keys()].some(id => citations.filter(citation => citation.id === id).length !== 1)) {
      return undefined;
    }
    for (const citation of citations) {
      const replacement = replacementById.get(citation.id);
      if (replacement !== undefined)
        replacementById.set(citation.id, preserveMemoryCodeCitationAnchor(citation, replacement));
    }
    const next = citations.map(citation => replacementById.get(citation.id) ?? citation);
    formatMemoryCodeCitationLines(next);
    const canonical = canonicalMemoryDocumentContent(record.content).replace(/\r\n?/gu, '\n');
    const separatorIndex = canonical.indexOf('\n\n');
    const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
    const body = separatorIndex === -1 ? '' : canonical.slice(separatorIndex + 2);
    const currentLines = new Map<string, string>(
      citations.flatMap(citation => {
        const replacement = replacementById.get(citation.id);
        return replacement === undefined
          ? []
          : [
              [
                `code_citation: ${formatMemoryCodeCitation(citation)}`,
                `code_citation: ${formatMemoryCodeCitation(replacement)}`,
              ] as const,
            ];
      }),
    );
    const seen = new Set<string>();
    const headerLines = header.split('\n').map(line => {
      const replacement = currentLines.get(line);
      if (replacement === undefined) return line;
      seen.add(line);
      return replacement;
    });
    return seen.size === currentLines.size ? [...headerLines, '', body].join('\n').trim() : undefined;
  } catch {
    return undefined;
  }
}

function memoryContentWithRelations(content: string, relations: readonly MemoryRelation[]): string {
  assertMemoryDocumentSchemaWritable(content);
  const canonical = canonicalMemoryDocumentContent(content).replace(/\r\n?/gu, '\n');
  const separatorIndex = canonical.indexOf('\n\n');
  const header = separatorIndex === -1 ? canonical : canonical.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? '' : canonical.slice(separatorIndex + 2);
  const headerLines = header.split('\n').filter(line => !/^relation\s*:/u.test(line));
  const relationLines = [...relations]
    .sort((left, right) => compareText(`${left.type}\0${left.uri}`, `${right.type}\0${right.uri}`))
    .map(relation => `relation: ${relation.type} ${relation.uri}`);
  return [...headerLines, ...relationLines, '', body].join('\n').trim();
}

function contextHealthRepairProposalIdV1(
  proposal: Omit<ContextHealthRepairProposalV1, 'revision'> | ContextHealthRepairProposalV1,
): string {
  const mutation = proposal.mutation;
  return `health-repair-${sha256HexSync(
    JSON.stringify({
      category: proposal.category,
      findingId: proposal.findingId,
      mutation:
        mutation.kind === 'review-only'
          ? {
              kind: mutation.kind,
              repairKind: mutation.repairKind,
              suggestedMutation: mutation.suggestedMutation ?? null,
              subjectUri: mutation.subjectUri ?? null,
              targetUri: mutation.targetUri ?? null,
            }
          : mutation.kind === 'archive-memory'
            ? {
                kind: mutation.kind,
                subjectUri: mutation.subjectUri,
                survivorUri: mutation.survivorUri ?? null,
              }
            : mutation.kind === 'remove-relations'
              ? {kind: mutation.kind, subjectUri: mutation.subjectUri, targetUri: mutation.targetUri}
              : {
                  citationId: mutation.citationId,
                  kind: mutation.kind,
                  replacementId: mutation.replacement.id,
                  subjectUri: mutation.subjectUri,
                },
      project: proposal.project,
      selector: proposal.selector ?? null,
      version: proposal.version,
    }),
  ).slice(0, 40)}`;
}

function proposalRevisionPayload(
  proposal: Omit<ContextHealthRepairProposalV1, 'revision'> | ContextHealthRepairProposalV1,
) {
  return {
    category: proposal.category,
    findingId: proposal.findingId,
    mutation: canonicalMutation(proposal.mutation),
    preconditions: [...proposal.preconditions]
      .sort((left, right) => compareText(left.uri, right.uri))
      .map(precondition => ({
        expectedContentHash: precondition.expectedContentHash,
        expectedProject: precondition.expectedProject,
        uri: precondition.uri,
      })),
    project: proposal.project,
    proposalId: proposal.proposalId,
    selector: proposal.selector ?? null,
    summary: proposal.summary,
    version: proposal.version,
  };
}

function canonicalMutation(mutation: ContextHealthRepairMutationV1) {
  if (mutation.kind === 'archive-memory') {
    return {
      kind: mutation.kind,
      subjectUri: mutation.subjectUri,
      survivorUri: mutation.survivorUri ?? null,
    };
  }
  if (mutation.kind === 'remove-relations') {
    return {
      expectedResultContentHash: mutation.expectedResultContentHash,
      kind: mutation.kind,
      subjectUri: mutation.subjectUri,
      targetPrecondition: mutation.targetPrecondition,
      targetUri: mutation.targetUri,
    };
  }
  if (mutation.kind === 'replace-citation') {
    return {
      citationId: mutation.citationId,
      expectedResultContentHash: mutation.expectedResultContentHash,
      kind: mutation.kind,
      replacement: mutation.replacement,
      subjectUri: mutation.subjectUri,
    };
  }
  return {
    kind: mutation.kind,
    reason: mutation.reason,
    repairKind: mutation.repairKind,
    suggestedMutation: mutation.suggestedMutation ?? null,
    subjectUri: mutation.subjectUri ?? null,
    targetUri: mutation.targetUri ?? null,
  };
}

function projectContextHealthRepairKnowledgeDeltaV1(
  reportRevision: string,
  proposals: readonly ContextHealthRepairProposalV1[],
  recordsByUri: ReadonlyMap<string, MemoryRecord | undefined>,
): KnowledgeDeltaV1 {
  const selected = [...proposals]
    .sort((left, right) => compareText(left.proposalId, right.proposalId))
    .slice(0, KNOWLEDGE_DELTA_V1_MAX_ITEMS);
  const authorizationHash = sha256HexSync(
    JSON.stringify({
      proposals: selected.map(proposal => ({
        preconditions: [...proposal.preconditions]
          .sort((left, right) => compareText(left.uri, right.uri))
          .map(precondition => ({
            expectedContentHash: precondition.expectedContentHash,
            expectedProject: precondition.expectedProject,
            uri: precondition.uri,
          })),
        proposalId: proposal.proposalId,
        revision: proposal.revision,
      })),
      reportRevision,
      version: CONTEXT_HEALTH_REPAIR_VERSION,
    }),
  );
  const reviewId = `review-${authorizationHash.slice(0, 16)}`;
  const revision = selected.length === 0 ? 1 : Number.parseInt(authorizationHash.slice(16, 28), 16) + 1;
  const items: readonly KnowledgeDeltaItemV1[] = selected.map((proposal, index) => {
    const subjectUri = proposal.mutation.subjectUri;
    const subject = subjectUri === undefined ? undefined : recordsByUri.get(subjectUri);
    const expectedTargetContentHash = proposal.preconditions.find(item => item.uri === subjectUri)?.expectedContentHash;
    const supersede = proposal.mutation.kind === 'review-only' ? proposal.mutation.suggestedMutation : undefined;
    return {
      candidateId: `${reviewId}-${index + 1}`,
      comparison:
        proposal.category === 'semantic-contradiction' ? ('contradiction' as const) : ('replacement' as const),
      comparisonReason: proposal.summary,
      confidence: proposal.category === 'semantic-contradiction' ? 0.65 : 0.9,
      mutationPreview: {
        bodyText:
          supersede?.kind === 'supersede-memory'
            ? `Supersede ${supersede.subjectUri} (${supersede.preservedMemoryId}) with ${supersede.supersededByUri} (${supersede.supersededByMemoryId}); preserve the stale identity in status=superseded history with archived_from=${supersede.archivedFrom}.`
            : proposal.summary,
        ...(expectedTargetContentHash === undefined ? {} : {expectedTargetContentHash}),
        operation: 'requires_explicit_operation' as const,
        ...(subjectUri === undefined ? {} : {replaceUri: subjectUri}),
        truncated: false,
      },
      proposedDestination: {
        kind:
          subject?.metadata.kind === 'handoff' || subject?.metadata.kind === 'preference'
            ? subject.metadata.kind
            : 'durable',
        project: proposal.project,
        ...(subjectUri === undefined ? {} : {targetUri: subjectUri}),
        topic: subject?.metadata.topic ?? 'context-health-review',
      },
      recommendation: 'manual_review' as const,
      sourceEvidence: [
        `health-finding:${sha256HexSync(proposal.findingId)}`,
        `health-proposal:${proposal.proposalId}@${proposal.revision}`,
      ],
      state: 'pending' as const,
      truncated: false,
      type: 'context-repair-or-retirement' as const,
    };
  });
  return {
    items,
    noAction: items.length === 0,
    reviewId,
    revision,
    type: 'knowledge-delta',
    version: 1,
  };
}

function applyReceipt(proposal: ContextHealthRepairProposalV1, resultHash: string): ContextHealthRepairApplyReceiptV1 {
  return {
    proposalId: proposal.proposalId,
    resultHash,
    revision: proposal.revision,
    version: CONTEXT_HEALTH_REPAIR_VERSION,
  };
}

function expectedReceiptResultHash(proposal: ContextHealthRepairProposalV1): string {
  if (proposal.mutation.kind === 'remove-relations' || proposal.mutation.kind === 'replace-citation')
    return proposal.mutation.expectedResultContentHash;
  if (proposal.mutation.kind === 'archive-memory') {
    return (
      proposal.preconditions.find(precondition => precondition.uri === proposal.mutation.subjectUri)
        ?.expectedContentHash ?? ''
    );
  }
  return '';
}

function conflict(
  input: ApplyContextHealthRepairProposalInputV1,
  code: ContextHealthRepairConflictCodeV1,
  message: string,
): ContextHealthRepairApplyResultV1 {
  const observed = observedPreconditionHashes(input.records, input.proposal.preconditions);
  return {
    conflict: {
      code,
      conflictId: `health-repair-conflict-${sha256HexSync(
        JSON.stringify({
          code,
          expectedRevision: input.expectedRevision,
          observed,
          observedRelationTarget:
            input.proposal.mutation.kind === 'remove-relations'
              ? observedRelationTarget(input.proposal.mutation.targetUri, input.records)
              : null,
          proposalId: input.proposal.proposalId,
          revision: input.proposal.revision,
          version: CONTEXT_HEALTH_REPAIR_VERSION,
        }),
      ).slice(0, 40)}`,
      message,
    },
    records: input.records,
    status: 'conflict',
  };
}

function relationTargetPreconditionMatches(
  mutation: Extract<ContextHealthRepairMutationV1, {readonly kind: 'remove-relations'}>,
  records: readonly MemoryRecord[],
  absentTargetUris: ReadonlySet<string>,
): boolean {
  const targetMemoryId = memoryIdFromIdentityAlias(mutation.targetUri);
  const matches = records.filter(record =>
    targetMemoryId === undefined ? record.uri === mutation.targetUri : record.metadata.memoryId === targetMemoryId,
  );
  if (mutation.targetPrecondition.state === 'absent') {
    const identityMatches =
      targetMemoryId === undefined ? matches : records.filter(record => record.metadata.memoryId === targetMemoryId);
    return identityMatches.length === 0 && absentTargetUris.has(mutation.targetUri);
  }
  if (matches.length !== 1) return false;
  const target = matches[0];
  if (!target) return false;
  return (
    target.metadata.status !== 'active' &&
    memoryContentHash(target.content) === mutation.targetPrecondition.expectedContentHash
  );
}

function observedRelationTarget(targetUri: string, records: readonly MemoryRecord[]) {
  const targetMemoryId = memoryIdFromIdentityAlias(targetUri);
  const matches = records.filter(record =>
    targetMemoryId === undefined ? record.uri === targetUri : record.metadata.memoryId === targetMemoryId,
  );
  return {
    matches: matches.map(record => ({
      contentHash: memoryContentHash(record.content),
      project: record.metadata.project ?? null,
      status: record.metadata.status,
    })),
    uri: targetUri,
  };
}

function isSamePersonalMemoryScope(subjectUri: string, targetUri: string): boolean {
  try {
    const subject = parseResourceId(subjectUri);
    const target = parseResourceId(targetUri);
    return (
      subject.anchor === undefined &&
      target.anchor === undefined &&
      subject.namespace === 'user' &&
      target.namespace === 'user' &&
      subject.segments[0] === target.segments[0] &&
      subject.segments[1] === 'memories' &&
      target.segments[1] === 'memories'
    );
  } catch {
    return false;
  }
}

function isCanonicalPersonalMemoryUri(uri: string): boolean {
  try {
    const resource = parseResourceId(uri);
    return (
      resource.canonicalUri === uri &&
      resource.anchor === undefined &&
      resource.namespace === 'user' &&
      resource.segments[1] === 'memories' &&
      resource.segments[2] !== 'shared'
    );
  } catch {
    return false;
  }
}

function observedPreconditionHashes(
  records: readonly MemoryRecord[],
  preconditions: readonly ContextHealthRepairRecordPreconditionV1[],
) {
  return [...preconditions]
    .sort((left, right) => compareText(left.uri, right.uri))
    .map(precondition => {
      const record = uniqueRecord(records, precondition.uri);
      return {
        contentHash: record === undefined ? null : memoryContentHash(record.content),
        expectedContentHash: precondition.expectedContentHash,
        expectedProject: precondition.expectedProject,
        project: record?.metadata.project ?? null,
        uri: precondition.uri,
      };
    });
}

function uniqueRecord(records: readonly MemoryRecord[], uri: string): MemoryRecord | undefined {
  const matches = records.filter(record => record.uri === uri);
  return matches.length === 1 ? matches[0] : undefined;
}

function memoryContentHash(content: string): string {
  return sha256HexSync(canonicalMemoryDocumentContent(content));
}

function proposalLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_CONTEXT_HEALTH_REPAIR_PROPOSAL_LIMIT;
  return Math.max(0, Math.min(MAXIMUM_CONTEXT_HEALTH_REPAIR_PROPOSAL_LIMIT, Math.floor(input)));
}

function boundedSummary(value: string): string {
  return value.length <= MAXIMUM_CONTEXT_HEALTH_REPAIR_SUMMARY_CHARACTERS
    ? value
    : value.slice(0, MAXIMUM_CONTEXT_HEALTH_REPAIR_SUMMARY_CHARACTERS);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isArchiveRepairableKind(kind: MemoryRecord['metadata']['kind']): boolean {
  return kind === 'durable' || kind === 'handoff' || kind === 'incident';
}

function archiveRewriteBlocker(record: MemoryRecord): string | undefined {
  if ((record.metadata.citationErrors?.length ?? 0) > 0) {
    return 'Malformed code citation metadata requires manual repair before archival.';
  }
  try {
    assertMemoryDocumentSchemaWritable(record.content);
    return undefined;
  } catch {
    return 'The memory schema is not writable by this Threadnote version and requires manual review.';
  }
}

import type {ContextBriefMemoryCitationValidationV2} from './types.js';
import type {ContextHealthFindingV1} from './health.js';
import type {ContextHealthSemanticCompletenessV2} from './health_semantic.js';
import type {MemoryRecord} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {memoryCodeCitationAnchorId, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {sha256HexSync} from '@threadnote/platform/sha256';

export type ContextHealthFindingClassificationV2 = 'actionable' | 'automatically-managed' | 'coverage' | 'historical';

export interface ContextMaintenanceSnapshotDiagnosticV1 {
  readonly version: 1;
  readonly category:
    | 'invalid-header'
    | 'invalid-utf8'
    | 'permission-denied'
    | 'record-size-limit'
    | 'cache-size-limit'
    | 'authority-boundary'
    | 'record-not-regular'
    | 'record-changed'
    | 'io-error';
  readonly stage: 'discovery' | 'record-read' | 'authority-check' | 'inventory-cache';
  readonly memoryUri?: string;
  readonly summary: string;
  readonly recovery: string;
  readonly retryable: boolean;
}

export type ContextHealthCaseDispositionV2 =
  | 'queued'
  | 'repairing'
  | 'waiting-evidence'
  | 'needs-decision'
  | 'resolved'
  | 'retired'
  | 'historical'
  | 'deferred-policy';

export interface ContextHealthCitationCoverageV2 {
  readonly eligible: number;
  readonly checked: number;
  readonly pending?: number;
  readonly unavailable?: number;
  readonly deferred: number;
  readonly currentVerified: number;
  readonly historicalVerified: number;
  readonly unverified: number;
  readonly state: 'complete' | 'partial' | 'unavailable';
  readonly reasons: readonly {readonly reason: string; readonly count: number}[];
}

export interface ContextHealthMaintenanceSummaryV2 {
  readonly version: 2;
  readonly actionableFindings: number;
  readonly automaticallyManagedFindings: number;
  readonly historicalFindings: number;
  readonly affectedMemories: number;
  readonly citationCoverage: ContextHealthCitationCoverageV2;
  readonly semanticCoverage: ContextHealthSemanticCompletenessV2;
}

export interface ContextHealthCaseIdentityV2 {
  readonly project: string;
  readonly memoryId: string;
  readonly family: string;
  readonly slot: string;
}

export function contextHealthCitationCaseSlotV2(citation: MemoryCodeCitationV1): string {
  return `anchor:${memoryCodeCitationAnchorId(citation)}`;
}

/** Ordinal alone proves no lineage after insertions, removals or reordering. */
export function migrateContextHealthCitationCaseSlotV2(input: {
  readonly slot: string;
  readonly citationId?: string;
  readonly citations: readonly MemoryCodeCitationV1[];
}): string | undefined {
  const stableId = /^anchor:tncc_[0-9a-f]{40}$/u.test(input.slot) ? input.slot.slice(7) : undefined;
  const evidenceId = input.citationId ?? (/^tncc_[0-9a-f]{40}$/u.test(input.slot) ? input.slot : undefined);
  if (stableId === undefined && evidenceId === undefined) return undefined;
  try {
    const matches = input.citations.filter(citation =>
      stableId === undefined
        ? citation.id === evidenceId || memoryCodeCitationAnchorId(citation) === evidenceId
        : memoryCodeCitationAnchorId(citation) === stableId,
    );
    if (matches.length !== 1) return undefined;
    const match = matches[0];
    const anchorId = memoryCodeCitationAnchorId(match);
    if (evidenceId !== undefined && match.id !== evidenceId && anchorId !== evidenceId) return undefined;
    if (input.citations.filter(citation => memoryCodeCitationAnchorId(citation) === anchorId).length !== 1)
      return undefined;
    return contextHealthCitationCaseSlotV2(match);
  } catch {
    return undefined;
  }
}

export function resolveContextHealthRelationTargetV2(
  records: readonly MemoryRecord[],
  uri: string,
): {readonly state: 'active' | 'inactive' | 'missing' | 'conflicted'; readonly record?: MemoryRecord} {
  const id = memoryIdFromIdentityAlias(uri);
  const matches = records.filter(record =>
    id === undefined ? record.uri === uri || record.metadata.archivedFrom === uri : record.metadata.memoryId === id,
  );
  const record = matches[0];
  return matches.length > 1
    ? {state: 'conflicted'}
    : record === undefined
      ? {state: 'missing'}
      : {state: record.metadata.status === 'active' ? 'active' : 'inactive', record};
}

export function contextHealthFindingCaseIdentityV2(input: {
  readonly project: string;
  readonly finding: ContextHealthFindingV1;
  readonly records: readonly MemoryRecord[];
}): ContextHealthCaseIdentityV2 {
  const {finding, records, project} = input;
  if (finding.caseIdentity !== undefined) return finding.caseIdentity;
  const subjectUri = finding.repair.subjectUri ?? finding.uris[0];
  const subject = records.find(record => record.uri === subjectUri);
  let memoryId = subject?.metadata.memoryId ?? subjectUri ?? 'project';
  let family: string = finding.category;
  let slot = finding.repair.targetUri ?? 'record';
  if (finding.category.startsWith('citation-')) {
    family = 'citation';
    const citationId = finding.repair.targetUri?.slice((subjectUri?.length ?? 0) + 1);
    slot =
      migrateContextHealthCitationCaseSlotV2({
        slot: citationId ?? slot,
        citations: subject?.metadata.codeCitations ?? [],
      }) ??
      citationId ??
      slot;
  } else if (finding.category.startsWith('relation-target-')) {
    family = 'relation';
    slot =
      finding.repair.targetUri === undefined
        ? slot
        : (resolveContextHealthRelationTargetV2(records, finding.repair.targetUri).record?.metadata.memoryId ?? slot);
  } else if (finding.semanticEvidence !== undefined) {
    memoryId = [finding.semanticEvidence.left.recordUri, finding.semanticEvidence.right.recordUri]
      .map(uri => records.find(record => record.uri === uri)?.metadata.memoryId ?? uri)
      .sort()
      .join(':');
    slot = [finding.semanticEvidence.left.claimFingerprint, finding.semanticEvidence.right.claimFingerprint]
      .sort()
      .join(':');
  }
  return {project, memoryId, family, slot};
}

/** Stable identity stays independent of messages, retry reasons and physical memory locations. */
export function contextHealthCaseIdV2(input: ContextHealthCaseIdentityV2): string {
  return `health-case-${sha256HexSync(JSON.stringify([input.project, input.memoryId, input.family, input.slot])).slice(0, 40)}`;
}

export function classifyContextHealthFindingV2(
  finding: ContextHealthFindingV1,
  automaticEligible = true,
): ContextHealthFindingClassificationV2 {
  if (finding.category === 'citation-unknown' || finding.category === 'guidance-unavailable') return 'coverage';
  if (finding.category === 'relation-target-inactive' && finding.classification === 'historical') return 'historical';
  if (
    automaticEligible &&
    (finding.category === 'relation-target-missing' ||
      finding.category === 'relation-target-inactive' ||
      finding.category === 'validity-expired')
  ) {
    return 'automatically-managed';
  }
  return 'actionable';
}

export function contextHealthCitationCoverageV2(input: {
  readonly records: readonly MemoryRecord[];
  readonly validations: readonly ContextBriefMemoryCitationValidationV2[];
}): ContextHealthCitationCoverageV2 {
  const validations = new Map(input.validations.map(validation => [validation.uri, validation]));
  let eligible = 0;
  let checked = 0;
  let pending = 0;
  let unavailable = 0;
  let completeChecks = 0;
  let currentVerified = 0;
  let historicalVerified = 0;
  const reasons = new Map<string, number>();
  for (const record of input.records) {
    const receipts = new Map(
      (validations.get(record.uri)?.receipts ?? []).map(receipt => [receipt.citationId, receipt]),
    );
    const citationIds = new Set([
      ...(record.metadata.codeCitations ?? []).map(citation => citation.id),
      ...receipts.keys(),
    ]);
    for (const citationId of citationIds) {
      eligible += 1;
      const receipt = receipts.get(citationId);
      const historical = receipt?.provenance === 'historical-verified';
      const completed = receipt !== undefined && receipt.status !== 'unknown' && !historical;
      if (!historical && !completed) {
        if (receipt === undefined || (receipt.status === 'unknown' && receipt.reason === 'citation-limit'))
          pending += 1;
        else unavailable += 1;
      }
      const completeEvidence = completed && receipt.coverage === 'current-complete';
      if (completed) checked += 1;
      if (completeEvidence) completeChecks += 1;
      if (
        completeEvidence &&
        (receipt.status === 'exact' || receipt.status === 'relocated') &&
        (receipt.provenance === undefined || receipt.provenance === 'current-verified')
      )
        currentVerified += 1;
      if (!completeEvidence) {
        const reason = receipt?.reason ?? 'not-checked';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
      if (receipt !== undefined && 'provenance' in receipt && receipt.provenance === 'historical-verified') {
        historicalVerified += 1;
      }
    }
  }
  return {
    eligible,
    checked,
    pending,
    unavailable,
    deferred: eligible - checked,
    currentVerified,
    historicalVerified,
    unverified: eligible - currentVerified - historicalVerified,
    state: completeChecks === eligible ? 'complete' : checked === 0 ? 'unavailable' : 'partial',
    reasons: [...reasons]
      .map(([reason, count]) => ({reason, count}))
      .sort((left, right) => left.reason.localeCompare(right.reason)),
  };
}

export function summarizeContextHealthMaintenanceV2(input: {
  readonly findings: readonly ContextHealthFindingV1[];
  readonly citationCoverage: ContextHealthCitationCoverageV2;
  readonly semanticCoverage: ContextHealthSemanticCompletenessV2;
}): ContextHealthMaintenanceSummaryV2 {
  const count = (classification: ContextHealthFindingClassificationV2) =>
    input.findings.filter(finding => finding.classification === classification).length;
  return {
    version: 2,
    actionableFindings: count('actionable'),
    automaticallyManagedFindings: count('automatically-managed'),
    historicalFindings: count('historical'),
    affectedMemories: new Set(
      input.findings
        .filter(finding => finding.classification === 'actionable')
        .flatMap(finding => (finding.repair.subjectUri === undefined ? finding.uris : [finding.repair.subjectUri])),
    ).size,
    citationCoverage: input.citationCoverage,
    semanticCoverage: input.semanticCoverage,
  };
}

import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
import type {ContextBriefMemoryCitationValidationV2} from './types.js';
import type {ContextHealthFindingV1} from './health.js';
import type {ContextHealthSemanticCompletenessV2} from './health_semantic.js';
import type {MemoryRecord} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {currentMemoryCodeCitations} from '@threadnote/memory/reviewed-support';
import {memoryCodeCitationAnchorId, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export type ContextHealthFindingClassificationV2 = 'actionable' | 'automatically-managed' | 'coverage' | 'historical';

export const ContextMaintenanceSnapshotDiagnosticV1 = Schema.Struct({
  version: Schema.Literals([1]),
  category: Schema.Literals([
    'invalid-header',
    'invalid-utf8',
    'permission-denied',
    'record-size-limit',
    'cache-size-limit',
    'authority-boundary',
    'record-not-regular',
    'record-changed',
    'io-error',
  ]),
  stage: Schema.Literals(['discovery', 'record-read', 'authority-check', 'inventory-cache']),
  memoryUri: Schema.optional(Schema.String),
  summary: Schema.String,
  recovery: Schema.String,
  retryable: Schema.Boolean,
});
export type ContextMaintenanceSnapshotDiagnosticV1 = typeof ContextMaintenanceSnapshotDiagnosticV1.Type;

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
  const stableId = /^anchor:tncc_[0-9a-f]{40}$/u.test(input.slot)
    ? Effect.pipe(input.slot, EffectString.slice(7))
    : undefined;
  const evidenceId = input.citationId ?? (/^tncc_[0-9a-f]{40}$/u.test(input.slot) ? input.slot : undefined);
  if (stableId === undefined && evidenceId === undefined) return undefined;
  try {
    const matches = EffectArray.filter(input.citations, citation =>
      stableId === undefined
        ? citation.id === evidenceId || memoryCodeCitationAnchorId(citation) === evidenceId
        : memoryCodeCitationAnchorId(citation) === stableId,
    );
    if (matches.length !== 1) return undefined;
    const match = matches[0];
    const anchorId = memoryCodeCitationAnchorId(match);
    if (evidenceId !== undefined && match.id !== evidenceId && anchorId !== evidenceId) return undefined;
    if (EffectArray.filter(input.citations, citation => memoryCodeCitationAnchorId(citation) === anchorId).length !== 1)
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
  const matches = EffectArray.filter(records, record =>
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
  const subject = EffectOption.getOrUndefined(EffectArray.findFirst(records, record => record.uri === subjectUri));
  let memoryId = subject?.metadata.memoryId ?? subjectUri ?? 'project';
  let family: string = finding.category;
  let slot = finding.repair.targetUri ?? 'record';
  if (Effect.pipe(finding.category, EffectString.startsWith('citation-'))) {
    family = 'citation';
    const citationId = Effect.pipe(finding.repair.targetUri, effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect.pipe(effectOptionalString, EffectString.slice((subjectUri?.length ?? 0) + 1)),
    );
    slot =
      migrateContextHealthCitationCaseSlotV2({
        slot: citationId ?? slot,
        citations: subject === undefined ? [] : currentMemoryCodeCitations(subject),
      }) ??
      citationId ??
      slot;
  } else if (Effect.pipe(finding.category, EffectString.startsWith('relation-target-'))) {
    family = 'relation';
    slot =
      finding.repair.targetUri === undefined
        ? slot
        : (resolveContextHealthRelationTargetV2(records, finding.repair.targetUri).record?.metadata.memoryId ?? slot);
  } else if (finding.semanticEvidence !== undefined) {
    memoryId = EffectArray.join(
      EffectArray.map(
        [finding.semanticEvidence.left.recordUri, finding.semanticEvidence.right.recordUri],
        uri =>
          EffectOption.getOrUndefined(EffectArray.findFirst(records, record => record.uri === uri))?.metadata
            .memoryId ?? uri,
      ).sort(),
      ':',
    );
    slot = EffectArray.join(
      [finding.semanticEvidence.left.claimFingerprint, finding.semanticEvidence.right.claimFingerprint].sort(),
      ':',
    );
  }
  return {project, memoryId, family, slot};
}

/** Stable identity stays independent of messages, retry reasons and physical memory locations. */
export function contextHealthCaseIdV2(input: ContextHealthCaseIdentityV2): string {
  return `health-case-${Effect.pipe(sha256HexSync(JSON.stringify([input.project, input.memoryId, input.family, input.slot])), EffectString.slice(0, 40))}`;
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
  /** Reader DTOs may explicitly select a bounded subset of the canonical current vector. */
  readonly citationSelection?: 'provided';
}): ContextHealthCitationCoverageV2 {
  const validations = new Map(EffectArray.map(input.validations, validation => [validation.uri, validation]));
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
      EffectArray.map(validations.get(record.uri)?.receipts ?? [], receipt => [receipt.citationId, receipt]),
    );
    const current = currentMemoryCodeCitations(record);
    const provided = new Set(EffectArray.map(record.metadata.codeCitations ?? [], citation => citation.id));
    const citationIds = new Set(
      record.metadata.reviewedSupport === undefined
        ? [...EffectArray.map(current, citation => citation.id), ...receipts.keys()]
        : EffectArray.map(
            EffectArray.filter(
              current,
              (citation, __effectArrayIndex) =>
                __effectArrayIndex in current && (input.citationSelection !== 'provided' || provided.has(citation.id)),
            ),
            citation => citation.id,
          ),
    );
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
    reasons: EffectArray.map([...reasons], ([reason, count]) => ({reason, count})).sort((left, right) =>
      Effect.pipe(left.reason, EffectString.localeCompare(right.reason)),
    ),
  };
}

export function summarizeContextHealthMaintenanceV2(input: {
  readonly findings: readonly ContextHealthFindingV1[];
  readonly citationCoverage: ContextHealthCitationCoverageV2;
  readonly semanticCoverage: ContextHealthSemanticCompletenessV2;
}): ContextHealthMaintenanceSummaryV2 {
  const count = (classification: ContextHealthFindingClassificationV2) =>
    EffectArray.filter(input.findings, finding => finding.classification === classification).length;
  return {
    version: 2,
    actionableFindings: count('actionable'),
    automaticallyManagedFindings: count('automatically-managed'),
    historicalFindings: count('historical'),
    affectedMemories: new Set(
      EffectArray.flatMap(
        EffectArray.filter(
          input.findings,
          (finding: ContextHealthFindingV1) => finding.classification === 'actionable',
        ),
        (finding: ContextHealthFindingV1) =>
          finding.repair.subjectUri === undefined ? finding.uris : [finding.repair.subjectUri],
      ),
    ).size,
    citationCoverage: input.citationCoverage,
    semanticCoverage: input.semanticCoverage,
  };
}

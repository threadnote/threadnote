import type {
  ContextBriefCitationValidationReceiptV2,
  ContextBriefMemoryCitationValidationV2,
} from '@threadnote/context/types';
import {buildCompactPlan} from '@threadnote/memory/hygiene';
import type {CandidateComparison} from '@threadnote/memory/candidate';
import {isAgentArtifactUri, type MemoryRecord} from '@threadnote/memory/document';
import {
  analyzeContextHealthSemantics,
  type ContextHealthSemanticCompletenessV1,
  type ContextHealthSemanticContradictionV1,
} from './health_semantic.js';
import {
  classifyContextHealthFindingV2,
  contextHealthCaseIdV2,
  contextHealthFindingCaseIdentityV2,
  type ContextHealthCaseIdentityV2,
  contextHealthCitationCoverageV2,
  summarizeContextHealthMaintenanceV2,
  type ContextHealthCitationCoverageV2,
  type ContextHealthFindingClassificationV2,
  type ContextHealthMaintenanceSummaryV2,
} from './health_maintenance.js';
import {sha256HexSync} from '@threadnote/platform/sha256';

export const CONTEXT_HEALTH_REPORT_VERSION = 1 as const;
export const DEFAULT_CONTEXT_HEALTH_FINDING_LIMIT = 100 as const;
export const MAXIMUM_CONTEXT_HEALTH_FINDING_LIMIT = 500 as const;

export type ContextHealthFindingCategoryV1 =
  | 'candidate-contradiction'
  | 'candidate-possible-duplicate'
  | 'citation-changed'
  | 'citation-missing'
  | 'citation-unknown'
  | 'exact-duplicate'
  | 'guidance-locally-modified'
  | 'guidance-missing-block'
  | 'guidance-stale-sources'
  | 'guidance-unavailable'
  | 'relation-target-conflicted'
  | 'relation-target-inactive'
  | 'relation-target-missing'
  | 'review-overdue'
  | 'semantic-contradiction'
  | 'validity-expired';

export type ContextHealthSeverityV1 = 'critical' | 'high' | 'low' | 'medium';
export type ContextHealthConfidenceV1 = 'high' | 'low' | 'medium';
export type ContextHealthRepairabilityV1 = 'manual-review' | 'requires-evidence' | 'reviewable';

export interface ContextHealthRepairDescriptorV1 {
  readonly kind:
    | 'archive-memory'
    | 'deduplicate-memory'
    | 'repair-guidance'
    | 'repair-citation'
    | 'repair-relation'
    | 'review-candidate'
    | 'review-memory';
  readonly subjectUri?: string;
  readonly summary: string;
  readonly targetUri?: string;
}

export interface ContextHealthFindingV1 {
  readonly caseId?: string;
  readonly caseIdentity?: ContextHealthCaseIdentityV2;
  readonly classification?: ContextHealthFindingClassificationV2;
  readonly category: ContextHealthFindingCategoryV1;
  readonly confidence: ContextHealthConfidenceV1;
  readonly id: string;
  readonly repair: ContextHealthRepairDescriptorV1;
  readonly repairability: ContextHealthRepairabilityV1;
  readonly semanticEvidence?: ContextHealthSemanticContradictionV1;
  readonly severity: ContextHealthSeverityV1;
  readonly summary: string;
  readonly uris: readonly string[];
}

export interface ContextHealthRelationEvidenceV1 {
  readonly sourceUri: string;
  readonly status: 'active' | 'conflicted' | 'inactive' | 'missing';
  readonly targetUri: string;
}

export interface ContextHealthCandidateEvidenceV1 {
  readonly candidateId: string;
  readonly comparison: CandidateComparison;
  readonly project: string;
  readonly targetUri?: string;
}

export interface ContextHealthGuidanceEvidenceV1 {
  readonly sourceUris: readonly string[];
  readonly state: 'locally-modified' | 'missing-block' | 'stale-sources' | 'unavailable';
}

export interface ContextHealthReportInputV1 {
  readonly after?: string;
  readonly candidateEvidence?: readonly ContextHealthCandidateEvidenceV1[];
  readonly guidanceEvidence?: readonly ContextHealthGuidanceEvidenceV1[];
  readonly citationValidations?: readonly ContextBriefMemoryCitationValidationV2[];
  readonly citationCoverage?: ContextHealthCitationCoverageV2;
  readonly includeCitationCoverageFindings?: boolean;
  readonly duplicateCorpus?: readonly MemoryRecord[];
  readonly includeFindingCategories?: readonly ContextHealthFindingCategoryV1[];
  /** How category and URI filters combine when both are present. Defaults to the legacy `any` behavior. */
  readonly includeFindingCombination?: 'all' | 'any';
  readonly includeFindingUris?: readonly string[];
  readonly limit?: number;
  readonly now: Date;
  readonly project: string;
  readonly records: readonly MemoryRecord[];
  readonly relationEvidence?: readonly ContextHealthRelationEvidenceV1[];
}

export interface ContextHealthReportV1 {
  readonly maintenance?: ContextHealthMaintenanceSummaryV2;
  readonly findings: readonly ContextHealthFindingV1[];
  readonly limit: number;
  readonly omittedFindings: number;
  readonly nextCursor?: string;
  readonly project: string;
  readonly recordsScanned: number;
  /** Findings after this page; unlike omittedFindings, excludes earlier pages. */
  readonly remainingFindings?: number;
  readonly semanticCompleteness: ContextHealthSemanticCompletenessV1;
  readonly status: 'clean' | 'findings' | 'unknown';
  readonly version: typeof CONTEXT_HEALTH_REPORT_VERSION;
}

/** A pure, evidence-driven maintenance planner. It only describes reviewable repairs. */
export function buildContextHealthReport(input: ContextHealthReportInputV1): ContextHealthReportV1 {
  const records = input.records
    .filter(record => record.metadata.status === 'active' && record.metadata.project === input.project)
    .sort(compareRecords);
  const recordUris = new Set(records.map(record => record.uri));
  const includeFindingCategories =
    input.includeFindingCategories === undefined ? undefined : new Set(input.includeFindingCategories);
  const includeFindingUris = input.includeFindingUris === undefined ? undefined : new Set(input.includeFindingUris);
  const semanticAnalysis = analyzeContextHealthSemantics({project: input.project, records});
  const duplicateCorpus = (input.duplicateCorpus ?? records)
    .filter(record => record.metadata.status === 'active' && record.metadata.project === input.project)
    .sort(compareRecords);
  const findings = deduplicateFindings(
    [
      ...validityFindings(records, input.now),
      ...reviewFindings(records, input.now),
      ...citationFindings(input.citationValidations ?? [], recordUris, input.includeCitationCoverageFindings ?? false),
      ...relationFindings(input.relationEvidence ?? [], records),
      ...duplicateFindings(duplicateCorpus, input.project, input.now),
      ...candidateFindings(input.candidateEvidence ?? [], input.project),
      ...guidanceFindings(input.guidanceEvidence ?? []),
      ...semanticFindings(semanticAnalysis.contradictions),
    ].sort(compareFindings),
  )
    .map(finding => projectFinding(finding, input.project, input.records))
    .filter(finding => {
      const categoryMatches = includeFindingCategories?.has(finding.category);
      const uriMatches =
        includeFindingUris === undefined ? undefined : findingMatchesSelectedUris(finding, includeFindingUris);
      if (categoryMatches === undefined) return uriMatches ?? true;
      if (uriMatches === undefined) return categoryMatches;
      return input.includeFindingCombination === 'all' ? categoryMatches && uriMatches : categoryMatches || uriMatches;
    });
  const citationCoverage =
    input.citationCoverage ?? contextHealthCitationCoverageV2({records, validations: input.citationValidations ?? []});
  const maintenance = summarizeContextHealthMaintenanceV2({
    findings,
    citationCoverage,
    semanticCoverage: semanticAnalysis.completeness,
  });
  const limit = findingLimit(input.limit);
  const cursorDigest = contextHealthCursorDigest(records, findings);
  const start = contextHealthCursorStart(input.after, findings.length, cursorDigest);
  const selectedFindings = findings.slice(start, start + limit);
  const omittedFindings = Math.max(0, findings.length - selectedFindings.length);
  const remainingFindings = Math.max(0, findings.length - start - selectedFindings.length);
  const filtered = includeFindingUris !== undefined || includeFindingCategories !== undefined;
  return {
    findings: selectedFindings,
    maintenance,
    limit,
    ...(remainingFindings === 0
      ? {}
      : {nextCursor: contextHealthCursor(start + selectedFindings.length, cursorDigest)}),
    omittedFindings,
    project: input.project,
    recordsScanned: records.length,
    ...(input.after === undefined && remainingFindings === 0 ? {} : {remainingFindings}),
    semanticCompleteness: semanticAnalysis.completeness,
    status:
      semanticAnalysis.completeness.state !== 'complete' ||
      citationCoverage.state !== 'complete' ||
      (filtered && findings.length === 0)
        ? 'unknown'
        : findings.length > 0
          ? 'findings'
          : 'clean',
    version: CONTEXT_HEALTH_REPORT_VERSION,
  };
}

function findingMatchesSelectedUris(finding: ContextHealthFindingV1, includeFindingUris: ReadonlySet<string>): boolean {
  return finding.repair.subjectUri === undefined
    ? finding.uris.some(uri => includeFindingUris.has(uri))
    : includeFindingUris.has(finding.repair.subjectUri);
}

function contextHealthCursor(position: number, digest: string): string {
  return `hcx1_${position.toString(36)}_${digest.slice(0, 40)}`;
}

function contextHealthCursorStart(after: string | undefined, findingCount: number, digest: string): number {
  if (after === undefined) return 0;
  const match = /^hcx1_([1-9a-z][0-9a-z]*)_([0-9a-f]{40})$/u.exec(after);
  const position = match === null ? Number.NaN : Number.parseInt(match[1] ?? '', 36);
  if (
    !Number.isSafeInteger(position) ||
    position <= 0 ||
    position >= findingCount ||
    match?.[2] !== digest.slice(0, 40)
  ) {
    throw new Error('Context-health continuation cursor is invalid or stale; rerun the first page.');
  }
  return position;
}

function contextHealthCursorDigest(
  records: readonly MemoryRecord[],
  findings: readonly ContextHealthFindingV1[],
): string {
  return sha256HexSync(
    JSON.stringify({
      findings: findings.map(finding => finding.id),
      records: records
        .map(record => ({contentHash: sha256HexSync(record.content), uri: record.uri}))
        .sort((left, right) => compareText(`${left.uri}\0${left.contentHash}`, `${right.uri}\0${right.contentHash}`)),
      version: CONTEXT_HEALTH_REPORT_VERSION,
    }),
  );
}

function semanticFindings(
  contradictions: readonly ContextHealthSemanticContradictionV1[],
): readonly ContextHealthFindingV1[] {
  return contradictions.map(semanticEvidence => ({
    ...finding(
      'semantic-contradiction',
      [semanticEvidence.left.recordUri, semanticEvidence.right.recordUri],
      `claims ${semanticEvidence.left.claimId} and ${semanticEvidence.right.claimId} have opposing assertions`,
      {
        confidence: 'medium',
        kind: 'review-memory',
        repairability: 'manual-review',
        severity: 'medium',
        summary: 'Review both durable claims, designate which assertion is stale, then supersede or correct it.',
      },
    ),
    semanticEvidence,
  }));
}

function guidanceFindings(evidence: readonly ContextHealthGuidanceEvidenceV1[]): readonly ContextHealthFindingV1[] {
  return evidence.flatMap(item => {
    const uris = [...new Set(item.sourceUris)].sort(compareText);
    if (uris.length === 0) return [];
    return [
      finding(`guidance-${item.state}`, uris, `project guidance is ${item.state}`, {
        confidence: 'high',
        kind: 'repair-guidance',
        repairability: item.state === 'unavailable' ? 'requires-evidence' : 'reviewable',
        severity: item.state === 'stale-sources' ? 'medium' : 'high',
        summary: `Review projected project guidance: ${item.state}.`,
      }),
    ];
  });
}

function validityFindings(records: readonly MemoryRecord[], now: Date): readonly ContextHealthFindingV1[] {
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) return [];
  return records.flatMap(record => {
    const validTo = timestamp(record.metadata.validTo);
    if (validTo === undefined || validTo > nowMilliseconds) return [];
    return [
      finding('validity-expired', [record.uri], `valid_to expired at ${record.metadata.validTo}`, {
        confidence: 'high',
        kind: 'archive-memory',
        repairability: 'reviewable',
        severity: 'critical',
        subjectUri: record.uri,
        summary: 'Review whether this expired memory should be archived or replaced.',
      }),
    ];
  });
}

function reviewFindings(records: readonly MemoryRecord[], now: Date): readonly ContextHealthFindingV1[] {
  const nowMilliseconds = now.getTime();
  return records.flatMap(record => {
    const reviewAfter = record.metadata.reviewAfter;
    const reviewAfterMilliseconds = timestamp(reviewAfter) ?? timestamp(`${reviewAfter}T00:00:00.000Z`);
    if (reviewAfterMilliseconds === undefined || reviewAfterMilliseconds > nowMilliseconds) return [];
    return [
      finding('review-overdue', [record.uri], `review_after ${reviewAfter} is due`, {
        confidence: 'high',
        kind: 'review-memory',
        repairability: 'reviewable',
        severity: 'medium',
        subjectUri: record.uri,
        summary: 'Review this memory and record its maintenance outcome.',
      }),
    ];
  });
}

function citationFindings(
  validations: readonly ContextBriefMemoryCitationValidationV2[],
  recordUris: ReadonlySet<string>,
  includeCoverageFindings: boolean,
): readonly ContextHealthFindingV1[] {
  return validations
    .filter(validation => recordUris.has(validation.uri))
    .flatMap(validation =>
      validation.receipts.flatMap(receipt => citationFinding(validation.uri, receipt, includeCoverageFindings)),
    );
}

function citationFinding(
  uri: string,
  receipt: ContextBriefCitationValidationReceiptV2,
  includeCoverageFindings: boolean,
): readonly ContextHealthFindingV1[] {
  const citationUri = `${uri}#${receipt.citationId}`;
  if (receipt.status === 'changed') {
    return [
      finding('citation-changed', [uri], `citation ${receipt.citationId} no longer matches current source`, {
        confidence: receipt.coverage === 'current-complete' ? 'high' : 'medium',
        kind: 'repair-citation',
        repairability: 'reviewable',
        severity: 'high',
        subjectUri: uri,
        summary: `Review and recapture citation ${receipt.citationId}.`,
        targetUri: citationUri,
      }),
    ];
  }
  if (receipt.status === 'deleted') {
    return [
      finding('citation-missing', [uri], `citation ${receipt.citationId} target is missing`, {
        confidence: receipt.coverage === 'current-complete' ? 'high' : 'medium',
        kind: 'repair-citation',
        repairability: 'reviewable',
        severity: 'high',
        subjectUri: uri,
        summary: `Review the missing target for citation ${receipt.citationId}.`,
        targetUri: citationUri,
      }),
    ];
  }
  if (receipt.status === 'unknown') {
    if (!includeCoverageFindings && receipt.provenance === 'historical-verified') return [];
    if (
      !includeCoverageFindings &&
      ['citation-limit', 'graph-incomplete', 'graph-stale', 'validation-error'].includes(receipt.reason)
    )
      return [];
    return [
      finding('citation-unknown', [uri], `citation ${receipt.citationId} could not be validated: ${receipt.reason}`, {
        confidence: 'low',
        kind: 'repair-citation',
        repairability: 'requires-evidence',
        severity: 'low',
        subjectUri: uri,
        summary: `Restore validation evidence before repairing citation ${receipt.citationId}.`,
        targetUri: citationUri,
      }),
    ];
  }
  return [];
}

function relationFindings(
  evidence: readonly ContextHealthRelationEvidenceV1[],
  records: readonly MemoryRecord[],
): readonly ContextHealthFindingV1[] {
  const relationsBySource = new Map(records.map(record => [record.uri, record.metadata.relations ?? []]));
  return evidence
    .filter(
      item =>
        !isAgentArtifactUri(item.targetUri) &&
        item.status !== 'active' &&
        relationsBySource.get(item.sourceUri)?.some(relation => relation.uri === item.targetUri) === true,
    )
    .map(item => {
      const historical =
        item.status === 'inactive' &&
        relationsBySource
          .get(item.sourceUri)
          ?.filter(relation => relation.uri === item.targetUri)
          .every(relation => relation.type !== 'depends_on') === true;
      const category = `relation-target-${item.status}` as Extract<
        ContextHealthFindingCategoryV1,
        `relation-target-${string}`
      >;
      return {
        ...finding(category, [item.sourceUri, item.targetUri], `relation target is ${item.status}`, {
          confidence: item.status === 'conflicted' ? 'medium' : 'high',
          kind: 'repair-relation',
          repairability: item.status === 'conflicted' ? 'manual-review' : 'reviewable',
          severity: 'high',
          subjectUri: item.sourceUri,
          summary: `Review the relation target ${item.targetUri}.`,
          targetUri: item.targetUri,
        }),
        ...(historical ? {classification: 'historical' as const} : {}),
      };
    });
}

function duplicateFindings(
  records: readonly MemoryRecord[],
  project: string,
  now: Date,
): readonly ContextHealthFindingV1[] {
  const plan = buildCompactPlan(records, {now, project});
  return plan.forgets.flatMap(action => {
    if (!action.reason.startsWith('exact duplicate of ')) return [];
    const survivor = action.reason.slice('exact duplicate of '.length);
    return [
      finding('exact-duplicate', [action.uri, survivor], `exact duplicate of ${survivor}`, {
        confidence: 'high',
        kind: 'deduplicate-memory',
        repairability: 'reviewable',
        severity: 'medium',
        subjectUri: action.uri,
        summary: `Review duplicate retirement against survivor ${survivor}.`,
        targetUri: survivor,
      }),
    ];
  });
}

function candidateFindings(
  evidence: readonly ContextHealthCandidateEvidenceV1[],
  project: string,
): readonly ContextHealthFindingV1[] {
  return evidence
    .filter(
      item =>
        item.project === project && (item.comparison === 'contradiction' || item.comparison === 'possible_duplicate'),
    )
    .map(item => {
      const category = item.comparison === 'contradiction' ? 'candidate-contradiction' : 'candidate-possible-duplicate';
      const uris = item.targetUri === undefined ? [] : [item.targetUri];
      return {
        ...finding(category, uris, `candidate ${item.candidateId} is ${item.comparison.replace('_', ' ')}`, {
          confidence: 'medium',
          kind: 'review-candidate',
          repairability: 'manual-review',
          severity: 'medium',
          summary: `Review candidate ${item.candidateId} before applying it.`,
          ...(item.targetUri === undefined ? {} : {targetUri: item.targetUri}),
        }),
        caseIdentity: {project, memoryId: 'candidate', family: 'candidate', slot: item.candidateId},
        caseId: contextHealthCaseIdV2({project, memoryId: 'candidate', family: 'candidate', slot: item.candidateId}),
      };
    });
}

function finding(
  category: ContextHealthFindingCategoryV1,
  uris: readonly string[],
  summary: string,
  repair: Omit<ContextHealthRepairDescriptorV1, 'summary'> & {
    readonly confidence: ContextHealthConfidenceV1;
    readonly repairability: ContextHealthRepairabilityV1;
    readonly severity: ContextHealthSeverityV1;
    readonly summary: string;
  },
): ContextHealthFindingV1 {
  const canonicalUris = [...new Set(uris)].sort(compareText);
  return {
    category,
    confidence: repair.confidence,
    id: [category, ...canonicalUris, summary].join('\u0000'),
    repair: {
      kind: repair.kind,
      ...(repair.subjectUri === undefined ? {} : {subjectUri: repair.subjectUri}),
      summary: repair.summary,
      ...(repair.targetUri === undefined ? {} : {targetUri: repair.targetUri}),
    },
    repairability: repair.repairability,
    severity: repair.severity,
    summary,
    uris: canonicalUris,
  };
}

function projectFinding(
  finding: ContextHealthFindingV1,
  project: string,
  records: readonly MemoryRecord[],
): ContextHealthFindingV1 {
  const subjectUri = finding.repair.subjectUri ?? finding.uris[0];
  const subject = records.find(record => record.uri === subjectUri);
  const caseIdentity = contextHealthFindingCaseIdentityV2({project, finding, records});
  return {
    ...finding,
    caseIdentity,
    caseId: finding.caseId ?? contextHealthCaseIdV2(caseIdentity),
    classification: classifyContextHealthFindingV2(
      finding,
      subject?.metadata.visibility !== 'shared' && subject?.metadata.visibility !== 'external',
    ),
  };
}

function findingLimit(input: number | undefined): number {
  if (input === undefined) return DEFAULT_CONTEXT_HEALTH_FINDING_LIMIT;
  if (!Number.isFinite(input)) return DEFAULT_CONTEXT_HEALTH_FINDING_LIMIT;
  return Math.max(0, Math.min(MAXIMUM_CONTEXT_HEALTH_FINDING_LIMIT, Math.floor(input)));
}

function compareFindings(left: ContextHealthFindingV1, right: ContextHealthFindingV1): number {
  const severity = severityRank(left.severity) - severityRank(right.severity);
  if (severity !== 0) return severity;
  const category = categoryRank(left.category) - categoryRank(right.category);
  if (category !== 0) return category;
  return compareText(left.id, right.id);
}

function deduplicateFindings(findings: readonly ContextHealthFindingV1[]): readonly ContextHealthFindingV1[] {
  return [...new Map(findings.map(finding => [finding.id, finding])).values()];
}

function severityRank(severity: ContextHealthSeverityV1): number {
  return {critical: 0, high: 1, medium: 2, low: 3}[severity];
}

function categoryRank(category: ContextHealthFindingCategoryV1): number {
  const rank: Record<ContextHealthFindingCategoryV1, number> = {
    'validity-expired': 0,
    'citation-changed': 1,
    'citation-missing': 2,
    'relation-target-missing': 3,
    'relation-target-inactive': 4,
    'relation-target-conflicted': 5,
    'guidance-locally-modified': 6,
    'guidance-missing-block': 7,
    'guidance-unavailable': 8,
    'review-overdue': 9,
    'exact-duplicate': 10,
    'semantic-contradiction': 11,
    'candidate-contradiction': 12,
    'candidate-possible-duplicate': 13,
    'guidance-stale-sources': 14,
    'citation-unknown': 15,
  };
  return rank[category];
}

function compareRecords(left: MemoryRecord, right: MemoryRecord): number {
  return compareText(left.uri, right.uri);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

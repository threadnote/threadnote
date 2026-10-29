import {Array as EffectArray, Schema} from 'effect';
import * as EffectRecord from 'effect/Record';
import {assertMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {ContextMaintenanceSnapshotDiagnosticV1} from '@threadnote/context/health_maintenance';
import type {
  ContextMaintenanceCaseV2,
  ContextMaintenanceReceiptV2,
  MaintenanceState,
  UndoJournal,
  WorkCheckpoint,
} from './maintenance_contracts.js';
import type {
  LegacyMaintenanceSemanticProgress,
  MaintenanceSemanticProgress,
  MaintenanceWorkSchedule,
} from './maintenance_decisions.js';
import type {ContextMaintenanceInventoryPreparationV2} from './maintenance_inventory.js';
import type {MemoryRelation} from '@threadnote/memory/document';
import type {ContextHealthRepairProposalV1} from './health_repair.js';
import {CONTEXT_HEALTH_FINDING_CATEGORIES, CONTEXT_HEALTH_MEMORY_KINDS} from './health_selector.js';
import {validTopicMaintenanceCheckpoints} from './maintenance_topic.js';
const all = <Value>(values: readonly Value[], predicate: (value: Value) => boolean): boolean =>
  EffectArray.every(values, predicate);
const any = <Value>(values: readonly Value[], predicate: (value: Value) => boolean): boolean =>
  EffectArray.some(values, predicate);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !EffectArray.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const oneOf = (value: unknown, values: readonly string[]): boolean =>
  typeof value === 'string' && any(values, item => item === value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && all(EffectRecord.values(value), isString);
const isNumberRecord = (value: unknown): value is Record<string, number> =>
  isRecord(value) && all(EffectRecord.values(value), isNumber);
const optional = (record: Record<string, unknown>, key: string, guard: (value: unknown) => boolean): boolean =>
  !(key in record) || record[key] === undefined || guard(record[key]);
const strings = (value: unknown): value is string[] => EffectArray.isArray(value) && all(value, isString);
const isRelation = (value: unknown): value is MemoryRelation =>
  isRecord(value) &&
  oneOf(value.type, ['depends_on', 'evidence_for', 'references', 'related_to', 'supersedes']) &&
  isString(value.uri);
const isRelationArray = (value: unknown): value is MemoryRelation[] =>
  EffectArray.isArray(value) && all(value, isRelation);
const isResourceObservation = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.uri) &&
  optional(value, 'sourceHash', isString) &&
  optional(value, 'memoryId', isString) &&
  optional(value, 'status', isString);
function isMaintenanceCase(value: unknown): value is ContextMaintenanceCaseV2 {
  if (!isRecord(value)) return false;
  if (
    !all(
      [
        'caseId',
        'project',
        'memoryId',
        'family',
        'slot',
        'evidenceRevision',
        'disposition',
        'reason',
        'firstSeen',
        'lastSeen',
        'lastChecked',
        'attemptCount',
        'events',
      ],
      key => key in value,
    ) ||
    !all(
      [
        'caseId',
        'project',
        'memoryId',
        'family',
        'slot',
        'evidenceRevision',
        'reason',
        'firstSeen',
        'lastSeen',
        'lastChecked',
      ],
      key => isString(value[key]),
    ) ||
    !oneOf(value.disposition, [
      'queued',
      'repairing',
      'waiting-evidence',
      'needs-decision',
      'resolved',
      'retired',
      'historical',
      'deferred-policy',
    ]) ||
    !isNonNegativeInteger(value.attemptCount) ||
    !EffectArray.isArray(value.events) ||
    !all(value.events, event => isRecord(event) && isString(event.at) && isString(event.reason))
  )
    return false;
  if (
    !optional(value, 'nextAttemptAt', isString) ||
    !optional(value, 'citationId', isString) ||
    !optional(value, 'subjectUri', isString) ||
    !optional(value, 'archivedUri', isString) ||
    !optional(value, 'causeKey', isString) ||
    !optional(value, 'repositoryId', isString) ||
    !optional(value, 'omittedSubjects', isNonNegativeInteger) ||
    !optional(value, 'omittedSources', isNonNegativeInteger)
  )
    return false;
  if (
    value.wake !== undefined &&
    (!isRecord(value.wake) || value.wake.kind !== 'evidence-generation' || !isString(value.wake.revision))
  )
    return false;
  if (
    value.anchorEvidence !== undefined &&
    (!isRecord(value.anchorEvidence) ||
      !isString(value.anchorEvidence.status) ||
      !isString(value.anchorEvidence.coverage) ||
      !optional(value.anchorEvidence, 'provenance', isString))
  )
    return false;
  const retirement = value.retirement;
  if (
    retirement !== undefined &&
    (!isRecord(retirement) ||
      !all(['citationId', 'anchorSlot', 'evidenceRevision', 'expectedContentHash', 'retiredAt', 'reason'], key =>
        isString(retirement[key]),
      ) ||
      !optional(retirement, 'provenance', item => item === 'historical-verified' || item === 'unverified') ||
      !optional(retirement, 'evidenceGeneration', isString) ||
      !optional(retirement, 'attemptedSteps', strings))
  )
    return false;
  if (
    value.subjectContentHashes !== undefined &&
    (!EffectArray.isArray(value.subjectContentHashes) ||
      !all(value.subjectContentHashes, item => isRecord(item) && isString(item.uri) && isString(item.hash)))
  )
    return false;
  if (
    value.relationEvidence !== undefined &&
    (!isRecord(value.relationEvidence) ||
      value.relationEvidence.completeness !== 'selected-only' ||
      value.relationEvidence.provenance !== 'bounded-selected-resource-read' ||
      !isResourceObservation(value.relationEvidence.subject) ||
      !EffectArray.isArray(value.relationEvidence.observations) ||
      !all(value.relationEvidence.observations, isResourceObservation))
  )
    return false;
  if (
    value.candidateReview !== undefined &&
    (!isRecord(value.candidateReview) ||
      !isString(value.candidateReview.reviewId) ||
      !isNonNegativeInteger(value.candidateReview.revision) ||
      !isString(value.candidateReview.candidateRevision))
  )
    return false;
  const sourceSnapshot = value.sourceSnapshot;
  if (
    sourceSnapshot !== undefined &&
    (!isRecord(sourceSnapshot) || !all(['cwd', 'generation', 'revision'], key => isString(sourceSnapshot[key])))
  )
    return false;
  if (
    value.sourceSnapshots !== undefined &&
    (!EffectArray.isArray(value.sourceSnapshots) ||
      !all(
        value.sourceSnapshots,
        item => isRecord(item) && all(['uri', 'cwd', 'generation', 'revision'], key => isString(item[key])),
      ))
  )
    return false;
  return true;
}
function isReceipt(value: unknown): value is ContextMaintenanceReceiptV2 {
  return (
    isRecord(value) &&
    all(['receiptId', 'project', 'subjectUri', 'postHash', 'timestamp'], key => isString(value[key])) &&
    oneOf(value.state, ['applying', 'applied', 'undone', 'conflict']) &&
    optional(value, 'archivedUri', isString)
  );
}
function isCheckpoint(value: unknown): value is WorkCheckpoint {
  return (
    isRecord(value) &&
    isString(value.revision) &&
    isString(value.checkedAt) &&
    optional(value, 'citationAdmissionVersion', isNumber) &&
    optional(value, 'retryAt', isString) &&
    optional(value, 'checkedCitations', isNumber) &&
    optional(value, 'attemptedCitations', isNumber) &&
    optional(value, 'memoryHash', isString) &&
    optional(value, 'sourceEpoch', isString) &&
    optional(value, 'sourceRevision', isString) &&
    optional(value, 'inventoryComplete', value => typeof value === 'boolean')
  );
}
function isLegacyMaintenanceSemanticProgress(value: unknown): value is LegacyMaintenanceSemanticProgress {
  return (
    isRecord(value) &&
    value.version === undefined &&
    isString(value.generation) &&
    isNonNegativeInteger(value.cursor) &&
    isNonNegativeInteger(value.totalBatches) &&
    isNonNegativeInteger(value.eligibleRecords) &&
    typeof value.partial === 'boolean'
  );
}
function isCurrentMaintenanceSemanticProgress(value: unknown): value is MaintenanceSemanticProgress {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !isNumber(value.analyzerVersion) ||
    !isString(value.generation) ||
    !isNonNegativeInteger(value.cursor) ||
    !isNonNegativeInteger(value.totalBatches) ||
    !isNonNegativeInteger(value.eligibleRecords) ||
    !isNonNegativeInteger(value.comparedClaimPairs) ||
    !isNonNegativeInteger(value.churnCount) ||
    !isNonNegativeInteger(value.outputOmittedFindings) ||
    !EffectArray.isArray(value.records) ||
    !EffectArray.isArray(value.dirty) ||
    !isRecord(value.comparison)
  )
    return false;
  if (
    !all(
      value.records,
      item =>
        isRecord(item) &&
        isString(item.uri) &&
        isString(item.hash) &&
        optional(item, 'removed', value => typeof value === 'boolean') &&
        optional(item, 'claims', isNonNegativeInteger) &&
        optional(item, 'unsupportedClaims', isNonNegativeInteger) &&
        optional(
          item,
          'reasons',
          reasons =>
            EffectArray.isArray(reasons) &&
            all(reasons, reason =>
              oneOf(reason, [
                'body-limit',
                'claim-budget',
                'claim-limit',
                'claim-too-large',
                'contradiction-limit',
                'no-claims',
                'record-limit',
                'unsupported-extraction',
              ]),
            ),
        ),
    )
  )
    return false;
  const comparison = value.comparison;
  if (
    !isNonNegativeInteger(comparison.pairCursor) ||
    !isNonNegativeInteger(comparison.claimCursor) ||
    !strings(comparison.seenCaseIds) ||
    !optional(comparison, 'seenOverflow', item => typeof item === 'boolean')
  )
    return false;
  if (
    !all(
      value.dirty,
      item =>
        isRecord(item) &&
        isString(item.uri) &&
        isNonNegativeInteger(item.otherCursor) &&
        isNonNegativeInteger(item.claimCursor) &&
        strings(item.seenCaseIds) &&
        optional(item, 'seenOverflow', flag => typeof flag === 'boolean'),
    )
  )
    return false;
  if (!optional(value, 'omissionPairsOverflow', item => typeof item === 'boolean')) return false;
  return (
    value.omissionPairs === undefined ||
    (EffectArray.isArray(value.omissionPairs) &&
      all(
        value.omissionPairs,
        item =>
          isRecord(item) &&
          all(['key', 'leftUri', 'leftHash', 'rightUri', 'rightHash'], key => isString(item[key])) &&
          isNonNegativeInteger(item.count),
      ))
  );
}
function isMaintenanceSemanticProgress(
  value: unknown,
): value is MaintenanceSemanticProgress | LegacyMaintenanceSemanticProgress {
  return isLegacyMaintenanceSemanticProgress(value) || isCurrentMaintenanceSemanticProgress(value);
}
function isWorkSchedule(value: unknown): value is MaintenanceWorkSchedule {
  if (!isRecord(value) || !oneOf(value.nextPhase, ['records', 'semantic', 'requested', 'topic'])) return false;
  if (
    !optional(value, 'lastSemanticProject', isString) ||
    !optional(value, 'lastRequestedRoot', isString) ||
    !optional(value, 'lastTopicMemoryId', isString)
  )
    return false;
  const discovery = value.requestDiscovery;
  return (
    discovery === undefined ||
    (isRecord(discovery) &&
      isString(discovery.namesHash) &&
      isNonNegativeInteger(discovery.scanned) &&
      typeof discovery.scopedPending === 'boolean' &&
      optional(discovery, 'scope', isString) &&
      optional(discovery, 'lastFile', isString))
  );
}
function isRepairProposal(value: unknown): value is ContextHealthRepairProposalV1 {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isString(value.findingId) ||
    !isString(value.project) ||
    !isString(value.proposalId) ||
    !isString(value.revision) ||
    !isString(value.summary) ||
    !oneOf(value.category, CONTEXT_HEALTH_FINDING_CATEGORIES) ||
    !EffectArray.isArray(value.preconditions)
  )
    return false;
  if (
    !all(
      value.preconditions,
      item =>
        isRecord(item) && isString(item.expectedContentHash) && isString(item.expectedProject) && isString(item.uri),
    )
  )
    return false;
  if (
    value.selector !== undefined &&
    (!isRecord(value.selector) ||
      !optional(value.selector, 'after', isString) ||
      !optional(value.selector, 'findingCategory', item => oneOf(item, CONTEXT_HEALTH_FINDING_CATEGORIES)) ||
      !optional(value.selector, 'kind', item => oneOf(item, CONTEXT_HEALTH_MEMORY_KINDS)) ||
      !optional(value.selector, 'topic', isString))
  )
    return false;
  const mutation = value.mutation;
  if (!isRecord(mutation)) return false;
  if (mutation.kind === 'archive-memory')
    return isString(mutation.subjectUri) && optional(mutation, 'survivorUri', isString);
  if (mutation.kind === 'remove-relations') {
    const target = mutation.targetPrecondition;
    return (
      isString(mutation.subjectUri) &&
      isString(mutation.targetUri) &&
      isString(mutation.expectedResultContentHash) &&
      isRecord(target) &&
      (target.state === 'absent' || (target.state === 'inactive' && isString(target.expectedContentHash)))
    );
  }
  if (mutation.kind === 'replace-citation') {
    if (
      !isString(mutation.subjectUri) ||
      !isString(mutation.citationId) ||
      !isString(mutation.expectedResultContentHash)
    )
      return false;
    try {
      assertMemoryCodeCitation(mutation.replacement);
    } catch {
      return false;
    }
    return true;
  }
  if (
    mutation.kind !== 'review-only' ||
    !isString(mutation.reason) ||
    !oneOf(mutation.repairKind, [
      'archive-memory',
      'deduplicate-memory',
      'repair-guidance',
      'repair-citation',
      'repair-relation',
      'review-candidate',
      'review-memory',
    ]) ||
    !optional(mutation, 'subjectUri', isString) ||
    !optional(mutation, 'targetUri', isString)
  )
    return false;
  if (mutation.suggestedMutation === undefined) return true;
  const direction = mutation.suggestedMutation;
  const designation = isRecord(direction) ? direction.designation : undefined;
  return (
    isRecord(direction) &&
    direction.kind === 'supersede-memory' &&
    direction.status === 'superseded' &&
    all(['archivedFrom', 'preservedMemoryId', 'subjectUri', 'supersededByMemoryId', 'supersededByUri'], key =>
      isString(direction[key]),
    ) &&
    isRecord(designation) &&
    designation.type === 'context-health-semantic-direction' &&
    designation.version === 1 &&
    all(['contradictionId', 'currentUri', 'reportRevision', 'staleUri'], key => isString(designation[key]))
  );
}
export function isUndoJournal(value: unknown): value is UndoJournal {
  if (
    !isRecord(value) ||
    !isReceipt(value) ||
    !isString(value.before) ||
    !isString(value.after) ||
    !isRelationArray(value.removed)
  )
    return false;
  if (value.archiveProposal !== undefined && !isRepairProposal(value.archiveProposal)) return false;
  if (!optional(value, 'archiveCallerCwd', isString)) return false;
  if (
    value.relationChanges !== undefined &&
    (!EffectArray.isArray(value.relationChanges) ||
      !all(
        value.relationChanges,
        change =>
          isRecord(change) &&
          isRelation(change.relation) &&
          optional(change, 'targetHash', isString) &&
          optional(change, 'successorHash', isString) &&
          optional(change, 'lineageHashes', strings),
      ))
  )
    return false;
  return true;
}
const isInventoryPreparation = (value: unknown): value is ContextMaintenanceInventoryPreparationV2 =>
  isRecord(value) &&
  typeof value.complete === 'boolean' &&
  isNonNegativeInteger(value.admittedRecords) &&
  optional(value, 'omittedRecords', isNonNegativeInteger) &&
  optional(
    value,
    'diagnostics',
    items => EffectArray.isArray(items) && all(items, item => Schema.is(ContextMaintenanceSnapshotDiagnosticV1)(item)),
  ) &&
  optional(value, 'incompleteReason', item =>
    oneOf(item, [
      'inventory-records-omitted',
      'inventory-discovery-incomplete',
      'inventory-terminal-catalog-boundary',
      'inventory-terminal-byte-boundary',
      'inventory-terminal-time-boundary',
      'inventory-terminal-lock-contended',
      'inventory-terminal-generation-race',
      'inventory-terminal-membership-race',
    ]),
  );
const isSemanticCoverage = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.project) &&
  oneOf(value.state, ['partial', 'complete']) &&
  all(
    [
      'eligibleRecords',
      'checkedBatches',
      'totalBatches',
      'extractedRecords',
      'totalRecords',
      'comparedClaimPairs',
      'unsupportedRecords',
      'unsupportedClaims',
      'bodyLimitedRecords',
      'outputOmittedFindings',
      'churnCount',
      'dirtyRecordPairsRemaining',
    ],
    key => isNonNegativeInteger(value[key]),
  ) &&
  typeof value.extractionComplete === 'boolean' &&
  typeof value.comparisonComplete === 'boolean' &&
  optional(value, 'totalClaimPairs', isNonNegativeInteger);
export function isMaintenanceState(value: unknown): value is MaintenanceState {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    typeof value.paused !== 'boolean' ||
    !oneOf(value.state, ['idle', 'running', 'waiting-evidence', 'needs-decision', 'failed']) ||
    !isString(value.generation) ||
    !EffectArray.isArray(value.cases) ||
    !all(value.cases, isMaintenanceCase) ||
    !EffectArray.isArray(value.receipts) ||
    !all(value.receipts, isReceipt) ||
    !EffectArray.isArray(value.projects) ||
    !all(
      value.projects,
      project =>
        isRecord(project) &&
        isString(project.project) &&
        isString(project.generation) &&
        all(['cursor', 'eligible', 'checked', 'eligibleCitations', 'checkedCitations'], key =>
          isNonNegativeInteger(project[key]),
        ),
    ) ||
    !isRecord(value.checkpoints) ||
    !all(EffectRecord.values(value.checkpoints), isCheckpoint)
  )
    return false;
  if (
    !optional(value, 'preparation', isInventoryPreparation) ||
    !optional(value, 'semanticCoverage', list => EffectArray.isArray(list) && all(list, isSemanticCoverage)) ||
    !optional(value, 'counts', isNumberRecord) ||
    !optional(value, 'omittedCases', isNonNegativeInteger) ||
    !optional(value, 'omittedReceipts', isNonNegativeInteger) ||
    !optional(value, 'lastProgressAt', isString) ||
    !optional(value, 'lastProject', isString) ||
    !optional(value, 'lastWakeAt', isString) ||
    !optional(value, 'lastTaskByProject', isStringRecord) ||
    !optional(value, 'policyOverrides', isStringRecord) ||
    !optional(value, 'decisionCheckpoints', isStringRecord)
  )
    return false;
  if (
    value.groups !== undefined &&
    (!EffectArray.isArray(value.groups) ||
      !all(
        value.groups,
        group =>
          isRecord(group) &&
          isString(group.causeKey) &&
          isString(group.project) &&
          oneOf(group.disposition, [
            'queued',
            'repairing',
            'waiting-evidence',
            'needs-decision',
            'resolved',
            'retired',
            'historical',
            'deferred-policy',
          ]) &&
          isString(group.reason) &&
          isNonNegativeInteger(group.affectedMemories),
      ))
  )
    return false;
  if (
    value.page !== undefined &&
    (!isRecord(value.page) ||
      !isString(value.page.generation) ||
      !optional(value.page, 'caseNextCursor', isString) ||
      !optional(value.page, 'receiptNextCursor', isString))
  )
    return false;
  if (
    value.error !== undefined &&
    (!isRecord(value.error) ||
      !isString(value.error.reason) ||
      !isString(value.error.at) ||
      !optional(value.error, 'diagnostic', item => Schema.is(ContextMaintenanceSnapshotDiagnosticV1)(item)))
  )
    return false;
  if (
    value.semanticProgress !== undefined &&
    (!isRecord(value.semanticProgress) ||
      !all(EffectRecord.values(value.semanticProgress), isMaintenanceSemanticProgress))
  )
    return false;
  if (value.workSchedule !== undefined && !isWorkSchedule(value.workSchedule)) return false;
  if (!validTopicMaintenanceCheckpoints(value.topicCheckpoints)) return false;
  return true;
}

import {Array as EffectArray, Option as EffectOption} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {
  ContextHealthCaseDispositionV2,
  ContextMaintenanceSnapshotDiagnosticV1,
} from '@threadnote/context/health_maintenance';
import {CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION} from '@threadnote/context/health_semantic';
import type {
  ContextMaintenanceCaseV2,
  ContextMaintenanceStatusV2,
  ContextMaintenanceReadOptions,
  MaintenanceState,
} from './maintenance.js';
import {maintenanceSnapshotFailure} from './maintenance_snapshot.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

function maintenanceCaseSubjectKeys(item: ContextMaintenanceCaseV2): readonly string[] {
  return (item.subjectContentHashes?.length ?? 0) > 0
    ? EffectArray.map(item.subjectContentHashes!, subject => subject.uri)
    : [item.memoryId];
}

export function publicStatus(
  originalState: MaintenanceState,
  project?: string,
  options: ContextMaintenanceReadOptions = {},
): ContextMaintenanceStatusV2 {
  const state =
    project === undefined
      ? originalState
      : {
          ...originalState,
          projects: EffectArray.filter(originalState.projects, item => item.project === project),
          cases: EffectArray.filter(originalState.cases, item => item.project === project),
          receipts: EffectArray.filter(originalState.receipts, item => item.project === project),
        };
  const {
    checkpoints: _checkpoints,
    lastProject: _lastProject,
    lastTaskByProject: _lastTaskByProject,
    lastWakeAt: _lastWakeAt,
    policyOverrides: _policyOverrides,
    decisionCheckpoints: _decisionCheckpoints,
    semanticProgress: _semanticProgress,
    workSchedule: _workSchedule,
    topicCheckpoints: _topicCheckpoints,
    ...status
  } = state;
  const counts: Record<string, number> = {
    decisionMemories: new Set(
      EffectArray.flatMap(
        EffectArray.filter(state.cases, item => item.disposition === 'needs-decision'),
        maintenanceCaseSubjectKeys,
      ),
    ).size,
  };
  const groups = new Map<
    string,
    {causeKey: string; project: string; disposition: ContextHealthCaseDispositionV2; reason: string; ids: Set<string>}
  >();
  for (const item of state.cases) {
    counts[item.disposition] = (counts[item.disposition] ?? 0) + 1;
    const key = `${item.project}:${item.causeKey ?? item.family}:${item.disposition}`;
    const group = groups.get(key) ?? {
      causeKey: item.causeKey ?? item.family,
      project: item.project,
      disposition: item.disposition,
      reason: item.reason,
      ids: new Set<string>(),
    };
    for (const subject of maintenanceCaseSubjectKeys(item)) group.ids.add(subject);
    groups.set(key, group);
  }
  const generation = sha256HexSync(JSON.stringify([project, state.generation, state.cases, state.receipts]));
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100))
    throw new Error('Maintenance page limit must be an integer from 1 to 100.');
  const limit = options.limit;
  const orderedCases = [...state.cases].sort(
    (a, b) =>
      Number(b.disposition === 'needs-decision') - Number(a.disposition === 'needs-decision') ||
      Effect.pipe(a.caseId, EffectString.localeCompare(b.caseId)),
  );
  const orderedReceipts = [...state.receipts].reverse();
  const select = <T>(
    items: readonly T[],
    kind: 'case' | 'receipt',
    cursor: string | undefined,
    exact: string | undefined,
    id: (item: T) => string,
    size: number,
  ) => {
    if (cursor !== undefined && exact !== undefined) throw new Error('Choose a page cursor or an exact selector.');
    if (exact !== undefined) {
      const item = EffectOption.getOrUndefined(EffectArray.findFirst(items, item => id(item) === exact));
      if (item === undefined) throw new Error('The exact maintenance selector is unavailable in this project.');
      return {items: [item]};
    }
    let offset = 0;
    if (cursor !== undefined) {
      const match = /^maintenance-page-(case|receipt)-([0-9a-f]{64})-(\d+)$/u.exec(cursor);
      if (match?.[1] !== kind || match[2] !== generation)
        throw new Error('The maintenance page changed. Restart status pagination for this project.');
      offset = Number(match[3]);
      if (!Number.isSafeInteger(offset) || offset > items.length) throw new Error('Invalid maintenance page offset.');
    }
    const selected = items.slice(offset, offset + size);
    return {
      items: selected,
      next:
        offset + selected.length < items.length
          ? `maintenance-page-${kind}-${generation}-${offset + selected.length}`
          : undefined,
    };
  };
  const casePage = select(orderedCases, 'case', options.caseCursor, options.caseId, item => item.caseId, limit ?? 30);
  const receiptPage = select(
    orderedReceipts,
    'receipt',
    options.receiptCursor,
    options.receiptId,
    item => item.receiptId,
    limit ?? 10,
  );
  const cases = EffectArray.map(casePage.items, item => ({
    ...item,
    events: options.caseId === undefined ? item.events.slice(-2) : item.events,
    ...(options.caseId === undefined
      ? {
          subjectContentHashes: item.subjectContentHashes?.slice(0, 8),
          sourceSnapshots: item.sourceSnapshots?.slice(0, 4),
          omittedSubjects: Math.max(0, (item.subjectContentHashes?.length ?? 0) - 8),
          omittedSources: Math.max(0, (item.sourceSnapshots?.length ?? 0) - 4),
        }
      : {}),
  }));
  return {
    ...status,
    semanticCoverage: EffectArray.map(
      EffectArray.filter(
        EffectRecord.toEntries(state.semanticProgress ?? {}),
        ([name]) => project === undefined || name === project,
      ),
      ([name, progress]) => {
        if (progress.version !== 2 || progress.analyzerVersion !== CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION)
          return {
            project: name,
            state: 'partial' as const,
            eligibleRecords: progress.eligibleRecords,
            checkedBatches: 0,
            totalBatches: progress.totalBatches,
            extractedRecords: 0,
            totalRecords: progress.eligibleRecords,
            extractionComplete: false,
            comparisonComplete: false,
            comparedClaimPairs: 0,
            unsupportedRecords: 0,
            unsupportedClaims: 0,
            bodyLimitedRecords: 0,
            outputOmittedFindings: 0,
            churnCount: 0,
            dirtyRecordPairsRemaining: 0,
          };
        const progressRecords = progress.records;
        const records = progressRecords
          ? EffectArray.filter(progressRecords, (record, index) => index in progressRecords && !record.removed)
          : [];
        const extracted = EffectArray.filter(records, record => record.claims !== undefined);
        const unsupported = EffectArray.filter(extracted, record => (record.reasons?.length ?? 0) > 0);
        const allClaims = EffectArray.reduce(extracted, 0, (sum, record) => sum + (record.claims ?? 0));
        const sameRecordPairs = EffectArray.reduce(extracted, 0, (sum, record) => sum + (record.claims ?? 0) ** 2);
        const totalClaimPairs =
          extracted.length === records.length ? (allClaims ** 2 - sameRecordPairs) / 2 : undefined;
        const dirtyRecordPairsRemaining =
          EffectArray.reduce(progress.dirty, 0, (sum, entry) => {
            const ownIndex = EffectOption.getOrElse(
              EffectArray.findFirstIndex(progress.records, record => record.uri === entry.uri),
              () => -1,
            );
            return (
              sum + Math.max(0, progress.records.length - entry.otherCursor - Number(ownIndex >= entry.otherCursor))
            );
          }) ?? 0;
        const comparisonFinished =
          progress.comparison?.pairCursor >=
            Math.max(0, (progress.records.length * (progress.records.length - 1)) / 2) &&
          (progress.dirty?.length ?? 0) === 0;
        const extractionComplete = extracted.length === records.length;
        return {
          project: name,
          state:
            comparisonFinished && extractionComplete && unsupported.length === 0 && progress.outputOmittedFindings === 0
              ? ('complete' as const)
              : ('partial' as const),
          eligibleRecords: progress.eligibleRecords,
          checkedBatches: progress.records.length <= 1 ? Number(extractionComplete) : progress.comparison.pairCursor,
          totalBatches: progress.totalBatches,
          extractedRecords: extracted.length,
          totalRecords: records.length,
          extractionComplete,
          comparisonComplete: comparisonFinished,
          comparedClaimPairs: progress.comparedClaimPairs ?? 0,
          ...(totalClaimPairs === undefined ? {} : {totalClaimPairs}),
          unsupportedRecords: unsupported.length,
          unsupportedClaims: EffectArray.reduce(extracted, 0, (sum, record) => sum + (record.unsupportedClaims ?? 0)),
          bodyLimitedRecords: EffectArray.filter(extracted, record => Boolean(record.reasons?.includes('body-limit')))
            .length,
          outputOmittedFindings: progress.outputOmittedFindings ?? 0,
          churnCount: progress.churnCount ?? 0,
          dirtyRecordPairsRemaining,
        };
      },
    ),
    cases,
    receipts: receiptPage.items,
    omittedReceipts: state.receipts.length - receiptPage.items.length,
    page: {generation, caseNextCursor: casePage.next, receiptNextCursor: receiptPage.next},
    counts,
    groups: EffectArray.map([...groups.values()].slice(0, 100), ({ids, ...group}) => ({
      ...group,
      affectedMemories: ids.size,
    })),
    omittedCases: state.cases.length - cases.length,
  };
}

function renderSnapshotDiagnostic(diagnostic: ContextMaintenanceSnapshotDiagnosticV1): readonly string[] {
  return [
    diagnostic.summary,
    `Category: ${diagnostic.category}`,
    `Stage: ${diagnostic.stage}`,
    ...(diagnostic.memoryUri === undefined ? [] : [`Memory: ${diagnostic.memoryUri}`]),
    diagnostic.recovery,
  ];
}

export function renderContextMaintenanceStatus(status: ContextMaintenanceStatusV2): string {
  const counts = status.counts ?? {};
  const diagnostics = [
    ...new Map(
      EffectArray.map(
        [...(status.error?.diagnostic ? [status.error.diagnostic] : []), ...(status.preparation?.diagnostics ?? [])],
        diagnostic => {
          const safe = maintenanceSnapshotFailure(
            diagnostic.category,
            diagnostic.stage,
            diagnostic.memoryUri,
          ).diagnostic;
          return [JSON.stringify([safe.category, safe.stage, safe.memoryUri]), safe];
        },
      ),
    ).values(),
  ];
  return EffectArray.join(
    [
      `Context maintenance: ${status.paused ? 'paused' : status.state}`,
      ...(status.preparation?.complete === false
        ? [
            `Preparation: partial; ${status.preparation.admittedRecords} records indexed so far; ${status.preparation.omittedRecords ?? 0} records omitted.`,
          ]
        : []),
      `Decisions: ${counts.decisionMemories ?? 0}; waiting evidence: ${counts['waiting-evidence'] ?? 0}; completed: ${(counts.resolved ?? 0) + (counts.retired ?? 0)}.`,
      ...EffectArray.map(
        status.projects,
        item =>
          `${item.project}: ${item.checked}/${item.eligible} tasks checked; ${item.checkedCitations}/${item.eligibleCitations} citations verified.`,
      ),
      ...EffectArray.map(
        (status.groups ?? []).slice(0, 12),
        group => `${group.project}: ${group.reason} (${group.affectedMemories} memories)`,
      ),
      ...(status.error === undefined ? [] : [`Maintenance error: ${status.error.reason}`]),
      ...EffectArray.flatMap(diagnostics.slice(0, 8), renderSnapshotDiagnostic),
      ...(diagnostics.length > 8 ? [`Diagnostics: ${diagnostics.length - 8} additional diagnostics omitted.`] : []),
    ],
    '\n',
  );
}

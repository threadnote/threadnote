import {sha256HexSync} from '@threadnote/platform/sha256';
import type {ContextHealthCaseDispositionV2} from '@threadnote/context/health_maintenance';
import type {
  ContextMaintenanceCaseV2,
  ContextMaintenanceStatusV2,
  ContextMaintenanceReadOptions,
  MaintenanceState,
} from './maintenance.js';

function maintenanceCaseSubjectKeys(item: ContextMaintenanceCaseV2): readonly string[] {
  return (item.subjectContentHashes?.length ?? 0) > 0
    ? item.subjectContentHashes!.map(subject => subject.uri)
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
          projects: originalState.projects.filter(item => item.project === project),
          cases: originalState.cases.filter(item => item.project === project),
          receipts: originalState.receipts.filter(item => item.project === project),
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
    ...status
  } = state;
  const counts: Record<string, number> = {
    decisionMemories: new Set(
      state.cases.filter(item => item.disposition === 'needs-decision').flatMap(maintenanceCaseSubjectKeys),
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
      a.caseId.localeCompare(b.caseId),
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
      const item = items.find(item => id(item) === exact);
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
  const cases = casePage.items.map(item => ({
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
    semanticCoverage: Object.entries(state.semanticProgress ?? {})
      .filter(([name]) => project === undefined || name === project)
      .map(([name, progress]) => ({
        project: name,
        state:
          progress.cursor >= progress.totalBatches && !progress.partial ? ('complete' as const) : ('partial' as const),
        eligibleRecords: progress.eligibleRecords,
        checkedBatches: progress.cursor,
        totalBatches: progress.totalBatches,
      })),
    cases,
    receipts: receiptPage.items,
    omittedReceipts: state.receipts.length - receiptPage.items.length,
    page: {generation, caseNextCursor: casePage.next, receiptNextCursor: receiptPage.next},
    counts,
    groups: [...groups.values()].slice(0, 100).map(({ids, ...group}) => ({...group, affectedMemories: ids.size})),
    omittedCases: state.cases.length - cases.length,
  };
}

export function renderContextMaintenanceStatus(status: ContextMaintenanceStatusV2): string {
  const counts = status.counts ?? {};
  return [
    `Context maintenance: ${status.paused ? 'paused' : status.state}`,
    ...(status.preparation?.complete === false
      ? [`Preparation: partial; ${status.preparation.admittedRecords} records indexed so far.`]
      : []),
    `Decisions: ${counts.decisionMemories ?? 0}; waiting evidence: ${counts['waiting-evidence'] ?? 0}; completed: ${(counts.resolved ?? 0) + (counts.retired ?? 0)}.`,
    ...status.projects.map(
      item =>
        `${item.project}: ${item.checked}/${item.eligible} tasks checked; ${item.checkedCitations}/${item.eligibleCitations} citations verified.`,
    ),
    ...(status.groups ?? [])
      .slice(0, 12)
      .map(group => `${group.project}: ${group.reason} (${group.affectedMemories} memories)`),
    ...(status.error === undefined ? [] : [`Maintenance error: ${status.error.reason}`]),
    ...(status.error?.diagnostic === undefined
      ? []
      : [
          status.error.diagnostic.summary,
          `Stage: ${status.error.diagnostic.stage}`,
          ...(status.error.diagnostic.memoryUri === undefined ? [] : [`Memory: ${status.error.diagnostic.memoryUri}`]),
          status.error.diagnostic.recovery,
        ]),
  ].join('\n');
}

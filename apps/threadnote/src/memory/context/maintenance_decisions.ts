import {Effect} from 'effect';
import {buildContextHealthReport} from '@threadnote/context/health';
import {listCandidateReviews} from '@threadnote/memory/candidate';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '@threadnote/memory/document';
import {contextHealthFindingCaseIdentityV2} from '@threadnote/context/health_maintenance';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readMemoryRecordsByUri} from '../../mcp/server/memory.js';
import {upsertCase} from './maintenance_policy.js';
import {
  advanceContextMaintenanceEvidenceRequestExecution,
  pendingContextMaintenanceEvidenceRoots,
  type ContextMaintenanceEvidenceRequestDiscovery,
  type ContextMaintenanceEvidenceRequestPage,
} from './maintenance_evidence.js';
import type {ContextMaintenanceCaseV2, MaintenanceState} from './maintenance.js';

export const readMaintenanceCandidateDecisions = Effect.fn('contextMaintenance.candidateDecisions')(function* (
  config: RuntimeConfig,
  project?: string,
) {
  const reviews = yield* listCandidateReviews(config.agentContextHome);
  return reviews
    .filter(review => project === undefined || review.project === project)
    .flatMap(review =>
      review.candidates
        .filter(
          candidate =>
            ['pending', 'deferred', 'applying'].includes(candidate.state) &&
            ['contradiction', 'possible_duplicate'].includes(candidate.comparison),
        )
        .map(candidate => ({
          review,
          candidate,
          revision: sha256HexSync(JSON.stringify([review.reviewId, review.revision, candidate])),
        })),
    );
});

export const readMaintenanceSemanticRecords = Effect.fn('contextMaintenance.semanticSubjects')(function* (
  config: RuntimeConfig,
  project: string,
  inventory: readonly MemoryRecord[],
  cursor = 0,
) {
  const eligible = inventory
    .filter(
      record =>
        record.metadata.status === 'active' &&
        record.metadata.kind === 'durable' &&
        (record.metadata.project ?? 'unscoped') === project,
    )
    .sort((left, right) => left.uri.localeCompare(right.uri));
  const admission = selectMaintenanceSemanticPairBatch(eligible, cursor);
  const selected = admission.records;
  const records = yield* readMemoryRecordsByUri(
    config,
    selected.map(record => record.uri),
  );
  return {...admission, records, eligibleRecords: eligible.length};
});

export function selectMaintenanceSemanticPairBatch<A>(records: readonly A[], cursor: number) {
  const blocks = Math.max(1, Math.ceil(records.length / 64));
  const pairs = Array.from({length: blocks}, (_, left) =>
    Array.from({length: blocks - left}, (_, offset) => [left, left + offset] as const),
  ).flat();
  const [left, right] = pairs[cursor % pairs.length];
  return {
    records: [
      ...new Set([...records.slice(left * 64, (left + 1) * 64), ...records.slice(right * 64, (right + 1) * 64)]),
    ],
    totalBatches: maintenanceSemanticWindowCount(records.length),
  };
}

export function maintenanceSemanticWindowCount(records: number): number {
  const blocks = Math.max(1, Math.ceil(records / 64));
  return (blocks * (blocks + 1)) / 2;
}

export function prepareMaintenanceSemanticProgress(
  active: readonly MemoryRecord[],
  hashes: ReadonlyMap<string, string>,
  previous: MaintenanceState['semanticProgress'],
  projectScope?: string,
) {
  const projects = [
    ...new Set(
      active
        .filter(record => record.metadata.kind === 'durable')
        .filter(record => projectScope === undefined || record.metadata.project === projectScope)
        .map(record => record.metadata.project!),
    ),
  ].sort();
  const generations = new Map(
    projects.map(project => [
      project,
      sha256HexSync(
        active
          .filter(record => record.metadata.project === project)
          .map(record => `${record.uri}:${hashes.get(record.uri)}`)
          .join('|'),
      ),
    ]),
  );
  const progress = Object.fromEntries(
    Object.entries(previous ?? {}).filter(
      ([project]) => (projectScope !== undefined && project !== projectScope) || projects.includes(project),
    ),
  );
  for (const project of projects) {
    const generation = generations.get(project)!;
    if (progress[project]?.generation === generation) continue;
    const eligibleRecords = active.filter(
      record => record.metadata.kind === 'durable' && record.metadata.project === project,
    ).length;
    progress[project] = {
      generation,
      cursor: 0,
      totalBatches: maintenanceSemanticWindowCount(eligibleRecords),
      eligibleRecords,
      partial: false,
    };
  }
  const pending = projects.filter(project => progress[project].cursor < progress[project].totalBatches);
  return {projects, generations, progress, pending};
}

export interface MaintenanceWorkSchedule {
  readonly nextPhase: 'records' | 'semantic' | 'requested';
  readonly lastSemanticProject?: string;
  readonly lastRequestedRoot?: string;
  readonly requestDiscovery?: ContextMaintenanceEvidenceRequestDiscovery;
}

export function selectMaintenanceWorkPhase(
  previous: MaintenanceWorkSchedule | undefined,
  pendingSemanticProjects: readonly string[],
  hasRecordTasks: boolean,
  pendingRequestedRoots: readonly string[] = [],
): {
  readonly phase: 'records' | 'semantic' | 'requested';
  readonly project?: string;
  readonly root?: string;
  readonly next: MaintenanceWorkSchedule;
} {
  const projects = [...new Set(pendingSemanticProjects)].sort();
  const roots = [...new Set(pendingRequestedRoots)];
  const order = ['records', 'semantic', 'requested'] as const;
  const start = Math.max(0, order.indexOf(previous?.nextPhase ?? 'records'));
  const phase =
    [...order.slice(start), ...order.slice(0, start)].find(
      item =>
        (item === 'records' && hasRecordTasks) ||
        (item === 'semantic' && projects.length > 0) ||
        (item === 'requested' && roots.length > 0),
    ) ?? 'records';
  const nextPhase = order[(order.indexOf(phase) + 1) % order.length];
  if (phase === 'records') return {phase, next: {...previous, nextPhase}};
  if (phase === 'semantic') {
    const index = previous?.lastSemanticProject === undefined ? -1 : projects.indexOf(previous.lastSemanticProject);
    const project = projects[(index + 1) % projects.length];
    return {phase, project, next: {...previous, nextPhase, lastSemanticProject: project}};
  }
  const index = previous?.lastRequestedRoot === undefined ? -1 : roots.indexOf(previous.lastRequestedRoot);
  const root = roots[(index + 1) % roots.length];
  return {phase, root, next: {...previous, nextPhase, lastRequestedRoot: root}};
}
export const selectMaintenanceWorkAndRequestCursor = Effect.fn('contextMaintenance.workAndRequestCursor')(function* (
  previous: MaintenanceWorkSchedule | undefined,
  semanticProjects: readonly string[],
  hasRecordTasks: boolean,
  page: ContextMaintenanceEvidenceRequestPage,
  now: number,
  scope?: string,
) {
  const roots = yield* pendingContextMaintenanceEvidenceRoots(page.requests, now, scope);
  const work = selectMaintenanceWorkPhase(previous, semanticProjects, hasRecordTasks, roots.slice(0, 1));
  const requestDiscovery = advanceContextMaintenanceEvidenceRequestExecution(
    previous?.requestDiscovery,
    page,
    scope,
    roots.length > 0,
    work.root,
  );
  return {work, requestDiscovery};
});

export const runMaintenanceSemanticWindow = Effect.fn('contextMaintenance.semanticWindow')(function* (
  config: RuntimeConfig,
  project: string,
  inventory: readonly MemoryRecord[],
  revision: string,
  cursor: number,
  wasPartial: boolean,
  cases: Map<string, ContextMaintenanceCaseV2>,
  now: string,
) {
  const batch = yield* readMaintenanceSemanticRecords(config, project, inventory, cursor);
  const subjects = batch.records;
  const semantic = buildMaintenanceSemanticReport(project, subjects, now);
  const semanticIds = new Set<string>();
  for (const finding of semantic.findings.filter(finding => finding.category === 'semantic-contradiction')) {
    const identity = contextHealthFindingCaseIdentityV2({project, finding, records: subjects});
    const item = upsertCase(
      cases,
      {...identity, evidenceRevision: revision, disposition: 'needs-decision', reason: 'opposing-canonical-claims'},
      now,
    );
    semanticIds.add(item.caseId);
    cases.set(item.caseId, {
      ...item,
      subjectContentHashes: subjects
        .filter(subject =>
          [finding.semanticEvidence?.left.recordUri, finding.semanticEvidence?.right.recordUri].includes(subject.uri),
        )
        .map(subject => ({uri: subject.uri, hash: sha256HexSync(canonicalMemoryDocumentContent(subject.content))})),
    });
  }
  for (const [id, item] of cases)
    if (
      item.project === project &&
      item.family === 'semantic-contradiction' &&
      semantic.semanticCompleteness?.state === 'complete' &&
      !semanticIds.has(id) &&
      item.subjectContentHashes?.length === 2 &&
      item.subjectContentHashes.every(subject => subjects.some(record => record.uri === subject.uri))
    )
      cases.set(id, {...item, disposition: 'resolved', reason: 'semantic-postcondition-verified', lastChecked: now});
  return {
    generation: revision,
    cursor: cursor + 1,
    totalBatches: batch.totalBatches,
    eligibleRecords: batch.eligibleRecords,
    partial: wasPartial || semantic.semanticCompleteness?.state !== 'complete',
  };
});

export function buildMaintenanceSemanticReport(project: string, records: readonly MemoryRecord[], now: string) {
  return buildContextHealthReport({
    project,
    now: new Date(now),
    records: records.map(record => ({
      ...record,
      metadata: {...record.metadata, project, relations: [], codeCitations: []},
    })),
  });
}

export function activeIncomingDependency(subject: MemoryRecord, records: readonly MemoryRecord[]): boolean {
  const identities = new Set(
    [
      subject.uri,
      subject.metadata.archivedFrom,
      subject.metadata.memoryId === undefined ? undefined : `threadnote://memory/${subject.metadata.memoryId}`,
    ].filter((uri): uri is string => uri !== undefined),
  );
  return records.some(
    record =>
      record.uri !== subject.uri &&
      record.metadata.status === 'active' &&
      (record.metadata.relations ?? []).some(
        relation => relation.type === 'depends_on' && identities.has(relation.uri),
      ),
  );
}

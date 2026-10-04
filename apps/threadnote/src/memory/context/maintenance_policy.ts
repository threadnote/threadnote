import {sha256HexSync} from '@threadnote/platform/sha256';
import {isSharedMemoryUri, type MemoryRecord, type MemoryRelation} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {
  contextHealthCaseIdV2,
  contextHealthCitationCaseSlotV2,
  resolveContextHealthRelationTargetV2,
} from '@threadnote/context/health_maintenance';
import type {ContextMaintenanceCaseV2} from './maintenance.js';

const MAX_EVENTS = 8;

export function duplicateArchiveSafe(subject: MemoryRecord, survivor: MemoryRecord | undefined): boolean {
  if (
    survivor === undefined ||
    survivor.uri === subject.uri ||
    isSharedMemoryUri(survivor.uri) ||
    subject.body.trim() !== survivor.body.trim()
  )
    return false;
  if (subject.metadata.memoryId === undefined || survivor.metadata.memoryId === undefined) return false;
  const relations = new Set((survivor.metadata.relations ?? []).map(item => `${item.type}:${item.uri}`));
  const citations = new Set((survivor.metadata.codeCitations ?? []).map(item => item.id));
  return (
    (subject.metadata.relations ?? []).every(item => relations.has(`${item.type}:${item.uri}`)) &&
    (subject.metadata.codeCitations ?? []).every(item => citations.has(item.id))
  );
}

export function maintenanceCheckpointCurrent(
  check: {readonly memoryHash?: string; readonly sourceEpoch?: string; readonly retryAt?: string} | undefined,
  hash: string | undefined,
  epoch: string | undefined,
  now: string,
) {
  return (
    hash !== undefined &&
    check?.memoryHash === hash &&
    (check.sourceEpoch === undefined || epoch === undefined || check.sourceEpoch === epoch) &&
    (check.retryAt === undefined || check.retryAt > now)
  );
}

export function selectFairMaintenanceWork<T extends {readonly project: string}>(
  items: readonly T[],
  lastProject: string | undefined,
  limit: number,
): readonly T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.project);
    if (group === undefined) groups.set(item.project, [item]);
    else group.push(item);
  }
  const projects = [...groups.keys()].sort();
  const start = lastProject === undefined ? 0 : (projects.indexOf(lastProject) + 1) % Math.max(1, projects.length);
  const ordered = [...projects.slice(start), ...projects.slice(0, start)];
  const result: T[] = [];
  for (let round = 0; result.length < limit; round++) {
    let added = false;
    for (const project of ordered) {
      const item = groups.get(project)?.[round];
      if (item === undefined) continue;
      result.push(item);
      added = true;
      if (result.length >= limit) break;
    }
    if (!added) break;
  }
  return result;
}

export function updateMaintenanceCase(
  previous: ContextMaintenanceCaseV2 | undefined,
  input: Pick<
    ContextMaintenanceCaseV2,
    'project' | 'memoryId' | 'family' | 'slot' | 'evidenceRevision' | 'disposition' | 'reason'
  > &
    Pick<ContextMaintenanceCaseV2, 'citationId' | 'anchorEvidence'>,
  now: string,
): ContextMaintenanceCaseV2 {
  const unchanged = previous?.evidenceRevision === input.evidenceRevision;
  const attemptCount = unchanged ? (previous?.attemptCount ?? 0) + 1 : 1;
  const waiting = input.disposition === 'waiting-evidence';
  const timedRetry = waiting && input.reason !== 'repository-ambiguous' && attemptCount < 3;
  return {
    ...input,
    subjectUri: previous?.subjectUri,
    archivedUri: previous?.archivedUri,
    nextAttemptAt: undefined,
    wake: undefined,
    caseId: contextHealthCaseIdV2(input),
    firstSeen: previous?.firstSeen ?? now,
    lastSeen: now,
    lastChecked: now,
    attemptCount,
    ...(timedRetry
      ? {
          nextAttemptAt: new Date(
            Date.parse(now) + Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.min(attemptCount, 10)),
          ).toISOString(),
        }
      : waiting
        ? {wake: {kind: 'evidence-generation' as const, revision: input.evidenceRevision}}
        : {}),
    events: [...(previous?.events ?? []), {at: now, reason: input.reason}].slice(-MAX_EVENTS),
  };
}

export function mergeMaintenanceCaseLineage(
  left: ContextMaintenanceCaseV2,
  right: ContextMaintenanceCaseV2,
): ContextMaintenanceCaseV2 {
  const latest = left.lastChecked > right.lastChecked ? left : right;
  return {
    ...latest,
    firstSeen: [left.firstSeen, right.firstSeen].sort()[0],
    lastSeen: [left.lastSeen, right.lastSeen].sort().at(-1)!,
    attemptCount:
      left.evidenceRevision === right.evidenceRevision
        ? Math.max(left.attemptCount, right.attemptCount)
        : latest.attemptCount,
    events: [
      ...new Map([...left.events, ...right.events].map(event => [`${event.at}:${event.reason}`, event])).values(),
    ]
      .sort((a, b) => a.at.localeCompare(b.at) || a.reason.localeCompare(b.reason))
      .slice(-MAX_EVENTS),
  };
}

export function reconcileRepositoryRecoveryCases(cases: Map<string, ContextMaintenanceCaseV2>, now: string): void {
  const groups = new Map<string, ContextMaintenanceCaseV2[]>();
  for (const item of cases.values())
    if (
      item.family === 'citation' &&
      item.reason === 'repository-ambiguous' &&
      item.disposition === 'waiting-evidence' &&
      item.repositoryId !== undefined
    ) {
      const key = `${item.project}:${item.repositoryId}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
  const current = new Set<string>();
  for (const anchors of groups.values()) {
    const identity = {
      project: anchors[0].project,
      memoryId: anchors[0].repositoryId!,
      family: 'repository-recovery',
      slot: 'repository',
    };
    const revision = sha256HexSync(JSON.stringify(anchors.map(item => [item.caseId, item.evidenceRevision]).sort()));
    const previous = cases.get(contextHealthCaseIdV2(identity));
    const item =
      previous?.evidenceRevision === revision
        ? previous
        : upsertCase(
            cases,
            {
              project: anchors[0].project,
              memoryId: anchors[0].repositoryId!,
              family: 'repository-recovery',
              slot: 'repository',
              repositoryId: anchors[0].repositoryId,
              causeKey: `${anchors[0].repositoryId}:repository-ambiguous`,
              evidenceRevision: revision,
              disposition: 'needs-decision',
              reason: 'repository-ambiguous',
            },
            now,
          );
    current.add(item.caseId);
    cases.set(item.caseId, {
      ...item,
      sourceSnapshots: anchors
        .flatMap(anchor =>
          anchor.sourceSnapshot === undefined
            ? []
            : [{uri: anchor.subjectContentHashes?.[0]?.uri ?? '', ...anchor.sourceSnapshot}],
        )
        .filter((source, index, all) => all.findIndex(other => other.uri === source.uri) === index)
        .sort((a, b) => a.uri.localeCompare(b.uri)),
      subjectContentHashes: [
        ...new Map(
          anchors.flatMap(anchor => anchor.subjectContentHashes ?? []).map(subject => [subject.uri, subject]),
        ).values(),
      ].sort((a, b) => a.uri.localeCompare(b.uri)),
    });
  }
  for (const [id, item] of cases)
    if (item.family === 'repository-recovery' && !current.has(id))
      cases.set(id, {...item, disposition: 'resolved', reason: 'repository-ambiguity-resolved'});
}

export function upsertCase(
  cases: Map<string, ContextMaintenanceCaseV2>,
  input: Parameters<typeof updateMaintenanceCase>[1] & Pick<ContextMaintenanceCaseV2, 'causeKey' | 'repositoryId'>,
  now: string,
) {
  const id = contextHealthCaseIdV2(input);
  const previous = cases.get(id);
  const effective =
    input.family === 'citation' &&
    previous?.disposition === 'retired' &&
    previous.evidenceRevision === input.evidenceRevision
      ? {...input, disposition: previous.disposition, reason: previous.reason, retirement: previous.retirement}
      : input.family === 'relation' &&
          input.disposition === 'historical' &&
          previous?.disposition === 'needs-decision' &&
          previous.evidenceRevision === input.evidenceRevision
        ? {...input, disposition: previous.disposition, reason: previous.reason}
        : input;
  const item = {
    ...updateMaintenanceCase(previous, effective, now),
    causeKey: input.causeKey ?? `${input.family}:${input.reason}`,
    ...(input.repositoryId === undefined ? {} : {repositoryId: input.repositoryId}),
  };
  cases.set(id, item);
  return item;
}

export const resolveRelationTarget = resolveContextHealthRelationTargetV2;

export interface MaintenanceRelationPolicy {
  readonly state: 'active' | 'historical' | 'redirectable' | 'prunable' | 'ambiguous' | 'unknown';
  readonly target?: MemoryRecord;
  readonly successor?: MemoryRecord;
  readonly lineage?: readonly MemoryRecord[];
}

export function resolveMaintenanceRelationPolicy(
  record: MemoryRecord,
  relation: MemoryRelation,
  corpus: readonly MemoryRecord[],
  complete = true,
): MaintenanceRelationPolicy {
  const target = resolveRelationTarget(corpus, relation.uri);
  if (target.state === 'conflicted') return {state: 'ambiguous'};
  if (target.state === 'active') return {state: 'active', target: target.record};
  if (target.state === 'inactive' && relation.type !== 'depends_on')
    return {state: 'historical', target: target.record};
  if (!complete || isSharedMemoryUri(record.uri)) return {state: 'unknown'};
  const personalRoot = record.uri.slice(0, record.uri.indexOf('/memories/') + '/memories/'.length);
  const personal = (uri: string) =>
    personalRoot.includes('/memories/') && uri.startsWith(personalRoot) && !isSharedMemoryUri(uri);
  if (target.record === undefined)
    return {
      state: personal(relation.uri) && memoryIdFromIdentityAlias(relation.uri) === undefined ? 'prunable' : 'unknown',
    };
  if (!personal(target.record.uri)) return {state: 'unknown', target: target.record};
  const lineage: MemoryRecord[] = [target.record];
  let current = target.record;
  for (let hop = 0; hop < 64; hop++) {
    const successors = corpus.filter(candidate =>
      (candidate.metadata.relations ?? []).some(
        link => link.type === 'supersedes' && resolveRelationTarget(corpus, link.uri).record?.uri === current.uri,
      ),
    );
    if (successors.length > 1) return {state: 'ambiguous', target: target.record};
    const successor = successors[0];
    if (successor === undefined) return {state: 'prunable', target: target.record, lineage};
    if (
      !personal(successor.uri) ||
      successor.uri === record.uri ||
      successor.metadata.memoryId === undefined ||
      resolveRelationTarget(corpus, `threadnote://memory/${successor.metadata.memoryId}`).record?.uri !==
        successor.uri ||
      lineage.some(
        prior =>
          prior.uri === successor.uri ||
          (prior.metadata.relations ?? []).some(
            link => link.type === 'supersedes' && resolveRelationTarget(corpus, link.uri).record?.uri === successor.uri,
          ),
      )
    )
      return {state: 'ambiguous', target: target.record};
    lineage.push(successor);
    if (successor.metadata.status === 'active')
      return {state: 'redirectable', target: target.record, successor, lineage};
    current = successor;
  }
  return {state: 'unknown', target: target.record, lineage};
}

export function safeRelationRemoval(record: MemoryRecord, corpus: readonly MemoryRecord[]): readonly MemoryRelation[] {
  return (record.metadata.relations ?? []).filter(
    relation => resolveMaintenanceRelationPolicy(record, relation, corpus).state === 'prunable',
  );
}

export function maintenanceRelationPolicyMatches(left: MaintenanceRelationPolicy, right: MaintenanceRelationPolicy) {
  return (
    left.state === right.state &&
    left.target?.uri === right.target?.uri &&
    left.successor?.uri === right.successor?.uri &&
    left.target?.content === right.target?.content &&
    left.successor?.content === right.successor?.content &&
    JSON.stringify(left.lineage?.map(record => [record.uri, sha256HexSync(record.content)])) ===
      JSON.stringify(right.lineage?.map(record => [record.uri, sha256HexSync(record.content)]))
  );
}

export function reconcileAbsentMaintenanceAnchors(
  cases: Map<string, ContextMaintenanceCaseV2>,
  record: MemoryRecord,
  now: string,
) {
  const anchors = new Set((record.metadata.codeCitations ?? []).map(contextHealthCitationCaseSlotV2));
  const chunks = Math.max(1, Math.ceil((record.metadata.codeCitations?.length ?? 0) / 64));
  for (const [id, item] of cases) {
    if (!absentMaintenanceAnchorCase(item, record, anchors, chunks)) continue;
    const unresolved = item.slot.startsWith('legacy-unresolved:');
    cases.set(id, {
      ...item,
      disposition: 'resolved',
      reason: unresolved ? 'legacy-anchor-lineage-unprovable' : 'canonical-anchor-removed',
      lastChecked: now,
      nextAttemptAt: undefined,
      wake: undefined,
      events: [
        ...item.events,
        {at: now, reason: unresolved ? 'legacy-anchor-lineage-unprovable' : 'canonical-anchor-removed'},
      ].slice(-MAX_EVENTS),
    });
  }
}

export function hasAbsentMaintenanceAnchors(cases: Iterable<ContextMaintenanceCaseV2>, record: MemoryRecord): boolean {
  const anchors = new Set((record.metadata.codeCitations ?? []).map(contextHealthCitationCaseSlotV2));
  const chunks = Math.max(1, Math.ceil((record.metadata.codeCitations?.length ?? 0) / 64));
  for (const item of cases) if (absentMaintenanceAnchorCase(item, record, anchors, chunks)) return true;
  return false;
}

function absentMaintenanceAnchorCase(
  item: ContextMaintenanceCaseV2,
  record: MemoryRecord,
  anchors: ReadonlySet<string>,
  chunks: number,
) {
  if (
    item.memoryId !== (record.metadata.memoryId ?? record.uri) ||
    item.project !== (record.metadata.project ?? 'unscoped') ||
    item.disposition === 'resolved' ||
    item.disposition === 'retired'
  )
    return false;
  return (
    (['citation', 'current-support'].includes(item.family) && !anchors.has(item.slot)) ||
    (item.family === 'citation-coverage' && /^\d+$/u.test(item.slot) && Number(item.slot) >= chunks)
  );
}

export function maintenanceAnchorChunksComplete(
  record: MemoryRecord,
  checkpoints: Readonly<Record<string, {readonly inventoryComplete?: boolean; readonly memoryHash?: string}>>,
  hash: string | undefined,
) {
  return (
    hash !== undefined &&
    Array.from(
      {length: Math.max(1, Math.ceil((record.metadata.codeCitations?.length ?? 0) / 64))},
      (_, chunk) => checkpoints[`${record.metadata.memoryId ?? record.uri}:${chunk}`],
    ).every(check => check?.inventoryComplete === true && check.memoryHash === hash)
  );
}

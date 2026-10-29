import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {currentMemoryCodeCitations} from '@threadnote/memory/reviewed-support';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  isAgentArtifactUri,
  isSharedMemoryUri,
  type MemoryRecord,
  type MemoryRelation,
  canonicalMemoryDocumentContent,
} from '@threadnote/memory/document';
import {memoryIdFromIdentityAlias} from '@threadnote/memory/identity-alias';
import {
  contextHealthCaseIdV2,
  contextHealthCitationCaseSlotV2,
  migrateContextHealthCitationCaseSlotV2,
  resolveContextHealthRelationTargetV2,
} from '@threadnote/context/health_maintenance';
import type {ContextMaintenanceCaseV2} from './maintenance.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const MAX_EVENTS = 8;

export function maintenanceContentHash(content: string) {
  return sha256HexSync(canonicalMemoryDocumentContent(content));
}

export function nextMaintenanceDeadline(record: MemoryRecord, now: string): string | undefined {
  return EffectArray.filter(
    [record.metadata.validTo, record.metadata.reviewAfter],
    (value): value is string => value !== undefined && Date.parse(value) > Date.parse(now),
  ).sort()[0];
}

export function artifactOnlySharedRelationProposal(
  item: ContextMaintenanceCaseV2,
  subject: MemoryRecord,
  records: readonly MemoryRecord[],
): boolean {
  return (
    item.family === 'shared-owner-proposal' &&
    item.reason === 'shared-canonical-relations-require-owner-review' &&
    item.slot === 'relations' &&
    isSharedMemoryUri(subject.uri) &&
    subject.metadata.relations != null &&
    Boolean(EffectArray.some(subject.metadata.relations, relation => isAgentArtifactUri(relation.uri))) &&
    EffectArray.every(subject.metadata.relations, relation => {
      if (isAgentArtifactUri(relation.uri)) return true;
      const state = resolveRelationTarget(records, relation.uri).state;
      return state === 'active' || state === 'inactive';
    })
  );
}

export function duplicateArchiveSafe(subject: MemoryRecord, survivor: MemoryRecord | undefined): boolean {
  if (
    survivor === undefined ||
    survivor.uri === subject.uri ||
    isSharedMemoryUri(survivor.uri) ||
    Effect.pipe(subject.body, EffectString.trim) !== Effect.pipe(survivor.body, EffectString.trim)
  )
    return false;
  if (subject.metadata.memoryId === undefined || survivor.metadata.memoryId === undefined) return false;
  const relations = new Set(EffectArray.map(survivor.metadata.relations ?? [], item => `${item.type}:${item.uri}`));
  const citations = new Set(EffectArray.map(survivor.metadata.codeCitations ?? [], item => item.id));
  return (
    EffectArray.every(subject.metadata.relations ?? [], item => relations.has(`${item.type}:${item.uri}`)) &&
    EffectArray.every(subject.metadata.codeCitations ?? [], item => citations.has(item.id))
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

export function selectMaintenanceCitationCaseTask<
  T extends {readonly record: MemoryRecord; readonly project: string; readonly chunk: number},
>(items: readonly T[], selected: ContextMaintenanceCaseV2): T | undefined {
  const matches = EffectArray.filter(
    items,
    (item, __effectArrayIndex) =>
      __effectArrayIndex in items &&
      item.project === selected.project &&
      (item.record.metadata.memoryId ?? item.record.uri) === selected.memoryId &&
      (selected.subjectUri === undefined || selected.subjectUri === item.record.uri) &&
      (selected.family === 'citation-coverage'
        ? String(item.chunk) === selected.slot
        : selected.family === 'citation' &&
          EffectArray.some(
            currentMemoryCodeCitations(item.record).slice(item.chunk * 64, (item.chunk + 1) * 64),
            citation => contextHealthCitationCaseSlotV2(citation) === selected.slot,
          )),
  );
  return matches.length === 1 ? matches[0] : undefined;
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
      ...new Map(
        EffectArray.map([...left.events, ...right.events], event => [`${event.at}:${event.reason}`, event]),
      ).values(),
    ]
      .sort(
        (a, b) =>
          Effect.pipe(a.at, EffectString.localeCompare(b.at)) ||
          Effect.pipe(a.reason, EffectString.localeCompare(b.reason)),
      )
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
    const revision = sha256HexSync(
      JSON.stringify(EffectArray.map(anchors, item => [item.caseId, item.evidenceRevision]).sort()),
    );
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
      sourceSnapshots: EffectArrayPipe(
        EffectArray.flatMap(anchors, (anchor, effectFlatMapIndex) =>
          effectFlatMapIndex in anchors
            ? anchor.sourceSnapshot === undefined
              ? []
              : [{uri: anchor.subjectContentHashes?.[0]?.uri ?? '', ...anchor.sourceSnapshot}]
            : [],
        ),
        __effectArrayValues =>
          EffectArray.filter(
            __effectArrayValues,
            (source, index) =>
              index in __effectArrayValues &&
              EffectOption.getOrElse(
                EffectArray.findFirstIndex(__effectArrayValues, other => other.uri === source.uri),
                () => -1,
              ) === index,
          ),
      ).sort((a, b) => Effect.pipe(a.uri, EffectString.localeCompare(b.uri))),
      subjectContentHashes: [
        ...new Map(
          EffectArray.map(
            EffectArray.flatMap(anchors, (anchor, __effectArrayIndex) =>
              __effectArrayIndex in anchors ? (anchor.subjectContentHashes ?? []) : [],
            ),
            subject => [subject.uri, subject],
          ),
        ).values(),
      ].sort((a, b) => Effect.pipe(a.uri, EffectString.localeCompare(b.uri))),
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
  if (isAgentArtifactUri(relation.uri)) return {state: 'unknown'};
  const target = resolveRelationTarget(corpus, relation.uri);
  if (target.state === 'conflicted') return {state: 'ambiguous'};
  if (target.state === 'active') return {state: 'active', target: target.record};
  if (target.state === 'inactive' && relation.type !== 'depends_on')
    return {state: 'historical', target: target.record};
  if (!complete || isSharedMemoryUri(record.uri)) return {state: 'unknown'};
  const personalRoot = Effect.pipe(
    record.uri,
    EffectString.slice(
      0,
      Effect.pipe(
        record.uri,
        EffectString.indexOf('/memories/'),
        Effect.Option.getOrElse(() => -1),
      ) + '/memories/'.length,
    ),
  );
  const personal = (uri: string) =>
    Effect.pipe(personalRoot, EffectString.includes('/memories/')) &&
    Effect.pipe(uri, EffectString.startsWith(personalRoot)) &&
    !isSharedMemoryUri(uri);
  if (target.record === undefined)
    return {
      state: personal(relation.uri) && memoryIdFromIdentityAlias(relation.uri) === undefined ? 'prunable' : 'unknown',
    };
  if (!personal(target.record.uri)) return {state: 'unknown', target: target.record};
  const lineage: MemoryRecord[] = [target.record];
  let current = target.record;
  for (let hop = 0; hop < 64; hop++) {
    const successors = EffectArray.filter(
      corpus,
      (candidate, __effectArrayIndex) =>
        __effectArrayIndex in corpus &&
        EffectArray.some(
          candidate.metadata.relations ?? [],
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
      EffectArray.some(
        lineage,
        prior =>
          prior.uri === successor.uri ||
          EffectArray.some(
            prior.metadata.relations ?? [],
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
  return EffectArrayPipe(record.metadata.relations ?? [], __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (relation, __effectArrayIndex) =>
        __effectArrayIndex in __effectArrayValues &&
        resolveMaintenanceRelationPolicy(record, relation, corpus).state === 'prunable',
    ),
  );
}

export function maintenanceRelationPolicyMatches(left: MaintenanceRelationPolicy, right: MaintenanceRelationPolicy) {
  return (
    left.state === right.state &&
    left.target?.uri === right.target?.uri &&
    left.successor?.uri === right.successor?.uri &&
    left.target?.content === right.target?.content &&
    left.successor?.content === right.successor?.content &&
    JSON.stringify(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(left.lineage), lineage =>
          EffectArray.map(lineage, record => [record.uri, sha256HexSync(record.content)]),
        ),
      ),
    ) ===
      JSON.stringify(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(right.lineage), lineage =>
            EffectArray.map(lineage, record => [record.uri, sha256HexSync(record.content)]),
          ),
        ),
      )
  );
}

export function reconcileAbsentMaintenanceAnchors(
  cases: Map<string, ContextMaintenanceCaseV2>,
  record: MemoryRecord,
  now: string,
) {
  const anchors = new Set(EffectArray.map(currentMemoryCodeCitations(record), contextHealthCitationCaseSlotV2));
  const chunks = Math.max(1, Math.ceil(currentMemoryCodeCitations(record).length / 64));
  for (const [id, item] of cases) {
    if (!absentMaintenanceAnchorCase(item, record, anchors, chunks)) continue;
    const unresolved = Effect.pipe(item.slot, EffectString.startsWith('legacy-unresolved:'));
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
  const anchors = new Set(EffectArray.map(currentMemoryCodeCitations(record), contextHealthCitationCaseSlotV2));
  const chunks = Math.max(1, Math.ceil(currentMemoryCodeCitations(record).length / 64));
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
    EffectArray.every(
      Array.from(
        {length: Math.max(1, Math.ceil(currentMemoryCodeCitations(record).length / 64))},
        (_, chunk) => checkpoints[`${record.metadata.memoryId ?? record.uri}:${chunk}`],
      ),
      check => check?.inventoryComplete === true && check.memoryHash === hash,
    )
  );
}

export function migrateMaintenanceCases(
  cases: readonly ContextMaintenanceCaseV2[],
  records: readonly MemoryRecord[] = [],
  hashes?: ReadonlyMap<string, string>,
  inventoryComplete = false,
): readonly ContextMaintenanceCaseV2[] {
  const identities = new Map<string, ContextMaintenanceCaseV2>();
  for (const item of cases) {
    const subject = EffectOption.getOrUndefined(
      EffectArray.findFirst(records, record => (record.metadata.memoryId ?? record.uri) === item.memoryId),
    );
    const citations = subject ? currentMemoryCodeCitations(subject) : [];
    const ordinal = /^(?:anchor:)?(\d+)$/u.exec(item.slot);
    const unchangedSubject =
      subject !== undefined &&
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(item.subjectContentHashes), findArray =>
          EffectArray.some(
            findArray,
            reference =>
              reference.uri === subject.uri &&
              reference.hash === (hashes?.get(subject.uri) ?? maintenanceContentHash(subject.content)),
          ),
        ),
      );
    const citationId =
      item.citationId ?? (unchangedSubject && ordinal !== null ? citations[Number(ordinal[1])]?.id : undefined);
    const slot =
      item.family === 'citation'
        ? records.length === 0 || Effect.pipe(item.slot, EffectString.startsWith('legacy-unresolved:'))
          ? item.slot
          : /^anchor:tncc_[0-9a-f]{40}$/u.test(item.slot) &&
              !EffectArray.some(citations, citation => contextHealthCitationCaseSlotV2(citation) === item.slot)
            ? item.slot
            : (migrateContextHealthCitationCaseSlotV2({
                slot: item.slot,
                citationId,
                citations,
              }) ?? `legacy-unresolved:${item.caseId}`)
        : item.family === 'relation'
          ? Effect.pipe(
              item.slot,
              EffectString.replace(
                /^(?:depends_on|references|related_to|supersedes|evidence_for):(?=threadnote:\/\/)/u,
                '',
              ),
            )
          : item.slot === item.family && item.family !== 'citation'
            ? 'record'
            : item.slot;
    // Remove non-memory findings before a current checkpoint can skip record work.
    if (item.family === 'relation' && isAgentArtifactUri(slot)) continue;
    if (inventoryComplete && unchangedSubject && artifactOnlySharedRelationProposal(item, subject, records)) continue;
    const canonicalSlot =
      item.family === 'relation' ? (resolveRelationTarget(records, slot).record?.metadata.memoryId ?? slot) : slot;
    const next = {
      ...item,
      slot: canonicalSlot,
      disposition:
        item.family === 'review-overdue' && item.disposition === 'deferred-policy'
          ? ('needs-decision' as const)
          : item.disposition,
      caseId: contextHealthCaseIdV2({...item, slot: canonicalSlot}),
    };
    const prior = identities.get(next.caseId);
    identities.set(next.caseId, prior === undefined ? next : mergeMaintenanceCaseLineage(prior, next));
  }
  return [...identities.values()];
}

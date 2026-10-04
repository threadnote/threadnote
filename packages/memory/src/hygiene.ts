import {uriSegment} from '@threadnote/workspace/manifest';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  isSharedMemoryUri,
  parseMemoryDocument,
  type MemoryMetadata,
  type MemoryRecord,
} from '@threadnote/memory/document';
import {parseResourceId} from '@threadnote/store/resource-id';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';
import type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';
import {
  MEMORY_HYGIENE_SOURCES_HEADING,
  MEMORY_HYGIENE_SOURCES_MARKER,
  parseMemoryHygieneSources,
} from './hygiene/provenance.js';

export type CompactableMemoryKind = Extract<MemoryKind, 'durable' | 'handoff' | 'incident'>;
export {parseMemoryDocument};
export type {MemoryMetadata, MemoryRecord};

export interface CompactPlanOptions {
  readonly kind?: CompactableMemoryKind;
  readonly now?: Date;
  readonly project: string;
  readonly topic?: string;
}

export interface KeepUpdateAction {
  readonly content: string;
  readonly expectedContent: string;
  readonly reason: string;
  readonly sourceUris: readonly string[];
  readonly uri: string;
}

export interface ArchiveAction {
  readonly expectedContent: string;
  readonly kind: CompactableMemoryKind;
  readonly project: string;
  readonly reason: string;
  readonly sourceUris: readonly string[];
  readonly topic?: string;
  readonly uri: string;
}

export interface ForgetAction {
  readonly expectedContent: string;
  readonly reason: string;
  readonly sourceUris: readonly string[];
  readonly uri: string;
}

export interface ManualReviewItem {
  readonly reason: string;
  readonly uri: string;
}

export interface MergeReviewProposal {
  readonly project: string;
  readonly reason: string;
  readonly sourceUris: readonly string[];
  readonly topic: string;
}

export interface CompactPlan {
  readonly archives: readonly ArchiveAction[];
  readonly forgets: readonly ForgetAction[];
  readonly keepUpdates: readonly KeepUpdateAction[];
  readonly manualReview: readonly ManualReviewItem[];
  readonly mergeReviewProposals: readonly MergeReviewProposal[];
  readonly options: CompactPlanOptions;
  readonly recordsScanned: number;
}

interface GroupedRecord {
  readonly groupKey: string;
  readonly memoryScope: string;
  readonly project: string;
  readonly record: MemoryRecord;
  readonly topic?: string;
  readonly workspaceScope?: string;
}

interface ParsedMemoryUri {
  readonly kind: CompactableMemoryKind;
  readonly project: string;
  readonly status: MemoryStatus;
  readonly topic: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HANDOFF_TERMINAL_RETENTION_MS = 7 * DAY_MS;
const HANDOFF_REVIEW_AGE_MS = 14 * DAY_MS;
const HANDOFF_MAXIMUM_ACTIVE_AGE_MS = 30 * DAY_MS;
const COMPACT_PLAN_SECTION_PREVIEW_LIMIT = 25;
export const DEFAULT_HANDOFF_NEXT_STEP = 'inspect the current repo state and continue from this handoff';
const TERMINAL_HANDOFF_STATUSES = new Set([
  'abandoned',
  'canceled',
  'cancelled',
  'closed',
  'complete',
  'completed',
  'done',
  'merged',
  'released',
  'resolved',
  'shipped',
  'superseded',
]);

export function buildCompactPlan(records: readonly MemoryRecord[], options: CompactPlanOptions): CompactPlan {
  const now = options.now ?? new Date();
  const groupedRecords = records
    .map(record => groupableRecord(record))
    .filter((item): item is GroupedRecord => item !== undefined)
    .filter(item => item.project === options.project)
    .filter(item => options.topic === undefined || item.topic === options.topic)
    .filter(item => options.kind === undefined || item.record.metadata.kind === options.kind)
    .sort(compareGroupedRecords);

  const mergeReviewProposals = buildMergeReviewProposals(groupedRecords);
  const mutableRecords = groupedRecords.filter(item => isPersonalMemoryUri(item.record.uri));
  const keepUpdates: KeepUpdateAction[] = [];
  const archives: ArchiveAction[] = [];
  const forgets: ForgetAction[] = [];
  const manualReview: ManualReviewItem[] = [];
  const claimedMutationUris = new Set<string>();
  const protectedReviewUris = new Set<string>();

  const addArchive = (item: GroupedRecord, reason: string): void => {
    if (claimedMutationUris.has(item.record.uri)) {
      return;
    }
    const kind = item.record.metadata.kind;
    if (!isCompactableKind(kind)) {
      return;
    }
    claimedMutationUris.add(item.record.uri);
    archives.push({
      expectedContent: item.record.content,
      kind,
      project: item.project,
      reason,
      sourceUris: [item.record.uri],
      topic: item.topic,
      uri: item.record.uri,
    });
  };
  const addManualReview = (item: GroupedRecord, reason: string): void => {
    if (claimedMutationUris.has(item.record.uri) || protectedReviewUris.has(item.record.uri)) {
      return;
    }
    protectedReviewUris.add(item.record.uri);
    manualReview.push({reason, uri: item.record.uri});
  };

  for (const item of mutableRecords) {
    const {record} = item;
    if (hasExpiredValidity(record, now)) {
      addArchive(item, `valid_to expired at ${record.metadata.validTo}`);
      continue;
    }
    if (record.metadata.kind !== 'handoff') {
      continue;
    }
    const age = memoryAgeMilliseconds(record, now);
    if (age === undefined) {
      continue;
    }
    const pending = hasExplicitPendingHandoffState(record.body);
    const terminal = hasExplicitTerminalHandoffState(record.body);
    if (age >= HANDOFF_MAXIMUM_ACTIVE_AGE_MS) {
      if (pending) {
        addManualReview(item, '30-day handoff retention deferred by explicit pending/open/blocker language');
      } else {
        addArchive(item, 'active handoff reached the 30-day recoverable retention boundary');
      }
      continue;
    }
    if (age >= HANDOFF_TERMINAL_RETENTION_MS && terminal && !pending) {
      addArchive(item, 'terminal handoff reached the 7-day recoverable retention boundary');
      continue;
    }
    if (age >= HANDOFF_REVIEW_AGE_MS) {
      addManualReview(item, 'nonterminal active handoff is between 14 and 30 days old');
    }
  }

  const groups = new Map<string, GroupedRecord[]>();
  for (const item of mutableRecords.filter(
    candidate => !claimedMutationUris.has(candidate.record.uri) && !protectedReviewUris.has(candidate.record.uri),
  )) {
    groups.set(item.groupKey, [...(groups.get(item.groupKey) ?? []), item]);
  }

  for (const group of [...groups.values()].sort(compareGroupedRecordLists)) {
    const recordsInGroup = group.map(item => item.record);
    const kind = recordsInGroup[0]?.metadata.kind;
    const topic = group[0]?.topic;
    const project = group[0]?.project;
    if (!kind || !project || !isCompactableKind(kind)) {
      continue;
    }

    const duplicateGroups = groupBy(recordsInGroup, record => comparableMemoryBody(record.body));
    const duplicateRetiredUris = new Set<string>();
    const duplicateMetadataConflictUris = new Set<string>();
    const distinctBodyCount = duplicateGroups.size;
    for (const duplicateGroup of duplicateGroups.values()) {
      if (duplicateGroup.length < 2) {
        continue;
      }
      const metadataReference = duplicateGroup[0];
      if (!duplicateGroup.every(record => hasEquivalentMemoryMetadata(record, metadataReference))) {
        for (const record of duplicateGroup) {
          duplicateMetadataConflictUris.add(record.uri);
          addManualReview(
            group.find(item => item.record.uri === record.uri)!,
            'same body has distinct metadata or provenance; no automatic retirement',
          );
        }
        continue;
      }
      const duplicateKeep = preferredKeepRecord(duplicateGroup, topic);
      for (const duplicate of sortedNewestFirst(duplicateGroup).filter(record => record.uri !== duplicateKeep.uri)) {
        duplicateRetiredUris.add(duplicate.uri);
        const sourceUris = sortedUniqueUris([duplicate.uri, duplicateKeep.uri]);
        forgets.push({
          expectedContent: duplicate.content,
          reason: `exact duplicate of ${duplicateKeep.uri}`,
          sourceUris,
          uri: duplicate.uri,
        });
        claimedMutationUris.add(duplicate.uri);
      }
      if (distinctBodyCount === 1 || kind !== 'handoff') {
        const sourceUris = memoryProvenanceUris(duplicateGroup);
        keepUpdates.push({
          content: memoryContentWithHygieneSources(duplicateKeep, sourceUris),
          expectedContent: duplicateKeep.content,
          reason: 'keep exact duplicate group with source URIs',
          sourceUris,
          uri: duplicateKeep.uri,
        });
        claimedMutationUris.add(duplicateKeep.uri);
      }
    }

    const remainingRecords = recordsInGroup.filter(
      record => !duplicateRetiredUris.has(record.uri) && !duplicateMetadataConflictUris.has(record.uri),
    );
    if (recordsInGroup.length > 1 && distinctBodyCount === 1) {
      continue;
    }
    if (remainingRecords.length === 0) {
      continue;
    }
    if (remainingRecords.length === 1) {
      const [record] = remainingRecords;
      if (!record) {
        continue;
      }
      if (record.metadata.supersedes === record.uri) {
        keepUpdates.push({
          content: memoryContentWithHygieneSources(record, [record.uri]),
          expectedContent: record.content,
          reason: 'strip self-supersedes header',
          sourceUris: [record.uri],
          uri: record.uri,
        });
        claimedMutationUris.add(record.uri);
      }
      continue;
    }

    if (kind === 'handoff') {
      const keep = preferredKeepRecord(remainingRecords, topic);
      const sourceUris = memoryProvenanceUris(recordsInGroup);
      keepUpdates.push({
        content: memoryContentWithHygieneSources(keep, sourceUris),
        expectedContent: keep.content,
        reason: 'keep latest handoff and preserve source URIs',
        sourceUris,
        uri: keep.uri,
      });
      claimedMutationUris.add(keep.uri);
      for (const record of sortedNewestFirst(remainingRecords).filter(item => item.uri !== keep.uri)) {
        archives.push({
          expectedContent: record.content,
          kind,
          project,
          reason: `older handoff for ${project}/${topic ?? 'unknown'}`,
          sourceUris: [record.uri],
          topic,
          uri: record.uri,
        });
        claimedMutationUris.add(record.uri);
      }
      continue;
    }

    for (const record of sortedNewestFirst(remainingRecords)) {
      if (!claimedMutationUris.has(record.uri)) {
        manualReview.push({reason: `non-exact ${kind} memory in overlapping group`, uri: record.uri});
      }
    }
  }

  return {
    archives: sortByUri(dedupeByUri(archives)),
    forgets: sortByUri(dedupeByUri(forgets)),
    keepUpdates: sortByUri(dedupeByUri(keepUpdates)),
    manualReview: sortByUri(dedupeByUri(manualReview)),
    mergeReviewProposals,
    options,
    recordsScanned: groupedRecords.length,
  };
}

export function memoryContentWithHygieneSources(record: MemoryRecord, sourceUris: readonly string[]): string {
  assertMemoryDocumentSchemaWritable(record.content);
  const existingSourceUris = hygieneSourceUris(record.body);
  const body = stripHygieneSources(record.body);
  const uniqueSourceUris = [...new Set([...existingSourceUris, ...sourceUris])].sort();
  const metadata = {
    ...record.metadata,
    supersedes: record.metadata.supersedes === record.uri ? undefined : record.metadata.supersedes,
  };
  return formatMemoryDocument(
    record.headerTitle,
    metadata,
    [
      body,
      '',
      MEMORY_HYGIENE_SOURCES_MARKER,
      MEMORY_HYGIENE_SOURCES_HEADING,
      '',
      ...uniqueSourceUris.map(uri => `- ${uri}`),
    ].join('\n'),
  );
}

export function formatCompactPlan(plan: CompactPlan, options: {readonly apply: boolean}): string {
  const scope = [
    `project ${plan.options.project}`,
    plan.options.topic ? `topic ${plan.options.topic}` : undefined,
    plan.options.kind ? `kind ${plan.options.kind}` : undefined,
  ]
    .filter((item): item is string => item !== undefined)
    .join(', ');
  const lines = [
    `${options.apply ? 'Applying' : 'Dry-run'} memory hygiene plan for ${scope}`,
    `Records scanned: ${plan.recordsScanned}`,
    '',
    formatPlanSection(
      'Keep/update',
      plan.keepUpdates.map(action => formatPlanAction(action.uri, action.reason, action.sourceUris)),
    ),
    formatPlanSection(
      'Archive expired/stale active memories',
      plan.archives.map(action => formatPlanAction(action.uri, action.reason, action.sourceUris)),
    ),
    formatPlanSection(
      'Forget exact duplicates',
      plan.forgets.map(action => formatPlanAction(action.uri, action.reason, action.sourceUris)),
    ),
    formatPlanSection(
      'Manual review',
      plan.manualReview.map(item => `${item.uri} (${item.reason})`),
    ),
    formatPlanSection(
      'Merge/review proposals',
      plan.mergeReviewProposals.map(proposal =>
        formatPlanAction(`${proposal.project}/${proposal.topic}`, proposal.reason, proposal.sourceUris),
      ),
    ),
  ];
  if (!options.apply) {
    lines.push('', 'No changes made. Re-run with --apply to execute this plan.');
  }
  return lines.join('\n');
}

export function recallHygieneNudges(
  text: string,
  options: {readonly records?: readonly MemoryRecord[]; readonly user: string},
): readonly string[] {
  const activeUris = activePersonalMemoryUrisFromText(text, options.user);
  const nudges: string[] = [];
  const returnedUriSet = new Set(activeUris);
  const returnedRecords =
    options.records?.filter(record => returnedUriSet.has(record.uri)).map(record => groupableRecord(record)) ?? [];
  const groups = new Map<string, GroupedRecord[]>();
  for (const item of returnedRecords) {
    if (!item) {
      continue;
    }
    groups.set(item.groupKey, [...(groups.get(item.groupKey) ?? []), item]);
  }
  for (const group of [...groups.values()].sort(compareGroupedRecordLists)) {
    if (group.length < 3) {
      continue;
    }
    const first = group[0];
    if (!first || !isCompactableKind(first.record.metadata.kind)) {
      continue;
    }
    const topic = first.topic;
    if (!topic) {
      continue;
    }
    nudges.push(
      `${group.length} active ${memoryKindPlural(first.record.metadata.kind)} look overlapping for ${first.project}/${topic}; run compact_context({"project":"${first.project}","topic":"${topic}","dryRun":true}).`,
    );
  }

  const projectCounts = new Map<string, number>();
  for (const uri of activeUris) {
    const parsed = parsePersonalMemoryUri(uri, options.user);
    if (!parsed || parsed.kind !== 'handoff' || parsed.status !== 'active') {
      continue;
    }
    projectCounts.set(parsed.project, (projectCounts.get(parsed.project) ?? 0) + 1);
  }
  for (const [project, count] of [...projectCounts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (count < 10) {
      continue;
    }
    nudges.push(
      `Many active handoffs surfaced for ${project}; run compact_context({"project":"${project}","dryRun":true}).`,
    );
  }
  return [...new Set(nudges)];
}

/**
 * Collects one-way `references:` pointers off already-surfaced memory records,
 * dropping any URI that recall already displayed so the referenced-context pass
 * only adds prior context the caller has not already seen. Deduped, order
 * preserved.
 */
export function referencedUrisFromRecords(records: readonly MemoryRecord[], recallOutput: string): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const record of records) {
    for (const uri of record.metadata.references ?? []) {
      if (seen.has(uri) || recallOutput.includes(uri)) {
        continue;
      }
      seen.add(uri);
      result.push(uri);
    }
  }
  return result;
}

/**
 * Keeps declared reference candidates that were successfully read back as
 * canonical memory records. Reference metadata is intentionally one-way and may
 * outlive an archived, replaced, or deleted target; recall must not advertise a
 * pointer that its read command cannot currently resolve.
 */
export function existingReferencedUris(
  candidates: readonly string[],
  records: readonly MemoryRecord[],
): readonly string[] {
  const existing = new Set(records.map(record => record.uri));
  return candidates.filter(uri => existing.has(uri));
}

/** Renders bounded one-way reference pointers without inlining another memory. */
export function formatReferencedContextPointers(uris: readonly string[], maxUris: number): string | undefined {
  if (uris.length === 0) {
    return undefined;
  }
  const capped = uris.slice(0, maxUris);
  const lines = [
    'Referenced read-only context (one-way pointers from surfaced memories):',
    ...capped.map(uri => `- ${uri}`),
  ];
  if (uris.length > capped.length) {
    const omitted = uris.length - capped.length;
    lines.push(`- … ${omitted} more referenced ${omitted === 1 ? 'memory' : 'memories'} omitted`);
  }
  return lines.join('\n');
}

export function activePersonalMemoryUrisFromText(text: string, user: string): readonly string[] {
  const userSegment = uriSegment(user);
  const matches = text.matchAll(/(?:threadnote|viking):\/\/[^\s)]+/g);
  const uris: string[] = [];
  for (const match of matches) {
    const uri = match[0] ? trimTrailingCharacters(match[0], '.,;:') : undefined;
    const canonicalUri = uri ? canonicalResourceInput(uri) : undefined;
    if (!canonicalUri || !parsePersonalMemoryUri(canonicalUri, userSegment)) {
      continue;
    }
    uris.push(canonicalUri);
  }
  return [...new Set(uris)];
}

export function parsePersonalMemoryUri(uri: string, user: string): ParsedMemoryUri | undefined {
  const canonicalUri = canonicalResourceInput(uri);
  if (!canonicalUri) return undefined;
  const prefix = `threadnote://user/${uriSegment(user)}/memories/`;
  if (!canonicalUri.startsWith(prefix) || isSharedMemoryUri(canonicalUri)) {
    return undefined;
  }
  const rest = canonicalUri.slice(prefix.length);
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 4) {
    return undefined;
  }
  if (parts[0] === 'handoffs' && parts[1] === 'active' && parts[2] && parts[3]?.endsWith('.md')) {
    return {kind: 'handoff', project: parts[2], status: 'active', topic: parts[3].replace(/\.md$/, '')};
  }
  if (parts[0] === 'durable' && parts[1] === 'projects' && parts[2] && parts[3]?.endsWith('.md')) {
    return {kind: 'durable', project: parts[2], status: 'active', topic: parts[3].replace(/\.md$/, '')};
  }
  if (parts[0] === 'incidents' && parts[1] === 'active' && parts[2] && parts[3]?.endsWith('.md')) {
    return {kind: 'incident', project: parts[2], status: 'active', topic: parts[3].replace(/\.md$/, '')};
  }
  return undefined;
}

function canonicalResourceInput(uri: string): string | undefined {
  try {
    return parseResourceId(uri).canonicalUri;
  } catch {
    return undefined;
  }
}

export function handoffTopicForBranch(
  branch: string | undefined,
  options: {readonly timestamped?: boolean; readonly topic?: string},
): string | undefined {
  const topic = normalizeOptionalMetadata(options.topic);
  if (options.timestamped === true) {
    if (topic) {
      throw new Error('Cannot combine --timestamped with --topic.');
    }
    return undefined;
  }
  return topic ?? normalizeOptionalMetadata(branch) ?? 'current';
}

function groupableRecord(record: MemoryRecord): GroupedRecord | undefined {
  if (record.metadata.status !== 'active' || !isCompactableKind(record.metadata.kind)) {
    return undefined;
  }
  const project = normalizeOptionalMetadata(record.metadata.project) ?? parseProjectFromUri(record.uri);
  if (!project) {
    return undefined;
  }
  const topic = topicForRecord(record);
  const memoryScope = memoryScopeForUri(record.uri);
  const workspaceScope = normalizeOptionalMetadata(record.metadata.workspaceScope);
  const groupKey = [memoryScope, record.metadata.kind, project, workspaceScope ?? '<repo>', topic ?? record.uri].join(
    '\0',
  );
  return {groupKey, memoryScope, project, record, topic, workspaceScope};
}

export function topicForRecord(record: MemoryRecord): string | undefined {
  return (
    normalizeOptionalMetadata(record.metadata.topic) ??
    normalizeOptionalMetadata(branchFromBody(record.body)) ??
    topicFromUri(record.uri)
  );
}

function branchFromBody(body: string): string | undefined {
  const branchLine = body.split(/\r?\n/u).find(line => line.startsWith('branch:'));
  const branch = branchLine?.slice('branch:'.length).trim();
  const firstToken = branch?.split(/\s+/)[0];
  return firstToken ? trimTrailingCharacters(firstToken, '.,;:') : undefined;
}

function topicFromUri(uri: string): string | undefined {
  const name = uriBasename(uri).replace(/\.md$/, '');
  return name.startsWith('threadnote-') ? undefined : name;
}

function parseProjectFromUri(uri: string): string | undefined {
  const parts = uri.split('/memories/')[1]?.split('/').filter(Boolean) ?? [];
  if ((parts[0] === 'handoffs' || parts[0] === 'incidents') && parts[1] === 'active') {
    return parts[2];
  }
  if (parts[0] === 'durable' && parts[1] === 'projects') {
    return parts[2];
  }
  return undefined;
}

function comparableMemoryBody(body: string): string {
  return stripHygieneSources(body).replace(/\r\n?/g, '\n');
}

function hasEquivalentMemoryMetadata(left: MemoryRecord, right: MemoryRecord): boolean {
  return (
    left.headerTitle === right.headerTitle &&
    formatMemoryDocument(left.headerTitle, left.metadata, '') ===
      formatMemoryDocument(right.headerTitle, right.metadata, '')
  );
}

function hygieneSourceUris(body: string): readonly string[] {
  return parseMemoryHygieneSources(body)?.uris ?? [];
}

function memoryProvenanceUris(records: readonly MemoryRecord[]): readonly string[] {
  return sortedUniqueUris(records.flatMap(record => [record.uri, ...hygieneSourceUris(record.body)]));
}

function stripHygieneSources(body: string): string {
  const parsed = parseMemoryHygieneSources(body);
  return parsed ? parsed.body : body;
}

function preferredKeepRecord(records: readonly MemoryRecord[], topic?: string): MemoryRecord {
  const newestFirst = sortedNewestFirst(records);
  const newestTimestamp = timestampMs(newestFirst[0] ?? records[0]);
  const equallyNew = newestFirst.filter(record => timestampMs(record) === newestTimestamp);
  return equallyNew.find(record => isStableRecord(record, topic)) ?? equallyNew[0] ?? records[0];
}

function isStableRecord(record: MemoryRecord, topic?: string): boolean {
  const recordTopic = topic ?? topicForRecord(record);
  return recordTopic !== undefined && uriBasename(record.uri) === `${uriSegment(recordTopic)}.md`;
}

function uriBasename(uri: string): string {
  return uri.replaceAll('\\', '/').split('/').at(-1) ?? uri;
}

function sortedNewestFirst<T extends MemoryRecord>(records: readonly T[]): readonly T[] {
  return [...records].sort((left, right) => {
    const timestampDiff = timestampMs(right) - timestampMs(left);
    return timestampDiff === 0 ? left.uri.localeCompare(right.uri) : timestampDiff;
  });
}

function timestampMs(record: MemoryRecord): number {
  const parsed = Date.parse(record.metadata.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function memoryAgeMilliseconds(record: MemoryRecord, now: Date): number | undefined {
  const nowMilliseconds = now.getTime();
  const observations = [
    parseTimestamp(record.metadata.timestamp),
    parseTimestamp(record.metadata.updatedAt),
    parseTimestamp(record.metadata.lastReviewed),
  ].filter((value): value is number => value !== undefined);
  const observedAt = observations.length > 0 ? Math.max(...observations) : undefined;
  if (!Number.isFinite(nowMilliseconds) || observedAt === undefined || observedAt > nowMilliseconds) {
    return undefined;
  }
  return nowMilliseconds - observedAt;
}

function hasExpiredValidity(record: MemoryRecord, now: Date): boolean {
  const validToMilliseconds = parseTimestamp(record.metadata.validTo);
  const nowMilliseconds = now.getTime();
  return (
    validToMilliseconds !== undefined && Number.isFinite(nowMilliseconds) && validToMilliseconds <= nowMilliseconds
  );
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasExplicitTerminalHandoffState(body: string): boolean {
  const fields = handoffBodyFields(body);
  const statuses = normalizedFieldValues(fields.get('status'));
  const nextSteps = normalizedFieldValues(fields.get('next_step'));
  return statuses.some(status => TERMINAL_HANDOFF_STATUSES.has(status)) || nextSteps.includes('none');
}

function hasExplicitPendingHandoffState(body: string): boolean {
  const fields = handoffBodyFields(body);
  const statuses = normalizedFieldValues(fields.get('status'));
  const nextSteps = normalizedFieldValues(fields.get('next_step'));
  const blockers = normalizedFieldValues([...(fields.get('blockers') ?? []), ...(fields.get('blocker') ?? [])]);
  if (
    statuses.some(status =>
      /^(?:active|awaiting(?:\s+.+)?|blocked|in[ _-]?progress|open|pending|waiting(?:\s+.+)?)$/.test(status),
    )
  ) {
    return true;
  }
  if (nextSteps.some(nextStep => nextStep !== 'none' && nextStep !== DEFAULT_HANDOFF_NEXT_STEP)) {
    return true;
  }
  if (
    blockers.some(blocker => !/^(?:n\/?a|no(?:\s+blockers?)?|none(?:\s+recorded)?|not\s+applicable)$/.test(blocker))
  ) {
    return true;
  }
  return (
    /\b(?:PR|pull request|issue)\s+(?:is\s+)?open\b/i.test(body) ||
    /\b(?:awaiting|blocked by|waiting for)\b/i.test(body) ||
    /\b(?:remains?|still)\s+(?:blocked|open|pending)\b/i.test(body) ||
    /^\s*(?:[-*]\s+)?(?:blocked|blocker|pending)\s*:/im.test(body)
  );
}

function handoffBodyFields(body: string): Map<string, string[]> {
  const lines = body.split(/\r?\n/);
  const fields = new Map<string, string[]>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripHandoffBullet((lines[index] ?? '').trim());
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const name = line.slice(0, colon);
    if (!/^(?:status|next_step|blockers?)$/i.test(name)) {
      continue;
    }
    const key = name.toLowerCase();
    let value = line.slice(colon + 1).trim();
    if (/[\r\u2028\u2029]/.test(value)) {
      continue;
    }
    if (!value) {
      let followingLine = '';
      for (let followingIndex = index + 1; followingIndex < lines.length; followingIndex += 1) {
        followingLine = lines[followingIndex].trim();
        if (followingLine) break;
      }
      if (followingLine && !isHandoffHeader(followingLine)) {
        value = stripHandoffBullet(followingLine);
      }
    }
    const values = fields.get(key) ?? [];
    values.push(value);
    fields.set(key, values);
  }
  return fields;
}

function stripHandoffBullet(line: string): string {
  return (line[0] === '-' || line[0] === '*') && line.length > 1 && line[1].trim().length === 0
    ? line.slice(1).trimStart()
    : line;
}

function isHandoffHeader(line: string): boolean {
  const colon = line.indexOf(':');
  if (colon < 0) return false;
  const prefix = line.slice(0, colon);
  if (/^[\w -]+$/.test(prefix.trimEnd())) return true;
  if ((prefix[0] !== '-' && prefix[0] !== '*') || prefix.length < 2 || prefix[1].trim().length !== 0) {
    return false;
  }
  const remainder = prefix.slice(2);
  const label = remainder.trim();
  return label ? /^[\w -]+$/.test(label) : remainder.includes(' ');
}

function normalizedFieldValues(values: readonly string[] | undefined): readonly string[] {
  return (values ?? [])
    .map(value => trimTrailingCharacters(value.trim().toLowerCase(), '.!;:').replace(/\s+/g, ' '))
    .filter(value => value.length > 0);
}

function buildMergeReviewProposals(records: readonly GroupedRecord[]): readonly MergeReviewProposal[] {
  const groups = new Map<string, GroupedRecord[]>();
  for (const item of records) {
    if (!item.topic) {
      continue;
    }
    const key = [item.project, item.topic].join('\0');
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const proposals: MergeReviewProposal[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first?.topic || group.length < 2) {
      continue;
    }
    const reasons: string[] = [];
    const kinds = new Set(group.map(item => item.record.metadata.kind));
    const memoryScopes = new Set(group.map(item => item.memoryScope));
    const workspaceScopes = new Set(group.map(item => item.workspaceScope ?? '<repo>'));
    if (kinds.size > 1) {
      reasons.push('same project/topic spans multiple memory kinds');
    }
    if (memoryScopes.size > 1) {
      reasons.push('same project/topic spans multiple memory scopes');
    }
    if (workspaceScopes.size > 1) {
      reasons.push('same project/topic spans multiple workspace scopes');
    }
    for (const kind of ['durable', 'incident'] as const) {
      const sameKind = group.filter(item => item.record.metadata.kind === kind);
      if (sameKind.length > 1 && new Set(sameKind.map(item => comparableMemoryBody(item.record.body))).size > 1) {
        reasons.push(`divergent active ${kind} memories`);
      }
    }
    if (reasons.length === 0) {
      continue;
    }
    proposals.push({
      project: first.project,
      reason: reasons.sort().join('; '),
      sourceUris: sortedUniqueUris(group.map(item => item.record.uri)),
      topic: first.topic,
    });
  }
  return proposals.sort(compareMergeReviewProposals);
}

function memoryScopeForUri(uri: string): string {
  const canonicalUri = canonicalResourceInput(uri) ?? uri;
  const shared = /^threadnote:\/\/user\/[^/]+\/memories\/shared\/([^/]+)\//.exec(canonicalUri)?.[1];
  if (shared) {
    return `shared:${shared}`;
  }
  const personal = /^threadnote:\/\/user\/([^/]+)\/memories\//.exec(canonicalUri)?.[1];
  return personal ? `personal:${personal}` : `external:${canonicalUri}`;
}

function isPersonalMemoryUri(uri: string): boolean {
  const canonicalUri = canonicalResourceInput(uri);
  if (!canonicalUri || isSharedMemoryUri(canonicalUri)) {
    return false;
  }
  return /^threadnote:\/\/user\/[^/]+\/memories\/(?:durable\/projects|handoffs\/active|incidents\/active)\//.test(
    canonicalUri,
  );
}

function groupBy<T>(values: readonly T[], keyForValue: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyForValue(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function compareGroupedRecordLists(left: readonly GroupedRecord[], right: readonly GroupedRecord[]): number {
  return (left[0]?.groupKey ?? '').localeCompare(right[0]?.groupKey ?? '');
}

function compareGroupedRecords(left: GroupedRecord, right: GroupedRecord): number {
  return left.groupKey.localeCompare(right.groupKey) || left.record.uri.localeCompare(right.record.uri);
}

function compareMergeReviewProposals(left: MergeReviewProposal, right: MergeReviewProposal): number {
  return (
    left.project.localeCompare(right.project) ||
    left.topic.localeCompare(right.topic) ||
    left.sourceUris.join('\0').localeCompare(right.sourceUris.join('\0')) ||
    left.reason.localeCompare(right.reason)
  );
}

function dedupeByUri<T extends {readonly uri: string}>(items: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.uri)) {
      continue;
    }
    seen.add(item.uri);
    result.push(item);
  }
  return result;
}

function sortByUri<T extends {readonly uri: string}>(items: readonly T[]): readonly T[] {
  return [...items].sort((left, right) => left.uri.localeCompare(right.uri));
}

function sortedUniqueUris(uris: readonly string[]): readonly string[] {
  return [...new Set(uris)].sort((left, right) => left.localeCompare(right));
}

function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isCompactableKind(kind: MemoryKind): kind is CompactableMemoryKind {
  return kind === 'durable' || kind === 'handoff' || kind === 'incident';
}

function memoryKindPlural(kind: MemoryKind): string {
  switch (kind) {
    case 'handoff':
      return 'handoffs';
    case 'incident':
      return 'incidents';
    case 'durable':
      return 'durable memories';
    case 'preference':
      return 'preferences';
    case 'smoke':
      return 'smoke memories';
  }
}

function formatPlanSection(title: string, lines: readonly string[]): string {
  if (lines.length === 0) {
    return `${title} (0):\n- none`;
  }
  const preview = lines.slice(0, COMPACT_PLAN_SECTION_PREVIEW_LIMIT);
  const omitted = lines.length - preview.length;
  return [
    `${title} (${lines.length}):`,
    ...preview.map(line => `- ${line}`),
    ...(omitted > 0 ? [`- … ${omitted} more omitted; narrow the plan with kind or topic`] : []),
  ].join('\n');
}

function formatPlanAction(uri: string, reason: string, sourceUris: readonly string[]): string {
  return `${uri} (${reason}; sources: ${sourceUris.join(', ')})`;
}

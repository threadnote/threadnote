import {Array as EffectArray, Option as EffectOption} from 'effect';
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
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

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

/** Earliest future handoff-age threshold used by buildCompactPlan. */
export function nextCompactPlanClockBoundary(
  records: readonly MemoryRecord[],
  project: string,
  now: Date,
): number | undefined {
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) return undefined;
  let next: number | undefined;
  for (const record of records) {
    const grouped = groupableRecord(record);
    if (
      grouped?.project !== project ||
      record.metadata.kind !== 'handoff' ||
      !isPersonalMemoryUri(record.uri) ||
      hasExpiredValidity(record, now)
    )
      continue;
    const observedAt = memoryObservedAt(record);
    if (observedAt === undefined) continue;
    for (const age of [HANDOFF_TERMINAL_RETENTION_MS, HANDOFF_REVIEW_AGE_MS, HANDOFF_MAXIMUM_ACTIVE_AGE_MS]) {
      const boundary = observedAt + age;
      if (Number.isFinite(boundary) && boundary > nowMilliseconds && (next === undefined || boundary < next))
        next = boundary;
    }
  }
  return next;
}

export function buildCompactPlan(records: readonly MemoryRecord[], options: CompactPlanOptions): CompactPlan {
  const now = options.now ?? new Date();
  const groupedRecords = EffectArray.filter(
    EffectArray.filter(
      EffectArray.filter(
        EffectArray.filter(
          EffectArray.map(records, record => groupableRecord(record)),
          (item): item is GroupedRecord => item !== undefined,
        ),
        item => item.project === options.project,
      ),
      item => options.topic === undefined || item.topic === options.topic,
    ),
    item => options.kind === undefined || item.record.metadata.kind === options.kind,
  ).sort(compareGroupedRecords);

  const mergeReviewProposals = buildMergeReviewProposals(groupedRecords);
  const mutableRecords = EffectArray.filter(
    groupedRecords,
    (item, __effectArrayIndex2) => __effectArrayIndex2 in groupedRecords && isPersonalMemoryUri(item.record.uri),
  );
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
  for (const item of EffectArray.filter(
    mutableRecords,
    candidate => !claimedMutationUris.has(candidate.record.uri) && !protectedReviewUris.has(candidate.record.uri),
  )) {
    groups.set(item.groupKey, [...(groups.get(item.groupKey) ?? []), item]);
  }

  for (const group of [...groups.values()].sort(compareGroupedRecordLists)) {
    const recordsInGroup = EffectArray.map(group, item => item.record);
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
      if (!EffectArray.every(duplicateGroup, record => hasEquivalentMemoryMetadata(record, metadataReference))) {
        for (const record of duplicateGroup) {
          duplicateMetadataConflictUris.add(record.uri);
          addManualReview(
            EffectOption.getOrUndefined(EffectArray.findFirst(group, item => item.record.uri === record.uri))!,
            'same body has distinct metadata or provenance; no automatic retirement',
          );
        }
        continue;
      }
      const duplicateKeep = preferredKeepRecord(duplicateGroup, topic);
      for (const duplicate of EffectArray.filter(
        sortedNewestFirst(duplicateGroup),
        record => record.uri !== duplicateKeep.uri,
      )) {
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

    const remainingRecords = EffectArray.filter(
      recordsInGroup,
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
      for (const record of EffectArray.filter(sortedNewestFirst(remainingRecords), item => item.uri !== keep.uri)) {
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
    EffectArray.join(
      [
        body,
        '',
        MEMORY_HYGIENE_SOURCES_MARKER,
        MEMORY_HYGIENE_SOURCES_HEADING,
        '',
        ...EffectArray.map(uniqueSourceUris, uri => `- ${uri}`),
      ],
      '\n',
    ),
  );
}

export function formatCompactPlan(plan: CompactPlan, options: {readonly apply: boolean}): string {
  const scope = EffectArray.join(
    EffectArray.filter(
      [
        `project ${plan.options.project}`,
        plan.options.topic ? `topic ${plan.options.topic}` : undefined,
        plan.options.kind ? `kind ${plan.options.kind}` : undefined,
      ],
      (item): item is string => item !== undefined,
    ),
    ', ',
  );
  const lines = [
    `${options.apply ? 'Applying' : 'Dry-run'} memory hygiene plan for ${scope}`,
    `Records scanned: ${plan.recordsScanned}`,
    '',
    formatPlanSection(
      'Keep/update',
      EffectArray.map(plan.keepUpdates, action => formatPlanAction(action.uri, action.reason, action.sourceUris)),
    ),
    formatPlanSection(
      'Archive expired/stale active memories',
      EffectArray.map(plan.archives, action => formatPlanAction(action.uri, action.reason, action.sourceUris)),
    ),
    formatPlanSection(
      'Forget exact duplicates',
      EffectArray.map(plan.forgets, action => formatPlanAction(action.uri, action.reason, action.sourceUris)),
    ),
    formatPlanSection(
      'Manual review',
      EffectArray.map(plan.manualReview, item => `${item.uri} (${item.reason})`),
    ),
    formatPlanSection(
      'Merge/review proposals',
      EffectArray.map(plan.mergeReviewProposals, proposal =>
        formatPlanAction(`${proposal.project}/${proposal.topic}`, proposal.reason, proposal.sourceUris),
      ),
    ),
  ];
  if (!options.apply) {
    lines.push('', 'No changes made. Re-run with --apply to execute this plan.');
  }
  return EffectArray.join(lines, '\n');
}

export function recallHygieneNudges(
  text: string,
  options: {readonly records?: readonly MemoryRecord[]; readonly user: string},
): readonly string[] {
  const activeUris = activePersonalMemoryUrisFromText(text, options.user);
  const nudges: string[] = [];
  const returnedUriSet = new Set(activeUris);
  const returnedRecords =
    EffectOption.getOrUndefined(
      EffectOption.map(EffectOption.fromNullishOr(options.records), records =>
        EffectArray.map(
          EffectArray.filter(
            records,
            (record, __effectArrayIndex) => __effectArrayIndex in records && returnedUriSet.has(record.uri),
          ),
          record => groupableRecord(record),
        ),
      ),
    ) ?? [];
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
  for (const [project, count] of [...projectCounts.entries()].sort(([left], [right]) =>
    Effect.pipe(left, EffectString.localeCompare(right)),
  )) {
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
      if (seen.has(uri) || Effect.pipe(recallOutput, EffectString.includes(uri))) {
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
  const existing = new Set(EffectArray.map(records, record => record.uri));
  return EffectArray.filter(
    candidates,
    (uri, __effectArrayIndex) => __effectArrayIndex in candidates && existing.has(uri),
  );
}

/** Renders bounded one-way reference pointers without inlining another memory. */
export function formatReferencedContextPointers(uris: readonly string[], maxUris: number): string | undefined {
  if (uris.length === 0) {
    return undefined;
  }
  const capped = uris.slice(0, maxUris);
  const lines = [
    'Referenced read-only context (one-way pointers from surfaced memories):',
    ...EffectArray.map(capped, uri => `- ${uri}`),
  ];
  if (uris.length > capped.length) {
    const omitted = uris.length - capped.length;
    lines.push(`- … ${omitted} more referenced ${omitted === 1 ? 'memory' : 'memories'} omitted`);
  }
  return EffectArray.join(lines, '\n');
}

export function activePersonalMemoryUrisFromText(text: string, user: string): readonly string[] {
  const userSegment = uriSegment(user);
  const matches = Effect.pipe(text, EffectString.matchAll(/(?:threadnote|viking):\/\/[^\s)]+/g));
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
  if (!Effect.pipe(canonicalUri, EffectString.startsWith(prefix)) || isSharedMemoryUri(canonicalUri)) {
    return undefined;
  }
  const rest = Effect.pipe(canonicalUri, EffectString.slice(prefix.length));
  const parts = EffectArray.filter(Effect.pipe(rest, EffectString.split('/')), Boolean);
  if (parts.length < 4) {
    return undefined;
  }
  if (
    parts[0] === 'handoffs' &&
    parts[1] === 'active' &&
    parts[2] &&
    Effect.pipe(parts[3], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.endsWith('.md')),
    )
  ) {
    return {
      kind: 'handoff',
      project: parts[2],
      status: 'active',
      topic: Effect.pipe(parts[3], EffectString.replace(/\.md$/, '')),
    };
  }
  if (
    parts[0] === 'durable' &&
    parts[1] === 'projects' &&
    parts[2] &&
    Effect.pipe(parts[3], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.endsWith('.md')),
    )
  ) {
    return {
      kind: 'durable',
      project: parts[2],
      status: 'active',
      topic: Effect.pipe(parts[3], EffectString.replace(/\.md$/, '')),
    };
  }
  if (
    parts[0] === 'incidents' &&
    parts[1] === 'active' &&
    parts[2] &&
    Effect.pipe(parts[3], effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.endsWith('.md')),
    )
  ) {
    return {
      kind: 'incident',
      project: parts[2],
      status: 'active',
      topic: Effect.pipe(parts[3], EffectString.replace(/\.md$/, '')),
    };
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
  const groupKey = EffectArray.join(
    [memoryScope, record.metadata.kind, project, workspaceScope ?? '<repo>', topic ?? record.uri],
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
  const branchLine = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      Effect.pipe(body, EffectString.split(/\r?\n/u)),
      __effectArrayValue => !!(line => Effect.pipe(line, EffectString.startsWith('branch:')))(__effectArrayValue),
    ),
  );
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional chaining through branch parsing.
  const branch = branchLine?.slice('branch:'.length).trim();
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve optional chaining for the optional branch value.
  const firstToken = branch?.split(/\s+/)[0];
  return firstToken ? trimTrailingCharacters(firstToken, '.,;:') : undefined;
}

function topicFromUri(uri: string): string | undefined {
  const name = Effect.pipe(uriBasename(uri), EffectString.replace(/\.md$/, ''));
  return Effect.pipe(name, EffectString.startsWith('threadnote-')) ? undefined : name;
}

function parseProjectFromUri(uri: string): string | undefined {
  const parts =
    EffectOption.getOrUndefined(
      EffectOption.map(
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve the optional URI split and its fallback.
        EffectOption.fromNullishOr(uri.split('/memories/')[1]?.split('/')),
        __effectOptionalArrayReceiver => EffectArray.filter(__effectOptionalArrayReceiver, Boolean),
      ),
    ) ?? [];
  if ((parts[0] === 'handoffs' || parts[0] === 'incidents') && parts[1] === 'active') {
    return parts[2];
  }
  if (parts[0] === 'durable' && parts[1] === 'projects') {
    return parts[2];
  }
  return undefined;
}

function comparableMemoryBody(body: string): string {
  return Effect.pipe(stripHygieneSources(body), EffectString.replace(/\r\n?/g, '\n'));
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
  return sortedUniqueUris(EffectArray.flatMap(records, record => [record.uri, ...hygieneSourceUris(record.body)]));
}

function stripHygieneSources(body: string): string {
  const parsed = parseMemoryHygieneSources(body);
  return parsed ? parsed.body : body;
}

function preferredKeepRecord(records: readonly MemoryRecord[], topic?: string): MemoryRecord {
  const newestFirst = sortedNewestFirst(records);
  const newestTimestamp = timestampMs(newestFirst[0] ?? records[0]);
  const equallyNew = EffectArray.filter(newestFirst, record => timestampMs(record) === newestTimestamp);
  return (
    EffectOption.getOrUndefined(
      EffectArray.findFirst(
        equallyNew,
        __effectArrayValue => !!(record => isStableRecord(record, topic))(__effectArrayValue),
      ),
    ) ??
    equallyNew[0] ??
    records[0]
  );
}

function isStableRecord(record: MemoryRecord, topic?: string): boolean {
  const recordTopic = topic ?? topicForRecord(record);
  return recordTopic !== undefined && uriBasename(record.uri) === `${uriSegment(recordTopic)}.md`;
}

function uriBasename(uri: string): string {
  return Effect.pipe(uri, EffectString.replaceAll('\\', '/'), EffectString.split('/')).at(-1) ?? uri;
}

function sortedNewestFirst<T extends MemoryRecord>(records: readonly T[]): readonly T[] {
  return [...records].sort((left, right) => {
    const timestampDiff = timestampMs(right) - timestampMs(left);
    return timestampDiff === 0 ? Effect.pipe(left.uri, EffectString.localeCompare(right.uri)) : timestampDiff;
  });
}

function timestampMs(record: MemoryRecord): number {
  const parsed = Date.parse(record.metadata.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function memoryAgeMilliseconds(record: MemoryRecord, now: Date): number | undefined {
  const nowMilliseconds = now.getTime();
  const observedAt = memoryObservedAt(record);
  if (!Number.isFinite(nowMilliseconds) || observedAt === undefined || observedAt > nowMilliseconds) {
    return undefined;
  }
  return nowMilliseconds - observedAt;
}

function memoryObservedAt(record: MemoryRecord): number | undefined {
  const observations = EffectArray.filter(
    [
      parseTimestamp(record.metadata.timestamp),
      parseTimestamp(record.metadata.updatedAt),
      parseTimestamp(record.metadata.lastReviewed),
    ],
    (value): value is number => value !== undefined,
  );
  return observations.length > 0 ? Math.max(...observations) : undefined;
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
  return EffectArray.some(statuses, status => TERMINAL_HANDOFF_STATUSES.has(status)) || nextSteps.includes('none');
}

function hasExplicitPendingHandoffState(body: string): boolean {
  const fields = handoffBodyFields(body);
  const statuses = normalizedFieldValues(fields.get('status'));
  const nextSteps = normalizedFieldValues(fields.get('next_step'));
  const blockers = normalizedFieldValues([...(fields.get('blockers') ?? []), ...(fields.get('blocker') ?? [])]);
  if (
    EffectArray.some(statuses, status =>
      /^(?:active|awaiting(?: .+)?|blocked|in[ _-]?progress|open|pending|waiting(?: .+)?)$/.test(status),
    )
  ) {
    return true;
  }
  if (EffectArray.some(nextSteps, nextStep => nextStep !== 'none' && nextStep !== DEFAULT_HANDOFF_NEXT_STEP)) {
    return true;
  }
  if (
    EffectArray.some(
      blockers,
      blocker => !/^(?:n\/?a|no(?:\s+blockers?)?|none(?:\s+recorded)?|not\s+applicable)$/.test(blocker),
    )
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
  const lines = Effect.pipe(body, EffectString.split(/\r?\n/));
  const fields = new Map<string, string[]>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripHandoffBullet(Effect.pipe(lines[index] ?? '', EffectString.trim));
    const colon = Effect.pipe(
      line,
      EffectString.indexOf(':'),
      Effect.Option.getOrElse(() => -1),
    );
    if (colon < 0) {
      continue;
    }
    const name = Effect.pipe(line, EffectString.slice(0, colon));
    if (!/^(?:status|next_step|blockers?)$/i.test(name)) {
      continue;
    }
    const key = Effect.pipe(name, EffectString.toLowerCase);
    let value = Effect.pipe(line, EffectString.slice(colon + 1), EffectString.trim);
    if (/[\r\u2028\u2029]/.test(value)) {
      continue;
    }
    if (!value) {
      let followingLine = '';
      for (let followingIndex = index + 1; followingIndex < lines.length; followingIndex += 1) {
        followingLine = Effect.pipe(lines[followingIndex], EffectString.trim);
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
  return (line[0] === '-' || line[0] === '*') && line.length > 1 && Effect.pipe(line[1], EffectString.trim).length === 0
    ? Effect.pipe(line, EffectString.slice(1), EffectString.trimStart)
    : line;
}

function isHandoffHeader(line: string): boolean {
  const colon = Effect.pipe(
    line,
    EffectString.indexOf(':'),
    Effect.Option.getOrElse(() => -1),
  );
  if (colon < 0) return false;
  const prefix = Effect.pipe(line, EffectString.slice(0, colon));
  if (/^[\w -]+$/.test(Effect.pipe(prefix, EffectString.trimEnd))) return true;
  if (
    (prefix[0] !== '-' && prefix[0] !== '*') ||
    prefix.length < 2 ||
    Effect.pipe(prefix[1], EffectString.trim).length !== 0
  ) {
    return false;
  }
  const remainder = Effect.pipe(prefix, EffectString.slice(2));
  const label = Effect.pipe(remainder, EffectString.trim);
  return label ? /^[\w -]+$/.test(label) : Effect.pipe(remainder, EffectString.includes(' '));
}

function normalizedFieldValues(values: readonly string[] | undefined): readonly string[] {
  return EffectArray.filter(
    EffectArray.map(values ?? [], value =>
      Effect.pipe(
        trimTrailingCharacters(Effect.pipe(value, EffectString.trim, EffectString.toLowerCase), '.!;:'),
        EffectString.replace(/\s+/g, ' '),
      ),
    ),
    value => value.length > 0,
  );
}

function buildMergeReviewProposals(records: readonly GroupedRecord[]): readonly MergeReviewProposal[] {
  const groups = new Map<string, GroupedRecord[]>();
  for (const item of records) {
    if (!item.topic) {
      continue;
    }
    const key = EffectArray.join([item.project, item.topic], '\0');
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const proposals: MergeReviewProposal[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first?.topic || group.length < 2) {
      continue;
    }
    const reasons: string[] = [];
    const kinds = new Set(EffectArray.map(group, item => item.record.metadata.kind));
    const memoryScopes = new Set(EffectArray.map(group, item => item.memoryScope));
    const workspaceScopes = new Set(EffectArray.map(group, item => item.workspaceScope ?? '<repo>'));
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
      const sameKind = EffectArray.filter(group, item => item.record.metadata.kind === kind);
      if (
        sameKind.length > 1 &&
        new Set(EffectArray.map(sameKind, item => comparableMemoryBody(item.record.body))).size > 1
      ) {
        reasons.push(`divergent active ${kind} memories`);
      }
    }
    if (reasons.length === 0) {
      continue;
    }
    proposals.push({
      project: first.project,
      reason: EffectArray.join(reasons.sort(), '; '),
      sourceUris: sortedUniqueUris(EffectArray.map(group, item => item.record.uri)),
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
  return Effect.pipe(left[0]?.groupKey ?? '', EffectString.localeCompare(right[0]?.groupKey ?? ''));
}

function compareGroupedRecords(left: GroupedRecord, right: GroupedRecord): number {
  return (
    Effect.pipe(left.groupKey, EffectString.localeCompare(right.groupKey)) ||
    Effect.pipe(left.record.uri, EffectString.localeCompare(right.record.uri))
  );
}

function compareMergeReviewProposals(left: MergeReviewProposal, right: MergeReviewProposal): number {
  return (
    Effect.pipe(left.project, EffectString.localeCompare(right.project)) ||
    Effect.pipe(left.topic, EffectString.localeCompare(right.topic)) ||
    Effect.pipe(
      EffectArray.join(left.sourceUris, '\0'),
      EffectString.localeCompare(EffectArray.join(right.sourceUris, '\0')),
    ) ||
    Effect.pipe(left.reason, EffectString.localeCompare(right.reason))
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
  return [...items].sort((left, right) => Effect.pipe(left.uri, EffectString.localeCompare(right.uri)));
}

function sortedUniqueUris(uris: readonly string[]): readonly string[] {
  return [...new Set(uris)].sort((left, right) => Effect.pipe(left, EffectString.localeCompare(right)));
}

function normalizeOptionalMetadata(value: string | undefined): string | undefined {
  const trimmed = Effect.pipe(value, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
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
  return EffectArray.join(
    [
      `${title} (${lines.length}):`,
      ...EffectArray.map(preview, line => `- ${line}`),
      ...(omitted > 0 ? [`- … ${omitted} more omitted; narrow the plan with kind or topic`] : []),
    ],
    '\n',
  );
}

function formatPlanAction(uri: string, reason: string, sourceUris: readonly string[]): string {
  return `${uri} (${reason}; sources: ${EffectArray.join(sourceUris, ', ')})`;
}

import {Effect} from 'effect';
import {
  CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION,
  compareContextHealthSemanticClaimWindow,
  extractContextHealthSemanticClaims,
  type ContextHealthSemanticUnknownReasonV2,
} from '@threadnote/context/health_semantic';
import {buildContextHealthReport, semanticFindings} from '@threadnote/context/health';
import {listCandidateReviews} from '@threadnote/memory/candidate';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '@threadnote/memory/document';
import {contextHealthCaseIdV2, contextHealthFindingCaseIdentityV2} from '@threadnote/context/health_maintenance';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readMemoryRecordsByUri, readMemoryRecordsByUriWithSourceHash} from '../../mcp/server/memory.js';
import {upsertCase} from './maintenance_policy.js';
import {
  advanceContextMaintenanceEvidenceRequestExecution,
  pendingContextMaintenanceEvidenceRoots,
  type ContextMaintenanceEvidenceRequestDiscovery,
  type ContextMaintenanceEvidenceRequestPage,
} from './maintenance_evidence.js';
import type {ContextMaintenanceCaseV2, MaintenanceState} from './maintenance.js';
import {reviewedSemanticContradictionIds} from './semantic_review_state.js';

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
  let remainder = cursor % maintenanceSemanticWindowCount(records.length);
  let left = 0;
  while (remainder >= blocks - left) remainder -= blocks - left++;
  const right = left + remainder;
  return {
    records: [
      ...new Set([...records.slice(left * 64, (left + 1) * 64), ...records.slice(right * 64, (right + 1) * 64)]),
    ],
    totalBatches: maintenanceSemanticWindowCount(records.length),
  };
}

export interface SemanticRecordProgress {
  readonly uri: string;
  readonly hash: string;
  readonly removed?: boolean;
  readonly claims?: number;
  readonly unsupportedClaims?: number;
  readonly reasons?: readonly ContextHealthSemanticUnknownReasonV2[];
}

export interface SemanticComparisonProgress {
  readonly pairCursor: number;
  readonly claimCursor: number;
  readonly seenCaseIds: readonly string[];
  readonly seenOverflow?: boolean;
}

export interface MaintenanceSemanticProgress {
  readonly version: 2;
  readonly analyzerVersion: number;
  readonly generation: string;
  readonly cursor: number;
  readonly totalBatches: number;
  readonly eligibleRecords: number;
  readonly records: readonly SemanticRecordProgress[];
  readonly comparison: SemanticComparisonProgress;
  readonly dirty: readonly {
    readonly uri: string;
    readonly otherCursor: number;
    readonly claimCursor: number;
    readonly seenCaseIds: readonly string[];
    readonly seenOverflow?: boolean;
  }[];
  readonly comparedClaimPairs: number;
  readonly churnCount: number;
  readonly outputOmittedFindings: number;
  readonly omissionPairs?: readonly {
    readonly key: string;
    readonly leftUri: string;
    readonly leftHash: string;
    readonly rightUri: string;
    readonly rightHash: string;
    readonly count: number;
  }[];
  readonly omissionPairsOverflow?: boolean;
}

interface SemanticOutputBudget {
  remainingBytes: number;
  retained: number;
  readonly byProject: Map<string, number>;
}

const MAX_OMISSION_PAIRS = 1_024;
const MAX_OMISSION_LEDGER_BYTES = 256 * 1_024;

export function maintenanceSemanticOutputBudget(
  cases: ReadonlyMap<string, ContextMaintenanceCaseV2>,
  availableStateBytes: number,
): SemanticOutputBudget {
  const byProject = new Map<string, number>();
  let retained = 0;
  for (const item of cases.values()) {
    if (item.family !== 'semantic-contradiction') continue;
    retained += 1;
    if (item.disposition !== 'historical') byProject.set(item.project, (byProject.get(item.project) ?? 0) + 1);
  }
  return {remainingBytes: Math.max(0, Math.min(2 * 1_024 * 1_024, availableStateBytes)), retained, byProject};
}

export function maintenanceSemanticRecordPairAt(index: number, count: number): readonly [number, number] {
  let lower = 0;
  let upper = count - 1;
  const rowStart = (row: number) => (row * (2 * count - row - 1)) / 2;
  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (rowStart(middle) <= index) lower = middle;
    else upper = middle;
  }
  const left = rowStart(upper) <= index ? upper : lower;
  return [left, count - 1 - (index - rowStart(left))];
}

function semanticPairCount(count: number): number {
  return (count * (count - 1)) / 2;
}

export function maintenanceSemanticProgressPending(progress: MaintenanceSemanticProgress): boolean {
  return (
    progress.comparison.pairCursor < semanticPairCount(progress.records.length) ||
    progress.dirty.length > 0 ||
    progress.records.some(record => !record.removed && record.claims === undefined)
  );
}

export function maintenanceSemanticProgressUnsupported(progress: MaintenanceSemanticProgress): boolean {
  return (
    progress.outputOmittedFindings > 0 ||
    progress.records.some(record => !record.removed && (record.reasons?.length ?? 0) > 0)
  );
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
  inventoryComplete = true,
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
        JSON.stringify([
          CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION,
          active
            .filter(record => record.metadata.project === project && record.metadata.kind === 'durable')
            .map(record => `${record.uri}:${hashes.get(record.uri)}`)
            .sort(),
        ]),
      ),
    ]),
  );
  const progress: Record<string, MaintenanceSemanticProgress> = Object.fromEntries(
    Object.entries(previous ?? {}).filter(
      ([project]) => (projectScope !== undefined && project !== projectScope) || projects.includes(project),
    ),
  );
  for (const project of projects) {
    const generation = generations.get(project)!;
    const eligible = active.filter(record => record.metadata.kind === 'durable' && record.metadata.project === project);
    const current = new Map(
      eligible.map(record => [
        record.uri,
        {
          hash: hashes.get(record.uri) ?? record.content,
        },
      ]),
    );
    const old = progress[project];
    if (
      old?.version === 2 &&
      old.analyzerVersion === CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION &&
      old.generation === generation
    )
      continue;
    const reusable = old?.version === 2 && old.analyzerVersion === CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION;
    const records: SemanticRecordProgress[] = reusable ? [...old.records] : [];
    const dirty = reusable ? [...old.dirty] : [];
    let churnCount = reusable ? old.churnCount : 0;
    for (let index = 0; index < records.length; index += 1) {
      const item = records[index];
      const revision = current.get(item.uri);
      if (revision === undefined) {
        if (!inventoryComplete) continue;
        if (!item.removed) churnCount += 1;
        records[index] = {...item, removed: true};
        continue;
      }
      current.delete(item.uri);
      if (revision.hash === item.hash && !item.removed) continue;
      churnCount += 1;
      records[index] = {uri: item.uri, ...revision};
      const previousDirty = dirty.findIndex(entry => entry.uri === item.uri);
      if (previousDirty >= 0) dirty.splice(previousDirty, 1);
      dirty.push({uri: item.uri, otherCursor: 0, claimCursor: 0, seenCaseIds: []});
    }
    for (const [uri, revision] of [...current].sort(([a], [b]) => a.localeCompare(b))) {
      records.push({uri, ...revision});
      if (reusable) {
        churnCount += 1;
        dirty.push({uri, otherCursor: 0, claimCursor: 0, seenCaseIds: []});
      }
    }
    const retainedOmissions = reusable
      ? (old.omissionPairs ?? []).filter(
          pair =>
            (hashes.get(pair.leftUri) === undefined
              ? !inventoryComplete
              : hashes.get(pair.leftUri) === pair.leftHash) &&
            (hashes.get(pair.rightUri) === undefined
              ? !inventoryComplete
              : hashes.get(pair.rightUri) === pair.rightHash),
        )
      : [];
    const resetOmissions =
      reusable && old.outputOmittedFindings > 0 && (old.omissionPairsOverflow || !old.omissionPairs);
    progress[project] = {
      version: 2,
      analyzerVersion: CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION,
      generation,
      cursor: reusable && !resetOmissions ? old.cursor : 0,
      totalBatches: Math.max(1, semanticPairCount(records.length)),
      eligibleRecords: eligible.length,
      records,
      comparison: reusable && !resetOmissions ? old.comparison : {pairCursor: 0, claimCursor: 0, seenCaseIds: []},
      dirty: reusable && !resetOmissions ? dirty : [],
      comparedClaimPairs: reusable ? old.comparedClaimPairs : 0,
      churnCount,
      outputOmittedFindings: resetOmissions ? 0 : retainedOmissions.reduce((sum, pair) => sum + pair.count, 0),
      omissionPairs: resetOmissions ? [] : retainedOmissions,
      omissionPairsOverflow: false,
    };
  }
  const pending = projects.filter(project => maintenanceSemanticProgressPending(progress[project]));
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

function recordSemanticOutputOmissions(
  progress: MaintenanceSemanticProgress,
  left: SemanticRecordProgress,
  right: SemanticRecordProgress,
  startingPair: boolean,
  omitted: number,
  output: SemanticOutputBudget,
) {
  const [first, second] = [left, right].sort((a, b) => a.uri.localeCompare(b.uri));
  const key = sha256HexSync(`${first.uri}\0${second.uri}`);
  const previous = progress.omissionPairs ?? [];
  const prior = previous.find(pair => pair.key === key);
  const omissionPairs = startingPair ? previous.filter(pair => pair.key !== key) : [...previous];
  const outputOmittedFindings = Math.max(
    0,
    progress.outputOmittedFindings - (startingPair ? (prior?.count ?? 0) : 0) + omitted,
  );
  let omissionPairsOverflow = progress.omissionPairsOverflow === true;
  if (omitted > 0) {
    const existing = omissionPairs.findIndex(pair => pair.key === key);
    if (existing >= 0) {
      const old = omissionPairs[existing];
      const updated = {...old, count: old.count + omitted};
      const addedBytes =
        new TextEncoder().encode(JSON.stringify(updated)).length - new TextEncoder().encode(JSON.stringify(old)).length;
      if (addedBytes <= output.remainingBytes) {
        omissionPairs[existing] = updated;
        output.remainingBytes -= addedBytes;
      } else {
        omissionPairs.splice(existing, 1);
        omissionPairsOverflow = true;
      }
    } else {
      const entry = {
        key,
        leftUri: first.uri,
        leftHash: first.hash,
        rightUri: second.uri,
        rightHash: second.hash,
        count: omitted,
      };
      const encoder = new TextEncoder();
      const ledgerBytes = omissionPairs.reduce((sum, pair) => sum + encoder.encode(JSON.stringify(pair)).length, 0);
      const entryBytes = encoder.encode(JSON.stringify(entry)).length + 1;
      if (
        omissionPairs.length < MAX_OMISSION_PAIRS &&
        ledgerBytes + entryBytes < MAX_OMISSION_LEDGER_BYTES &&
        entryBytes <= output.remainingBytes
      ) {
        omissionPairs.push(entry);
        output.remainingBytes -= entryBytes;
      } else omissionPairsOverflow = true;
    }
  }
  return {omissionPairs, omissionPairsOverflow, outputOmittedFindings};
}

const runMaintenanceSemanticStep = Effect.fn('contextMaintenance.semanticStep')(function* (
  config: RuntimeConfig,
  project: string,
  progress: MaintenanceSemanticProgress,
  cases: Map<string, ContextMaintenanceCaseV2>,
  now: string,
  budget: number,
  output: SemanticOutputBudget,
) {
  const records = [...progress.records];
  const dirty = [...progress.dirty];
  const totalPairs = semanticPairCount(records.length);
  const main = progress.comparison.pairCursor < totalPairs;
  const activeDirty = !main ? dirty[0] : undefined;
  const pairIndex = main ? maintenanceSemanticRecordPairAt(progress.comparison.pairCursor, records.length) : undefined;
  const dirtyIndex = activeDirty === undefined ? -1 : records.findIndex(item => item.uri === activeDirty.uri);
  const otherIndex = activeDirty?.otherCursor ?? -1;
  const selected =
    pairIndex ?? (dirtyIndex >= 0 && otherIndex < records.length ? ([dirtyIndex, otherIndex] as const) : undefined);
  if (selected === undefined) {
    if (activeDirty !== undefined) {
      dirty.shift();
      return {...progress, dirty};
    }
    const index = records.findIndex(record => !record.removed && record.claims === undefined);
    if (index >= 0) {
      const [source] = yield* readMemoryRecordsByUriWithSourceHash(config, [records[index].uri]);
      if (source === undefined || source.sourceHash !== records[index].hash) return progress;
      const extracted = extractContextHealthSemanticClaims(source.record);
      records[index] = {
        ...records[index],
        claims: extracted.claims.length,
        unsupportedClaims: extracted.claims.filter(claim => claim.extraction === 'unsupported').length,
        reasons: extracted.reasons,
      };
    }
    return {...progress, records, cursor: Math.max(progress.cursor, records.length === 1 ? 1 : 0)};
  }
  const [leftIndex, rightIndex] = selected;
  if (leftIndex === rightIndex || records[leftIndex]?.removed || records[rightIndex]?.removed) {
    if (main)
      return {
        ...progress,
        comparison: {pairCursor: progress.comparison.pairCursor + 1, claimCursor: 0, seenCaseIds: []},
        cursor: progress.comparison.pairCursor + 1,
      };
    dirty[0] = {...activeDirty!, otherCursor: otherIndex + 1, claimCursor: 0, seenCaseIds: []};
    if (dirty[0].otherCursor >= records.length) dirty.shift();
    return {...progress, dirty};
  }
  const sources = yield* readMemoryRecordsByUriWithSourceHash(config, [
    records[leftIndex].uri,
    records[rightIndex].uri,
  ]);
  if (sources.length !== 2 || sources.some((source, index) => source.sourceHash !== records[selected[index]].hash))
    return progress;
  const subjects = sources.map(source => source.record);
  const [left, right] = subjects.map(record => extractContextHealthSemanticClaims(record));
  for (const [index, extracted] of [
    [leftIndex, left],
    [rightIndex, right],
  ] as const) {
    records[index] = {
      ...records[index],
      claims: extracted.claims.length,
      unsupportedClaims: extracted.claims.filter(claim => claim.extraction === 'unsupported').length,
      reasons: extracted.reasons,
    };
  }
  const reviewedIds = new Set(yield* reviewedSemanticContradictionIds(config, project, subjects));
  const seen = new Set(main ? progress.comparison.seenCaseIds : activeDirty!.seenCaseIds);
  let seenOverflow = main ? progress.comparison.seenOverflow === true : activeDirty!.seenOverflow === true;
  const claimCursor = main ? progress.comparison.claimCursor : activeDirty!.claimCursor;
  const pairClaims = left.claims.length * right.claims.length;
  const page = compareContextHealthSemanticClaimWindow(left.claims, right.claims, claimCursor, budget);
  const end = page.nextCursor;
  let omitted = 0;
  for (const evidence of page.contradictions) {
    const finding = semanticFindings([evidence])[0];
    const identity = contextHealthFindingCaseIdentityV2({project, finding, records: subjects});
    if (reviewedIds.has(evidence.contradictionId)) continue;
    const id = contextHealthCaseIdV2(identity);
    const existing = cases.get(id);
    const enteringCurrent = existing === undefined || existing.disposition === 'historical';
    if (
      (enteringCurrent && (output.byProject.get(project) ?? 0) >= 512) ||
      (existing === undefined && (output.retained >= 2_048 || output.remainingBytes < 4_096))
    ) {
      omitted += 1;
      continue;
    }
    const item = upsertCase(
      cases,
      {
        ...identity,
        evidenceRevision: progress.generation,
        disposition: 'needs-decision',
        reason: 'opposing-canonical-claims',
      },
      now,
    );
    const retained = {
      ...item,
      subjectContentHashes: subjects.map(subject => ({
        uri: subject.uri,
        hash: sha256HexSync(canonicalMemoryDocumentContent(subject.content)),
      })),
    };
    if (existing === undefined) {
      const bytes = new TextEncoder().encode(JSON.stringify(retained)).length + id.length + 64;
      if (bytes > output.remainingBytes) {
        cases.delete(id);
        omitted += 1;
        continue;
      }
      output.remainingBytes -= bytes;
      output.retained += 1;
    }
    cases.set(id, retained);
    if (enteringCurrent) output.byProject.set(project, (output.byProject.get(project) ?? 0) + 1);
    if (seen.has(id)) continue;
    const seenBytes = new TextEncoder().encode(id).length + 3;
    if (seen.size < 1_024 && seenBytes <= output.remainingBytes) {
      seen.add(id);
      output.remainingBytes -= seenBytes;
    } else seenOverflow = true;
  }
  const done = end >= pairClaims;
  const omissions = recordSemanticOutputOmissions(
    progress,
    records[leftIndex],
    records[rightIndex],
    claimCursor === 0,
    omitted,
    output,
  );
  if (done && !seenOverflow) {
    const completeExtraction = left.reasons.length === 0 && right.reasons.length === 0;
    for (const [id, item] of cases) {
      if (
        item.project !== project ||
        item.family !== 'semantic-contradiction' ||
        seen.has(id) ||
        ['historical', 'resolved', 'retired'].includes(item.disposition)
      )
        continue;
      if (
        item.subjectContentHashes?.length !== 2 ||
        !item.subjectContentHashes.every(subject => subjects.some(record => record.uri === subject.uri))
      )
        continue;
      const sameSources = item.subjectContentHashes.every(subject =>
        subjects.some(
          record =>
            record.uri === subject.uri &&
            subject.hash === sha256HexSync(canonicalMemoryDocumentContent(record.content)),
        ),
      );
      if (!sameSources) {
        upsertCase(
          cases,
          {
            ...item,
            disposition: 'historical',
            reason: `semantic-analyzer-v${CONTEXT_HEALTH_SEMANTIC_ANALYZER_VERSION}-evidence-superseded`,
          },
          now,
        );
      } else if (completeExtraction) {
        cases.set(id, {...item, disposition: 'resolved', reason: 'semantic-postcondition-verified', lastChecked: now});
      }
    }
  }
  if (main) {
    const pairCursor = progress.comparison.pairCursor + Number(done);
    return {
      ...progress,
      records,
      comparedClaimPairs: progress.comparedClaimPairs + Math.max(0, end - claimCursor),
      ...omissions,
      comparison: {
        pairCursor,
        claimCursor: done ? 0 : end,
        seenCaseIds: done ? [] : [...seen],
        seenOverflow: !done && seenOverflow,
      },
      cursor: pairCursor,
    };
  }
  dirty[0] = {
    ...activeDirty!,
    otherCursor: otherIndex + Number(done),
    claimCursor: done ? 0 : end,
    seenCaseIds: done ? [] : [...seen],
    seenOverflow: !done && seenOverflow,
  };
  if (dirty[0].otherCursor >= records.length) dirty.shift();
  return {
    ...progress,
    records,
    dirty,
    comparedClaimPairs: progress.comparedClaimPairs + Math.max(0, end - claimCursor),
    ...omissions,
  };
});

export const runMaintenanceSemanticWindow = Effect.fn('contextMaintenance.semanticWindow')(function* (
  config: RuntimeConfig,
  project: string,
  progress: MaintenanceSemanticProgress,
  cases: Map<string, ContextMaintenanceCaseV2>,
  now: string,
  availableStateBytes = 2 * 1_024 * 1_024,
) {
  let current = progress;
  let budget = 8_192;
  const output = maintenanceSemanticOutputBudget(cases, availableStateBytes);
  for (let steps = 0; steps < 32 && budget > 0; steps += 1) {
    const next = yield* runMaintenanceSemanticStep(config, project, current, cases, now, budget, output);
    if (next === current) break;
    if (next.omissionPairsOverflow && current.dirty.length > 0) {
      current = {
        ...next,
        comparison: {pairCursor: 0, claimCursor: 0, seenCaseIds: []},
        dirty: [],
        cursor: 0,
        outputOmittedFindings: 0,
        omissionPairs: [],
      };
      break;
    }
    budget -= Math.max(1, next.comparedClaimPairs - current.comparedClaimPairs);
    current = next;
    if (
      current.comparison.pairCursor >= semanticPairCount(current.records.length) &&
      current.dirty.length === 0 &&
      current.records.every(record => record.removed || record.claims !== undefined)
    )
      break;
  }
  return current;
});

export function buildMaintenanceSemanticReport(
  project: string,
  records: readonly MemoryRecord[],
  now: string,
  reviewedIds?: readonly string[],
) {
  return buildContextHealthReport({
    project,
    reviewedSemanticContradictionIds: reviewedIds,
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

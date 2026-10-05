import {Clock, DateTime, Effect, FileSystem, Option, Path, Result} from 'effect';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {uriSegment} from '@threadnote/workspace/manifest';
import {validateContextHealthMemoryCitations} from '@threadnote/context/citation_validation';
import type {ContextBriefMemoryCitationValidationV2} from '@threadnote/context/types';
import {readMemoryRecordsByUri} from '../../mcp/server/memory.js';
import {
  advanceContextMaintenanceEvidenceRequest,
  clearContextMaintenanceEvidenceRequest,
  collectContextMaintenanceCitationEvidence,
  deferContextMaintenanceEvidenceRequest,
  readContextMaintenanceCitationAssociation,
  readContextMaintenanceSourceEpoch,
  requestedRootProjectionComplete,
  type ContextMaintenanceEvidenceRequest,
  type ContextMaintenanceWorkerObservation,
} from './maintenance_evidence.js';
import type {ContextMaintenanceCaseV2} from './maintenance.js';
import {maintenanceCitationAdmissionCurrent, recordSourceRevision} from './maintenance_source.js';

export interface MaintenanceWorkerTask {
  readonly record: MemoryRecord;
  readonly project: string;
  readonly chunk: number;
  readonly key: string;
  readonly citationIds?: readonly string[];
}
export interface MaintenanceWorkerEvidence {
  readonly project: string;
  readonly cwd: string;
  readonly records: readonly MemoryRecord[];
  readonly validations: readonly ContextBriefMemoryCitationValidationV2[];
  readonly observation?: ContextMaintenanceWorkerObservation;
}

export const MAINTENANCE_WORKER_BATCH_ANCHOR_LIMIT = 16;
export const MAINTENANCE_WORKER_BATCH_SELECTOR_LIMIT = 8;

export function planMaintenanceWorkerBatches<T extends MaintenanceWorkerTask>(tasks: readonly T[]) {
  const groups: (T & MaintenanceWorkerTask)[][] = [];
  const current = new Map<string, (T & MaintenanceWorkerTask)[]>();
  const slices = tasks.flatMap(task => {
    const citations = maintenanceTaskCitations(task, task.record);
    const parts: (typeof citations)[number][][] = [];
    for (const citation of citations) {
      const part = parts.at(-1);
      if (
        part === undefined ||
        part.length >= MAINTENANCE_WORKER_BATCH_ANCHOR_LIMIT ||
        new Set([...part, citation].map(item => `${item.repositoryId}:${item.sourceCommit}`)).size >
          MAINTENANCE_WORKER_BATCH_SELECTOR_LIMIT
      )
        parts.push([citation]);
      else part.push(citation);
    }
    return parts.map(part => (parts.length === 1 ? task : {...task, citationIds: part.map(citation => citation.id)}));
  });
  for (const task of slices) {
    const citations = maintenanceTaskCitations(task, task.record);
    if (citations.length === 0) continue;
    const previous = current.get(task.project);
    const together = previous === undefined ? [] : [...previous, task];
    const anchors = together.flatMap(item => maintenanceTaskCitations(item, item.record));
    if (
      previous === undefined ||
      anchors.length > MAINTENANCE_WORKER_BATCH_ANCHOR_LIMIT ||
      new Set(anchors.map(citation => `${citation.repositoryId}:${citation.sourceCommit}`)).size >
        MAINTENANCE_WORKER_BATCH_SELECTOR_LIMIT
    ) {
      const group = [task];
      groups.push(group);
      current.set(task.project, group);
    } else previous.push(task);
  }
  return groups;
}

function maintenanceTaskCitations(task: MaintenanceWorkerTask, record: MemoryRecord) {
  const citations = record.metadata.codeCitations?.slice(task.chunk * 64, (task.chunk + 1) * 64) ?? [];
  return task.citationIds === undefined
    ? citations
    : citations.filter(citation => task.citationIds!.includes(citation.id));
}

export function mergeMaintenanceWorkerEvidence(
  left: MaintenanceWorkerEvidence,
  right: MaintenanceWorkerEvidence,
): MaintenanceWorkerEvidence {
  const records = [...new Set([...left.records, ...right.records].map(record => record.uri))].map(uri => {
    const first = left.records.find(record => record.uri === uri);
    const second = right.records.find(record => record.uri === uri);
    const record = second ?? first!;
    return {
      ...record,
      metadata: {
        ...record.metadata,
        codeCitations: [
          ...new Map(
            [...(first?.metadata.codeCitations ?? []), ...(second?.metadata.codeCitations ?? [])].map(citation => [
              citation.id,
              citation,
            ]),
          ).values(),
        ],
      },
    };
  });
  const before = left.observation,
    after = right.observation;
  const compatible =
    before !== undefined &&
    after !== undefined &&
    before.sourceEpoch === after.sourceEpoch &&
    before.memoryGeneration !== undefined &&
    after.memoryGeneration !== undefined &&
    Object.entries(before.association.bySelector).every(
      ([selector, epoch]) =>
        after.association.bySelector[selector] === undefined || after.association.bySelector[selector] === epoch,
    ) &&
    Object.entries(before.association.sourceEpochs).every(
      ([root, epoch]) =>
        after.association.sourceEpochs[root] === undefined || after.association.sourceEpochs[root] === epoch,
    ) &&
    left.records.every(record =>
      right.records.every(next => next.uri !== record.uri || next.content === record.content),
    );
  const bySelector = Object.fromEntries(
    Object.entries({...before?.association.bySelector, ...after?.association.bySelector}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
  const observation = !compatible
    ? undefined
    : {
        ...after,
        association: {
          epoch: sha256HexSync(JSON.stringify([Object.keys(bySelector).length, bySelector])),
          bySelector,
          roots: [...new Set([...before.association.roots, ...after.association.roots])],
          sourceEpochs: {...before.association.sourceEpochs, ...after.association.sourceEpochs},
        },
      };
  const validations = [...new Set([...left.validations, ...right.validations].map(validation => validation.uri))].map(
    uri => ({
      uri,
      receipts: [
        ...new Map(
          [...left.validations, ...right.validations]
            .filter(validation => validation.uri === uri)
            .flatMap(validation => validation.receipts)
            .map(receipt => [receipt.citationId, receipt]),
        ).values(),
      ],
    }),
  );
  return {...right, records, observation, validations};
}

export const readMaintenanceWorkerSubjectGeneration = Effect.fn('contextMaintenance.workerSubjectFence')(function* (
  config: RuntimeConfig,
  records: readonly MemoryRecord[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const before = yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
  const current = yield* readMemoryRecordsByUri(
    config,
    records.map(record => record.uri),
  );
  const after = yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
  return before === after &&
    records.every(record =>
      current.some(
        next => next.uri === record.uri && next.metadata.status === 'active' && next.content === record.content,
      ),
    )
    ? after
    : undefined;
});

export const collectMaintenanceWorkerBatch = Effect.fn('contextMaintenance.workerBatch')(function* <R = never>(
  config: RuntimeConfig,
  tasks: readonly MaintenanceWorkerTask[],
  cwd: string,
  skip?: (record: MemoryRecord, observation: ContextMaintenanceWorkerObservation) => Effect.Effect<boolean, unknown, R>,
) {
  const project = tasks[0].project;
  const current = yield* readMemoryRecordsByUri(config, [...new Set(tasks.map(task => task.record.uri))]);
  const records = current.map(record => ({
    ...record,
    metadata: {
      ...record.metadata,
      codeCitations: tasks
        .filter(task => task.record.uri === record.uri)
        .flatMap(task => maintenanceTaskCitations(task, record)),
    },
  }));
  const candidates = records.map(record => ({
    codeCitations: record.metadata.codeCitations ?? [],
    uri: record.uri,
  }));
  const citations = records.flatMap(record => record.metadata.codeCitations ?? []);
  if (
    citations.length > MAINTENANCE_WORKER_BATCH_ANCHOR_LIMIT ||
    new Set(citations.map(citation => `${citation.repositoryId}:${citation.sourceCommit}`)).size >
      MAINTENANCE_WORKER_BATCH_SELECTOR_LIMIT
  )
    return {project, cwd, records, validations: [], observation: undefined} satisfies MaintenanceWorkerEvidence;
  if (candidates.length === 0) {
    const association = yield* readContextMaintenanceCitationAssociation(
      config,
      cwd,
      records.flatMap(record => record.metadata.codeCitations ?? []),
    );
    const sourceEpoch = association.sourceEpochs[cwd] ?? (yield* readContextMaintenanceSourceEpoch(config, cwd));
    const memoryGeneration = yield* readCanonicalMutationGeneration(
      yield* FileSystem.FileSystem,
      yield* Path.Path,
      config.agentContextHome,
      config.account,
    ).pipe(Effect.orElseSucceed(() => undefined));
    return {
      project,
      cwd,
      records,
      validations: [],
      observation: {association, sourceEpoch, memoryGeneration},
    } satisfies MaintenanceWorkerEvidence;
  }
  let observation: ContextMaintenanceWorkerObservation | undefined;
  const validations = yield* collectContextMaintenanceCitationEvidence<
    R | Effect.Services<ReturnType<typeof validateContextHealthMemoryCitations>>
  >(config, project, records, candidates, cwd, {
    mode: 'worker',
    skipWorkerValidation: skip,
    workerSubjectFence: () => readMaintenanceWorkerSubjectGeneration(config, records),
    observeWorker: value =>
      Effect.sync(() => {
        observation = value;
      }),
    validate: selected =>
      validateContextHealthMemoryCitations(config, {callerCwd: cwd, kind: 'repository', project}, selected, {
        fullScan: true,
      }),
  }).pipe(Effect.orElseSucceed(() => []));
  return {project, cwd, records, validations, observation} satisfies MaintenanceWorkerEvidence;
});

export const prepareMaintenanceWorkerBatches = Effect.fn('contextMaintenance.prepareWorkerBatches')(function* (
  config: RuntimeConfig,
  tasks: readonly MaintenanceWorkerTask[],
  roots: ReadonlyMap<string, string>,
  cwd: string,
  started: number,
  now: string,
  checkpoints: Readonly<
    Record<
      string,
      {
        readonly memoryHash?: string;
        readonly citationAdmissionVersion?: number;
        readonly sourceEpoch?: string;
        readonly retryAt?: string;
        readonly revision: string;
        readonly sourceRevision?: string;
      }
    >
  >,
  cases: ReadonlyMap<string, ContextMaintenanceCaseV2>,
) {
  const batches: MaintenanceWorkerEvidence[] = [];
  const batchByTask = new Map<string, MaintenanceWorkerEvidence>();
  const groups = planMaintenanceWorkerBatches(tasks);
  const remaining = new Map<string, number>();
  for (const task of groups.flat()) remaining.set(task.key, (remaining.get(task.key) ?? 0) + 1);
  for (const group of groups) {
    if (remaining.get(groups[0][0].key) === 0 && (yield* Clock.currentTimeMillis) - started > 5_000) break;
    const root = roots.get(group[0].project) ?? cwd;
    const batch = yield* collectMaintenanceWorkerBatch(config, group, root, (record, observation) =>
      Effect.gen(function* () {
        const checks = group.filter(task => task.record.uri === record.uri).map(task => checkpoints[task.key]);
        if (checks.some(check => !maintenanceCitationAdmissionCurrent(record, check))) return false;
        if (
          !checks.every(
            check =>
              check?.memoryHash === sha256HexSync(canonicalMemoryDocumentContent(record.content)) &&
              check.sourceEpoch === observation.sourceEpoch &&
              (check.retryAt === undefined || check.retryAt > now),
          )
        )
          return false;
        if (
          ![...cases.values()].some(
            item =>
              item.project === group[0].project &&
              item.disposition === 'waiting-evidence' &&
              item.memoryId === (record.metadata.memoryId ?? record.uri) &&
              ((item.nextAttemptAt !== undefined && item.nextAttemptAt > now) ||
                checks.some(check => item.wake?.revision === check.revision)),
          )
        )
          return false;
        const revision = yield* recordSourceRevision(config, record, root, observation.association);
        return checks.every(check => check.sourceRevision === revision);
      }),
    );
    batches.push(batch);
    for (const task of group) {
      const previous = batchByTask.get(task.key);
      batchByTask.set(task.key, previous === undefined ? batch : mergeMaintenanceWorkerEvidence(previous, batch));
      remaining.set(task.key, remaining.get(task.key)! - 1);
    }
  }
  for (const [key, count] of remaining) if (count > 0) batchByTask.delete(key);
  return {batches, batchByTask};
});

export function maintenanceWorkerRecordValidations(evidence: MaintenanceWorkerEvidence, record: MemoryRecord) {
  const original = evidence.records.find(original => original.uri === record.uri);
  if (
    evidence.observation === undefined ||
    original?.content !== record.content ||
    (record.metadata.project ?? 'unscoped') !== evidence.project
  )
    return [];
  const ids = new Set((record.metadata.codeCitations ?? []).map(citation => citation.id));
  return evidence.validations
    .filter(validation => validation.uri === record.uri)
    .map(validation => ({...validation, receipts: validation.receipts.filter(receipt => ids.has(receipt.citationId))}));
}

export function maintenanceWorkerCheckpointReusable(
  record: MemoryRecord,
  check:
    | {
        readonly revision: string;
        readonly checkedCitations?: number;
        readonly citationAdmissionVersion?: number;
        readonly retryAt?: string;
      }
    | undefined,
  evidence: MaintenanceWorkerEvidence | undefined,
  revision: string,
  now: string,
  legacy: boolean,
) {
  if (legacy || !maintenanceCitationAdmissionCurrent(record, check)) return false;
  const observedCitations =
    evidence === undefined
      ? 0
      : maintenanceWorkerRecordValidations(evidence, record)
          .flatMap(validation => validation.receipts)
          .filter(receipt => receipt.status !== 'unknown' || receipt.provenance === 'historical-verified').length;
  return (
    check?.revision === revision &&
    observedCitations <= (check.checkedCitations ?? 0) &&
    (check.retryAt === undefined || check.retryAt > now)
  );
}

export const maintenanceWorkerBatchCurrent = Effect.fn('contextMaintenance.workerClosingFence')(function* (
  config: RuntimeConfig,
  evidence: MaintenanceWorkerEvidence,
) {
  const observed = evidence.observation;
  if (observed === undefined || observed.memoryGeneration === undefined) return false;
  const association = yield* readContextMaintenanceCitationAssociation(
    config,
    evidence.cwd,
    evidence.records.flatMap(record => record.metadata.codeCitations ?? []),
  );
  const source =
    association.sourceEpochs[evidence.cwd] ?? (yield* readContextMaintenanceSourceEpoch(config, evidence.cwd));
  const generation = yield* readMaintenanceWorkerSubjectGeneration(config, evidence.records).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return (
    generation !== undefined && source === observed.sourceEpoch && association.epoch === observed.association.epoch
  );
});

export function selectRequestedMaintenanceUris(uris: readonly string[], cursor: string | undefined, limit: number) {
  const ordered = [...new Set(uris)].sort();
  const following = cursor === undefined ? -1 : ordered.findIndex(uri => uri > cursor);
  const after = following < 0 ? 0 : following;
  return [...ordered.slice(after), ...ordered.slice(0, after)].slice(0, limit);
}

export function selectRelationBoundedMaintenanceWindow<T extends {readonly record: MemoryRecord}>(
  candidates: readonly T[],
): readonly T[] {
  const relation = candidates.findIndex(task => (task.record.metadata.relations?.length ?? 0) > 0);
  return relation < 0 ? candidates : candidates.slice(0, Math.max(1, relation));
}

export const runRequestedMaintenanceProjection = Effect.fn('contextMaintenance.requestedRoot')(function* (
  config: RuntimeConfig,
  request: ContextMaintenanceEvidenceRequest,
  active: readonly MemoryRecord[],
  inventory: readonly MemoryRecord[],
  inventoryComplete: boolean,
) {
  const byUri = new Map(active.map(record => [record.uri, record]));
  const now = yield* Clock.currentTimeMillis;
  const eligible = request.uris.filter(uri => !(Date.parse(request.deferredUntil?.[uri] ?? '') > now));
  const selected = selectRequestedMaintenanceUris(eligible, request.cursor, 4);
  if (selected.length > 0)
    yield* advanceContextMaintenanceEvidenceRequest(
      config,
      request.project,
      request.cwd,
      selected.at(-1)!,
      request.revision,
      request.page,
    );
  const completed = new Set<string>();
  for (const uri of selected) {
    const record = byUri.get(uri);
    if (record !== undefined && (record.metadata.codeCitations?.length ?? 0) > 0) continue;
    if (yield* requestedSubjectObsolete(config, uri, inventory, inventoryComplete)) {
      yield* clearContextMaintenanceEvidenceRequest(
        config,
        request.project,
        request.cwd,
        [uri],
        request.revision,
        request.page,
      );
      completed.add(uri);
    }
  }
  const tasks = selected.flatMap(uri => {
    const record = byUri.get(uri);
    return record === undefined ||
      record.metadata.status !== 'active' ||
      record.metadata.project !== request.project ||
      (record.metadata.codeCitations?.length ?? 0) === 0 ||
      (record.metadata.citationErrors?.length ?? 0) > 0
      ? []
      : [{record, project: request.project, chunk: 0, key: uri}];
  });
  for (const group of planMaintenanceWorkerBatches(tasks)) {
    const evidence = yield* collectMaintenanceWorkerBatch(config, group, request.cwd);
    if (evidence.observation === undefined || !(yield* maintenanceWorkerBatchCurrent(config, evidence))) continue;
    for (const task of group) {
      const current = evidence.records.find(record => record.uri === task.record.uri);
      if (current === undefined || sha256HexSync(current.content) !== task.record.content) continue;
      const expected = new Set((current.metadata.codeCitations ?? []).map(citation => citation.id));
      const validated = new Set(
        evidence.validations
          .filter(validation => validation.uri === current.uri)
          .flatMap(validation => validation.receipts.map(receipt => receipt.citationId)),
      );
      if (
        expected.size !== validated.size ||
        [...expected].some(id => !validated.has(id)) ||
        !(yield* requestedRootProjectionComplete(config, request.project, request.cwd, current, evidence.observation))
      )
        continue;
      yield* clearContextMaintenanceEvidenceRequest(
        config,
        request.project,
        request.cwd,
        [current.uri],
        request.revision,
        request.page,
      );
      completed.add(current.uri);
    }
  }
  const failed = selected.filter(uri => !completed.has(uri));
  if (failed.length > 0)
    yield* deferContextMaintenanceEvidenceRequest(
      config,
      request.project,
      request.cwd,
      failed,
      DateTime.formatIso(DateTime.makeUnsafe(now + 120_000)),
      request.revision,
      request.page,
    );
});

const requestedSubjectObsolete = Effect.fn('contextMaintenance.requestedSubjectObsolete')(function* (
  config: RuntimeConfig,
  uri: string,
  inventory: readonly MemoryRecord[],
  complete: boolean,
) {
  if (!complete) return false;
  const prefix = `threadnote://user/${uriSegment(config.user)}/memories/`;
  if (!uri.startsWith(prefix)) return false;
  const relative = uri.slice(prefix.length);
  if (relative.startsWith('/') || relative.split('/').some(segment => segment === '..' || segment.length === 0))
    return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(
    config.agentContextHome,
    'data',
    config.account,
    'user',
    uriSegment(config.user),
    'memories',
    relative,
  );
  const before = yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
  const first = yield* fs.stat(file).pipe(Effect.result);
  if (Result.isFailure(first)) {
    if (first.failure.reason._tag !== 'NotFound' || inventory.some(record => record.uri === uri)) return false;
    return before === (yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account));
  }
  if (first.success.type !== 'File' || Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return false;
  const current = (yield* readMemoryRecordsByUri(config, [uri]))[0];
  const last = yield* fs.stat(file).pipe(Effect.option);
  const after = yield* readCanonicalMutationGeneration(fs, path, config.agentContextHome, config.account);
  return (
    current !== undefined &&
    (current.metadata.status !== 'active' || (current.metadata.codeCitations?.length ?? 0) === 0) &&
    (current.metadata.citationErrors?.length ?? 0) === 0 &&
    Option.isSome(last) &&
    first.success.size === last.value.size &&
    JSON.stringify(first.success.mtime) === JSON.stringify(last.value.mtime) &&
    before === after
  );
});

export function invalidateMaintenanceWorkerBatch(
  evidence: MaintenanceWorkerEvidence,
  cases: Map<string, ContextMaintenanceCaseV2>,
  previous: ReadonlyMap<string, ContextMaintenanceCaseV2>,
  checkpoints: Record<string, unknown>,
) {
  const subjects = new Set(evidence.records.map(record => record.metadata.memoryId ?? record.uri));
  for (const [id, item] of cases)
    if (
      item.project === evidence.project &&
      subjects.has(item.memoryId) &&
      (item.family.startsWith('citation') || item.family === 'current-support')
    ) {
      const original = previous.get(id);
      cases.set(
        id,
        original ?? {
          ...item,
          disposition: 'waiting-evidence',
          reason: 'worker-evidence-changed',
          nextAttemptAt: undefined,
          wake: undefined,
        },
      );
    }
  for (const key of Object.keys(checkpoints))
    if ([...subjects].some(subject => key.startsWith(`${subject}:`))) delete checkpoints[key];
}

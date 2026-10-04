import {Clock, Effect, FileSystem, Path} from 'effect';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {validateContextHealthMemoryCitations} from '@threadnote/context/citation_validation';
import type {ContextBriefMemoryCitationValidationV2} from '@threadnote/context/types';
import {readMemoryRecordsByUri} from '../../mcp/server/memory.js';
import {
  collectContextMaintenanceCitationEvidence,
  readContextMaintenanceCitationAssociation,
  readContextMaintenanceSourceEpoch,
  type ContextMaintenanceWorkerObservation,
} from './maintenance_evidence.js';
import type {ContextMaintenanceCaseV2} from './maintenance.js';
import {recordSourceRevision} from './maintenance_source.js';

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

export function planMaintenanceWorkerBatches<T extends MaintenanceWorkerTask>(tasks: readonly T[]) {
  const groups: (T & MaintenanceWorkerTask)[][] = [];
  const current = new Map<string, (T & MaintenanceWorkerTask)[]>();
  const slices = tasks.flatMap(task => {
    const citations = task.record.metadata.codeCitations?.slice(task.chunk * 64, (task.chunk + 1) * 64) ?? [];
    const parts: (typeof citations)[number][][] = [];
    for (const citation of citations) {
      const part = parts.at(-1);
      if (
        part === undefined ||
        new Set([...part, citation].map(item => `${item.repositoryId}:${item.sourceCommit}`)).size > 32
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
      anchors.length > 96 ||
      new Set(anchors.map(citation => `${citation.repositoryId}:${citation.sourceCommit}`)).size > 32
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
  const candidates = records.flatMap((record, rank) =>
    record.metadata.kind !== 'durable' && record.metadata.kind !== 'handoff'
      ? []
      : [
          {
            citationErrorCount: record.metadata.citationErrors?.length ?? 0,
            codeCitations: record.metadata.codeCitations ?? [],
            excerpt: '',
            kind: record.metadata.kind,
            memoryId: record.metadata.memoryId,
            project: record.metadata.project,
            rank,
            uri: record.uri,
          },
        ],
  );
  const citations = candidates.flatMap(candidate => candidate.codeCitations);
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
  if (
    citations.length > 96 ||
    new Set(citations.map(citation => `${citation.repositoryId}:${citation.sourceCommit}`)).size > 32
  )
    return {project, cwd, records, validations: [], observation: undefined} satisfies MaintenanceWorkerEvidence;
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

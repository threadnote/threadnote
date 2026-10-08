import {Effect, FileSystem, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {assertSafeRelativePath} from '@threadnote/platform/paths';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  readContextMaintenanceCitationAssociation,
  readContextMaintenanceSourceEpoch,
  type ContextMaintenanceWorkerObservation,
} from './maintenance_evidence.js';
import {resolveMaintenanceRelationPolicy, resolveRelationTarget} from './maintenance_policy.js';

export type MaintenanceCitationAssociation = Effect.Success<
  ReturnType<typeof readContextMaintenanceCitationAssociation>
>;

export const CURRENT_MAINTENANCE_CITATION_ADMISSION_VERSION = 1;

/** Older checkpoints never admitted explicit citations on non-brief memory kinds. */
export function maintenanceCitationAdmissionCurrent(
  record: MemoryRecord,
  checkpoint: {readonly citationAdmissionVersion?: number} | undefined,
) {
  return (
    (record.metadata.codeCitations?.length ?? 0) === 0 ||
    record.metadata.kind === 'durable' ||
    record.metadata.kind === 'handoff' ||
    checkpoint?.citationAdmissionVersion === CURRENT_MAINTENANCE_CITATION_ADMISSION_VERSION
  );
}

export function maintenanceRecordRevision(
  record: MemoryRecord,
  corpus: readonly MemoryRecord[],
  inventoryComplete: boolean,
  sourceEpoch: string | undefined,
  sourceRevision: string | undefined,
) {
  const contentHash = (content: string) => sha256HexSync(canonicalMemoryDocumentContent(content));
  const relations = (record.metadata.relations ?? [])
    .map(relation => {
      const target = resolveRelationTarget(corpus, relation.uri);
      const policy = resolveMaintenanceRelationPolicy(record, relation, corpus, inventoryComplete);
      const successors = corpus
        .filter(
          candidate =>
            candidate.metadata.status === 'active' &&
            (candidate.metadata.relations ?? []).some(
              link =>
                link.type === 'supersedes' &&
                resolveRelationTarget(corpus, link.uri).record?.uri === target.record?.uri,
            ),
        )
        .map(candidate => [candidate.uri, contentHash(candidate.content)])
        .sort();
      return `${relation.type}:${relation.uri}:${target.state}:${target.record?.content ?? ''}:${policy.state}:${JSON.stringify(successors)}:${JSON.stringify(policy.lineage?.map(item => [item.uri, contentHash(item.content)]))}`;
    })
    .join('|');
  return sha256HexSync(
    `${inventoryComplete}:${contentHash(record.content)}:${sourceEpoch ?? ''}:${sourceRevision ?? ''}:${relations}`,
  );
}

const readRecordSourceAssociation = Effect.fn('contextMaintenance.recordAssociation')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  cwd: string,
) {
  const citations = [
    ...new Map(
      (record.metadata.codeCitations ?? []).map(citation => [
        `${citation.repositoryId}:${citation.sourceCommit}`,
        citation,
      ]),
    ).values(),
  ];
  const parts: MaintenanceCitationAssociation[] = [];
  for (let offset = 0; offset < Math.max(1, citations.length); offset += 32)
    parts.push(yield* readContextMaintenanceCitationAssociation(config, cwd, citations.slice(offset, offset + 32)));
  const bySelector = Object.fromEntries(
    parts.flatMap(part => Object.entries(part.bySelector)).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    epoch: sha256HexSync(JSON.stringify([citations.length, bySelector])),
    bySelector,
    roots: [...new Set(parts.flatMap(part => part.roots))],
    sourceEpochs: Object.assign({}, ...parts.map(part => part.sourceEpochs)),
  } satisfies MaintenanceCitationAssociation;
});

export function projectMaintenanceCitationAssociation(
  record: MemoryRecord,
  association: MaintenanceCitationAssociation,
) {
  const selectors = [
    ...new Set(
      (record.metadata.codeCitations ?? []).map(citation => `${citation.repositoryId}:${citation.sourceCommit}`),
    ),
  ].sort();
  return sha256HexSync(
    JSON.stringify([
      selectors.length,
      Object.fromEntries(
        selectors.flatMap(selector => {
          const epoch = association.bySelector[selector];
          return epoch === undefined ? [] : [[selector, epoch]];
        }),
      ),
    ]),
  );
}

export const recordSourceRevision = Effect.fn('contextMaintenance.recordSourceRevision')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  cwd: string,
  observed?: MaintenanceCitationAssociation,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const association = observed ?? (yield* readRecordSourceAssociation(config, record, cwd));
  return sha256HexSync(
    projectMaintenanceCitationAssociation(record, association) +
      (yield* Effect.forEach(
        [...new Set((record.metadata.codeCitations ?? []).map(citation => citation.path))],
        relative =>
          Effect.gen(function* () {
            const safe = yield* Effect.try(() => assertSafeRelativePath(relative));
            const root = yield* fs.realPath(cwd);
            const file = yield* fs.realPath(path.join(root, safe));
            const contained = path.relative(root, file);
            if (contained.startsWith('..') || path.isAbsolute(contained)) return `${relative}:outside-root`;
            const info = yield* fs.stat(file);
            return `${relative}:${Number(info.size)}:${JSON.stringify(info.mtime)}`;
          }).pipe(Effect.orElseSucceed(() => `${relative}:unavailable`)),
        {concurrency: 16},
      )).join('\n'),
  );
});

export const maintenanceRecordSourceObservation = Effect.fn('contextMaintenance.recordSourceObservation')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  root: string,
  previousEpoch: string | undefined,
  observed?: ContextMaintenanceWorkerObservation,
  fullAssociation = false,
) {
  const epoch = observed?.sourceEpoch ?? previousEpoch ?? (yield* readContextMaintenanceSourceEpoch(config, root));
  const revision = yield* recordSourceRevision(
    config,
    record,
    root,
    fullAssociation ? undefined : observed?.association,
  );
  return {epoch, revision};
});

import {Array as EffectArray} from 'effect';
import {currentMemoryCodeCitations} from '@threadnote/memory/reviewed-support';
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
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

export type MaintenanceCitationAssociation = Effect.Success<
  ReturnType<typeof readContextMaintenanceCitationAssociation>
>;

export const CURRENT_MAINTENANCE_CITATION_ADMISSION_VERSION = 1;

export const maintenanceCitationAdmissionVersion = (record: MemoryRecord) =>
  CURRENT_MAINTENANCE_CITATION_ADMISSION_VERSION + (record.metadata.reviewedSupport ? 1 : 0);

/** Older checkpoints never admitted explicit citations on non-brief memory kinds. */
export function maintenanceCitationAdmissionCurrent(
  record: MemoryRecord,
  checkpoint: {readonly citationAdmissionVersion?: number} | undefined,
) {
  return (
    currentMemoryCodeCitations(record).length === 0 ||
    (!record.metadata.reviewedSupport && (record.metadata.kind === 'durable' || record.metadata.kind === 'handoff')) ||
    checkpoint?.citationAdmissionVersion === maintenanceCitationAdmissionVersion(record)
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
  const relations = EffectArray.join(
    EffectArray.map(record.metadata.relations ?? [], relation => {
      const target = resolveRelationTarget(corpus, relation.uri);
      const policy = resolveMaintenanceRelationPolicy(record, relation, corpus, inventoryComplete);
      const successors = EffectArray.map(
        EffectArray.filter(
          corpus,
          (candidate, __effectArrayIndex) =>
            __effectArrayIndex in corpus &&
            candidate.metadata.status === 'active' &&
            EffectArray.some(
              candidate.metadata.relations ?? [],
              link =>
                link.type === 'supersedes' &&
                resolveRelationTarget(corpus, link.uri).record?.uri === target.record?.uri,
            ),
        ),
        candidate => [candidate.uri, contentHash(candidate.content)],
      ).sort();
      return `${relation.type}:${relation.uri}:${target.state}:${target.record?.content ?? ''}:${policy.state}:${JSON.stringify(successors)}:${JSON.stringify(EffectOption.getOrUndefined(EffectOption.map(EffectOption.fromNullishOr(policy.lineage), __effectArrayReceiver => EffectArray.map(__effectArrayReceiver, item => [item.uri, contentHash(item.content)]))))}`;
    }),
    '|',
  );
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
      EffectArray.map(currentMemoryCodeCitations(record), citation => [
        `${citation.repositoryId}:${citation.sourceCommit}`,
        citation,
      ]),
    ).values(),
  ];
  const parts: MaintenanceCitationAssociation[] = [];
  for (let offset = 0; offset < Math.max(1, citations.length); offset += 32)
    parts.push(yield* readContextMaintenanceCitationAssociation(config, cwd, citations.slice(offset, offset + 32)));
  const bySelector = EffectRecord.fromEntries(
    EffectArray.flatMap(parts, part => EffectRecord.toEntries(part.bySelector)).sort(([a], [b]) =>
      Effect2.pipe(a, EffectString.localeCompare(b)),
    ),
  );
  return {
    epoch: sha256HexSync(JSON.stringify([citations.length, bySelector])),
    bySelector,
    roots: [...new Set(EffectArray.flatMap(parts, part => part.roots))],
    sourceEpochs: Object.assign({}, ...EffectArray.map(parts, part => part.sourceEpochs)),
  } satisfies MaintenanceCitationAssociation;
});

export function projectMaintenanceCitationAssociation(
  record: MemoryRecord,
  association: MaintenanceCitationAssociation,
) {
  const selectors = [
    ...new Set(
      EffectArray.map(
        currentMemoryCodeCitations(record),
        citation => `${citation.repositoryId}:${citation.sourceCommit}`,
      ),
    ),
  ].sort();
  return sha256HexSync(
    JSON.stringify([
      ...(record.metadata.reviewedSupport
        ? [
            record.metadata.reviewedSupport.active.digest,
            EffectArray.map(currentMemoryCodeCitations(record), citation => citation.id),
          ]
        : []),
      selectors.length,
      EffectRecord.fromEntries(
        EffectArray.flatMap(selectors, selector => {
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
      EffectArray.join(
        yield* Effect.forEach(
          [...new Set(EffectArray.map(currentMemoryCodeCitations(record), citation => citation.path))],
          relative =>
            Effect.gen(function* () {
              const safe = yield* Effect.try(() => assertSafeRelativePath(relative));
              const root = yield* fs.realPath(cwd);
              const file = yield* fs.realPath(path.join(root, safe));
              const contained = path.relative(root, file);
              if (Effect2.pipe(contained, EffectString.startsWith('..')) || path.isAbsolute(contained))
                return `${relative}:outside-root`;
              const info = yield* fs.stat(file);
              return `${relative}:${Number(info.size)}:${JSON.stringify(info.mtime)}`;
            }).pipe(Effect.orElseSucceed(() => `${relative}:unavailable`)),
          {concurrency: 16},
        ),
        '\n',
      ),
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

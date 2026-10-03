import {Effect} from 'effect';
import {buildContextHealthReport} from '@threadnote/context/health';
import {listCandidateReviews} from '@threadnote/memory/candidate';
import type {MemoryRecord} from '@threadnote/memory/document';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readMemoryRecordsByUri} from '../../mcp/server/memory.js';

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
    totalBatches: pairs.length,
  };
}

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

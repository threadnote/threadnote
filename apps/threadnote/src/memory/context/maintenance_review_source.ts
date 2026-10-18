import {Effect, Path, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {MemoryRecord} from '@threadnote/memory/document';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import type {
  TopicMaintenanceReviewPayloadV1,
  TopicMaintenanceReviewPayload,
} from '@threadnote/memory/topic-maintenance-draft';
import {
  buildTopicMaintenanceEvidencePacket,
  observeTopicMaintenanceEvidence,
  projectTopicMaintenanceObservation,
} from '@threadnote/context/topic_maintenance';
import {verifyTopicObsidianReviewSource} from './maintenance_obsidian.js';
import {maintenanceContentHash} from './maintenance_policy.js';
import {readContextMaintenanceSourceEpoch} from './maintenance_evidence.js';
import {
  basisFromPacket,
  readyEvidence,
  reviewEvidenceFromPacket,
  sameRelevantBasis,
  sameRelevantEvidence,
} from './maintenance_draft.js';

export class TopicReviewSourceError extends Schema.TaggedError<TopicReviewSourceError>()('TopicReviewSourceError', {
  message: Schema.String,
}) {}
const fail = (message: string) => TopicReviewSourceError.make({message});

/** Reconstruct only the previously reviewed vector; it never authorizes a new capture. */
function reviewedObservation(record: MemoryRecord, review: TopicMaintenanceReviewPayloadV1) {
  const byHandle = new Map(review.reviewEvidence.map(entry => [entry.handleId, entry]));
  const citations = (record.metadata.codeCitations ?? []).filter(citation =>
    review.basis.handles.some(handle => handle.variant === 'historical' && handle.citationId === citation.id),
  );
  const sources = citations.map(original => {
    const entry = byHandle.get(`current:${original.id}`);
    if (!entry) throw fail('The reviewed current source capture is missing.');
    const current: MemoryCodeCitationV1 = entry.citation;
    const oldHash =
      original.target.kind === 'symbol' ? original.target.fragmentHash.value : original.fileContentHash.value;
    const currentHash =
      current.target.kind === 'symbol' ? current.target.fragmentHash.value : current.fileContentHash.value;
    return {
      citationId: original.id,
      status:
        current.path !== original.path
          ? ('relocated' as const)
          : currentHash === oldHash
            ? ('exact' as const)
            : ('changed' as const),
      reason: 'reviewed-current-capture',
      historicalAvailable: true,
      current,
      currentFileBytesHash: entry.fileBytesHash,
      observedPath: current.path,
      ...(current.target.kind === 'symbol' ? {observedNodeId: current.target.nodeId} : {}),
      excerptTruncated: false,
    };
  });
  return projectTopicMaintenanceObservation(record, sources);
}

/** The accepted target can change after a write; the immutable pre-write record remains the source comparison basis. */
export const verifyTopicMaintenanceReviewSource = Effect.fn('topicMaintenance.verifyReviewSource')(function* (
  config: RuntimeConfig,
  originalRecord: MemoryRecord,
  review: TopicMaintenanceReviewPayload,
  sourceCwd?: string,
) {
  if (review.version === 2) {
    yield* verifyTopicObsidianReviewSource(config, originalRecord, review);
    return {outcome: 'ready' as const, sourceKind: 'obsidian' as const};
  }
  if (!sourceCwd || !(yield* Path.Path).isAbsolute(sourceCwd)) return yield* fail('Topic sourceCwd must be absolute.');
  if (
    originalRecord.uri !== review.basis.targetUri ||
    maintenanceContentHash(originalRecord.content) !== review.basis.targetHash
  )
    return yield* fail('The reviewed target baseline changed.');
  const previous = yield* Effect.try({
    try: () => reviewedObservation(originalRecord, review),
    catch: cause => fail(cause instanceof Error ? cause.message : 'The reviewed source vector is invalid.'),
  });
  if (previous.revision !== review.basis.observationRevision)
    return yield* fail('The reviewed source vector no longer matches the draft revision.');
  const openingEpoch = yield* readContextMaintenanceSourceEpoch(config, sourceCwd);
  const observed = yield* observeTopicMaintenanceEvidence(config, originalRecord, sourceCwd, previous, {
    allowCapture: false,
  });
  if (observed.revision !== previous.revision || observed.outcome === 'unavailable')
    return yield* fail('The reviewed declared source changed or is unavailable.');
  const built = yield* buildTopicMaintenanceEvidencePacket(config, originalRecord, sourceCwd, observed);
  if (built.outcome !== 'ready') return yield* fail('The reviewed source packet is unavailable.');
  const packet = readyEvidence(built);
  if (
    (yield* readContextMaintenanceSourceEpoch(config, sourceCwd)) !== openingEpoch ||
    !sameRelevantBasis(review.basis, basisFromPacket(packet)) ||
    !sameRelevantEvidence(review.reviewEvidence, reviewEvidenceFromPacket(packet))
  )
    return yield* fail('The reviewed source identity or excerpt changed.');
  return packet;
});

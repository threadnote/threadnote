import {Effect, FileSystem, Path, Result, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {resolveAutomaticSharedMemorySource} from '../../git_proposal/topic_maintenance_commands.js';
import {readSeedManifest} from '@threadnote/workspace/manifest';
import {verifyAuthoredMemoryRelationTargetIdentities} from '../relations.js';
import {expandPath} from '@threadnote/platform/paths';
import {readContextHealthCitationEvidence} from '@threadnote/context/citation_validation';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {assertAutomaticMaintenanceTarget} from '@threadnote/memory/automatic-maintenance';
import {readContextMaintenanceCanonicalRecord} from './maintenance_inventory.js';
import {automaticMemorySourceUriScopes, readAutomaticCodeEvidence} from './maintenance_preparation.js';
import {AUTOMATIC_PREPARATION_MAPPER} from './maintenance_preparation_state.js';
import {automaticSupportedSymbolMatchesExcerpt} from './maintenance_code_capture.js';
import type {AutomaticMaintenanceReviewPayloadV3} from '@threadnote/memory/topic-maintenance-draft';
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
import {withAutomaticReviewCodeObservations} from './maintenance_review_code_observation.js';
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
  if (review.version === 3) {
    yield* verifyAutomaticMaintenanceReviewSource(config, originalRecord, review, sourceCwd);
    return {outcome: 'ready' as const, kind: 'automatic' as const};
  }
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

/** Revalidates persisted exact preconditions; cache deletion cannot erase approval authority or recovery proof. */
export const verifyAutomaticMaintenanceReviewSource = Effect.fn('automaticMaintenance.verifyReviewSource')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  review: AutomaticMaintenanceReviewPayloadV3,
  sourceCwd?: string,
) {
  yield* Effect.try({
    try: () => assertAutomaticMaintenanceTarget(review.basis.assessment, record),
    catch: () => fail('The automatic review baseline or approved role authority changed.'),
  });
  const manifest = yield* readSeedManifest(config.manifestPath).pipe(Effect.result);
  let root: string | undefined;
  if (Result.isSuccess(manifest)) {
    const matches = manifest.success.projects.filter(project => project.name === record.metadata.project);
    if (matches.length === 1) root = yield* expandPath(matches[0].path);
  }
  if (sourceCwd !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    if (
      !(yield* Path.Path).isAbsolute(sourceCwd) ||
      (root && (yield* fs.realPath(root)) !== (yield* fs.realPath(sourceCwd)))
    )
      return yield* fail('The configured automatic source checkout changed.');
    root = sourceCwd;
  }
  const scopeRevision = sha256HexSync(
    JSON.stringify({
      project: record.metadata.project,
      root: root ?? null,
      sourcePolicy: 'same-project-and-shared-team-v1',
      mapper: AUTOMATIC_PREPARATION_MAPPER,
    }),
  );
  if (scopeRevision !== review.basis.scopeRevision)
    return yield* fail('The automatic preparation source policy changed.');
  const portableReads = new Map<string, Effect.Success<ReturnType<typeof resolveAutomaticSharedMemorySource>>>();
  for (const entry of review.reviewEvidence)
    if (entry.descriptor.source.kind === 'memory' && entry.descriptor.locator) {
      const resolved = yield* resolveAutomaticSharedMemorySource(
        config,
        entry.descriptor.source,
        entry.descriptor.locator,
      );
      portableReads.set(resolved.uri, resolved);
      portableReads.set(entry.descriptor.source.uri, resolved);
    }
  const ordinarySources = [];
  for (const read of review.basis.reads) {
    if (read.uri === record.uri || read.uri.startsWith('code:')) continue;
    const routed = portableReads.get(read.uri);
    const current = routed
      ? {record: routed.record, hash: sha256HexSync(routed.record.content)}
      : yield* readContextMaintenanceCanonicalRecord(config, read.uri);
    if (
      current.hash !== read.hash ||
      current.record.metadata.status !== 'active' ||
      (current.record.metadata.project ?? '') !== (record.metadata.project ?? '') ||
      current.record.metadata.visibility === 'external' ||
      current.record.metadata.trust === 'untrusted' ||
      current.record.metadata.authority === 'external'
    )
      return yield* fail('A reviewed canonical source or its current access policy changed.');
    if (!routed)
      ordinarySources.push({
        content: current.record.content,
        memoryId: current.record.metadata.memoryId,
        uri: current.record.uri,
        allowedUriScopes: automaticMemorySourceUriScopes(config, record),
      });
  }
  // Exact physical bytes alone cannot detect a newly ambiguous stable identity.
  yield* verifyAuthoredMemoryRelationTargetIdentities(config, ordinarySources);
  const expectedCode = review.basis.reads.filter(read => read.uri.startsWith('code:'));
  let code: Effect.Success<ReturnType<typeof readAutomaticCodeEvidence>> | undefined;
  if (expectedCode.length) {
    code = yield* readAutomaticCodeEvidence(config, record, root);
    if (
      JSON.stringify([...code.reads].sort((a, b) => a.uri.localeCompare(b.uri))) !==
      JSON.stringify([...expectedCode].sort((a, b) => a.uri.localeCompare(b.uri)))
    )
      return yield* fail('The exact automatic code preparation vector changed.');
  }
  for (const entry of review.reviewEvidence) {
    const source = entry.descriptor.source;
    if (source.kind === 'memory') {
      const portable = portableReads.get(source.uri);
      const current = portable
        ? {record: portable.record, hash: sha256HexSync(portable.record.content)}
        : yield* readContextMaintenanceCanonicalRecord(config, source.uri);
      if (
        current.hash !== source.canonicalHash ||
        current.record.metadata.memoryId !== source.memoryId ||
        current.record.body.slice(source.fragment.startOffset, source.fragment.endOffset) !== entry.content ||
        sha256HexSync(entry.content) !== source.fragment.hash ||
        current.record.metadata.status !== 'active' ||
        (current.record.metadata.project ?? '') !== (record.metadata.project ?? '')
      )
        return yield* fail('The exact reviewed memory fragment changed or is unavailable.');
    } else if (source.kind === 'code') {
      if (!entry.codeExcerpt) return yield* fail('The code source has no reviewed byte geometry.');
      if (!root) return yield* fail('The exact current code source is not the configured project checkout.');
      const identity = yield* resolveRepositoryIdentity(root);
      if (
        identity.repositoryId !== source.citation.repositoryId ||
        (identity.remoteIdentity ? 'remote' : 'local') !== source.citation.repositoryIdentityKind
      )
        return yield* fail('The exact current code source is not the configured project checkout.');
      const selected = yield* readContextHealthCitationEvidence(
        config,
        {kind: 'repository', callerCwd: root ?? config.agentContextHome},
        source.citation,
        {
          startLine: entry.codeExcerpt.startLine,
          maximumLines: entry.codeExcerpt.endLine - entry.codeExcerpt.startLine + 1,
          maximumBytes: 32 * 1024,
        },
      );
      const exactBytes = (excerpt: (typeof selected.excerpts)[number]) =>
        excerpt.provenance === 'current-verified' &&
        excerpt.supportsCitation &&
        excerpt.fileBytesHash === entry.codeExcerpt!.fileBytesHash &&
        excerpt.content === entry.content &&
        excerpt.excerptHash === entry.contentHash &&
        excerpt.source.sourceDirty === source.citation.sourceDirty;
      if (!selected.excerpts.some(exactBytes)) {
        // A retained approved pin may need a separately fenced current proof after extractor-context drift.
        // Only the just-reconstructed exact code vector is authoritative here, never persisted cache/review proof.
        const active = (record.metadata.reviewedSupport?.active.sources ?? []).filter(
          descriptor =>
            descriptor.id === entry.descriptor.id &&
            descriptor.scope === entry.descriptor.scope &&
            descriptor.source.kind === 'code' &&
            descriptor.source.citation.id === source.citation.id &&
            JSON.stringify(descriptor.locator ?? null) === JSON.stringify(entry.descriptor.locator ?? null),
        );
        const own = code?.evidence.find(
          evidence =>
            evidence.id === entry.descriptor.id &&
            evidence.source.kind === 'code' &&
            evidence.source.citation.id === source.citation.id &&
            evidence.availability === 'available' &&
            evidence.authority === 'recorded',
        );
        const supported =
          active.length === 1 &&
          own &&
          code?.candidates.some(
            candidate =>
              candidate.evidenceId === own.id &&
              candidate.excerpt &&
              !candidate.excerpt.truncated &&
              candidate.excerpt.startLine === entry.codeExcerpt!.startLine &&
              candidate.excerpt.endLine === entry.codeExcerpt!.endLine &&
              exactBytes(candidate.excerpt) &&
              automaticSupportedSymbolMatchesExcerpt(source.citation, candidate.excerpt),
          );
        if (!supported) return yield* fail('The exact reviewed current code bytes or authority changed.');
      }
      // A verified configured-caller route deliberately reports incomplete global route discovery.
      // Its positive current evidence is authoritative here; unrelated global inventory is not required.
    } else return yield* fail('Imported support requires its explicit retained-evidence provider review.');
  }
}, withAutomaticReviewCodeObservations);

import {Effect} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalMemoryDocumentContent, type MemoryRecord} from '@threadnote/memory/document';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {
  validateTopicMaintenanceManifest,
  type TopicMaintenanceDependencyV1,
  type TopicMaintenanceParagraphV1,
} from '@threadnote/memory/topic-maintenance';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  observeCleanRepositoryWorktree,
  resolvePublishedRepositoryReadFence,
  resolveRepositoryIdentity,
} from '@threadnote/graph/repository';
import {captureMemoryCodeCitations} from './citation/capture.js';
import {
  readContextHealthCitationEvidence,
  validateContextHealthMemoryCitations,
  type ContextHealthCitationSourceExcerptV1,
} from './citation_validation.js';
import type {ContextBriefCitationValidationReceiptV2} from './types.js';

export const TOPIC_MAINTENANCE_EVIDENCE_VERSION = 1 as const;
export const TOPIC_MAINTENANCE_PACKET_MAX_BYTES = 64 * 1024;
const TARGET_MAX_BYTES = 32 * 1024;
const EXCERPT_MAX_BYTES = 1024;
const EXCERPT_MAX_LINES = 8;
const excerptOptions = {maximumBytes: EXCERPT_MAX_BYTES, maximumLines: EXCERPT_MAX_LINES, symbolSpanOnly: true};

type Status = ContextBriefCitationValidationReceiptV2['status'];

export interface TopicMaintenanceSourceObservationV1 {
  readonly citationId: string;
  readonly status: Status;
  readonly reason: string;
  readonly historicalAvailable: boolean;
  readonly current?: MemoryCodeCitationV1;
  readonly currentFileBytesHash?: string;
  readonly observedPath?: string;
  readonly observedNodeId?: string;
  readonly excerptTruncated?: boolean;
}

export interface TopicMaintenanceObservationV1 {
  readonly version: typeof TOPIC_MAINTENANCE_EVIDENCE_VERSION;
  readonly targetHash: string;
  readonly revision: string;
  readonly coverage: 'declared-only';
  readonly outcome: 'unchanged' | 'review-required' | 'unavailable';
  readonly sources: readonly TopicMaintenanceSourceObservationV1[];
  readonly canDraft: boolean;
}

function declaredCitations(record: MemoryRecord) {
  const manifest = validateTopicMaintenanceManifest(record.metadata.topicMaintenance, record);
  const ids = new Set([
    ...manifest.paragraphs.flatMap(paragraph => paragraph.citationIds),
    ...manifest.additionalDependencies.map(dependency => dependency.citationId),
  ]);
  return (record.metadata.codeCitations ?? [])
    .filter(citation => ids.has(citation.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function relevantHash(source: TopicMaintenanceSourceObservationV1): string | undefined {
  if (!source.current || !source.currentFileBytesHash) return undefined;
  return source.current.target.kind === 'symbol'
    ? source.current.target.fragmentHash.value
    : source.current.fileContentHash.value;
}

function relevantState(original: MemoryCodeCitationV1, source: TopicMaintenanceSourceObservationV1) {
  const hash = relevantHash(source);
  if (source.status === 'unknown' || source.status === 'deleted' || !source.historicalAvailable || !hash)
    return 'unavailable';
  const originalHash =
    original.target.kind === 'symbol' ? original.target.fragmentHash.value : original.fileContentHash.value;
  if (hash !== originalHash) return 'changed';
  return (source.observedPath ?? source.current?.path) === original.path ? 'same' : 'moved';
}

/** Pure, declared-only evidence projection. Snapshot/HEAD and new citation IDs are deliberately excluded. */
export function projectTopicMaintenanceObservation(
  record: MemoryRecord,
  sources: readonly TopicMaintenanceSourceObservationV1[],
): TopicMaintenanceObservationV1 {
  const originals = declaredCitations(record);
  if (sources.length !== originals.length || new Set(sources.map(source => source.citationId)).size !== sources.length)
    throw new Error('Topic evidence must cover every declared citation exactly once.');
  const byId = new Map(sources.map(source => [source.citationId, source]));
  const ordered = originals.map(original => {
    const source = byId.get(original.id);
    if (!source) throw new Error('Topic evidence cites an undeclared source.');
    if (
      source.current &&
      (source.current.repositoryId !== original.repositoryId ||
        source.current.target.kind !== original.target.kind ||
        source.current.sourceDirty ||
        source.current.evidenceRetention !== 'capsule-retained')
    )
      throw new Error('Topic current evidence changed repository, kind, cleanliness, or retention.');
    return source;
  });
  const targetHash = sha256HexSync(canonicalMemoryDocumentContent(record.content));
  const revision = sha256HexSync(
    JSON.stringify([
      TOPIC_MAINTENANCE_EVIDENCE_VERSION,
      targetHash,
      originals.map((original, index) => {
        const source = ordered[index];
        return [
          original.id,
          original.repositoryId,
          original.path,
          original.target.kind,
          original.target.kind === 'symbol' ? original.target.fragmentHash.value : original.fileContentHash.value,
          relevantState(original, source),
          source.excerptTruncated === true,
          source.observedPath ?? source.current?.path ?? '',
          relevantHash(source) ?? '',
        ];
      }),
    ]),
  );
  const unavailable = ordered.some((source, index) => relevantState(originals[index], source) === 'unavailable');
  const changed = ordered.some((source, index) => relevantState(originals[index], source) !== 'same');
  const truncatedForReview = changed && ordered.some(source => source.excerptTruncated === true);
  const outcome = unavailable || truncatedForReview ? 'unavailable' : changed ? 'review-required' : 'unchanged';
  return {
    version: TOPIC_MAINTENANCE_EVIDENCE_VERSION,
    targetHash,
    revision,
    coverage: 'declared-only',
    outcome,
    sources: ordered,
    canDraft: outcome === 'review-required',
  };
}

/** Reads published exact-current graph evidence only; the canonical citations stay immutable. */
export const observeTopicMaintenanceEvidence = Effect.fn('topicMaintenance.observeEvidence')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  callerCwd: string,
  previous?: TopicMaintenanceObservationV1,
  options?: {readonly allowCapture?: boolean},
) {
  const citations = declaredCitations(record);
  const trustedPrevious = (() => {
    if (!previous || previous.version !== TOPIC_MAINTENANCE_EVIDENCE_VERSION) return undefined;
    try {
      const projection = projectTopicMaintenanceObservation(record, previous.sources);
      return projection.targetHash === previous.targetHash && projection.revision === previous.revision
        ? previous
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const identity = yield* resolveRepositoryIdentity(callerCwd).pipe(Effect.orElseSucceed(() => undefined));
  const clean =
    identity && (yield* observeCleanRepositoryWorktree(callerCwd).pipe(Effect.orElseSucceed(() => undefined)));
  const scope = {kind: 'repository' as const, callerCwd};
  if (!identity || !clean || citations.some(citation => citation.repositoryId !== identity.repositoryId)) {
    const reason = !clean ? 'dirty-or-unavailable-source' : 'repository-mismatch';
    const unavailable = yield* Effect.forEach(
      citations,
      citation =>
        readContextHealthCitationEvidence(config, scope, citation, excerptOptions).pipe(
          Effect.map(evidence => ({
            citationId: citation.id,
            status: 'unknown' as const,
            reason,
            historicalAvailable: evidence.excerpts.some(
              excerpt => excerpt.provenance === 'historical-verified' && excerpt.supportsCitation,
            ),
            excerptTruncated: evidence.excerpts.some(excerpt => excerpt.truncated),
          })),
          Effect.orElseSucceed(() => ({
            citationId: citation.id,
            status: 'unknown' as const,
            reason,
            historicalAvailable: false,
          })),
        ),
      {concurrency: 2},
    );
    return projectTopicMaintenanceObservation(record, unavailable);
  }
  const validated = yield* validateContextHealthMemoryCitations(config, scope, [
    {uri: record.uri, codeCitations: citations},
  ]).pipe(Effect.orElseSucceed(() => []));
  const receipts = new Map(
    validated.flatMap(item => item.receipts.map(receipt => [receipt.citationId, receipt] as const)),
  );
  const sources = yield* Effect.forEach(
    citations,
    citation =>
      Effect.gen(function* () {
        const receipt = receipts.get(citation.id);
        const evidence = yield* readContextHealthCitationEvidence(config, scope, citation, excerptOptions).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const old = evidence?.excerpts.find(
          excerpt => excerpt.provenance === 'historical-verified' && excerpt.supportsCitation,
        );
        const now = evidence?.excerpts.find(excerpt => excerpt.provenance === 'current-verified');
        const status = receipt?.status ?? 'unknown';
        const base = {
          citationId: citation.id,
          status,
          reason: receipt?.reason ?? 'validation-unavailable',
          historicalAvailable: old !== undefined,
          excerptTruncated: old?.truncated === true || now?.truncated === true,
          ...(receipt?.observedPath === undefined ? {} : {observedPath: receipt.observedPath}),
          ...(receipt?.observedNodeId === undefined ? {} : {observedNodeId: receipt.observedNodeId}),
        };
        if (!now || !receipt || receipt.coverage !== 'current-complete') return base;
        const prior = trustedPrevious?.sources.find(source => source.citationId === citation.id);
        const sameLocator =
          prior?.observedPath === receipt.observedPath && prior?.observedNodeId === receipt.observedNodeId;
        let current: MemoryCodeCitationV1 | undefined;
        if (
          options?.allowCapture !== false &&
          status === 'exact' &&
          now.supportsCitation &&
          citation.fileContentHash.value === now.source.fileContentHash
        )
          current = citation;
        else if (sameLocator && prior?.currentFileBytesHash === now.fileBytesHash) current = prior.current;
        else if (options?.allowCapture !== false && status !== 'unknown' && status !== 'deleted') {
          const ref =
            citation.target.kind === 'symbol' ? receipt.observedNodeId : (receipt.observedPath ?? citation.path);
          if (ref)
            current = (yield* captureMemoryCodeCitations(config, {
              callerCwd,
              refs: [ref],
            }).pipe(Effect.orElseSucceed(() => [])))[0];
        }
        if (
          !current ||
          current.sourceDirty ||
          current.evidenceRetention !== 'capsule-retained' ||
          current.repositoryId !== citation.repositoryId ||
          current.target.kind !== citation.target.kind ||
          current.path !== (receipt.observedPath ?? citation.path) ||
          current.fileContentHash.value !== now.source.fileContentHash
        )
          return base;
        return {...base, current, currentFileBytesHash: now.fileBytesHash};
      }),
    {concurrency: 2},
  );
  const closing = yield* resolvePublishedRepositoryReadFence(callerCwd, identity).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (!closing || closing.worktreeChanged || closing.headCommit !== identity.headCommit)
    return projectTopicMaintenanceObservation(
      record,
      sources.map(source => ({
        citationId: source.citationId,
        status: 'unknown' as const,
        reason: 'source-changed-during-observation',
        historicalAvailable: source.historicalAvailable,
        excerptTruncated: source.excerptTruncated,
      })),
    );
  return projectTopicMaintenanceObservation(record, sources);
});

export interface TopicMaintenanceEvidencePacketV1 {
  readonly version: 1;
  readonly outcome: 'ready' | 'unavailable';
  readonly targetUri: string;
  readonly targetHash: string;
  readonly observationRevision: string;
  readonly coverage: 'declared-only';
  readonly reason?: string;
  readonly body?: string;
  readonly paragraphs?: readonly TopicMaintenanceParagraphV1[];
  readonly additionalDependencies?: readonly TopicMaintenanceDependencyV1[];
  readonly sources?: readonly {
    readonly citationId: string;
    readonly status: Status;
    readonly original: MemoryCodeCitationV1;
    readonly current: MemoryCodeCitationV1;
    readonly oldExcerpt: ContextHealthCitationSourceExcerptV1;
    readonly newExcerpt: ContextHealthCitationSourceExcerptV1;
  }[];
  readonly truncatedExcerpts?: number;
}

/** Rejects an oversized packet as a whole; never trims a declared source or accepted paragraph. */
export function boundTopicMaintenanceEvidencePacket(
  packet: TopicMaintenanceEvidencePacketV1,
): TopicMaintenanceEvidencePacketV1 {
  if (packet.outcome !== 'ready') return packet;
  const reason =
    new TextEncoder().encode(packet.body ?? '').byteLength > TARGET_MAX_BYTES
      ? 'target-body-overflow'
      : new TextEncoder().encode(JSON.stringify(packet)).byteLength > TOPIC_MAINTENANCE_PACKET_MAX_BYTES
        ? 'packet-overflow'
        : undefined;
  if (!reason) return packet;
  return {
    version: 1,
    outcome: 'unavailable',
    targetUri: packet.targetUri,
    targetHash: packet.targetHash,
    observationRevision: packet.observationRevision,
    coverage: 'declared-only',
    reason,
  };
}

/** A bounded read packet. Outer maintenance case/target/source CAS fences remain with the application. */
export const buildTopicMaintenanceEvidencePacket = Effect.fn('topicMaintenance.buildEvidencePacket')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  callerCwd: string,
  observation: TopicMaintenanceObservationV1,
) {
  const sources = declaredCitations(record);
  const unavailable = (reason: string, truncatedExcerpts?: number): TopicMaintenanceEvidencePacketV1 => ({
    version: 1,
    outcome: 'unavailable',
    targetUri: record.uri,
    targetHash: observation.targetHash,
    observationRevision: observation.revision,
    coverage: 'declared-only',
    reason,
    ...(truncatedExcerpts === undefined ? {} : {truncatedExcerpts}),
  });
  const currentProjection = projectTopicMaintenanceObservation(record, observation.sources);
  if (
    observation.version !== TOPIC_MAINTENANCE_EVIDENCE_VERSION ||
    currentProjection.targetHash !== observation.targetHash ||
    currentProjection.revision !== observation.revision
  )
    return unavailable('observation-stale-or-unavailable');
  if (observation.outcome === 'unavailable') {
    const truncated = observation.sources.filter(source => source.excerptTruncated === true).length;
    return truncated > 0
      ? unavailable('excerpt-truncated', truncated)
      : unavailable('observation-stale-or-unavailable');
  }
  if (new TextEncoder().encode(record.body).byteLength > TARGET_MAX_BYTES) return unavailable('target-body-overflow');
  const scope = {kind: 'repository' as const, callerCwd};
  const entries = yield* Effect.forEach(
    sources,
    original =>
      Effect.gen(function* () {
        const observed = observation.sources.find(item => item.citationId === original.id);
        if (!observed?.current) return undefined;
        const old = yield* readContextHealthCitationEvidence(config, scope, original, excerptOptions).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const next =
          observed.current.id === original.id
            ? old
            : yield* readContextHealthCitationEvidence(config, scope, observed.current, excerptOptions).pipe(
                Effect.orElseSucceed(() => undefined),
              );
        const oldExcerpt = old?.excerpts.find(
          item => item.provenance === 'historical-verified' && item.supportsCitation,
        );
        const newExcerpt = next?.excerpts.find(item => item.provenance === 'current-verified' && item.supportsCitation);
        if (!oldExcerpt || !newExcerpt || newExcerpt.fileBytesHash !== observed.currentFileBytesHash) return undefined;
        return {
          citationId: original.id,
          status: observed.status,
          original,
          current: observed.current,
          oldExcerpt,
          newExcerpt,
        };
      }),
    {concurrency: 2},
  );
  if (entries.some(entry => entry === undefined)) return unavailable('historical-or-current-evidence-unavailable');
  const truncatedExcerpts = entries.filter(entry => entry!.oldExcerpt.truncated || entry!.newExcerpt.truncated).length;
  if (truncatedExcerpts > 0) return unavailable('excerpt-truncated', truncatedExcerpts);
  const packet: TopicMaintenanceEvidencePacketV1 = {
    version: 1,
    outcome: 'ready',
    targetUri: record.uri,
    targetHash: observation.targetHash,
    observationRevision: observation.revision,
    coverage: 'declared-only',
    body: record.body,
    paragraphs: record.metadata.topicMaintenance!.paragraphs,
    additionalDependencies: record.metadata.topicMaintenance!.additionalDependencies,
    sources: entries as Exclude<(typeof entries)[number], undefined>[],
    truncatedExcerpts: 0,
  };
  return boundTopicMaintenanceEvidencePacket(packet);
});

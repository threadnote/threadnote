import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Effect} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  canonicalMemoryDocumentContent,
  type MemoryObsidianEvidenceV1,
  type MemoryRecord,
} from '@threadnote/memory/document';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {
  topicMaintenanceAcceptedCitation,
  isCodeTopicMaintenanceManifest,
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
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

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
  if (!isCodeTopicMaintenanceManifest(manifest))
    throw new Error('Imported topic maintenance is unavailable until its reviewed adapter is enabled.');
  const ids = new Set([
    ...EffectArray.flatMap(manifest.paragraphs, paragraph => paragraph.citationIds),
    ...EffectArray.map(manifest.additionalDependencies, dependency => dependency.citationId),
  ]);
  return EffectArrayPipe(record.metadata.codeCitations ?? [], __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (citation, __effectArrayIndex2) => __effectArrayIndex2 in __effectArrayValues && ids.has(citation.id),
    ),
  ).sort((a, b) => Effect2.pipe(a.id, EffectString.localeCompare(b.id)));
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
  const baselines = EffectArray.map(originals, original => topicMaintenanceAcceptedCitation(record, original.id));
  if (
    sources.length !== originals.length ||
    new Set(EffectArray.map(sources, source => source.citationId)).size !== sources.length
  )
    throw new Error('Topic evidence must cover every declared citation exactly once.');
  const byId = new Map(EffectArray.map(sources, source => [source.citationId, source]));
  const ordered = EffectArray.map(originals, original => {
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
      EffectArray.map(originals, (original, index) => {
        const source = ordered[index];
        const baseline = baselines[index];
        return [
          original.id,
          original.repositoryId,
          baseline.path,
          baseline.target.kind,
          baseline.target.kind === 'symbol' ? baseline.target.fragmentHash.value : baseline.fileContentHash.value,
          relevantState(baseline, source),
          source.excerptTruncated === true,
          source.observedPath ?? source.current?.path ?? '',
          relevantHash(source) ?? '',
        ];
      }),
    ]),
  );
  const unavailable = EffectArray.some(
    ordered,
    (source, index) => relevantState(baselines[index], source) === 'unavailable',
  );
  const changed = EffectArray.some(ordered, (source, index) => relevantState(baselines[index], source) !== 'same');
  const truncatedForReview = changed && EffectArray.some(ordered, source => source.excerptTruncated === true);
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
  const baselines = new Map(
    EffectArray.map(citations, citation => [citation.id, topicMaintenanceAcceptedCitation(record, citation.id)]),
  );
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
  if (!identity || !clean || EffectArray.some(citations, citation => citation.repositoryId !== identity.repositoryId)) {
    const reason = !clean ? 'dirty-or-unavailable-source' : 'repository-mismatch';
    const unavailable = yield* Effect.forEach(
      citations,
      citation =>
        readContextHealthCitationEvidence(config, scope, citation, excerptOptions).pipe(
          Effect.map(evidence => ({
            citationId: citation.id,
            status: 'unknown' as const,
            reason,
            historicalAvailable: EffectArray.some(
              evidence.excerpts,
              excerpt => excerpt.provenance === 'historical-verified' && excerpt.supportsCitation,
            ),
            excerptTruncated: EffectArray.some(evidence.excerpts, excerpt => excerpt.truncated),
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
    {
      uri: record.uri,
      codeCitations: [
        ...new Map(EffectArray.map([...baselines.values()], citation => [citation.id, citation])).values(),
      ],
    },
  ]).pipe(Effect.orElseSucceed(() => []));
  const receipts = new Map(
    EffectArray.flatMap(validated, item =>
      EffectArray.map(item.receipts, receipt => [receipt.citationId, receipt] as const),
    ),
  );
  const sources = yield* Effect.forEach(
    citations,
    citation =>
      Effect.gen(function* () {
        const baseline = baselines.get(citation.id)!;
        const receipt = receipts.get(baseline.id);
        const evidence = yield* readContextHealthCitationEvidence(config, scope, citation, excerptOptions).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const baselineEvidence =
          baseline.id === citation.id
            ? evidence
            : yield* readContextHealthCitationEvidence(config, scope, baseline, excerptOptions).pipe(
                Effect.orElseSucceed(() => undefined),
              );
        const old = EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(evidence?.excerpts), __effectArrayReceiver =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(
                __effectArrayReceiver,
                __effectArrayValue =>
                  !!(excerpt => excerpt.provenance === 'historical-verified' && excerpt.supportsCitation)(
                    __effectArrayValue,
                  ),
              ),
            ),
          ),
        );
        const accepted = EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(baselineEvidence?.excerpts), __effectArrayReceiver =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(
                __effectArrayReceiver,
                __effectArrayValue =>
                  !!(excerpt => excerpt.provenance === 'historical-verified' && excerpt.supportsCitation)(
                    __effectArrayValue,
                  ),
              ),
            ),
          ),
        );
        const now = EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(baselineEvidence?.excerpts), __effectArrayReceiver =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(__effectArrayReceiver, excerpt => excerpt.provenance === 'current-verified'),
            ),
          ),
        );
        const status = receipt?.status ?? 'unknown';
        const base = {
          citationId: citation.id,
          status,
          reason: receipt?.reason ?? 'validation-unavailable',
          historicalAvailable: old !== undefined && accepted !== undefined,
          excerptTruncated: old?.truncated === true || accepted?.truncated === true || now?.truncated === true,
          ...(receipt?.observedPath === undefined ? {} : {observedPath: receipt.observedPath}),
          ...(receipt?.observedNodeId === undefined ? {} : {observedNodeId: receipt.observedNodeId}),
        };
        if (!now || !receipt || receipt.coverage !== 'current-complete') return base;
        const prior = EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(trustedPrevious?.sources), __effectArrayReceiver =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(__effectArrayReceiver, source => source.citationId === citation.id),
            ),
          ),
        );
        const sameLocator =
          prior?.observedPath === receipt.observedPath && prior?.observedNodeId === receipt.observedNodeId;
        let current: MemoryCodeCitationV1 | undefined;
        if (
          (options?.allowCapture !== false ||
            record.metadata.topicMaintenance?.version === 2 ||
            (record.metadata.topicMaintenance?.version === 3 &&
              record.metadata.topicMaintenance.sourceKind === 'code')) &&
          status === 'exact' &&
          now.supportsCitation &&
          baseline.fileContentHash.value === now.source.fileContentHash &&
          baseline.extractorSet === now.source.extractorSet
        )
          current = baseline;
        else if (
          sameLocator &&
          prior?.currentFileBytesHash === now.fileBytesHash &&
          prior.current?.extractorSet === now.source.extractorSet
        )
          current = prior.current;
        else if (options?.allowCapture !== false && status !== 'unknown' && status !== 'deleted') {
          const ref =
            baseline.target.kind === 'symbol' ? receipt.observedNodeId : (receipt.observedPath ?? baseline.path);
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
          current.repositoryId !== baseline.repositoryId ||
          current.target.kind !== baseline.target.kind ||
          current.path !== (receipt.observedPath ?? baseline.path) ||
          current.extractorSet !== now.source.extractorSet ||
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
      EffectArray.map(sources, source => ({
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

/** Provider-neutral pure projection; Obsidian I/O is composed by the application. */
export interface TopicMaintenanceObsidianObservationV2 {
  readonly version: 2;
  readonly sourceKind: 'obsidian';
  readonly targetHash: string;
  readonly revision: string;
  readonly coverage: 'declared-only';
  readonly outcome: 'unchanged' | 'review-required' | 'unavailable';
  readonly canDraft: boolean;
  readonly inspectionDigest?: string;
  readonly sources: readonly {
    readonly citationId: string;
    readonly status: Status;
    readonly reason: string;
    readonly historicalAvailable: boolean;
    readonly originStatus: string;
    readonly activeStatus: string;
  }[];
}
export type TopicMaintenanceObservation = TopicMaintenanceObservationV1 | TopicMaintenanceObsidianObservationV2;

export interface TopicMaintenanceObsidianEvidenceReadV2 {
  readonly citation: MemoryObsidianEvidenceV1;
  readonly historical: 'available' | 'expired' | 'revoked' | 'missing' | 'corrupt';
  readonly currentRevision: 'same' | 'changed' | 'removed' | 'unknown';
  readonly fragment?: string;
}
export interface TopicMaintenanceObsidianInspectionV2 {
  readonly sourceId: string;
  readonly sourceInstanceId: string;
  readonly noteId: string;
  readonly relativePath: string;
  readonly revisionHash: string;
  readonly sanitizerVersion: string;
  readonly accessHash: string;
  readonly vaultHash: string;
  readonly inspectionDigest: string;
  readonly content: string;
  readonly startOffset: 0;
  readonly endOffset: number;
  readonly truncated: boolean;
}
export interface TopicMaintenanceObsidianEvidencePacketV2 {
  readonly version: 2;
  readonly sourceKind: 'obsidian';
  readonly outcome: 'ready' | 'unavailable';
  readonly targetUri: string;
  readonly targetHash: string;
  readonly observationRevision: string;
  readonly coverage: 'declared-only';
  readonly canDraft: boolean;
  readonly reason?: string;
  readonly body?: string;
  readonly paragraphs?: readonly TopicMaintenanceParagraphV1[];
  readonly additionalDependencies: readonly [];
  readonly obsidian: {
    readonly origin?: TopicMaintenanceObsidianEvidenceReadV2;
    readonly active?: TopicMaintenanceObsidianEvidenceReadV2;
    readonly current?: TopicMaintenanceObsidianInspectionV2;
    readonly capture?: {
      readonly reviewId: string;
      readonly revision: number;
      readonly state: 'reserved' | 'captured';
      readonly citation?: MemoryObsidianEvidenceV1;
      readonly fragment?: string;
    };
  };
}
export type TopicMaintenanceEvidencePacket =
  TopicMaintenanceEvidencePacketV1 | TopicMaintenanceObsidianEvidencePacketV2;

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
    const truncated = EffectArray.filter(observation.sources, source => source.excerptTruncated === true).length;
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
        const observed = EffectOption.getOrUndefined(
          EffectArray.findFirst(observation.sources, item => item.citationId === original.id),
        );
        if (!observed?.current) return undefined;
        const sameCitation = observed.current.id === original.id;
        const old = yield* readContextHealthCitationEvidence(config, scope, original, {
          ...excerptOptions,
          purpose: sameCitation ? 'both' : 'historical',
        }).pipe(Effect.orElseSucceed(() => undefined));
        const next = sameCitation
          ? old
          : yield* readContextHealthCitationEvidence(config, scope, observed.current, {
              ...excerptOptions,
              purpose: 'current',
            }).pipe(Effect.orElseSucceed(() => undefined));
        const oldExcerpt = EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(old?.excerpts), __effectArrayReceiver =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(
                __effectArrayReceiver,
                __effectArrayValue =>
                  !!(item => item.provenance === 'historical-verified' && item.supportsCitation)(__effectArrayValue),
              ),
            ),
          ),
        );
        const newExcerpt = EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(next?.excerpts), __effectArrayReceiver =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(
                __effectArrayReceiver,
                __effectArrayValue =>
                  !!(item => item.provenance === 'current-verified' && item.supportsCitation)(__effectArrayValue),
              ),
            ),
          ),
        );
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
  const availableEntries = EffectArray.filter(
    entries,
    (entry): entry is Exclude<typeof entry, undefined> => entry !== undefined,
  );
  if (availableEntries.length !== entries.length) return unavailable('historical-or-current-evidence-unavailable');
  const truncatedExcerpts = EffectArray.filter(
    availableEntries,
    entry => entry.oldExcerpt.truncated || entry.newExcerpt.truncated,
  ).length;
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
    sources: availableEntries,
    truncatedExcerpts: 0,
  };
  return boundTopicMaintenanceEvidencePacket(packet);
});

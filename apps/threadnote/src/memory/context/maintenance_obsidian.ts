import {Clock, Crypto, DateTime, Effect, Result, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  canonicalMemoryDocumentContent,
  type MemoryRecord,
  type MemoryObsidianEvidenceV1,
} from '@threadnote/memory/document';
import {consolidationSections} from '@threadnote/memory/consolidation';
import {
  buildTopicMaintenanceObsidianManifest,
  validateTopicMaintenanceManifest,
  isCodeTopicMaintenanceManifest,
  topicMaintenanceObsidianCitationId,
} from '@threadnote/memory/topic-maintenance';
import {
  validateTopicMaintenanceBasis,
  validateTopicMaintenanceObsidianReviewEvidence,
  validateTopicMaintenanceObsidianCaptureIntent,
  type TopicMaintenanceObsidianDraftBasisV2,
  type TopicMaintenanceObsidianReviewPayloadV2,
} from '@threadnote/memory/topic-maintenance-draft';
import {loadCandidateReviewOptional, saveCandidateReview, withCandidateReviewLock} from '@threadnote/memory/candidate';
import type {
  TopicMaintenanceObsidianObservationV2,
  TopicMaintenanceObsidianEvidencePacketV2,
} from '@threadnote/context/topic_maintenance';
import {
  inspectObsidianNote,
  readObsidianEvidence as readProviderObsidianEvidence,
  captureObsidianEvidence,
  recoverObsidianEvidenceCapture,
} from '@threadnote/integration-obsidian/source';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readMemoryRecordsByUri} from '../../mcp/server/memory.js';
import {readContextMaintenancePacket} from './maintenance.js';

export class TopicObsidianError extends Schema.TaggedError<TopicObsidianError>()('TopicObsidianError', {
  message: Schema.String,
}) {}
const fail = (message: string) => TopicObsidianError.make({message});
const readObsidianEvidence = (config: RuntimeConfig, pin: MemoryObsidianEvidenceV1) =>
  readProviderObsidianEvidence(config, pin, {preserveExpired: true});
const hash = (value: unknown) => sha256HexSync(JSON.stringify(value));
export const topicObsidianReviewId = (uri: string) =>
  `review-${sha256HexSync(`topic-maintenance\0${uri}`).slice(0, 24)}`;
export const isObsidianTopic = (record: MemoryRecord) =>
  record.metadata.topicMaintenance?.version === 3 && record.metadata.topicMaintenance.sourceKind === 'obsidian';
const importedManifest = (record: MemoryRecord) => {
  const manifest = validateTopicMaintenanceManifest(record.metadata.topicMaintenance, record);
  if (isCodeTopicMaintenanceManifest(manifest)) throw fail('Select an enrolled private Obsidian topic.');
  return manifest;
};
const inspectDigest = (value: Effect.Success<ReturnType<typeof inspectObsidianNote>>) =>
  hash([
    value.sourceId,
    value.sourceInstanceId,
    value.noteId,
    value.relativePath,
    value.revisionHash,
    value.sanitizerVersion,
    value.accessHash,
    value.vaultHash,
  ]);
function boundedPrefix(text: string) {
  let content = '';
  let bytes = 0;
  for (const char of text) {
    const size = new TextEncoder().encode(char).byteLength;
    if (bytes + size > 8192) break;
    content += char;
    bytes += size;
  }
  return {content, startOffset: 0 as const, endOffset: content.length, truncated: content.length !== text.length};
}

/** No pin allocation. Every call rereads access, historical pins and the exact live provider identity. */
export const inspectTopicObsidianState = Effect.fn('topicObsidian.inspectState')(
  function* (config: RuntimeConfig, record: MemoryRecord) {
    const manifest = yield* Effect.try({
      try: () => importedManifest(record),
      catch: () => fail('The imported topic metadata is unavailable.'),
    });
    const origin = record.metadata.obsidianEvidence!;
    const original = yield* readObsidianEvidence(config, origin);
    const active =
      topicMaintenanceObsidianCitationId(origin) === topicMaintenanceObsidianCitationId(manifest.activeEvidence)
        ? original
        : yield* readObsidianEvidence(config, manifest.activeEvidence);
    const inspected = yield* inspectObsidianNote(config, origin.sourceId, {
      sourceInstanceId: origin.sourceInstanceId,
      noteId: origin.noteId,
    }).pipe(Effect.result);
    const current = Result.isSuccess(inspected) ? inspected.success : undefined;
    const available =
      original.historical === 'available' &&
      active.historical === 'available' &&
      current !== undefined &&
      current.sourceId === origin.sourceId &&
      current.sourceInstanceId === origin.sourceInstanceId &&
      current.noteId === origin.noteId &&
      current.accessHash === origin.accessHash &&
      current.vaultHash === origin.vaultHash;
    const digest = available ? inspectDigest(current) : undefined;
    const moved = available && current.relativePath !== manifest.activeEvidence.relativePath;
    const same =
      available &&
      !moved &&
      current.revisionHash === manifest.activeEvidence.revisionHash &&
      current.sanitizerVersion === manifest.activeEvidence.sanitizerVersion;
    const targetHash = sha256HexSync(canonicalMemoryDocumentContent(record.content));
    const status = !available
      ? ('unknown' as const)
      : same
        ? ('exact' as const)
        : moved
          ? ('relocated' as const)
          : ('changed' as const);
    const sources = [
      {
        citationId: manifest.originCitationId,
        status,
        reason: available
          ? same
            ? 'same-sanitized-revision'
            : 'current-note-changed'
          : 'imported-evidence-unavailable',
        historicalAvailable: original.historical === 'available',
        originStatus: original.historical,
        activeStatus: active.historical,
      },
    ];
    const revision = hash([
      2,
      'obsidian',
      targetHash,
      topicMaintenanceObsidianCitationId(origin),
      original.historical,
      topicMaintenanceObsidianCitationId(manifest.activeEvidence),
      active.historical,
      digest ?? 'unavailable',
    ]);
    const observation: TopicMaintenanceObsidianObservationV2 = {
      version: 2,
      sourceKind: 'obsidian',
      targetHash,
      revision,
      coverage: 'declared-only',
      outcome: !available ? 'unavailable' : same ? 'unchanged' : 'review-required',
      canDraft: false,
      sources,
      ...(digest ? {inspectionDigest: digest} : {}),
    };
    return {manifest, original, active, current: available ? current : undefined, observation};
  },
  Effect.mapError(() => fail('The imported source state is unavailable.')),
);

/** Enrollment uses the existing origin pin; it cannot create or renew evidence. */
export const inspectTopicObsidianOrigin = Effect.fn('topicObsidian.inspectOrigin')(
  function* (config: RuntimeConfig, record: MemoryRecord) {
    if (isObsidianTopic(record)) {
      const state = yield* inspectTopicObsidianState(config, record);
      if (!state.current || state.original.historical !== 'available' || state.active.historical !== 'available')
        return yield* fail('The imported origin or active evidence is unavailable.');
      return {
        origin: state.original.citation,
        current: state.current,
        revision: hash([
          topicMaintenanceObsidianCitationId(state.original.citation),
          state.original.historical,
          inspectDigest(state.current),
        ]),
      };
    }
    const origin = record.metadata.obsidianEvidence;
    if (
      !origin ||
      record.metadata.obsidianEvidenceError ||
      record.metadata.codeCitations?.length ||
      record.metadata.sourceEvidence ||
      record.metadata.sourceEvidenceError
    )
      return yield* fail('Select one private memory derived from a single Obsidian note.');
    yield* Effect.try({
      try: () => {
        if (isObsidianTopic(record)) importedManifest(record);
        else
          buildTopicMaintenanceObsidianManifest(record, {
            paragraphs: consolidationSections(record.body).map(() => ({
              role: 'historical',
              support: 'direct',
              citationIds: [topicMaintenanceObsidianCitationId(origin)],
            })),
          });
      },
      catch: () => fail('Select an eligible private imported topic.'),
    });
    const historical = yield* readObsidianEvidence(config, origin);
    if (historical.historical !== 'available')
      return yield* fail('The original retained note fragment is unavailable.');
    const current = yield* inspectObsidianNote(config, origin.sourceId, {
      sourceInstanceId: origin.sourceInstanceId,
      noteId: origin.noteId,
    });
    if (
      current.sourceInstanceId !== origin.sourceInstanceId ||
      current.noteId !== origin.noteId ||
      current.accessHash !== origin.accessHash ||
      current.vaultHash !== origin.vaultHash
    )
      return yield* fail('The imported source access or identity changed.');
    return {
      origin,
      current,
      revision: hash([topicMaintenanceObsidianCitationId(origin), historical.historical, inspectDigest(current)]),
    };
  },
  Effect.mapError(() => fail('The imported origin is unavailable.')),
);

export const readTopicObsidianPacket = Effect.fn('topicObsidian.readPacket')(
  function* (config: RuntimeConfig, record: MemoryRecord) {
    const state = yield* inspectTopicObsidianState(config, record);
    const base = {
      version: 2 as const,
      sourceKind: 'obsidian' as const,
      targetUri: record.uri,
      targetHash: state.observation.targetHash,
      observationRevision: state.observation.revision,
      coverage: 'declared-only' as const,
      additionalDependencies: [] as const,
    };
    if (!state.current || state.original.historical !== 'available' || state.active.historical !== 'available')
      return {
        ...base,
        outcome: 'unavailable' as const,
        canDraft: false,
        reason: 'imported-evidence-unavailable',
        obsidian: {},
      } satisfies TopicMaintenanceObsidianEvidencePacketV2;
    const inspected = state.current;
    const current = {
      sourceId: inspected.sourceId,
      sourceInstanceId: inspected.sourceInstanceId,
      noteId: inspected.noteId,
      relativePath: inspected.relativePath,
      revisionHash: inspected.revisionHash,
      sanitizerVersion: inspected.sanitizerVersion,
      accessHash: inspected.accessHash,
      vaultHash: inspected.vaultHash,
      inspectionDigest: inspectDigest(inspected),
      ...boundedPrefix(inspected.sanitizedContent),
    };
    const review = yield* loadCandidateReviewOptional(config.agentContextHome, topicObsidianReviewId(record.uri));
    const intent = review?.maintenanceCapture;
    let capture: TopicMaintenanceObsidianEvidencePacketV2['obsidian']['capture'];
    if (
      review &&
      intent &&
      intent.targetHash === base.targetHash &&
      intent.observationRevision === base.observationRevision &&
      intent.inspectionDigest === current.inspectionDigest
    ) {
      const read =
        intent.stage === 'captured' && intent.citation
          ? yield* readObsidianEvidence(config, intent.citation)
          : undefined;
      if (read?.historical === 'available' && read.currentRevision === 'same')
        capture = {
          reviewId: review.reviewId,
          revision: review.revision,
          state: 'captured',
          citation: read.citation,
          fragment: read.fragment,
        };
      else if (intent.stage === 'reserved')
        capture = {reviewId: review.reviewId, revision: review.revision, state: 'reserved'};
    }
    const packet: TopicMaintenanceObsidianEvidencePacketV2 = {
      ...base,
      outcome: 'ready',
      canDraft: capture?.state === 'captured',
      body: record.body,
      paragraphs: state.manifest.paragraphs,
      obsidian: {origin: state.original, active: state.active, current, ...(capture ? {capture} : {})},
    };
    if (new TextEncoder().encode(JSON.stringify(packet)).byteLength > 64 * 1024)
      return {...base, outcome: 'unavailable' as const, canDraft: false, reason: 'packet-overflow', obsidian: {}};
    return packet;
  },
  Effect.mapError(() => fail('The imported packet is unavailable.')),
);

export interface TopicObsidianCaptureInput {
  readonly caseId: string;
  readonly expectedContentHash: string;
  readonly observationRevision: string;
  readonly inspectionDigest: string;
  readonly fragmentStart: number;
  readonly fragmentEnd: number;
  readonly retentionDays?: number;
  readonly approved: boolean;
}
/** Explicit approval only. The fixed intent is durable BEFORE the provider can rename a pin. */
export const captureTopicObsidianEvidence = Effect.fn('topicObsidian.capture')(function* (
  config: RuntimeConfig,
  input: TopicObsidianCaptureInput,
) {
  if (
    input.approved !== true ||
    !/^health-case-[a-f0-9]{40}$/u.test(input.caseId) ||
    ![input.expectedContentHash, input.observationRevision, input.inspectionDigest].every(value =>
      /^[a-f0-9]{64}$/u.test(value),
    ) ||
    !Number.isSafeInteger(input.fragmentStart) ||
    !Number.isSafeInteger(input.fragmentEnd) ||
    input.fragmentStart < 0 ||
    input.fragmentEnd <= input.fragmentStart
  )
    return yield* fail('Capture requires approval of an exact inspected note fragment.');
  const outer = yield* readContextMaintenancePacket(config, input.caseId);
  if (
    !('topicEvidence' in outer) ||
    outer.topicEvidence.version !== 2 ||
    outer.topicEvidence.sourceKind !== 'obsidian' ||
    outer.topicEvidence.outcome !== 'ready'
  )
    return yield* fail('The imported case is unavailable. Refresh its evidence.');
  const packet = outer.topicEvidence;
  if (
    packet.targetHash !== input.expectedContentHash ||
    packet.observationRevision !== input.observationRevision ||
    packet.obsidian.current?.inspectionDigest !== input.inspectionDigest ||
    input.fragmentEnd > (packet.obsidian.current?.endOffset ?? 0)
  )
    return yield* fail('The inspected source or target changed. Refresh its evidence.');
  const reviewId = topicObsidianReviewId(packet.targetUri);
  return yield* withCandidateReviewLock(
    config.agentContextHome,
    reviewId,
    Effect.gen(function* () {
      const prior = yield* loadCandidateReviewOptional(config.agentContextHome, reviewId);
      if (
        prior?.candidates.some(item => item.state === 'applying' || item.state === 'conflict') ||
        (prior?.maintenanceApproval && prior.candidates[0]?.state === 'pending')
      )
        return yield* fail('Resolve the existing approval before capturing another fragment.');
      const record = (yield* readMemoryRecordsByUri(config, [packet.targetUri]))[0];
      if (!record) return yield* fail('The imported target is unavailable.');
      const state = yield* inspectTopicObsidianState(config, record);
      const current = state.current;
      if (
        !current ||
        state.observation.targetHash !== input.expectedContentHash ||
        state.observation.revision !== input.observationRevision ||
        inspectDigest(current) !== input.inspectionDigest
      )
        return yield* fail('The inspected source or target changed before capture.');
      const fragment = current.sanitizedContent.slice(input.fragmentStart, input.fragmentEnd);
      const days = input.retentionDays ?? 90;
      if (
        input.fragmentEnd > current.sanitizedContent.length ||
        !fragment ||
        new TextEncoder().encode(fragment).byteLength > 8192 ||
        !Number.isSafeInteger(days) ||
        days < 1 ||
        days > 365
      )
        return yield* fail('Choose an exact fragment of 1–8192 UTF-8 bytes and retention of 1–365 days.');
      const previous = prior?.maintenanceCapture;
      const same =
        previous &&
        previous.targetHash === input.expectedContentHash &&
        previous.observationRevision === input.observationRevision &&
        previous.inspectionDigest === input.inspectionDigest &&
        previous.input.fragment === fragment &&
        previous.input.reservation.fragmentStart === input.fragmentStart &&
        previous.input.reservation.fragmentEnd === input.fragmentEnd &&
        previous.input.retentionDays === days;
      let review = prior;
      if (!same) {
        const crypto = yield* Crypto.Crypto;
        const now = yield* Clock.currentTimeMillis;
        const intent = validateTopicMaintenanceObsidianCaptureIntent({
          version: 1,
          sourceKind: 'obsidian',
          stage: 'reserved',
          targetUri: record.uri,
          targetHash: input.expectedContentHash,
          observationRevision: input.observationRevision,
          inspectionDigest: input.inspectionDigest,
          input: {
            sourceId: current.sourceId,
            relativePath: current.relativePath,
            fragment,
            expectedSourceInstanceId: current.sourceInstanceId,
            expectedNoteId: current.noteId,
            expectedRevisionHash: current.revisionHash,
            expectedSanitizerVersion: current.sanitizerVersion,
            retentionDays: days,
            reservation: {
              version: 1,
              operationId: yield* crypto.randomUUIDv4(),
              pinId: yield* crypto.randomUUIDv4(),
              capturedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + days * 86_400_000)),
              accessHash: current.accessHash,
              vaultHash: current.vaultHash,
              fragmentStart: input.fragmentStart,
              fragmentEnd: input.fragmentEnd,
            },
          },
        });
        const at = DateTime.formatIso(DateTime.makeUnsafe(now));
        const revision = (prior?.revision ?? 0) + 1;
        review = {
          version: 3,
          reviewId,
          revision,
          createdAt: prior?.createdAt ?? at,
          project: record.metadata.project ?? 'unscoped',
          topic: record.metadata.topic ?? 'topic-maintenance',
          task: 'Capture a reviewed private note fragment.',
          outcome: 'Private capture approval; accepted memory is unchanged.',
          sourceAgentClient: 'threadnote-topic-maintenance',
          codeCitations: [],
          candidates: [
            {
              candidateId: `${reviewId}-1`,
              categories: ['invariant'],
              comparison: 'replacement',
              confidence: 0,
              evidence: [],
              kind: 'durable',
              project: record.metadata.project ?? 'unscoped',
              proposedText: '',
              reason: 'Capture requires a separate reviewed topic proposal.',
              recommendation: 'manual_review',
              state: 'pending',
              targetContentHash: input.expectedContentHash,
              targetUri: record.uri,
              topic: record.metadata.topic ?? 'topic-maintenance',
            },
          ],
          auditEvents: prior?.auditEvents ?? [],
          ...(prior?.maintenanceClosedConflict ? {maintenanceClosedConflict: prior.maintenanceClosedConflict} : {}),
          maintenanceCapture: intent,
        };
        yield* saveCandidateReview(config.agentContextHome, review);
      }
      if (!review?.maintenanceCapture) return yield* fail('The private capture intent is unavailable.');
      const intent = review.maintenanceCapture;
      const recovered = yield* recoverObsidianEvidenceCapture(config, intent.input);
      const pin = recovered ?? (yield* captureObsidianEvidence(config, intent.input));
      const attached = validateTopicMaintenanceObsidianCaptureIntent({...intent, stage: 'captured', citation: pin});
      if (intent.stage === 'captured' && JSON.stringify(intent.citation) === JSON.stringify(pin)) return review;
      const updated = {...review, revision: review.revision + 1, maintenanceCapture: attached};
      yield* saveCandidateReview(config.agentContextHome, updated);
      // Close over the same source vector after attachment; retain the pin/journal on a race.
      const closingRecord = (yield* readMemoryRecordsByUri(config, [record.uri]))[0];
      if (!closingRecord)
        return yield* fail('The captured target disappeared; the private capture remains recoverable.');
      const closing = yield* inspectTopicObsidianState(config, closingRecord);
      if (closing.observation.revision !== input.observationRevision)
        return yield* fail('The captured source changed; the private capture remains recoverable.');
      return updated;
    }),
  );
});

export function topicObsidianBasisFromPacket(
  packet: TopicMaintenanceObsidianEvidencePacketV2,
): TopicMaintenanceObsidianDraftBasisV2 {
  const origin = packet.obsidian.origin;
  const active = packet.obsidian.active;
  const capture = packet.obsidian.capture;
  if (
    packet.outcome !== 'ready' ||
    !packet.body ||
    !packet.paragraphs ||
    origin?.historical !== 'available' ||
    active?.historical !== 'available' ||
    capture?.state !== 'captured' ||
    !capture.citation ||
    !capture.fragment
  )
    throw fail('Approve and capture the exact current note fragment before drafting.');
  const ids = [
    ...new Set([
      topicMaintenanceObsidianCitationId(origin.citation),
      ...packet.paragraphs.flatMap(item => item.citationIds),
    ]),
  ].sort();
  const basis = validateTopicMaintenanceBasis({
    version: 2,
    sourceKind: 'obsidian',
    targetUri: packet.targetUri,
    targetHash: packet.targetHash,
    observationRevision: packet.observationRevision,
    packetDigest: hash(packet),
    body: packet.body,
    paragraphs: packet.paragraphs,
    additionalDependencies: [],
    handles: ids.flatMap(citationId =>
      (['historical', 'current'] as const).map(variant => ({id: `${variant}:${citationId}`, citationId, variant})),
    ),
    originEvidence: origin.citation,
    activeEvidence: active.citation,
    currentEvidence: capture.citation,
  });
  if (basis.version !== 2) throw fail('Imported basis kind changed.');
  return basis;
}
export function topicObsidianReviewEvidenceFromPacket(packet: TopicMaintenanceObsidianEvidencePacketV2) {
  const basis = topicObsidianBasisFromPacket(packet);
  const {origin, active, capture} = packet.obsidian;
  return validateTopicMaintenanceObsidianReviewEvidence(
    basis,
    basis.handles.map(handle => {
      const prior = handle.citationId === topicMaintenanceObsidianCitationId(basis.originEvidence) ? origin! : active!;
      const citation = handle.variant === 'historical' ? prior.citation : capture!.citation!;
      const content = handle.variant === 'historical' ? prior.fragment! : capture!.fragment!;
      return {
        sourceKind: 'obsidian',
        handleId: handle.id,
        content,
        excerptHash: sha256HexSync(content),
        provenance: handle.variant === 'historical' ? 'historical-verified' : 'current-verified',
        supportsCitation: true,
        truncated: false,
        citation,
      };
    }),
  );
}

/** Used before display, preview, under canonical write, after write and on retries. No capture is permitted. */
export const verifyTopicObsidianReviewSource = Effect.fn('topicObsidian.verifyReview')(function* (
  config: RuntimeConfig,
  record: MemoryRecord,
  review: TopicMaintenanceObsidianReviewPayloadV2,
) {
  if (
    record.uri !== review.basis.targetUri ||
    sha256HexSync(canonicalMemoryDocumentContent(record.content)) !== review.basis.targetHash
  )
    return yield* fail('The reviewed imported target baseline changed.');
  const state = yield* inspectTopicObsidianState(config, record);
  if (!state.current || state.observation.revision !== review.basis.observationRevision)
    return yield* fail('The reviewed imported source is unavailable or changed.');
  for (const pin of [review.basis.originEvidence, review.basis.activeEvidence, review.basis.currentEvidence]) {
    const evidence = yield* readObsidianEvidence(config, pin);
    if (
      evidence.historical !== 'available' ||
      evidence.fragment === undefined ||
      (pin === review.basis.currentEvidence && evidence.currentRevision !== 'same')
    )
      return yield* fail('The reviewed retained fragment is unavailable.');
    const entries = review.reviewEvidence.filter(
      item => topicMaintenanceObsidianCitationId(item.citation) === topicMaintenanceObsidianCitationId(pin),
    );
    if (entries.some(item => item.content !== evidence.fragment))
      return yield* fail('The reviewed private fragment changed.');
  }
  const current = review.basis.currentEvidence;
  if (
    current.sourceInstanceId !== state.current.sourceInstanceId ||
    current.noteId !== state.current.noteId ||
    current.revisionHash !== state.current.revisionHash ||
    current.sanitizerVersion !== state.current.sanitizerVersion ||
    current.accessHash !== state.current.accessHash ||
    current.vaultHash !== state.current.vaultHash
  )
    return yield* fail('The reviewed current note vector changed.');
  return state;
});

import {Array as EffectArray} from 'effect';
import {Predicate} from 'effect';
import {
  CONTEXT_BRIEF_LEGACY_PROJECTOR_VERSION,
  CONTEXT_BRIEF_LEGACY_VERSION,
  CONTEXT_BRIEF_AGENT_VIEW_VERSION,
  CONTEXT_BRIEF_PROCEDURE_AGENT_VIEW_VERSION,
  CONTEXT_BRIEF_PROCEDURE_PROJECTOR_VERSION,
  CONTEXT_BRIEF_PROCEDURE_VERSION,
  CONTEXT_BRIEF_PROJECTOR_VERSION,
  CONTEXT_BRIEF_TOPIC_PROJECTOR_VERSION,
  CONTEXT_BRIEF_TOPIC_AGENT_VIEW_VERSION,
  CONTEXT_BRIEF_TOPIC_VERSION,
  CONTEXT_BRIEF_VERSION,
  type ContextBriefProjectorVersion,
  type ContextBriefResponseVersion,
  type ContextBriefTopicMaintenanceV1,
} from './types.js';
import * as EffectRecord from 'effect/Record';

const TOPIC_FIELDS = new Set([
  'coverage',
  'excerptOrdinal',
  'excerptRole',
  'historicalParagraphs',
  'normativeParagraphs',
  'unresolvedParagraphs',
  'attention',
  'reviewId',
]);
const REQUIRED = EffectArray.filter([...TOPIC_FIELDS], field => field !== 'reviewId');
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 64;

/** Closed wire contract shared by the structured and agent-view decoders. */
export function isContextBriefTopicField(value: unknown): value is ContextBriefTopicMaintenanceV1 {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) return false;
  if (
    EffectArray.some(EffectRecord.keys(value), key => !TOPIC_FIELDS.has(key)) ||
    EffectArray.some(REQUIRED, key => !EffectRecord.has(value, key))
  )
    return false;
  const pending = value.attention === 'pending-review';
  return (
    value.coverage === 'declared-only' &&
    count(value.excerptOrdinal) &&
    value.excerptOrdinal >= 1 &&
    ['descriptive', 'normative', 'historical'].includes(String(value.excerptRole)) &&
    count(value.historicalParagraphs) &&
    count(value.normativeParagraphs) &&
    count(value.unresolvedParagraphs) &&
    value.historicalParagraphs + value.normativeParagraphs <= 64 &&
    ['none', 'pending-review', 'review-unavailable'].includes(String(value.attention)) &&
    (pending
      ? typeof value.reviewId === 'string' && /^review-[a-f0-9]{24}$/u.test(value.reviewId)
      : value.reviewId === undefined)
  );
}

export function topicProjectionError(value: Record<string, unknown>, topicVersion: boolean): string | undefined {
  for (const field of ['activeHandoffs', 'durableDecisions']) {
    for (const memory of EffectArray.isArray(value[field]) ? value[field] : []) {
      if (!Predicate.isObject(memory) || !EffectRecord.has(memory, 'topicMaintenance')) continue;
      if (!isContextBriefTopicField(memory.topicMaintenance)) return `${field}.topicMaintenance is invalid`;
    }
  }
  return hasTopicMarker(value) === topicVersion
    ? undefined
    : 'topic projection version must match retained topic evidence';
}

function hasTopicMarker(value: Record<string, unknown>): boolean {
  const memories = [
    ...(EffectArray.isArray(value.activeHandoffs) ? value.activeHandoffs : []),
    ...(EffectArray.isArray(value.durableDecisions) ? value.durableDecisions : []),
  ];
  return (
    EffectArray.some(memories, memory => Predicate.isObject(memory) && EffectRecord.has(memory, 'topicMaintenance')) ||
    (EffectArray.isArray(value.stalenessAndConflicts) &&
      EffectArray.some(
        value.stalenessAndConflicts,
        issue => Predicate.isObject(issue) && issue.kind === 'topic-support',
      ))
  );
}

export function projectedContextBriefVersion(
  prior: ContextBriefResponseVersion,
  projection: Record<string, unknown>,
): ContextBriefResponseVersion {
  return hasTopicMarker(projection) ? CONTEXT_BRIEF_TOPIC_VERSION : prior;
}

export function contextBriefProjectorVersion(version: ContextBriefResponseVersion): ContextBriefProjectorVersion {
  switch (version) {
    case CONTEXT_BRIEF_LEGACY_VERSION:
      return CONTEXT_BRIEF_LEGACY_PROJECTOR_VERSION;
    case CONTEXT_BRIEF_VERSION:
      return CONTEXT_BRIEF_PROJECTOR_VERSION;
    case CONTEXT_BRIEF_TOPIC_VERSION:
      return CONTEXT_BRIEF_TOPIC_PROJECTOR_VERSION;
    default:
      return CONTEXT_BRIEF_PROCEDURE_PROJECTOR_VERSION;
  }
}

export function inferredContextBriefVersion(value: Record<string, unknown>): ContextBriefResponseVersion {
  if (value.version === CONTEXT_BRIEF_TOPIC_AGENT_VIEW_VERSION) return CONTEXT_BRIEF_TOPIC_VERSION;
  if (value.version === CONTEXT_BRIEF_PROCEDURE_AGENT_VIEW_VERSION) return CONTEXT_BRIEF_PROCEDURE_VERSION;
  return Predicate.isObject(value.coverage) && value.coverage.codeAnchors !== undefined
    ? CONTEXT_BRIEF_VERSION
    : CONTEXT_BRIEF_LEGACY_VERSION;
}

export function agentViewVersionError(value: Record<string, unknown>, briefVersion: unknown): string | undefined {
  if (
    value.version === CONTEXT_BRIEF_AGENT_VIEW_VERSION &&
    (value.verifiedProcedures !== undefined ||
      briefVersion === CONTEXT_BRIEF_PROCEDURE_VERSION ||
      briefVersion === CONTEXT_BRIEF_TOPIC_VERSION)
  )
    return 'legacy agent views cannot carry verified procedures';
  if (
    value.version === CONTEXT_BRIEF_PROCEDURE_AGENT_VIEW_VERSION &&
    (briefVersion !== CONTEXT_BRIEF_PROCEDURE_VERSION || value.verifiedProcedures === undefined)
  )
    return 'procedure agent views require procedure-version evidence';
  if (value.version === CONTEXT_BRIEF_TOPIC_AGENT_VIEW_VERSION && briefVersion !== CONTEXT_BRIEF_TOPIC_VERSION)
    return 'topic agent views require topic-version evidence';
  return undefined;
}

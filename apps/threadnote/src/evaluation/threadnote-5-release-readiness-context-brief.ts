import {Array as EffectArray} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {parseContextBriefV1, renderContextBriefText} from '@threadnote/context/projector';
import {parseContextBriefRequestV1} from '@threadnote/context/types';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {measureAgentToolResponse} from '@threadnote/protocol/agent-response';
import {
  threadnote5ContextBriefAttemptDigest,
  type Threadnote5LocalAuthorityEntryV1,
} from './threadnote-5-release-readiness-authority.js';
import {
  parseThreadnote5TrustedSourceV1,
  type Threadnote5MeasurementV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5SourceV1,
} from './threadnote-5-release-readiness-contract.js';
import {
  boundedArray,
  compareText,
  exactObject,
  hashText,
  isoInstant,
  object,
  text,
  unique,
} from './threadnote-5-release-readiness-validation.js';
import * as EffectRecord from 'effect/Record';

const MAX_ATTEMPTS = 64;

export interface Threadnote5FirstBriefLinkV1 {
  readonly activationId: string;
  readonly activationReceiptRevision: string;
  readonly completedAt: string;
  readonly durationMilliseconds: number;
  readonly laneId: string;
}

export interface Threadnote5ContextBriefDerivedClaimsV1 {
  readonly assertions: readonly string[];
  readonly correlations?: {readonly firstBriefs: readonly Threadnote5FirstBriefLinkV1[]};
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly missingKinds?: readonly string[];
}

/** Replays production Context Brief projections and binds reviewed plan quality to exact attempts. */
export function deriveThreadnote5ContextBriefClaims(
  scenario: Threadnote5ReleaseScenario,
  value: unknown,
  candidate: Threadnote5SourceV1,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): Threadnote5ContextBriefDerivedClaimsV1 {
  const source = exactObject(value, ['attempts'], 'Context Brief capture');
  const attempts = boundedArray(source.attempts, 'Context Brief attempts', 1, MAX_ATTEMPTS);
  const parsedAttempts = EffectArray.map(attempts, attempt => contextBriefAttempt(attempt, candidate, scenario));
  if (!unique(EffectArray.map(parsedAttempts, attempt => attempt.attemptDigest))) {
    throw new Error('Context Brief attempts must be unique.');
  }
  if (scenario === 'output-budgets') {
    return {assertions: ['context-brief-800-to-1500-estimated-tokens'], measurements: []};
  }
  if (
    authority?.type !== 'context-brief-plan-citation' ||
    canonicalJson(EffectArray.map(authority.trials, trial => trial.attemptDigest).sort(compareText)) !==
      canonicalJson(EffectArray.map(parsedAttempts, attempt => attempt.attemptDigest).sort(compareText))
  ) {
    return {assertions: [], measurements: [], missingKinds: ['context-brief-plan-citation-authority']};
  }
  return {
    assertions: ['first-plan-source-cited', 'first-plan-correct'],
    correlations: {firstBriefs: EffectArray.map(parsedAttempts, attempt => attempt.firstBriefLink!)},
    measurements: [
      {
        id: 'estimated-tokens-to-first-cited-correct-plan',
        sampleCount: parsedAttempts.length,
        total: EffectArray.reduce(parsedAttempts, 0, (sum, attempt) => sum + attempt.estimatedTokens),
      },
    ],
  };
}

function contextBriefAttempt(
  value: unknown,
  candidate: Threadnote5SourceV1,
  scenario: Threadnote5ReleaseScenario,
): {
  readonly attemptDigest: string;
  readonly estimatedTokens: number;
  readonly firstBriefLink?: Threadnote5FirstBriefLinkV1;
} {
  const capture = exactObject(value, ['event', 'request', 'result'], 'Context Brief attempt');
  const request = parseContextBriefRequestV1(capture.request);
  const result = exactObject(capture.result, ['structuredContent', 'text'], 'Context Brief result');
  const structuredContent = parseContextBriefV1(result.structuredContent);
  const textResult = text(result.text, 'Context Brief result text', 256 * 1024);
  if (textResult !== renderContextBriefText(structuredContent)) {
    throw new Error('Context Brief text projection does not replay.');
  }
  const measurement = measureAgentToolResponse({structuredContent, text: textResult});
  const event = object(capture.event, 'Context Brief capture event');
  const eventKeys =
    scenario === 'solo' ? ['activationId', 'activationReceiptRevision', 'candidate', 'completedAt'] : ['candidate'];
  if (canonicalJson(EffectRecord.keys(event).sort()) !== canonicalJson(eventKeys.sort())) {
    throw new Error('Context Brief capture event has unsupported or missing fields.');
  }
  if (
    canonicalJson(parseThreadnote5TrustedSourceV1(event.candidate, 'candidate')) !== canonicalJson(candidate) ||
    measurement.estimatedTokens > request.budgetTokens
  ) {
    throw new Error('Context Brief attempt candidate or budget binding is invalid.');
  }
  const attemptDigest = threadnote5ContextBriefAttemptDigest(capture);
  if (scenario !== 'solo') return {attemptDigest, estimatedTokens: measurement.estimatedTokens};
  const identity = {
    activationId: hashText(event.activationId, 'Context Brief activation ID'),
    activationReceiptRevision: hashText(event.activationReceiptRevision, 'Context Brief activation receipt revision'),
    completedAt: text(event.completedAt, 'Context Brief completion time', 64),
  };
  if (!isoInstant(identity.completedAt)) throw new Error('Context Brief completion time is invalid.');
  return {
    attemptDigest,
    estimatedTokens: measurement.estimatedTokens,
    firstBriefLink: {
      ...identity,
      durationMilliseconds: 0,
      laneId: sha256HexSync(`threadnote-5-first-brief-lane-v1\0${canonicalJson(identity)}`),
    },
  };
}

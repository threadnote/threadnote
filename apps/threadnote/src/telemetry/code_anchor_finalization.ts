import {Array as EffectArray} from 'effect';
import {Clock, Effect} from 'effect';
import {
  withAnonymousTelemetryCheckpoint,
  type AnonymousTelemetryCodeAnchorFinalizationResult,
  type AnonymousTelemetryCodeAnchorFinalizationTrigger,
  type AnonymousTelemetryFields,
  type AnonymousTelemetryQuantityBucket,
} from '../effect/telemetry.js';

export interface CodeAnchorFinalizationTelemetryReceipt {
  readonly conflictCount: number;
  readonly failedCount: number;
  readonly finalizedCount: number;
  readonly matchedCount?: number;
  readonly pendingCount: number;
  readonly scannedCount: number;
  readonly state?: 'completed' | 'contended' | 'failed';
}

/**
 * Observe a deferred-anchor pass without accepting memory URIs, code selectors,
 * repository identity, or raw item reasons into the telemetry boundary.
 */
export function withCodeAnchorFinalizationAnonymousTelemetry<A extends CodeAnchorFinalizationTelemetryReceipt, E, R>(
  trigger: AnonymousTelemetryCodeAnchorFinalizationTrigger,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const measured = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const value = yield* effect;
    const finishedAt = yield* Clock.currentTimeMillis;
    return {elapsedMilliseconds: Math.max(0, finishedAt - startedAt), value} as const;
  });
  return withAnonymousTelemetryCheckpoint(
    {
      fields: {codeAnchorFinalizationTrigger: trigger, phase: 'memory.code-anchor-finalization'},
      retainFields: false,
      successFields: observed =>
        codeAnchorFinalizationTelemetryFields(observed.value, observed.elapsedMilliseconds) ?? {},
      successOutcome: observed =>
        codeAnchorFinalizationTelemetryFields(observed.value, observed.elapsedMilliseconds) === undefined
          ? 'unavailable'
          : 'success',
    },
    measured,
  ).pipe(Effect.map(observed => observed.value));
}

/** Closed result and power-of-two work/latency projection. */
export function codeAnchorFinalizationTelemetryFields(
  receipt: CodeAnchorFinalizationTelemetryReceipt,
  elapsedMilliseconds: number,
): AnonymousTelemetryFields | undefined {
  const counts = [
    receipt.scannedCount,
    receipt.finalizedCount,
    receipt.pendingCount,
    receipt.conflictCount,
    receipt.failedCount,
    ...(receipt.matchedCount === undefined ? [] : [receipt.matchedCount]),
  ];
  if (!EffectArray.every(counts, isPrivateCount) || !isPrivateCount(elapsedMilliseconds)) return undefined;
  if (
    receipt.finalizedCount + receipt.pendingCount + receipt.conflictCount + receipt.failedCount !==
      receipt.scannedCount ||
    receipt.finalizedCount > receipt.scannedCount ||
    receipt.pendingCount > receipt.scannedCount ||
    receipt.conflictCount > receipt.scannedCount ||
    receipt.failedCount > receipt.scannedCount ||
    (receipt.matchedCount !== undefined && receipt.matchedCount < receipt.scannedCount)
  ) {
    return undefined;
  }
  const result = finalizationResult(receipt);
  if (result === undefined) return undefined;
  return {
    codeAnchorFinalizationConflictBucket: telemetryQuantityBucket(receipt.conflictCount),
    codeAnchorFinalizationFailedBucket: telemetryQuantityBucket(receipt.failedCount),
    codeAnchorFinalizationFinalizedBucket: telemetryQuantityBucket(receipt.finalizedCount),
    codeAnchorFinalizationLatencyMillisecondsBucket: telemetryQuantityBucket(elapsedMilliseconds),
    ...(receipt.matchedCount === undefined
      ? {}
      : {codeAnchorFinalizationMatchedBucket: telemetryQuantityBucket(receipt.matchedCount)}),
    codeAnchorFinalizationPendingBucket: telemetryQuantityBucket(receipt.pendingCount),
    codeAnchorFinalizationResult: result,
    codeAnchorFinalizationScannedBucket: telemetryQuantityBucket(receipt.scannedCount),
  };
}

export function telemetryQuantityBucket(value: number): AnonymousTelemetryQuantityBucket | undefined {
  if (!isPrivateCount(value)) return undefined;
  return value === 0 ? '0' : `2^${Math.min(52, Math.floor(Math.log2(value)))}`;
}

function finalizationResult(
  receipt: CodeAnchorFinalizationTelemetryReceipt,
): AnonymousTelemetryCodeAnchorFinalizationResult | undefined {
  if (receipt.state === 'failed') return 'failed';
  if (receipt.state === 'contended') return 'contended';
  if (receipt.scannedCount === 0) return 'no-work';
  const outcomes: readonly [AnonymousTelemetryCodeAnchorFinalizationResult, number][] = [
    ['finalized', receipt.finalizedCount],
    ['pending', receipt.pendingCount],
    ['conflict', receipt.conflictCount],
    ['failed', receipt.failedCount],
  ];
  const nonEmpty = EffectArray.filter(outcomes, entry => entry[1] > 0);
  if (nonEmpty.length === 1) return nonEmpty[0][0];
  if (nonEmpty.length > 1) return 'mixed';
  return undefined;
}

function isPrivateCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

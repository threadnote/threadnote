import {Effect, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  codeGraphCliReadPlan,
  codeGraphCliUsesBorrowedContinuity,
  type CodeGraphCliFreshnessPolicy,
  type CodeGraphCliReadPlan,
} from '../cli/freshness.js';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '../query.js';
import {
  CodeGraphSnapshotUnavailable,
  type CodeGraphQueryOptions,
  type CodeGraphQueryResult,
  type CodeGraphStatus,
} from '../types.js';

type CodeGraphQueryServiceShape = Parameters<typeof CodeGraphQueryService.of>[0];

const STRICT_BORROWED_READ_PLAN = {
  refresh: false,
  strictFreshness: true,
  unavailable: false,
} satisfies CodeGraphCliReadPlan;

export function readCodeGraphCliWithContinuity<E, R>(
  continuity: {readonly borrowedContinuity: boolean; readonly readPlan: CodeGraphCliReadPlan},
  read: (plan: CodeGraphCliReadPlan, reuseStatusObservation: boolean) => Effect.Effect<CodeGraphQueryResult, E, R>,
): Effect.Effect<{readonly borrowedContinuity: boolean; readonly result: CodeGraphQueryResult}, E, R> {
  return Effect.gen(function* () {
    if (!continuity.borrowedContinuity) {
      return {borrowedContinuity: false, result: yield* read(continuity.readPlan, true)};
    }
    const borrowed = yield* read(STRICT_BORROWED_READ_PLAN, true).pipe(
      Effect.map(result => ({result, state: 'ready' as const})),
      Effect.catchIf(Schema.is(CodeGraphSnapshotUnavailable), () => Effect.succeed({state: 'unavailable' as const})),
    );
    if (borrowed.state === 'ready' && borrowed.result.freshness === 'current') {
      return {borrowedContinuity: true, result: borrowed.result};
    }
    return {borrowedContinuity: false, result: yield* read(continuity.readPlan, false)};
  });
}

/** Resolve a shared read before any bounded foreground refresh is considered. */
export const resolveCodeGraphCliReadContinuity = Effect.fn('codeGraph.command.resolveReadContinuity')(function* (
  config: RuntimeConfig,
  service: CodeGraphQueryServiceShape,
  initialStatus: CodeGraphStatus,
  operation: CodeGraphQueryOptions['operation'],
  freshness: CodeGraphCliFreshnessPolicy,
) {
  let status = initialStatus;
  if (status.stale || !status.readySnapshot) {
    status = yield* service.attachSharedReadySnapshot(config.agentContextHome, status.identity, status, {
      allowBorrowedStale: freshness !== 'current' || (operation !== 'impact' && operation !== 'path'),
    });
  }
  const statusObservation = observationFromCodeGraphStatus(status);
  const borrowedContinuity = codeGraphCliUsesBorrowedContinuity(
    freshness,
    operation,
    status,
    statusObservation?.borrowedSnapshotId !== undefined,
    statusObservation?.overlay?.dirty === false,
  );
  const readPlan = codeGraphCliReadPlan(freshness, status);
  return {borrowedContinuity, readPlan, status, statusObservation};
});

import {Array as EffectArray, Clock, DateTime, Effect, FileSystem, Path} from 'effect';
import * as EffectRecord from 'effect/Record';
import {errorMessage} from '@threadnote/platform/errors';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {readCanonicalMutationGeneration} from '@threadnote/store/resource/mutation_generation';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ContextMaintenanceWorkerQuiet, MaintenanceState} from './maintenance_contracts.js';
import type {MaintenanceWorkSchedule} from './maintenance_decisions.js';
import {readDraftQueueNextEligibleAt} from './maintenance_draft_queue.js';
import {
  contextMaintenanceEvidenceRequestKey,
  readContextMaintenanceEvidenceRequestPage,
  type ContextMaintenanceEvidenceRequest,
} from './maintenance_evidence.js';
import {readRawState, readState, withStateLock, writeState} from './maintenance.js';

const WAKE_INTERVAL_MS = 30_000;
const MAX_WAKE_INTERVAL_MS = 30 * 60_000;
const MAX_FAILED_WAKE_INTERVAL_MS = 5 * 60_000;
const STATE_LOCK = {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 60_000};
/** A worker tick serves one phase of the work schedule, so one quiet tick per phase is a full rotation. */
const ROTATING_WORK_PHASES = EffectRecord.size({
  records: true,
  semantic: true,
  requested: true,
  topic: true,
} satisfies Record<MaintenanceWorkSchedule['nextPhase'], true>);

/**
 * Rotating cursors, timestamps and retry times are excluded: a tick that only moves them made no progress.
 * Evidence requests keep their progress in request files. Every URI a tick selects is either cleared or
 * deferred, so the remaining and deferred URI sets show each attempt; a repeated deferral is quiet.
 */
export function contextMaintenanceProgressFingerprint(
  state: MaintenanceState,
  requests: readonly ContextMaintenanceEvidenceRequest[],
): string {
  const sorted = (items: readonly unknown[]) => EffectArray.map(items, item => JSON.stringify(item)).sort();
  return sha256HexSync(
    JSON.stringify([
      sorted(EffectArray.map(state.cases, item => [item.caseId, item.disposition, item.reason, item.evidenceRevision])),
      sorted(EffectArray.map(state.receipts, item => [item.receiptId, item.state])),
      state.workSchedule?.requestDiscovery?.namesHash ?? null,
      sorted(EffectRecord.toEntries(state.semanticProgress ?? {})),
      sorted(
        EffectArray.map(EffectRecord.toEntries(state.checkpoints), ([key, item]) => [
          key,
          item.memoryHash ?? null,
          item.revision,
        ]),
      ),
      sorted(
        EffectArray.map(EffectRecord.toEntries(state.topicCheckpoints ?? {}), ([key, item]) => [
          key,
          item.targetHash,
          item.revision,
          item.outcome,
        ]),
      ),
      sorted(
        EffectArray.map(requests, request => [
          contextMaintenanceEvidenceRequestKey(request),
          [...request.uris].sort(),
          EffectRecord.keys(request.deferredUntil ?? {}).sort(),
        ]),
      ),
    ]),
  );
}

function earliestDeadlineAfter(deadlines: readonly (string | number | undefined)[], after: number): number {
  return EffectArray.reduce(deadlines, Number.POSITIVE_INFINITY, (earliest, deadline) => {
    const at = typeof deadline === 'string' ? Date.parse(deadline) : (deadline ?? Number.NaN);
    return at > after && at < earliest ? at : earliest;
  });
}

/**
 * An overdue deadline waits for its phase, so it counts as pending until one full rotation of quiet ticks. After that
 * rotation it belongs to work that maintenance cannot complete, and only deadlines after `at` are pending.
 */
function pendingDeadlineFloor(streak: number, at: number): number {
  return streak < ROTATING_WORK_PHASES ? Number.NEGATIVE_INFINITY : at;
}

/** The streak restarts when progress, a canonical mutation, or recovery from a failed state appears. */
export function nextContextMaintenanceWorkerQuiet(
  state: MaintenanceState,
  requests: readonly ContextMaintenanceEvidenceRequest[],
  canonicalGeneration: string,
  now: number,
  draftNextEligibleAt?: number,
): ContextMaintenanceWorkerQuiet {
  const fingerprint = contextMaintenanceProgressFingerprint(state, requests);
  const previous = state.workerQuiet;
  const quiet =
    previous?.failed !== true &&
    previous?.fingerprint === fingerprint &&
    previous.canonicalGeneration === canonicalGeneration;
  const streak = quiet ? previous.streak + 1 : 0;
  const retryAt = earliestDeadlineAfter(
    [
      ...EffectArray.flatMap(requests, request => EffectArray.map(request.uris, uri => request.deferredUntil?.[uri])),
      draftNextEligibleAt,
    ],
    pendingDeadlineFloor(streak, now),
  );
  return {
    fingerprint,
    canonicalGeneration,
    streak,
    ...(Number.isFinite(retryAt) ? {retryAt: DateTime.formatIso(DateTime.makeUnsafe(retryAt))} : {}),
  };
}

/**
 * A tick serves one phase, so a pending deadline already due at the last wake keeps the thirty-second interval.
 * A failed state cannot serve deadlines or mutations, so it only backs off, and the cap keeps the retry regular.
 */
export function contextMaintenanceWakeIntervalMs(
  state: Pick<MaintenanceState, 'state' | 'cases' | 'checkpoints' | 'workerQuiet'>,
  lastWakeAt: number,
  canonicalGeneration: string | undefined,
): number {
  const quiet = state.workerQuiet;
  if (state.state === 'failed')
    return Math.min(WAKE_INTERVAL_MS * 2 ** (quiet?.streak ?? 0), MAX_FAILED_WAKE_INTERVAL_MS);
  if (quiet === undefined || quiet.failed === true || quiet.canonicalGeneration !== canonicalGeneration)
    return WAKE_INTERVAL_MS;
  const deadline = earliestDeadlineAfter(
    [
      quiet.retryAt,
      ...EffectArray.map(EffectRecord.values(state.checkpoints), item => item.retryAt),
      ...EffectArray.map(
        EffectArray.filter(state.cases, item => item.disposition === 'waiting-evidence'),
        item => item.nextAttemptAt,
      ),
    ],
    pendingDeadlineFloor(quiet.streak, lastWakeAt),
  );
  const backoff = Math.min(WAKE_INTERVAL_MS * 2 ** quiet.streak, MAX_WAKE_INTERVAL_MS);
  return Math.max(WAKE_INTERVAL_MS, Math.min(backoff, deadline - lastWakeAt));
}

/** Wakes without an owner (CLI mutations) bypass the backoff and keep the fixed coalescing interval. */
export const contextMaintenanceWakeDue = Effect.fn('contextMaintenance.wakeDue')(function* (
  config: RuntimeConfig,
  state: MaintenanceState,
  now: number,
  bindToParent: boolean | undefined,
) {
  const lastWakeAt = state.lastWakeAt === undefined ? Number.NaN : Date.parse(state.lastWakeAt);
  if (!Number.isFinite(lastWakeAt)) return true;
  if (now - lastWakeAt < WAKE_INTERVAL_MS) return false;
  if (!bindToParent || state.workerQuiet === undefined) return true;
  const generation = yield* currentCanonicalGeneration(config).pipe(Effect.orElseSucceed(() => undefined));
  return now - lastWakeAt >= contextMaintenanceWakeIntervalMs(state, lastWakeAt, generation);
});

/**
 * Only the guarded worker records its ticks; a foreground run is compared at the next worker tick.
 * The maintain command reports failure through its exit code or a persisted failed state. A persisted failed state
 * advances the streak and marks the record failed, so the next successful tick restarts the streak.
 */
export const recordContextMaintenanceWorkerTick = Effect.fn('contextMaintenance.recordWorkerTick')(
  function* (config: RuntimeConfig, tickExitCode: number | string | null | undefined) {
    if (Number(tickExitCode ?? 0) !== 0) return;
    const {requests} = yield* readContextMaintenanceEvidenceRequestPage(config);
    // The same worker runs draft generation, which retries without a canonical mutation.
    const draftNextEligibleAt = yield* readDraftQueueNextEligibleAt(config).pipe(Effect.orElseSucceed(() => undefined));
    yield* withStateLock(
      config,
      Effect.gen(function* () {
        const state = yield* readState(config);
        if (state.paused) return;
        const previous = state.workerQuiet;
        const workerQuiet: ContextMaintenanceWorkerQuiet =
          state.state === 'failed'
            ? {
                fingerprint: previous?.fingerprint ?? '',
                canonicalGeneration: previous?.canonicalGeneration ?? '',
                streak: (previous?.streak ?? 0) + 1,
                failed: true,
              }
            : nextContextMaintenanceWorkerQuiet(
                state,
                requests,
                yield* currentCanonicalGeneration(config),
                yield* Clock.currentTimeMillis,
                draftNextEligibleAt,
              );
        yield* writeState(config, {...state, workerQuiet});
      }),
      {...STATE_LOCK, waitTimeoutMilliseconds: 10_000},
    );
  },
  Effect.catch(error =>
    Effect.logWarning(`Context maintenance kept its wake backoff unchanged: ${errorMessage(error)}`),
  ),
);

/** Resume is a foreground choice, so it waits out a short maintenance write before it reports a warning. */
export const clearContextMaintenanceWorkerQuiet = Effect.fn('contextMaintenance.clearWorkerQuiet')(
  function* (config: RuntimeConfig) {
    yield* withStateLock(
      config,
      Effect.gen(function* () {
        const {workerQuiet, ...state} = yield* readRawState(config);
        if (workerQuiet !== undefined) yield* writeState(config, state);
      }),
      {...STATE_LOCK, waitTimeoutMilliseconds: 5_000},
    );
  },
  Effect.catch(error =>
    Effect.logWarning(
      `Context maintenance resumed, but the first automatic wake can wait for the old backoff: ${errorMessage(error)}`,
    ),
  ),
);

const currentCanonicalGeneration = Effect.fn('contextMaintenance.canonicalGeneration')(function* (
  config: RuntimeConfig,
) {
  return yield* readCanonicalMutationGeneration(
    yield* FileSystem.FileSystem,
    yield* Path.Path,
    config.agentContextHome,
    config.account,
  );
});

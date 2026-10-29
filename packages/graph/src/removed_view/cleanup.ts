import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES,
  type CodeGraphRemovedViewCleanupAuthorizationResult,
  type CodeGraphRemovedViewCleanupBlockedCode,
  type CodeGraphRemovedViewCleanupEntry,
  type CodeGraphRemovedViewCleanupUpdate,
  type CodeGraphRemovedViewCleanupUpdateResult,
} from '../store.js';
import {isCodeGraphRemovedViewBuildStatusCursor} from './build_cleanup.js';

export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_BURST_UNITS = 8;
export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_BURST_MILLISECONDS = 250;
export const CODE_GRAPH_REMOVED_VIEW_CLEANUP_BURST_PAUSE_MILLISECONDS = 25;

const MAXIMUM_CANONICAL_DATE_MILLISECONDS = 253_402_300_799_999;
const INVALID_SIDECAR_RETRY_MILLISECONDS = 30_000;
const VECTOR_PHASE_CURSOR =
  /^vp1:(r|n|a):([0-9a-f]{64})(?::([a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?))?(?::([0-9]+))?$/u;

export interface CodeGraphRemovedViewCleanupWorkerInput {
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly threadnoteHome: string;
}

export type CodeGraphRemovedViewCleanupPageResult =
  | {readonly state: 'complete'}
  | {
      readonly cursorToken: string;
      /** Optional scheduling cooldown for a boundedly observed, preserved candidate. */
      readonly retryAfterMilliseconds?: number;
      readonly state: 'progress';
    }
  | {
      readonly blockedCode: CodeGraphRemovedViewCleanupBlockedCode;
      readonly retryAfterMilliseconds: number;
      readonly state: 'deferred';
    };

export interface CodeGraphRemovedViewCleanupVectorPreparation {
  /** Absolute monotonic deadline for bounded planning and receipt admission. */
  readonly deadlineMonotonicMilliseconds: number;
  /** Exactly one immediate capacity attempt: no wait, sleep, or maintenance recursion. */
  readonly reservationMode: 'nonblocking-one-attempt';
}

export interface CodeGraphRemovedViewCleanupWorkerDependencies {
  readonly authorize: (
    input: CodeGraphRemovedViewCleanupWorkerInput,
    entry: CodeGraphRemovedViewCleanupEntry,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupAuthorizationResult, unknown>;
  readonly claim: (
    input: CodeGraphRemovedViewCleanupWorkerInput,
    nowMilliseconds: number,
    limit: number,
  ) => Effect.Effect<readonly CodeGraphRemovedViewCleanupEntry[], unknown>;
  readonly cleanupBuildStatusUnit: (
    input: CodeGraphRemovedViewCleanupWorkerInput,
    entry: CodeGraphRemovedViewCleanupEntry,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupPageResult, unknown>;
  readonly cleanupProvenanceUnit: (
    input: CodeGraphRemovedViewCleanupWorkerInput,
    entry: CodeGraphRemovedViewCleanupEntry,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupPageResult, unknown>;
  /**
   * Plan and enter the capacity receipt before invoking `use`. The supplied
   * commit effect acquires and releases its model lock when `use` evaluates
   * it; the Store CAS in `use` therefore runs after the model lock is released
   * while the receipt and target lock remain held. Planning and receipt
   * admission share the finite deadline, while reservationMode forbids
   * capacity waiting or maintenance recursion.
   */
  readonly withPreparedVectorUnit: <A, E>(
    input: CodeGraphRemovedViewCleanupWorkerInput,
    entry: CodeGraphRemovedViewCleanupEntry,
    preparation: CodeGraphRemovedViewCleanupVectorPreparation,
    use: (commit: Effect.Effect<CodeGraphRemovedViewCleanupPageResult, unknown>) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, unknown>;
  /** Monotonic elapsed-time source; never use wall clock for the burst deadline. */
  readonly monotonicMilliseconds: Effect.Effect<number, never>;
  readonly nowMilliseconds: Effect.Effect<number, never>;
  readonly sleep: (milliseconds: number) => Effect.Effect<void, never>;
  readonly update: (
    input: CodeGraphRemovedViewCleanupWorkerInput,
    entry: CodeGraphRemovedViewCleanupEntry,
    update: CodeGraphRemovedViewCleanupUpdate,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupUpdateResult, unknown>;
  readonly withTargetLock: <A, E>(
    input: CodeGraphRemovedViewCleanupWorkerInput,
    worktreeId: string,
    effect: Effect.Effect<A, E>,
    scopeId?: string,
  ) => Effect.Effect<A, unknown>;
}

export interface CodeGraphRemovedViewCleanupWorkerResult {
  readonly advanced: number;
  readonly claimed: number;
  readonly deferred: number;
  readonly progressed: number;
  readonly remaining: boolean;
  readonly stale: number;
  readonly state: 'deferred' | 'idle' | 'worked';
}

export interface CodeGraphRemovedViewCleanupWorkerShape {
  /** One foreground-safe cleanup unit with one nonblocking capacity attempt. */
  readonly tick: (
    input: CodeGraphRemovedViewCleanupWorkerInput,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupWorkerResult, never>;
  /** At most eight units or 250 ms; a claimed unit always finishes before the deadline is observed again. */
  readonly burst: (
    input: CodeGraphRemovedViewCleanupWorkerInput,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupWorkerResult, never>;
}

interface MutableWorkerResult {
  advanced: number;
  claimed: number;
  deferred: number;
  progressed: number;
  stale: number;
}

export const makeCodeGraphRemovedViewCleanupWorker = Effect.fn('codeGraph.makeRemovedViewCleanupWorker')(
  (dependencies: CodeGraphRemovedViewCleanupWorkerDependencies) =>
    Effect.sync(() => {
      const run = (
        input: CodeGraphRemovedViewCleanupWorkerInput,
        maximumUnits: number,
        maximumDurationMilliseconds: number,
      ): Effect.Effect<CodeGraphRemovedViewCleanupWorkerResult, never> =>
        Effect.gen(function* () {
          const result: MutableWorkerResult = {advanced: 0, claimed: 0, deferred: 0, progressed: 0, stale: 0};
          const startedAt = yield* dependencies.monotonicMilliseconds;
          const preparation: CodeGraphRemovedViewCleanupVectorPreparation = {
            deadlineMonotonicMilliseconds: startedAt + maximumDurationMilliseconds,
            reservationMode: 'nonblocking-one-attempt',
          };
          let remaining = true;
          let claimUnavailable = false;

          while (result.claimed < maximumUnits) {
            if (result.claimed > 0) {
              const observedAt = yield* dependencies.monotonicMilliseconds;
              if (observedAt - startedAt >= maximumDurationMilliseconds) break;
            }
            const claimAt = yield* dependencies.nowMilliseconds;
            const claimed = yield* dependencies.claim(input, claimAt, 1).pipe(
              Effect.match({
                onFailure: () => undefined,
                onSuccess: entries => entries,
              }),
            );
            if (claimed === undefined || claimed.length > 1) {
              claimUnavailable = true;
              break;
            }
            const entry = claimed[0];
            if (entry === undefined) {
              remaining = false;
              break;
            }

            result.claimed += 1;
            const outcome = yield* runClaimedUnit(dependencies, input, entry, preparation);
            result[outcome] += 1;
            if (result.claimed < maximumUnits) {
              const beforePause = yield* dependencies.monotonicMilliseconds;
              const remainingMilliseconds = maximumDurationMilliseconds - (beforePause - startedAt);
              if (remainingMilliseconds <= 0) break;
              yield* dependencies.sleep(
                Math.min(CODE_GRAPH_REMOVED_VIEW_CLEANUP_BURST_PAUSE_MILLISECONDS, remainingMilliseconds),
              );
            }
          }

          if (result.claimed === 0) {
            return {
              ...result,
              remaining: claimUnavailable,
              state: claimUnavailable ? ('deferred' as const) : ('idle' as const),
            };
          }
          return {...result, remaining, state: 'worked' as const};
        });

      return {
        burst: input =>
          run(input, CODE_GRAPH_REMOVED_VIEW_CLEANUP_BURST_UNITS, CODE_GRAPH_REMOVED_VIEW_CLEANUP_BURST_MILLISECONDS),
        tick: input => run(input, 1, CODE_GRAPH_REMOVED_VIEW_CLEANUP_BURST_MILLISECONDS),
      } satisfies CodeGraphRemovedViewCleanupWorkerShape;
    }),
);

const runClaimedUnit = Effect.fn('codeGraph.runRemovedViewCleanupUnit')(function* (
  dependencies: CodeGraphRemovedViewCleanupWorkerDependencies,
  input: CodeGraphRemovedViewCleanupWorkerInput,
  entry: CodeGraphRemovedViewCleanupEntry,
  preparation: CodeGraphRemovedViewCleanupVectorPreparation,
) {
  const execute = (
    cleanup: (
      authorizedEntry: CodeGraphRemovedViewCleanupEntry,
    ) => Effect.Effect<CodeGraphRemovedViewCleanupPageResult, unknown>,
  ) =>
    runAuthorizedCleanupUnit(dependencies, input, entry, cleanup).pipe(Effect.orElseSucceed(() => 'deferred' as const));
  if (entry.cursorToken !== undefined && !validPhaseCursor(entry.phase, entry.cursorToken)) {
    return yield* execute(() => Effect.succeed(invalidSidecarPage()));
  }
  if (entry.phase !== 'vector-pointers') {
    return yield* execute(authorizedEntry => cleanupPage(dependencies, input, authorizedEntry));
  }
  return yield* dependencies
    .withPreparedVectorUnit(input, entry, preparation, commit => execute(() => commit))
    .pipe(Effect.orElseSucceed(() => 'deferred' as const));
});

const runAuthorizedCleanupUnit = Effect.fn('codeGraph.runAuthorizedRemovedViewCleanupUnit')(function* (
  dependencies: CodeGraphRemovedViewCleanupWorkerDependencies,
  input: CodeGraphRemovedViewCleanupWorkerInput,
  entry: CodeGraphRemovedViewCleanupEntry,
  cleanup: (
    authorizedEntry: CodeGraphRemovedViewCleanupEntry,
  ) => Effect.Effect<CodeGraphRemovedViewCleanupPageResult, unknown>,
) {
  return yield* dependencies.withTargetLock(
    input,
    entry.worktreeId,
    Effect.gen(function* () {
      const authorization = yield* dependencies.authorize(input, entry);
      if (authorization.state === 'stale') return 'stale' as const;
      if (authorization.state === 'active-pointer-changed') return 'deferred' as const;

      const page = yield* cleanup(authorization.entry).pipe(Effect.orElseSucceed(() => ioFailurePage()));
      const normalized = normalizePageResult(authorization.entry, page);
      const now = yield* dependencies.nowMilliseconds;
      const update = updateForPageResult(authorization.entry, normalized, now);
      if (update === undefined) return 'deferred' as const;
      const stored = yield* dependencies.update(input, authorization.entry, update);
      if (stored.state === 'stale') return 'stale' as const;
      if (stored.state === 'active-pointer-changed') return 'deferred' as const;
      return normalized.state === 'complete'
        ? ('advanced' as const)
        : normalized.state === 'progress'
          ? ('progressed' as const)
          : ('deferred' as const);
    }),
    entry.scopeId,
  );
});

function cleanupPage(
  dependencies: CodeGraphRemovedViewCleanupWorkerDependencies,
  input: CodeGraphRemovedViewCleanupWorkerInput,
  entry: CodeGraphRemovedViewCleanupEntry,
): Effect.Effect<CodeGraphRemovedViewCleanupPageResult, unknown> {
  if (entry.phase === 'build-status') return dependencies.cleanupBuildStatusUnit(input, entry);
  if (entry.phase === 'provenance') {
    const evidenceFields = [entry.repositoryId, entry.provenanceRecordDigest, entry.provenanceRecordIdentity] as const;
    if (EffectArray.every(evidenceFields, value => value === undefined)) return Effect.succeed({state: 'complete'});
    if (EffectArray.some(evidenceFields, value => value === undefined)) {
      return Effect.succeed(invalidSidecarPage());
    }
    return dependencies.cleanupProvenanceUnit(input, entry);
  }
  return Effect.succeed(invalidSidecarPage());
}

function normalizePageResult(
  entry: CodeGraphRemovedViewCleanupEntry,
  result: CodeGraphRemovedViewCleanupPageResult,
): CodeGraphRemovedViewCleanupPageResult {
  if (result.state === 'complete') return result;
  if (result.state === 'deferred') {
    return validRetry(result.retryAfterMilliseconds) ? result : invalidSidecarPage();
  }
  if (
    entry.phase === 'provenance' ||
    result.cursorToken === entry.cursorToken ||
    !validPhaseCursor(entry.phase, result.cursorToken) ||
    (result.retryAfterMilliseconds !== undefined && !validRetry(result.retryAfterMilliseconds))
  ) {
    return invalidSidecarPage();
  }
  return result;
}

function updateForPageResult(
  entry: CodeGraphRemovedViewCleanupEntry,
  result: CodeGraphRemovedViewCleanupPageResult,
  nowMilliseconds: number,
): CodeGraphRemovedViewCleanupUpdate | undefined {
  if (!validNow(nowMilliseconds)) return undefined;
  const updatedAt = new Date(Math.max(nowMilliseconds, Date.parse(entry.updatedAt))).toISOString();
  if (result.state === 'progress') {
    const nextAttemptAt =
      result.retryAfterMilliseconds === undefined
        ? safeAdd(nowMilliseconds, 1)
        : safeAdd(nowMilliseconds, result.retryAfterMilliseconds);
    if (nextAttemptAt === undefined) return undefined;
    return {
      attempts: entry.attempts,
      cursorToken: result.cursorToken,
      nextAttemptAt,
      phase: entry.phase,
      updatedAt,
    };
  }
  if (result.state === 'deferred') {
    if (entry.attempts >= Number.MAX_SAFE_INTEGER || entry.nextAttemptAt >= MAXIMUM_CANONICAL_DATE_MILLISECONDS) {
      return undefined;
    }
    const delayed = safeAdd(nowMilliseconds, result.retryAfterMilliseconds);
    if (delayed === undefined) return undefined;
    return {
      attempts: entry.attempts + 1,
      blockedCode: result.blockedCode,
      cursorToken: entry.cursorToken,
      nextAttemptAt: Math.max(entry.nextAttemptAt + 1, delayed),
      phase: entry.phase,
      updatedAt,
    };
  }
  const phaseIndex = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(entry.phase);
  const nextPhase = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES[phaseIndex + 1];
  if (nextPhase === undefined) return undefined;
  const nextAttemptAt = safeAdd(nowMilliseconds, 1);
  return nextAttemptAt === undefined ? undefined : {attempts: 0, nextAttemptAt, phase: nextPhase, updatedAt};
}

function validPhaseCursor(phase: CodeGraphRemovedViewCleanupEntry['phase'], cursor: string): boolean {
  if (phase === 'vector-pointers') return isCodeGraphRemovedViewVectorCursor(cursor);
  if (phase === 'build-status') return isCodeGraphRemovedViewBuildStatusCursor(cursor);
  return false;
}

/** Exact durable grammar emitted by the vector retirement adapter. */
export function isCodeGraphRemovedViewVectorCursor(cursor: string): boolean {
  const match = VECTOR_PHASE_CURSOR.exec(cursor);
  if (match === null) return false;
  const [, mode, , modelName, stepText] = match;
  if (mode === 'r') return modelName === undefined && stepText === undefined;
  if (mode === 'n') return modelName !== undefined && stepText === undefined;
  if (mode !== 'a' || modelName === undefined || stepText === undefined || !/^[1-9][0-9]*$/u.test(stepText)) {
    return false;
  }
  const step = Number(stepText);
  return Number.isSafeInteger(step) && step > 0 && String(step) === stepText;
}

function validRetry(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAXIMUM_CANONICAL_DATE_MILLISECONDS;
}

function validNow(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAXIMUM_CANONICAL_DATE_MILLISECONDS;
}

function safeAdd(left: number, right: number): number | undefined {
  const value = left + right;
  return Number.isSafeInteger(value) && value <= MAXIMUM_CANONICAL_DATE_MILLISECONDS ? value : undefined;
}

function invalidSidecarPage(): CodeGraphRemovedViewCleanupPageResult {
  return {
    blockedCode: 'invalid-sidecar',
    retryAfterMilliseconds: INVALID_SIDECAR_RETRY_MILLISECONDS,
    state: 'deferred',
  };
}

function ioFailurePage(): CodeGraphRemovedViewCleanupPageResult {
  return {blockedCode: 'io-error', retryAfterMilliseconds: 1_000, state: 'deferred'};
}

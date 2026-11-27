import {isServableVectorReadiness, RecallReadyReadBoundary, type RecallSemanticPreflight} from './read_boundary.js';
import {CallerReadCancellation, hasReadCleanupUnconfirmed} from '@threadnote/platform/read_deadline';
import {recallPreflightSkipsSemanticRead} from './vector/negative-readiness.js';
import {Array as EffectArray} from 'effect';
import {Cause, Clock, Console, Effect, Option, Result, Schema} from 'effect';
import {recallIndexPreselectionLimit} from '@threadnote/recall/results';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {readModelSelection, selectedEmbeddingModelId} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {currentRecallCorpusGeneration, readRecallIndexData, recallIndexStatus} from './index.js';
import {type RecallEligibilityPolicy} from './eligibility.js';
import {VectorCorpusGenerationChanged, VectorIndexCorrupt} from './vector-index.js';
import {selectedSemanticScoreSnapshot} from './vector/semantic-read.js';
import {
  catchRecallRefreshEnqueueUnavailable,
  lexicalRefreshDisposition,
  olderReadRefreshWarning,
  staleReadRefreshWarning,
  scheduleMcpRecallBackgroundRefresh,
  scheduleMcpRecallBackgroundRefreshReceipt,
} from './mcp/refresh.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

import type {RecallRuntimeConfig} from './runtime.js';

/** The semantic score path of recall: the MCP and CLI reads, their retrieval gate and their warnings. */
export const SEMANTIC_GENERATION_RETRY_LIMIT = 2;
export const MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS = 30_000;
export const MCP_RECALL_SEMANTIC_TIMEOUT_COOLDOWN_MILLISECONDS = 60_000;

export interface RecallSemanticScoresResult {
  /** For a masked read, the lexical generation of its mask, not the served vector corpus. */
  readonly corpusGeneration: Option.Option<string>;
  readonly scores: Option.Option<ReadonlyMap<string, number>>;
  readonly warning: Option.Option<string>;
}

export type BoundedRecallSemanticRetrieval<A> =
  | {readonly status: 'completed'; readonly value: A}
  | {readonly cause: Cause.Cause<unknown>; readonly status: 'failed'}
  | {readonly status: 'timed-out'};

export type GatedRecallSemanticRetrieval<A> = BoundedRecallSemanticRetrieval<A> | {readonly status: 'cooldown'};

export interface McpRecallSemanticScoresResult {
  readonly result: RecallSemanticScoresResult;
  readonly status: 'available' | 'failed' | 'timed-out' | 'unavailable';
}

type McpReadOnlySemanticScoresAttempt =
  | {readonly manifest: LocalModelManifest; readonly read: ServedSemanticRead; readonly state: 'available'}
  | {readonly manifest: LocalModelManifest; readonly state: 'refreshable'}
  | {readonly state: 'structurally-unavailable'}
  | {readonly state: 'unavailable'};

export function emptyRecallSemanticScoresResult(
  warning: Option.Option<string> = Option.none(),
): RecallSemanticScoresResult {
  return {
    corpusGeneration: Option.none(),
    scores: Option.none(),
    warning,
  };
}

export function boundedRecallSemanticRetrieval<A, E, R>(
  retrieval: Effect.Effect<A, E, R>,
): Effect.Effect<BoundedRecallSemanticRetrieval<A>, E, R> {
  return retrieval.pipe(
    Effect.map(value => ({status: 'completed' as const, value})),
    Effect.catchCauseIf(
      cause => !Cause.hasInterrupts(cause) && !hasReadCleanupUnconfirmed(cause),
      cause => Effect.succeed({cause: cause, status: 'failed' as const}),
    ),
    Effect.catchCause(cause => Effect.failCause(cause)),
    work =>
      Effect.flatMap(CallerReadCancellation, caller =>
        caller
          ? work
          : work.pipe(
              Effect.timeoutOrElse({
                duration: MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS,
                orElse: () => Effect.succeed({status: 'timed-out' as const}),
              }),
            ),
      ),
  );
}

export function createMcpRecallSemanticRetrievalGate() {
  const retryAfterByRuntime = new WeakMap<object, {readonly deadline: bigint}>();
  const cooldownNanos = BigInt(MCP_RECALL_SEMANTIC_TIMEOUT_COOLDOWN_MILLISECONDS) * 1_000_000n;
  return <A, E, R>(
    runtime: object,
    retrieval: Effect.Effect<A, E, R>,
  ): Effect.Effect<GatedRecallSemanticRetrieval<A>, E, R> =>
    Effect.gen(function* () {
      if (yield* CallerReadCancellation) return yield* boundedRecallSemanticRetrieval(retrieval);
      const now = yield* Clock.monotonicTimeNanos;
      const previousCooldown = retryAfterByRuntime.get(runtime);
      if (previousCooldown && previousCooldown.deadline > now) return {status: 'cooldown'} as const;
      const result = yield* boundedRecallSemanticRetrieval(retrieval);
      if (result.status === 'timed-out') {
        retryAfterByRuntime.set(runtime, {deadline: (yield* Clock.monotonicTimeNanos) + cooldownNanos});
      } else if (retryAfterByRuntime.get(runtime) === previousCooldown) {
        retryAfterByRuntime.delete(runtime);
      }
      return result;
    });
}

const mcpRecallSemanticRetrievalGate = createMcpRecallSemanticRetrievalGate();

/**
 * MCP recall uses only the already-active lexical/vector generations. It never
 * builds, repairs, or retries derived storage while a client request is open.
 */
export const loadMcpRecallSemanticScoresResult = Effect.fn('recall.loadMcpSemanticScoresResult')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
  preflight?: RecallSemanticPreflight,
) {
  const semanticLimit = recallIndexPreselectionLimit(limit);
  const runtime = yield* LocalModelRuntime;
  const attempt = yield* mcpRecallSemanticRetrievalGate(
    runtime,
    loadReadOnlySemanticScoresAttempt(config, query, semanticLimit, eligibility, allowedUriScopes, preflight),
  );
  if (attempt.status === 'cooldown') {
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallCooldownWarning())),
      status: 'unavailable',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.status === 'timed-out') {
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallTimeoutWarning())),
      status: 'timed-out',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.status === 'failed') {
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallFailureWarning(attempt.cause))),
      status: 'failed',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.value.state === 'refreshable') {
    const queued = yield* queueReadRefresh(config, attempt.value.manifest);
    return (
      Result.isSuccess(queued)
        ? {
            result: emptyRecallSemanticScoresResult(Option.some(staleReadRefreshWarning(queued.success))),
            status: 'unavailable',
          }
        : {result: emptyRecallSemanticScoresResult(Option.some(queued.failure)), status: 'failed'}
    ) satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.value.state === 'structurally-unavailable') {
    return {
      result: emptyRecallSemanticScoresResult(Option.some(semanticRecallStructuralWarning())),
      status: 'failed',
    } satisfies McpRecallSemanticScoresResult;
  }
  if (attempt.value.state === 'unavailable') {
    return {result: emptyRecallSemanticScoresResult(), status: 'unavailable'} satisfies McpRecallSemanticScoresResult;
  }
  const {manifest, read} = attempt.value;
  return {
    result: yield* servedSemanticResult(config, manifest, read),
    status: 'available',
  } satisfies McpRecallSemanticScoresResult;
});

const loadReadOnlySemanticScoresAttempt = Effect.fn('recall.loadReadOnlySemanticScoresAttempt')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
  preflight?: RecallSemanticPreflight,
) {
  const selection = yield* readModelSelection(config.agentContextHome);
  const modelId = selectedEmbeddingModelId(selection, 'recall');
  if (!modelId) return {state: 'unavailable'} satisfies McpReadOnlySemanticScoresAttempt;
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== 'embedding') return {state: 'unavailable'} satisfies McpReadOnlySemanticScoresAttempt;
  const store = yield* LocalModelStore;
  const installed = yield* store.status(config.agentContextHome, manifest);
  if (!installed.installed) return {state: 'unavailable'} satisfies McpReadOnlySemanticScoresAttempt;
  if (
    recallPreflightSkipsSemanticRead(
      {
        id: manifest.id,
        sha256: manifest.sha256,
        dimensions: manifest.dimensions ?? 0,
        promptPrefixes: manifest.promptPrefixes,
      },
      preflight,
    )
  )
    return {manifest, state: 'refreshable'} satisfies McpReadOnlySemanticScoresAttempt;
  let lexicalGeneration: string | undefined;
  if (Option.isNone(yield* Effect.serviceOption(RecallReadyReadBoundary))) {
    // Without the boundary, the read binds the lexical generation here; the worker binds its own.
    const lexicalStatus = yield* recallIndexStatus(config, false);
    const lexicalDisposition = lexicalRefreshDisposition(lexicalStatus);
    if (lexicalDisposition === 'refreshable')
      return {manifest, state: 'refreshable'} satisfies McpReadOnlySemanticScoresAttempt;
    if (lexicalDisposition === 'unsafe' || !('generation' in lexicalStatus) || !lexicalStatus.generation)
      return {state: 'structurally-unavailable'} satisfies McpReadOnlySemanticScoresAttempt;
    lexicalGeneration = lexicalStatus.generation;
  }
  const read = yield* readSemantic(config, query, limit, eligibility, allowedUriScopes, lexicalGeneration).pipe(
    Effect.catchCauseIf(
      cause =>
        cause.reasons.length > 0 &&
        EffectArray.every(
          cause.reasons,
          reason => Cause.isFailReason(reason) && Schema.is(VectorCorpusGenerationChanged)(reason.error),
        ),
      () => Effect.succeed('changed' as const),
    ),
  );
  if (read === 'changed') return {manifest, state: 'refreshable'} satisfies McpReadOnlySemanticScoresAttempt;
  if (read === undefined)
    return lexicalGeneration === undefined
      ? ({state: 'unavailable'} satisfies McpReadOnlySemanticScoresAttempt)
      : ({manifest, state: 'refreshable'} satisfies McpReadOnlySemanticScoresAttempt);
  if (read.readiness === 'corrupt' || read.readiness === 'lexical-unavailable')
    return {state: 'structurally-unavailable'} satisfies McpReadOnlySemanticScoresAttempt;
  const served = servedSemanticRead(read);
  // Every unserved read, also a servable one whose scores were withdrawn mid-read, keeps the refresh queued.
  return served === undefined
    ? ({manifest, state: 'refreshable'} satisfies McpReadOnlySemanticScoresAttempt)
    : ({manifest, read: served, state: 'available'} satisfies McpReadOnlySemanticScoresAttempt);
});

/** The one semantic read of every path; the snapshot decides the readiness and runs any masked decision once. */
const readSemantic = (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
  eligibility: RecallEligibilityPolicy | undefined,
  allowedUriScopes: readonly string[] | undefined,
  lexicalGeneration: string | undefined,
) =>
  selectedSemanticScoreSnapshot(config, query, {
    allowedUriScopes,
    eligibility,
    limit,
    ...(lexicalGeneration === undefined
      ? {}
      : {corpusGeneration: lexicalGeneration, currentCorpusGeneration: () => currentRecallCorpusGeneration(config)}),
  }).pipe(
    Effect.map(snapshot =>
      snapshot === undefined
        ? undefined
        : {...snapshot, corpusGeneration: snapshot.corpusGeneration ?? lexicalGeneration},
    ),
  );

interface ServedSemanticRead {
  readonly readiness: 'current' | 'serving-older';
  readonly corpusGeneration: string;
  readonly scores: ReadonlyMap<string, number>;
}
const servedSemanticRead = (
  read: Effect.Success<ReturnType<typeof readSemantic>> & object,
): ServedSemanticRead | undefined =>
  isServableVectorReadiness(read.readiness) && read.scores !== undefined && read.corpusGeneration !== undefined
    ? {readiness: read.readiness, corpusGeneration: read.corpusGeneration, scores: read.scores}
    : undefined;

/** A read-triggered enqueue: its receipt, or the warning of a failed enqueue, which never fails the read. */
const queueReadRefresh = (config: RecallRuntimeConfig, manifest: LocalModelManifest, corpusGeneration?: string) =>
  scheduleMcpRecallBackgroundRefreshReceipt(config, manifest, corpusGeneration).pipe(
    Effect.map(receipt => Result.succeed(receipt)),
    catchRecallRefreshEnqueueUnavailable(warning => Effect.succeed(Result.fail(warning))),
  );

/** Served scores; a masked read keeps the refresh queued and warns only when that refresh is blocked or fails. */
const servedSemanticResult = Effect.fn('recall.servedSemanticResult')(function* (
  config: RecallRuntimeConfig,
  manifest: LocalModelManifest,
  read: ServedSemanticRead,
) {
  const queued =
    read.readiness === 'serving-older' ? yield* queueReadRefresh(config, manifest, read.corpusGeneration) : undefined;
  const warning =
    queued === undefined
      ? Option.none<string>()
      : Result.isSuccess(queued)
        ? olderReadRefreshWarning(queued.success)
        : Option.some(queued.failure);
  return {
    corpusGeneration: Option.some(read.corpusGeneration),
    scores: Option.some(read.scores),
    warning,
  } satisfies RecallSemanticScoresResult;
});

export const semanticResultMatchesLexicalSnapshot = Effect.fn('recall.semanticResultMatchesLexicalSnapshot')(function* (
  config: RecallRuntimeConfig,
  semanticResult: RecallSemanticScoresResult,
  snapshotGenerations: readonly string[],
) {
  if (Option.isNone(semanticResult.scores)) return true;
  // A masked result carries its mask generation here, so it is accepted only for that lexical snapshot.
  if (Option.isNone(semanticResult.corpusGeneration)) return false;
  const semanticGeneration = semanticResult.corpusGeneration.value;
  if (snapshotGenerations.length !== 1 || snapshotGenerations[0] !== semanticGeneration) {
    return false;
  }
  const currentGeneration = yield* currentRecallCorpusGeneration(config);
  return Option.isSome(currentGeneration) && currentGeneration.value === semanticGeneration;
});

export const loadRecallSemanticScoresResult = Effect.fn('recall.loadSemanticScoresResult')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
  preflight?: RecallSemanticPreflight,
) {
  return yield* Effect.gen(function* () {
    const selection = yield* readModelSelection(config.agentContextHome);
    const modelId = selectedEmbeddingModelId(selection, 'recall');
    if (!modelId) return undefined;
    const catalog = yield* LocalModelCatalog;
    const manifest = yield* catalog.get(modelId);
    if (manifest.role !== 'embedding') return undefined;
    const store = yield* LocalModelStore;
    const installed = yield* store.status(config.agentContextHome, manifest);
    if (!installed.installed) return undefined;
    if (
      recallPreflightSkipsSemanticRead(
        {
          id: manifest.id,
          sha256: manifest.sha256,
          dimensions: manifest.dimensions ?? 0,
          promptPrefixes: manifest.promptPrefixes,
        },
        preflight,
      )
    ) {
      yield* scheduleMcpRecallBackgroundRefresh(config, manifest);
      return undefined;
    }
    const semanticLimit = recallIndexPreselectionLimit(limit);
    return yield* loadCurrentSemanticScores(config, manifest, query, semanticLimit, eligibility, allowedUriScopes);
  }).pipe(
    Effect.map(result => result ?? emptyRecallSemanticScoresResult()),
    Effect.catchCauseIf(
      cause => !Cause.hasInterrupts(cause) && !hasReadCleanupUnconfirmed(cause),
      cause => Effect.succeed(emptyRecallSemanticScoresResult(Option.some(semanticRecallFailureWarning(cause)))),
    ),
  );
});

const loadCurrentSemanticScores = Effect.fn('recall.loadCurrentSemanticScores')(function* (
  config: RecallRuntimeConfig,
  manifest: LocalModelManifest,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  for (let retry = 0; retry <= SEMANTIC_GENERATION_RETRY_LIMIT; retry += 1) {
    const attempt = yield* loadSemanticScoresAttempt(
      config,
      manifest,
      query,
      limit,
      eligibility,
      allowedUriScopes,
    ).pipe(Effect.result);
    if (Result.isSuccess(attempt)) return attempt.success;
    if (Schema.is(VectorCorpusGenerationChanged)(attempt.failure) && retry < SEMANTIC_GENERATION_RETRY_LIMIT) {
      continue;
    }
    return yield* Effect.fail(attempt.failure);
  }
  return yield* Effect.die(new Error('Semantic generation retry loop exhausted without a result.'));
});

const loadSemanticScoresAttempt = Effect.fn('recall.loadSemanticScoresAttempt')(function* (
  config: RecallRuntimeConfig,
  manifest: LocalModelManifest,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  const boundary = Option.isSome(yield* Effect.serviceOption(RecallReadyReadBoundary));
  const lexicalGeneration = boundary
    ? undefined
    : (yield* readRecallIndexData(config, {includeInactive: false, limit: 0, query: ''})).generation;
  const read = yield* readSemantic(config, query, limit, eligibility, allowedUriScopes, lexicalGeneration);
  if (boundary && read?.readiness === 'corrupt')
    return yield* VectorIndexCorrupt.make({
      modelId: manifest.id,
      message: 'Semantic ready storage failed read-only validation.',
    });
  // A worker read without an opening has nothing to join.
  if (read === undefined && boundary) return undefined;
  const served = read === undefined ? undefined : servedSemanticRead(read);
  if (served !== undefined) return yield* servedSemanticResult(config, manifest, served);
  // Every unserved read keeps the refresh queued.
  yield* scheduleMcpRecallBackgroundRefresh(config, manifest);
  const corpusGeneration = read?.corpusGeneration ?? lexicalGeneration;
  return corpusGeneration === undefined
    ? undefined
    : ({
        corpusGeneration: Option.some(corpusGeneration),
        scores: Option.none(),
        warning: Option.none(),
      } satisfies RecallSemanticScoresResult);
});

export const loadRecallSemanticScores = Effect.fn('recall.loadSemanticScores')(function* (
  config: RecallRuntimeConfig,
  query: string,
  limit: number,
  eligibility?: RecallEligibilityPolicy,
  allowedUriScopes?: readonly string[],
) {
  const result = yield* loadRecallSemanticScoresResult(config, query, limit, eligibility, allowedUriScopes);
  if (Option.isSome(result.warning)) yield* Console.warn(result.warning.value);
  return Option.getOrUndefined(result.scores);
});

function semanticRecallFailureWarning(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const failureType =
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    error._tag === 'EmbeddingFailed' &&
    'message' in error &&
    typeof error.message === 'string' &&
    Effect2.pipe(error.message, EffectString.includes('isolated worker retry was exhausted'))
      ? 'LocalModelWorkerRetryExhausted'
      : semanticRecallFailureType(error);
  return (
    `Local AI recall warning: semantic retrieval failed (${failureType}); deterministic lexical recall continued. ` +
    'Run threadnote doctor --dry-run if this repeats.'
  );
}

function semanticRecallTimeoutWarning(): string {
  return (
    `Local AI recall warning: semantic retrieval timed out after ${MCP_RECALL_SEMANTIC_RETRIEVAL_TIMEOUT_MILLISECONDS}ms; ` +
    'deterministic lexical recall continued. Run threadnote doctor --dry-run if this repeats.'
  );
}

function semanticRecallCooldownWarning(): string {
  return (
    'Local AI recall warning: semantic retrieval was skipped after a recent timeout; ' +
    `deterministic lexical recall continued. Retry after ${MCP_RECALL_SEMANTIC_TIMEOUT_COOLDOWN_MILLISECONDS / 1_000}s ` +
    'or run threadnote doctor --dry-run if this repeats.'
  );
}

function semanticRecallStructuralWarning(): string {
  return (
    'Local AI recall warning: semantic index storage failed read-only validation. Lexical recall continued; ' +
    'no automatic repair ran. Run threadnote doctor --dry-run.'
  );
}

function semanticRecallFailureType(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('_tag' in error) || typeof error._tag !== 'string') {
    return 'SemanticRecallUnavailable';
  }
  return [
    'EmbeddingFailed',
    'InferenceInterrupted',
    'InsufficientMemory',
    'ModelLoadFailed',
    'ModelNotInstalled',
    'NativeRuntimeUnavailable',
    'UnsupportedNativeRuntime',
    'VectorIndexCorrupt',
  ].includes(error._tag)
    ? error._tag
    : 'SemanticRecallUnavailable';
}

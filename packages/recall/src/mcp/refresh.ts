import {RECALL_INVENTORY_POLICY_CHANGED_REASON, RECALL_LOGICAL_SCOPE_CHANGED_REASON} from '../index/freshness.js';
import {loadRecallVectorAuthorizationKey} from '../vector/preparation-identity.js';
import * as EffectString from 'effect/String';
import {Cause, Effect, Option, Schema} from 'effect';
import {
  consumeResourceRecallInvalidationReceipt,
  type ResourceRecallInvalidationReceipt,
} from '@threadnote/store/resource/recall-invalidation';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {readModelSelection, selectedEmbeddingModelId} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {vectorIndexGenerationReadiness} from '../vector/semantic-read.js';
import {RECALL_SEMANTIC_COMPACTION_NOTICE, semanticReadDuringCompaction} from '../vector/compaction.js';
import {
  currentRecallCorpusGeneration,
  expireRecallIndexValidation,
  loadRecallIndexData,
  recallIndexStatus,
  type RecallIndexStatus,
} from '../index.js';
import {hasReadCleanupUnconfirmed} from '@threadnote/platform/read_deadline';
import {emitRecallDiagnostic} from '../diagnostics.js';

interface McpRecallRefreshConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export type McpRecallBackgroundRefreshSchedule = 'coalesced' | 'scheduled';

export type DerivedIndexRefreshOutcome =
  | {readonly state: 'current'}
  | {readonly repair: string; readonly state: 'deferred'}
  | {readonly state: 'unavailable'}
  | {readonly state: 'blocked'; readonly repair: string};

import {
  deferRecallEmbeddings,
  RecallEmbeddingDemandUnavailable,
  type RecallEmbeddingDemandReceipt,
  recallEmbeddingModelIdentity,
  requestRecallEmbeddingsReceipt,
} from '../background/demand.js';

class McpRecallBackgroundRefreshBlocked extends Schema.TaggedError<
  McpRecallBackgroundRefreshBlocked,
  {readonly brand: unique symbol}
>()('McpRecallBackgroundRefreshBlocked', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/**
 * Persist demand before returning; an ephemeral caller cannot discard it on exit. A caller that already
 * holds the current lexical generation passes it and saves a status read.
 */
export const scheduleMcpRecallBackgroundRefreshReceipt = Effect.fn('recall.scheduleMcpBackgroundRefreshReceipt')(
  function* (config: McpRecallRefreshConfig, manifest: LocalModelManifest, knownCorpusGeneration?: string) {
    // A stale or unreadable lexical index gives no generation, so the read cannot join and is a new event.
    const corpusGeneration =
      knownCorpusGeneration ??
      Option.getOrUndefined(
        yield* currentRecallCorpusGeneration(config).pipe(
          Effect.catchCauseIf(
            cause => !Cause.hasInterrupts(cause) && !hasReadCleanupUnconfirmed(cause),
            () => Effect.succeed(Option.none<string>()),
          ),
        ),
      );
    return yield* requestRecallEmbeddingsReceipt(config, true, {
      model: recallEmbeddingModelIdentity(manifest),
      corpusGeneration,
    });
  },
);

export const scheduleMcpRecallBackgroundRefresh = (config: McpRecallRefreshConfig, manifest: LocalModelManifest) =>
  scheduleMcpRecallBackgroundRefreshReceipt(config, manifest).pipe(Effect.map(receipt => receipt.disposition));

// Refresh warnings live here. A joined block is not retried by the read, so no warning may claim it is queued.

/** The warning of a read without scores whose refresh was enqueued. */
export function staleReadRefreshWarning(receipt: Pick<RecallEmbeddingDemandReceipt, 'blocked'>): string {
  return receipt.blocked
    ? 'Local AI recall warning: semantic indexes are stale or missing; background refresh is blocked. Lexical recall continued. Run threadnote doctor --dry-run.'
    : 'Local AI recall warning: semantic indexes are stale or missing; background refresh is queued for idle. Lexical recall continued without waiting.';
}

/** A masked read of an older generation warns only when the refresh it joined is blocked. */
export function olderReadRefreshWarning(receipt: Pick<RecallEmbeddingDemandReceipt, 'blocked'>): Option.Option<string> {
  return receipt.blocked
    ? Option.some(
        'Local AI recall warning: semantic recall uses an older index; the background refresh is blocked. Run threadnote doctor --dry-run.',
      )
    : Option.none();
}

/** Maps only a durable-demand enqueue failure to its warning; every other cause stays a failure. */
export const catchRecallRefreshEnqueueUnavailable =
  <B, E2, R2>(onWarning: (warning: string) => Effect.Effect<B, E2, R2>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | B, E | E2, R | R2> =>
    self.pipe(
      Effect.catchCause((cause): Effect.Effect<B, E | E2, R2> => {
        const reason = cause.reasons[0];
        if (cause.reasons.length !== 1 || !Cause.isFailReason(reason)) return Effect.failCause(cause);
        if (!Schema.is(RecallEmbeddingDemandUnavailable)(reason.error)) return Effect.failCause(cause);
        const error = reason.error;
        return onWarning(
          `Local AI recall warning: background refresh enqueue not confirmed [${error.stage ?? 'unknown'}/${error.reason ?? 'unknown'}]; lexical recall continued.`,
        );
      }),
    );

/** Canonical and lexical readiness complete now; document inference is durable idle demand. */
export const refreshRecallDerivedIndexesFromSelection = Effect.fn('recall.refreshDerivedIndexesFromSelection')(
  function* (
    config: McpRecallRefreshConfig,
    invalidatedUris: readonly string[],
    receipt?: ResourceRecallInvalidationReceipt,
    onStage?: (stage: 'lexical' | 'recall-demand') => Effect.Effect<void>,
  ) {
    const uris = [...new Set(invalidatedUris)];
    const forceRefresh =
      uris.length === 0 ||
      consumeResourceRecallInvalidationReceipt(
        receipt,
        {home: config.agentContextHome, account: config.account, user: config.user},
        uris,
      )
        ? false
        : yield* expireRecallIndexValidation(config.agentContextHome, false, uris).pipe(
            Effect.as(false),
            Effect.catchCauseIf(
              cause => !Cause.hasInterrupts(cause),
              cause =>
                emitRecallDiagnostic(config.agentContextHome, {
                  event: 'recall.invalidation-failed',
                  scope: 'active',
                  stage: 'refresh-expire',
                  invalidatedUriCount: uris.length,
                  error: Cause.squash(cause),
                }).pipe(Effect.as(true)),
            ),
          );
    // Complete lexical freshness before deciding whether any vector caller needs candidate data.
    if (onStage) yield* onStage('lexical');
    yield* refreshRecallLexicalIndex(config, forceRefresh, true);
    if (onStage) yield* onStage('recall-demand');
    return yield* Effect.gen(function* () {
      const selection = yield* readModelSelection(config.agentContextHome);
      const modelId = selectedEmbeddingModelId(selection, 'recall');
      if (modelId === undefined) return {state: 'unavailable' as const};
      const catalog = yield* LocalModelCatalog;
      const manifest = yield* catalog.get(modelId);
      if (manifest.role !== 'embedding') return {state: 'unavailable' as const};
      const store = yield* LocalModelStore;
      const installed = yield* store.status(config.agentContextHome, manifest);
      if (!installed.installed) return {state: 'unavailable' as const};
      const lexical = yield* recallIndexStatus(config, false);
      if (!lexical.generation)
        return {state: 'deferred' as const, repair: 'Lexical generation is unavailable; run `threadnote repair`.'};
      // Mutation hooks inspect metadata only; a full encoded-vector integrity scan
      // belongs to explicit doctor/verify or the worker's first admitted unit.
      const readiness = yield* vectorIndexGenerationReadiness(
        config.agentContextHome,
        manifest,
        lexical.generation,
        yield* loadRecallVectorAuthorizationKey(config),
      );
      if (readiness === 'current') return {state: 'current' as const};
      if (readiness === 'corrupt')
        return {
          state: 'deferred' as const,
          // A read that a compaction holds is not damage, so it gets the notice and no rebuild hint.
          repair: (yield* semanticReadDuringCompaction(config))
            ? RECALL_SEMANTIC_COMPACTION_NOTICE
            : 'Vector storage validation failed; run `threadnote index rebuild`.',
        };
      return yield* deferRecallEmbeddings(config);
    }).pipe(
      Effect.catchCauseIf(
        cause => !Cause.hasInterrupts(cause),
        () =>
          Effect.succeed({
            repair: 'Run `threadnote repair` to retry derived-index refresh.',
            state: 'deferred' as const,
          }),
      ),
    );
  },
);

/** Canonical memory commits are durable even when optional derived-index repair fails. */
export const refreshRecallDerivedIndexesAfterCanonicalMutation = Effect.fn(
  'recall.refreshDerivedIndexesAfterCanonicalMutation',
)(function* (
  config: McpRecallRefreshConfig,
  invalidatedUris: readonly string[],
  receipt?: ResourceRecallInvalidationReceipt,
  onStage?: (stage: 'lexical' | 'recall-demand') => Effect.Effect<void>,
) {
  const outcome = yield* refreshRecallDerivedIndexesFromSelection(config, invalidatedUris, receipt, onStage).pipe(
    Effect.catchCauseIf(
      cause => !Cause.hasInterrupts(cause),
      cause =>
        emitRecallDiagnostic(config.agentContextHome, {
          event: 'recall.lexical-refresh-failed',
          scope: 'active',
          stage: 'mutation-hook',
          error: Cause.squash(cause),
        }).pipe(
          Effect.as({
            repair: 'Canonical memory was committed, but lexical recall refresh failed; run `threadnote repair`.',
            state: 'blocked' as const,
          }),
        ),
    ),
  );
  if (
    outcome.state === 'blocked' ||
    (outcome.state === 'deferred' && EffectString.includes('repair')(outcome.repair))
  ) {
    yield* Effect.logWarning(
      'Canonical memory was committed, but derived recall indexes could not be refreshed [recall-refresh:deferred]. Run threadnote repair.',
    );
  }
  return outcome;
}, Effect.orDie);

const refreshRecallLexicalIndex = Effect.fn('recall.refreshDerivedLexicalIndex')(function* (
  config: McpRecallRefreshConfig,
  forceRefresh = false,
  metadataOnly = false,
) {
  const lexicalStatus = yield* recallIndexStatus(config, false);
  if (lexicalRefreshDisposition(lexicalStatus) === 'unsafe') {
    return yield* McpRecallBackgroundRefreshBlocked.make({
      message: `Lexical recall is unavailable: ${lexicalStatus.reason ?? 'unknown storage state'}; run threadnote repair.`,
    });
  }
  return yield* loadRecallIndexData(config, {
    forceRefresh,
    includeInactive: false,
    ...(metadataOnly ? {memoryIds: []} : {}),
  });
});

export function lexicalRefreshDisposition(status: RecallIndexStatus): 'current' | 'refreshable' | 'unsafe' {
  if (status.ready && status.generation) return 'current';
  if (
    status.reason === 'not built; run `threadnote repair`' ||
    status.reason === 'canonical documents changed; run `threadnote repair`' ||
    status.reason === RECALL_LOGICAL_SCOPE_CHANGED_REASON ||
    status.reason === RECALL_INVENTORY_POLICY_CHANGED_REASON
  ) {
    return 'refreshable';
  }
  return 'unsafe';
}

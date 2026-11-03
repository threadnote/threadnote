import {loadRecallVectorAuthorizationKey} from '../vector/preparation-identity.js';
import * as EffectString from 'effect/String';
import {Cause, Effect, Schema} from 'effect';
import {
  consumeResourceRecallInvalidationReceipt,
  type ResourceRecallInvalidationReceipt,
} from '@threadnote/store/resource/recall-invalidation';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {vectorIndexGenerationReadiness} from '../vector-index.js';
import {expireRecallIndexValidation, loadRecallIndexData, recallIndexStatus, type RecallIndexStatus} from '../index.js';

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

import {deferRecallEmbeddings, readRecallEmbeddingDemand, requestRecallEmbeddings} from '../background/demand.js';

class McpRecallBackgroundRefreshBlocked extends Schema.TaggedError<
  McpRecallBackgroundRefreshBlocked,
  {readonly brand: unique symbol}
>()('McpRecallBackgroundRefreshBlocked', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/** Persist demand before returning; an ephemeral caller cannot discard it on exit. */
export const scheduleMcpRecallBackgroundRefresh = Effect.fn('recall.scheduleMcpBackgroundRefresh')(function* (
  config: McpRecallRefreshConfig,
  _manifest: LocalModelManifest,
) {
  const previous = yield* readRecallEmbeddingDemand(config);
  yield* requestRecallEmbeddings(config, true);
  return previous?.desired ? ('coalesced' as const) : ('scheduled' as const);
});

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
              () => Effect.succeed(true),
            ),
          );
    // Complete lexical freshness before deciding whether any vector caller needs candidate data.
    if (onStage) yield* onStage('lexical');
    yield* refreshRecallLexicalIndex(config, forceRefresh, true);
    if (onStage) yield* onStage('recall-demand');
    return yield* Effect.gen(function* () {
      const selection = yield* readModelSelection(config.agentContextHome);
      const modelId = selection.roles.embedding;
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
          repair: 'Vector storage validation failed; run `threadnote index rebuild`.',
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
      () =>
        Effect.succeed({
          repair: 'Canonical memory was committed, but lexical recall refresh failed; run `threadnote repair`.',
          state: 'blocked' as const,
        }),
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
    status.reason === 'canonical documents changed; run `threadnote repair`'
  ) {
    return 'refreshable';
  }
  return 'unsafe';
}

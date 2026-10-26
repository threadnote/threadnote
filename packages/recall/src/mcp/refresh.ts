import {Effect, FileSystem, Path, Schema} from 'effect';
import {
  consumeResourceRecallInvalidationReceipt,
  type ResourceRecallInvalidationReceipt,
} from '@threadnote/store/resource/recall-invalidation';
import {LocalModelCatalog, type LocalModelManifest} from '@threadnote/inference/models/catalog';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {ensureVectorIndex, vectorIndexGenerationReadiness, vectorIndexStatus} from '../vector-index.js';
import {
  currentRecallCorpusGeneration,
  expireRecallIndexValidation,
  loadRecallIndexData,
  recallIndexStatus,
  type RecallIndexData,
  type RecallIndexStatus,
} from '../index.js';

interface McpRecallRefreshConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly manifestPath?: string;
  readonly user: string;
}

export type McpRecallBackgroundRefreshSchedule = 'coalesced' | 'scheduled';

export type DerivedIndexRefreshOutcome =
  {readonly state: 'current'} | {readonly repair: string; readonly state: 'deferred'} | {readonly state: 'unavailable'};

interface ActiveMcpRecallRefresh {
  config: McpRecallRefreshConfig;
  manifest: LocalModelManifest;
  pending: boolean;
}

const activeRefreshes = new Map<string, ActiveMcpRecallRefresh>();

class McpRecallBackgroundRefreshBlocked extends Schema.TaggedError<McpRecallBackgroundRefreshBlocked>()(
  'McpRecallBackgroundRefreshBlocked',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

/**
 * Start one process-local derived-index refresh without joining it to the MCP
 * request. Concurrent calls retain the latest inputs for one trailing rerun so
 * a newer generation is not lost behind an obsolete generation fence. The
 * filesystem locks remain the cross-process authority; this map only prevents
 * redundant work from concurrent requests in this process.
 */
export const scheduleMcpRecallBackgroundRefresh = Effect.fn('recall.scheduleMcpBackgroundRefresh')(function* (
  config: McpRecallRefreshConfig,
  manifest: LocalModelManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalHome = yield* fs
    .realPath(config.agentContextHome)
    .pipe(Effect.orElseSucceed(() => path.resolve(config.agentContextHome)));
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const candidate: ActiveMcpRecallRefresh = {config, manifest, pending: false};
      const active = yield* Effect.sync(() => {
        const existing = activeRefreshes.get(canonicalHome);
        if (existing !== undefined) {
          existing.config = config;
          existing.manifest = manifest;
          existing.pending = true;
          return existing;
        }
        activeRefreshes.set(canonicalHome, candidate);
        return candidate;
      });
      if (active !== candidate) return 'coalesced' as const;

      const clear = Effect.sync(() => {
        if (activeRefreshes.get(canonicalHome) === active) activeRefreshes.delete(canonicalHome);
      });
      const refresh = Effect.gen(function* () {
        for (;;) {
          const latest = yield* Effect.sync(() => {
            active.pending = false;
            return {config: active.config, manifest: active.manifest};
          });
          yield* refreshMcpRecallDerivedIndexes(latest.config, latest.manifest).pipe(
            Effect.catchCause(() =>
              Effect.logWarning(
                'Threadnote background recall-index refresh failed; deterministic lexical recall remains available. Run threadnote doctor --dry-run.',
              ),
            ),
          );
          const rerun = yield* Effect.sync(() => {
            if (activeRefreshes.get(canonicalHome) !== active) return false;
            if (active.pending) return true;
            activeRefreshes.delete(canonicalHome);
            return false;
          });
          if (!rerun) return;
        }
      }).pipe(Effect.ensuring(clear));
      yield* Effect.forkDetach(refresh);
      return 'scheduled' as const;
    }),
  );
});

const refreshMcpRecallDerivedIndexes = Effect.fn('recall.refreshMcpDerivedIndexes')(function* (
  config: McpRecallRefreshConfig,
  manifest: LocalModelManifest,
) {
  const index = yield* refreshRecallLexicalIndex(config);
  yield* refreshRecallVectorIndex(config, manifest, index);
});

/**
 * Restore derived-index readiness after a trusted product mutation. Lexical
 * readiness is synchronous and independently invalidated. An already-built
 * selected vector index finishes before this hook returns because graph and
 * Workset preparation can run in an ephemeral child process; process-local
 * detached work would be lost when that child exits. Incremental vector reuse
 * avoids re-embedding unchanged memory chunks. This hook never constructs a
 * previously absent vector index.
 */
export const refreshRecallDerivedIndexesFromSelection = Effect.fn('recall.refreshDerivedIndexesFromSelection')(
  function* (
    config: McpRecallRefreshConfig,
    invalidatedUris: readonly string[],
    receipt?: ResourceRecallInvalidationReceipt,
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
            Effect.catchCause(() => Effect.succeed(true)),
          );
    // Complete lexical freshness before deciding whether any vector caller needs candidate data.
    yield* refreshRecallLexicalIndex(config, forceRefresh, true);
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
      const vectorStatus = yield* vectorIndexStatus(config.agentContextHome, manifest);
      if (!vectorStatus.ready && vectorStatus.reason === 'not built') return {state: 'unavailable' as const};
      const index = yield* loadRecallIndexData(config, {includeInactive: false});
      yield* refreshRecallVectorIndex(config, manifest, index);
      const readiness = yield* vectorIndexGenerationReadiness(config.agentContextHome, manifest, index.generation);
      if (readiness !== 'current') {
        return {
          repair: 'Run `threadnote repair` to retry derived-index refresh.',
          state: 'deferred' as const,
        };
      }
      return {state: 'current' as const};
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed({repair: 'Run `threadnote repair` to retry derived-index refresh.', state: 'deferred' as const}),
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
) {
  const outcome = yield* refreshRecallDerivedIndexesFromSelection(config, invalidatedUris, receipt).pipe(
    Effect.catchCause(() =>
      Effect.succeed({repair: 'Run `threadnote repair` to retry derived-index refresh.', state: 'deferred' as const}),
    ),
  );
  if (outcome.state === 'deferred') {
    yield* Effect.logWarning(
      'Canonical memory was committed, but derived recall indexes could not be refreshed. Run threadnote repair.',
    );
  }
  return outcome;
});

const refreshRecallLexicalIndex = Effect.fn('recall.refreshDerivedLexicalIndex')(function* (
  config: McpRecallRefreshConfig,
  forceRefresh = false,
  metadataOnly = false,
) {
  const lexicalStatus = yield* recallIndexStatus(config, false);
  if (lexicalRefreshDisposition(lexicalStatus) === 'unsafe') {
    return yield* McpRecallBackgroundRefreshBlocked.make({message: ''});
  }
  return yield* loadRecallIndexData(config, {
    forceRefresh,
    includeInactive: false,
    ...(metadataOnly ? {memoryIds: []} : {}),
  });
});

const refreshRecallVectorIndex = Effect.fn('recall.refreshDerivedVectorIndex')(function* (
  config: McpRecallRefreshConfig,
  manifest: LocalModelManifest,
  index: RecallIndexData,
) {
  const vectorStatus = yield* vectorIndexStatus(config.agentContextHome, manifest);
  if (!vectorStatus.ready && vectorStatus.reason !== 'not built') {
    return yield* McpRecallBackgroundRefreshBlocked.make({message: ''});
  }
  const readiness = yield* vectorIndexGenerationReadiness(config.agentContextHome, manifest, index.generation);
  if (readiness === 'corrupt') return yield* McpRecallBackgroundRefreshBlocked.make({message: ''});
  if (readiness === 'current') return;
  yield* ensureVectorIndex(config, manifest, index.candidates, {
    corpusGeneration: index.generation,
    currentCorpusGeneration: () => currentRecallCorpusGeneration(config),
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

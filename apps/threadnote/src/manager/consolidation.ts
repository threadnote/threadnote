import {DateTime, Effect, FileSystem, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ResourceStore} from '@threadnote/store/resource-store';
import {parseResourceId} from '@threadnote/store/resource-id';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {
  consolidationRevision,
  ConsolidationTargetSchema,
  reviewConsolidation,
  validateConsolidationProvenance,
  type ConsolidationSource,
  type ConsolidationTarget,
} from '@threadnote/memory/consolidation';
import {cleanupMode, memoryKind, memoryStatus, optionalString} from '@threadnote/manager/request_inputs';
import {storeMemory, runArchive, runForget} from '../memory/index.js';
import {MemoryOperationError, memoryDirectoryUri} from '../memory/migrations.js';
import {uriSegment} from '@threadnote/workspace/manifest';
import {isInSharedNamespace} from '../share/index.js';
import {captureConsoleWithoutProgress} from '../effect/console.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';

export interface ReviewedConsolidationJob {
  readonly id: string;
  readonly createdAt: string;
  readonly draft?: string;
  readonly sources?: readonly ConsolidationSource[];
  readonly target: Partial<ConsolidationTarget>;
  resultUri?: string;
}
const attempt = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: error => MemoryOperationError.make({message: error instanceof Error ? error.message : String(error)}),
  });
const identity = (id: string) => `tn_${sha256HexSync(`consolidation:${id}`).slice(0, 32)}`;

export const applyReviewedConsolidation = Effect.fn('manager.applyReviewedConsolidation')(function* (
  config: RuntimeConfig,
  job: ReviewedConsolidationJob | undefined,
  id: string,
  body: Record<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [`consolidation-operation:${id}`],
    Effect.gen(function* () {
      const store = yield* ResourceStore;
      const location = {account: config.account, home: config.agentContextHome, user: config.user};
      let resultUri = job?.resultUri ?? optionalString(body.resultUri);
      if (!job && !resultUri) {
        const candidateUri = yield* attempt(
          () =>
            `${memoryDirectoryUri(config, {
              kind: memoryKind(body.kind) ?? 'durable',
              status: memoryStatus(body.status) ?? 'active',
              project: optionalString(body.project) ?? '',
              topic: optionalString(body.topic) ?? `consolidation-${id}`,
              sourceAgentClient: 'manager',
              timestamp: '',
            })}/${uriSegment(optionalString(body.topic) ?? `consolidation-${id}`)}.md`,
        );
        const candidate = yield* store
          .read(location, candidateUri)
          .pipe(Effect.catchTag('ResourceNotFound', () => Effect.void));
        if (candidate !== undefined) resultUri = candidateUri;
      }
      const savedContent = resultUri ? yield* store.read(location, resultUri) : undefined;
      const saved = savedContent && resultUri ? parseMemoryDocument(resultUri, savedContent) : undefined;
      if (resultUri) {
        const receiptUri = resultUri;
        const address = yield* attempt(() => parseResourceId(receiptUri));
        if (
          address.namespace !== 'user' ||
          address.segments[0] !== config.user ||
          isInSharedNamespace(config, resultUri) ||
          saved?.metadata.memoryId !== identity(id) ||
          saved.metadata.consolidation?.operationId !== id ||
          saved.metadata.consolidationError
        )
          return yield* MemoryOperationError.make({
            message: 'Saved consolidation receipt is missing, changed, or outside the personal Library.',
          });
        yield* attempt(() => validateConsolidationProvenance(saved.metadata.consolidation, saved.body));
      }
      let previous = saved?.metadata.consolidation;
      const sources = job?.sources ?? previous?.sources;
      const draft = optionalString(body.draft) ?? job?.draft ?? saved?.body;
      if (!sources || !draft)
        return yield* MemoryOperationError.make({
          message: 'Consolidation job not found. To resume saved cleanup, provide its resultUri.',
        });
      const defaults = previous?.target ?? job?.target ?? {};
      const target: ConsolidationTarget = yield* attempt(() =>
        Schema.decodeUnknownSync(ConsolidationTargetSchema)({
          kind: optionalString(body.kind) ?? defaults.kind ?? 'durable',
          status: optionalString(body.status) ?? defaults.status ?? 'active',
          project: optionalString(body.project) ?? defaults.project ?? '',
          topic: optionalString(body.topic) ?? optionalString(defaults.topic) ?? `consolidation-${id}`,
          sourceAgentClient: optionalString(body.sourceAgentClient) ?? defaults.sourceAgentClient ?? 'manager',
        }),
      );
      if (target.status !== 'active' || target.kind === 'smoke')
        return yield* MemoryOperationError.make({
          message: 'Consolidation results must be active durable, handoff, incident, or preference memories.',
        });
      if (body.cleanup !== undefined && !['archive', 'forget', 'keep'].includes(String(body.cleanup)))
        return yield* MemoryOperationError.make({message: 'Invalid consolidation cleanup choice.'});
      const cleanup = body.cleanup === undefined && previous ? previous.cleanup : cleanupMode(body.cleanup);
      const reviewed = yield* attempt(() =>
        reviewConsolidation(draft, sources, body.reviews ?? previous?.reviews, {
          operationId: id,
          cleanup,
          cleanupShared:
            body.cleanupShared === undefined ? (previous?.cleanupShared ?? false) : body.cleanupShared === true,
          target,
        }),
      );
      if (previous && previous.requestHash !== reviewed.provenance.requestHash)
        return yield* MemoryOperationError.make({
          message:
            'Consolidation already saved with a different draft, target, support review, or cleanup approval. Resume the original receipt.',
        });
      // Preflight all live sources before saving or starting a cleanup retry. Missing is safe only after a verified save.
      const currentSources = yield* Effect.forEach(sources, source =>
        Effect.gen(function* () {
          const current = yield* store
            .read(location, source.uri)
            .pipe(Effect.catchTag('ResourceNotFound', () => Effect.void));
          if (current === undefined && previous) return undefined;
          if (current === undefined || consolidationRevision(current) !== source.revision)
            return yield* MemoryOperationError.make({
              message: `Source ${source.uri} changed after consolidation review. No newer revision will be cleaned up.`,
            });
          return {uri: source.uri, content: current};
        }),
      );
      const timestamp = job?.createdAt ?? saved?.metadata.timestamp ?? DateTime.formatIso(yield* DateTime.now);
      const metadata = {
        kind: target.kind,
        status: target.status,
        project: target.project,
        topic: target.topic,
        sourceAgentClient: target.sourceAgentClient,
        timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        memoryId: identity(id),
        schemaVersion: MEMORY_SCHEMA_VERSION,
        visibility: 'personal' as const,
        codeCitations: reviewed.codeCitations,
        relations: reviewed.relations,
        consolidation: reviewed.provenance,
      };
      const expected = yield* attempt(() => formatMemoryDocument('MEMORY', metadata, draft));
      // The destination is deterministic even if interruption prevented the in-memory job receipt from updating.
      if (!resultUri) {
        const candidateUri = `${memoryDirectoryUri(config, metadata)}/${uriSegment(target.topic)}.md`;
        const candidate = yield* store
          .read(location, candidateUri)
          .pipe(Effect.catchTag('ResourceNotFound', () => Effect.void));
        if (candidate !== undefined) {
          const record = parseMemoryDocument(candidateUri, candidate);
          if (
            candidate.trim() !== expected ||
            record?.metadata.memoryId !== identity(id) ||
            record.metadata.consolidation?.requestHash !== reviewed.provenance.requestHash
          )
            return yield* MemoryOperationError.make({
              message: `Consolidation destination ${candidateUri} already exists. Choose another result topic; existing memories were preserved.`,
            });
          resultUri = candidateUri;
          previous = record.metadata.consolidation;
          if (job) job.resultUri = candidateUri;
        }
      }
      let uri = resultUri;
      let output = '';
      if (!previous) {
        const captured = yield* captureConsoleWithoutProgress(
          storeMemory(config, {
            bodyText: draft,
            dryRun: false,
            createOnly: true,
            metadata,
            title: 'MEMORY',
            expectedSourceContent: currentSources.filter(source => source !== undefined),
          }),
        );
        uri = captured.value;
        output = captured.output;
        if (job) job.resultUri = uri;
      }
      if (!uri) return yield* MemoryOperationError.make({message: 'Consolidation result was not stored.'});
      const savedUri = uri;
      const cleanupOutput = yield* withMemoryUriLocks(
        fs,
        config.agentContextHome,
        [savedUri],
        Effect.gen(function* () {
          const verified = yield* store.read(location, savedUri);
          if (verified.trim() !== (savedContent ?? expected).trim())
            return yield* MemoryOperationError.make({
              message: `Saved consolidation ${savedUri} differs from the reviewed content/provenance. Source cleanup was refused.`,
            });
          const record = parseMemoryDocument(savedUri, verified);
          if (
            !record?.metadata.consolidation ||
            record.metadata.citationErrors?.length ||
            record.metadata.consolidation.requestHash !== reviewed.provenance.requestHash
          )
            return yield* MemoryOperationError.make({
              message: 'Saved consolidation evidence verification failed. Source cleanup was refused.',
            });
          const outputs: string[] = [];
          if (cleanup !== 'keep')
            for (const source of sources) {
              if (source.uri === savedUri)
                return yield* MemoryOperationError.make({
                  message: 'Consolidation destination cannot overwrite a source.',
                });
              if (isInSharedNamespace(config, source.uri) && !reviewed.provenance.cleanupShared) {
                outputs.push(`Skipped shared source cleanup: ${source.uri}`);
                continue;
              }
              // A selected active relation still needs its target. Derivation alone never creates this dependency.
              if (
                reviewed.relations.some(
                  relation =>
                    relation.uri === source.uri ||
                    (source.memoryId && relation.uri === `threadnote://memory/${source.memoryId}`),
                )
              ) {
                outputs.push(`Kept active dependency source: ${source.uri}`);
                continue;
              }
              const current = yield* store
                .read(location, source.uri)
                .pipe(Effect.catchTag('ResourceNotFound', () => Effect.void));
              if (current === undefined) {
                outputs.push(`Source cleanup already completed: ${source.uri}`);
                continue;
              }
              const captured = yield* captureConsoleWithoutProgress(
                cleanup === 'forget'
                  ? runForget(config, source.uri, {expectedRevision: source.revision})
                  : runArchive(config, source.uri, {
                      expectedRevision: source.revision,
                      consolidationCleanup: {key: sha256HexSync(`${id}:${source.uri}:${source.revision}`), timestamp},
                    }),
              );
              outputs.push(captured.output);
            }
          return outputs.join('\n');
        }),
      );
      return {
        resultUri: savedUri,
        output: [output || `Verified saved consolidation: ${savedUri}`, cleanupOutput].filter(Boolean).join('\n'),
      };
    }),
  );
});

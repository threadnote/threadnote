import {Console, DateTime, Effect, FileSystem, Option, Result} from 'effect';
import {ResourceStore} from '@threadnote/store/resource-store';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {
  assertMemoryDocumentSchemaWritable,
  formatMemoryDocument,
  memoryArchiveBody,
  memoryArchiveMetadata,
  parseMemoryDocument,
  type MemoryMetadata,
} from '@threadnote/memory/document';
import {consolidationRevision} from '@threadnote/memory/consolidation';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ArchiveOptions} from '../types.js';
import {assertResourceUri} from '../utils.js';
import {storeMemory} from './commands.js';
import {discardDeferredCodeAnchorIntent} from './deferred/code_anchor.js';
import {
  attemptSync,
  MemoryOperationError,
  NATIVE_RESOURCE_BACKEND,
  normalizeOptionalMetadata,
  removeResourceWithRetry,
  resourceStoreLocation,
} from './migrations.js';
import {refreshRecallDerivedIndexesAfterCanonicalMutation} from '@threadnote/recall/mcp/refresh';

export const runArchive = Effect.fn('runArchive')(function* (
  config: RuntimeConfig,
  uri: string,
  options: ArchiveOptions,
) {
  yield* attemptSync(() => assertResourceUri(uri));
  const ov = NATIVE_RESOURCE_BACKEND;
  const store = yield* ResourceStore;
  if (options.dryRun === true) {
    const fallbackMetadata: MemoryMetadata = {
      archivedFrom: uri,
      kind: options.kind ?? 'handoff',
      project: normalizeOptionalMetadata(options.project),
      sourceAgentClient: 'threadnote',
      status: 'archived',
      timestamp: DateTime.formatIso(yield* DateTime.now),
      topic: normalizeOptionalMetadata(options.topic),
    };
    yield* storeMemory(config, {
      bodyText: ['Archived original Threadnote memory.', '', '<original memory content would be read here>'].join('\n'),
      dryRun: true,
      metadata: fallbackMetadata,
      title: 'MEMORY',
    });
    yield* Console.log(`Would remove archived native resource: ${uri}`);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const invalidatedUris = options.invalidatedUris ?? [uri];
  yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [uri],
    Effect.gen(function* () {
      const rawOriginalMemory = yield* store.read(resourceStoreLocation(config), uri);
      const originalMemory = rawOriginalMemory.trim();
      if (
        options.expectedRevision !== undefined &&
        consolidationRevision(rawOriginalMemory) !== options.expectedRevision
      )
        return yield* MemoryOperationError.make({
          message: `Memory ${uri} changed after consolidation review. Source cleanup was refused.`,
        });
      if (options.expectedContent !== undefined && originalMemory !== options.expectedContent.trim()) {
        return yield* MemoryOperationError.make({
          message: `Memory ${uri} changed after the hygiene plan. Re-run compact before archiving.`,
        });
      }
      yield* attemptSync(() => assertMemoryDocumentSchemaWritable(originalMemory));
      const sourceRecord = parseMemoryDocument(uri, originalMemory);
      if (!sourceRecord) return yield* MemoryOperationError.make({message: `Cannot archive invalid memory ${uri}.`});
      const inferredMetadata = sourceRecord.metadata;
      if (inferredMetadata.citationErrors && inferredMetadata.citationErrors.length > 0) {
        const reasons = [...new Set(inferredMetadata.citationErrors.map(error => error.reason))].sort().join(', ');
        return yield* MemoryOperationError.make({
          message: `Cannot archive ${uri}: malformed code citation metadata (${reasons}) must be repaired or recaptured first.`,
        });
      }
      const metadata = memoryArchiveMetadata(inferredMetadata, {
        archivedFrom: uri,
        kind: options.kind ?? inferredMetadata.kind ?? 'handoff',
        project: normalizeOptionalMetadata(options.project),
        sourceAgentClient: 'threadnote',
        timestamp: options.consolidationCleanup?.timestamp ?? DateTime.formatIso(yield* DateTime.now),
        topic: normalizeOptionalMetadata(options.topic),
      });
      const archiveBody = memoryArchiveBody(sourceRecord.body);
      const archiveFingerprint = yield* store.fingerprint(formatMemoryDocument('MEMORY', metadata, archiveBody));
      const archiveUri = yield* storeMemory(config, {
        bodyText: archiveBody,
        consolidationArchiveKey: options.consolidationCleanup?.key,
        deferRecallIndexRefresh: true,
        dryRun: false,
        metadata,
        skipMemoryIdentityLock: true,
        title: 'MEMORY',
      });
      invalidatedUris.push(archiveUri);
      const currentSource = yield* store.read(resourceStoreLocation(config), uri).pipe(Effect.option);
      if (Option.isNone(currentSource) || currentSource.value.trim() !== originalMemory) {
        const rolledBack = yield* removeResourceWithRetry(ov, config, archiveUri, {
          expectedFingerprint: archiveFingerprint,
        });
        return yield* MemoryOperationError.make({
          message: rolledBack
            ? `Memory ${uri} changed while its archive was being stored. The archived copy was rolled back; re-run the operation.`
            : `Memory ${uri} changed while its archive was being stored. The source was preserved, but cleanup of ${archiveUri} needs review.`,
        });
      }
      const removal = yield* removeResourceWithRetry(ov, config, uri, {
        alreadyLocked: true,
        ...(options.expectedRevision === undefined
          ? {}
          : {expectedFingerprint: yield* store.fingerprint(rawOriginalMemory)}),
      }).pipe(Effect.result);
      if (Result.isFailure(removal)) {
        yield* removeResourceWithRetry(ov, config, archiveUri, {expectedFingerprint: archiveFingerprint});
        return yield* Effect.fail(removal.failure);
      }
      const removedOriginal = removal.success;
      if (removedOriginal) {
        yield* discardDeferredCodeAnchorIntent(config, uri);
        yield* Console.log(`Archived original memory: ${uri}`);
      } else {
        yield* Console.error(`Archive stored and the original is no longer present: ${uri}`);
      }
    }),
  ).pipe(
    Effect.ensuring(
      options.deferRecallIndexRefresh
        ? Effect.void
        : refreshRecallDerivedIndexesAfterCanonicalMutation(config, invalidatedUris).pipe(Effect.asVoid),
    ),
  );
});

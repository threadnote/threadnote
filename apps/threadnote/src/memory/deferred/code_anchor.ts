import {DateTime, Effect, FileSystem, Option, Path, Predicate, Result} from 'effect';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {succeedUndefined} from '@threadnote/platform/optional';
import {sha256Hex} from '@threadnote/platform/digest';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {withMemoryUriLocks} from '@threadnote/memory/lock';
import {ResourceStore} from '@threadnote/store/resource-store';
import {
  fileSystemModeIsPrivate,
  readOpenedFileSystemIdentity,
  readPathFileSystemIdentity,
  runtimePlatform,
  runtimeTextDirectoryNamePage,
} from '@threadnote/platform/system';
import {uriSegment} from '@threadnote/workspace/manifest';
import {parseResourceId, validatePortableSegment} from '@threadnote/store/resource-id';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  captureMemoryCodeCitations,
  memoryCodeCitationProjectScopeReceipt,
  type MemoryCodeCitationCaptureRecoveryV1,
  normalizeMemoryCodeRefs,
} from '@threadnote/context/citation/capture';
import {MEMORY_SCHEMA_VERSION, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {discardMemoryRelocation} from '@threadnote/memory/relocation';
import {classifyDeferredCodeAnchorCallerCheckoutAdmission} from './code_anchor_checkout.js';
import {deferredCodeAnchorCaptureFailureItem} from './code_anchor_failure.js';
import {
  deferredCodeAnchorIntentId,
  hasDeferredCodeAnchorIntentKeys,
  isDeferredCodeAnchorFullProjectScope,
  parseMemoryCodeCitationProjectScopeReceipt,
  verifyDeferredCodeAnchorProjectScope,
  type DeferredCodeAnchorIntentV1,
} from './code_anchor_scope.js';
export type {DeferredCodeAnchorIntentV1} from './code_anchor_scope.js';
import {scheduleDeferredCodeAnchorIntentRefresh} from './code_anchor_scheduler.js';
import {
  deferredCodeAnchorFinalizationVerified,
  memoryContentHash,
  readDeferredMemoryObservation,
  reconcileInterruptedDeferredCodeAnchorCommit,
  resourceStoreLocation,
  type DeferredMemoryObservation,
} from './code_anchor_memory.js';
import {
  DeferredCodeAnchorError,
  DEFERRED_CODE_ANCHOR_ITEM_ROOT_NAME,
  DEFERRED_CODE_ANCHOR_LEGACY_QUARANTINE_NAME,
  DEFERRED_CODE_ANCHOR_ROUTE_ROOT_NAME,
  DEFERRED_CODE_ANCHOR_URI_ADDRESS_HEX_LENGTH,
  deferredCodeAnchorError,
  deferredCodeAnchorIntentAncestorsForPath,
  deferredCodeAnchorItemAncestors,
  deferredCodeAnchorPathEntryKind,
  deferredCodeAnchorRouteAncestors,
  ensurePrivateDeferredCodeAnchorDirectory,
  inspectPrivateDeferredCodeAnchorDirectories,
  quarantinePrivateDeferredCodeAnchorLegacyEntry,
  quarantinePrivateDeferredCodeAnchorRouteEntry,
  readPrivateDeferredCodeAnchorDirectory,
  removePrivateDeferredCodeAnchorFile,
  removePrivateDeferredCodeAnchorRouteMarker,
  sameDeferredCodeAnchorFile,
  samePrivateDeferredCodeAnchorDirectories,
  validatePrivateDeferredCodeAnchorDirectories,
  writePrivateDeferredCodeAnchorFile,
} from './code_anchor_private_fs.js';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';

export {deferredCodeAnchorFinalizationVerified, type DeferredMemoryObservation} from './code_anchor_memory.js';
export {deferredCodeAnchorDoctorCheck} from './code_anchor_doctor.js';

export const DEFERRED_CODE_ANCHOR_INTENT_VERSION = 1 as const;
export const DEFERRED_CODE_ANCHOR_FINALIZATION_VERSION = 1 as const;
export const DEFERRED_CODE_ANCHOR_ROUTE_FINALIZATION_VERSION = 1 as const;
export const DEFAULT_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT = 25;
export const MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT = 100;
const DEFERRED_CODE_ANCHOR_FINALIZATION_CONCURRENCY = 4;
const MAX_DEFERRED_CODE_ANCHOR_INTENT_BYTES = 128 * 1024;
const DEFERRED_CODE_ANCHOR_SCAN_CURSOR_NAME = 'scan-cursor-v1';
const DEFERRED_CODE_ANCHOR_ROUTE_SCAN_CURSOR_PREFIX = 'route-scan-cursor-v1-';
const DEFERRED_CODE_ANCHOR_ROUTED_DISCOVERY_CURSOR_PREFIX = 'routed-discovery-cursor-v1-';
const DEFERRED_CODE_ANCHOR_LEGACY_ROUTE_SCAN_CURSOR_PREFIX = 'legacy-route-scan-cursor-v1-';
const MAX_DEFERRED_CODE_ANCHOR_CURSOR_BYTES = 512;
const MAX_DEFERRED_CODE_ANCHOR_ROUTE_LOCK_WAIT_MILLISECONDS = 5_000;
const DEFERRED_CODE_ANCHOR_ROUTE_LOCK_RETRY_MILLISECONDS = 25;
const DEFERRED_CODE_ANCHOR_ROUTE_LOCK_STALE_MILLISECONDS = 5 * 60 * 1_000;
const DEFERRED_CODE_ANCHOR_QUALIFIED_REF = /^cgr_[0-9a-f]{40}$/u;
const DEFERRED_CODE_ANCHOR_REFS_BLOOM_BYTES = 16;
const DEFERRED_CODE_ANCHOR_REFS_BLOOM_HASH_COUNT = 7;
const DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT = 8;
const DEFERRED_CODE_ANCHOR_ROUTE_KEY_HEX_LENGTH = 32;
const MIN_DEFERRED_CODE_ANCHOR_ROUTED_SCAN_LIMIT = 4;
const DEFERRED_CODE_ANCHOR_ROUTED_SCAN_MULTIPLIER = 4;
const MIN_DEFERRED_CODE_ANCHOR_LEGACY_ROUTE_SCAN_LIMIT = 32;
const DEFERRED_CODE_ANCHOR_LEGACY_ROUTE_SCAN_MULTIPLIER = 4;
const DEFAULT_DEFERRED_CODE_ANCHOR_ROUTE_PASS_TIMEOUT_MILLISECONDS = 750;
const MAX_DEFERRED_CODE_ANCHOR_ROUTE_PASS_TIMEOUT_MILLISECONDS = 5_000;

export {DeferredCodeAnchorError};

export type MemoryCodeCitationPolicy = 'defer' | 'require-current';

export interface DeferredCodeAnchorWriteRequest {
  readonly callerCwd: string;
  readonly codeRefs: readonly string[];
  /** Omitted preserves the canonical full/unselected compatibility path. */
  readonly project?: string;
  readonly recovery: MemoryCodeCitationCaptureRecoveryV1;
}

export function withDeferredCodeAnchorMutationLocks<A, E, R>(
  fs: FileSystem.FileSystem,
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  uris: readonly (string | undefined)[],
  effect: Effect.Effect<A, E, R>,
) {
  const scopeKey = `threadnote-internal://deferred-code-anchor-mutations/${encodeURIComponent(config.account)}/${encodeURIComponent(uriSegment(config.user))}`;
  return withMemoryUriLocks(fs, config.agentContextHome, [scopeKey, ...uris], effect);
}

export type DeferredCodeAnchorEligibility =
  | {readonly state: 'eligible'}
  | {
      readonly reason:
        | 'canonical-memory-changed'
        | 'canonical-memory-missing'
        | 'memory-already-cited'
        | 'memory-id-changed'
        | 'memory-no-longer-active'
        | 'memory-no-longer-personal';
      readonly state: 'conflict';
    };

export interface DeferredCodeAnchorFinalizeItemV1 {
  readonly citationCount?: number;
  readonly code?: string;
  readonly memoryUri?: string;
  readonly reason?: string;
  readonly recoveryAction?: 'prepare-current-graph' | 'replace-memory-code-refs';
  readonly retryable?: boolean;
  readonly state: 'conflict' | 'failed' | 'finalized' | 'pending';
}

export interface DeferredCodeAnchorFinalizationReceiptV1 {
  readonly conflictCount: number;
  readonly failedCount: number;
  readonly finalizedCount: number;
  readonly items: readonly DeferredCodeAnchorFinalizeItemV1[];
  readonly pendingCount: number;
  readonly scannedCount: number;
  readonly type: 'threadnote-deferred-code-anchor-finalization';
  readonly version: typeof DEFERRED_CODE_ANCHOR_FINALIZATION_VERSION;
}

export type DeferredCodeAnchorFinalizationRoute =
  | {
      /** The cwd that produced the already-observed exact repository identity. */
      readonly callerCwd: string;
      readonly kind: 'repository';
      readonly repositoryId: string;
      readonly worktreeId: string;
    }
  | {
      readonly kind: 'workset';
      readonly name: string;
    };

export interface DeferredCodeAnchorRouteFinalizationReceiptV1 {
  readonly conflictCount: number;
  readonly failedCount: number;
  readonly finalizedCount: number;
  /** Valid private route intents observed inside this bounded protected pass. */
  readonly matchedCount: number;
  readonly pendingCount: number;
  readonly scannedCount: number;
  readonly state: 'completed' | 'contended' | 'failed';
  readonly type: 'threadnote-deferred-code-anchor-route-finalization';
  readonly version: typeof DEFERRED_CODE_ANCHOR_ROUTE_FINALIZATION_VERSION;
}

export interface DeferredCodeAnchorRouteFinalizationOptions {
  readonly limit?: number;
  /** @internal Runs before one selected intent is attempted. */ readonly onAttemptedUri?: (uri: string) => void;
  /** @internal Total foreground budget for discovery, locking, and finalization. */
  readonly passTimeoutMilliseconds?: number;
  /** @internal A bounded caller hint used only to promote one matching intent. */
  readonly preferredCodeRefs?: readonly string[];
  /** @internal Runs only after the canonical CAS write has been verified. */
  readonly onFinalizedUri?: (uri: string) => void;
  readonly waitTimeoutMilliseconds?: number;
}

export interface StoredDeferredCodeAnchorIntent {
  readonly kind: 'valid';
  readonly intent: DeferredCodeAnchorIntentV1;
  readonly markerPath?: string;
  readonly name: string;
  readonly path: string;
}

interface InvalidDeferredCodeAnchorIntent {
  readonly kind: 'invalid';
  readonly name: string;
  readonly path: string;
  readonly uriDigest?: string;
}

type DeferredCodeAnchorIntentEntry = InvalidDeferredCodeAnchorIntent | StoredDeferredCodeAnchorIntent;

/**
 * Stage the private intent before the canonical memory write. A crash can leave
 * an orphaned intent, but cannot leave a successfully stored deferred memory
 * without its recovery intent. Finalization reconciles orphans fail-closed.
 */
export const stageDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.stage')(function* (
  config: RuntimeConfig,
  input: {
    readonly memoryContent: string;
    readonly memoryMetadata: MemoryMetadata;
    readonly memoryUri: string;
    readonly request: DeferredCodeAnchorWriteRequest;
  },
) {
  const canonicalUri = canonicalPersonalMemoryUri(config, input.memoryUri);
  const record = parseMemoryDocument(canonicalUri, input.memoryContent);
  if (!record || !record.metadata.memoryId) {
    return yield* deferredCodeAnchorError('Deferred code anchors require a canonical memory with a stable memory_id.');
  }
  if (record.metadata.status !== 'active') {
    return yield* deferredCodeAnchorError('Deferred code anchors may be staged only for active memories.');
  }
  if (record.metadata.visibility === 'shared' || record.metadata.visibility === 'external') {
    return yield* deferredCodeAnchorError(
      'Deferred code anchors are private-local and cannot be staged for shared memory.',
    );
  }
  if ((record.metadata.codeCitations?.length ?? 0) > 0) {
    return yield* deferredCodeAnchorError('Deferred code anchors require an uncited canonical memory.');
  }
  if (record.metadata.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    return yield* deferredCodeAnchorError(
      `Deferred code anchors require memory schema version ${MEMORY_SCHEMA_VERSION}.`,
    );
  }
  if (input.memoryMetadata.memoryId !== record.metadata.memoryId) {
    return yield* deferredCodeAnchorError('Deferred code-anchor memory identity changed during preparation.');
  }

  const refs = normalizeMemoryCodeRefs(input.request.codeRefs);
  if (refs.length === 0) {
    return yield* deferredCodeAnchorError('Deferred code anchors require at least one code reference.');
  }
  const path = yield* Path.Path;
  if (!path.isAbsolute(input.request.callerCwd)) {
    return yield* deferredCodeAnchorError('Deferred code-anchor callerCwd must be absolute.');
  }
  const fs = yield* FileSystem.FileSystem;
  const query = yield* CodeGraphQueryService;
  const requestedProject =
    config.manifestSource === 'bundled-example' || !(yield* fs.exists(config.manifestPath))
      ? undefined
      : input.request.project;
  const status = yield* query.status(config.agentContextHome, input.request.callerCwd, {
    project: requestedProject,
    manifestPath: config.manifestPath,
    observeWorktree: true,
    requestMaintenance: false,
  });
  const project = requestedProject === undefined ? undefined : status.projectCoverage?.project;
  if (requestedProject !== undefined && project === undefined) {
    return yield* deferredCodeAnchorError('Deferred code anchors require verified selected project graph evidence.');
  }
  const projectScope =
    project === undefined ? undefined : (memoryCodeCitationProjectScopeReceipt(status) ?? {kind: 'full' as const});
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const expectedMemoryHash = yield* memoryContentHash(input.memoryContent);
  const intentId = yield* deferredCodeAnchorIntentId({
    callerCwd: input.request.callerCwd,
    codeRefs: refs,
    expectedMemoryHash,
    memoryId: record.metadata.memoryId,
    memoryUri: canonicalUri,
    ...(project === undefined ? {} : {project}),
    ...(projectScope === undefined ? {} : {projectScope}),
    repositoryId: status.identity.repositoryId,
    recovery: input.request.recovery,
    worktreeId: status.identity.worktreeId,
  });
  const intent: DeferredCodeAnchorIntentV1 = {
    authorization: 'explicit-code-refs',
    callerCwd: input.request.callerCwd,
    codeRefs: refs,
    createdAt,
    expectedMemoryHash,
    intentId,
    memoryId: record.metadata.memoryId,
    memoryUri: canonicalUri,
    ...(project === undefined ? {} : {project}),
    ...(projectScope === undefined ? {} : {projectScope}),
    repositoryId: status.identity.repositoryId,
    recovery: input.request.recovery,
    type: 'threadnote-deferred-code-anchor-intent',
    version: DEFERRED_CODE_ANCHOR_INTENT_VERSION,
    visibility: 'private-local',
    worktreeId: status.identity.worktreeId,
  };
  yield* writeDeferredCodeAnchorIntent(config, intent);
  if (intent.recovery.preparation.target !== 'workset') {
    yield* scheduleDeferredCodeAnchorIntentRefresh(config, intent).pipe(Effect.ignoreCause);
  }
  return intent;
});

export const hasDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.has')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  return (yield* findUrisWithDeferredCodeAnchorIntents(config, [memoryUri])).size === 1;
});

export const findUrisWithDeferredCodeAnchorIntents = Effect.fn('memoryCodeAnchor.findUris')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUris: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) return new Set<string>();
  const names = (yield* readPrivateDeferredCodeAnchorDirectory(fs, root, [root])) ?? [];
  const itemRoot = path.join(root, DEFERRED_CODE_ANCHOR_ITEM_ROOT_NAME);
  const itemRootNames = yield* readPrivateDeferredCodeAnchorDirectory(fs, itemRoot, [root, itemRoot]);
  const keyed = yield* Effect.forEach(
    [...new Set(memoryUris.map(uri => parseResourceId(uri).canonicalUri))],
    uri => deferredCodeAnchorUriDigest(uri).pipe(Effect.map(digest => ({digest, uri}))),
    {concurrency: 4},
  );
  const present = yield* Effect.forEach(
    keyed,
    candidate => {
      const itemAncestors = deferredCodeAnchorItemAncestors(path, root, candidate.digest);
      const itemDirectory = itemAncestors[itemAncestors.length - 1];
      return (
        itemRootNames === undefined
          ? succeedUndefined
          : readPrivateDeferredCodeAnchorDirectory(fs, itemDirectory, itemAncestors)
      ).pipe(
        Effect.map(itemNames =>
          (itemNames?.some(name => isDeferredCodeAnchorIntentNameForDigest(name, candidate.digest)) ?? false) ||
          names.some(name => isDeferredCodeAnchorIntentNameForDigest(name, candidate.digest))
            ? candidate.uri
            : undefined,
        ),
      );
    },
    {concurrency: 4},
  );
  return new Set(present.filter((uri): uri is string => uri !== undefined));
});

export const discardDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.discard')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* deferredCodeAnchorRoot(config);
  const paths = yield* deferredCodeAnchorIntentPaths(config, memoryUri);
  for (const intentPath of paths) {
    const ancestors = deferredCodeAnchorIntentAncestorsForPath(path, root, intentPath);
    const content = yield* readPrivateDeferredCodeAnchorIntent(fs, intentPath, ancestors);
    const intent = content === undefined ? undefined : parseDeferredCodeAnchorIntent(content);
    if (intent === undefined) {
      yield* removePrivateDeferredCodeAnchorFile(fs, intentPath, ancestors);
      yield* discardDeferredCodeAnchorRouteMarkersNamed(config, path.basename(intentPath));
    } else {
      yield* discardStoredDeferredCodeAnchorIntent(config, {
        intent,
        kind: 'valid',
        name: path.basename(intentPath),
        path: intentPath,
      });
    }
  }
});

export const discardOtherDeferredCodeAnchorIntents = Effect.fn('memoryCodeAnchor.discardOther')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
  retainedIntentId: string,
) {
  const path = yield* Path.Path;
  const root = yield* deferredCodeAnchorRoot(config);
  const candidates = yield* deferredCodeAnchorIntentPaths(config, memoryUri);
  const retainedCandidates = candidates.filter(
    candidate => deferredCodeAnchorIntentIdFromName(path.basename(candidate)) === retainedIntentId,
  );
  const retainedPath =
    retainedCandidates.find(
      candidate => parseDeferredCodeAnchorIntentName(path.basename(candidate))?.kind === 'sharded',
    ) ?? retainedCandidates[0];
  const paths = candidates.filter(candidate => candidate !== retainedPath);
  const fs = yield* FileSystem.FileSystem;
  for (const intentPath of paths) {
    const ancestors = deferredCodeAnchorIntentAncestorsForPath(path, root, intentPath);
    const content = yield* readPrivateDeferredCodeAnchorIntent(fs, intentPath, ancestors);
    const intent = content === undefined ? undefined : parseDeferredCodeAnchorIntent(content);
    if (intent === undefined || intent.intentId === retainedIntentId) {
      yield* removePrivateDeferredCodeAnchorFile(fs, intentPath, ancestors);
      if (parseDeferredCodeAnchorIntentName(path.basename(intentPath))?.kind === 'sharded') {
        yield* discardDeferredCodeAnchorRouteMarkersNamed(config, path.basename(intentPath));
      }
    } else {
      yield* discardStoredDeferredCodeAnchorIntent(config, {
        intent,
        kind: 'valid',
        name: path.basename(intentPath),
        path: intentPath,
      });
    }
  }
  return paths.length;
});

export const discardDeferredCodeAnchorIntentsWithin = Effect.fn('memoryCodeAnchor.discardWithin')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  const canonical = parseResourceId(memoryUri).canonicalUri;
  yield* discardDeferredCodeAnchorIntent(config, canonical);
  const stored = yield* listDeferredCodeAnchorIntents(config);
  const prefix = `${canonical}/`;
  const matching = stored.filter(
    (entry): entry is StoredDeferredCodeAnchorIntent =>
      entry.kind === 'valid' && entry.intent.memoryUri.startsWith(prefix),
  );
  yield* Effect.forEach(matching, entry => discardStoredDeferredCodeAnchorIntent(config, entry), {concurrency: 4});
  return matching.length;
});

export function classifyDeferredCodeAnchorEligibility(
  intent: DeferredCodeAnchorIntentV1,
  observation: DeferredMemoryObservation | undefined,
): DeferredCodeAnchorEligibility {
  if (!observation) return {reason: 'canonical-memory-missing', state: 'conflict'};
  if (observation.record.metadata.memoryId !== intent.memoryId) {
    return {reason: 'memory-id-changed', state: 'conflict'};
  }
  if (observation.hash !== intent.expectedMemoryHash) {
    return {reason: 'canonical-memory-changed', state: 'conflict'};
  }
  if (observation.record.metadata.status !== 'active') {
    return {reason: 'memory-no-longer-active', state: 'conflict'};
  }
  if (observation.record.metadata.visibility === 'shared' || observation.record.metadata.visibility === 'external') {
    return {reason: 'memory-no-longer-personal', state: 'conflict'};
  }
  if ((observation.record.metadata.codeCitations?.length ?? 0) > 0) {
    return {reason: 'memory-already-cited', state: 'conflict'};
  }
  return {state: 'eligible'};
}

export const finalizeDeferredCodeAnchors = Effect.fn('memoryCodeAnchor.finalize')(function* (
  config: RuntimeConfig,
  options: {readonly limit?: number; readonly uris?: readonly string[]} = {},
) {
  const limit = boundedFinalizeLimit(options.limit);
  const requestedUris = new Set((options.uris ?? []).map(uri => canonicalPersonalMemoryUri(config, uri)));
  const requestedDigests = new Set(
    yield* Effect.forEach([...requestedUris], uri => deferredCodeAnchorUriDigest(uri), {concurrency: 4}),
  );
  const matching = (yield* listDeferredCodeAnchorIntents(config)).filter(entry => {
    if (requestedUris.size === 0) return true;
    if (entry.kind === 'valid') return requestedUris.has(entry.intent.memoryUri);
    const uriDigest = entry.uriDigest;
    return uriDigest !== undefined && [...requestedDigests].some(digest => digest.startsWith(uriDigest));
  });
  const stored =
    requestedUris.size === 0
      ? yield* selectDeferredCodeAnchorFinalizationWindow(config, matching, limit)
      : matching.slice(0, limit);
  const items = yield* Effect.forEach(
    stored,
    entry => {
      if (entry.kind === 'invalid') {
        return Effect.succeed<DeferredCodeAnchorFinalizeItemV1>({
          code: 'invalid-intent',
          reason: 'Private deferred code-anchor intent is unreadable or malformed.',
          state: 'failed' as const,
        } satisfies DeferredCodeAnchorFinalizeItemV1);
      }
      return finalizeDeferredCodeAnchor(config, entry).pipe(
        Effect.result,
        Effect.map((finalized): DeferredCodeAnchorFinalizeItemV1 =>
          Result.isSuccess(finalized)
            ? finalized.success
            : ({
                code: 'finalization-error',
                memoryUri: entry.intent.memoryUri,
                reason: 'Deferred code-anchor finalization failed safely; retry or run threadnote doctor --dry-run.',
                state: 'failed' as const,
              } satisfies DeferredCodeAnchorFinalizeItemV1),
        ),
      );
    },
    {concurrency: DEFERRED_CODE_ANCHOR_FINALIZATION_CONCURRENCY},
  );
  return {
    conflictCount: items.filter(item => item.state === 'conflict').length,
    failedCount: items.filter(item => item.state === 'failed').length,
    finalizedCount: items.filter(item => item.state === 'finalized').length,
    items,
    pendingCount: items.filter(item => item.state === 'pending').length,
    scannedCount: items.length,
    type: 'threadnote-deferred-code-anchor-finalization',
    version: DEFERRED_CODE_ANCHOR_FINALIZATION_VERSION,
  } satisfies DeferredCodeAnchorFinalizationReceiptV1;
});

/**
 * Opportunistically consume only intents routed by an already-observed graph
 * publication. This is deliberately a ready-evidence consumer: it never asks
 * the graph service to index, attach, refresh, or perform maintenance.
 *
 * The initial private-outbox scan is also the absent-route fast path. When no
 * valid intent belongs to the supplied route, the function returns before it
 * reads a canonical memory or asks the graph service for status.
 */
export const finalizeDeferredCodeAnchorsForRoute = Effect.fn('memoryCodeAnchor.finalizeRoute')(function* (
  config: RuntimeConfig,
  route: DeferredCodeAnchorFinalizationRoute,
  options: DeferredCodeAnchorRouteFinalizationOptions = {},
) {
  const failedReceipt = deferredCodeAnchorRouteReceipt('failed');
  let observedMatchedCount = 0;
  const observedItems: DeferredCodeAnchorFinalizeItemV1[] = [];
  return yield* Effect.gen(function* () {
    const limit = boundedFinalizeLimit(options.limit);
    const waitTimeoutMilliseconds = boundedRouteLockWaitTimeout(options.waitTimeoutMilliseconds);
    const passTimeoutMilliseconds = boundedRoutePassTimeout(options.passTimeoutMilliseconds);
    const routeDigest = yield* deferredCodeAnchorRouteDigest(config, route);
    const preferredCodeRefs = safelyNormalizePreferredCodeRefs(options.preferredCodeRefs ?? []);
    const preferredCodeRefDigests = yield* Effect.forEach(preferredCodeRefs, ref => sha256Hex(ref), {concurrency: 4});
    const attempted = yield* Effect.gen(function* () {
      const preflight = yield* listDeferredCodeAnchorIntentsForRoute(
        config,
        route,
        routeDigest,
        limit,
        preferredCodeRefDigests,
        false,
      );
      if (preflight.entries.length === 0 && !preflight.maintenancePending) {
        return deferredCodeAnchorRouteReceipt(preflight.partial ? 'contended' : 'completed');
      }

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lockPath = path.join(
        config.agentContextHome,
        'threadnote',
        'deferred-code-anchor-finalizers',
        `${routeDigest}.lock`,
      );
      return yield* withExclusiveFileLock(
        fs,
        lockPath,
        {
          retryIntervalMilliseconds: DEFERRED_CODE_ANCHOR_ROUTE_LOCK_RETRY_MILLISECONDS,
          staleAfterMilliseconds: DEFERRED_CODE_ANCHOR_ROUTE_LOCK_STALE_MILLISECONDS,
          useCanonicalProcessStartIdentity: true,
          waitTimeoutMilliseconds,
        },
        Effect.gen(function* () {
          const locked = yield* listDeferredCodeAnchorIntentsForRoute(
            config,
            route,
            routeDigest,
            limit,
            preferredCodeRefDigests,
            true,
          );
          const matching = locked.entries;
          observedMatchedCount = matching.length;
          if (matching.length === 0) {
            return deferredCodeAnchorRouteReceipt(
              locked.partial || locked.maintenancePending ? 'contended' : 'completed',
            );
          }
          const selected = prioritizeDeferredCodeAnchorEntries(matching, preferredCodeRefs).slice(
            0,
            limit,
          ) as readonly StoredDeferredCodeAnchorIntent[];
          const items = yield* Effect.forEach(
            selected,
            entry =>
              Effect.gen(function* () {
                if (options.onAttemptedUri)
                  safelyNotifyDeferredCodeAnchorUri(options.onAttemptedUri, entry.intent.memoryUri);
                const finalized = yield* finalizeDeferredCodeAnchor(config, entry).pipe(Effect.result);
                const item: DeferredCodeAnchorFinalizeItemV1 = Result.isSuccess(finalized)
                  ? finalized.success
                  : ({
                      code: 'finalization-error',
                      memoryUri: entry.intent.memoryUri,
                      reason:
                        'Deferred code-anchor finalization failed safely; retry or run threadnote doctor --dry-run.',
                      state: 'failed' as const,
                    } satisfies DeferredCodeAnchorFinalizeItemV1);
                if (item.state === 'pending' || item.state === 'failed') {
                  yield* rotateDeferredCodeAnchorRouteMarker(entry);
                } else if (item.state === 'finalized' && options.onFinalizedUri !== undefined) {
                  safelyNotifyDeferredCodeAnchorUri(options.onFinalizedUri, entry.intent.memoryUri);
                }
                return item;
              }),
            {concurrency: DEFERRED_CODE_ANCHOR_FINALIZATION_CONCURRENCY},
          );
          observedItems.push(...items);
          if (matching.length > selected.length) {
            const unprocessed = matching.find(entry => !selected.includes(entry));
            if (unprocessed !== undefined) yield* retainDeferredCodeAnchorRouteMarkerLane(unprocessed);
          }
          const remainingWork =
            locked.partial ||
            matching.length > selected.length ||
            observedItems.some(item => item.state === 'pending' || item.state === 'failed');
          return deferredCodeAnchorRouteReceipt(
            remainingWork ? 'contended' : 'completed',
            matching.length,
            observedItems,
          );
        }),
      ).pipe(
        Effect.catchIf(isFileLockTimeout, () =>
          Effect.succeed(deferredCodeAnchorRouteReceipt('contended', preflight.entries.length)),
        ),
      );
    }).pipe(Effect.timeoutOption(passTimeoutMilliseconds));
    return Option.isSome(attempted)
      ? attempted.value
      : deferredCodeAnchorRouteReceipt('contended', observedMatchedCount, observedItems);
  }).pipe(Effect.catchCause(() => Effect.succeed(failedReceipt)));
});

export function deferredCodeAnchorIntentMatchesFinalizationRoute(
  intent: DeferredCodeAnchorIntentV1,
  route: DeferredCodeAnchorFinalizationRoute,
): boolean {
  if (route.kind === 'repository') {
    return intent.repositoryId === route.repositoryId && intent.worktreeId === route.worktreeId;
  }
  return (
    (intent.recovery.preparation.target === 'workset' && intent.recovery.preparation.arguments[0] === route.name) ||
    intent.codeRefs.some(ref => DEFERRED_CODE_ANCHOR_QUALIFIED_REF.test(ref))
  );
}

const finalizeDeferredCodeAnchor = Effect.fn('memoryCodeAnchor.finalizeOne')(function* (
  config: RuntimeConfig,
  entry: StoredDeferredCodeAnchorIntent,
) {
  const fs = yield* FileSystem.FileSystem;
  const admission = yield* withMemoryUriLocks(
    fs,
    config.agentContextHome,
    [entry.intent.memoryUri],
    Effect.gen(function* () {
      const initial = yield* readDeferredMemoryObservation(config, entry.intent.memoryUri);
      const eligibility = classifyDeferredCodeAnchorEligibility(entry.intent, initial);
      if (eligibility.state === 'conflict') {
        yield* discardStoredDeferredCodeAnchorIntent(config, entry);
        return {
          item: {
            memoryUri: entry.intent.memoryUri,
            reason: eligibility.reason,
            state: 'conflict',
          } satisfies DeferredCodeAnchorFinalizeItemV1,
          state: 'rejected' as const,
        };
      }
      const checkout = yield* classifyDeferredCodeAnchorCallerCheckoutAdmission(config.agentContextHome, entry.intent);
      if (checkout.state === 'conflict') {
        yield* discardStoredDeferredCodeAnchorIntent(config, entry);
        return {
          item: {
            memoryUri: entry.intent.memoryUri,
            reason: checkout.reason,
            state: 'conflict',
          } satisfies DeferredCodeAnchorFinalizeItemV1,
          state: 'rejected' as const,
        };
      }
      return {state: 'eligible' as const};
    }),
  );
  if (admission.state === 'rejected') return admission.item;

  const captured = yield* verifyDeferredCodeAnchorProjectScope(config, entry.intent).pipe(
    Effect.andThen(() =>
      captureMemoryCodeCitations(config, {
        callerCwd: entry.intent.callerCwd,
        ...(entry.intent.project === undefined ? {} : {project: entry.intent.project}),
        expectedCallerIdentity: {
          repositoryId: entry.intent.repositoryId,
          worktreeId: entry.intent.worktreeId,
        },
        ...(entry.intent.projectScope === undefined ? {} : {expectedProjectScope: entry.intent.projectScope}),
        omitUnresolved: true,
        refs: entry.intent.codeRefs,
      }),
    ),
    Effect.tap(() => verifyDeferredCodeAnchorProjectScope(config, entry.intent)),
    Effect.result,
  );
  if (Result.isFailure(captured)) {
    const classified = deferredCodeAnchorCaptureFailureItem(captured.failure, entry.intent.memoryUri);
    if (classified !== undefined) {
      if (
        classified.state === 'pending' &&
        classified.retryable === true &&
        entry.intent.recovery.preparation.target !== 'workset'
      ) {
        yield* scheduleDeferredCodeAnchorIntentRefresh(config, entry.intent).pipe(Effect.ignoreCause);
      }
      return classified;
    }
    return {
      code: 'citation-capture-failed',
      memoryUri: entry.intent.memoryUri,
      reason: 'Code citation capture failed safely; retry or run threadnote doctor --dry-run.',
      state: 'failed',
    } satisfies DeferredCodeAnchorFinalizeItemV1;
  }
  const citations = captured.success;
  return yield* withDeferredCodeAnchorMutationLocks(
    fs,
    config,
    [entry.intent.memoryUri],
    Effect.gen(function* () {
      const current = yield* readDeferredMemoryObservation(config, entry.intent.memoryUri);
      const currentEligibility = classifyDeferredCodeAnchorEligibility(entry.intent, current);
      if (currentEligibility.state === 'conflict') {
        yield* discardStoredDeferredCodeAnchorIntent(config, entry);
        return {
          memoryUri: entry.intent.memoryUri,
          reason: currentEligibility.reason,
          state: 'conflict',
        } satisfies DeferredCodeAnchorFinalizeItemV1;
      }
      if (citations.length === 0) {
        yield* discardStoredDeferredCodeAnchorIntent(config, entry);
        return {
          memoryUri: entry.intent.memoryUri,
          reason: 'code-references-absent',
          state: 'conflict',
        } satisfies DeferredCodeAnchorFinalizeItemV1;
      }
      const record = current!.record;
      const sourceCommit = commonCitationSourceCommit(citations);
      const memory = formatMemoryDocument(
        record.headerTitle,
        {
          ...record.metadata,
          codeCitations: citations,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          ...(sourceCommit === undefined ? {} : {sourceCommit}),
          sourceObservedAt: DateTime.formatIso(yield* DateTime.now),
        },
        record.body,
      );
      const store = yield* ResourceStore;
      // The private intent is the recovery record for the canonical write. If
      // the foreground deadline interrupts after that write commits, reconcile
      // the canonical bytes before releasing the mutation lock. This keeps the
      // potentially slow write interruptible while closing the commit/cleanup
      // race; process crashes remain recoverable through the already-cited path.
      return yield* Effect.gen(function* () {
        yield* store.write(resourceStoreLocation(config), entry.intent.memoryUri, memory, {mode: 'upsert'});
        yield* discardMemoryRelocation(config, entry.intent.memoryUri);
        const verified = yield* store.read(resourceStoreLocation(config), entry.intent.memoryUri);
        const verifiedRecord = parseMemoryDocument(entry.intent.memoryUri, verified);
        if (!verifiedRecord || !deferredCodeAnchorFinalizationVerified(memory, verified)) {
          return yield* deferredCodeAnchorError(
            `Deferred code-anchor verification failed for ${entry.intent.memoryUri}.`,
          );
        }
        yield* discardStoredDeferredCodeAnchorIntent(config, entry);
        return {
          citationCount: citations.length,
          memoryUri: entry.intent.memoryUri,
          state: 'finalized',
        } satisfies DeferredCodeAnchorFinalizeItemV1;
      }).pipe(
        Effect.onInterrupt(() =>
          reconcileInterruptedDeferredCodeAnchorCommit(
            config,
            entry.intent.memoryUri,
            memory,
            discardMemoryRelocation(config, entry.intent.memoryUri).pipe(
              Effect.andThen(discardStoredDeferredCodeAnchorIntent(config, entry)),
            ),
          ),
        ),
      );
    }),
  );
});

const writeDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.writeIntent')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  intent: DeferredCodeAnchorIntentV1,
) {
  yield* persistShardedDeferredCodeAnchorIntent(config, intent, `${JSON.stringify(intent, undefined, 2)}\n`);
});

export const listDeferredCodeAnchorIntents = Effect.fn('memoryCodeAnchor.listIntents')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) return [] as DeferredCodeAnchorIntentEntry[];
  const itemRoot = path.join(root, DEFERRED_CODE_ANCHOR_ITEM_ROOT_NAME);
  const itemDirectoryNames = yield* readPrivateDeferredCodeAnchorDirectory(fs, itemRoot, [root, itemRoot]);
  const itemCandidates: {readonly ancestors: readonly string[]; readonly name: string; readonly path: string}[] = [];
  for (const directoryName of itemDirectoryNames ?? []) {
    if (!/^u[a-f0-9]{32}$/u.test(directoryName)) continue;
    const itemDirectory = path.join(itemRoot, directoryName);
    const ancestors = [root, itemRoot, itemDirectory];
    const itemNames = yield* readPrivateDeferredCodeAnchorDirectory(fs, itemDirectory, ancestors);
    for (const name of itemNames ?? []) {
      if (name.endsWith('.json')) itemCandidates.push({ancestors, name, path: path.join(itemDirectory, name)});
    }
  }
  const legacyNames = ((yield* readPrivateDeferredCodeAnchorDirectory(fs, root, [root])) ?? []).filter(name =>
    name.endsWith('.json'),
  );
  const legacyQuarantineRoot = path.join(root, DEFERRED_CODE_ANCHOR_LEGACY_QUARANTINE_NAME);
  const quarantinedCandidates: {readonly ancestors: readonly string[]; readonly name: string; readonly path: string}[] =
    [];
  if (yield* validatePrivateDeferredCodeAnchorDirectories(fs, [root, legacyQuarantineRoot])) {
    const slots = yield* readPrivateDeferredCodeAnchorDirectory(fs, legacyQuarantineRoot, [root, legacyQuarantineRoot]);
    for (const slot of slots ?? []) {
      if (!/^q-[a-f0-9]{24}$/u.test(slot)) continue;
      const slotRoot = path.join(legacyQuarantineRoot, slot);
      const ancestors = [root, legacyQuarantineRoot, slotRoot];
      if (!(yield* validatePrivateDeferredCodeAnchorDirectories(fs, ancestors))) continue;
      quarantinedCandidates.push({ancestors, name: `${slot}.json`, path: path.join(slotRoot, 'entry')});
    }
  }
  const candidates = [
    ...legacyNames.map(name => ({ancestors: [root], name, path: path.join(root, name)})),
    ...itemCandidates,
    ...quarantinedCandidates,
  ];
  const entries: DeferredCodeAnchorIntentEntry[] = [];
  for (const {ancestors, name, path: intentPath} of candidates.sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const content = yield* readPrivateDeferredCodeAnchorIntent(fs, intentPath, ancestors);
    const candidate = content === undefined ? undefined : parseDeferredCodeAnchorIntent(content);
    const parsed =
      candidate && (yield* storedDeferredCodeAnchorIntentMatchesAddress(config, candidate, name))
        ? candidate
        : undefined;
    entries.push(
      parsed
        ? {intent: parsed, kind: 'valid', name, path: intentPath}
        : {kind: 'invalid', name, path: intentPath, uriDigest: deferredCodeAnchorUriDigestFromName(name)},
    );
  }
  return entries;
});

interface DeferredCodeAnchorRouteIntentListing {
  readonly entries: readonly StoredDeferredCodeAnchorIntent[];
  /** Advisory route markers need a protected cleanup pass before absence is conclusive. */
  readonly maintenancePending: boolean;
  /** Discovery stopped at a fixed page boundary and may not cover every compatible legacy/route entry. */
  readonly partial: boolean;
}

const listDeferredCodeAnchorIntentsForRoute = Effect.fn('memoryCodeAnchor.listIntentsForRoute')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  route: DeferredCodeAnchorFinalizationRoute,
  routeDigest: string,
  finalizeLimit: number,
  preferredCodeRefDigests: readonly string[],
  advanceCursors: boolean,
) {
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) {
    return {entries: [], maintenancePending: false, partial: false} satisfies DeferredCodeAnchorRouteIntentListing;
  }

  const routedScanLimit = Math.max(
    MIN_DEFERRED_CODE_ANCHOR_ROUTED_SCAN_LIMIT,
    Math.min(
      MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT * DEFERRED_CODE_ANCHOR_ROUTED_SCAN_MULTIPLIER,
      finalizeLimit * DEFERRED_CODE_ANCHOR_ROUTED_SCAN_MULTIPLIER,
    ),
  );
  const legacyScanLimit = Math.max(
    MIN_DEFERRED_CODE_ANCHOR_LEGACY_ROUTE_SCAN_LIMIT,
    Math.min(
      MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT * DEFERRED_CODE_ANCHOR_LEGACY_ROUTE_SCAN_MULTIPLIER,
      finalizeLimit * DEFERRED_CODE_ANCHOR_LEGACY_ROUTE_SCAN_MULTIPLIER,
    ),
  );
  const legacy = yield* migrateBoundedLegacyDeferredCodeAnchorIntents(config, root, legacyScanLimit);
  const queueKeys = deferredCodeAnchorRouteQueueKeys(route, routeDigest, preferredCodeRefDigests);
  const entries: StoredDeferredCodeAnchorIntent[] = [];
  let maintenancePending = false;
  let partial = legacy.partial;
  let remaining = routedScanLimit;
  for (const key of queueKeys) {
    if (remaining === 0) {
      partial = true;
      break;
    }
    const queue = yield* readDeferredCodeAnchorRouteQueue(config, root, key, remaining, advanceCursors);
    partial ||= queue.partial;
    maintenancePending ||= queue.maintenancePending;
    for (const entry of queue.entries) {
      if (
        deferredCodeAnchorIntentMatchesFinalizationRoute(entry.intent, route) &&
        !entries.some(existing => existing.path === entry.path)
      ) {
        entries.push(entry);
        remaining -= 1;
        if (remaining === 0) break;
      }
    }
  }
  return {
    entries,
    maintenancePending,
    partial,
  } satisfies DeferredCodeAnchorRouteIntentListing;
});

function deferredCodeAnchorRouteQueueKeys(
  route: DeferredCodeAnchorFinalizationRoute,
  routeDigest: string,
  preferredCodeRefDigests: readonly string[],
): readonly string[] {
  const preferredKeys = preferredCodeRefDigests.map(
    digest => `p${digest.slice(0, DEFERRED_CODE_ANCHOR_ROUTE_KEY_HEX_LENGTH)}`,
  );
  return route.kind === 'repository'
    ? [...preferredKeys, `r${routeDigest.slice(0, DEFERRED_CODE_ANCHOR_ROUTE_KEY_HEX_LENGTH)}`]
    : [...preferredKeys, `w${routeDigest.slice(0, DEFERRED_CODE_ANCHOR_ROUTE_KEY_HEX_LENGTH)}`, 'q'];
}

const readDeferredCodeAnchorRouteQueue = Effect.fn('memoryCodeAnchor.readRouteQueue')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  root: string,
  key: string,
  limit: number,
  advanceCursor: boolean,
) {
  if (!isDeferredCodeAnchorRouteQueueKey(key)) {
    return yield* deferredCodeAnchorError('Deferred code-anchor route queue key is invalid.');
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const queueAncestors = deferredCodeAnchorRouteAncestors(path, root, key);
  const queueRoot = queueAncestors[queueAncestors.length - 1];
  if (!(yield* validatePrivateDeferredCodeAnchorDirectories(fs, queueAncestors))) {
    return {entries: [] as StoredDeferredCodeAnchorIntent[], maintenancePending: false, partial: false};
  }
  const quarantine = (entryPath: string, sourceAncestors: readonly string[]) =>
    quarantinePrivateDeferredCodeAnchorRouteEntry(fs, path, entryPath, sourceAncestors, queueAncestors);
  const startLane = yield* readDeferredCodeAnchorRouteQueueCursor(fs, path, queueRoot, queueAncestors);
  const entries: StoredDeferredCodeAnchorIntent[] = [];
  let inspectedMarkerCount = 0;
  let maintenancePending = false;
  for (let offset = 0; offset < DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT; offset += 1) {
    const lane = (startLane + offset) % DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT;
    const laneAncestors = deferredCodeAnchorRouteAncestors(path, root, key, lane);
    const laneRoot = laneAncestors[laneAncestors.length - 1];
    const laneAuthority = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, laneAncestors);
    if (laneAuthority === undefined) continue;
    const remaining = limit - inspectedMarkerCount;
    if (remaining <= 0) {
      return {entries, maintenancePending, partial: true};
    }
    const page = yield* runtimeTextDirectoryNamePage(laneRoot, remaining + 1);
    const laneAfterListing = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, laneAncestors);
    if (laneAfterListing === undefined || !samePrivateDeferredCodeAnchorDirectories(laneAuthority, laneAfterListing)) {
      return yield* deferredCodeAnchorError('Deferred code-anchor route lane changed during listing.');
    }
    const pageEntries = page.names.slice(0, remaining);
    if (pageEntries.length === 0) continue;
    const laneHasUnexaminedMarkers = page.overflow || page.names.length > pageEntries.length;
    for (const markerName of pageEntries) {
      inspectedMarkerCount += 1;
      const markerPath = path.join(laneRoot, markerName);
      const markerKind = yield* deferredCodeAnchorPathEntryKind(fs, markerPath);
      const markerIsPrivateFile =
        markerKind === 'file' && fileSystemModeIsPrivate(runtimePlatform, (yield* fs.stat(markerPath)).mode);
      if (!markerIsPrivateFile) {
        if (advanceCursor) yield* quarantine(markerPath, laneAncestors);
        else maintenancePending = true;
        continue;
      }
      if (!markerName.endsWith('.ref')) {
        if (advanceCursor) yield* quarantine(markerPath, laneAncestors);
        else maintenancePending = true;
        continue;
      }
      const name = `${markerName.slice(0, -4)}.json`;
      const address = parseDeferredCodeAnchorIntentName(name);
      if (address?.kind !== 'sharded') {
        if (advanceCursor) yield* quarantine(markerPath, laneAncestors);
        else maintenancePending = true;
        continue;
      }
      const intentPath = path.join(root, DEFERRED_CODE_ANCHOR_ITEM_ROOT_NAME, `u${address.uriDigest}`, name);
      const itemAncestors = deferredCodeAnchorItemAncestors(path, root, address.uriDigest);
      const itemDirectoryExists = yield* validatePrivateDeferredCodeAnchorDirectories(fs, itemAncestors);
      const content = itemDirectoryExists
        ? yield* readPrivateDeferredCodeAnchorIntent(fs, intentPath, itemAncestors)
        : undefined;
      const intent = content === undefined ? undefined : parseDeferredCodeAnchorIntent(content);
      if (intent && (yield* storedDeferredCodeAnchorIntentMatchesAddress(config, intent, name))) {
        entries.push({intent, kind: 'valid', markerPath, name, path: intentPath});
      } else if (advanceCursor) {
        // A route marker never owns the canonical intent. Quarantining only
        // this hint makes progress without deriving deletion authority.
        yield* quarantine(markerPath, laneAncestors);
      } else {
        maintenancePending = true;
      }
    }
    if (advanceCursor) {
      const nextLane = laneHasUnexaminedMarkers ? lane : (lane + 1) % DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT;
      yield* writeDeferredCodeAnchorRouteQueueCursor(fs, path, queueRoot, queueAncestors, nextLane);
    }
    if (laneHasUnexaminedMarkers) return {entries, maintenancePending, partial: true};
    if (inspectedMarkerCount >= limit && offset + 1 < DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT) {
      return {entries, maintenancePending, partial: true};
    }
  }
  return {entries, maintenancePending, partial: false};
});

const migrateBoundedLegacyDeferredCodeAnchorIntents = Effect.fn('memoryCodeAnchor.migrateLegacyPage')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  root: string,
  limit: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // New intents never live in this flat root. A native directory page keeps
  // compatibility work fixed even when old installations accumulated a large outbox.
  const rootAuthority = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, [root]);
  if (rootAuthority === undefined) return {partial: false};
  const page = yield* runtimeTextDirectoryNamePage(root, limit + 8);
  const rootAfterListing = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, [root]);
  if (rootAfterListing === undefined || !samePrivateDeferredCodeAnchorDirectories(rootAuthority, rootAfterListing)) {
    return yield* deferredCodeAnchorError('Deferred code-anchor outbox changed during legacy listing.');
  }
  const names = page.names.filter(name => name.endsWith('.json')).slice(0, limit);
  for (const name of names) {
    const intentPath = path.join(root, name);
    if (parseDeferredCodeAnchorIntentName(name) === undefined) {
      yield* quarantinePrivateDeferredCodeAnchorLegacyEntry(fs, path, intentPath, [root]);
      continue;
    }
    const content = yield* readPrivateDeferredCodeAnchorIntent(fs, intentPath, [root]);
    const intent = content === undefined ? undefined : parseDeferredCodeAnchorIntent(content);
    if (
      content === undefined ||
      intent === undefined ||
      !(yield* storedDeferredCodeAnchorIntentMatchesAddress(config, intent, name))
    ) {
      // Quarantine preserves diagnostics and keeps bounded migration moving without following or deleting the entry.
      yield* quarantinePrivateDeferredCodeAnchorLegacyEntry(fs, path, intentPath, [root]);
      continue;
    }
    yield* persistShardedDeferredCodeAnchorIntent(config, intent, content);
    yield* removePrivateDeferredCodeAnchorFile(fs, intentPath, [root]);
  }
  return {partial: page.overflow || page.names.filter(name => name.endsWith('.json')).length > limit};
});

const persistShardedDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.persistSharded')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  intent: DeferredCodeAnchorIntentV1,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* ensurePrivateDeferredCodeAnchorRoot(config);
  const uriDigest = yield* deferredCodeAnchorUriDigest(intent.memoryUri);
  const name = yield* deferredCodeAnchorShardedIntentName(intent);
  const itemRoot = yield* ensurePrivateDeferredCodeAnchorDirectory(
    fs,
    path.join(root, DEFERRED_CODE_ANCHOR_ITEM_ROOT_NAME),
    [root],
  );
  const itemDirectory = yield* ensurePrivateDeferredCodeAnchorDirectory(
    fs,
    path.join(itemRoot, `u${uriDigest.slice(0, DEFERRED_CODE_ANCHOR_URI_ADDRESS_HEX_LENGTH)}`),
    [root, itemRoot],
  );
  const target = path.join(itemDirectory, name);
  yield* writePrivateDeferredCodeAnchorFile(fs, path, target, content, 'intent', [root, itemRoot, itemDirectory]);

  const routeRoot = yield* ensurePrivateDeferredCodeAnchorDirectory(
    fs,
    path.join(root, DEFERRED_CODE_ANCHOR_ROUTE_ROOT_NAME),
    [root],
  );
  for (const key of yield* deferredCodeAnchorRouteQueueKeysForIntent(config, intent)) {
    const queueRoot = yield* ensurePrivateDeferredCodeAnchorDirectory(fs, path.join(routeRoot, key), [root, routeRoot]);
    const laneRoot = yield* ensurePrivateDeferredCodeAnchorDirectory(fs, path.join(queueRoot, '0'), [
      root,
      routeRoot,
      queueRoot,
    ]);
    const marker = path.join(laneRoot, `${name.slice(0, -5)}.ref`);
    yield* writePrivateDeferredCodeAnchorFile(fs, path, marker, '1\n', 'route marker', [
      root,
      routeRoot,
      queueRoot,
      laneRoot,
    ]);
  }
  return {intent, kind: 'valid', name, path: target} satisfies StoredDeferredCodeAnchorIntent;
});

const deferredCodeAnchorRouteQueueKeysForIntent = Effect.fn('memoryCodeAnchor.routeQueueKeys')(function* (
  config: Pick<RuntimeConfig, 'account' | 'user'>,
  intent: DeferredCodeAnchorIntentV1,
) {
  const repositoryDigest = yield* deferredCodeAnchorRouteDigest(config, {
    callerCwd: intent.callerCwd,
    kind: 'repository',
    repositoryId: intent.repositoryId,
    worktreeId: intent.worktreeId,
  });
  const keys = [`r${repositoryDigest.slice(0, DEFERRED_CODE_ANCHOR_ROUTE_KEY_HEX_LENGTH)}`];
  if (intent.recovery.preparation.target === 'workset') {
    const worksetDigest = yield* deferredCodeAnchorRouteDigest(config, {
      kind: 'workset',
      name: intent.recovery.preparation.arguments[0],
    });
    keys.push(`w${worksetDigest.slice(0, DEFERRED_CODE_ANCHOR_ROUTE_KEY_HEX_LENGTH)}`);
  }
  const digests = yield* Effect.forEach(intent.codeRefs, ref => sha256Hex(ref), {concurrency: 4});
  keys.push(...digests.map(digest => `p${digest.slice(0, DEFERRED_CODE_ANCHOR_ROUTE_KEY_HEX_LENGTH)}`));
  const qualifiedRefs = intent.codeRefs.filter(ref => DEFERRED_CODE_ANCHOR_QUALIFIED_REF.test(ref));
  if (qualifiedRefs.length > 0) {
    keys.push('q');
  }
  return [...new Set(keys)];
});

function isDeferredCodeAnchorRouteQueueKey(key: string): boolean {
  return key === 'q' || /^[rwp][a-f0-9]{32}$/u.test(key);
}

const readDeferredCodeAnchorRouteQueueCursor = Effect.fn('memoryCodeAnchor.readRouteQueueCursor')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  queueRoot: string,
  queueAncestors: readonly string[],
) {
  const content = yield* readPrivateDeferredCodeAnchorIntent(fs, path.join(queueRoot, 'cursor'), queueAncestors);
  if (content === undefined || !/^[0-7]\n?$/u.test(content)) return 0;
  return Number.parseInt(content, 10);
});

const writeDeferredCodeAnchorRouteQueueCursor = Effect.fn('memoryCodeAnchor.writeRouteQueueCursor')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  queueRoot: string,
  queueAncestors: readonly string[],
  lane: number,
) {
  if (!Number.isSafeInteger(lane) || lane < 0 || lane >= DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT) {
    return yield* deferredCodeAnchorError('Deferred code-anchor route queue cursor is invalid.');
  }
  yield* writePrivateDeferredCodeAnchorFile(
    fs,
    path,
    path.join(queueRoot, 'cursor'),
    `${lane}\n`,
    'route cursor',
    queueAncestors,
  );
});

const selectDeferredCodeAnchorFinalizationWindow = Effect.fn('memoryCodeAnchor.selectWindow')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  entries: readonly DeferredCodeAnchorIntentEntry[],
  limit: number,
  cursorName = DEFERRED_CODE_ANCHOR_SCAN_CURSOR_NAME,
  preferredCodeRefs: readonly string[] = [],
) {
  if (entries.length <= limit) return prioritizeDeferredCodeAnchorEntries(entries, preferredCodeRefs);
  const cursor = yield* readDeferredCodeAnchorScanCursor(config, cursorName);
  const next = cursor === undefined ? 0 : entries.findIndex(entry => entry.name > cursor);
  const start = next === -1 ? 0 : next;
  const rotated = [...entries.slice(start), ...entries.slice(0, start)];
  const baseline = rotated.slice(0, limit);
  const selected = prioritizeDeferredCodeAnchorEntries(rotated, preferredCodeRefs).slice(0, limit);
  // Advance by the fair baseline rather than the promoted entry. A requested
  // backlink receives one bounded priority displacement without pinning the
  // rest of a route behind a repeatedly pending preferred intent.
  yield* writeDeferredCodeAnchorScanCursor(config, baseline[baseline.length - 1].name, cursorName);
  return selected;
});

const readDeferredCodeAnchorScanCursor = Effect.fn('memoryCodeAnchor.readScanCursor')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  cursorName = DEFERRED_CODE_ANCHOR_SCAN_CURSOR_NAME,
) {
  if (!isDeferredCodeAnchorCursorName(cursorName)) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) return undefined;
  const cursorPath = path.join(root, cursorName);
  const content = yield* readPrivateDeferredCodeAnchorIntent(fs, cursorPath, [root]);
  if (content === undefined || new TextEncoder().encode(content).byteLength > MAX_DEFERRED_CODE_ANCHOR_CURSOR_BYTES) {
    return undefined;
  }
  const cursor = content.endsWith('\n') ? content.slice(0, -1) : content;
  return isDeferredCodeAnchorCursorValue(cursor) ? cursor : undefined;
});

const writeDeferredCodeAnchorScanCursor = Effect.fn('memoryCodeAnchor.writeScanCursor')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  cursor: string,
  cursorName = DEFERRED_CODE_ANCHOR_SCAN_CURSOR_NAME,
) {
  if (!isDeferredCodeAnchorCursorValue(cursor) || !isDeferredCodeAnchorCursorName(cursorName)) {
    return yield* deferredCodeAnchorError('Deferred code-anchor scan cursor is invalid.');
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* ensurePrivateDeferredCodeAnchorRoot(config);
  const target = path.join(root, cursorName);
  yield* writePrivateDeferredCodeAnchorFile(fs, path, target, `${cursor}\n`, 'scan cursor', [root]);
});

function prioritizeDeferredCodeAnchorEntries(
  entries: readonly DeferredCodeAnchorIntentEntry[],
  preferredCodeRefs: readonly string[],
): readonly DeferredCodeAnchorIntentEntry[] {
  if (preferredCodeRefs.length === 0) return entries;
  const preferred = new Set(preferredCodeRefs);
  const preferredIndex = entries.findIndex(
    entry => entry.kind === 'valid' && entry.intent.codeRefs.some(ref => preferred.has(ref)),
  );
  if (preferredIndex <= 0) return entries;
  return [entries[preferredIndex], ...entries.slice(0, preferredIndex), ...entries.slice(preferredIndex + 1)];
}

function isDeferredCodeAnchorCursorName(value: string): boolean {
  return (
    value === DEFERRED_CODE_ANCHOR_SCAN_CURSOR_NAME ||
    new RegExp(
      `^(?:${DEFERRED_CODE_ANCHOR_ROUTE_SCAN_CURSOR_PREFIX}|${DEFERRED_CODE_ANCHOR_ROUTED_DISCOVERY_CURSOR_PREFIX}|${DEFERRED_CODE_ANCHOR_LEGACY_ROUTE_SCAN_CURSOR_PREFIX})[a-f0-9]{64}$`,
      'u',
    ).test(value)
  );
}

function isDeferredCodeAnchorCursorValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_DEFERRED_CODE_ANCHOR_CURSOR_BYTES &&
    value.endsWith('.json') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !/[\r\n]/u.test(value)
  );
}

const readPrivateDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.readPrivateIntent')(function* (
  fs: FileSystem.FileSystem,
  intentPath: string,
  ancestorDirectories: readonly string[],
) {
  const ancestorAuthority = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
  if (ancestorAuthority === undefined) return undefined;
  if (Option.isSome(yield* fs.readLink(intentPath).pipe(Effect.option))) return undefined;
  const before = yield* fs.stat(intentPath).pipe(Effect.option);
  if (
    Option.isNone(before) ||
    before.value.type !== 'File' ||
    Number(before.value.size) > MAX_DEFERRED_CODE_ANCHOR_INTENT_BYTES ||
    !fileSystemModeIsPrivate(runtimePlatform, before.value.mode)
  ) {
    return undefined;
  }
  const beforeIdentity = yield* readPathFileSystemIdentity(intentPath, before.value, 'File');
  if (Option.isNone(beforeIdentity)) return undefined;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* fs.open(intentPath, {flag: 'r'});
      const openedBefore = yield* opened.stat;
      const pathOpened = yield* fs.stat(intentPath);
      const openedBeforeIdentity = yield* readOpenedFileSystemIdentity(opened, openedBefore, 'File');
      const pathOpenedIdentity = yield* readPathFileSystemIdentity(intentPath, pathOpened, 'File');
      const ancestorsOpened = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
      if (
        ancestorsOpened === undefined ||
        !samePrivateDeferredCodeAnchorDirectories(ancestorAuthority, ancestorsOpened) ||
        Option.isSome(yield* fs.readLink(intentPath).pipe(Effect.option)) ||
        Option.isNone(openedBeforeIdentity) ||
        Option.isNone(pathOpenedIdentity) ||
        !sameDeferredCodeAnchorFile(before.value, beforeIdentity.value, openedBefore, openedBeforeIdentity.value) ||
        !sameDeferredCodeAnchorFile(before.value, beforeIdentity.value, pathOpened, pathOpenedIdentity.value)
      ) {
        return undefined;
      }
      const bytes = new Uint8Array(MAX_DEFERRED_CODE_ANCHOR_INTENT_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = Number(yield* opened.read(bytes.subarray(offset)));
        if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - offset) return undefined;
        if (count === 0) break;
        offset += count;
      }
      const openedAfter = yield* opened.stat;
      const pathAfter = yield* fs.stat(intentPath);
      const openedAfterIdentity = yield* readOpenedFileSystemIdentity(opened, openedAfter, 'File');
      const pathAfterIdentity = yield* readPathFileSystemIdentity(intentPath, pathAfter, 'File');
      const ancestorsAfter = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestorDirectories);
      if (
        ancestorsAfter === undefined ||
        !samePrivateDeferredCodeAnchorDirectories(ancestorAuthority, ancestorsAfter) ||
        Option.isSome(yield* fs.readLink(intentPath).pipe(Effect.option)) ||
        Option.isNone(openedAfterIdentity) ||
        Option.isNone(pathAfterIdentity) ||
        !sameDeferredCodeAnchorFile(before.value, beforeIdentity.value, openedAfter, openedAfterIdentity.value) ||
        !sameDeferredCodeAnchorFile(before.value, beforeIdentity.value, pathAfter, pathAfterIdentity.value) ||
        offset > MAX_DEFERRED_CODE_ANCHOR_INTENT_BYTES ||
        BigInt(offset) !== before.value.size
      ) {
        return undefined;
      }
      return yield* Effect.try({
        try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes.subarray(0, offset)),
        catch: () => undefined,
      });
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));
});

const discardStoredDeferredCodeAnchorIntent = Effect.fn('memoryCodeAnchor.discardStored')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  entry: StoredDeferredCodeAnchorIntent,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) return;
  yield* removePrivateDeferredCodeAnchorFile(
    fs,
    entry.path,
    deferredCodeAnchorIntentAncestorsForPath(path, root, entry.path),
  );
  const uriDigest = yield* deferredCodeAnchorUriDigest(entry.intent.memoryUri);
  const name = yield* deferredCodeAnchorShardedIntentName(entry.intent);
  const itemAncestors = deferredCodeAnchorItemAncestors(path, root, uriDigest);
  yield* removePrivateDeferredCodeAnchorFile(
    fs,
    path.join(itemAncestors[itemAncestors.length - 1], name),
    itemAncestors,
  );
  const markerName = `${name.slice(0, -5)}.ref`;
  for (const key of yield* deferredCodeAnchorRouteQueueKeysForIntent(config, entry.intent)) {
    for (let lane = 0; lane < DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT; lane += 1) {
      const laneAncestors = deferredCodeAnchorRouteAncestors(path, root, key, lane);
      yield* removePrivateDeferredCodeAnchorRouteMarker(
        fs,
        path.join(laneAncestors[laneAncestors.length - 1], markerName),
        laneAncestors,
      );
    }
  }
});

const discardDeferredCodeAnchorRouteMarkersNamed = Effect.fn('memoryCodeAnchor.discardMarkersNamed')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  intentName: string,
) {
  const address = parseDeferredCodeAnchorIntentName(intentName);
  if (address?.kind !== 'sharded') return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) return;
  const routeRoot = path.join(root, DEFERRED_CODE_ANCHOR_ROUTE_ROOT_NAME);
  const markerName = `${intentName.slice(0, -5)}.ref`;
  const routeKeys = yield* readPrivateDeferredCodeAnchorDirectory(fs, routeRoot, [root, routeRoot]);
  for (const key of routeKeys ?? []) {
    if (!isDeferredCodeAnchorRouteQueueKey(key)) continue;
    const queueAncestors = deferredCodeAnchorRouteAncestors(path, root, key);
    const queueRoot = queueAncestors[queueAncestors.length - 1];
    if ((yield* readPrivateDeferredCodeAnchorDirectory(fs, queueRoot, queueAncestors)) === undefined) continue;
    for (let lane = 0; lane < DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT; lane += 1) {
      const laneAncestors = deferredCodeAnchorRouteAncestors(path, root, key, lane);
      const laneRoot = laneAncestors[laneAncestors.length - 1];
      if ((yield* readPrivateDeferredCodeAnchorDirectory(fs, laneRoot, laneAncestors)) === undefined) continue;
      yield* removePrivateDeferredCodeAnchorRouteMarker(fs, path.join(laneRoot, markerName), laneAncestors);
    }
  }
});

const rotateDeferredCodeAnchorRouteMarker = Effect.fn('memoryCodeAnchor.rotateRouteMarker')(function* (
  entry: StoredDeferredCodeAnchorIntent,
) {
  if (entry.markerPath === undefined) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const laneRoot = path.dirname(entry.markerPath);
  const lane = Number.parseInt(path.basename(laneRoot), 10);
  if (!Number.isSafeInteger(lane) || lane < 0 || lane >= DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT) return;
  const queueRoot = path.dirname(laneRoot);
  const routeRoot = path.dirname(queueRoot);
  const root = path.dirname(routeRoot);
  const key = path.basename(queueRoot);
  if (path.basename(routeRoot) !== DEFERRED_CODE_ANCHOR_ROUTE_ROOT_NAME || !isDeferredCodeAnchorRouteQueueKey(key)) {
    return;
  }
  const sourceAncestors = deferredCodeAnchorRouteAncestors(path, root, key, lane);
  if (!(yield* validatePrivateDeferredCodeAnchorDirectories(fs, sourceAncestors))) return;
  const nextLane = (lane + 1) % DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT;
  const queueAncestors = deferredCodeAnchorRouteAncestors(path, root, key);
  if (!(yield* validatePrivateDeferredCodeAnchorDirectories(fs, queueAncestors))) return;
  const nextRoot = yield* ensurePrivateDeferredCodeAnchorDirectory(fs, path.join(queueRoot, String(nextLane)), [
    root,
    routeRoot,
    queueRoot,
  ]);
  const targetAncestors = deferredCodeAnchorRouteAncestors(path, root, key, nextLane);
  const rotationAuthority = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, [
    ...sourceAncestors,
    ...targetAncestors,
  ]);
  if (rotationAuthority === undefined) return;
  const target = path.join(nextRoot, path.basename(entry.markerPath));
  const targetKind = yield* deferredCodeAnchorPathEntryKind(fs, target);
  if (targetKind !== 'missing') {
    yield* removePrivateDeferredCodeAnchorRouteMarker(fs, entry.markerPath, sourceAncestors);
    return;
  }
  const sourceKind = yield* deferredCodeAnchorPathEntryKind(fs, entry.markerPath);
  if (sourceKind !== 'file' && sourceKind !== 'symlink') return;
  if (sourceKind === 'file') {
    const sourceInfo = yield* fs.stat(entry.markerPath);
    if (!fileSystemModeIsPrivate(runtimePlatform, sourceInfo.mode)) return;
  }
  const beforeRename = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, [...sourceAncestors, ...targetAncestors]);
  if (beforeRename === undefined || !samePrivateDeferredCodeAnchorDirectories(rotationAuthority, beforeRename)) return;
  yield* fs.rename(entry.markerPath, target);
  const after = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, [...sourceAncestors, ...targetAncestors]);
  if (after === undefined || !samePrivateDeferredCodeAnchorDirectories(rotationAuthority, after)) {
    return yield* deferredCodeAnchorError('Deferred code-anchor route changed during marker rotation.');
  }
});

const retainDeferredCodeAnchorRouteMarkerLane = Effect.fn('memoryCodeAnchor.retainRouteMarkerLane')(function* (
  entry: StoredDeferredCodeAnchorIntent,
) {
  if (entry.markerPath === undefined) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const laneRoot = path.dirname(entry.markerPath);
  const lane = Number.parseInt(path.basename(laneRoot), 10);
  if (!Number.isSafeInteger(lane) || lane < 0 || lane >= DEFERRED_CODE_ANCHOR_ROUTE_LANE_COUNT) return;
  const queueRoot = path.dirname(laneRoot);
  const routeRoot = path.dirname(queueRoot);
  const root = path.dirname(routeRoot);
  const key = path.basename(queueRoot);
  if (path.basename(routeRoot) !== DEFERRED_CODE_ANCHOR_ROUTE_ROOT_NAME || !isDeferredCodeAnchorRouteQueueKey(key)) {
    return;
  }
  const queueAncestors = deferredCodeAnchorRouteAncestors(path, root, key);
  yield* writeDeferredCodeAnchorRouteQueueCursor(fs, path, queueRoot, queueAncestors, lane);
});

function parseDeferredCodeAnchorIntent(content: string): DeferredCodeAnchorIntentV1 | undefined {
  try {
    const value: unknown = JSON.parse(content);
    if (!Predicate.isObject(value)) return undefined;
    const baseKeys = [
      'authorization',
      'callerCwd',
      'codeRefs',
      'createdAt',
      'expectedMemoryHash',
      'intentId',
      'memoryId',
      'memoryUri',
      'recovery',
      'repositoryId',
      'type',
      'version',
      'visibility',
      'worktreeId',
    ] as const;
    if (
      !hasDeferredCodeAnchorIntentKeys(value, baseKeys) ||
      value.type !== 'threadnote-deferred-code-anchor-intent' ||
      value.version !== DEFERRED_CODE_ANCHOR_INTENT_VERSION ||
      value.authorization !== 'explicit-code-refs' ||
      value.visibility !== 'private-local' ||
      typeof value.intentId !== 'string' ||
      !/^tnca_[a-f0-9]{32}$/u.test(value.intentId) ||
      typeof value.memoryId !== 'string' ||
      value.memoryId.length === 0 ||
      typeof value.memoryUri !== 'string' ||
      typeof value.expectedMemoryHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.expectedMemoryHash) ||
      typeof value.repositoryId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.repositoryId) ||
      typeof value.worktreeId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.worktreeId) ||
      typeof value.callerCwd !== 'string' ||
      typeof value.createdAt !== 'string' ||
      !isCanonicalIsoDate(value.createdAt) ||
      !Array.isArray(value.codeRefs) ||
      !value.codeRefs.every(ref => typeof ref === 'string') ||
      !isMemoryCodeCitationRecovery(value.recovery)
    ) {
      return undefined;
    }
    const codeRefs = normalizeMemoryCodeRefs(value.codeRefs);
    if (codeRefs.length !== value.codeRefs.length) return undefined;
    const project = value.project;
    if (project !== undefined && (typeof project !== 'string' || project.length === 0)) return undefined;
    const projectScope = parseMemoryCodeCitationProjectScopeReceipt(value.projectScope);
    if (
      (value.projectScope !== undefined && projectScope === undefined) ||
      (projectScope !== undefined &&
        !isDeferredCodeAnchorFullProjectScope(projectScope) &&
        project !== projectScope.project)
    )
      return undefined;
    return {
      ...value,
      codeRefs,
      ...(project === undefined ? {} : {project}),
      ...(projectScope === undefined ? {} : {projectScope}),
    } as unknown as DeferredCodeAnchorIntentV1;
  } catch {
    return undefined;
  }
}

const storedDeferredCodeAnchorIntentMatchesAddress = Effect.fn('memoryCodeAnchor.validateAddress')(function* (
  config: Pick<RuntimeConfig, 'account' | 'user'>,
  intent: DeferredCodeAnchorIntentV1,
  name: string,
) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(intent.callerCwd)) return false;
  const canonicalUri = yield* Effect.sync(() => {
    try {
      return canonicalPersonalMemoryUri(config, intent.memoryUri);
    } catch {
      return undefined;
    }
  });
  if (canonicalUri === undefined || canonicalUri !== intent.memoryUri) return false;
  const digest = yield* deferredCodeAnchorUriDigest(canonicalUri);
  const address = parseDeferredCodeAnchorIntentName(name);
  if (
    address === undefined ||
    !digest.startsWith(address.uriDigest) ||
    (address.intentId !== undefined && address.intentId !== intent.intentId)
  ) {
    return false;
  }
  if (address.kind === 'routed') {
    const repositoryRouteDigest = yield* deferredCodeAnchorRouteDigest(config, {
      callerCwd: intent.callerCwd,
      kind: 'repository',
      repositoryId: intent.repositoryId,
      worktreeId: intent.worktreeId,
    });
    const worksetRouteDigest =
      intent.recovery.preparation.target === 'workset'
        ? yield* deferredCodeAnchorRouteDigest(config, {
            kind: 'workset',
            name: intent.recovery.preparation.arguments[0],
          })
        : undefined;
    const refsBloom = yield* deferredCodeAnchorRefsBloom(intent.codeRefs);
    if (
      address.repositoryRouteDigest === undefined ||
      !repositoryRouteDigest.startsWith(address.repositoryRouteDigest) ||
      (address.worksetRouteDigest === undefined
        ? worksetRouteDigest !== undefined
        : worksetRouteDigest === undefined || !worksetRouteDigest.startsWith(address.worksetRouteDigest)) ||
      address.qualified !== intent.codeRefs.some(ref => DEFERRED_CODE_ANCHOR_QUALIFIED_REF.test(ref)) ||
      (address.refsBloom !== undefined && address.refsBloom !== refsBloom)
    ) {
      return false;
    }
  } else if (
    address.kind === 'sharded' &&
    address.refsBloom !== (yield* deferredCodeAnchorRefsBloom(intent.codeRefs))
  ) {
    return false;
  }
  return (
    (yield* deferredCodeAnchorIntentId({
      callerCwd: intent.callerCwd,
      codeRefs: intent.codeRefs,
      expectedMemoryHash: intent.expectedMemoryHash,
      memoryId: intent.memoryId,
      memoryUri: intent.memoryUri,
      ...(intent.project === undefined ? {} : {project: intent.project}),
      ...(intent.projectScope === undefined ? {} : {projectScope: intent.projectScope}),
      repositoryId: intent.repositoryId,
      recovery: intent.recovery,
      worktreeId: intent.worktreeId,
    })) === intent.intentId
  );
});

function isMemoryCodeCitationRecovery(value: unknown): value is MemoryCodeCitationCaptureRecoveryV1 {
  if (!Predicate.isObject(value) || value.type !== 'memory-code-citation-capture-recovery' || value.version !== 1)
    return false;
  if (
    !hasExactKeys(value, [
      'code',
      'indexingStarted',
      'observedGraph',
      'preparation',
      'recovery',
      'retryCondition',
      'retryable',
      'type',
      'version',
    ]) ||
    (value.code !== 'exact-current-evidence-unavailable' && value.code !== 'ready-graph-unavailable') ||
    value.indexingStarted !== false ||
    value.recovery !== 'prepare-current-graph' ||
    value.retryCondition !== 'after-current-graph-ready' ||
    value.retryable !== true ||
    !Predicate.isObject(value.observedGraph) ||
    !Predicate.isObject(value.preparation)
  ) {
    return false;
  }
  if (
    !hasExactKeys(value.observedGraph, ['freshness', 'readySnapshot', 'stale']) ||
    !['current', 'deferred', 'stale'].includes(String(value.observedGraph.freshness)) ||
    !['absent', 'available'].includes(String(value.observedGraph.readySnapshot)) ||
    typeof value.observedGraph.stale !== 'boolean'
  ) {
    return false;
  }
  if (value.preparation.target === 'callerCwd') {
    return (
      hasExactKeys(value.preparation, ['action', 'arguments', 'command', 'target']) &&
      value.preparation.action === 'index-current-graph' &&
      value.preparation.command === 'threadnote graph index --no-vectors' &&
      Array.isArray(value.preparation.arguments) &&
      value.preparation.arguments.length === 0
    );
  }
  return (
    value.preparation.target === 'workset' &&
    hasExactKeys(value.preparation, ['action', 'arguments', 'command', 'target']) &&
    value.preparation.action === 'prepare-workset' &&
    value.preparation.command === 'threadnote workset prepare' &&
    Array.isArray(value.preparation.arguments) &&
    value.preparation.arguments.length === 1 &&
    typeof value.preparation.arguments[0] === 'string' &&
    value.preparation.arguments[0].length > 0
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const deferredCodeAnchorIntentPaths = Effect.fn('memoryCodeAnchor.intentPaths')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
  memoryUri: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* existingPrivateDeferredCodeAnchorRoot(config);
  if (root === undefined) return [] as string[];
  const digest = yield* deferredCodeAnchorUriDigest(memoryUri);
  const legacy = ((yield* readPrivateDeferredCodeAnchorDirectory(fs, root, [root])) ?? [])
    .filter(name => isDeferredCodeAnchorIntentNameForDigest(name, digest))
    .map(name => path.join(root, name));
  const itemAncestors = deferredCodeAnchorItemAncestors(path, root, digest);
  const itemRoot = itemAncestors[1];
  const itemRootNames = yield* readPrivateDeferredCodeAnchorDirectory(fs, itemRoot, [root, itemRoot]);
  const itemDirectory = itemAncestors[itemAncestors.length - 1];
  const sharded =
    itemRootNames === undefined
      ? []
      : ((yield* readPrivateDeferredCodeAnchorDirectory(fs, itemDirectory, itemAncestors)) ?? []);
  return [
    ...legacy,
    ...sharded
      .filter(name => isDeferredCodeAnchorIntentNameForDigest(name, digest))
      .map(name => path.join(itemDirectory, name)),
  ];
});

function deferredCodeAnchorUriDigest(memoryUri: string) {
  return sha256Hex(parseResourceId(memoryUri).canonicalUri);
}

interface DeferredCodeAnchorIntentNameAddress {
  readonly intentId?: string;
  readonly kind: 'legacy' | 'routed' | 'sharded';
  readonly qualified: boolean;
  readonly refsBloom?: string;
  readonly repositoryRouteDigest?: string;
  readonly uriDigest: string;
  readonly worksetRouteDigest?: string;
}

const deferredCodeAnchorShardedIntentName = Effect.fn('memoryCodeAnchor.shardedIntentName')(function* (
  intent: DeferredCodeAnchorIntentV1,
) {
  const uriDigest = yield* deferredCodeAnchorUriDigest(intent.memoryUri);
  const refsBloom = yield* deferredCodeAnchorRefsBloom(intent.codeRefs);
  return `${uriDigest.slice(0, DEFERRED_CODE_ANCHOR_URI_ADDRESS_HEX_LENGTH)}-${intent.intentId}-b${refsBloom}.json`;
});

const deferredCodeAnchorRefsBloom = Effect.fn('memoryCodeAnchor.refsBloom')(function* (refs: readonly string[]) {
  const digests = yield* Effect.forEach(refs, ref => sha256Hex(ref), {concurrency: 4});
  const bits = Array.from({length: DEFERRED_CODE_ANCHOR_REFS_BLOOM_BYTES * 8}, () => false);
  for (const digest of digests) {
    for (const position of deferredCodeAnchorBloomPositions(digest)) bits[position] = true;
  }
  let encoded = '';
  for (let offset = 0; offset < bits.length; offset += 4) {
    let value = 0;
    for (let index = 0; index < 4; index += 1) value = value * 2 + (bits[offset + index] ? 1 : 0);
    encoded += value.toString(16);
  }
  return encoded;
});

function deferredCodeAnchorBloomPositions(digest: string): readonly number[] {
  const bitCount = DEFERRED_CODE_ANCHOR_REFS_BLOOM_BYTES * 8;
  return Array.from(
    {length: DEFERRED_CODE_ANCHOR_REFS_BLOOM_HASH_COUNT},
    (_, index) => Number.parseInt(digest.slice(index * 8, index * 8 + 8), 16) % bitCount,
  );
}

function parseDeferredCodeAnchorIntentName(name: string): DeferredCodeAnchorIntentNameAddress | undefined {
  const legacy = /^([a-f0-9]{64})(?:-(tnca_[a-f0-9]+))?\.json$/u.exec(name);
  if (legacy) {
    return {
      intentId: legacy[2],
      kind: 'legacy',
      qualified: false,
      uriDigest: legacy[1],
    };
  }
  const sharded = /^([a-f0-9]{32})-(tnca_[a-f0-9]{32})-b([a-f0-9]{32})\.json$/u.exec(name);
  if (sharded) {
    return {
      intentId: sharded[2],
      kind: 'sharded',
      qualified: false,
      refsBloom: sharded[3],
      uriDigest: sharded[1],
    };
  }
  const routed =
    /^((?:[a-f0-9]{32}|[a-f0-9]{64}))-(tnca_[a-f0-9]{32})-r((?:[a-f0-9]{8}|[a-f0-9]{12}|[a-f0-9]{32}))(?:-w((?:[a-f0-9]{8}|[a-f0-9]{12}|[a-f0-9]{32})))?(-q)?(?:-b([a-f0-9]{32}))?\.json$/u.exec(
      name,
    );
  if (!routed) return undefined;
  return {
    intentId: routed[2],
    kind: 'routed',
    qualified: routed[5] !== undefined,
    refsBloom: routed[6],
    repositoryRouteDigest: routed[3],
    uriDigest: routed[1],
    worksetRouteDigest: routed[4],
  };
}

/** Public filename-shape classifier for bounded diagnostics and dogfood evidence. */
export function isDeferredCodeAnchorIntentFilename(name: string): boolean {
  return parseDeferredCodeAnchorIntentName(name) !== undefined;
}

function deferredCodeAnchorIntentIdFromName(name: string): string | undefined {
  return parseDeferredCodeAnchorIntentName(name)?.intentId;
}

function deferredCodeAnchorUriDigestFromName(name: string): string | undefined {
  return (
    parseDeferredCodeAnchorIntentName(name)?.uriDigest ?? /^([a-f0-9]{64}|[a-f0-9]{32})(?:-|\.json$)/u.exec(name)?.[1]
  );
}

function isDeferredCodeAnchorIntentNameForDigest(name: string, digest: string): boolean {
  const addressedDigest = parseDeferredCodeAnchorIntentName(name)?.uriDigest;
  return (
    (addressedDigest !== undefined && digest.startsWith(addressedDigest)) ||
    ((name.startsWith(`${digest}-tnca_`) ||
      name.startsWith(`${digest.slice(0, DEFERRED_CODE_ANCHOR_URI_ADDRESS_HEX_LENGTH)}-tnca_`)) &&
      name.endsWith('.json'))
  );
}

const deferredCodeAnchorRoot = Effect.fn('memoryCodeAnchor.root')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const path = yield* Path.Path;
  const account = validatePortableSegment(config.account, config.account);
  return path.join(
    config.agentContextHome,
    'data',
    account,
    'user',
    uriSegment(config.user),
    'private',
    'deferred-code-anchors',
    'v1',
  );
});

const ensurePrivateDeferredCodeAnchorRoot = Effect.fn('memoryCodeAnchor.ensurePrivateRoot')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* deferredCodeAnchorRoot(config);
  const before = yield* deferredCodeAnchorPathEntryKind(fs, root);
  if (before === 'symlink') {
    return yield* deferredCodeAnchorError('Deferred code-anchor outbox must not be a symbolic link.');
  }
  if (before !== 'missing' && before !== 'directory') {
    return yield* deferredCodeAnchorError('Deferred code-anchor outbox must be a private directory.');
  }
  if (before === 'missing') yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  if (!(yield* validatePrivateDeferredCodeAnchorDirectories(fs, [root]))) {
    return yield* deferredCodeAnchorError('Deferred code-anchor outbox must be a private directory.');
  }
  return root;
});

const existingPrivateDeferredCodeAnchorRoot = Effect.fn('memoryCodeAnchor.existingPrivateRoot')(function* (
  config: Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* deferredCodeAnchorRoot(config);
  if (Option.isSome(yield* fs.readLink(root).pipe(Effect.option))) {
    return yield* deferredCodeAnchorError('Deferred code-anchor outbox must not be a symbolic link.');
  }
  const info = yield* fs.stat(root).pipe(Effect.option);
  if (Option.isNone(info)) return undefined;
  if (info.value.type !== 'Directory' || !fileSystemModeIsPrivate(runtimePlatform, info.value.mode)) {
    return yield* deferredCodeAnchorError('Deferred code-anchor outbox must be a private directory.');
  }
  return root;
});

function canonicalPersonalMemoryUri(config: Pick<RuntimeConfig, 'user'>, memoryUri: string): string {
  const canonical = parseResourceId(memoryUri).canonicalUri;
  const personalPrefix = `threadnote://user/${uriSegment(config.user)}/memories/`;
  if (!canonical.startsWith(personalPrefix) || canonical.startsWith(`${personalPrefix}shared/`)) {
    throw deferredCodeAnchorError('Deferred code anchors require a personal canonical memory URI.');
  }
  return canonical;
}

function boundedFinalizeLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT) {
    throw deferredCodeAnchorError(
      `Deferred code-anchor finalization limit must be between 1 and ${MAX_DEFERRED_CODE_ANCHOR_FINALIZE_LIMIT}.`,
    );
  }
  return value;
}

function boundedRouteLockWaitTimeout(waitTimeoutMilliseconds: number | undefined): number {
  const value = waitTimeoutMilliseconds ?? 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DEFERRED_CODE_ANCHOR_ROUTE_LOCK_WAIT_MILLISECONDS) {
    throw deferredCodeAnchorError(
      `Deferred code-anchor route lock wait must be between 0 and ${MAX_DEFERRED_CODE_ANCHOR_ROUTE_LOCK_WAIT_MILLISECONDS} milliseconds.`,
    );
  }
  return value;
}

function boundedRoutePassTimeout(passTimeoutMilliseconds: number | undefined): number {
  const value = passTimeoutMilliseconds ?? DEFAULT_DEFERRED_CODE_ANCHOR_ROUTE_PASS_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DEFERRED_CODE_ANCHOR_ROUTE_PASS_TIMEOUT_MILLISECONDS) {
    throw deferredCodeAnchorError(
      `Deferred code-anchor route pass timeout must be between 1 and ${MAX_DEFERRED_CODE_ANCHOR_ROUTE_PASS_TIMEOUT_MILLISECONDS} milliseconds.`,
    );
  }
  return value;
}

const deferredCodeAnchorRouteDigest = Effect.fn('memoryCodeAnchor.routeDigest')(function* (
  config: Pick<RuntimeConfig, 'account' | 'user'>,
  route: DeferredCodeAnchorFinalizationRoute,
) {
  if (route.kind === 'repository') {
    const path = yield* Path.Path;
    if (
      !path.isAbsolute(route.callerCwd) ||
      !/^[a-f0-9]{64}$/u.test(route.repositoryId) ||
      !/^[a-f0-9]{64}$/u.test(route.worktreeId)
    ) {
      return yield* deferredCodeAnchorError('Deferred code-anchor repository route is invalid.');
    }
  } else if (route.name.length === 0 || route.name.length > 256 || route.name.trim() !== route.name) {
    return yield* deferredCodeAnchorError('Deferred code-anchor workset route is invalid.');
  }
  return yield* sha256Hex(
    [
      'threadnote-deferred-code-anchor-route-v1',
      config.account,
      uriSegment(config.user),
      route.kind,
      ...(route.kind === 'repository' ? [route.repositoryId, route.worktreeId] : [route.name]),
    ].join('\n'),
  );
});

function safelyNormalizePreferredCodeRefs(refs: readonly string[]): readonly string[] {
  try {
    return normalizeMemoryCodeRefs(refs);
  } catch {
    // Preferred refs are only a scheduling hint. A malformed hint must not
    // suppress otherwise safe route healing.
    return [];
  }
}

function safelyNotifyDeferredCodeAnchorUri(notify: (uri: string) => void, uri: string): void {
  try {
    notify(uri);
  } catch {
    // Notifications are scheduling hints only. A caller callback must never
    // change finalization, cleanup, or route-rotation authority.
  }
}

function deferredCodeAnchorRouteReceipt(
  state: DeferredCodeAnchorRouteFinalizationReceiptV1['state'],
  matchedCount = 0,
  items: readonly DeferredCodeAnchorFinalizeItemV1[] = [],
): DeferredCodeAnchorRouteFinalizationReceiptV1 {
  return {
    conflictCount: items.filter(item => item.state === 'conflict').length,
    failedCount: items.filter(item => item.state === 'failed').length,
    finalizedCount: items.filter(item => item.state === 'finalized').length,
    matchedCount,
    pendingCount: items.filter(item => item.state === 'pending').length,
    scannedCount: items.length,
    state,
    type: 'threadnote-deferred-code-anchor-route-finalization',
    version: DEFERRED_CODE_ANCHOR_ROUTE_FINALIZATION_VERSION,
  };
}

function commonCitationSourceCommit(citations: readonly MemoryCodeCitationV1[]): string | undefined {
  const commits = new Set(citations.map(citation => citation.sourceCommit));
  return commits.size === 1 ? citations[0]?.sourceCommit : undefined;
}

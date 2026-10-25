import {Clock, Crypto, Effect, FileSystem, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {readModelSelection} from '@threadnote/inference/models/selection';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {CodeGraphStore} from '../store.js';
import {
  codeGraphEmbeddingWorkerLockPath,
  codeGraphEmbeddingWorkerReceiptPath,
  codeGraphLayout,
  type CodeGraphLayout,
} from '../layout.js';
import {withCodeGraphDatabaseWriteLock} from '../maintenance/gate.js';
import {executeCodeGraphVectorGeneration, type CodeGraphEmbeddingStatus} from '../embedding.js';
import {captureCodeGraphVectorPublication} from './publication.js';
import {makeCodeGraphVectorRetirementCapacityProtector} from './retirement.js';
import {inspectVectorPageStorageSql} from './retirement/inspection.js';
import {CODE_GRAPH_EMBEDDING_WORKER_PROTOCOL_VERSION} from '../worker_protocol.js';
import {
  blockUnclaimedCodeGraphEmbeddingDemand,
  CODE_GRAPH_EMBEDDING_DEMAND_WRITE_BOUNDARY,
  claimCodeGraphEmbeddingDemand,
  validateCodeGraphEmbeddingDemandClaim,
  acknowledgeCodeGraphEmbeddingDemand,
  readCodeGraphEmbeddingDemandPage,
  type CodeGraphEmbeddingDemandLane,
  type CodeGraphEmbeddingDemandOwner,
  type CodeGraphEmbeddingDemandAcknowledgement,
} from './demand.js';

export class CodeGraphEmbeddingWorkerSuperseded extends Schema.TaggedError<CodeGraphEmbeddingWorkerSuperseded>()(
  'CodeGraphEmbeddingWorkerSuperseded',
  {message: Schema.String},
) {}
class CodeGraphEmbeddingWorkerModelInvalidated extends Schema.TaggedError<CodeGraphEmbeddingWorkerModelInvalidated>()(
  'CodeGraphEmbeddingWorkerModelInvalidated',
  {message: Schema.String},
) {}
export interface CodeGraphEmbeddingWorkerCatalogPage {
  readonly checkoutIds: readonly string[];
  readonly after?: string;
}
export interface CodeGraphEmbeddingWorkerOutcome {
  readonly state: 'ready' | 'checkpointed' | 'deferred' | 'unavailable' | 'blocked';
  readonly reason?: string;
}
export interface CodeGraphEmbeddingWorkerOptions {
  readonly version: string;
  /** Enumerates existing graph catalogs only. It must never create demand or index. */
  readonly catalogPage: (after?: string) => Effect.Effect<CodeGraphEmbeddingWorkerCatalogPage, unknown>;
  readonly idleGraceMilliseconds?: number;
  readonly pollMilliseconds?: number;
  readonly onReady?: Effect.Effect<void, unknown>;
  readonly afterAttachment?: Effect.Effect<void, unknown>;
  readonly onClaim?: Effect.Effect<void, unknown>;
  readonly afterCheckpoint?: Effect.Effect<void, unknown>;
  readonly onUnitResult?: (result: CodeGraphEmbeddingWorkerOutcome) => Effect.Effect<void, unknown>;
}

/** Generation and demand ownership must agree about retrying the same token. */
export function isCodeGraphEmbeddingWorkerContention(error: unknown): boolean {
  const tag = typeof error === 'object' && error !== null && '_tag' in error ? String(error._tag) : '';
  return (
    (typeof error === 'object' && error !== null && 'recovery' in error && error.recovery === 'defer') ||
    isFileLockTimeout(error) ||
    tag === 'CodeGraphStoreBusyError' ||
    tag === 'CodeGraphMaintenanceActiveError'
  );
}

/** A single bounded lane turn; inference is outside every structural publication gate. */
const processCodeGraphEmbeddingWorkerUnit = Effect.fn('codeGraph.embeddingWorkerUnit')(function* (input: {
  readonly home: string;
  readonly layout: CodeGraphLayout;
  readonly lane: CodeGraphEmbeddingDemandLane;
  readonly owner: CodeGraphEmbeddingDemandOwner;
  readonly afterAttachment?: Effect.Effect<void, unknown>;
  readonly onClaim?: Effect.Effect<void, unknown>;
  readonly afterCheckpoint?: Effect.Effect<void, unknown>;
}) {
  const store = yield* CodeGraphStore;
  const catalog = yield* LocalModelCatalog;
  const modelStore = yield* LocalModelStore;
  const runtime = yield* LocalModelRuntime;
  const system = yield* SystemInfo;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const {home, layout, lane, owner} = input;
  const capacity = yield* makeCodeGraphVectorRetirementCapacityProtector({
    databasePath: layout.databasePath,
    threadnoteHome: home,
    claimMode: 'nonblocking-one-attempt',
  });
  const mutate = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.gen(function* () {
      const storage = yield* store.withSession(
        layout.databasePath,
        Effect.gen(function* () {
          return yield* inspectVectorPageStorageSql(yield* SqlClient.SqlClient);
        }),
        {readOnly: true},
      );
      return yield* capacity(
        CODE_GRAPH_EMBEDDING_DEMAND_WRITE_BOUNDARY,
        withCodeGraphDatabaseWriteLock(
          home,
          layout.checkoutId,
          store.withSession(
            layout.databasePath,
            Effect.gen(function* () {
              return yield* (yield* SqlClient.SqlClient).withTransaction(program);
            }),
            {existingOnly: true, writerGateHeld: true},
          ),
          0,
        ),
        storage,
      );
    });
  const manifest = yield* Effect.gen(function* () {
    const selection = yield* readModelSelection(home);
    return selection.roles.embedding ? yield* catalog.get(selection.roles.embedding) : undefined;
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (!manifest || manifest.role !== 'embedding' || !manifest.dimensions) {
    yield* mutate(
      Effect.gen(function* () {
        yield* blockUnclaimedCodeGraphEmbeddingDemand(yield* SqlClient.SqlClient, lane, {
          now: yield* Clock.currentTimeMillis,
          reason: 'model-unavailable',
        });
      }),
    );
    return {state: 'unavailable' as const};
  }
  const model = {id: manifest.id, sha256: manifest.sha256, dimensions: manifest.dimensions, templateVersion: 1};
  const now = yield* Clock.currentTimeMillis;
  let abandonedOwnerToken: string | undefined;
  if (
    lane.active &&
    (lane.active.owner.processId !== owner.processId ||
      lane.active.owner.processStartIdentity !== owner.processStartIdentity)
  ) {
    const previous = lane.active;
    const running = system.isProcessRunning(previous.owner.processId);
    const identity = running ? yield* system.processStartIdentity(previous.owner.processId) : undefined;
    if (!running || (identity !== undefined && identity !== previous.owner.processStartIdentity))
      abandonedOwnerToken = previous.owner.token;
  }
  let claim =
    lane.active?.owner.processId === owner.processId &&
    lane.active.owner.processStartIdentity === owner.processStartIdentity &&
    lane.active.expiresAt > now
      ? lane.active
      : undefined;
  if (
    claim &&
    (claim.model.id !== model.id || claim.model.sha256 !== model.sha256 || claim.model.dimensions !== model.dimensions)
  ) {
    abandonedOwnerToken = claim.owner.token;
    claim = undefined;
  }
  if (!claim)
    claim = yield* mutate(
      Effect.gen(function* () {
        return yield* claimCodeGraphEmbeddingDemand(yield* SqlClient.SqlClient, {
          ...lane,
          abandonedOwnerToken,
          owner: {...owner, token: yield* crypto.randomUUIDv4()},
          model,
          now: yield* Clock.currentTimeMillis,
        });
      }),
    );
  if (!claim)
    return {
      state:
        lane.state === 'blocked' &&
        lane.model?.id === model.id &&
        lane.model.sha256 === model.sha256 &&
        lane.model.dimensions === model.dimensions &&
        lane.model.templateVersion === model.templateVersion
          ? ('blocked' as const)
          : ('deferred' as const),
    };
  const pinned = claim;
  yield* input.onClaim ?? Effect.void;
  const validateClaimInSession = Effect.gen(function* () {
    const valid = yield* validateCodeGraphEmbeddingDemandClaim(
      yield* SqlClient.SqlClient,
      pinned,
      yield* Clock.currentTimeMillis,
    );
    const current = (yield* readModelSelection(home)).roles.embedding;
    const currentManifest = current ? yield* catalog.get(current) : undefined;
    if (
      currentManifest?.id !== pinned.model.id ||
      currentManifest.sha256 !== pinned.model.sha256 ||
      currentManifest.dimensions !== pinned.model.dimensions
    )
      return yield* CodeGraphEmbeddingWorkerModelInvalidated.make({message: 'Embedding model selection changed.'});
    if (!valid)
      return yield* CodeGraphEmbeddingWorkerSuperseded.make({message: 'Code graph embedding demand was superseded.'});
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
  const acknowledge = (ack: Omit<CodeGraphEmbeddingDemandAcknowledgement, 'now'>) =>
    mutate(
      Effect.gen(function* () {
        return yield* acknowledgeCodeGraphEmbeddingDemand(yield* SqlClient.SqlClient, pinned, {
          ...ack,
          now: yield* Clock.currentTimeMillis,
        });
      }),
    );
  const execute = Effect.gen(function* () {
    const snapshot = yield* store.readySnapshotById(layout.databasePath, pinned.snapshotId);
    if (!snapshot)
      return yield* CodeGraphEmbeddingWorkerSuperseded.make({message: 'Code graph embedding snapshot is unavailable.'});
    const publication = yield* captureCodeGraphVectorPublication({
      store,
      layout,
      threadnoteHome: home,
      snapshot,
      background: true,
      validateClaimInSession,
    });
    const read = <A, E>(program: Effect.Effect<A, E>) =>
      Effect.acquireUseRelease(
        store.acquireSnapshotLease(layout.databasePath, snapshot.id, 120_000, {waitTimeoutMilliseconds: 0}),
        () => publication.validate.pipe(Effect.andThen(program)),
        token =>
          store.releaseSnapshotLease(layout.databasePath, token, {waitTimeoutMilliseconds: 0}).pipe(Effect.ignore),
      );
    const result: CodeGraphEmbeddingStatus = yield* Effect.acquireUseRelease(
      store.acquireSnapshotLease(layout.databasePath, snapshot.id, 180_000, {waitTimeoutMilliseconds: 0}),
      () =>
        executeCodeGraphVectorGeneration({
          catalog,
          modelStore,
          runtime,
          fs,
          path,
          layout,
          snapshot,
          threadnoteHome: home,
          force: false,
          publication,
          abandonedOwnerToken,
          ownerToken: pinned.owner.token,
          retainPublicationClaimOnFailure: isCodeGraphEmbeddingWorkerContention,
          maximumSteps: 1,
          maximumInferenceSymbolsPerStep: 32,
          inferenceBatchSize: 32,
          embeddingContextPoolSize: 1,
          lockWaitTimeoutMilliseconds: 0,
          symbols: {
            count: read(store.countEmbeddingSymbols(layout.databasePath, snapshot.id)),
            loadPage: (cursor, limit) =>
              read(store.loadEmbeddingSymbolPage(layout.databasePath, snapshot.id, cursor, Math.min(400, limit))),
          },
        }),
      token => store.releaseSnapshotLease(layout.databasePath, token, {waitTimeoutMilliseconds: 0}).pipe(Effect.ignore),
    );
    if (result.ready) {
      yield* input.afterAttachment ?? Effect.void;
      yield* acknowledge({kind: 'finish'});
      return {state: 'ready' as const};
    }
    if (result.state === 'checkpointed') {
      yield* acknowledge({kind: 'checkpoint'});
      yield* input.afterCheckpoint ?? Effect.void;
      return {state: 'checkpointed' as const};
    }
    yield* acknowledge({
      kind: result.state === 'deferred' ? 'defer' : 'failure',
      retainClaim: result.state === 'deferred',
      reason: result.reason,
      blocked: result.state !== 'deferred',
      retryAfterMilliseconds: 1000,
    });
    return {state: result.state === 'deferred' ? ('deferred' as const) : ('blocked' as const)};
  });
  return yield* execute.pipe(
    Effect.catch(error => {
      const tag = typeof error === 'object' && error !== null && '_tag' in error ? String(error._tag) : '';
      const superseded = tag === 'CodeGraphEmbeddingWorkerSuperseded' || tag === 'CodeGraphVectorPublicationSuperseded';
      const modelInvalidated = tag === 'CodeGraphEmbeddingWorkerModelInvalidated';
      const contention = isCodeGraphEmbeddingWorkerContention(error);
      return Effect.gen(function* () {
        const publicationModelChanged =
          tag === 'CodeGraphVectorPublicationSuperseded'
            ? yield* Effect.gen(function* () {
                const selectedId = (yield* readModelSelection(home)).roles.embedding;
                if (!selectedId) return true;
                const selected = yield* catalog.get(selectedId);
                return (
                  selected.id !== pinned.model.id ||
                  selected.sha256 !== pinned.model.sha256 ||
                  selected.dimensions !== pinned.model.dimensions
                );
              }).pipe(Effect.orElseSucceed(() => false))
            : false;
        const rebind = modelInvalidated || publicationModelChanged;
        return yield* acknowledge({
          kind: rebind ? 'rebind' : superseded ? 'superseded' : contention ? 'defer' : 'failure',
          retainClaim: contention,
          reason: rebind
            ? 'model-changed'
            : superseded
              ? 'superseded'
              : contention
                ? 'contention'
                : 'Embedding failed; inspect model installation and graph capacity, then retry.',
          blocked: !contention && /DiskCapacity|ModelNotInstalled/.test(tag),
          retryAfterMilliseconds: contention ? 1000 : undefined,
        }).pipe(
          Effect.map(lane => ({state: lane?.state === 'blocked' ? ('blocked' as const) : ('deferred' as const)})),
        );
      });
    }),
  );
});

function expectedWorkerFailure(error: unknown) {
  const tag = typeof error === 'object' && error !== null && '_tag' in error ? String(error._tag) : '';
  return (
    isFileLockTimeout(error) ||
    tag.startsWith('CodeGraphStore') ||
    tag.startsWith('CodeGraphDiskCapacity') ||
    tag === 'CodeGraphMaintenanceActiveError'
  );
}

/** Admission can deny even the status write; preserve recorded demand and report a read-only outcome. */
export const runCodeGraphEmbeddingWorkerUnit = (input: Parameters<typeof processCodeGraphEmbeddingWorkerUnit>[0]) =>
  processCodeGraphEmbeddingWorkerUnit(input).pipe(
    Effect.catchIf(expectedWorkerFailure, error => {
      const recovery = typeof error === 'object' && error !== null && 'recovery' in error ? error.recovery : undefined;
      const contention = isFileLockTimeout(error) || recovery === 'defer' || recovery === 'retry';
      return Effect.succeed({
        state: contention ? ('deferred' as const) : ('blocked' as const),
        reason: contention
          ? 'contention'
          : 'capacity-or-catalog-unavailable; recover storage or schema support, then wake recorded demand',
      });
    }),
  );

/** Home lock also bounds all background inference to one batch. No cold indexing or demand creation. */
export const runCodeGraphEmbeddingWorker = Effect.fn('codeGraph.embeddingWorker')(function* (
  home: string,
  options: CodeGraphEmbeddingWorkerOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const crypto = yield* Crypto.Crypto;
  const store = yield* CodeGraphStore;
  const canonicalHome = yield* fs.realPath(home);
  const owner = {
    token: yield* crypto.randomUUIDv4(),
    processId: system.processId,
    processStartIdentity: (yield* system.processStartIdentity(system.processId)) ?? '',
  };
  if (!owner.processStartIdentity)
    return yield* CodeGraphEmbeddingWorkerSuperseded.make({message: 'Cannot identify embedding worker process.'});
  const receiptPath = codeGraphEmbeddingWorkerReceiptPath(path, canonicalHome);
  return yield* withExclusiveFileLock(
    fs,
    codeGraphEmbeddingWorkerLockPath(path, canonicalHome),
    {
      retryIntervalMilliseconds: 1,
      staleAfterMilliseconds: 120_000,
      waitTimeoutMilliseconds: 0,
    },
    Effect.gen(function* () {
      const receipt = JSON.stringify({
        ...owner,
        protocol: CODE_GRAPH_EMBEDDING_WORKER_PROTOCOL_VERSION,
        version: options.version,
      });
      yield* fs.remove(receiptPath, {force: true});
      yield* fs.writeFileString(receiptPath, receipt, {mode: 0o600, flag: 'wx'});
      yield* options.onReady ?? Effect.void;
      let idleSince = yield* Clock.currentTimeMillis;
      do {
        let catalogAfter: string | undefined;
        let runnable = false;
        do {
          const page = yield* options.catalogPage(catalogAfter);
          if (page.checkoutIds.length > 64)
            return yield* CodeGraphEmbeddingWorkerSuperseded.make({message: 'Embedding catalog page exceeds bound.'});
          for (const checkoutId of page.checkoutIds) {
            let after: {worktreeId: string; scopeId: string} | undefined;
            do {
              const catalogLayout = codeGraphLayout(path, canonicalHome, checkoutId, '0'.repeat(64));
              if (!(yield* fs.exists(catalogLayout.databasePath))) break;
              const lanes = yield* store
                .withSession(
                  catalogLayout.databasePath,
                  Effect.gen(function* () {
                    return yield* readCodeGraphEmbeddingDemandPage(yield* SqlClient.SqlClient, {after, limit: 64});
                  }),
                  {readOnly: true},
                )
                .pipe(Effect.catchIf(expectedWorkerFailure, () => Effect.succeed([])));
              for (const lane of lanes) {
                after = lane;
                if (lane.state === 'ready' || lane.state === 'cancelled') continue;
                if (lane.notBefore > (yield* Clock.currentTimeMillis)) {
                  if (lane.state !== 'blocked') runnable = true;
                  continue;
                }
                const result = yield* runCodeGraphEmbeddingWorkerUnit({
                  home: canonicalHome,
                  layout: codeGraphLayout(path, canonicalHome, checkoutId, lane.worktreeId, lane.scopeId),
                  lane,
                  owner,
                  afterAttachment: options.afterAttachment,
                  onClaim: options.onClaim,
                  afterCheckpoint: options.afterCheckpoint,
                });
                yield* options.onUnitResult?.(result) ?? Effect.void;
                if (result.state === 'checkpointed' || result.state === 'deferred') runnable = true;
              }
              if (lanes.length < 64) break;
            } while (true);
          }
          catalogAfter = page.after;
        } while (catalogAfter !== undefined);
        const now = yield* Clock.currentTimeMillis;
        if (runnable) idleSince = now;
        if (now - idleSince >= (options.idleGraceMilliseconds ?? 2000)) break;
        yield* Effect.sleep(options.pollMilliseconds ?? 1000);
      } while (true);
    }).pipe(
      Effect.ensuring(
        fs.readFileString(receiptPath).pipe(
          Effect.flatMap(content =>
            content.includes(owner.token) ? fs.remove(receiptPath, {force: true}) : Effect.void,
          ),
          Effect.ignore,
        ),
      ),
    ),
  ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.void));
});

import {Array as EffectArray} from 'effect';
import {Clock, Effect, FileSystem, Option, Path} from 'effect';
import {syncWritableFile} from '@threadnote/platform/file/durability';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {readVerifiedCasBlobBounded} from '../cas.js';
import {readBoundedPrivateBytes, writePrivateBytesFile, writePrivateJsonFile} from '../atomic.js';
import {sha256Digest, SHA256_DIGEST, SHA256_HEX, sha256HexFromDigest} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {graphSharingLayout} from '../layout.js';
import {
  listGraphShareSignedCandidatePageIds,
  parseGraphShareSignedCandidateQueue,
  readGraphShareSignedCandidatePage,
  type GraphShareSignedCandidateV2,
} from '../signed/candidate.js';
import {verifyGraphWorkerResultAnnouncement, type GraphWorkerResultAnnouncement} from './announcement.js';
import {
  verifyGraphWorkerResultIntegrity,
  type createGraphWorkerResultArtifact,
  type GraphWorkerResultAuthority,
} from './result.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

/** Quotas apply to one exact contributor authority scope. Revoked scopes remain private and inert. */
export const GRAPH_WORKER_OUTBOX_MAX_OPERATIONS = 128;
export const GRAPH_WORKER_OUTBOX_MAX_METADATA_BYTES = 1_048_576;
export const GRAPH_WORKER_OUTBOX_MAX_BLOBS = 384;
export const GRAPH_WORKER_OUTBOX_MAX_BLOB_BYTES = 128 * 1_048_576;
const MAX_PRINCIPAL_SCOPES = 128;
const MAX_PRINCIPAL_INDEX_BYTES = 65_536;
const MAX_RESULT_BYTES = 32 * 1_048_576;
const PAGE_ID = /^[0-9a-f]{64}$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ORG = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const LOCK = {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 30_000, waitTimeoutMilliseconds: 30_000};
const TEMPORARY = /^(?:outbox\.json|[0-9a-f]{64})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
const MAX_RECOVERY_ENTRIES = 4_096;
const EMPTY: GraphWorkerDeliveryOutboxV1 = {operations: [], schemaVersion: 1};

/** The caller constructs this only from current trust, profile and worker enrollment. */
export interface GraphWorkerDeliveryScope {
  readonly organization: string;
  readonly principalId: string;
  readonly profileDigest: string;
  readonly repositoryId: string;
  readonly signingPublicKey: string;
  readonly workerId: string;
}

export function graphWorkerDeliveryScope(
  authority: GraphWorkerResultAuthority,
  organization: string,
): GraphWorkerDeliveryScope {
  return {
    organization,
    principalId: authority.principalId,
    profileDigest: authority.profileDigest,
    repositoryId: authority.repositoryId,
    signingPublicKey: authority.signingPublicKey,
    workerId: authority.workerId,
  };
}

export interface GraphWorkerDeliveryOutboxOperationV1 {
  readonly admissionStatus?: 'accepted' | 'duplicate' | 'quarantined' | 'stale-source';
  readonly announcement: GraphWorkerResultAnnouncement;
  readonly attestationDigest: string;
  readonly attestationSize: number;
  readonly authority: GraphWorkerResultAuthority;
  readonly candidate: GraphShareSignedCandidateV2;
  readonly candidateIdentity: string;
  readonly candidatePageId: string;
  readonly manifestDigest: string;
  readonly manifestSize: number;
  readonly operationId: string;
  readonly organization: string;
  readonly preparedAtMilliseconds: number;
  readonly resultDigest: string;
  readonly resultSize: number;
  readonly sourceCommit: string;
  readonly state: 'prepared' | 'admitted' | 'superseded';
}

export interface GraphWorkerDeliveryOutboxV1 {
  readonly operations: readonly GraphWorkerDeliveryOutboxOperationV1[];
  readonly schemaVersion: 1;
}

export interface GraphWorkerDeliveryReplay {
  readonly operation: GraphWorkerDeliveryOutboxOperationV1;
  readonly artifact: {
    readonly attestationBytes: Uint8Array;
    readonly manifestBytes: Uint8Array;
    readonly manifestDigest: string;
    readonly resultBytes: Uint8Array;
  };
}

type Artifact = Effect.Success<ReturnType<typeof createGraphWorkerResultArtifact>>;

/**
 * The exact signed closure is written before metadata refers to it. A process crash before the
 * metadata rename leaves only quota-counted orphan blobs; the source candidate remains queued.
 */
export const prepareGraphWorkerDeliveryOutbox = Effect.fn('codeGraph.sharing.prepareWorkerDeliveryOutbox')(
  function* (input: {
    readonly announcement: GraphWorkerResultAnnouncement;
    readonly artifact: Artifact;
    readonly authority: GraphWorkerResultAuthority;
    readonly candidate: GraphShareSignedCandidateV2;
    readonly candidatePageId: string;
    readonly repositoryId: string;
    readonly threadnoteHome: string;
  }) {
    if (!SHA256_HEX.test(input.repositoryId) || !PAGE_ID.test(input.candidatePageId)) return yield* invalid();
    const candidate = yield* Effect.try({
      try: () => parseCandidate(input.candidate),
      catch: () => invalid(),
    });
    const authority = {...input.authority};
    const artifact = copyArtifact(input.artifact);
    const announcement = yield* Effect.try({
      try: () => structuredClone(input.announcement),
      catch: () => invalid(),
    });
    const verified = yield* verifyGraphWorkerResultIntegrity({...artifact, expected: authority});
    const body = yield* verifyGraphWorkerResultAnnouncement(announcement, authority);
    const claims = verified.attestation.claims;
    if (
      candidate.sourceCommit !== claims.sourceCommit ||
      candidate.organization.length === 0 ||
      candidate.profileDigest !== claims.profileDigest ||
      candidate.actionKey !== claims.actionKey ||
      candidate.batchId !== claims.batchId ||
      candidate.graphAbi !== claims.graphAbi ||
      candidate.resultDigest !== claims.resultDigest ||
      candidate.resultSize !== claims.resultSize ||
      candidate.semanticDigest !== claims.semanticDigest ||
      candidate.partialCoverage !== claims.partialCoverage ||
      candidate.releaseIdentity !== claims.releaseIdentity ||
      canonicalJson(candidate.platform) !== canonicalJson(claims.platform) ||
      canonicalJson(candidate.resourceLimits) !== canonicalJson(claims.resourceLimits) ||
      input.repositoryId !== claims.repositoryId ||
      body.idempotencyKey !== announcement.body.idempotencyKey ||
      body.actionKey !== claims.actionKey ||
      body.attestationDigest !== verified.attestationDigest ||
      body.resultManifestDigest !== artifact.manifestDigest ||
      body.semanticDigest !== claims.semanticDigest ||
      body.batchId !== claims.batchId
    )
      return yield* invalid();
    const operation: GraphWorkerDeliveryOutboxOperationV1 = {
      announcement,
      attestationDigest: verified.attestationDigest,
      attestationSize: artifact.attestationBytes.byteLength,
      authority,
      candidate,
      candidateIdentity: exactCandidateIdentity(candidate),
      candidatePageId: input.candidatePageId,
      manifestDigest: artifact.manifestDigest,
      manifestSize: artifact.manifestBytes.byteLength,
      operationId: body.idempotencyKey,
      organization: candidate.organization,
      preparedAtMilliseconds: yield* Clock.currentTimeMillis,
      resultDigest: claims.resultDigest,
      resultSize: artifact.resultBytes.byteLength,
      sourceCommit: claims.sourceCommit,
      state: 'prepared',
    };
    if (!validOperation(operation)) return yield* invalid();
    const scope = graphWorkerDeliveryScope(authority, candidate.organization);
    return yield* withOutboxLock(
      input.threadnoteHome,
      scope,
      Effect.gen(function* () {
        yield* registerPrincipalScope(input.threadnoteHome, scope);
        const current = yield* readOutbox(input.threadnoteHome, scope);
        yield* recoverOutboxStorage(input.threadnoteHome, scope, current);
        const existing = Option.getOrUndefined(
          EffectArray.findFirst(current.operations, item => item.operationId === operation.operationId),
        );
        if (existing !== undefined) {
          if (immutableIdentity(existing) !== immutableIdentity(operation)) return yield* invalid();
          // If a power loss retained metadata but lost a referenced blob, the still-queued
          // original candidate can restore only the same cryptographically verified bytes.
          const required = [
            {bytes: artifact.resultBytes, digest: operation.resultDigest},
            {bytes: artifact.attestationBytes, digest: operation.attestationDigest},
            {bytes: artifact.manifestBytes, digest: operation.manifestDigest},
          ];
          yield* verifyOutboxCapacity(input.threadnoteHome, scope, required);
          for (const blob of required) yield* persistBlob(input.threadnoteHome, scope, blob.digest, blob.bytes);
          yield* readOperationArtifact(input.threadnoteHome, scope, existing);
          yield* syncExistingOutbox(input.threadnoteHome, scope);
          return {operation: existing, prepared: false, sourcePageId: input.candidatePageId};
        }
        if (current.operations.length >= GRAPH_WORKER_OUTBOX_MAX_OPERATIONS)
          return yield* graphSharingFailure('Graph worker delivery outbox operation quota is full.');
        const required = [
          {bytes: artifact.resultBytes, digest: operation.resultDigest},
          {bytes: artifact.attestationBytes, digest: operation.attestationDigest},
          {bytes: artifact.manifestBytes, digest: operation.manifestDigest},
        ];
        yield* verifyOutboxCapacity(input.threadnoteHome, scope, required);
        for (const blob of required) yield* persistBlob(input.threadnoteHome, scope, blob.digest, blob.bytes);
        yield* writeOutbox(input.threadnoteHome, scope, {
          operations: [...current.operations, operation],
          schemaVersion: 1,
        });
        return {operation, prepared: true, sourcePageId: input.candidatePageId};
      }),
    );
  },
);

/** Every replay verifies all stored content digests before exposing any network bytes. */
export const readGraphWorkerDeliveryOutbox = Effect.fn('codeGraph.sharing.readWorkerDeliveryOutbox')(function* (
  threadnoteHome: string,
  scope: GraphWorkerDeliveryScope,
) {
  if (!validScope(scope)) return yield* invalid();
  const current = yield* readOutbox(threadnoteHome, scope);
  const replay: GraphWorkerDeliveryReplay[] = [];
  for (const operation of current.operations) {
    const artifact = yield* readOperationArtifact(threadnoteHome, scope, operation);
    replay.push({operation, artifact});
  }
  return replay;
});

/** List bounded metadata without loading every potentially large result blob on each retry tick. */
export const listGraphWorkerDeliveryOutboxOperations = Effect.fn('codeGraph.sharing.listWorkerDeliveryOutbox')(
  function* (threadnoteHome: string, scope: GraphWorkerDeliveryScope) {
    if (!validScope(scope)) return yield* invalid();
    return (yield* readOutbox(threadnoteHome, scope)).operations;
  },
);

export const readGraphWorkerDeliveryOutboxOperation = Effect.fn('codeGraph.sharing.readWorkerDeliveryOperation')(
  function* (threadnoteHome: string, scope: GraphWorkerDeliveryScope, operationId: string) {
    if (!validScope(scope) || !SHA256_DIGEST.test(operationId)) return yield* invalid();
    const operation = Option.getOrUndefined(
      EffectArray.findFirst(
        (yield* readOutbox(threadnoteHome, scope)).operations,
        item => item.operationId === operationId,
      ),
    );
    if (operation === undefined) return undefined;
    return {
      operation,
      artifact: yield* readOperationArtifact(threadnoteHome, scope, operation),
    } satisfies GraphWorkerDeliveryReplay;
  },
);

/** Only the exact current principal and signing identity can locate prior worker generations. */
export const listGraphWorkerDeliveryPrincipalScopes = Effect.fn('codeGraph.sharing.listWorkerPrincipalScopes')(
  function* (threadnoteHome: string, current: GraphWorkerDeliveryScope) {
    if (!validScope(current)) return yield* invalid();
    const index = yield* readPrincipalIndex(threadnoteHome, current);
    const active: GraphWorkerDeliveryScope[] = [];
    for (const scope of index.scopes) {
      const hasWork = yield* withOutboxLock(
        threadnoteHome,
        scope,
        Effect.gen(function* () {
          const current = yield* readOutbox(threadnoteHome, scope);
          if (current.operations.length > 0) return true;
          // A crash can leave blobs after committing an empty outbox but before cleanup.
          // Recover under the scope lock before removing its last discoverable index entry.
          yield* recoverOutboxStorage(threadnoteHome, scope, current);
          yield* unregisterPrincipalScope(threadnoteHome, scope);
          return false;
        }),
      );
      if (hasWork) active.push(scope);
    }
    return EffectArray.some(active, scope => scope.workerId === current.workerId) ? active : [...active, current];
  },
);

/** Call only after an exact echoed admission or authenticated canonical stale-source response. */
export const markGraphWorkerDeliveryAdmitted = Effect.fn('codeGraph.sharing.markWorkerDeliveryAdmitted')(
  function* (input: {
    readonly scope: GraphWorkerDeliveryScope;
    readonly candidateIdentity: string;
    readonly candidatePageId: string;
    readonly operationId: string;
    readonly response: {
      readonly idempotencyKey: string;
      readonly status: 'accepted' | 'duplicate' | 'quarantined' | 'stale-source';
    };
    readonly threadnoteHome: string;
  }) {
    if (!validScope(input.scope) || !PAGE_ID.test(input.candidatePageId)) return yield* invalid();
    return yield* withOutboxLock(
      input.threadnoteHome,
      input.scope,
      Effect.gen(function* () {
        const current = yield* readOutbox(input.threadnoteHome, input.scope);
        const operation = Option.getOrUndefined(
          EffectArray.findFirst(current.operations, item => item.operationId === input.operationId),
        );
        if (
          operation === undefined ||
          operation.candidateIdentity !== input.candidateIdentity ||
          operation.candidatePageId !== input.candidatePageId ||
          input.response.idempotencyKey !== input.operationId ||
          !['accepted', 'duplicate', 'quarantined', 'stale-source'].includes(input.response.status)
        )
          return yield* invalid();
        yield* readOperationArtifact(input.threadnoteHome, input.scope, operation);
        if (operation.state !== 'prepared') {
          // A lost local response to our own metadata rename is safe to replay.
          if (operation.admissionStatus !== input.response.status) return yield* invalid();
          return operation;
        }
        const admitted = {
          ...operation,
          admissionStatus: input.response.status,
          state: input.response.status === 'stale-source' ? ('superseded' as const) : ('admitted' as const),
        };
        yield* writeOutbox(input.threadnoteHome, input.scope, {
          operations: EffectArray.map(current.operations, item =>
            item.operationId === input.operationId ? admitted : item,
          ),
          schemaVersion: 1,
        });
        return admitted;
      }),
    );
  },
);

/** `candidateAbsent` must come from the exact page's durable ACK result under its lock. */
export const retireGraphWorkerDeliveryOutbox = Effect.fn('codeGraph.sharing.retireWorkerDeliveryOutbox')(
  function* (input: {
    readonly scope: GraphWorkerDeliveryScope;
    readonly candidateAbsent: true;
    readonly candidateIdentity: string;
    readonly candidatePageId: string;
    readonly operationId: string;
    readonly threadnoteHome: string;
  }) {
    if (!validScope(input.scope) || !PAGE_ID.test(input.candidatePageId) || input.candidateAbsent !== true)
      return yield* invalid();
    return yield* withOutboxLock(
      input.threadnoteHome,
      input.scope,
      Effect.gen(function* () {
        const current = yield* readOutbox(input.threadnoteHome, input.scope);
        const operation = Option.getOrUndefined(
          EffectArray.findFirst(current.operations, item => item.operationId === input.operationId),
        );
        if (operation === undefined) return false;
        if (
          (operation.state !== 'admitted' && operation.state !== 'superseded') ||
          operation.candidateIdentity !== input.candidateIdentity ||
          operation.candidatePageId !== input.candidatePageId
        )
          return yield* invalid();
        const next = {
          operations: EffectArray.filter(current.operations, item => item.operationId !== input.operationId),
          schemaVersion: 1 as const,
        };
        yield* writeOutbox(input.threadnoteHome, input.scope, next);
        yield* recoverOutboxStorage(input.threadnoteHome, input.scope, next);
        if (next.operations.length === 0) yield* unregisterPrincipalScope(input.threadnoteHome, input.scope);
        return true;
      }),
    );
  },
);

/** A settled same-candidate result permits retirement of older, now unusable worker generations. */
export const retireSupersededGraphWorkerDeliveryOutbox = Effect.fn('codeGraph.sharing.retireSupersededWorkerOutbox')(
  function* (input: {
    readonly admittedOperationId: string;
    readonly admittedScope: GraphWorkerDeliveryScope;
    readonly candidateAbsent: true;
    readonly candidateIdentity: string;
    readonly oldScope: GraphWorkerDeliveryScope;
    readonly threadnoteHome: string;
  }) {
    if (
      !validScope(input.admittedScope) ||
      !validScope(input.oldScope) ||
      input.candidateAbsent !== true ||
      canonicalJson(principalIdentity(input.admittedScope)) !== canonicalJson(principalIdentity(input.oldScope))
    )
      return yield* invalid();
    const admitted = Option.getOrUndefined(
      EffectArray.findFirst(
        (yield* readOutbox(input.threadnoteHome, input.admittedScope)).operations,
        item => item.operationId === input.admittedOperationId,
      ),
    );
    if (
      (admitted?.state !== 'admitted' && admitted?.state !== 'superseded') ||
      admitted.candidateIdentity !== input.candidateIdentity
    )
      return yield* invalid();
    return yield* withOutboxLock(
      input.threadnoteHome,
      input.oldScope,
      Effect.gen(function* () {
        const current = yield* readOutbox(input.threadnoteHome, input.oldScope);
        const next = {
          schemaVersion: 1 as const,
          operations: EffectArray.filter(
            current.operations,
            item =>
              item.operationId === input.admittedOperationId || item.candidateIdentity !== input.candidateIdentity,
          ),
        };
        const retired = current.operations.length - next.operations.length;
        if (retired === 0) return 0;
        yield* writeOutbox(input.threadnoteHome, input.oldScope, next);
        yield* recoverOutboxStorage(input.threadnoteHome, input.oldScope, next);
        if (next.operations.length === 0) yield* unregisterPrincipalScope(input.threadnoteHome, input.oldScope);
        return retired;
      }),
    );
  },
);

/** An expired unsent signature is replaced only when its complete source candidate remains recoverable. */
export const retireExpiredPreparedGraphWorkerDeliveryOutbox = Effect.fn(
  'codeGraph.sharing.retireExpiredPreparedWorkerOutbox',
)(function* (input: {
  readonly operationId: string;
  readonly scope: GraphWorkerDeliveryScope;
  readonly threadnoteHome: string;
}) {
  if (!validScope(input.scope) || !SHA256_DIGEST.test(input.operationId)) return yield* invalid();
  return yield* withOutboxLock(
    input.threadnoteHome,
    input.scope,
    Effect.gen(function* () {
      const current = yield* readOutbox(input.threadnoteHome, input.scope);
      const operation = Option.getOrUndefined(
        EffectArray.findFirst(current.operations, item => item.operationId === input.operationId),
      );
      if (operation?.state !== 'prepared' || operation.authority.expiresAt > (yield* Clock.currentTimeMillis) / 1000)
        return false;
      const original = yield* readGraphShareSignedCandidatePage(
        input.threadnoteHome,
        input.scope.repositoryId,
        operation.candidatePageId,
      );
      let candidateDurable =
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(original?.candidates), __effectArrayReceiver =>
            EffectArray.some(
              __effectArrayReceiver,
              candidate => canonicalJson(candidate) === canonicalJson(operation.candidate),
            ),
          ),
        ) ?? false;
      if (!candidateDurable)
        for (const pageId of yield* listGraphShareSignedCandidatePageIds(
          input.threadnoteHome,
          input.scope.repositoryId,
        )) {
          const page = yield* readGraphShareSignedCandidatePage(input.threadnoteHome, input.scope.repositoryId, pageId);
          if (
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(page?.candidates), __effectArrayReceiver =>
                EffectArray.some(
                  __effectArrayReceiver,
                  candidate => canonicalJson(candidate) === canonicalJson(operation.candidate),
                ),
              ),
            )
          ) {
            candidateDurable = true;
            break;
          }
        }
      if (!candidateDurable) return false;
      const cas = yield* readVerifiedCasBlobBounded(
        operation.candidate.casRoot,
        operation.resultDigest,
        operation.resultSize,
      ).pipe(Effect.option);
      if (Option.isNone(cas) || cas.value.byteLength !== operation.resultSize) return false;
      const next = {
        schemaVersion: 1 as const,
        operations: EffectArray.filter(current.operations, item => item.operationId !== input.operationId),
      };
      yield* writeOutbox(input.threadnoteHome, input.scope, next);
      yield* recoverOutboxStorage(input.threadnoteHome, input.scope, next);
      if (next.operations.length === 0) yield* unregisterPrincipalScope(input.threadnoteHome, input.scope);
      return true;
    }),
  );
});

function parseCandidate(value: unknown): GraphShareSignedCandidateV2 {
  const parsed = parseGraphShareSignedCandidateQueue({candidates: [value], schemaVersion: 2});
  return structuredClone(parsed.candidates[0]);
}

function exactCandidateIdentity(value: GraphShareSignedCandidateV2): string {
  const pendingIdentity = JSON.stringify([
    value.actionKey,
    value.resultDigest,
    value.sourceCommit,
    value.semanticDigest,
    value.casRoot,
    value.profileDigest,
    value.organization,
    value.releaseIdentity,
  ]);
  return JSON.stringify([pendingIdentity, value.graphAbi, value.partialCoverage, value.snapshotId]);
}

function immutableIdentity(value: GraphWorkerDeliveryOutboxOperationV1): string {
  const {
    state: _state,
    admissionStatus: _admissionStatus,
    preparedAtMilliseconds: _at,
    candidatePageId: _sourcePage,
    ...immutable
  } = value;
  return canonicalJson(immutable);
}

function validOperation(value: unknown): value is GraphWorkerDeliveryOutboxOperationV1 {
  if (!isRecord(value)) return false;
  const allowed =
    'admissionStatus,announcement,attestationDigest,attestationSize,authority,candidate,candidateIdentity,candidatePageId,manifestDigest,manifestSize,operationId,organization,preparedAtMilliseconds,resultDigest,resultSize,sourceCommit,state';
  if (
    EffectArray.join(EffectRecord.keys(value).sort(), ',') !== allowed &&
    EffectArray.join(EffectRecord.keys(value).sort(), ',') !==
      Effect2.pipe(allowed, EffectString.replace('admissionStatus,', ''))
  )
    return false;
  try {
    const candidate = parseCandidate(value.candidate);
    const announcement = value.announcement;
    const authority = value.authority;
    return (
      validAnnouncement(announcement) &&
      isRecord(authority) &&
      EffectArray.join(EffectRecord.keys(authority).sort(), ',') ===
        'expiresAt,graphAbi,principalId,profileDigest,repositoryId,signingPublicKey,workerId' &&
      typeof value.candidateIdentity === 'string' &&
      value.candidateIdentity === exactCandidateIdentity(candidate) &&
      typeof value.candidatePageId === 'string' &&
      PAGE_ID.test(value.candidatePageId) &&
      typeof value.organization === 'string' &&
      ORG.test(value.organization) &&
      value.organization === candidate.organization &&
      typeof value.sourceCommit === 'string' &&
      COMMIT.test(value.sourceCommit) &&
      value.sourceCommit === candidate.sourceCommit &&
      typeof value.operationId === 'string' &&
      SHA256_DIGEST.test(value.operationId) &&
      value.operationId === announcement.body.idempotencyKey &&
      typeof value.resultDigest === 'string' &&
      SHA256_DIGEST.test(value.resultDigest) &&
      value.resultDigest === candidate.resultDigest &&
      typeof value.attestationDigest === 'string' &&
      SHA256_DIGEST.test(value.attestationDigest) &&
      value.attestationDigest === announcement.body.attestationDigest &&
      typeof value.manifestDigest === 'string' &&
      SHA256_DIGEST.test(value.manifestDigest) &&
      value.manifestDigest === announcement.body.resultManifestDigest &&
      validSize(value.resultSize, MAX_RESULT_BYTES) &&
      value.resultSize === candidate.resultSize &&
      validSize(value.attestationSize, 65_536) &&
      validSize(value.manifestSize, 8_192) &&
      typeof value.preparedAtMilliseconds === 'number' &&
      Number.isSafeInteger(value.preparedAtMilliseconds) &&
      value.preparedAtMilliseconds >= 0 &&
      (value.state === 'prepared' || value.state === 'admitted' || value.state === 'superseded') &&
      (value.state === 'prepared'
        ? value.admissionStatus === undefined
        : value.state === 'superseded'
          ? value.admissionStatus === 'stale-source'
          : ['accepted', 'duplicate', 'quarantined'].includes(String(value.admissionStatus))) &&
      announcement.publicKey === authority.signingPublicKey &&
      announcement.body.repositoryId === authority.repositoryId &&
      announcement.body.profileDigest === authority.profileDigest &&
      announcement.body.principalId === authority.principalId &&
      announcement.body.workerId === authority.workerId &&
      candidate.graphAbi === authority.graphAbi &&
      announcement.body.actionKey === candidate.actionKey &&
      announcement.body.semanticDigest === candidate.semanticDigest &&
      announcement.body.batchId === candidate.batchId &&
      announcement.body.profileDigest === candidate.profileDigest &&
      typeof authority.expiresAt === 'number' &&
      Number.isSafeInteger(authority.expiresAt) &&
      authority.expiresAt > 0 &&
      typeof authority.signingPublicKey === 'string' &&
      SHA256_HEX.test(authority.signingPublicKey) &&
      typeof authority.graphAbi === 'string' &&
      SHA256_HEX.test(authority.graphAbi) &&
      typeof authority.principalId === 'string' &&
      SHA256_DIGEST.test(authority.principalId) &&
      typeof authority.profileDigest === 'string' &&
      SHA256_DIGEST.test(authority.profileDigest) &&
      typeof authority.repositoryId === 'string' &&
      SHA256_HEX.test(authority.repositoryId) &&
      typeof authority.workerId === 'string' &&
      /^gw_[0-9a-f]{32}$/u.test(authority.workerId)
    );
  } catch {
    return false;
  }
}

function validAnnouncement(value: unknown): value is GraphWorkerResultAnnouncement {
  if (
    !isRecord(value) ||
    EffectArray.join(EffectRecord.keys(value).sort(), ',') !== 'algorithm,body,publicKey,schemaVersion,signature' ||
    value.algorithm !== 'ed25519' ||
    value.schemaVersion !== 1 ||
    typeof value.publicKey !== 'string' ||
    !SHA256_HEX.test(value.publicKey) ||
    typeof value.signature !== 'string' ||
    !/^[0-9a-f]{128}$/u.test(value.signature) ||
    !isRecord(value.body)
  )
    return false;
  const body = value.body;
  if (
    EffectArray.join(EffectRecord.keys(body).sort(), ',') !==
    'actionKey,attestationDigest,batchId,idempotencyKey,principalId,profileDigest,repositoryId,resultManifestDigest,semanticDigest,workerId'
  )
    return false;
  const {idempotencyKey, ...fields} = body;
  return (
    typeof body.actionKey === 'string' &&
    SHA256_HEX.test(body.actionKey) &&
    typeof body.attestationDigest === 'string' &&
    SHA256_DIGEST.test(body.attestationDigest) &&
    typeof body.batchId === 'string' &&
    /^[0-9a-f]{40}$/u.test(body.batchId) &&
    typeof body.principalId === 'string' &&
    SHA256_DIGEST.test(body.principalId) &&
    typeof body.profileDigest === 'string' &&
    SHA256_DIGEST.test(body.profileDigest) &&
    typeof body.repositoryId === 'string' &&
    SHA256_HEX.test(body.repositoryId) &&
    typeof body.resultManifestDigest === 'string' &&
    SHA256_DIGEST.test(body.resultManifestDigest) &&
    typeof body.semanticDigest === 'string' &&
    SHA256_DIGEST.test(body.semanticDigest) &&
    typeof body.workerId === 'string' &&
    /^gw_[0-9a-f]{32}$/u.test(body.workerId) &&
    typeof idempotencyKey === 'string' &&
    SHA256_DIGEST.test(idempotencyKey) &&
    idempotencyKey === sha256Digest('threadnote.graph.worker.result-operation.v1\0' + canonicalJson(fields))
  );
}

function validSize(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function parseOutbox(value: unknown): GraphWorkerDeliveryOutboxV1 {
  if (
    !isRecord(value) ||
    EffectArray.join(EffectRecord.keys(value).sort(), ',') !== 'operations,schemaVersion' ||
    value.schemaVersion !== 1 ||
    !EffectArray.isArray(value.operations) ||
    value.operations.length > GRAPH_WORKER_OUTBOX_MAX_OPERATIONS
  )
    throw graphSharingFailure('Graph worker delivery outbox metadata is invalid.');
  const operations = EffectArray.filter(value.operations, validOperation);
  if (operations.length !== value.operations.length)
    throw graphSharingFailure('Graph worker delivery outbox metadata is invalid.');
  if (new Set(EffectArray.map(operations, item => item.operationId)).size !== operations.length)
    throw graphSharingFailure('Graph worker delivery outbox contains duplicate operations.');
  return {operations, schemaVersion: 1};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function copyArtifact(input: Artifact): Artifact {
  return {
    attestationBytes: new Uint8Array(input.attestationBytes),
    manifestBytes: new Uint8Array(input.manifestBytes),
    manifestDigest: input.manifestDigest,
    resultBytes: new Uint8Array(input.resultBytes),
  };
}

function validScope(scope: unknown): scope is GraphWorkerDeliveryScope {
  return (
    isRecord(scope) &&
    EffectArray.join(EffectRecord.keys(scope).sort(), ',') ===
      'organization,principalId,profileDigest,repositoryId,signingPublicKey,workerId' &&
    typeof scope.organization === 'string' &&
    ORG.test(scope.organization) &&
    typeof scope.principalId === 'string' &&
    SHA256_DIGEST.test(scope.principalId) &&
    typeof scope.profileDigest === 'string' &&
    SHA256_DIGEST.test(scope.profileDigest) &&
    typeof scope.repositoryId === 'string' &&
    SHA256_HEX.test(scope.repositoryId) &&
    typeof scope.signingPublicKey === 'string' &&
    SHA256_HEX.test(scope.signingPublicKey) &&
    typeof scope.workerId === 'string' &&
    /^gw_[0-9a-f]{32}$/u.test(scope.workerId)
  );
}

function scopeMatches(operation: GraphWorkerDeliveryOutboxOperationV1, scope: GraphWorkerDeliveryScope): boolean {
  return canonicalJson(graphWorkerDeliveryScope(operation.authority, operation.organization)) === canonicalJson(scope);
}

function outboxPaths(path: Path.Path, home: string, scope: GraphWorkerDeliveryScope) {
  const scopeId = sha256HexFromDigest(sha256Digest(canonicalJson(scope)));
  const root = path.join(graphSharingLayout(path, home).root, 'worker-delivery', scope.repositoryId, scopeId);
  return {root, metadata: path.join(root, 'outbox.json'), blobs: path.join(root, 'sha256')};
}

function principalIdentity(scope: GraphWorkerDeliveryScope) {
  const {workerId: _workerId, ...principal} = scope;
  return principal;
}

function principalIndexPath(path: Path.Path, home: string, scope: GraphWorkerDeliveryScope): string {
  const digest = sha256HexFromDigest(sha256Digest(canonicalJson(principalIdentity(scope))));
  return path.join(
    graphSharingLayout(path, home).root,
    'worker-delivery',
    scope.repositoryId,
    'principals',
    `${digest}.json`,
  );
}

function readPrincipalIndex(home: string, scope: GraphWorkerDeliveryScope) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = principalIndexPath(path, home, scope);
    yield* secureDirectory(path.dirname(target), home);
    if (!(yield* fs.exists(target))) return {schemaVersion: 1 as const, scopes: [] as GraphWorkerDeliveryScope[]};
    const bytes = yield* readBoundedPrivateBytes(target, MAX_PRINCIPAL_INDEX_BYTES);
    const value = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown,
      catch: () => invalid(),
    });
    if (
      !isRecord(value) ||
      EffectArray.join(EffectRecord.keys(value).sort(), ',') !== 'schemaVersion,scopes' ||
      value.schemaVersion !== 1 ||
      !EffectArray.isArray(value.scopes) ||
      value.scopes.length > MAX_PRINCIPAL_SCOPES
    )
      return yield* invalid();
    const scopes = EffectArray.filter(value.scopes, validScope);
    if (
      scopes.length !== value.scopes.length ||
      EffectArray.some(
        scopes,
        item => canonicalJson(principalIdentity(item)) !== canonicalJson(principalIdentity(scope)),
      ) ||
      new Set(EffectArray.map(scopes, item => item.workerId)).size !== scopes.length
    )
      return yield* invalid();
    return {schemaVersion: 1 as const, scopes};
  });
}

function mutatePrincipalIndex(home: string, scope: GraphWorkerDeliveryScope, add: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = principalIndexPath(path, home, scope);
    yield* secureDirectory(path.dirname(target), home);
    yield* withExclusiveFileLock(
      fs,
      `${target}.lock`,
      LOCK,
      Effect.gen(function* () {
        const current = yield* readPrincipalIndex(home, scope);
        const scopes = EffectArray.filter(current.scopes, item => item.workerId !== scope.workerId);
        if (add) scopes.push(scope);
        if (scopes.length > MAX_PRINCIPAL_SCOPES)
          return yield* graphSharingFailure('Graph worker principal scope index is full.');
        if (
          scopes.length === current.scopes.length &&
          (add
            ? EffectArray.some(current.scopes, item => item.workerId === scope.workerId)
            : !EffectArray.some(current.scopes, item => item.workerId === scope.workerId))
        )
          return;
        yield* writePrivateJsonFile(target, {schemaVersion: 1, scopes});
        yield* syncWritableFile(fs, target);
        yield* syncDirectoryStrict(fs, path.dirname(target));
      }),
    );
  });
}

function registerPrincipalScope(home: string, scope: GraphWorkerDeliveryScope) {
  return mutatePrincipalIndex(home, scope, true);
}

function unregisterPrincipalScope(home: string, scope: GraphWorkerDeliveryScope) {
  return mutatePrincipalIndex(home, scope, false);
}

function blobPath(path: Path.Path, home: string, scope: GraphWorkerDeliveryScope, digest: string) {
  return path.join(outboxPaths(path, home, scope).blobs, sha256HexFromDigest(digest));
}

function syncDirectoryStrict(fs: FileSystem.FileSystem, directory: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(directory, {flag: 'r'});
      yield* handle.sync;
    }),
  );
}

function secureDirectory(directory: string, home: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Include parents: a symlink in the private outbox path must not redirect a bounded read or write.
    const parts: string[] = [];
    for (let current = directory; ; current = path.dirname(current)) {
      parts.push(current);
      if (current === path.resolve(home)) break;
      if (current === path.dirname(current)) return yield* invalid();
    }
    for (const part of parts.reverse()) {
      if (Option.isSome(yield* fs.readLink(part).pipe(Effect.option))) return yield* invalid();
      if (!(yield* fs.exists(part))) {
        yield* fs.makeDirectory(part, {mode: 0o700});
        yield* syncDirectoryStrict(fs, path.dirname(part));
      }
      const stat = yield* fs.stat(part);
      if (stat.type !== 'Directory') return yield* invalid();
      if (part !== path.resolve(home)) yield* fs.chmod(part, 0o700);
    }
  });
}

function withOutboxLock<A, E, R>(home: string, scope: GraphWorkerDeliveryScope, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = outboxPaths(path, home, scope);
    yield* secureDirectory(paths.root, home);
    return yield* withExclusiveFileLock(fs, `${paths.metadata}.lock`, LOCK, effect);
  });
}

function readOutbox(home: string, scope: GraphWorkerDeliveryScope) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = outboxPaths(path, home, scope).metadata;
    yield* secureDirectory(path.dirname(target), home);
    if (!(yield* fs.exists(target))) return EMPTY;
    const bytes = yield* readBoundedPrivateBytes(target, GRAPH_WORKER_OUTBOX_MAX_METADATA_BYTES);
    const parsed = yield* Effect.try({
      try: () => parseOutbox(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))),
      catch: () => graphSharingFailure('Graph worker delivery outbox metadata is invalid.'),
    });
    if (EffectArray.some(parsed.operations, operation => !scopeMatches(operation, scope))) return yield* invalid();
    return parsed;
  });
}

function writeOutbox(home: string, scope: GraphWorkerDeliveryScope, value: GraphWorkerDeliveryOutboxV1) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    if (
      !parseOutbox(value) ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength + 1 > GRAPH_WORKER_OUTBOX_MAX_METADATA_BYTES
    )
      return yield* graphSharingFailure('Graph worker delivery outbox metadata quota is full.');
    if (EffectArray.some(value.operations, operation => !scopeMatches(operation, scope))) return yield* invalid();
    const target = outboxPaths(path, home, scope).metadata;
    yield* writePrivateJsonFile(target, value);
    yield* syncExistingOutbox(home, scope);
  });
}

function syncExistingOutbox(home: string, scope: GraphWorkerDeliveryScope) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = outboxPaths(path, home, scope).metadata;
    yield* syncWritableFile(fs, target);
    yield* syncDirectoryStrict(fs, path.dirname(target));
  });
}

function readBlob(home: string, scope: GraphWorkerDeliveryScope, digest: string, maximum: number) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = blobPath(path, home, scope, digest);
    yield* secureDirectory(path.dirname(target), home);
    if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) return yield* invalid();
    const stat = yield* fs.stat(target);
    if (stat.type !== 'File' || Number(stat.size) > maximum) return yield* invalid();
    const bytes = yield* readBoundedPrivateBytes(target, maximum);
    if (sha256Digest(bytes) !== digest) return yield* invalid();
    return new Uint8Array(bytes);
  });
}

function readOperationArtifact(
  home: string,
  scope: GraphWorkerDeliveryScope,
  operation: GraphWorkerDeliveryOutboxOperationV1,
) {
  return Effect.gen(function* () {
    const [resultBytes, attestationBytes, manifestBytes] = yield* Effect.all([
      readBlob(home, scope, operation.resultDigest, operation.resultSize),
      readBlob(home, scope, operation.attestationDigest, operation.attestationSize),
      readBlob(home, scope, operation.manifestDigest, operation.manifestSize),
    ]);
    if (
      resultBytes.byteLength !== operation.resultSize ||
      attestationBytes.byteLength !== operation.attestationSize ||
      manifestBytes.byteLength !== operation.manifestSize
    )
      return yield* invalid();
    return {resultBytes, attestationBytes, manifestBytes, manifestDigest: operation.manifestDigest};
  });
}

function persistBlob(home: string, scope: GraphWorkerDeliveryScope, digest: string, bytes: Uint8Array) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = blobPath(path, home, scope, digest);
    if (sha256Digest(bytes) !== digest) return yield* invalid();
    yield* secureDirectory(path.dirname(target), home);
    if (yield* fs.exists(target)) {
      const existing = yield* readBlob(home, scope, digest, bytes.byteLength);
      if (existing.byteLength !== bytes.byteLength) return yield* invalid();
      yield* syncWritableFile(fs, target);
      yield* syncDirectoryStrict(fs, path.dirname(target));
      return;
    }
    yield* writePrivateBytesFile(target, bytes);
    yield* syncWritableFile(fs, target);
    yield* syncDirectoryStrict(fs, path.dirname(target));
    yield* readBlob(home, scope, digest, bytes.byteLength);
  });
}

function inspectBlobDirectory(home: string, scope: GraphWorkerDeliveryScope) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = outboxPaths(path, home, scope).blobs;
    yield* secureDirectory(directory, home);
    const names = yield* fs.readDirectory(directory);
    if (names.length > GRAPH_WORKER_OUTBOX_MAX_BLOBS)
      return yield* graphSharingFailure('Graph worker delivery outbox blob quota is full.');
    const blobs: Array<{name: string; size: number}> = [];
    for (const name of names) {
      if (!SHA256_HEX.test(name)) return yield* invalid();
      const target = path.join(directory, name);
      if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) return yield* invalid();
      const stat = yield* fs.stat(target);
      if (stat.type !== 'File' || Number(stat.size) > MAX_RESULT_BYTES) return yield* invalid();
      blobs.push({name, size: Number(stat.size)});
    }
    return blobs;
  });
}

function verifyOutboxCapacity(
  home: string,
  scope: GraphWorkerDeliveryScope,
  required: readonly {digest: string; bytes: Uint8Array}[],
) {
  return Effect.gen(function* () {
    const existing = yield* inspectBlobDirectory(home, scope);
    const names = new Set(EffectArray.map(existing, blob => blob.name));
    let size = EffectArray.reduce(existing, 0, (sum, blob) => sum + blob.size);
    for (const blob of required) {
      const name = sha256HexFromDigest(blob.digest);
      if (names.has(name)) continue;
      names.add(name);
      size += blob.bytes.byteLength;
    }
    if (names.size > GRAPH_WORKER_OUTBOX_MAX_BLOBS || size > GRAPH_WORKER_OUTBOX_MAX_BLOB_BYTES)
      return yield* graphSharingFailure('Graph worker delivery outbox blob quota is full.');
  });
}

/** Run only under the scope's mutation lock. Never remove a referenced blob or metadata. */
function recoverOutboxStorage(home: string, scope: GraphWorkerDeliveryScope, current: GraphWorkerDeliveryOutboxV1) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = outboxPaths(path, home, scope);
    const directory = paths.blobs;
    yield* secureDirectory(directory, home);
    const referenced = new Set(
      EffectArray.map(
        EffectArray.flatMap(current.operations, item => [
          item.resultDigest,
          item.attestationDigest,
          item.manifestDigest,
        ]),
        sha256HexFromDigest,
      ),
    );
    const rootNames = yield* fs.readDirectory(paths.root);
    const blobNames = yield* fs.readDirectory(directory);
    let rootChanged = false;
    let blobsChanged = false;
    for (const name of rootNames.slice(0, MAX_RECOVERY_ENTRIES)) {
      if (!TEMPORARY.test(name) || !Effect2.pipe(name, EffectString.startsWith('outbox.json.'))) continue;
      const target = path.join(paths.root, name);
      if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) return yield* invalid();
      const stat = yield* fs.stat(target);
      if (stat.type !== 'File') return yield* invalid();
      yield* fs.remove(target);
      rootChanged = true;
    }
    for (const name of blobNames.slice(0, MAX_RECOVERY_ENTRIES)) {
      if (referenced.has(name)) continue;
      if (!SHA256_HEX.test(name) && !TEMPORARY.test(name)) return yield* invalid();
      const target = path.join(directory, name);
      if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) return yield* invalid();
      const stat = yield* fs.stat(target);
      if (stat.type !== 'File') return yield* invalid();
      // These files have no durable operation referring to them. An interrupted
      // preparation may be safely reconstructed from its still-queued candidate.
      yield* fs.remove(target);
      blobsChanged = true;
    }
    if (rootChanged) yield* syncDirectoryStrict(fs, paths.root);
    if (blobsChanged) yield* syncDirectoryStrict(fs, directory);
  });
}

function invalid() {
  return graphSharingFailure('Graph worker delivery outbox authority or data is invalid.');
}

import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Clock, Effect, FileSystem, Path, Random, Schema} from 'effect';
import {isFileLockTimeout, withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {canonicalJson} from '../../checkpoint/canonical_json.js';
import {readVerifiedCasBlobBounded} from '../cas.js';
import {resolveGraphShareRepositoryClient} from '../client/state.js';
import {makeAuthenticatedGraphControlClient} from '../control/http.js';
import {
  acknowledgeGraphShareContributions,
  effectiveGraphShareContributionMode,
  effectiveGraphShareContributionPolicy,
} from '../contribution.js';
import {
  MAX_SIGNED_CONTRIBUTION_FAILURES,
  graphShareSignedContributionRetryDelay,
  readContributionRetryState,
  writeContributionRetryState,
} from '../contribution/retry_state.js';
import {parseSha256Digest, sha256Digest, SHA256_DIGEST} from '../digest.js';
import {graphSharingFailure, graphSharingUnavailable, GraphSharingError} from '../errors.js';
import {GRAPH_SHARE_HTTP_CAS_MAX_BYTES} from '../oci.js';
import type {GraphShareProfileV1} from '../profile.js';
import {readTrustedGraphShareContributionProfile} from '../profile/storage.js';
import {signedCandidateQueuePath} from '../signed/candidate.js';
import {
  acknowledgeGraphShareSignedCandidatePage,
  graphShareSignedCandidateIdentity,
  listGraphShareSignedCandidatePageIds,
  readGraphShareSignedCandidatePage,
  type GraphShareSignedCandidateV2,
} from '../signed/candidate.js';
import {lookupGraphShareTrustReceipt, type GraphShareTrustReceiptV1} from '../trust.js';
import {prepareGraphControlWorkerIdentity} from '../client/enrollment.js';
import {
  graphWorkerDeliveryScope,
  listGraphWorkerDeliveryPrincipalScopes,
  listGraphWorkerDeliveryOutboxOperations,
  markGraphWorkerDeliveryAdmitted,
  prepareGraphWorkerDeliveryOutbox,
  readGraphWorkerDeliveryOutboxOperation,
  retireGraphWorkerDeliveryOutbox,
  retireExpiredPreparedGraphWorkerDeliveryOutbox,
  retireSupersededGraphWorkerDeliveryOutbox,
  type GraphWorkerDeliveryOutboxOperationV1,
  type GraphWorkerDeliveryScope,
} from './delivery_outbox.js';
import {signGraphWorkerResultAnnouncement} from './announcement.js';
import {graphWorkerRegistryForProfile, uploadGraphWorkerArtifactToRegistry} from './registry_upload.js';
import {createGraphWorkerResultArtifact, type GraphWorkerResultAuthority} from './result.js';
import {advanceGraphWorkerCandidateScan, nextGraphWorkerCandidateScan} from './candidate_scan.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const ADMISSION_ACK = Schema.Struct({
  idempotencyKey: Schema.String.check(Schema.isPattern(SHA256_DIGEST)),
  status: Schema.Literals(['accepted', 'duplicate', 'quarantined']),
});
const STALE_SOURCE_ACK = Schema.Struct({
  error: Schema.Literal('stale-source'),
  idempotencyKey: Schema.String.check(Schema.isPattern(SHA256_DIGEST)),
});
const STRICT = {onExcessProperty: 'error'} as const;
const SIGNED_DELIVERY_DEADLINE_MILLISECONDS = 360_000;
const WORKER_MINIMUM_VALIDITY_SECONDS = 390;

/** Legacy worker metadata is deliberately never submitted to an OCI-backed org. */
export function usesSignedGraphWorkerDelivery(trust: GraphShareTrustReceiptV1): boolean {
  return Effect2.pipe(trust.registryCanonical, EffectString.startsWith('oci://'));
}

/** One bounded background round, independent of the foreground/legacy 30-second lease. */
export const drainQueuedGraphShareSignedContributions = Effect.fn('codeGraph.sharing.drainSignedContributions')(
  function* (input: {
    readonly cleanupOutbox?: boolean;
    readonly repositoryId: string;
    readonly threadnoteHome: string;
  }) {
    const trust = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.repositoryId);
    if (trust?.accessMode !== 'join' || !usesSignedGraphWorkerDelivery(trust)) return {sent: 0};
    // The page index is cheap; avoid invoking credential helpers on every idle monitor tick.
    if (
      input.cleanupOutbox === false &&
      (yield* listGraphShareSignedCandidatePageIds(input.threadnoteHome, input.repositoryId)).length === 0
    )
      return {sent: 0};
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockPath = `${signedCandidateQueuePath(path, input.threadnoteHome, input.repositoryId)}.delivery.lock`;
    yield* fs.makeDirectory(path.dirname(lockPath), {recursive: true, mode: 0o700});
    return yield* withExclusiveFileLock(
      fs,
      lockPath,
      {
        heartbeatIntervalMilliseconds: 10_000,
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 60_000,
        waitTimeoutMilliseconds: 0,
      },
      drainSignedBatch(input, trust),
    ).pipe(Effect.catchIf(isFileLockTimeout, () => Effect.succeed({sent: 0})));
  },
);

const drainSignedBatch = Effect.fn('codeGraph.sharing.drainSignedBatch')(function* (
  input: {readonly repositoryId: string; readonly threadnoteHome: string},
  trust: GraphShareTrustReceiptV1,
) {
  const state = yield* resolveGraphShareRepositoryClient(input.threadnoteHome, trust);
  const mode = effectiveGraphShareContributionMode(trust.accessMode, state.contributionMode);
  if (mode === 'off' || state.coordinatorUrl === undefined) return {sent: 0};
  const profile = yield* readTrustedGraphShareContributionProfile(trust, state.casRoot);
  if (
    effectiveGraphShareContributionPolicy(
      trust.accessMode,
      state.contributionMode,
      profile.contribution.maximumUploadBytesPerSecond,
    ).deliveryPausedReason !== undefined
  )
    return {sent: 0};
  if (
    profile.coordinator?.url !== state.coordinatorUrl ||
    !Effect2.pipe(profile.registry.worker, EffectString.startsWith('oci://'))
  )
    return yield* graphSharingFailure('Signed graph worker profile is outside its trusted transport.');
  yield* Effect.try({
    try: () =>
      graphWorkerRegistryForProfile(profile, {profileDigest: trust.profileDigest, repositoryId: trust.repositoryId}),
    catch: () => graphSharingFailure('Signed graph worker registry overlaps or exceeds its trusted namespace.'),
  });
  const controlScope = {
    coordinatorUrl: state.coordinatorUrl,
    organization: trust.organization,
    profileDigest: trust.profileDigest,
    repositoryId: trust.repositoryId,
  };
  const client = yield* makeAuthenticatedGraphControlClient(input.threadnoteHome, controlScope, 'graph:contribute');
  const currentTrust = Effect.gen(function* () {
    const now = yield* lookupGraphShareTrustReceipt(input.threadnoteHome, input.repositoryId);
    if (now?.accessMode !== 'join' || canonicalJson(now) !== canonicalJson(trust)) return false;
    const currentState = yield* resolveGraphShareRepositoryClient(input.threadnoteHome, now);
    return (
      currentState.casRoot === state.casRoot &&
      currentState.coordinatorUrl === state.coordinatorUrl &&
      effectiveGraphShareContributionMode(now.accessMode, currentState.contributionMode) !== 'off'
    );
  }).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* currentTrust)) return {sent: 0};
  const enrollment = yield* prepareGraphControlWorkerIdentity({
    home: input.threadnoteHome,
    scope: controlScope,
    client,
    isAuthorized: currentTrust,
    minimumValiditySeconds: WORKER_MINIMUM_VALIDITY_SECONDS,
  });
  const guard = Effect.gen(function* () {
    return (yield* currentTrust) && (yield* enrollment.stillAuthorized);
  }).pipe(Effect.orElseSucceed(() => false));
  if (!(yield* guard)) return {sent: 0};
  const scope = graphWorkerDeliveryScope(
    {
      expiresAt: enrollment.worker.expiresAt,
      graphAbi: Effect2.pipe('0', EffectString.repeat(64)),
      principalId: enrollment.worker.principalId,
      profileDigest: trust.profileDigest,
      repositoryId: trust.repositoryId,
      signingPublicKey: enrollment.signer.publicKey,
      workerId: enrollment.worker.workerId,
    },
    trust.organization,
  );
  const retryIdentity = sha256Digest(canonicalJson({scope, state, trust}));
  const retry = yield* readContributionRetryState(input.threadnoteHome, input.repositoryId, 'signed');
  const previous = retry?.identity === retryIdentity ? retry : undefined;
  if (previous !== undefined && previous.nextAttempt > (yield* Clock.currentTimeMillis)) return {sent: 0};
  return yield* Effect.gen(function* () {
    yield* reclaimExpiredGraphWorkerGenerations(input.threadnoteHome, scope);
    const now = (yield* Clock.currentTimeMillis) / 1000;
    const scopes = yield* listGraphWorkerDeliveryPrincipalScopes(input.threadnoteHome, scope);
    const operations = (yield* Effect.forEach(scopes, previousScope =>
      listGraphWorkerDeliveryOutboxOperations(input.threadnoteHome, previousScope).pipe(
        Effect.map(items => EffectArray.map(items, operation => ({operation, scope: previousScope}))),
      ),
    )).flat();
    const replay =
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          operations,
          item => item.operation.state === 'admitted' || item.operation.state === 'superseded',
        ),
      ) ??
      EffectOption.getOrUndefined(
        EffectArray.findFirst(
          operations,
          item =>
            item.operation.state === 'prepared' &&
            item.scope.workerId === scope.workerId &&
            item.operation.authority.expiresAt > now + SIGNED_DELIVERY_DEADLINE_MILLISECONDS / 1000,
        ),
      );
    if (replay !== undefined) {
      if (replay.operation.state !== 'prepared') {
        yield* finishAdmittedGraphWorkerResult(input, replay.scope, replay.operation);
      } else {
        const stored = yield* readGraphWorkerDeliveryOutboxOperation(
          input.threadnoteHome,
          replay.scope,
          replay.operation.operationId,
        );
        if (stored === undefined) return yield* graphSharingFailure('Prepared graph worker operation disappeared.');
        yield* dispatchPrepared(input, replay.scope, stored.operation, stored.artifact, profile, client, guard);
      }
      yield* writeContributionRetryState(input.threadnoteHome, input.repositoryId, undefined, 'signed');
      return {sent: 1};
    }
    let firstPreparationFailure: unknown;
    for (const position of yield* nextGraphWorkerCandidateScan(input.threadnoteHome, input.repositoryId)) {
      if (!(yield* guard)) return {sent: 0};
      const prepared = yield* prepareCandidate(
        input,
        trust,
        state.casRoot,
        position.candidate,
        position.pageId,
        enrollment,
      ).pipe(
        Effect.map(value => ({ok: true as const, value})),
        Effect.catch(error => Effect.succeed({ok: false as const, error})),
      );
      if (!prepared.ok) {
        firstPreparationFailure ??= prepared.error;
        yield* advanceGraphWorkerCandidateScan(input.threadnoteHome, input.repositoryId, position);
        continue;
      }
      yield* dispatchPrepared(input, scope, prepared.value.operation, prepared.value.artifact, profile, client, guard);
      yield* writeContributionRetryState(input.threadnoteHome, input.repositoryId, undefined, 'signed');
      return {sent: 1};
    }
    if (firstPreparationFailure !== undefined) return yield* Effect.fail(firstPreparationFailure);
    if (retry !== undefined)
      yield* writeContributionRetryState(input.threadnoteHome, input.repositoryId, undefined, 'signed');
    return {sent: 0};
  }).pipe(
    Effect.timeout(SIGNED_DELIVERY_DEADLINE_MILLISECONDS),
    Effect.catch(error =>
      Effect.gen(function* () {
        const failure = Schema.is(GraphSharingError)(error) ? error : undefined;
        const failures = Math.min(MAX_SIGNED_CONTRIBUTION_FAILURES, (previous?.failures ?? 0) + 1);
        const delay =
          failure?.httpStatus === 401 || failure?.httpStatus === 403
            ? Math.max(3_600_000, failure?.retryAfterMilliseconds ?? 0)
            : graphShareSignedContributionRetryDelay(
                failure?.httpStatus,
                failures,
                yield* Random.next,
                failure?.retryAfterMilliseconds,
              );
        yield* writeContributionRetryState(
          input.threadnoteHome,
          input.repositoryId,
          {
            failures,
            identity: retryIdentity,
            nextAttempt: Math.min(Number.MAX_SAFE_INTEGER, (yield* Clock.currentTimeMillis) + delay),
          },
          'signed',
        );
        if (failure?.kind === 'unavailable') return {sent: 0};
        return yield* Effect.fail(error);
      }),
    ),
  );
});

/** Keep a worker-rotation outage from exhausting the bounded principal index. */
export const reclaimExpiredGraphWorkerGenerations = Effect.fn('codeGraph.sharing.reclaimExpiredWorkerGenerations')(
  function* (threadnoteHome: string, current: GraphWorkerDeliveryScope) {
    const now = (yield* Clock.currentTimeMillis) / 1000;
    for (const prior of yield* listGraphWorkerDeliveryPrincipalScopes(threadnoteHome, current)) {
      const old = yield* listGraphWorkerDeliveryOutboxOperations(threadnoteHome, prior);
      for (const operation of old) {
        if (operation.state !== 'prepared' || operation.authority.expiresAt > now) continue;
        yield* retireExpiredPreparedGraphWorkerDeliveryOutbox({
          operationId: operation.operationId,
          scope: prior,
          threadnoteHome,
        });
      }
      // Free one index slot before preparing the current generation. Admitted operations
      // remain indexed so their exact journal ACK can finish after worker renewal.
      if (old.length > 0 && (yield* listGraphWorkerDeliveryOutboxOperations(threadnoteHome, prior)).length === 0) break;
    }
  },
);

const prepareCandidate = Effect.fn('codeGraph.sharing.prepareSignedCandidate')(function* (
  input: {readonly repositoryId: string; readonly threadnoteHome: string},
  trust: GraphShareTrustReceiptV1,
  casRoot: string,
  candidate: GraphShareSignedCandidateV2,
  pageId: string,
  enrollment: Effect.Success<ReturnType<typeof prepareGraphControlWorkerIdentity>>,
) {
  if (
    candidate.organization !== trust.organization ||
    candidate.profileDigest !== trust.profileDigest ||
    candidate.casRoot !== casRoot ||
    Effect2.pipe(candidate.sourceCommit, EffectString.slice(0, 40)) !== candidate.batchId
  )
    return yield* graphSharingFailure('Signed graph worker candidate is outside its current authority.');
  const resultBytes = yield* readVerifiedCasBlobBounded(
    casRoot,
    candidate.resultDigest,
    GRAPH_SHARE_HTTP_CAS_MAX_BYTES,
  );
  if (resultBytes.byteLength !== candidate.resultSize)
    return yield* graphSharingFailure('Signed candidate result size changed.');
  const authority: GraphWorkerResultAuthority = {
    expiresAt: enrollment.worker.expiresAt,
    graphAbi: candidate.graphAbi,
    principalId: enrollment.worker.principalId,
    profileDigest: trust.profileDigest,
    repositoryId: trust.repositoryId,
    signingPublicKey: enrollment.signer.publicKey,
    workerId: enrollment.worker.workerId,
  };
  const artifact = yield* createGraphWorkerResultArtifact({
    metadata: {
      batchId: candidate.batchId,
      graphAbi: candidate.graphAbi,
      identityClass: 'oauth-principal',
      issuedAt: Math.floor((yield* Clock.currentTimeMillis) / 1000),
      partialCoverage: candidate.partialCoverage,
      platform: candidate.platform,
      principalId: authority.principalId,
      profileDigest: authority.profileDigest,
      releaseIdentity: candidate.releaseIdentity,
      repositoryId: authority.repositoryId,
      resourceLimits: [...candidate.resourceLimits],
      sourceCommit: candidate.sourceCommit,
      workerId: authority.workerId,
    },
    resultBytes,
    signer: enrollment.signer,
  });
  const announcement = yield* signGraphWorkerResultAnnouncement({
    artifact,
    expected: authority,
    signer: enrollment.signer,
  });
  const prepared = yield* prepareGraphWorkerDeliveryOutbox({
    announcement,
    artifact,
    authority,
    candidate,
    candidatePageId: pageId,
    repositoryId: input.repositoryId,
    threadnoteHome: input.threadnoteHome,
  });
  const scope = graphWorkerDeliveryScope(authority, trust.organization);
  const replay = yield* readGraphWorkerDeliveryOutboxOperation(
    input.threadnoteHome,
    scope,
    prepared.operation.operationId,
  );
  if (replay === undefined) return yield* graphSharingFailure('Prepared graph worker artifact is unavailable.');
  return replay;
});

const dispatchPrepared = Effect.fn('codeGraph.sharing.dispatchPreparedWorkerResult')(function* <E, R>(
  input: {readonly repositoryId: string; readonly threadnoteHome: string},
  scope: GraphWorkerDeliveryScope,
  operation: GraphWorkerDeliveryOutboxOperationV1,
  artifact: {
    readonly attestationBytes: Uint8Array;
    readonly manifestBytes: Uint8Array;
    readonly manifestDigest: string;
    readonly resultBytes: Uint8Array;
  },
  profile: GraphShareProfileV1,
  client: Effect.Success<ReturnType<typeof makeAuthenticatedGraphControlClient>>,
  isAuthorized: Effect.Effect<boolean, E, R>,
) {
  yield* submitPreparedGraphWorkerResult(input, scope, operation, {
    isAuthorized,
    upload: uploadGraphWorkerArtifactToRegistry({
      artifact: {
        attestationBytes: new Uint8Array(artifact.attestationBytes),
        manifestBytes: new Uint8Array(artifact.manifestBytes),
        manifestDigest: parseSha256Digest(artifact.manifestDigest),
        resultBytes: new Uint8Array(artifact.resultBytes),
      },
      authority: operation.authority,
      profile,
      isAuthorized,
    }),
    announce: client.request('POST', '/v1/results', operation.announcement, isAuthorized),
  });
});

/** The outbox remains prepared on every unknown result, including a lost control response. */
export const submitPreparedGraphWorkerResult = Effect.fn('codeGraph.sharing.submitPreparedWorkerResult')(function* <
  UE,
  UR,
  AE,
  AR,
  GE,
  GR,
>(
  input: {readonly repositoryId: string; readonly threadnoteHome: string},
  scope: GraphWorkerDeliveryScope,
  operation: GraphWorkerDeliveryOutboxOperationV1,
  transport: {
    readonly announce: Effect.Effect<{readonly body: unknown; readonly status: number}, AE, AR>;
    readonly isAuthorized: Effect.Effect<boolean, GE, GR>;
    readonly upload: Effect.Effect<unknown, UE, UR>;
  },
) {
  if (!(yield* transport.isAuthorized))
    return yield* graphSharingFailure('Graph worker delivery is no longer authorized.');
  yield* transport.upload;
  if (!(yield* transport.isAuthorized))
    return yield* graphSharingFailure('Graph worker delivery is no longer authorized.');
  const response = yield* transport.announce;
  if (response.status === 409) {
    const stale = yield* Schema.decodeUnknownEffect(
      STALE_SOURCE_ACK,
      STRICT,
    )(response.body).pipe(
      Effect.mapError(() => graphSharingFailure('Graph worker stale-source acknowledgement is invalid.')),
    );
    if (stale.idempotencyKey !== operation.operationId)
      return yield* graphSharingFailure('Graph worker stale-source acknowledgement is outside its operation.');
    const superseded = yield* markGraphWorkerDeliveryAdmitted({
      scope,
      candidateIdentity: operation.candidateIdentity,
      candidatePageId: operation.candidatePageId,
      operationId: operation.operationId,
      response: {idempotencyKey: stale.idempotencyKey, status: 'stale-source'},
      threadnoteHome: input.threadnoteHome,
    });
    return yield* finishAdmittedGraphWorkerResult(input, scope, superseded);
  }
  const ack = yield* Schema.decodeUnknownEffect(
    ADMISSION_ACK,
    STRICT,
  )(response.body).pipe(
    Effect.mapError(() => graphSharingFailure('Graph worker admission acknowledgement is invalid.')),
  );
  if (
    !(
      (response.status === 201 && ack.status === 'accepted') ||
      (response.status === 200 && (ack.status === 'duplicate' || ack.status === 'quarantined'))
    ) ||
    ack.idempotencyKey !== operation.operationId
  )
    return yield* graphSharingFailure('Graph worker admission acknowledgement is outside its operation.');
  const admitted = yield* markGraphWorkerDeliveryAdmitted({
    scope,
    candidateIdentity: operation.candidateIdentity,
    candidatePageId: operation.candidatePageId,
    operationId: operation.operationId,
    response: ack,
    threadnoteHome: input.threadnoteHome,
  });
  yield* finishAdmittedGraphWorkerResult(input, scope, admitted);
});

export const finishAdmittedGraphWorkerResult = Effect.fn('codeGraph.sharing.finishAdmittedWorkerResult')(function* (
  input: {readonly repositoryId: string; readonly threadnoteHome: string},
  scope: GraphWorkerDeliveryScope,
  operation: GraphWorkerDeliveryOutboxOperationV1,
) {
  if (operation.state !== 'admitted' && operation.state !== 'superseded')
    return yield* graphSharingFailure('Graph worker result is not settled.');
  const accepted = new Set([operation.candidateIdentity]);
  let ack = yield* acknowledgeGraphShareSignedCandidatePage(
    input.threadnoteHome,
    input.repositoryId,
    operation.candidatePageId,
    accepted,
  );
  if (!ack.absent) {
    for (const pageId of yield* listGraphShareSignedCandidatePageIds(input.threadnoteHome, input.repositoryId)) {
      const page = yield* readGraphShareSignedCandidatePage(input.threadnoteHome, input.repositoryId, pageId);
      if (
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(page?.candidates), __effectArrayReceiver =>
            EffectArray.some(
              __effectArrayReceiver,
              candidate => graphShareSignedCandidateIdentity(candidate) === operation.candidateIdentity,
            ),
          ),
        )
      )
        yield* acknowledgeGraphShareSignedCandidatePage(input.threadnoteHome, input.repositoryId, pageId, accepted);
    }
    ack = yield* acknowledgeGraphShareSignedCandidatePage(
      input.threadnoteHome,
      input.repositoryId,
      operation.candidatePageId,
      accepted,
    );
  }
  if (!ack.absent) return yield* graphSharingUnavailable('Settled graph worker candidate could not be acknowledged.');
  // Both outcomes settle the exact candidate. This only removes its local legacy queue entry;
  // a stale result has no server receipt and is never counted as a consumed worker result.
  const selfAttestation = sha256Digest(
    canonicalJson({
      kind: 'contributor-self',
      payloadDigest: operation.resultDigest,
      schemaVersion: 1,
    }),
  );
  yield* acknowledgeGraphShareContributions(
    input.threadnoteHome,
    input.repositoryId,
    [
      {
        actionKey: operation.candidate.actionKey,
        attestationDigest: selfAttestation,
        batchId: operation.candidate.batchId,
        resultManifestDigest: parseSha256Digest(operation.resultDigest),
        semanticDigest: parseSha256Digest(operation.candidate.semanticDigest),
      },
    ],
    'passive',
  );
  for (const previousScope of yield* listGraphWorkerDeliveryPrincipalScopes(input.threadnoteHome, scope)) {
    yield* retireSupersededGraphWorkerDeliveryOutbox({
      admittedOperationId: operation.operationId,
      admittedScope: scope,
      candidateAbsent: true,
      candidateIdentity: operation.candidateIdentity,
      oldScope: previousScope,
      threadnoteHome: input.threadnoteHome,
    });
  }
  yield* retireGraphWorkerDeliveryOutbox({
    scope,
    candidateAbsent: true,
    candidateIdentity: operation.candidateIdentity,
    candidatePageId: operation.candidatePageId,
    operationId: operation.operationId,
    threadnoteHome: input.threadnoteHome,
  });
});

import {Clock, Console, Context, Effect, Layer, Path, Ref, Schema, Semaphore} from 'effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {CommandExecutor} from '@threadnote/platform/command';
import {
  createRemoteAccessTokenVerifier,
  parseBearerAccessToken,
  type AccessTokenClaims,
} from '@threadnote/protocol/access-token';
import {
  parseGraphShareFrontierManifest,
  parseGraphShareFrontierPointer,
  parseGraphShareSignatureEnvelope,
  verifyGraphShareFrontier,
} from '../artifacts.js';
import {decodeJsonBytes} from '../atomic.js';
import {casBlobPath} from '../cas.js';
import {
  graphControlGrantExpiry,
  makeGraphControlRateLimit,
  readGraphControlBytes,
  readGraphControlPolicy,
  type GraphControlPolicy,
  type GraphControlScope,
} from './authorization.js';
import {enrollGraphControlWorker, GraphControlEnrollmentError, readGraphWorkerEnrollmentRequest} from './enrollment.js';
import {GRAPH_SHARE_CONTROL_MAX_BODY_BYTES} from './protocol.js';
import type {GraphShareCoordinatorStateV1} from './protocol.js';
import {parseSha256Digest, sha256Digest} from '../digest.js';
import {GraphSharingError, graphSharingFailure, graphSharingUnavailable} from '../errors.js';
import {graphSharingFrontierPointerPath, graphSharingLayout} from '../layout.js';
import {graphShareFrontierDiscoveryTag} from '../namespace.js';
import {graphShareRegistryPublicationScope, graphSharePublicationPointer} from '../registry/publication.js';
import {graphSharePublicationAuthority, readGraphSharePublicationReceipt} from '../registry/publication_state.js';
import {
  admitGraphControlWorkerResult,
  readGraphControlWorkerResultRequest,
  readGraphWorkerAdmissionStore,
} from './result_admission.js';
import {
  assertProfileMatchesEnrollment,
  graphShareProfileDigest,
  type GraphShareEnrollment,
  type GraphShareProfileV1,
} from '../profile.js';

export interface GraphControlReaderOptions {
  readonly casRoot: string;
  readonly enrollment: GraphShareEnrollment;
  readonly policyFile: string;
  readonly profile: GraphShareProfileV1;
  readonly repoRoot?: string;
  readonly threadnoteHome: string;
  /** Live publisher state for the authorized collection window; omitted by standalone metadata readers. */
  readonly coordinatorStateRef?: Ref.Ref<GraphShareCoordinatorStateV1>;
  /** Internal gate. The route stays closed until source-verifying publication and sender delivery are complete. */
  readonly enableWorkerResults?: boolean;
}

type Operation = 'discovery' | 'frontier' | 'status' | 'enroll' | 'results' | 'unsupported';

export const validateGraphControlPolicy = Effect.fn('codeGraph.sharing.validateControlPolicy')(function* (
  options: GraphControlReaderOptions,
) {
  const scope = graphControlReaderScope(options);
  const policy = yield* readGraphControlPolicy(options.policyFile);
  if (
    policy.organization !== scope.organization ||
    policy.repositoryId !== scope.repositoryId ||
    policy.profileDigest !== scope.profileDigest
  ) {
    return yield* graphSharingFailure('Graph control policy does not match the enrolled profile.');
  }
  return policy;
});

export const makeGraphControlReader = Effect.fn('codeGraph.sharing.makeControlReader')(function* (
  options: GraphControlReaderOptions,
  verifyToken?: (token: string) => Promise<AccessTokenClaims>,
) {
  if (options.enableWorkerResults === true && options.repoRoot === undefined)
    return yield* graphSharingFailure('Signed worker admission requires a trusted source checkout.');
  const scope = graphControlReaderScope(options);
  const initial = yield* validateGraphControlPolicy(options);
  if (options.enableWorkerResults === true) yield* readGraphWorkerAdmissionStore(options.threadnoteHome, initial);
  const verify = verifyToken ?? createRemoteAccessTokenVerifier({...initial, jwksUrl: new URL(initial.jwksUrl)});
  const commandExecutor =
    options.enableWorkerResults === true
      ? Context.get(yield* Layer.build(CommandExecutor.layer), CommandExecutor)
      : undefined;
  const permits = yield* Semaphore.make(8);
  const resultPermits = yield* Semaphore.make(2);
  const globalAdmission = makeGraphControlRateLimit({maximumPrincipals: 1, requestsPerMinute: 1200});
  const principalAdmission = makeGraphControlRateLimit();
  const currentPolicy = readGraphControlPolicy(options.policyFile).pipe(
    Effect.filterOrFail(
      policy => sameAuthority(initial, policy),
      () => graphSharingFailure('Graph control authority changed; restart the listener.'),
    ),
  );

  const handleRequest = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (!globalAdmission('listener', now)) return reply(429, {error: 'rate-limited'});
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathname = request.url.split('?', 1)[0] ?? '';
    const operation: Operation =
      pathname === '/.well-known/threadnote-graph'
        ? 'discovery'
        : pathname === '/v1/status'
          ? 'status'
          : pathname === '/v1/enroll'
            ? 'enroll'
            : pathname === '/v1/results' && options.enableWorkerResults === true
              ? 'results'
              : /^\/v1\/frontiers\/[0-9a-f]{40}$/u.test(pathname)
                ? 'frontier'
                : 'unsupported';
    let principalId: string | undefined;
    const handle = Effect.gen(function* () {
      if (
        operation === 'enroll' || operation === 'results'
          ? request.method !== 'POST'
          : request.method !== 'GET' && request.method !== 'HEAD'
      )
        return reply(403, {error: 'operation-unavailable'});
      if (
        operation !== 'enroll' &&
        operation !== 'results' &&
        (request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0)
      ) {
        return reply(400, {error: 'invalid-request'});
      }
      if (operation === 'unsupported') return reply(404, {error: 'not-found'});
      if (operation === 'discovery')
        return reply(200, {
          organization: scope.organization,
          protocolVersions: ['v1'],
          controlMode: 'authenticated-metadata',
        });
      const principal = yield* fromPromiseInterruptible(
        () => verify(parseBearerAccessToken(request.headers.authorization)),
        () => graphSharingFailure('Graph control authentication failed.'),
      ).pipe(Effect.option);
      if (principal._tag === 'None') return reply(401, {error: 'unauthorized'});
      principalId = sha256Digest(JSON.stringify([principal.value.issuer, principal.value.subject]));
      const authorized = Effect.gen(function* () {
        const policy = yield* currentPolicy;
        const at = (yield* Clock.currentTimeMillis) / 1000;
        return (
          principal.value.expiresAt > at &&
          request.headers['x-threadnote-repository-id'] === scope.repositoryId &&
          request.headers['x-threadnote-profile-digest'] === scope.profileDigest &&
          graphControlGrantExpiry(
            policy,
            scope,
            principal.value,
            operation === 'enroll' || operation === 'results' ? 'graph:contribute' : 'graph:read',
            at,
          ) !== undefined
        );
      });
      if (!(yield* authorized)) return reply(403, {error: 'forbidden'});
      if (!principalAdmission(principalId, yield* Clock.currentTimeMillis)) return reply(429, {error: 'rate-limited'});
      if (operation === 'enroll') {
        const declared = Number(request.headers['content-length'] ?? 0);
        if (!Number.isSafeInteger(declared) || declared < 0 || declared > GRAPH_SHARE_CONTROL_MAX_BODY_BYTES)
          return reply(413, {error: 'invalid-request'});
        if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
          return reply(400, {error: 'invalid-request'});
        const decoded = yield* readGraphWorkerEnrollmentRequest(request.stream).pipe(Effect.option);
        if (decoded._tag === 'None') return reply(400, {error: 'invalid-request'});
        const enrolled = yield* enrollGraphControlWorker({
          home: options.threadnoteHome,
          initialPolicy: initial,
          principal: principal.value,
          readCurrentPolicy: currentPolicy,
          request: decoded.value,
        }).pipe(
          Effect.map(result => reply(result.created ? 201 : 200, result.body)),
          Effect.catchIf(
            error => Schema.is(GraphControlEnrollmentError)(error),
            error => Effect.succeed(reply(error.code === 'forbidden' ? 403 : 429, {error: error.code})),
          ),
        );
        return enrolled;
      }
      if (operation === 'results') {
        if (commandExecutor === undefined) return reply(503, {error: 'unavailable'});
        const declared = Number(request.headers['content-length'] ?? 0);
        if (!Number.isSafeInteger(declared) || declared < 0 || declared > GRAPH_SHARE_CONTROL_MAX_BODY_BYTES)
          return reply(413, {error: 'invalid-request'});
        if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
          return reply(400, {error: 'invalid-request'});
        const decoded = yield* readGraphControlWorkerResultRequest(request.stream).pipe(Effect.option);
        if (decoded._tag === 'None') return reply(400, {error: 'invalid-request'});
        yield* readGraphControlFrontier(options);
        const admitted = yield* admitGraphControlWorkerResult({
          announcement: decoded.value,
          casRoot: options.casRoot,
          commandExecutor,
          enrollment: options.enrollment,
          home: options.threadnoteHome,
          initialPolicy: initial,
          principal: principal.value,
          profile: options.profile,
          repoRoot: options.repoRoot!,
          readCurrentPolicy: currentPolicy,
        }).pipe(
          Effect.catchIf(
            error => Schema.is(GraphControlEnrollmentError)(error),
            () => Effect.succeed({status: 'invalid-authority' as const}),
          ),
          Effect.catchIf(
            error => Schema.is(GraphSharingError)(error) && error.kind === 'verification-failed',
            () => Effect.succeed({status: 'invalid-request' as const}),
          ),
        );
        if (admitted.status === 'invalid-authority') return reply(403, {error: 'forbidden'});
        if (admitted.status === 'invalid-request') return reply(400, {error: 'invalid-request'});
        if (admitted.status === 'operation-conflict') return reply(409, {error: 'operation-conflict'});
        if (admitted.status === 'stale-source')
          return reply(409, {error: 'stale-source', idempotencyKey: admitted.idempotencyKey});
        if (admitted.status === 'source-unavailable') return reply(425, {error: 'source-unavailable'});
        if (admitted.status === 'capacity-exceeded') return reply(429, {error: 'capacity-exceeded'});
        if (!('receipt' in admitted)) return reply(503, {error: 'unavailable'});
        return reply(admitted.status === 'accepted' ? 201 : 200, {
          idempotencyKey: admitted.receipt.announcement.body.idempotencyKey,
          status: admitted.status,
        });
      }
      const frontier = yield* readGraphControlFrontier(options);
      if (!(yield* authorized)) return reply(403, {error: 'forbidden'});
      if (operation === 'frontier') {
        const expected = graphShareFrontierDiscoveryTag(scope.repositoryId, frontier.manifest.branch).slice(
          'tn-frontier-'.length,
        );
        if (pathname !== `/v1/frontiers/${expected}`) return reply(404, {error: 'not-found'});
        return reply(200, {
          envelopeDigest: frontier.pointer.envelopeDigest,
          frontierDigest: frontier.pointer.manifestDigest,
          manifestDigest: frontier.pointer.manifestDigest,
        });
      }
      const machine =
        options.coordinatorStateRef === undefined ? undefined : (yield* Ref.get(options.coordinatorStateRef)).machine;
      const collectionIsCurrent = machine?.publishedFrontier === frontier.manifest.sourceCommit;
      return reply(200, {
        generation: frontier.manifest.generation,
        organization: scope.organization,
        phase: collectionIsCurrent ? machine.phase : 'published',
        observedHead: collectionIsCurrent && machine.phase === 'collecting' ? machine.observedHead : null,
        profileDigest: scope.profileDigest,
        publishedFrontier: frontier.manifest.sourceCommit,
        receipts: [],
        repositoryId: scope.repositoryId,
      });
    }).pipe(
      Effect.timeout(operation === 'results' ? '5 minutes' : '10 seconds'),
      Effect.catchDefect(() => Effect.succeed(reply(503, {error: 'unavailable'}))),
      Effect.orElseSucceed(() => reply(503, {error: 'unavailable'})),
    );
    const response = yield* (operation === 'results' ? resultPermits : permits).withPermitsIfAvailable(1)(handle);
    const selected = response._tag === 'Some' ? response.value : reply(503, {error: 'busy'});
    yield* Console.log(
      JSON.stringify({
        event: 'graph-control-access',
        operation,
        ...(principalId === undefined ? {} : {principalId}),
        status: selected.status,
      }),
    );
    return selected;
  });
  return {handle: handleRequest};
});

function graphControlReaderScope(options: GraphControlReaderOptions): GraphControlScope {
  const profileDigest = graphShareProfileDigest(options.profile);
  assertProfileMatchesEnrollment(options.profile, options.enrollment, profileDigest);
  return {organization: options.profile.organization, profileDigest, repositoryId: options.profile.repositoryId};
}

function sameAuthority(left: GraphControlPolicy, right: GraphControlPolicy): boolean {
  return (
    left.audience === right.audience &&
    left.issuer === right.issuer &&
    left.jwksUrl === right.jwksUrl &&
    left.organization === right.organization &&
    left.repositoryId === right.repositoryId &&
    left.profileDigest === right.profileDigest
  );
}

export const readGraphControlFrontier = Effect.fn('codeGraph.sharing.readControlFrontier')(function* (
  options: GraphControlReaderOptions,
) {
  const scope = graphControlReaderScope(options);
  const path = yield* Path.Path;
  const layout = graphSharingLayout(path, options.threadnoteHome, options.casRoot);
  const pointerFile = graphSharingFrontierPointerPath(path, layout.frontiersRoot, scope.repositoryId);
  const publication = options.profile.registry.canonical.startsWith('oci://')
    ? yield* readGraphSharePublicationReceipt(
        options.threadnoteHome,
        graphSharePublicationAuthority(graphShareRegistryPublicationScope(options), options.profile.registry.canonical),
      )
    : undefined;
  if (publication !== undefined && publication.acknowledged === undefined)
    return yield* graphSharingUnavailable('Registry frontier publication is pending.');
  const pointer =
    publication?.acknowledged === undefined
      ? parseGraphShareFrontierPointer(
          yield* decodeJsonBytes(yield* readGraphControlBytes(pointerFile, GRAPH_SHARE_CONTROL_MAX_BODY_BYTES)),
        )
      : graphSharePublicationPointer(publication.acknowledged);
  const readBlob = (digest: string) =>
    Effect.gen(function* () {
      const bytes = yield* readGraphControlBytes(
        yield* casBlobPath(options.casRoot, digest),
        GRAPH_SHARE_CONTROL_MAX_BODY_BYTES,
      );
      if (sha256Digest(bytes) !== digest) return yield* graphSharingFailure('Graph control artifact digest mismatch.');
      return yield* decodeJsonBytes(bytes);
    });
  const manifest = parseGraphShareFrontierManifest(yield* readBlob(pointer.manifestDigest));
  const envelope = parseGraphShareSignatureEnvelope(yield* readBlob(pointer.envelopeDigest));
  yield* verifyGraphShareFrontier(parseSha256Digest(options.enrollment.publisherKeyFingerprint), manifest, envelope);
  if (
    manifest.repositoryId !== scope.repositoryId ||
    manifest.profileDigest !== scope.profileDigest ||
    !options.profile.source.branches.includes(manifest.branch)
  ) {
    return yield* graphSharingFailure('Graph control frontier does not match the enrolled profile.');
  }
  return {manifest, pointer};
});

function reply(status: number, body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: {'cache-control': 'no-store', ...(status === 401 ? {'www-authenticate': 'Bearer'} : {})},
  });
}

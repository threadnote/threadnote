import {Clock, Crypto, Effect, FileSystem, Path, Schema, Stream} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {AccessTokenClaims} from '@threadnote/protocol/access-token';
import {writePrivateJsonFile} from '../atomic.js';
import {graphControlGrantExpiry, readGraphControlBytes, type GraphControlPolicy} from './authorization.js';
import {sha256Digest, sha256HexFromDigest, SHA256_DIGEST, SHA256_HEX} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {GRAPH_SHARE_CONTROL_MAX_BODY_BYTES} from './protocol.js';
import {graphSharingLayout} from '../layout.js';

const Digest = Schema.String.check(Schema.isPattern(SHA256_DIGEST));
const PositiveTime = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const EnrollmentRequest = Schema.Struct({
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  profileDigest: Digest,
  repositoryId: Schema.String.check(Schema.isPattern(SHA256_HEX)),
  signingPublicKey: Schema.optionalKey(Schema.String.check(Schema.isPattern(SHA256_HEX))),
});
const Worker = Schema.Struct({
  expiresAt: PositiveTime,
  operationId: Digest,
  principalId: Digest,
  workerId: Schema.String.check(Schema.isPattern(/^gw_[0-9a-f]{32}$/u)),
  signingPublicKey: Schema.optionalKey(Schema.String.check(Schema.isPattern(SHA256_HEX))),
});
const Document = Schema.Struct({
  authority: Digest,
  records: Schema.Array(Worker).check(Schema.isMaxLength(1024)),
  schemaVersion: Schema.Literal(1),
});
export type GraphWorkerEnrollmentRequest = typeof EnrollmentRequest.Type;
type EnrollmentDocument = typeof Document.Type;

export class GraphControlEnrollmentError extends Schema.TaggedError<GraphControlEnrollmentError>()(
  'GraphControlEnrollmentError',
  {
    code: Schema.Literals(['forbidden', 'capacity-exceeded']),
  },
) {}

export function parseGraphWorkerEnrollmentRequest(value: unknown): GraphWorkerEnrollmentRequest {
  return Schema.decodeUnknownSync(EnrollmentRequest, {onExcessProperty: 'error'})(value);
}

export const readGraphWorkerEnrollmentRequest = Effect.fn('codeGraph.sharing.readWorkerEnrollmentRequest')(function* <
  E,
  R,
>(stream: Stream.Stream<Uint8Array, E, R>) {
  const collected = yield* Stream.runFoldEffect(
    stream,
    () => ({bytes: new Uint8Array(GRAPH_SHARE_CONTROL_MAX_BODY_BYTES), length: 0}),
    (collected, chunk) =>
      Effect.gen(function* () {
        if (collected.length + chunk.byteLength > collected.bytes.byteLength)
          return yield* graphSharingFailure('Graph worker enrollment request exceeds the body limit.');
        collected.bytes.set(chunk, collected.length);
        collected.length += chunk.byteLength;
        return collected;
      }),
  );
  return yield* Effect.try({
    try: () =>
      parseGraphWorkerEnrollmentRequest(
        JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(collected.bytes.subarray(0, collected.length))),
      ),
    catch: () => graphSharingFailure('Graph worker enrollment request is invalid.'),
  });
});

function authorityDigest(policy: GraphControlPolicy): string {
  return sha256Digest(
    JSON.stringify([
      policy.issuer,
      policy.audience,
      policy.jwksUrl,
      policy.organization,
      policy.repositoryId,
      policy.profileDigest,
    ]),
  );
}

export const graphWorkerEnrollmentStatePath = Effect.fn('codeGraph.sharing.workerEnrollmentStatePath')(function* (
  home: string,
  policy: GraphControlPolicy,
) {
  const path = yield* Path.Path;
  return path.join(
    graphSharingLayout(path, home).root,
    'control',
    'enrollments',
    `${sha256HexFromDigest(authorityDigest(policy))}.json`,
  );
});

export const enrollGraphControlWorker = Effect.fn('codeGraph.sharing.enrollControlWorker')(function* <E, R>(input: {
  readonly home: string;
  readonly initialPolicy: GraphControlPolicy;
  readonly principal: AccessTokenClaims;
  readonly readCurrentPolicy: Effect.Effect<GraphControlPolicy, E, R>;
  readonly request: GraphWorkerEnrollmentRequest;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* graphWorkerEnrollmentStatePath(input.home, input.initialPolicy);
  const authority = authorityDigest(input.initialPolicy);
  const principalId = sha256Digest(JSON.stringify([input.principal.issuer, input.principal.subject]));
  const operationId = sha256Digest(JSON.stringify(['enroll', authority, principalId, input.request.idempotencyKey]));
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  return yield* withExclusiveFileLock(
    fs,
    `${target}.lock`,
    {
      retryIntervalMilliseconds: 25,
      staleAfterMilliseconds: 30_000,
      waitTimeoutMilliseconds: 2_000,
    },
    Effect.gen(function* () {
      const current = yield* input.readCurrentPolicy;
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const expiresAt = graphControlGrantExpiry(current, input.initialPolicy, input.principal, 'graph:contribute', now);
      if (
        authorityDigest(current) !== authority ||
        expiresAt === undefined ||
        input.principal.expiresAt <= now ||
        input.request.repositoryId !== current.repositoryId ||
        input.request.profileDigest !== current.profileDigest
      ) {
        return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
      }
      const document = yield* readEnrollmentDocument(target, authority);
      const retained = document.records.filter(record => record.expiresAt > now);
      const previous = retained.find(record => record.operationId === operationId);
      if (previous !== undefined && previous.principalId !== principalId)
        return yield* graphSharingFailure('Graph worker enrollment ownership is invalid.');
      if (previous !== undefined && previous.signingPublicKey !== input.request.signingPublicKey)
        return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
      if (
        previous === undefined &&
        (retained.length >= 1024 || retained.filter(record => record.principalId === principalId).length >= 32)
      ) {
        return yield* GraphControlEnrollmentError.make({code: 'capacity-exceeded'});
      }
      const worker = previous ?? {
        expiresAt: Math.min(expiresAt, now + 3600),
        operationId,
        principalId,
        ...(input.request.signingPublicKey === undefined ? {} : {signingPublicKey: input.request.signingPublicKey}),
        workerId: `gw_${(yield* (yield* Crypto.Crypto).randomUUIDv4()).replaceAll('-', '')}`,
      };
      // Recheck after state I/O and immediately before a durable write or replay acknowledgement.
      const latest = yield* input.readCurrentPolicy;
      const atCommit = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const grant = graphControlGrantExpiry(latest, input.initialPolicy, input.principal, 'graph:contribute', atCommit);
      if (
        authorityDigest(latest) !== authority ||
        grant === undefined ||
        input.principal.expiresAt <= atCommit ||
        worker.expiresAt <= atCommit
      ) {
        return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
      }
      const committed = previous === undefined ? {...worker, expiresAt: Math.min(worker.expiresAt, grant)} : worker;
      if (previous === undefined || retained.length !== document.records.length) {
        yield* writePrivateJsonFile(target, {
          authority,
          records: previous === undefined ? [...retained, committed] : retained,
          schemaVersion: 1,
        });
      }
      return {
        created: previous === undefined,
        body: {
          expiresAt: committed.expiresAt,
          principalId,
          profileDigest: input.initialPolicy.profileDigest,
          repositoryId: input.initialPolicy.repositoryId,
          schemaVersion: 1 as const,
          workerId: committed.workerId,
          ...(committed.signingPublicKey === undefined ? {} : {signingPublicKey: committed.signingPublicKey}),
        },
      };
    }),
  );
});

export const requireGraphControlWorker = Effect.fn('codeGraph.sharing.requireControlWorker')(function* <E, R>(input: {
  readonly home: string;
  readonly initialPolicy: GraphControlPolicy;
  readonly principal: AccessTokenClaims;
  readonly readCurrentPolicy: Effect.Effect<GraphControlPolicy, E, R>;
  readonly workerId: string;
}) {
  const authority = authorityDigest(input.initialPolicy);
  const principalId = sha256Digest(JSON.stringify([input.principal.issuer, input.principal.subject]));
  const grant = Effect.gen(function* () {
    const policy = yield* input.readCurrentPolicy;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const expiresAt = graphControlGrantExpiry(policy, input.initialPolicy, input.principal, 'graph:contribute', now);
    if (authorityDigest(policy) !== authority || expiresAt === undefined || input.principal.expiresAt <= now)
      return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
    return {now, expiresAt};
  });
  yield* grant;
  const target = yield* graphWorkerEnrollmentStatePath(input.home, input.initialPolicy);
  const document = yield* readEnrollmentDocument(target, authority);
  const worker = document.records.find(record => record.workerId === input.workerId);
  const current = yield* grant;
  if (worker === undefined || worker.principalId !== principalId || worker.expiresAt <= current.now)
    return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
  return {
    expiresAt: Math.min(worker.expiresAt, current.expiresAt, input.principal.expiresAt),
    principalId,
    workerId: worker.workerId,
    ...(worker.signingPublicKey === undefined ? {} : {signingPublicKey: worker.signingPublicKey}),
  };
});

/** Publisher-side live authority check; the coordinator never stores a contributor bearer token. */
export const requireGraphControlPublisherWorker = Effect.fn('codeGraph.sharing.requirePublisherWorker')(function* <
  E,
  R,
>(input: {
  readonly home: string;
  readonly initialPolicy: GraphControlPolicy;
  readonly principalId: string;
  readonly readCurrentPolicy: Effect.Effect<GraphControlPolicy, E, R>;
  readonly signingPublicKey: string;
  readonly workerId: string;
}) {
  const authority = authorityDigest(input.initialPolicy);
  const grant = Effect.gen(function* () {
    const policy = yield* input.readCurrentPolicy;
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const matching = policy.grants.find(
      item => sha256Digest(JSON.stringify([policy.issuer, item.subject])) === input.principalId,
    );
    if (authorityDigest(policy) !== authority || matching === undefined)
      return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
    const expiresAt = graphControlGrantExpiry(
      policy,
      input.initialPolicy,
      {issuer: policy.issuer, subject: matching.subject, scopes: new Set(['graph:contribute'])},
      'graph:contribute',
      now,
    );
    if (expiresAt === undefined) return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
    return {expiresAt, now};
  });
  yield* grant;
  const target = yield* graphWorkerEnrollmentStatePath(input.home, input.initialPolicy);
  const document = yield* readEnrollmentDocument(target, authority);
  const worker = document.records.find(record => record.workerId === input.workerId);
  const current = yield* grant;
  if (
    worker === undefined ||
    worker.principalId !== input.principalId ||
    worker.signingPublicKey !== input.signingPublicKey ||
    worker.expiresAt <= current.now
  )
    return yield* GraphControlEnrollmentError.make({code: 'forbidden'});
  return {
    expiresAt: Math.min(worker.expiresAt, current.expiresAt),
    principalId: input.principalId,
    profileDigest: input.initialPolicy.profileDigest,
    repositoryId: input.initialPolicy.repositoryId,
    signingPublicKey: input.signingPublicKey,
    workerId: input.workerId,
  };
});

const readEnrollmentDocument = Effect.fn('codeGraph.sharing.readEnrollmentDocument')(function* (
  target: string,
  authority: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(target))) return {authority, records: [], schemaVersion: 1} satisfies EnrollmentDocument;
  const bytes = yield* readGraphControlBytes(target, 1_048_576);
  const text = yield* Effect.try({
    try: () => new TextDecoder('utf-8', {fatal: true}).decode(bytes),
    catch: () => graphSharingFailure('Graph worker enrollment state is invalid.'),
  });
  const document = yield* Schema.decodeEffect(Schema.fromJsonString(Document), {onExcessProperty: 'error'})(text).pipe(
    Effect.mapError(() => graphSharingFailure('Graph worker enrollment state is invalid.')),
  );
  if (
    document.authority !== authority ||
    new Set(document.records.map(record => record.operationId)).size !== document.records.length ||
    new Set(document.records.map(record => record.workerId)).size !== document.records.length
  )
    return yield* graphSharingFailure('Graph worker enrollment state does not match its authority.');
  return document;
});

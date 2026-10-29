import {Effect, FileSystem, Path, Schema} from 'effect';
import {fromPromiseInterruptible} from '@threadnote/platform/errors';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {generateGraphSharePublisherKey} from '../artifacts.js';
import {readBoundedPrivateBytes, writePrivateJsonFile} from '../atomic.js';
import {sha256Digest, SHA256_DIGEST, SHA256_HEX} from '../digest.js';
import {graphSharingFailure} from '../errors.js';
import {graphSharingLayout} from '../layout.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const Key = Schema.Struct({
  fingerprint: Schema.String.check(Schema.isPattern(SHA256_DIGEST)),
  privateKey: Schema.String.check(Schema.isPattern(/^[0-9a-f]{96}$/u)),
  publicKey: Schema.String.check(Schema.isPattern(SHA256_HEX)),
  schemaVersion: Schema.Literal(1),
});
type Domain = 'attestation' | 'announcement';
const ED25519 = {name: 'Ed25519'} as const;
const failure = () => graphSharingFailure('Graph worker signing identity is invalid or unavailable.');

export const makeGraphWorkerSigner = Effect.fn('codeGraph.sharing.workerSigner')(function* (
  home: string,
  credentialIdentity: string,
) {
  if (!SHA256_DIGEST.test(credentialIdentity)) return yield* failure();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(
    graphSharingLayout(path, home).root,
    'worker-keys',
    Effect2.pipe(credentialIdentity, EffectString.slice(7)) + '.json',
  );
  yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
  return yield* withExclusiveFileLock(
    fs,
    target + '.lock',
    {retryIntervalMilliseconds: 25, staleAfterMilliseconds: 30_000, waitTimeoutMilliseconds: 2_000},
    Effect.gen(function* () {
      let key: typeof Key.Type;
      if (yield* fs.exists(target)) {
        const bytes = yield* readBoundedPrivateBytes(target, 1024);
        key = yield* Schema.decodeEffect(Schema.fromJsonString(Key), {onExcessProperty: 'error'})(
          new TextDecoder().decode(bytes),
        );
      } else {
        key = yield* generateGraphSharePublisherKey();
        yield* writePrivateJsonFile(target, key);
      }
      if (sha256Digest(Buffer.from(key.publicKey, 'hex')) !== key.fingerprint) return yield* failure();
      const privateKey = yield* fromPromiseInterruptible(
        () => crypto.subtle.importKey('pkcs8', Buffer.from(key.privateKey, 'hex'), ED25519, false, ['sign']),
        failure,
      );
      const sign = (domain: Domain, body: Uint8Array) =>
        Effect.gen(function* () {
          const bytes = yield* signingBytes(domain, body);
          return yield* fromPromiseInterruptible(
            () => crypto.subtle.sign(ED25519, privateKey, bytes).then(value => Buffer.from(value).toString('hex')),
            failure,
          );
        });
      const probe = new TextEncoder().encode(credentialIdentity);
      yield* verifyGraphWorkerSignature(key.publicKey, 'attestation', probe, yield* sign('attestation', probe));
      return {publicKey: key.publicKey, sign};
    }),
  ).pipe(Effect.mapError(failure));
});

export const verifyGraphWorkerSignature = Effect.fn('codeGraph.sharing.verifyWorkerSignature')(function* (
  publicKey: string,
  domain: Domain,
  body: Uint8Array,
  signature: string,
) {
  if (!SHA256_HEX.test(publicKey) || !/^[0-9a-f]{128}$/u.test(signature)) return yield* failure();
  const bytes = yield* signingBytes(domain, body);
  const key = yield* fromPromiseInterruptible(
    () => crypto.subtle.importKey('raw', Buffer.from(publicKey, 'hex'), ED25519, false, ['verify']),
    failure,
  );
  const accepted = yield* fromPromiseInterruptible(
    () => crypto.subtle.verify(ED25519, key, Buffer.from(signature, 'hex'), bytes),
    failure,
  );
  if (!accepted) return yield* failure();
});

const signingBytes = Effect.fn('codeGraph.sharing.workerSigningBytes')(function* (domain: Domain, body: Uint8Array) {
  if ((domain !== 'attestation' && domain !== 'announcement') || body.byteLength > 65_536) return yield* failure();
  const prefix = new TextEncoder().encode(`threadnote.graph.worker.${domain}.v1\0`);
  const bytes = new Uint8Array(prefix.byteLength + body.byteLength);
  bytes.set(prefix);
  bytes.set(body, prefix.byteLength);
  return bytes;
});

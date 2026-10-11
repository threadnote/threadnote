import {Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {sha256FileHex} from '@threadnote/platform/digest';
import {readBoundedPrivateBytes, writePrivateBytesFile} from './atomic.js';
import {parseSha256Digest, sha256Digest, sha256HexFromDigest} from './digest.js';
import {graphSharingFailure, graphSharingUnavailable} from './errors.js';
import {graphSharingCasBlobPath} from './layout.js';

export const putCasBytes = Effect.fn('codeGraph.sharing.putCasBytes')(function* (casRoot: string, bytes: Uint8Array) {
  const path = yield* Path.Path;
  const digest = sha256Digest(bytes);
  const destination = graphSharingCasBlobPath(path, casRoot, sha256HexFromDigest(digest));
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(destination)) {
    yield* verifyCasBlob(casRoot, digest);
    return digest;
  }
  yield* writePrivateBytesFile(destination, bytes);
  return digest;
});

export const putCasFile = Effect.fn('codeGraph.sharing.putCasFile')(function* (casRoot: string, sourcePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  if (Option.isSome(yield* fs.readLink(sourcePath).pipe(Effect.option))) {
    return yield* graphSharingFailure('CAS source must not be a symbolic link.');
  }
  const incoming = path.join(casRoot, 'incoming');
  yield* fs.makeDirectory(incoming, {recursive: true, mode: 0o700});
  const staging = path.join(incoming, `${yield* crypto.randomUUIDv4()}.tmp`);
  return yield* Effect.acquireUseRelease(
    fs.copyFile(sourcePath, staging).pipe(Effect.as(staging)),
    stagingPath =>
      Effect.gen(function* () {
        yield* fs.chmod(stagingPath, 0o600);
        const hex = yield* sha256FileHex(stagingPath);
        const digest = parseSha256Digest(hex);
        const destination = graphSharingCasBlobPath(path, casRoot, hex);
        if (Option.isSome(yield* fs.readLink(destination).pipe(Effect.option))) {
          return yield* graphSharingFailure(`CAS object must not be a symbolic link: ${digest}`);
        }
        if (yield* fs.exists(destination)) {
          yield* verifyCasBlob(casRoot, digest);
          return digest;
        }
        yield* fs.makeDirectory(path.dirname(destination), {recursive: true, mode: 0o700});
        yield* fs.rename(stagingPath, destination);
        return digest;
      }),
    stagingPath => fs.remove(stagingPath, {force: true}).pipe(Effect.ignore),
  );
});

export const verifyCasBlob = Effect.fn('codeGraph.sharing.verifyCasBlob')(function* (casRoot: string, digest: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expected = parseSha256Digest(digest, 'CAS digest');
  const target = graphSharingCasBlobPath(path, casRoot, sha256HexFromDigest(expected));
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* graphSharingFailure(`CAS object must not be a symbolic link: ${expected}`);
  }
  if (!(yield* fs.exists(target))) {
    return yield* graphSharingUnavailable(`CAS object is missing: ${expected}`);
  }
  const actual = parseSha256Digest(yield* sha256FileHex(target), 'CAS digest');
  if (actual !== expected) {
    return yield* graphSharingFailure(`CAS object digest mismatch: ${expected}`);
  }
  return target;
});

export const readVerifiedCasBlob = Effect.fn('codeGraph.sharing.readVerifiedCasBlob')(function* (
  casRoot: string,
  digest: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* verifyCasBlob(casRoot, digest);
  return yield* fs.readFile(target);
});

/** Read untrusted local CAS bytes with a fixed memory ceiling before digest verification. */
export const readVerifiedCasBlobBounded = Effect.fn('codeGraph.sharing.readVerifiedCasBlobBounded')(function* (
  casRoot: string,
  digest: string,
  maximum: number,
) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) return yield* graphSharingFailure('CAS read limit is invalid.');
  const expected = parseSha256Digest(digest, 'CAS digest');
  const target = yield* casBlobPath(casRoot, expected);
  const bytes = yield* readBoundedPrivateBytes(target, maximum);
  if (sha256Digest(bytes) !== expected) return yield* graphSharingFailure('CAS object digest mismatch.');
  return bytes;
});

export const casBlobPath = Effect.fn('codeGraph.sharing.casBlobPath')(function* (casRoot: string, digest: string) {
  const path = yield* Path.Path;
  return graphSharingCasBlobPath(path, casRoot, sha256HexFromDigest(digest));
});

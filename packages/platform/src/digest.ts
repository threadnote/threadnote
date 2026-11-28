import {Effect, FileSystem, Stream} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';

export const sha256Hex = Effect.fn('digest.sha256Hex')((value: string | Uint8Array) =>
  Effect.sync(() => sha256HexSync(value)),
);

export const sha256FileHex = Effect.fn('digest.sha256FileHex')(function* (
  path: string,
  options?: {readonly chunkSize: number},
) {
  const fs = yield* FileSystem.FileSystem;
  const hash = yield* Effect.sync(() => new Bun.CryptoHasher('sha256'));
  yield* fs.stream(path, options).pipe(Stream.runForEach(chunk => Effect.sync(() => hash.update(chunk))));
  return yield* Effect.sync(() => hash.digest('hex'));
});

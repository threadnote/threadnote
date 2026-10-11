import {Crypto, Effect, FileSystem, Option, Path, Schema, Stream} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {graphSharingFailure} from './errors.js';

export const writePrivateJsonFile = Effect.fn('codeGraph.sharing.writePrivateJsonFile')(function* (
  destination: string,
  value: unknown,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = path.dirname(destination);
  yield* fs.makeDirectory(parent, {recursive: true, mode: 0o700});
  if (Option.isSome(yield* fs.readLink(destination).pipe(Effect.option))) {
    return yield* graphSharingFailure(`Refusing to replace a graph-sharing symbolic link: ${destination}`);
  }
  const crypto = yield* Crypto.Crypto;
  const temporary = `${destination}.${yield* crypto.randomUUIDv4()}.tmp`;
  yield* fs.writeFileString(temporary, `${JSON.stringify(value)}\n`, {mode: 0o600});
  yield* fs
    .rename(temporary, destination)
    .pipe(Effect.onError(() => fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

/** Data and directory entry must survive before a dependent receipt can be retired. */
export const writeDurablePrivateJsonFile = Effect.fn('codeGraph.sharing.writeDurablePrivateJsonFile')(function* (
  destination: string,
  value: unknown,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* writePrivateJsonFile(destination, value);
  const sync = (target: string) =>
    Effect.scoped(fs.open(target, {flag: 'r'}).pipe(Effect.flatMap(file => file.sync))).pipe(
      Effect.mapError(cause => graphSharingFailure('Could not durably persist the graph frontier pointer.', cause)),
    );
  yield* sync(destination);
  if ((yield* SystemInfo).platform !== 'win32') yield* sync(path.dirname(destination));
});

export const writePrivateBytesFile = Effect.fn('codeGraph.sharing.writePrivateBytesFile')(function* (
  destination: string,
  bytes: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = path.dirname(destination);
  yield* fs.makeDirectory(parent, {recursive: true, mode: 0o700});
  if (Option.isSome(yield* fs.readLink(destination).pipe(Effect.option))) {
    return yield* graphSharingFailure(`Refusing to replace a graph-sharing symbolic link: ${destination}`);
  }
  const crypto = yield* Crypto.Crypto;
  const temporary = `${destination}.${yield* crypto.randomUUIDv4()}.tmp`;
  yield* fs.writeFile(temporary, bytes, {mode: 0o600});
  yield* fs
    .rename(temporary, destination)
    .pipe(Effect.onError(() => fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

export const readJsonFile = Effect.fn('codeGraph.sharing.readJsonFile')(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* graphSharingFailure(`Refusing to read a graph-sharing symbolic link: ${target}`);
  }
  return yield* decodeJsonText(yield* fs.readFileString(target));
});

export const readBoundedPrivateBytes = Effect.fn('codeGraph.sharing.readBoundedPrivateBytes')(function* (
  target: string,
  maximum: number,
) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
    return yield* graphSharingFailure('Graph-sharing metadata must not be a symbolic link.');
  }
  const bytes = Buffer.concat(yield* Stream.runCollect(fs.stream(target, {bytesToRead: maximum + 1})));
  if (bytes.length > maximum) return yield* graphSharingFailure('Graph-sharing metadata exceeds its size limit.');
  return bytes;
});

export const decodeJsonBytes = (bytes: Uint8Array) => decodeJsonText(new TextDecoder().decode(bytes));

const decodeJsonText = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Json), {errors: 'all'})(text).pipe(
    Effect.mapError(cause => graphSharingFailure('Graph-sharing metadata is not valid JSON.', cause)),
  );

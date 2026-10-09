import {sha256HexSync} from '@threadnote/platform/sha256';
import {Crypto, Effect, FileSystem, Path, Schema} from 'effect';
import type {RuntimeConfig} from '@threadnote/workspace/config';

interface DocumentCursor {
  readonly version: 1;
  readonly fingerprint: string;
  readonly requestId: string;
  readonly offset: number;
}
class SuperhumanCursorError extends Schema.TaggedError<SuperhumanCursorError>()('SuperhumanCursorError', {
  message: Schema.String,
}) {}
const cursorPath = Effect.fn('superhuman.cursorPath')(function* (config: RuntimeConfig, sourceId: string) {
  const path = yield* Path.Path;
  return path.join(
    config.agentContextHome,
    'threadnote',
    'sources',
    'superhuman',
    sourceId,
    sha256HexSync(`${config.account}:${config.user}`),
    'work-cursor.json',
  );
});
export const readDocumentCursor = Effect.fn('superhuman.readDocumentCursor')(function* (
  config: RuntimeConfig,
  sourceId: string,
  fingerprint: string,
  requestId: string,
  explicit: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* cursorPath(config, sourceId);
  if (!(yield* fs.exists(path))) return 0;
  const raw = yield* fs.readFileString(path);
  const cursor = yield* Effect.try({
    try: () => JSON.parse(raw) as DocumentCursor,
    catch: () => SuperhumanCursorError.make({message: 'Invalid Superhuman work cursor.'}),
  });
  if (
    !cursor ||
    cursor.version !== 1 ||
    typeof cursor.fingerprint !== 'string' ||
    typeof cursor.requestId !== 'string' ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0
  )
    return yield* SuperhumanCursorError.make({message: 'Invalid Superhuman work cursor.'});
  return cursor.fingerprint === fingerprint && (!explicit || cursor.requestId === requestId) ? cursor.offset : 0;
});
export const writeDocumentCursor = Effect.fn('superhuman.writeDocumentCursor')(function* (
  config: RuntimeConfig,
  sourceId: string,
  fingerprint: string,
  requestId: string,
  offset: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const path = yield* cursorPath(config, sourceId);
  yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
  const temporary = `${path}.${yield* crypto.randomUUIDv4}.tmp`;
  yield* fs.writeFileString(temporary, JSON.stringify({version: 1, fingerprint, requestId, offset}), {mode: 0o600});
  yield* fs.rename(temporary, path).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

import {Effect, FileSystem} from 'effect';
export {isJsonObject} from './config.js';
export const isDirectory = Effect.fn('utils.isDirectory')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  return info._tag === 'Some' && info.value.type === 'Directory';
});
export function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

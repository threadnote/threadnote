import {Array as EffectArray} from 'effect';
import {Crypto, Effect, FileSystem, Path, PlatformError, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {DevSkillsError} from './contract.js';
import * as EffectRecord from 'effect/Record';

export const fail = (code: string, message: string) => DevSkillsError.make({code, message});
export const hash = (content: string | Uint8Array) => sha256HexSync(content);
export function stableJson(value: unknown): string {
  if (EffectArray.isArray(value)) return `[${EffectArray.join(EffectArray.map(value, stableJson), ',')}]`;
  if (isRecord(value))
    return `{${EffectArray.join(
      EffectArray.map(EffectRecord.keys(value).sort(), key => `${JSON.stringify(key)}:${stableJson(value[key])}`),
      ',',
    )}}`;
  return JSON.stringify(value);
}
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !EffectArray.isArray(value);
export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw fail('invalid-state', message);
}
export const decode = <T>(content: string, parse: (value: unknown) => T) =>
  Effect.try({
    try: () => parse(JSON.parse(content)),
    catch: error =>
      Schema.is(DevSkillsError)(error) ? error : fail('invalid-state', 'Invalid development skills state.'),
  });
const missing = (error: PlatformError.PlatformError) => error.reason._tag === 'NotFound';
export const statOptional = Effect.fn('devSkills.statOptional')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(file).pipe(Effect.catchIf(missing, () => Effect.void));
});
/** Check existing ancestors too, including dangling symbolic links. Never turn I/O failures into absence. */
export const assertSafePath = Effect.fn('devSkills.safePath')(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.resolve(file);
  if (absolute !== file) return yield* fail('unsafe-path', `Expected a canonical absolute path: ${file}`);
  const parents: string[] = [];
  for (let current = absolute; ; current = path.dirname(current)) {
    parents.push(current);
    if (path.dirname(current) === current) break;
  }
  parents.reverse();
  const check = Effect.gen(function* () {
    for (const current of parents) {
      const link = yield* fs.readLink(current).pipe(Effect.result);
      if (link._tag === 'Success')
        return yield* fail('unsafe-path', `Symbolic links are not owned destinations: ${current}`);
      if (!['NotFound', 'InvalidArgument', 'Unknown'].includes(link.failure.reason._tag)) return yield* link.failure;
      const info = yield* statOptional(current);
      if (info && current !== absolute && info.type !== 'Directory')
        return yield* fail('unsafe-path', `A destination ancestor is not a directory: ${current}`);
      if (info && (yield* fs.realPath(current)) !== current)
        return yield* fail('unsafe-path', `Noncanonical destination ancestor: ${current}`);
    }
  });
  // A concurrent owner can remove a lock after stat. Recheck every ancestor once,
  // rather than accepting an unchecked replacement or hiding persistent I/O errors.
  yield* check.pipe(
    Effect.catchIf(
      error => PlatformError.isPlatformError(error) && missing(error),
      () => check,
    ),
  );
});
export const readOptional = Effect.fn('devSkills.readOptional')(function* (file: string, limit = 8_000_000) {
  yield* assertSafePath(file);
  const fs = yield* FileSystem.FileSystem;
  const info = yield* statOptional(file);
  if (!info) return null;
  if (info.type !== 'File' || Number(info.size) > limit)
    return yield* fail('invalid-state', `Expected a bounded regular file: ${file}`);
  return yield* fs.readFileString(file);
});
export const compareWrite = Effect.fn('devSkills.compareWrite')(function* (
  file: string,
  before: string | null,
  after: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const actual = yield* readOptional(file);
  if (actual === after) return;
  if (actual !== before) return yield* fail('preimage-conflict', `Content changed; preserved ${file}`);
  if (after === null) {
    yield* fs.remove(file);
    return;
  }
  yield* fs.makeDirectory(path.dirname(file), {recursive: true});
  yield* assertSafePath(file);
  const token = yield* (yield* Crypto.Crypto).randomUUIDv4();
  const temp = `${file}.threadnote-${token}`;
  yield* fs.writeFileString(temp, after, {flag: 'wx', mode: 0o600});
  yield* Effect.gen(function* () {
    if ((yield* readOptional(file)) !== before)
      return yield* fail('preimage-conflict', `Content changed; preserved ${file}`);
    yield* fs.rename(temp, file);
  }).pipe(Effect.ensuring(fs.remove(temp, {force: true}).pipe(Effect.ignore)));
});
export const enumerateFiles = Effect.fn('devSkills.enumerateFiles')(function* (root: string, limit = 2048) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pending = [''];
  const files: string[] = [];
  let visited = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    if (++visited > limit) return yield* fail('inventory-limit', `Directory inventory exceeds its bound: ${root}`);
    const absolute = path.join(root, relative);
    yield* assertSafePath(absolute);
    const info = yield* statOptional(absolute);
    if (!info) continue;
    if (info.type === 'Directory') {
      for (const child of yield* fs.readDirectory(absolute)) pending.push(relative ? `${relative}/${child}` : child);
    } else if (info.type === 'File') files.push(relative);
    else return yield* fail('unsafe-path', `Unsupported filesystem object: ${absolute}`);
  }
  return files.sort();
});

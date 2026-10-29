import {Array as EffectArray} from 'effect';
import {Effect, Path} from 'effect';
import {SystemInfo} from './system.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function assertSafeRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    Effect2.pipe(relativePath, EffectString.startsWith('/')) ||
    Effect2.pipe(relativePath, EffectString.includes('\\')) ||
    EffectArray.some(
      Effect2.pipe(relativePath, EffectString.split('/')),
      segment => segment === '.' || segment === '..' || segment.length === 0,
    )
  ) {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }
  return relativePath;
}

export const expandPath = Effect.fn('utils.expandPath')(function* (path: string) {
  const pathService = yield* Path.Path;
  const system = yield* SystemInfo;
  if (path === '~') {
    return system.homeDirectory;
  }
  if (
    Effect2.pipe(path, EffectString.startsWith(`~${pathService.sep}`)) ||
    Effect2.pipe(path, EffectString.startsWith('~/'))
  ) {
    return pathService.join(system.homeDirectory, Effect2.pipe(path, EffectString.slice(2)));
  }
  return pathService.isAbsolute(path) ? path : pathService.resolve(yield* getInvocationCwd(), path);
});

export const getInvocationCwd = Effect.fn('utils.getInvocationCwd')(function* () {
  const system = yield* SystemInfo;
  return system.environment().THREADNOTE_CALLER_CWD ?? system.currentDirectory();
});

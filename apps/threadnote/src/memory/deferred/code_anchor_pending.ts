import {Array as EffectArray, Effect, FileSystem, Path, String as EffectString} from 'effect';
import {runtimeTextDirectoryNamePage} from '@threadnote/platform/system';
import {
  deferredCodeAnchorError,
  deferredCodeAnchorRouteAncestors,
  inspectPrivateDeferredCodeAnchorDirectories,
  samePrivateDeferredCodeAnchorDirectories,
} from './code_anchor_private_fs.js';

/** Presence-only observation: fixed directory pages, no migration, cursor updates or canonical reads. */
export const privateDeferredCodeAnchorRouteHasEntries = Effect.fn('memoryCodeAnchor.routeHasEntries')(function* (
  root: string,
  keys: readonly string[],
  laneCount: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rootBefore = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, [root]);
  if (rootBefore === undefined) return false;
  const legacy = yield* runtimeTextDirectoryNamePage(root, 72);
  const rootAfter = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, [root]);
  if (rootAfter === undefined || !samePrivateDeferredCodeAnchorDirectories(rootBefore, rootAfter))
    return yield* deferredCodeAnchorError('Deferred code-anchor outbox changed during presence observation.');
  // Unknown/legacy flat entries need the owned migration path before absence can be proved.
  if (legacy.overflow || EffectArray.some(legacy.names, name => EffectString.endsWith('.json')(name))) return true;
  for (const key of keys) {
    for (let lane = 0; lane < laneCount; lane++) {
      const ancestors = deferredCodeAnchorRouteAncestors(path, root, key, lane);
      const before = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestors);
      if (before === undefined) continue;
      const page = yield* runtimeTextDirectoryNamePage(ancestors[ancestors.length - 1], 1);
      const after = yield* inspectPrivateDeferredCodeAnchorDirectories(fs, ancestors);
      if (after === undefined || !samePrivateDeferredCodeAnchorDirectories(before, after))
        return yield* deferredCodeAnchorError('Deferred code-anchor route changed during presence observation.');
      if (page.overflow || page.names.length > 0) return true;
    }
  }
  return false;
});

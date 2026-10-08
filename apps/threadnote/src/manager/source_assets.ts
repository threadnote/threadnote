import {Effect, FileSystem, Path} from 'effect';
import {MANAGER_STATIC_FILES} from '@threadnote/manager/server';
import {toolRoot} from '@threadnote/workspace/installation';
import {ManagerOperationError} from './operation_error.js';

export const assertManagerSourceAssets = Effect.fn('manager.assertSourceAssets')(function* () {
  if (typeof THREADNOTE_STANDALONE !== 'undefined' && THREADNOTE_STANDALONE) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bundle = MANAGER_STATIC_FILES['/app.js'];
  const bundlePath = path.join(yield* toolRoot(), bundle.sourceDirectory ?? bundle.directory ?? 'manager', bundle.path);
  if ((yield* fs.exists(bundlePath)) && (yield* fs.stat(bundlePath)).type === 'File') return;
  return yield* ManagerOperationError.make({
    message: 'Source Manager UI bundle is missing. Run bun run build from the repository root before manage.',
  });
});

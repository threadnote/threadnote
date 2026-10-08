import {Effect, FileSystem, Path} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {validateObsidianIdentifier} from '../obsidian/config.js';

export function withSourceLock<A, E, R>(
  config: Pick<RuntimeConfig, 'agentContextHome'>,
  sourceId: string,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const id = validateObsidianIdentifier(sourceId, 'source id');
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* withExclusiveFileLock(
      fs,
      path.join(config.agentContextHome, 'threadnote', 'source-locks', `${id}.lock`),
      {
        retryIntervalMilliseconds: 25,
        staleAfterMilliseconds: 5 * 60 * 1_000,
        waitTimeoutMilliseconds: 10_000,
      },
      effect,
    );
  });
}

import {Effect, Option, Path} from 'effect';
import {threadnoteStorageLayout} from '@threadnote/store/layout';
import {parseResourceId} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/store/resource-segment';
import type {RuntimeConfig} from '@threadnote/workspace/config';

type LocalMemoryConfig = Pick<RuntimeConfig, 'account' | 'agentContextHome' | 'user'>;

export const localUserMemoriesRoot = Effect.fn('memory.localUserMemoriesRoot')(function* (config: LocalMemoryConfig) {
  const path = yield* Path.Path;
  return threadnoteStorageLayout(path, config.agentContextHome, config.account, uriSegment(config.user))
    .userMemoriesRoot;
});

/** Match canonical storage's segment validation, including valid names such as topic..md. */
export const localMemoryPathForUri = Effect.fn('memory.localMemoryPathForUri')(function* (
  config: LocalMemoryConfig,
  uri: string,
) {
  if (!uri.startsWith(`threadnote://user/${uriSegment(config.user)}/memories/`)) return undefined;
  const parsed = yield* Effect.try(() => parseResourceId(uri)).pipe(Effect.option);
  if (Option.isNone(parsed) || parsed.value.anchor !== undefined) return undefined;
  const path = yield* Path.Path;
  return path.join(yield* localUserMemoriesRoot(config), ...parsed.value.segments.slice(2));
});

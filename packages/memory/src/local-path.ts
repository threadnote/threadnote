import {parseMemoryDocument, type MemoryRecord} from './document.js';
import {Array as EffectArray, Effect, FileSystem, Option, Path} from 'effect';
import {threadnoteStorageLayout} from '@threadnote/store/layout';
import {parseResourceId} from '@threadnote/store/resource-id';
import {uriSegment} from '@threadnote/store/resource-segment';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

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
  if (!Effect2.pipe(uri, EffectString.startsWith(`threadnote://user/${uriSegment(config.user)}/memories/`)))
    return undefined;
  const parsed = yield* Effect.try(() => parseResourceId(uri)).pipe(Effect.option);
  if (Option.isNone(parsed) || parsed.value.anchor !== undefined) return undefined;
  const path = yield* Path.Path;
  return path.join(yield* localUserMemoriesRoot(config), ...parsed.value.segments.slice(2));
});

/** Canonical personal hydration shared by recall composition and its owned reader. */
export const readLocalMemoryRecordsByUri = Effect.fn('memory.readMemoryRecordsByUri')(function* (
  config: LocalMemoryConfig,
  uris: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const records = yield* Effect.forEach(
    uris,
    uri =>
      Effect.gen(function* () {
        const filename = yield* localMemoryPathForUri(config, uri);
        if (!filename) return undefined;
        const info = yield* fs.stat(filename).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== 'File') return undefined;
        const content = yield* fs.readFileString(filename).pipe(Effect.orElseSucceed(() => undefined));
        return content ? parseMemoryDocument(uri, content) : undefined;
      }),
    {concurrency: 16},
  );
  return EffectArray.filter(records, (record): record is MemoryRecord => record !== undefined);
});

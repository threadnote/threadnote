import {Effect} from 'effect';
import {uriSegment} from '@threadnote/workspace/manifest';
import {resolveMemoryReplacementTarget} from '@threadnote/recall/memory/identity';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {localMemoryPathForUri, readTextIfExists} from './migrations.js';
import type {StoreMemoryOptions} from './store_contract.js';

export const resolveLocalMemoryReplacementTarget = Effect.fn('memory.resolveLocalReplacement')(function* (
  config: RuntimeConfig,
  requestedUri: string,
  options: {readonly prepare?: boolean} = {},
) {
  const target = yield* resolveMemoryReplacementTarget(
    config,
    requestedUri,
    [`threadnote://user/${uriSegment(config.user)}/memories`],
    uri =>
      Effect.gen(function* () {
        const path = yield* localMemoryPathForUri(config, uri);
        if (!path) return [];
        const content = yield* readTextIfExists(path);
        const record = content ? parseMemoryDocument(uri, content) : undefined;
        return record ? [record] : [];
      }),
    options,
  );
  return {...target, memoryId: target.record?.metadata.memoryId ?? target.expectedMemoryId};
});

export const resolveStoreMemoryReplacementOptions = Effect.fn('memory.resolveStoreReplacement')(function* (
  config: RuntimeConfig,
  options: StoreMemoryOptions,
) {
  if (!options.replaceUri) return options;
  const replacement = yield* resolveLocalMemoryReplacementTarget(config, options.replaceUri, {prepare: true});
  const memoryId = options.expectedReplaceMemoryId ?? replacement.memoryId ?? options.metadata.memoryId;
  return {
    ...options,
    expectedReplaceContent: options.expectedReplaceContent ?? replacement.record?.content,
    expectedReplaceMemoryId: memoryId,
    metadata: memoryId === options.metadata.memoryId ? options.metadata : {...options.metadata, memoryId},
    replaceUri: replacement.canonicalUri,
  } satisfies StoreMemoryOptions;
});

import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {ResourceStore} from '@threadnote/store/resource-store';
import {runNativeReadTool} from '@threadnote/threadnote/mcp/server/memory';
import {memoryReadResourcesFromNativeResult} from '@threadnote/threadnote/mcp/server/recall';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

const PRESENT_BODY = 'Present memory body for mixed batch read.';

function memoryMetadata(topic: string): MemoryMetadata {
  return {
    kind: 'durable',
    project: 'threadnote',
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: 'codex',
    status: 'active',
    timestamp: '2026-09-10T00:00:00.000Z',
    topic,
  };
}

function memoryUri(topic: string): string {
  return `threadnote://user/tester/memories/durable/projects/threadnote/${topic}.md`;
}

describe('MCP native batch read_context', () => {
  effectIt.effect('returns mixed success when some requested memories are missing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-read-batch-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };
        const presentUri = memoryUri('present-read');
        const missingUri = memoryUri('missing-read');
        const store = yield* ResourceStore;
        yield* store.write(
          {account: config.account, home: config.agentContextHome, user: config.user},
          presentUri,
          formatMemoryDocument('MEMORY', memoryMetadata('present-read'), PRESENT_BODY),
          {mode: 'create'},
        );

        const result = yield* runNativeReadTool(config, [missingUri, presentUri]);
        const texts = EffectArray.map(
          EffectArray.filter(result.content, item => item.type === 'text'),
          item => item.text,
        );
        const rawCanonicalRead = result._meta?.['threadnote.io/canonical-read'];
        const canonicalRead =
          rawCanonicalRead === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(
                Schema.StructWithRest(
                  Schema.Struct({
                    missing: Schema.optional(Schema.Array(Schema.String)),
                    resources: Schema.optional(
                      Schema.Array(
                        Schema.StructWithRest(Schema.Struct({requestedUri: Schema.String}), [
                          Schema.Record(Schema.String, Schema.Unknown),
                        ]),
                      ),
                    ),
                  }),
                  [Schema.Record(Schema.String, Schema.Unknown)],
                ),
              )(rawCanonicalRead);

        expect(result.isError).not.toBe(true);
        expect(EffectArray.some(texts, text => Effect2.pipe(text, EffectString.includes(PRESENT_BODY)))).toBe(true);
        expect(canonicalRead?.missing).toEqual([missingUri]);
        expect(
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(canonicalRead?.resources), __effectArrayReceiver =>
              EffectArray.map(__effectArrayReceiver, resource => resource.requestedUri),
            ),
          ),
        ).toEqual([presentUri]);
        expect(
          EffectOption.getOrUndefined(
            EffectOption.map(
              EffectOption.fromNullishOr(memoryReadResourcesFromNativeResult(result, [missingUri, presentUri])),
              __effectArrayReceiver => EffectArray.map(__effectArrayReceiver, resource => resource.uri),
            ),
          ),
        ).toEqual([presentUri]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps the batch as an error when every requested memory is missing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-read-batch-missing-'});
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: path.join(home, 'seed-manifest.yaml'),
          user: 'tester',
        };

        const result = yield* runNativeReadTool(config, [memoryUri('missing-a'), memoryUri('missing-b')]);
        expect(result.isError).toBe(true);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    effectIt,
    'succeeds for each present URI and errors only when none are present',
    {
      flags: FC.array(FC.boolean(), {maxLength: 4, minLength: 1}),
    },
    ({flags}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-mcp-read-batch-prop-'});
          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath: path.join(home, 'seed-manifest.yaml'),
            user: 'tester',
          };
          const store = yield* ResourceStore;
          const location = {account: config.account, home: config.agentContextHome, user: config.user};
          const uris = EffectArray.map(flags, (_, index) => memoryUri(`batch-${index}`));
          yield* Effect.forEach(
            EffectArray.flatMap(flags, (present, index) => (present ? [index] : [])),
            index =>
              store.write(
                location,
                uris[index],
                formatMemoryDocument('MEMORY', memoryMetadata(`batch-${index}`), `Present body ${index}`),
                {mode: 'create'},
              ),
            {concurrency: 1},
          );

          const result = yield* runNativeReadTool(config, uris);
          const presentCount = EffectArray.filter(flags, Boolean).length;
          const rawCanonicalRead = result._meta?.['threadnote.io/canonical-read'];
          const canonicalRead =
            rawCanonicalRead === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(
                  Schema.StructWithRest(Schema.Struct({resources: Schema.optional(Schema.Array(Schema.Unknown))}), [
                    Schema.Record(Schema.String, Schema.Unknown),
                  ]),
                )(rawCanonicalRead);
          expect(canonicalRead?.resources?.length ?? 0).toBe(presentCount);
          expect(result.isError === true).toBe(presentCount === 0);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 16}},
  );
});

import * as EffectString from 'effect/String';
import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import {Effect, Path} from 'effect';
import * as Effect2 from 'effect';
import {describe, expect} from 'vitest';
import fc from 'fast-check';
import {canonicalResourceUri} from '@threadnote/store/resource-id';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {localMemoryPathForUri, localUserMemoriesRoot} from '../src/local-path.js';
import {Array as EffectArray} from 'effect';

const config = {account: 'local', agentContextHome: '/private/pilot', user: 'tester'};
const prefix = 'threadnote://user/tester/memories/';
const segment = fc
  .array(fc.constantFrom('a', 'b', '.', '-', '_', 'é', ' ', '%', '#'), {maxLength: 12})
  .map(characters => `item${EffectArray.join(characters, '')}x`);

for (const [platform, layer] of [
  ['POSIX', BunPath.layerPosix],
  ['Windows', BunPath.layerWin32],
] as const) {
  describe(`local memory paths on ${platform}`, () => {
    effectIt.layer(layer)(it => {
      it.effect('accepts the pilot filename and rejects unsafe or foreign URIs', () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* localUserMemoriesRoot(config);
          const filename = 'how-source-backed-topic-updates-are-drafted-reviewed-and-safely-accepted..md';
          expect(yield* localMemoryPathForUri(config, `${prefix}durable/projects/pilot/${filename}`)).toBe(
            path.join(root, 'durable', 'projects', 'pilot', filename),
          );
          for (const uri of [
            'threadnote://user/other/memories/durable/topic.md',
            'threadnote://resources/repos/topic.md',
            `${prefix}../outside.md`,
            `${prefix}durable/../../outside.md`,
            `${prefix}durable/%2e%2e/outside.md`,
            `${prefix}durable/%2foutside.md`,
            `${prefix}durable/%5coutside.md`,
            `${prefix}durable\\..\\outside.md`,
            `${prefix}durable//topic.md`,
            `${prefix}durable/%00.md`,
            `${prefix}durable/NUL.md`,
            `${prefix}durable/topic.`,
            `${prefix}durable/topic.md?query=1`,
            `${prefix}durable/topic.md#anchor`,
          ])
            expect(yield* localMemoryPathForUri(config, uri)).toBeUndefined();
        }),
      );

      fcEffectProp(
        it,
        'maps valid encoded segments literally within the owned memory root',
        {folders: fc.array(segment, {minLength: 1, maxLength: 4}), name: segment},
        ({folders, name}) =>
          Effect.gen(function* () {
            const path = yield* Path.Path;
            const root = yield* localUserMemoriesRoot(config);
            const parts = [...folders, `${name}..md`];
            const uri = canonicalResourceUri('user', ['tester', 'memories', ...parts]);
            const mapped = yield* localMemoryPathForUri(config, uri);
            expect(mapped).toBeDefined();
            expect(Effect2.pipe(path.relative(root, mapped!), EffectString.split(path.sep))).toEqual(parts);
          }),
        {fastCheck: {numRuns: 40}},
      );

      fcEffectProp(
        it,
        'rejects parent segments at every generated depth without normalizing them away',
        {before: fc.array(segment, {maxLength: 4}), after: segment, parent: fc.constantFrom('..', '%2e%2e')},
        ({before, after, parent}) =>
          Effect.gen(function* () {
            const relative = EffectArray.join(
              [...EffectArray.map(before, encodeURIComponent), parent, `${encodeURIComponent(after)}.md`],
              '/',
            );
            expect(yield* localMemoryPathForUri(config, prefix + relative)).toBeUndefined();
          }),
        {fastCheck: {numRuns: 40}},
      );
    });
  });
}

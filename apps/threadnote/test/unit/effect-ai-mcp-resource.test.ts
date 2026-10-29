import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {expect, it} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as FC from 'fast-check';
import {Cause, Effect, Exit, Fiber, Layer} from 'effect';
import {describe} from 'vitest';
import {MCP_RESOURCE_READ_MAX_BYTES, readThreadnoteMcpResource} from '@threadnote/threadnote/effect/ai/mcp_resource';
import {ResourceStore} from '@threadnote/store/resource-store';

import {provideTestLayer} from '../helpers/effect-layer.js';

const config = {account: 'local', agentContextHome: '/unused', user: 'test-user'} as const;
const uri = 'threadnote://resources/bounded-resource.txt';
const ResourceTestLayer = Layer.merge(BunServices.layer, TestSystemInfoLayer);

describe('MCP protocol resource reads', () => {
  it.effect('returns the bounded-read error when the store reports truncation', () => {
    const store = resourceStore({
      readBounded: () => Effect.succeed({truncated: true}),
    });

    return Effect.gen(function* () {
      const exit = yield* readThreadnoteMcpResource(config, uri).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(provideTestLayer(Layer.merge(ResourceTestLayer, store)));
  });

  it.effect('preserves cancellation while the authoritative resource read is pending', () => {
    const store = resourceStore({readBounded: () => Effect.never});
    return Effect.gen(function* () {
      const fiber = yield* readThreadnoteMcpResource(config, uri).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    }).pipe(provideTestLayer(Layer.merge(ResourceTestLayer, store)));
  });

  fcEffectProp(
    it,
    'enforces the UTF-8 byte bound after every read even when metadata was stale',
    {
      character: FC.constantFrom('a', 'é', '😀'),
      delta: FC.integer({max: 8, min: -8}),
    },
    ({character, delta}) => {
      const targetBytes = MCP_RESOURCE_READ_MAX_BYTES + delta;
      const characterBytes = Buffer.byteLength(character, 'utf8');
      const count = Math.floor(targetBytes / characterBytes);
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
      const content = `${character.repeat(count)}${'x'.repeat(targetBytes - count * characterBytes)}`;
      const store = resourceStore({
        // Deliberately violate the store's bounded-read contract so this
        // property exercises the protocol boundary's independent byte check.
        readBounded: () => Effect.succeed({content, truncated: false}),
      });
      return Effect.gen(function* () {
        const exit = yield* readThreadnoteMcpResource(config, uri).pipe(Effect.exit);
        expect(Buffer.byteLength(content, 'utf8')).toBe(targetBytes);
        expect(Exit.isSuccess(exit)).toBe(targetBytes <= MCP_RESOURCE_READ_MAX_BYTES);
      }).pipe(provideTestLayer(Layer.merge(ResourceTestLayer, store)));
    },
    {fastCheck: {numRuns: 36}},
  );
});

function resourceStore(options: {readonly readBounded: Parameters<(typeof ResourceStore)['of']>[0]['readBounded']}) {
  return Layer.mock(ResourceStore, {readBounded: options.readBounded});
}

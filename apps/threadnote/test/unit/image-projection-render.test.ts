import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {renderMemoryTextToImages} from '@threadnote/threadnote/image_projection/render';
import {MCP_CLIENT_ENVIRONMENT_KEY} from '@threadnote/threadnote/image_projection/render_profile';
import {provideTestLayer} from '../helpers/effect-layer.js';

const SAMPLE = EffectArray.join(
  Array.from({length: 12}, (_, index) => `Readable memory line ${index}`),
  '\n',
);

describe('image projection render geometry', () => {
  effectIt.effect('uses a narrow 14px strip for Cursor and Copilot and denser Claude pages for Claude Code', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const withClient = (client: string) =>
        renderMemoryTextToImages(SAMPLE).pipe(
          Effect.provideService(
            SystemInfo,
            SystemInfo.of({
              ...system,
              environment: () => ({...system.environment(), [MCP_CLIENT_ENVIRONMENT_KEY]: client}),
            }),
          ),
        );
      const cursor = yield* withClient('cursor');
      const copilot = yield* withClient('copilot');
      const claude = yield* withClient('claude');
      expect(cursor.pages).toHaveLength(1);
      expect(copilot.pages).toHaveLength(1);
      expect(claude.pages).toHaveLength(1);
      expect(cursor.pages[0]?.width).toBeLessThanOrEqual(764);
      expect(copilot.pages[0]?.width).toBe(cursor.pages[0]?.width);
      expect(claude.pages[0]?.width).toBeGreaterThan(cursor.pages[0]?.width ?? 0);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

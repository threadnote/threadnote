import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {fromPromise} from '@threadnote/platform/errors';
import {SystemInfo} from '@threadnote/platform/system';
import {imageProjectionRenderOptions, resolveImageProjectionPxpipeModel} from './render_profile.js';

export interface RenderedMemoryImagePage {
  readonly height: number;
  readonly png: Uint8Array;
  readonly width: number;
}

export interface RenderedMemoryImages {
  readonly droppedChars: number;
  readonly pages: readonly RenderedMemoryImagePage[];
}

export type MemoryImageRenderer = (text: string) => Effect.Effect<RenderedMemoryImages, unknown, SystemInfo>;

export const renderMemoryTextToImages: MemoryImageRenderer = Effect.fn('imageProjection.render')(function* (
  text: string,
) {
  const system = yield* SystemInfo;
  const options = imageProjectionRenderOptions(resolveImageProjectionPxpipeModel(system.environment()));
  const result = yield* fromPromise('render memory text to images', async () => {
    const {renderTextToImages} = await import('pxpipe-proxy/transform');
    return renderTextToImages(text, options);
  });
  return {
    droppedChars: result.droppedChars,
    pages: EffectArray.map(result.pages, page => ({height: page.height, png: page.png, width: page.width})),
  };
});

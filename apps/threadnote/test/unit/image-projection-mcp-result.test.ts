import {describe, expect, it} from 'vitest';
import {mcpCallToolResultWithTelemetryMetadata} from '@threadnote/threadnote/effect/ai/mcp';
import {
  buildImageProjectedReadResult,
  imageProjectionAttemptEligible,
  imageProjectionSourceText,
} from '@threadnote/threadnote/image_projection/mcp_result';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe('image projection MCP results', () => {
  it('skips imaging when a cursor, outline, or section is present', () => {
    expect(imageProjectionAttemptEligible({})).toBe(true);
    expect(imageProjectionAttemptEligible({requestedCursor: 'tnrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})).toBe(false);
    expect(imageProjectionAttemptEligible({mode: 'outline'})).toBe(false);
    expect(imageProjectionAttemptEligible({section: '## Setup'})).toBe(false);
  });

  it('concatenates multiple URIs with headers and omits the body from structuredContent', () => {
    const resources = [
      {text: 'First body tn_abc123', uri: 'threadnote://user/me/memories/durable/projects/threadnote/a.md'},
      {text: 'Second body', uri: 'threadnote://user/me/memories/durable/projects/threadnote/b.md'},
    ];
    const source = imageProjectionSourceText(resources);
    expect(source).toContain('## threadnote://user/me/memories/durable/projects/threadnote/a.md');
    const result = buildImageProjectedReadResult({
      budgetTokens: 1_500,
      pages: [{height: 8, png: PNG, width: 8}],
      resources,
      source,
    });
    expect(result?.structuredContent).toMatchObject({
      complete: true,
      content: '',
      pageCount: 1,
      projection: 'image',
      resource: 1,
      resourceCount: 2,
    });
    expect(result?._meta['threadnote.io/read-page'].resource).toBe(1);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(result?.content), __effectArrayReceiver =>
          EffectArray.some(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(block => block.type === 'text' && Effect.pipe(block.text, EffectString.includes('tn_abc123')))(
                __effectArrayValue,
              ),
          ),
        ),
      ),
    ).toBe(true);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(result?.content), __effectArrayReceiver =>
          EffectArray.some(
            __effectArrayReceiver,
            __effectArrayValue =>
              !!(block =>
                block.type === 'image' &&
                block.mimeType === 'image/png' &&
                Buffer.from(block.data, 'base64')
                  .subarray(0, 8)
                  .equals(Buffer.from(PNG.subarray(0, 8))))(__effectArrayValue),
          ),
        ),
      ),
    ).toBe(true);
    expect(mcpCallToolResultWithTelemetryMetadata(result!)).toMatchObject({
      structuredContent: {projection: 'image', content: ''},
    });
  });

  it('bounds appended warnings', () => {
    const result = buildImageProjectedReadResult({
      budgetTokens: 1_500,
      pages: [{height: 8, png: PNG, width: 8}],
      resources: [{text: 'body', uri: 'threadnote://test/a.md'}],
      source: 'body',
      warnings: [`sync failed: ${Effect.pipe('x', EffectString.repeat(400))}`],
    });
    const caption =
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(result?.content), __effectArrayReceiver =>
          EffectOption.getOrUndefined(EffectArray.findFirst(__effectArrayReceiver, block => block.type === 'text')),
        ),
      )?.text ?? '';
    const warningLine = Effect.pipe(caption, EffectString.split('\n'))[1] ?? '';
    expect(warningLine.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(warningLine, 'utf8')).toBeLessThanOrEqual(160);
    expect(Effect.pipe(warningLine, EffectString.startsWith('sync failed:'))).toBe(true);
  });
});

import {Array as EffectArray} from 'effect';
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {TestError} from '@threadnote/testing/test-error';
import {extractCorpusFile} from '@threadnote/graph/languages/corpus/extractor';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';

const unpdf = vi.hoisted(() => ({getResolvedPDFJS: vi.fn()}));

vi.mock('unpdf', () => unpdf);

describe('PDF.js compatibility', () => {
  beforeEach(() => {
    unpdf.getResolvedPDFJS.mockReset();
  });

  test('extracts mixed text content and annotations, then releases page and document resources', async () => {
    const cleanup = vi.fn();
    const destroy = vi.fn(async () => undefined);
    const getDocument = vi.fn(() => ({
      destroy,
      promise: Promise.resolve({
        getPage: vi.fn(async () => ({
          cleanup,
          getAnnotations: vi.fn(async () => [
            {subtype: 'Link', url: 'https://example.test/runbook'},
            {subtype: 'Text'},
          ]),
          getTextContent: vi.fn(async () => ({
            items: [
              {id: 'section', type: 'beginMarkedContentProps'},
              {hasEOL: true, str: 'first'},
              {id: 'section', type: 'endMarkedContent'},
              {hasEOL: false, str: 'second'},
            ],
          })),
        })),
        numPages: 1,
      }),
    }));
    unpdf.getResolvedPDFJS.mockResolvedValue({getDocument});

    const facts = await extractCorpusFile(pdfFile('docs/compatibility.pdf'));
    const evidence = EffectArray.join(
      EffectArray.map(facts.symbols, symbol => `${symbol.name}\n${symbol.documentation ?? ''}`),
      '\n',
    );

    expect(evidence).toContain('first');
    expect(evidence).toContain('second');
    expect(evidence).not.toContain('beginMarkedContentProps');
    expect(facts.symbols).toContainEqual(expect.objectContaining({name: 'https://example.test/runbook'}));
    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({data: expect.any(Uint8Array), disableFontFace: true, useSystemFonts: true}),
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  test('releases the current page and loading task when caller cancellation interrupts text extraction', async () => {
    const controller = new AbortController();
    const cleanup = vi.fn();
    const destroy = vi.fn(async () => undefined);
    let signalTextStarted!: () => void;
    const textStarted = new Promise<void>(resolve => {
      signalTextStarted = resolve;
    });
    const getTextContent = vi.fn(() => {
      signalTextStarted();
      return new Promise<never>(() => undefined);
    });
    unpdf.getResolvedPDFJS.mockResolvedValue({
      getDocument: vi.fn(() => ({
        destroy,
        promise: Promise.resolve({
          getPage: vi.fn(async () => ({cleanup, getAnnotations: vi.fn(), getTextContent})),
          numPages: 1,
        }),
      })),
    });

    const extraction = extractCorpusFile(pdfFile('docs/cancelled-compatibility.pdf'), {signal: controller.signal});
    await textStarted;
    controller.abort(TestError.make({message: 'compatibility cancellation'}));

    await expect(extraction).rejects.toThrow('compatibility cancellation');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalled();
  });
});

function pdfFile(path: string): CodeGraphInventoryFile {
  return {
    blobId: 'blob',
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    contentHash: `hash:${path}`,
    language: 'office-document',
    mode: '100644',
    path,
    size: 4,
    source: 'commit',
  };
}

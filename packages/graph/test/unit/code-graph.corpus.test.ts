import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {describe, expect, test} from 'vitest';
import fc from 'fast-check';
import {strToU8, zipSync} from 'fflate';
import {Option} from 'effect';
import {extractCorpusFile, joinPdfTextItemsWithinLimit} from '@threadnote/graph/languages/corpus/extractor';
import {
  CORPUS_ARCHIVE_ENTRY_BYTES_LIMIT,
  CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT,
  OPAQUE_CORPUS_MEDIA_EXTENSIONS,
  isOpaqueCorpusMediaPath,
} from '@threadnote/graph/languages/corpus/policy';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import type {CodeGraphInventoryFile} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('code graph corpus extraction', () => {
  test('classifies opaque media by final extension independent of path shape and case', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...OPAQUE_CORPUS_MEDIA_EXTENSIONS),
        fc.array(fc.stringMatching(/^[a-z0-9_-]{1,12}$/u), {maxLength: 4}),
        fc.boolean(),
        (extension, directories, uppercase) => {
          const suffix = uppercase ? Effect.pipe(extension, EffectString.toUpperCase) : extension;
          const path = EffectArray.join([...directories, `asset${suffix}`], '/');
          expect(isOpaqueCorpusMediaPath(path)).toBe(true);
          expect(isOpaqueCorpusMediaPath(`${path}.txt`)).toBe(false);
        },
      ),
      {numRuns: 100},
    );
  });

  test('turns structured text and external references into searchable graph evidence', async () => {
    const facts = await extractCorpusFile(
      textFile(
        'docs/reliability.rst',
        EffectArray.join(
          [
            'Reliability architecture',
            '========================',
            '',
            'Retries use bounded exponential backoff.',
            '',
            'https://example.test/adr',
          ],
          '\n',
        ),
      ),
    );

    expect(EffectArray.map(facts.symbols, symbol => [symbol.kind, symbol.name])).toEqual(
      expect.arrayContaining([
        ['document', 'Reliability'],
        ['section', 'Reliability architecture'],
        ['external-resource', 'https://example.test/adr'],
      ]),
    );
    expect(EffectArray.map(facts.edges, edge => edge.relation)).toEqual(
      expect.arrayContaining(['contains', 'references']),
    );
  });

  test('never exposes script or style bodies through whitespace-tolerant HTML end tags', async () => {
    const facts = await extractCorpusFile(
      textFile(
        'docs/overview.html',
        EffectArray.join(
          [
            '<h1>Public architecture overview</h1>',
            '<script>privateScriptPayload()</script >',
            '<style>.private-style-payload { display: block }</STYLE \n>',
            '<p>Visible operational guidance.</p>',
          ],
          '\n',
        ),
      ),
    );
    const searchableEvidence = EffectArray.join(
      EffectArray.map(facts.symbols, symbol => `${symbol.name}\n${symbol.documentation ?? ''}`),
      '\n',
    );

    expect(searchableEvidence).toContain('Public architecture overview');
    expect(searchableEvidence).toContain('Visible operational guidance');
    expect(searchableEvidence).not.toContain('privateScriptPayload');
    expect(searchableEvidence).not.toContain('private-style-payload');
  });

  test('extracts OpenXML text locally without materializing non-document archive entries', async () => {
    const bytes = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8(
        '<w:document><w:body><w:p><w:r><w:t>Portable incident handoff</w:t></w:r></w:p></w:body></w:document>',
      ),
      'word/media/image.png': new Uint8Array(1_024),
    });
    const facts = await extractCorpusFile(binaryFile('handbook/on-call.docx', bytes));

    expect(facts.diagnostics).toEqual([]);
    expect(
      EffectArray.some(
        facts.symbols,
        symbol =>
          symbol.documentation !== undefined &&
          Effect.pipe(symbol.documentation, EffectString.includes('Portable incident handoff')),
      ),
    ).toBe(true);
    expect(
      EffectArray.some(facts.symbols, symbol => Effect.pipe(symbol.qualifiedName, EffectString.includes('word/media'))),
    ).toBe(false);
  });

  test('rejects a compressed document entry before expanding past the per-entry budget', async () => {
    const bytes = zipSync({'word/document.xml': new Uint8Array(CORPUS_ARCHIVE_ENTRY_BYTES_LIMIT + 1)}, {level: 9});
    const facts = await extractCorpusFile(binaryFile('handbook/oversized.docx', bytes));

    expect(facts.symbols[0]).toMatchObject({kind: 'asset', name: 'Oversized'});
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('per-entry safety budget');
  });

  test('caps inspected and selected archive entries before materializing an archive fan-out', async () => {
    const inspected = await extractCorpusFile(
      binaryFile(
        'handbook/inspected.docx',
        zipSync({
          'ignored-a.bin': strToU8('a'),
          'ignored-b.bin': strToU8('b'),
          'ignored-c.bin': strToU8('c'),
        }),
      ),
      {archiveInspectedEntryLimit: 2},
    );
    const selected = await extractCorpusFile(
      binaryFile(
        'handbook/selected.epub',
        zipSync({
          'chapter-a.html': strToU8('<p>a</p>'),
          'chapter-b.html': strToU8('<p>b</p>'),
          'chapter-c.html': strToU8('<p>c</p>'),
        }),
      ),
      {archiveSelectedEntryLimit: 2},
    );

    expect(inspected.symbols[0]).toMatchObject({kind: 'asset', name: 'Inspected'});
    expect(EffectArray.join(inspected.diagnostics, '\n')).toContain('inspected entry-count safety budget');
    expect(selected.symbols[0]).toMatchObject({kind: 'asset', name: 'Selected'});
    expect(EffectArray.join(selected.diagnostics, '\n')).toContain('selected entry-count safety budget');
  });

  test('deduplicates normalized archive names before expansion', async () => {
    const facts = await extractCorpusFile(
      binaryFile(
        'handbook/deduplicated.docx',
        zipSync({
          'word/document.xml': strToU8('<w:p><w:t>trusted first copy</w:t></w:p>'),
          'WORD//./document.xml': strToU8('<w:p><w:t>shadow duplicate copy</w:t></w:p>'),
        }),
      ),
    );

    const documentation = EffectArray.join(
      EffectArray.map(facts.symbols, symbol => symbol.documentation ?? ''),
      '\n',
    );
    expect(documentation).toContain('trusted first copy');
    expect(documentation).not.toContain('shadow duplicate copy');
  });

  test('orders archive entries naturally without locale-sensitive collation', async () => {
    const facts = await extractCorpusFile(
      binaryFile(
        'handbook/ordered.epub',
        zipSync({
          'chapters/chapter10.xhtml': strToU8('<p>ten</p>'),
          'chapters/chapter2.xhtml': strToU8('<p>two</p>'),
        }),
      ),
    );

    expect(
      EffectArray.map(
        EffectArray.filter(facts.symbols, symbol => symbol.kind === 'section'),
        symbol => symbol.name,
      ),
    ).toEqual(['chapter2', 'chapter10']);
  });

  test('extracts pages and links from a tracked PDF', async () => {
    const facts = await extractCorpusFile(binaryFile('docs/reliability.pdf', minimalPdf('Retry queue architecture')));

    expect(facts.diagnostics).toEqual([]);
    expect(
      EffectArray.some(
        facts.symbols,
        symbol =>
          symbol.documentation !== undefined &&
          Effect.pipe(symbol.documentation, EffectString.includes('Retry queue architecture')),
      ),
    ).toBe(true);
    expect(facts.symbols[0]?.signature).toContain('1 page');
  });

  test('ignores PDF marked-content boundaries while preserving text and explicit line endings', () => {
    expect(
      joinPdfTextItemsWithinLimit(
        [
          {id: 'section', type: 'beginMarkedContentProps'},
          {hasEOL: true, str: 'first'},
          {id: 'section', type: 'endMarkedContent'},
          {hasEOL: false, str: 'second'},
        ],
        12,
      ),
    ).toBe('first\nsecond');
  });

  test('preserves ordered PDF text exactly when it fits and rejects it when it exceeds the remaining budget', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({hasEOL: fc.boolean(), str: fc.string({maxLength: 20})}),
            fc.record({id: fc.string({maxLength: 20}), type: fc.constantFrom('begin', 'beginProps', 'end')}),
          ),
          {maxLength: 30},
        ),
        fc.integer({max: 200, min: 0}),
        (items, maximumCharacters) => {
          const expected = EffectArray.join(
            EffectArray.map(
              EffectArray.filter(
                items,
                (item): item is Extract<(typeof items)[number], {str: string}> => 'str' in item,
              ),
              item => `${item.str}${item.hasEOL ? '\n' : ''}`,
            ),
            '',
          );
          if (expected.length <= maximumCharacters) {
            expect(joinPdfTextItemsWithinLimit(items, maximumCharacters)).toBe(expected);
          } else {
            expect(() => joinPdfTextItemsWithinLimit(items, maximumCharacters)).toThrow('character safety budget');
          }
        },
      ),
      {numRuns: 100},
    );
  });

  test('falls back to metadata when cumulative PDF text exceeds its per-artifact budget', async () => {
    const facts = await extractCorpusFile(binaryFile('docs/text-bomb.pdf', minimalPdf('long extracted text')), {
      maximumExtractedTextCharacters: 4,
    });

    expect(facts.symbols[0]).toMatchObject({kind: 'asset', name: 'Text Bomb'});
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('character safety budget');
  });

  test('enforces the PDF elapsed budget independently of page count', async () => {
    let read = 0;
    const facts = await extractCorpusFile(binaryFile('docs/slow.pdf', minimalPdf('bounded')), {
      maximumElapsedMilliseconds: 1_000,
      monotonicNow: () => (read++ === 0 ? 0 : 2_000),
    });

    expect(facts.symbols[0]).toMatchObject({kind: 'asset', name: 'Slow'});
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('elapsed-time safety budget');
  });

  test('propagates in-flight caller cancellation instead of caching an asset fallback', async () => {
    const controller = new AbortController();
    const extraction = extractCorpusFile(binaryFile('docs/cancelled.pdf', minimalPdf('cancelled')), {
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort(TestError.make({message: 'indexing cancelled'})));

    await expect(extraction).rejects.toThrow('indexing cancelled');
  });

  test('indexes binary media as explicit assets without claiming semantic interpretation', async () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    writeUint32(png, 16, 320);
    writeUint32(png, 20, 200);
    const facts = await extractCorpusFile(binaryFile('diagrams/retry-flow.png', png));

    expect(facts.symbols[0]).toMatchObject({kind: 'asset', name: 'Retry Flow'});
    expect(facts.symbols[0]?.signature).toContain('320×200 pixels');
    expect(facts.diagnostics[0]).toContain('pixels were not interpreted');
  });

  test('indexes textless SVG geometry as metadata without expanding path data into corpus text', async () => {
    const startedAt = performance.now();
    const facts = await extractCorpusFile(
      textFile(
        'diagrams/generated.svg',
        `<svg viewBox="0 0 10 10"><!-- no <text> element --><path d="${Effect.pipe('M0 0 L10 10 ', EffectString.repeat(100_000))}"/></svg>`,
      ),
    );
    const duration = performance.now() - startedAt;

    expect(facts.symbols).toHaveLength(1);
    expect(facts.symbols[0]).toMatchObject({kind: 'asset', name: 'Generated'});
    expect(facts.symbols[0]?.documentation).not.toContain('M0 0');
    expect(EffectArray.join(facts.diagnostics, '\n')).toContain('SVG has no text elements');
    expect(duration).toBeLessThan(1_000);
  });

  test('retains text-bearing SVG diagrams as searchable corpus', async () => {
    const facts = await extractCorpusFile(
      textFile(
        'diagrams/retry.svg',
        '<svg><svg:title>Retry architecture</svg:title><text>Backoff queue</text><path d="M0 0 L10 10"/></svg>',
      ),
    );
    const documentation = EffectArray.join(
      EffectArray.map(facts.symbols, symbol => symbol.documentation ?? ''),
      '\n',
    );

    expect(facts.symbols[0]).toMatchObject({kind: 'document', name: 'Retry'});
    expect(documentation).toContain('Retry architecture');
    expect(documentation).toContain('Backoff queue');
    expect(facts.diagnostics).toEqual([]);
  });

  test('indexes Android adaptive-icon wiring and package provenance without interpreting pixels', async () => {
    const facts = await extractCorpusFile(
      textFile(
        'app/src/main/res/mipmap-anydpi-v33/ic_appicon.xml',
        EffectArray.join(
          [
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
            '  <background android:drawable="@color/ic_appicon_background"/>',
            '  <foreground android:drawable="@drawable/ic_appicon_foreground"/>',
            '  <monochrome android:drawable="@drawable/ic_appicon_monochrome"/>',
            '</adaptive-icon>',
          ],
          '\n',
        ),
      ),
      {},
      {packageName: Option.some(':app'), project: Option.none()},
    );

    expect(facts.symbols[0]).toMatchObject({kind: 'resource', packageName: ':app'});
    expect(
      EffectArray.map(
        EffectArray.filter(facts.symbols, symbol => symbol.kind === 'resource-reference'),
        symbol => symbol.name,
      ),
    ).toEqual(['@color/ic_appicon_background', '@drawable/ic_appicon_foreground', '@drawable/ic_appicon_monochrome']);
    expect(EffectArray.every(facts.symbols, symbol => symbol.packageName === ':app')).toBe(true);
    const resourceReferenceIds = new Set(
      EffectArray.map(
        EffectArray.filter(facts.symbols, symbol => symbol.kind === 'resource-reference'),
        symbol => symbol.id,
      ),
    );
    expect(
      EffectArrayPipe(facts.edges, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (edge, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues &&
            edge.relation === 'references' &&
            edge.targetId !== undefined &&
            resourceReferenceIds.has(edge.targetId),
        ),
      ),
    ).toHaveLength(3);
    expect(facts.diagnostics).toEqual([]);
  });

  test('retains iOS storyboard asset and side-effect-owner identifiers as resource evidence', async () => {
    const facts = await extractCorpusFile(
      textFile(
        'Mobile/Resources/Launch.storyboard',
        '<document><imageView image="AppIconMonochrome" customClass="LaunchImageView"/></document>',
      ),
    );

    expect(facts.symbols[0]).toMatchObject({kind: 'resource'});
    expect(
      EffectArray.map(
        EffectArray.filter(facts.symbols, symbol => symbol.kind === 'resource-reference'),
        symbol => symbol.name,
      ),
    ).toEqual(['AppIconMonochrome', 'LaunchImageView']);
    expect(
      EffectArray.some(
        facts.symbols,
        symbol =>
          symbol.documentation !== undefined &&
          Effect.pipe(symbol.documentation, EffectString.includes('attribute image AppIconMonochrome')),
      ),
    ).toBe(true);
  });

  test('keeps an oversized artifact searchable without materializing or interpreting its bytes', async () => {
    const facts = await extractCorpusFile({
      blobId: 'large-video',
      contentHash: 'large-video-hash',
      contentOmittedReason: 'size-budget',
      language: 'video',
      mode: '100644',
      path: 'recordings/architecture-review.mp4',
      size: CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT + 1,
      source: 'commit',
    });

    expect(facts.symbols[0]).toMatchObject({kind: 'asset', name: 'Architecture Review'});
    expect(facts.diagnostics[0]).toContain('per-artifact extraction safety budget');
  });

  test('keeps intentionally non-hydrated binary media searchable with an accurate diagnostic', async () => {
    const facts = await extractCorpusFile({
      blobId: 'metadata-video',
      contentHash: 'metadata-video-hash',
      contentOmittedReason: 'metadata-only',
      language: 'video',
      mode: '100644',
      path: 'recordings/demo.webm',
      size: 32 * 1_024 * 1_024,
      source: 'commit',
    });

    expect(facts.symbols[0]).toMatchObject({kind: 'asset', name: 'Demo'});
    expect(facts.symbols[0]?.signature).toContain('33554432 bytes');
    expect(facts.diagnostics[0]).toContain('binary media content was not loaded');
    expect(facts.diagnostics[0]).not.toContain('64 MiB');
  });

  test('registers documents and media as corpus files while keeping manifest precedence', () => {
    expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match('architecture/system.pdf')).toMatchObject({
      _tag: 'Some',
      value: {role: 'corpus'},
    });
    expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match('package.json')).toMatchObject({
      _tag: 'Some',
      value: {role: 'manifest'},
    });
    expect(BUILTIN_LANGUAGE_PACK_REGISTRY.match('Mobile/Launch.storyboard')).toMatchObject({
      _tag: 'Some',
      value: {role: 'corpus'},
    });
  });
});

function textFile(path: string, content: string): CodeGraphInventoryFile {
  return {
    blobId: 'blob',
    content,
    contentHash: `hash:${path}`,
    language: 'document',
    mode: '100644',
    path,
    size: content.length,
    source: 'commit',
  };
}

function binaryFile(path: string, bytes: Uint8Array): CodeGraphInventoryFile {
  return {
    blobId: 'blob',
    bytes,
    contentHash: `hash:${path}`,
    language:
      Effect.pipe(path, EffectString.endsWith('.pdf')) || Effect.pipe(path, EffectString.endsWith('.docx'))
        ? 'office-document'
        : 'image',
    mode: '100644',
    path,
    size: bytes.byteLength,
    source: 'commit',
  };
}

function minimalPdf(text: string): Uint8Array {
  const escaped = Effect.pipe(
    text,
    EffectString.replaceAll('\\', '\\\\'),
    EffectString.replaceAll('(', '\\('),
    EffectString.replaceAll(')', '\\)'),
  );
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets: number[] = [];
  EffectArray.forEach(objects, (object, index) => {
    offsets.push(new TextEncoder().encode(output).byteLength);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = new TextEncoder().encode(output).byteLength;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += EffectArray.join(
    EffectArray.map(offsets, offset => `${Effect.pipe(String(offset), EffectString.padStart(10, '0'))} 00000 n \n`),
    '',
  );
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(output);
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

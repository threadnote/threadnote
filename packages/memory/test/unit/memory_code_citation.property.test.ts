import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  createMemoryCodeCitation,
  deriveMemoryCodeCitationId,
  formatMemoryCodeCitation,
  formatMemoryCodeCitationLines,
  MAX_MEMORY_CODE_CITATIONS,
  memoryCodeCitationAnchorId,
  parseMemoryCodeCitation,
  parseMemoryCodeCitationHeaders,
  preserveMemoryCodeCitationAnchor,
  type MemoryCodeCitationInputV1,
  type MemoryCodeCitationTargetV1,
} from '@threadnote/memory/code/citation';

const safeCharacter = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split(''));
const safeText = (minimumLength: number, maximumLength: number) =>
  fc.array(safeCharacter, {maxLength: maximumLength, minLength: minimumLength}).map(characters => characters.join(''));
const repositoryPath = fc
  .array(safeText(1, 16), {maxLength: 5, minLength: 1})
  .map(segments => `${segments.join('/')}.ts`);
const hash = (seed: string) => ({algorithm: 'sha256' as const, value: sha256HexSync(seed)});

const symbolTarget: fc.Arbitrary<MemoryCodeCitationTargetV1> = fc
  .record({
    column: fc.integer({max: 200, min: 1}),
    endColumnDelta: fc.integer({max: 200, min: 0}),
    endLineDelta: fc.integer({max: 20, min: 0}),
    language: safeText(1, 20),
    line: fc.integer({max: 10_000, min: 1}),
    name: safeText(1, 40),
    qualifiedName: safeText(1, 80),
    seed: fc.string({maxLength: 80}),
    signature: fc.option(fc.string({maxLength: 80}), {nil: undefined}),
    symbolKind: safeText(1, 20),
  })
  .map(value => ({
    fragmentCanonicalization: 'utf8-source-span-v1',
    fragmentHash: hash(`fragment:${value.seed}`),
    kind: 'symbol',
    language: value.language,
    name: value.name,
    nodeId: `cgs_${sha256HexSync(`node:${value.seed}`).slice(0, 40)}`,
    qualifiedName: value.qualifiedName,
    ...(value.signature === undefined ? {} : {signatureHash: hash(`signature:${value.signature}`)}),
    span: {
      column: value.column,
      endColumn: value.endLineDelta === 0 ? value.column + Math.max(1, value.endColumnDelta) : value.endColumnDelta + 1,
      endLine: value.line + value.endLineDelta,
      line: value.line,
    },
    symbolKind: value.symbolKind,
  }));

const citationInput: fc.Arbitrary<MemoryCodeCitationInputV1> = fc
  .record({
    dirty: fc.boolean(),
    extractorSet: safeText(1, 40),
    identityKind: fc.constantFrom('local' as const, 'remote' as const),
    path: repositoryPath,
    seed: fc.string({maxLength: 100}),
    sourceGraphContent: fc.boolean(),
    target: fc.oneof(fc.constant({kind: 'file'} as const), symbolTarget),
  })
  .map(value => ({
    extractorSet: value.extractorSet,
    fileContentHash: hash(`file:${value.seed}`),
    path: value.path,
    repositoryId: sha256HexSync(`repository:${value.seed}`),
    repositoryIdentityKind: value.identityKind,
    sourceCommit: sha256HexSync(`commit:${value.seed}`).slice(0, 40),
    sourceDirty: value.dirty,
    ...(value.sourceGraphContent
      ? {sourceGraphContentId: `cgc_${sha256HexSync(`graph:${value.seed}`).slice(0, 40)}`}
      : {}),
    sourceSnapshotId: `cgsn_${sha256HexSync(`snapshot:${value.seed}`).slice(0, 40)}`,
    target: value.target,
    version: 1,
  }));

describe('memory code citation properties', () => {
  it('round-trips retention coverage without changing evidence or logical anchor identity', () => {
    fc.assert(
      fc.property(
        citationInput,
        fc.constantFrom('capsule-retained' as const, 'unavailable' as const),
        (input, evidenceRetention) => {
          const original = createMemoryCodeCitation(input);
          const retained = createMemoryCodeCitation({...input, evidenceRetention});
          expect(retained.id).toBe(original.id);
          expect(memoryCodeCitationAnchorId(retained)).toBe(memoryCodeCitationAnchorId(original));
          const encoded = formatMemoryCodeCitation(retained);
          expect(parseMemoryCodeCitation(encoded)).toEqual({ok: true, citation: retained});
          expect(formatMemoryCodeCitation(original)).not.toContain('evidenceRetention');
        },
      ),
      {numRuns: 100},
    );
    const original = createMemoryCodeCitation(sampleCitationInput);
    for (const evidenceRetention of ['', 'forever', null, false])
      expect(parseMemoryCodeCitation(JSON.stringify({...original, evidenceRetention}))).toMatchObject({
        ok: false,
        error: {reason: 'invalid-shape'},
      });
  });
  it('round-trips original identity through arbitrary bounded replacement chains without changing evidence identity', () => {
    fc.assert(
      fc.property(citationInput, fc.array(citationInput, {minLength: 1, maxLength: 4}), (input, replacements) => {
        const original = createMemoryCodeCitation(input);
        const originalWire = formatMemoryCodeCitation(original);
        let current = original;
        for (const replacementInput of replacements) {
          const captured = createMemoryCodeCitation(replacementInput);
          current = preserveMemoryCodeCitationAnchor(current, captured);
          expect(current.id).toBe(captured.id);
          const parsed = parseMemoryCodeCitation(formatMemoryCodeCitation(current));
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) throw new Error('Expected canonical citation');
          current = parsed.citation;
          expect(memoryCodeCitationAnchorId(current)).toBe(original.id);
          expect(current.fileContentHash).toEqual(captured.fileContentHash);
        }
        expect(formatMemoryCodeCitation(original)).toBe(originalWire);
      }),
      {numRuns: 80},
    );
  });

  it('rejects duplicate anchor lineage, malformed IDs and conflicting replacement lineage', () => {
    const original = createMemoryCodeCitation(sampleCitationInput);
    const replacement = preserveMemoryCodeCitationAnchor(
      original,
      createMemoryCodeCitation({...sampleCitationInput, path: 'src/new.ts'}),
    );
    expect(() => formatMemoryCodeCitationLines([original, replacement])).toThrow('unique');
    expect(
      parseMemoryCodeCitationHeaders([formatMemoryCodeCitation(original), formatMemoryCodeCitation(replacement)], 5)
        .errors,
    ).toEqual([{index: 1, reason: 'duplicate-id'}]);
    for (const anchorId of ['', 'tncc_short', `tncc_${'A'.repeat(40)}`, `${original.id}\n`]) {
      expect(parseMemoryCodeCitation(JSON.stringify({...replacement, anchorId}))).toMatchObject({
        ok: false,
        error: {reason: 'invalid-shape'},
      });
    }
    const unrelated = createMemoryCodeCitation({...sampleCitationInput, path: 'src/unrelated.ts'});
    expect(() => preserveMemoryCodeCitationAnchor(original, {...replacement, anchorId: unrelated.id})).toThrow(
      'identity',
    );
  });

  it('round-trips canonical citations and derives the same identity regardless of object key insertion order', () => {
    fc.assert(
      fc.property(citationInput, input => {
        const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as MemoryCodeCitationInputV1;
        const citation = createMemoryCodeCitation(input);
        const citationFromReorderedInput = createMemoryCodeCitation(reordered);
        const encoded = formatMemoryCodeCitation(citation);
        const parsed = parseMemoryCodeCitation(encoded);

        expect(citationFromReorderedInput).toEqual(citation);
        expect(deriveMemoryCodeCitationId(reordered)).toBe(citation.id);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.citation).toEqual(citation);
          expect(formatMemoryCodeCitation(parsed.citation)).toBe(encoded);
          expect(Object.isFrozen(parsed.citation)).toBe(true);
          expect(Object.isFrozen(parsed.citation.fileContentHash)).toBe(true);
          expect(Object.isFrozen(parsed.citation.target)).toBe(true);
        }
      }),
      {numRuns: 250},
    );
  });

  it('detects any valid-looking identity tamper instead of accepting caller-supplied hashes', () => {
    fc.assert(
      fc.property(citationInput, input => {
        const encoded = formatMemoryCodeCitation(createMemoryCodeCitation(input));
        const wire = JSON.parse(encoded) as {id: string};
        wire.id = `${wire.id.slice(0, -1)}${wire.id.endsWith('0') ? '1' : '0'}`;

        expect(parseMemoryCodeCitation(JSON.stringify(wire))).toEqual({
          error: {reason: 'id-mismatch'},
          ok: false,
        });
      }),
      {numRuns: 150},
    );
  });

  it('rejects header-injection characters across path and semantic locator fields', () => {
    fc.assert(
      fc.property(citationInput, fc.constantFrom('\n', '\r', '\0', '\u0085', '\u2028', '\u2029'), (input, control) => {
        expect(() => createMemoryCodeCitation({...input, path: `${input.path}${control}status: archived`})).toThrow(
          'invalid shape',
        );
        const target = input.target;
        if (target.kind === 'symbol') {
          expect(() =>
            createMemoryCodeCitation({
              ...input,
              target: {...target, qualifiedName: `${target.qualifiedName}${control}topic: injected`},
            }),
          ).toThrow('invalid shape');
        }
      }),
      {numRuns: 150},
    );
  });

  it('accepts bounded unique sets without mutation and rejects one citation beyond the count bound', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(citationInput, {
          maxLength: MAX_MEMORY_CODE_CITATIONS,
          selector: input => `${input.repositoryId}:${input.path}:${input.target.kind}`,
        }),
        inputs => {
          const citations = inputs.map(createMemoryCodeCitation);
          const before = JSON.stringify(citations);
          expect(formatMemoryCodeCitationLines(citations)).toHaveLength(citations.length);
          expect(JSON.stringify(citations)).toBe(before);
        },
      ),
      {numRuns: 150},
    );

    const tooMany = Array.from({length: MAX_MEMORY_CODE_CITATIONS + 1}, (_, index) =>
      createMemoryCodeCitation({
        ...sampleCitationInput,
        path: `src/${index}.ts`,
      }),
    );
    expect(() => formatMemoryCodeCitationLines(tooMany)).toThrow(`at most ${MAX_MEMORY_CODE_CITATIONS}`);
  });
});

const sampleCitationInput: MemoryCodeCitationInputV1 = {
  extractorSet: 'native-code-graph-13',
  fileContentHash: hash('file'),
  path: 'src/example.ts',
  repositoryId: sha256HexSync('repository'),
  repositoryIdentityKind: 'remote',
  sourceCommit: sha256HexSync('commit').slice(0, 40),
  sourceDirty: false,
  sourceGraphContentId: `cgc_${sha256HexSync('graph').slice(0, 40)}`,
  sourceSnapshotId: `cgsn_${sha256HexSync('snapshot').slice(0, 40)}`,
  target: {kind: 'file'},
  version: 1,
};

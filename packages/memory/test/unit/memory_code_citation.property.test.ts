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

import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray, Schema} from 'effect';

const safeCharacter = fc.constantFrom(
  ...Effect.pipe('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-', EffectString.split('')),
);
const safeText = (minimumLength: number, maximumLength: number) =>
  fc
    .array(safeCharacter, {maxLength: maximumLength, minLength: minimumLength})
    .map(characters => EffectArray.join(characters, ''));
const repositoryPath = fc
  .array(safeText(1, 16), {maxLength: 5, minLength: 1})
  .map(segments => `${EffectArray.join(segments, '/')}.ts`);
const decodeCitationWire = Schema.decodeUnknownSync(
  Schema.StructWithRest(Schema.Struct({id: Schema.String}), [Schema.Record(Schema.String, Schema.Unknown)]),
);
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
    nodeId: `cgs_${Effect.pipe(sha256HexSync(`node:${value.seed}`), EffectString.slice(0, 40))}`,
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

// Actual full/direct/overlay/alias/forced identities emitted by the graph V2 factory
// for logical cgsn_ + 40 a's, direct base, and optional force generation of 16 b's.
// Keep the corpus independent of this lower-level memory codec and its package dependencies.
const actualV2Snapshots = [
  'cgsn_04388f0282d68de40b7a7ec29bb4f0d48c29830b-lx2',
  'cgsn_dc5c1b9a8514d3681982e39052b7020e745817f8-lx2',
  'cgsn_79b3ccde5379dfc9e27d1c2582a1b803c408d416-lx2',
  'cgsn_c55f118a9fd03ded0005612eeb6697b29146f3d0-lx2',
  'cgsn_1c8cf7af3951f53a7ad6877c205bb1b75e10fc03-lx2',
] as const;

const citationInput: fc.Arbitrary<MemoryCodeCitationInputV1> = fc
  .record({
    dirty: fc.boolean(),
    extractorSet: safeText(1, 40),
    identityKind: fc.constantFrom('local' as const, 'remote' as const),
    path: repositoryPath,
    seed: fc.string({maxLength: 100}),
    sourceGraphContent: fc.boolean(),
    graphContentUsesSnapshot: fc.boolean(),
    legacySuffix: fc.constantFrom('', '-direct', '-full-bbbbbbbbbbbbbbbb'),
    actualV2Snapshot: fc.option(fc.constantFrom(...actualV2Snapshots), {nil: undefined}),
    target: fc.oneof(fc.constant({kind: 'file'} as const), symbolTarget),
  })
  .map(value => {
    const sourceSnapshotId =
      value.actualV2Snapshot ??
      `cgsn_${Effect.pipe(sha256HexSync(`snapshot:${value.seed}`), EffectString.slice(0, 40))}${value.legacySuffix}`;
    return {
      extractorSet: value.extractorSet,
      fileContentHash: hash(`file:${value.seed}`),
      path: value.path,
      repositoryId: sha256HexSync(`repository:${value.seed}`),
      repositoryIdentityKind: value.identityKind,
      sourceCommit: Effect.pipe(sha256HexSync(`commit:${value.seed}`), EffectString.slice(0, 40)),
      sourceDirty: value.dirty,
      ...(value.sourceGraphContent
        ? {
            sourceGraphContentId: value.graphContentUsesSnapshot
              ? sourceSnapshotId
              : `cgc_${Effect.pipe(sha256HexSync(`graph:${value.seed}`), EffectString.slice(0, 40))}`,
          }
        : {}),
      sourceSnapshotId,
      target: value.target,
      version: 1,
    };
  });

describe('memory code citation properties', () => {
  it('round trips actual V2 and legacy identities without accepting future or mixed physical shapes', () => {
    const logical = 'cgsn_' + EffectString.repeat(40)('a');
    for (const sourceSnapshotId of [
      logical,
      logical + '-direct',
      logical + '-full-bbbbbbbbbbbbbbbb',
      ...actualV2Snapshots,
    ]) {
      const input = {...sampleCitationInput, sourceSnapshotId, sourceGraphContentId: sourceSnapshotId};
      const citation = createMemoryCodeCitation(input);
      expect(parseMemoryCodeCitation(formatMemoryCodeCitation(citation))).toEqual({ok: true, citation});
      expect(citation.sourceSnapshotId).toBe(sourceSnapshotId);
      expect(citation.sourceGraphContentId).toBe(sourceSnapshotId);
    }
    for (const malformed of [
      logical + '-lx3',
      logical + '-lx02',
      logical + '-lx2-direct',
      logical + '-direct-lx2',
      logical + '-full-bbbbbbbbbbbbbbbb-lx2',
      logical + '-lx2-extra',
      'cgsn_' + EffectString.repeat(39)('a') + '-lx2',
      'cgsn_' + EffectString.repeat(41)('a') + '-lx2',
      'cgsn_' + EffectString.repeat(40)('A') + '-lx2',
      actualV2Snapshots[0] + '\n',
      ' ' + actualV2Snapshots[0],
    ]) {
      expect(() => createMemoryCodeCitation({...sampleCitationInput, sourceSnapshotId: malformed})).toThrow(
        'invalid shape',
      );
      expect(() => createMemoryCodeCitation({...sampleCitationInput, sourceGraphContentId: malformed})).toThrow(
        'invalid shape',
      );
    }
    expect(() =>
      createMemoryCodeCitation({
        ...sampleCitationInput,
        sourceGraphContentId: 'cgc_' + EffectString.repeat(40)('a') + '-lx2',
      }),
    ).toThrow('invalid shape');
    const original = createMemoryCodeCitation({
      ...sampleCitationInput,
      sourceSnapshotId: actualV2Snapshots[0],
      sourceGraphContentId: actualV2Snapshots[0],
    });
    for (const field of ['sourceSnapshotId', 'sourceGraphContentId'] as const)
      expect(parseMemoryCodeCitation(JSON.stringify({...original, [field]: actualV2Snapshots[1]}))).toEqual({
        ok: false,
        error: {reason: 'id-mismatch'},
      });
  });

  it('preserves the control-character contract across arbitrary UTF-16 text', () => {
    const codeUnits = fc.oneof(
      fc.array(fc.integer({min: 0, max: 0xffff}), {maxLength: 48}),
      fc.constantFrom(
        [0],
        [31],
        [32],
        [126],
        [127],
        [128],
        [133],
        [134],
        [0x2028],
        [0x2029],
        [0xd800],
        [0xdc00],
        [0xd800, 0xdc00],
      ),
    );
    fc.assert(
      fc.property(citationInput, codeUnits, (input, units) => {
        const extractorSet = 'x' + String.fromCharCode(...units);
        const rejected = EffectArray.some(
          units,
          unit => unit <= 0x1f || unit === 0x7f || unit === 0x85 || unit === 0x2028 || unit === 0x2029,
        );
        const create = () => createMemoryCodeCitation({...input, extractorSet});
        if (rejected) expect(create).toThrow();
        else expect(create().extractorSet).toBe(extractorSet);
      }),
      {numRuns: 300},
    );
  });

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
    for (const anchorId of [
      '',
      'tncc_short',
      `tncc_${Effect.pipe('A', EffectString.repeat(40))}`,
      `${original.id}\n`,
    ]) {
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
        const reordered = {...input};
        for (const key of Reflect.ownKeys(input).reverse()) {
          Reflect.deleteProperty(reordered, key);
          Reflect.set(reordered, key, Reflect.get(input, key));
        }
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
        const wire = {...decodeCitationWire(JSON.parse(encoded))};
        wire.id = `${Effect.pipe(wire.id, EffectString.slice(0, -1))}${Effect.pipe(wire.id, EffectString.endsWith('0')) ? '1' : '0'}`;

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
          const citations = EffectArray.map(inputs, createMemoryCodeCitation);
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
  sourceCommit: Effect.pipe(sha256HexSync('commit'), EffectString.slice(0, 40)),
  sourceDirty: false,
  sourceGraphContentId: `cgc_${Effect.pipe(sha256HexSync('graph'), EffectString.slice(0, 40))}`,
  sourceSnapshotId: `cgsn_${Effect.pipe(sha256HexSync('snapshot'), EffectString.slice(0, 40))}`,
  target: {kind: 'file'},
  version: 1,
};

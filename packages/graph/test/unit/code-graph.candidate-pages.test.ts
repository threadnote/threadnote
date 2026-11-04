import {candidateSynopsis} from '@threadnote/graph/store/resolution/candidate_synopsis';
import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  CANDIDATE_CODEC_BUFFER_BYTES,
  CANDIDATE_PAGE_LOGICAL_BYTES,
  CANDIDATE_PAGE_RAW_BYTES,
  candidateCanonicalSha,
  candidateBytesEqual,
  candidateFilePages,
  candidatePairHint,
  candidateTextRepresentable,
  canonicalCandidatePairs,
  compareCandidatePair,
  decodeCandidatePage,
  type CandidatePair,
  type CandidatePage,
} from '@threadnote/graph/store/resolution/candidate_pages';

const envelope = (page: CandidatePage) => ({...page, entryCount: page.pairs.length});
const scalar = fc
  .array(fc.constantFrom('a', 'Z', '\0', ':', '/', '%3A', 'é', '漢', '🙂', '\ue000', '\ufeff'), {maxLength: 50})
  .map(parts => EffectArray.join(parts, ''));

describe('complete file-owned candidate key pages', () => {
  it('round-trips exact original pairs with an independent UTF8 ordering and deduplication oracle', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(scalar, scalar), {maxLength: 150}), input => {
        const before = structuredClone(input);
        const expected = EffectArray.map(
          [...new Set(EffectArray.map(input, pair => JSON.stringify(pair)))],
          (value): CandidatePair => {
            const pair: unknown = JSON.parse(value);
            if (
              !EffectArray.isArray(pair) ||
              pair.length !== 2 ||
              typeof pair[0] !== 'string' ||
              typeof pair[1] !== 'string'
            )
              throw new Error('Independent pair oracle is invalid.');
            return [pair[0], pair[1]];
          },
        ).sort(
          (a, b) =>
            Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) ||
            Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])),
        );
        const canonical = canonicalCandidatePairs(input);
        const pages = [...candidateFilePages(canonical)];
        const decoded = EffectArray.flatMap(pages, page => decodeCandidatePage(page.payload!, envelope(page)));
        expect(canonical).toEqual(expected);
        expect(decoded).toEqual(expected);
        expect(candidateCanonicalSha(decoded)).toBe(candidateCanonicalSha(expected));
        expect(
          EffectArray.every(pages, page => page.pairs.length <= 64 && page.rawBytes <= CANDIDATE_PAGE_RAW_BYTES),
        ).toBe(true);
        expect(input).toEqual(before);
      }),
      {numRuns: 80},
    );
  });

  it('matches independent full length-framed SHA hints without ambiguous delimiter identities', () => {
    fc.assert(
      fc.property(fc.tuple(scalar, scalar), pair => {
        const d = Buffer.from(pair[0]);
        const k = Buffer.from(pair[1]);
        const header = Buffer.alloc(8);
        header.writeUInt32BE(d.byteLength, 0);
        header.writeUInt32BE(k.byteLength, 4);
        const bytes = Buffer.concat([Buffer.from('cgp3-sha256-first16-length-framed-pair-v1\0'), header, d, k]);
        const expected = Buffer.from(Bun.SHA256.hash(bytes, 'hex'), 'hex').subarray(0, 16);
        expect(candidatePairHint(pair)).toEqual(new Uint8Array(expected));
      }),
      {numRuns: 100},
    );
    expect(candidatePairHint(['a\0b', 'c'])).not.toEqual(candidatePairHint(['a', 'b\0c']));
    expect(compareCandidatePair(['domain', '🙂'], ['domain', '\ue000'])).toBeGreaterThan(0);
  });

  it('preserves leading and repeated BOM content in raw and compressed identities', () => {
    const frame = (pair: CandidatePair) => {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(Buffer.byteLength(pair[0]), 0);
      header.writeUInt32BE(Buffer.byteLength(pair[1]), 4);
      return Buffer.concat([header, Buffer.from(pair[0]), Buffer.from(pair[1])]);
    };
    const inputs: CandidatePair[][] = [
      [['\ufeffd', '\ufeff\ufeffk']],
      Array.from({length: 64}, (_, i) => [
        `\ufeff\ufeffdomain-${i}`,
        `\ufeff${EffectString.repeat(40)('repeated')}-${i}`,
      ]),
    ];
    for (const [index, input] of inputs.entries()) {
      const expected = [...input].sort(
        (a, b) =>
          Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) || Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])),
      );
      const page = [...candidateFilePages(canonicalCandidatePairs(input))][0];
      expect(page.codec).toBe(index === 0 ? 'raw-v1' : 'zlib3-v1');
      expect(decodeCandidatePage(page.payload!, envelope(page))).toEqual(expected);
      expect(candidateCanonicalSha(expected)).toBe(
        Bun.SHA256.hash(Buffer.concat(EffectArray.map(expected, frame)), 'hex'),
      );
      for (const pair of expected)
        expect(candidatePairHint(pair)).toEqual(
          new Uint8Array(
            Buffer.from(
              Bun.SHA256.hash(
                Buffer.concat([Buffer.from('cgp3-sha256-first16-length-framed-pair-v1\0'), frame(pair)]),
                'hex',
              ),
              'hex',
            ).subarray(0, 16),
          ),
        );
    }
  });

  it('keeps exact normal/literal logical boundaries without raising their limits', () => {
    const normal = [...candidateFilePages([['d', EffectString.repeat(65536 - 17)('x')]])][0];
    expect(normal.rawBytes).toBe(65536);
    expect(normal.codec).not.toBe('literal-pair-v1');
    expect([...candidateFilePages([['d', EffectString.repeat(65537 - 17)('x')]])][0].codec).toBe('literal-pair-v1');
    const literal = [...candidateFilePages([['d', EffectString.repeat(CANDIDATE_PAGE_LOGICAL_BYTES - 17)('x')]])][0];
    expect(literal.rawBytes).toBe(CANDIDATE_PAGE_LOGICAL_BYTES);
    expect(literal.payload).toBeUndefined();
    expect(() => [
      ...candidateFilePages([['d', EffectString.repeat(CANDIDATE_PAGE_LOGICAL_BYTES - 16)('x')]]),
    ]).toThrow();
  });

  it('retains first/last slots across64/65 and128/129 boundaries', () => {
    const pairs: CandidatePair[] = Array.from({length: 130}, (_, i) => [
      'domain',
      `key-${EffectString.padStart(4, '0')(String(i))}`,
    ]);
    const pages = [...candidateFilePages(pairs)];
    expect(EffectArray.map(pages, p => ({ordinal: p.ordinal, count: p.pairs.length}))).toEqual([
      {ordinal: 0, count: 64},
      {ordinal: 1, count: 64},
      {ordinal: 2, count: 2},
    ]);
    for (const page of pages) {
      expect(decodeCandidatePage(page.payload!, envelope(page))).toEqual(page.pairs);
      expect(page.synopsis).toEqual(candidateSynopsis(EffectArray.map(page.pairs, candidatePairHint)));
    }
    expect(pages[0].pairs[63]).toEqual(pairs[63]);
    expect(pages[1].pairs[0]).toEqual(pairs[64]);
    expect(pages[2].pairs[1]).toEqual(pairs[129]);
  });

  it('keeps legal large literal pairs without allocating a full encoded/compressed page', () => {
    const pair: CandidatePair = ['domain', `prefix${EffectString.repeat(70_000)('x')}🙂`];
    const pages = [...candidateFilePages([pair])];
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({codec: 'literal-pair-v1', ordinal: 0, pairs: [pair]});
    expect(pages[0].payload).toBeUndefined();
    expect(pages[0].rawBytes).toBeGreaterThan(CANDIDATE_PAGE_RAW_BYTES);
    expect(pages[0].rawBytes).toBeLessThan(CANDIDATE_PAGE_LOGICAL_BYTES);
    expect(CANDIDATE_CODEC_BUFFER_BYTES).toBeLessThan(8 * 1_048_576);
    expect(() => decodeCandidatePage(new Uint8Array(), envelope(pages[0]))).toThrow();
    const wrappedPair: CandidatePair = [
      'domain',
      `${EffectString.repeat(4_095)('x')}🙂${EffectString.repeat(70_000)('y')}`,
    ];
    // Independent one-shot framing crosses the streaming UTF16 chunk boundary.
    const header = Buffer.alloc(8);
    header.writeUInt32BE(Buffer.byteLength(wrappedPair[0]), 0);
    header.writeUInt32BE(Buffer.byteLength(wrappedPair[1]), 4);
    const expected = Bun.SHA256.hash(
      Buffer.concat([
        Buffer.from('cgp3-sha256-first16-length-framed-pair-v1\0'),
        header,
        Buffer.from(wrappedPair[0]),
        Buffer.from(wrappedPair[1]),
      ]),
      'hex',
    );
    expect(candidatePairHint(wrappedPair)).toEqual(new Uint8Array(Buffer.from(expected, 'hex').subarray(0, 16)));
  });

  it('rejects corrupt/trailing stored envelopes, oversized metadata and malformed frames before unbounded decoding', () => {
    const pairs: CandidatePair[] = Array.from({length: 64}, (_, i) => [
      'domain',
      `repeated-${EffectString.repeat(60)('payload')}-${i}`,
    ]);
    const page = [...candidateFilePages(canonicalCandidatePairs(pairs))][0];
    expect(page.codec).toBe('zlib3-v1');
    expect(() => decodeCandidatePage(new Uint8Array([...page.payload!, 0]), envelope(page))).toThrow();
    expect(() => decodeCandidatePage(page.payload!, {...envelope(page), rawBytes: 8 * 1_048_576})).toThrow();
    expect(() => decodeCandidatePage(page.payload!, {...envelope(page), entryCount: 65})).toThrow();
    const changed = new Uint8Array(page.payload!);
    changed[changed.length - 1] ^= 1;
    expect(() => decodeCandidatePage(changed, envelope(page))).toThrow();
    const raw = [...candidateFilePages([['domain', 'key']])][0];
    const wrongCount = new Uint8Array(raw.payload!);
    new DataView(wrongCount.buffer).setUint32(4, 64, false);
    expect(() =>
      decodeCandidatePage(wrongCount, {
        ...envelope(raw),
        storedSha: Bun.SHA256.hash(wrongCount, 'hex'),
        rawSha: Bun.SHA256.hash(wrongCount, 'hex'),
      }),
    ).toThrow();
  });

  it('keeps long BMP prefixes and astral-vs-BMP ordering exact through the native fast path', () => {
    const prefix = EffectString.repeat(16000)('a');
    const pairs: CandidatePair[] = [
      ['d', prefix + '\ue000'],
      ['d', prefix + '🙂'],
      ['d', prefix + '\uffff'],
      ['d', prefix + '\ufeff'],
      ['d', prefix + '\0'],
    ];
    const expected = [...pairs].sort(
      (a, b) =>
        Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])) || Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])),
    );
    const pages = [...candidateFilePages(canonicalCandidatePairs(pairs))];
    expect(EffectArray.flatMap(pages, page => decodeCandidatePage(page.payload!, envelope(page)))).toEqual(expected);
    expect(candidateTextRepresentable('\udfff')).toBe(false);
    expect(candidateTextRepresentable('\ud800x')).toBe(false);
    expect(candidateTextRepresentable('x\udfff')).toBe(false);
  });

  it('matches an independent exact UTF8 roundtrip oracle for arbitrary UTF16 code units', () => {
    const units = fc
      .array(fc.integer({min: 0, max: 65535}), {maxLength: 200})
      .map(values => String.fromCharCode(...values));
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
    fc.assert(
      fc.property(fc.oneof(scalar, units), value => {
        expect(candidateTextRepresentable(value)).toBe(decoder.decode(encoder.encode(value)) === value);
      }),
      {numRuns: 200},
    );
    for (const value of ['\ud800', '\udfff', 'x\udfff', '\ud800x', '\ud800\ud800\udfff', '🙂', '🙂🙂', '\ufeff\0🙂'])
      expect(candidateTextRepresentable(value)).toBe(decoder.decode(encoder.encode(value)) === value);
  });

  it('compares every stable byte view without copying or accepting other element types', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    const view = backing.subarray(1, 4);
    expect(candidateBytesEqual(view, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(candidateBytesEqual(view, Buffer.from([1, 2, 3]))).toBe(true);
    expect(candidateBytesEqual(view, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(candidateBytesEqual(view, new Uint8Array([1, 2]))).toBe(false);
    expect(candidateBytesEqual(null, view)).toBe(false);
    expect(candidateBytesEqual(new Uint16Array([1, 2, 3]), view)).toBe(false);
    expect([...backing]).toEqual([9, 1, 2, 3, 9]);
    expect(candidateTextRepresentable(null)).toBe(false);
    expect(candidateTextRepresentable(123)).toBe(false);
  });

  it('refuses non-scalar keys rather than silently replacing original bytes', () => {
    expect(candidateTextRepresentable('🙂')).toBe(true);
    expect(candidateTextRepresentable('\ud800')).toBe(false);
    expect(() => canonicalCandidatePairs([['domain', '\ud800']])).toThrow();
  });
});

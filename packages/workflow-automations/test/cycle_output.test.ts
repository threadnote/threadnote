import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {boundNativeCycleOutput, nativeCycleTextPage} from '../src/cycle_output.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('native cycle text paging', () => {
  it('reconstructs normalized Unicode text across bounded pages', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('🌊', 'é', '漢'), {minLength: 700, maxLength: 2200}),
        fc.integer({min: 1024, max: 4096}),
        (characters, maxBytes) => {
          const input = EffectArray.join(characters, '');
          const expected = new TextDecoder().decode(new TextEncoder().encode(input));
          const pages: string[] = [];
          let offsetBytes = 0;
          let sourceDigest: string | undefined;
          let pageCount = 0;
          while (true) {
            const page = nativeCycleTextPage(input, {
              maxBytes,
              offsetBytes,
              ...(sourceDigest === undefined ? {} : {sourceDigest}),
            });
            expect(new TextEncoder().encode(page.text).byteLength).toBeLessThanOrEqual(maxBytes);
            expect(page.offsetBytes).toBe(offsetBytes);
            expect(page.totalBytes).toBe(new TextEncoder().encode(expected).byteLength);
            expect(page.sourceDigest).toBe(sha256HexSync(new TextEncoder().encode(expected)));
            pages.push(page.text);
            pageCount += 1;
            if (page.nextOffsetBytes === null) break;
            expect(page.nextOffsetBytes).toBeGreaterThan(offsetBytes);
            offsetBytes = page.nextOffsetBytes;
            sourceDigest = page.sourceDigest;
            expect(pageCount).toBeLessThanOrEqual(20);
          }
          expect(EffectArray.join(pages, '')).toBe(expected);
        },
      ),
      {numRuns: 40},
    );
  });

  it('requires the exact digest for continuations and rejects stale or split offsets', () => {
    const source = `${Effect.pipe('x', EffectString.repeat(1023))}🌟tail`;
    const first = nativeCycleTextPage(source, {maxBytes: 1024});
    expect(first.text).toBe(Effect.pipe('x', EffectString.repeat(1023)));
    expect(first.nextOffsetBytes).toBe(1023);
    expect(caught(() => nativeCycleTextPage(source, {offsetBytes: 1023}))).toMatchObject({code: 'invalid-cycle-page'});
    expect(
      caught(() =>
        nativeCycleTextPage(source, {offsetBytes: 1023, sourceDigest: Effect.pipe('0', EffectString.repeat(64))}),
      ),
    ).toMatchObject({
      code: 'invalid-cycle-page',
    });
    expect(
      caught(() => nativeCycleTextPage(source, {offsetBytes: 1024, sourceDigest: first.sourceDigest})),
    ).toMatchObject({code: 'invalid-cycle-page'});
    expect(
      caught(() => nativeCycleTextPage(`${source}!`, {offsetBytes: 1023, sourceDigest: first.sourceDigest})),
    ).toMatchObject({code: 'invalid-cycle-page'});

    const last = nativeCycleTextPage(source, {
      offsetBytes: first.nextOffsetBytes!,
      sourceDigest: first.sourceDigest,
    });
    expect(last.text).toBe('🌟tail');
    expect(last.nextOffsetBytes).toBeNull();
    const atEnd = nativeCycleTextPage(source, {
      offsetBytes: first.totalBytes,
      sourceDigest: first.sourceDigest,
    });
    expect(atEnd).toMatchObject({text: '', nextOffsetBytes: null, offsetBytes: first.totalBytes});
  });

  it('rejects invalid page sizes and offsets instead of silently using defaults', () => {
    for (const maxBytes of [0, 1023, 65_537, 1024.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(caught(() => nativeCycleTextPage('text', {maxBytes}))).toMatchObject({code: 'invalid-cycle-page'});
    for (const offsetBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 5])
      expect(caught(() => nativeCycleTextPage('text', {offsetBytes}))).toMatchObject({code: 'invalid-cycle-page'});
  });
});

describe('native cycle output budgeting', () => {
  it('retains failure semantics and exact detail identity when a failed report is oversized', () => {
    const result = boundNativeCycleOutput(
      {status: 'error', code: 'invalid-cycle-review', report: Effect.pipe('x', EffectString.repeat(8000))},
      1024,
      {snapshotId: 'snapshot-1', detailKind: 'attempt', attemptId: 'failed-1'},
    );
    expect(result).toMatchObject({
      available: false,
      status: 'error',
      code: 'invalid-cycle-review',
      continuation: {command: 'detail', snapshotId: 'snapshot-1', detailKind: 'attempt', attemptId: 'failed-1'},
    });
  });
  it('returns ordinary responses unchanged when their UTF-8 JSON fits', () => {
    const payload = {available: true, snapshot: {snapshotId: 'snapshot-1'}, label: '🌊'};
    expect(boundNativeCycleOutput(payload)).toBe(payload);
  });

  it('replaces oversized data with a bounded response and explicit continuation', () => {
    const payload = {
      available: true,
      revision: 'revision-7',
      snapshot: {snapshotId: 'snapshot-1'},
      next: {cursor: 'cursor-2'},
      body: Effect.pipe('🌊', EffectString.repeat(1500)),
    };
    const result = boundNativeCycleOutput(payload, 1024);
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    expect(result).toMatchObject({
      available: false,
      reason: 'response-budget-exceeded',
      maxBytes: 1024,
      revision: 'revision-7',
      next: {cursor: 'cursor-2'},
      continuation: {command: 'detail', snapshotId: 'snapshot-1'},
    });
    expect(result).not.toHaveProperty('body');
    expect(result.requiredBytes).toBeGreaterThan(1024);
    expect(bytes).toBeLessThanOrEqual(1024);
  });

  it('refuses a fallback that cannot retain the next-page payload within budget', () => {
    const result = caught(() =>
      boundNativeCycleOutput(
        {
          available: true,
          snapshot: {snapshotId: 'snapshot-1'},
          next: {cursor: Effect.pipe('x', EffectString.repeat(1400))},
        },
        1024,
      ),
    );
    expect(result).toMatchObject({code: 'outputcapacity'});
  });

  it('rejects invalid response budgets', () => {
    for (const maximumBytes of [0, -1, 1.5, Number.NaN])
      expect(caught(() => boundNativeCycleOutput({available: true}, maximumBytes))).toMatchObject({
        code: 'outputcapacity',
      });
  });
});

import fc from 'fast-check';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {describe, expect, it} from 'vitest';
import {
  createSemanticProposal,
  proposalPage,
  type ProposalInput,
  type ProposalPage,
  type ProposalPageChunk,
  type SemanticProposal,
} from '../../src/proposals.js';
import {evidence, hash, observation} from '../fixtures.js';

const digest = (value: string) => requireHash(value);
function requireHash(value: string): string {
  // Deterministic test digest with valid lowercase hex; production supplies SHA-256.
  let state = 2166136261;
  for (const character of value)
    state = Math.imul(state ^ EffectOption.getOrUndefined(EffectString.codePointAt(0)(character))!, 16777619);
  return EffectString.repeat(8)(EffectString.padStart(8, '0')((state >>> 0).toString(16)));
}
function input(beforeText: string, start: number, end: number, newText: string): ProposalInput {
  const rawDigest = digest(beforeText);
  const targetObservation = {...observation, content: rawDigest};
  return {
    version: 1,
    operation: 'rename',
    evidence: {...evidence, observation: targetObservation},
    targets: [
      {
        observation: targetObservation,
        beforeText,
        edits: [{range: {start: {line: 0, character: start}, end: {line: 0, character: end}}, newText}],
        precondition: {
          sourceKind: 'overlay',
          rawDigest,
          encoding: 'utf-8',
          physicalIdentity: null,
          owner: 'client-a',
          documentVersion: 1,
        },
      },
    ],
  };
}
// Independent oracle: Unicode regex slicing plus complete reconstruction, never the pager's count.
function expectCompletePages(proposal: SemanticProposal, maxBytes: number): void {
  const original = JSON.stringify(proposal);
  const pages: ProposalPage[] = [];
  const chunks: ProposalPageChunk[] = [];
  let cursor = 0;
  for (let attempt = 0; attempt < 128; attempt++) {
    const page = proposalPage(proposal, {offset: cursor, maxBytes});
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(maxBytes);
    expect(page.offset).toBe(cursor);
    expect(page.digest).toBe(proposal.digest);
    expect(page.targetCount).toBe(proposal.targets.length);
    expect(page.chunks.length).toBeGreaterThan(0);
    pages.push(page);
    chunks.push(...page.chunks);
    if (page.next === null) break;
    expect(page.next).toBe(cursor + page.chunks.length);
    expect(page.next).toBeGreaterThan(cursor);
    expect(page.next).toBeLessThan(page.chunkCount);
    cursor = page.next;
  }
  expect(pages[pages.length - 1].next).toBeNull();
  const manifest = EffectArray.join(
    EffectArray.map(
      EffectArray.filter(chunks, chunk => chunk.kind === 'manifest'),
      chunk => chunk.text,
    ),
    '',
  );
  expect(JSON.parse(manifest)).toEqual({
    version: proposal.version,
    operation: proposal.operation,
    evidence: proposal.evidence,
    targets: EffectArray.map(proposal.targets, target => ({
      observation: target.observation,
      precondition: target.precondition,
      edits: target.edits,
    })),
  });
  const expected: ProposalPageChunk[] = [];
  const append = (kind: ProposalPageChunk['kind'], target: number | null, text: string): void => {
    for (const part of EffectOption.getOrElse(EffectString.match(/[\s\S]{1,512}/gu)(text), () => ['']))
      expected.push({kind, target, text: part});
  };
  append('manifest', null, manifest);
  for (let target = 0; target < proposal.targets.length; target++) {
    append('before', target, proposal.targets[target].beforeText);
    append('after', target, proposal.targets[target].afterText);
  }
  expect(chunks).toEqual(expected);
  for (const page of pages) {
    expect(page.chunkCount).toBe(expected.length);
    const end = page.offset + page.chunks.length;
    expect(page.next).toBe(end === expected.length ? null : end);
  }
  expect(JSON.stringify(proposal)).toBe(original);
}
describe('semantic edit proposal model', () => {
  it('derives CRLF and non-BMP edits using UTF-16 positions without changing caller input', () => {
    const source = 'a😀b\r\nnext';
    const value = input(source, 1, 3, 'X');
    const result = createSemanticProposal(value, digest);
    expect(result.targets[0].afterText).toBe('aXb\r\nnext');
    expect(value.targets[0].beforeText).toBe(source);
    expect(Object.isFrozen(result.targets[0].edits[0].range.start)).toBe(true);
    expect(() => createSemanticProposal(input(source, 2, 3, 'X'), digest)).toThrow(/surrogate/);
    expect(() => createSemanticProposal(input(source, 5, 5, 'X'), digest)).toThrow(/outside/);
  });
  it('rejects overlaps, unordered edits, and mismatched raw source preconditions', () => {
    const base = input('abcdef', 1, 3, 'x');
    expect(() =>
      createSemanticProposal(
        {
          ...base,
          targets: [
            {
              ...base.targets[0],
              edits: [
                base.targets[0].edits[0],
                {range: {start: {line: 0, character: 2}, end: {line: 0, character: 4}}, newText: 'y'},
              ],
            },
          ],
        },
        digest,
      ),
    ).toThrow(/overlap/);
    expect(() =>
      createSemanticProposal(
        {
          ...base,
          targets: [{...base.targets[0], precondition: {...base.targets[0].precondition, rawDigest: hash('f')}}],
        },
        digest,
      ),
    ).toThrow(/precondition/);
  });
  it('binds the digest to preconditions and exposes every manifest and image byte across bounded pages', () => {
    const beforeText = `left\n${EffectString.repeat(9000)('x')}`;
    const original = createSemanticProposal(input(beforeText, 0, 4, 'LEFT'), digest);
    expect(createSemanticProposal(input(beforeText, 0, 4, 'LEFT'), digest)).toEqual(original);
    const changed = input(beforeText, 0, 4, 'LEFT');
    const alteredInput = {
      ...changed,
      targets: [{...changed.targets[0], precondition: {...changed.targets[0].precondition, owner: 'client-b'}}],
    };
    const altered = createSemanticProposal(alteredInput, digest);
    expect(altered.digest).not.toBe(original.digest);
    let pages: ProposalPageChunk[] = [];
    let cursor: number | null | undefined;
    do {
      const offset = cursor ?? 0;
      const page = proposalPage(original, {offset, maxBytes: 12000});
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(12000);
      pages = EffectArray.appendAll(pages, page.chunks);
      if (page.next !== null) expect(page.next).toBeGreaterThan(offset);
      cursor = page.next;
    } while (cursor !== null);
    const beforeChunks = EffectArray.filter(pages, chunk => chunk.kind === 'before');
    const afterChunks = EffectArray.filter(pages, chunk => chunk.kind === 'after');
    const manifestChunks = EffectArray.filter(pages, chunk => chunk.kind === 'manifest');
    expect(
      EffectArray.join(
        EffectArray.map(beforeChunks, chunk => chunk.text),
        '',
      ),
    ).toBe(beforeText);
    expect(
      EffectArray.join(
        EffectArray.map(afterChunks, chunk => chunk.text),
        '',
      ),
    ).toBe(`LEFT\n${EffectString.repeat(9000)('x')}`);
    expect(
      EffectArray.join(
        EffectArray.map(manifestChunks, chunk => chunk.text),
        '',
      ),
    ).toContain('"precondition"');
    expect(() => proposalPage(original, {maxBytes: 1})).toThrow(/too small/);
  });
  it('pages a large image with exact JSON byte accounting and a progressing cursor', () => {
    const beforeText = EffectString.repeat(512 * 520)('界');
    const proposal = createSemanticProposal(input(beforeText, 0, 0, ''), digest);
    const first = proposalPage(proposal, {maxBytes: 64 * 1024});
    const second = proposalPage(proposal, {offset: first.next!, maxBytes: 64 * 1024});
    for (const page of [first, second])
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(first.chunks.length).toBeGreaterThan(1);
    expect(first.next).toBe(first.offset + first.chunks.length);
    expect(second.offset).toBe(first.next);
    expect(second.chunkCount).toBe(first.chunkCount);
    expect(() => proposalPage(proposal, {offset: first.chunkCount, maxBytes: 64 * 1024})).toThrow(/outside/);
  });
  it('retrieves the whole after-image at exact 512-codepoint boundaries through the terminal cursor', () => {
    for (const length of [512, 2048]) {
      const source = EffectString.repeat(length)('x');
      const proposal = createSemanticProposal(input(source, 0, 1, 'y'), digest);
      for (const budget of [1024, 1200, 8192]) expectCompletePages(proposal, budget);
    }
  });
  it('reconstructs the complete manifest and images for bounded Unicode serialization and page budgets', () => {
    const length = fc.oneof(fc.constantFrom(0, 1, 511, 512, 513, 1023, 1024, 1025, 1536, 2048), fc.nat(2048));
    const image = fc.tuple(length, fc.constantFrom('x', '😀', '\u0000', '\t', '"', '\\'));
    fc.assert(
      fc.property(image, image, ([beforeLength, beforePoint], [afterLength, afterPoint]) => {
        const before = EffectString.repeat(beforeLength)(beforePoint);
        const after = EffectString.repeat(afterLength)(afterPoint);
        const proposal = createSemanticProposal(input(before, 0, before.length, after), digest);
        // 4096 fits even one 512-codepoint all-control chunk after JSON escaping.
        for (const budget of [4096, 4608, 6144]) expectCompletePages(proposal, budget);
      }),
      {
        numRuns: 40,
        examples: [
          [
            [0, 'x'],
            [0, 'x'],
          ],
          [
            [511, '😀'],
            [513, '\u0000'],
          ],
          [
            [512, '\u0000'],
            [1024, '😀'],
          ],
          [
            [2048, '\\'],
            [1536, '\t'],
          ],
        ],
      },
    );
  });
  it('matches an independent flat-offset splice for bounded Unicode inputs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', '😀', 'é'), {minLength: 1, maxLength: 20}),
        fc.nat(),
        fc.string({maxLength: 5}),
        (parts, pick, replacement) => {
          const source = EffectArray.join(parts, '');
          const boundaries = [0];
          let offset = 0;
          for (const point of source) {
            offset += EffectOption.getOrUndefined(EffectString.codePointAt(0)(point))! > 0xffff ? 2 : 1;
            boundaries.push(offset);
          }
          const first = pick % boundaries.length;
          const second = first + (pick % (boundaries.length - first));
          const start = boundaries[first];
          const end = boundaries[second];
          const result = createSemanticProposal(input(source, start, end, replacement), digest);
          const expectedAfter = EffectString.slice(0, start)(source) + replacement + EffectString.slice(end)(source);
          expect(result.targets[0].afterText).toBe(expectedAfter);
          expect(input(source, start, end, replacement).targets[0].beforeText).toBe(source);
          const chunks: ProposalPageChunk[] = [];
          let cursor = 0;
          const totalChunks = proposalPage(result, {maxBytes: 1200}).chunkCount;
          do {
            const page = proposalPage(result, {offset: cursor, maxBytes: 1200});
            expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(1200);
            chunks.push(...page.chunks);
            if (page.next !== null) expect(page.next).toBe(cursor + page.chunks.length);
            cursor = page.next ?? page.chunkCount;
          } while (cursor < totalChunks);
          expect(
            EffectArray.join(
              EffectArray.map(
                EffectArray.filter(chunks, chunk => chunk.kind === 'before'),
                chunk => chunk.text,
              ),
              '',
            ),
          ).toBe(source);
          expect(
            EffectArray.join(
              EffectArray.map(
                EffectArray.filter(chunks, chunk => chunk.kind === 'after'),
                chunk => chunk.text,
              ),
              '',
            ),
          ).toBe(expectedAfter);
        },
      ),
      {numRuns: 80},
    );
  });
});

import fc from 'fast-check';
import * as EffectArray from 'effect/Array';
import * as EffectOption from 'effect/Option';
import * as EffectString from 'effect/String';
import {describe, expect, it} from 'vitest';
import {
  createSemanticProposal,
  proposalPage,
  type ProposalInput,
  type OrderedProposalInput,
  type ProposalOperation,
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
    ...(proposal.version === 2
      ? {
          qualification: proposal.qualification,
          operations: proposal.operations,
          ...(proposal.changeAnnotations === undefined ? {} : {changeAnnotations: proposal.changeAnnotations}),
        }
      : {}),
    targets: EffectArray.map(proposal.targets, target => ({
      observation: target.observation,
      ...('providerDocumentVersion' in target ? {providerDocumentVersion: target.providerDocumentVersion} : {}),
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
const sha256 = (value: string): string => new Bun.CryptoHasher('sha256').update(value).digest('hex');
function raw(operations: readonly ProposalOperation[]): OrderedProposalInput {
  return {
    version: 2,
    operation: 'code-action',
    qualification: 'unsupported-operation-sequence',
    evidence,
    targets: [],
    operations,
  };
}
const uri = observation.uri;
const destination = `${uri}.new`;
function qualified(): OrderedProposalInput {
  const legacy = input('abc', 0, 1, 'A');
  return {
    version: 2,
    operation: 'code-action',
    qualification: 'qualified-text-only',
    evidence: legacy.evidence,
    targets: legacy.targets,
    operations: [{kind: 'text', uri, version: 1, edits: legacy.targets[0].edits, target: 0}],
  };
}
describe('semantic edit proposal model', () => {
  it('preserves the original V1 canonical SHA-256 and verifies stored fields without permitting injected metadata', () => {
    const source = input('legacy', 0, 1, 'L');
    const rawDigest = sha256('legacy');
    const targetObservation = {...source.targets[0].observation, content: rawDigest};
    const original = {
      ...source,
      evidence: {...source.evidence, observation: targetObservation},
      targets: [
        {
          ...source.targets[0],
          observation: targetObservation,
          precondition: {...source.targets[0].precondition, rawDigest},
        },
      ],
    };
    const proposal = createSemanticProposal(original, sha256);
    expect(proposal.digest).toBe('7cffb106ffac7356b07e16dea240efd01fbd565b4a9c9eb82d72330dfd29eb10');
    expect(createSemanticProposal(JSON.parse(JSON.stringify(proposal)), sha256)).toEqual(proposal);
    for (const injected of [
      {operations: []},
      {qualification: 'qualified-text-only'},
      {metadata: {}},
      {digest: hash('f')},
    ])
      expect(() => createSemanticProposal({...proposal, ...injected}, sha256)).toThrow();
    expect(() =>
      createSemanticProposal({...proposal, targets: [{...proposal.targets[0], afterText: 'tampered'}]}, sha256),
    ).toThrow(/after-image/);
    expect(() =>
      createSemanticProposal({...original, targets: [{...original.targets[0], providerDocumentVersion: 1}]}, sha256),
    ).toThrow();
  });
  it('qualifies complete unique text groups and binds exact provider versions without altering legacy observations', () => {
    const value = qualified();
    const proposal = createSemanticProposal(value, digest);
    expect(proposal.targets[0].afterText).toBe('Abc');
    expectCompletePages(proposal, 4096);
    expect(createSemanticProposal(proposal, digest)).toEqual(proposal);
    const providerVersion = {
      ...value,
      targets: [{...value.targets[0], providerDocumentVersion: 9}],
      operations: [{...value.operations[0], version: 9}],
    };
    expect(createSemanticProposal(providerVersion, digest).digest).not.toBe(proposal.digest);
    expectCompletePages(createSemanticProposal(providerVersion, digest), 4096);
    expect(() => createSemanticProposal({...proposal, digest: hash('f')}, digest)).toThrow(/digest/);
    expect(() =>
      createSemanticProposal({...proposal, targets: [{...proposal.targets[0], afterText: 'tampered'}]}, digest),
    ).toThrow(/after-image/);
    for (const altered of [
      {...value, operations: [{...value.operations[0], target: null}]},
      {...value, operations: [{...value.operations[0], version: 3}]},
      {...value, operations: [{...value.operations[0], edits: []}]},
      {...value, operations: [...value.operations, ...value.operations]},
      {...value, operations: [{kind: 'create', uri}]},
      {
        ...value,
        qualification: 'unsupported-operation-sequence',
        targets: [],
        operations: [{...value.operations[0], target: null}],
      },
    ])
      expect(() => createSemanticProposal(altered, digest)).toThrow();
  });
  it('retains resource options, annotations, repeated raw text groups and exact ordering with zero fabricated images', () => {
    const edit = {
      range: {start: {line: 900, character: 700}, end: {line: 901, character: 1}},
      newText: '😀\nraw',
      annotationId: 'a',
    };
    const value = {
      ...raw([
        {kind: 'create', uri: destination, options: {overwrite: false, ignoreIfExists: true}, annotationId: 'a'},
        {kind: 'text', uri: destination, version: null, edits: [edit], target: null},
        {kind: 'rename', oldUri: destination, newUri: uri, options: {overwrite: true}, annotationId: 'a'},
        {kind: 'text', uri: destination, version: 7, edits: [edit], target: null},
        {kind: 'delete', uri, options: {recursive: true, ignoreIfNotExists: false}, annotationId: 'a'},
      ]),
      changeAnnotations: {a: {label: 'Review', needsConfirmation: true, description: 'Exact metadata'}},
    };
    const proposal = createSemanticProposal(value, digest);
    expect(proposal.targets).toEqual([]);
    expectCompletePages(proposal, 4096);
    expect(createSemanticProposal(proposal, digest)).toEqual(proposal);
    expect(Object.isFrozen(proposal)).toBe(true);
    if (proposal.version !== 2) throw new Error('expected V2');
    expect(Object.isFrozen(proposal.operations[0])).toBe(true);
    const rawText = proposal.operations[1];
    if (rawText.kind !== 'text') throw new Error('expected raw text');
    expect(Object.isFrozen(rawText.edits[0].range.start)).toBe(true);
    edit.newText = 'caller mutation';
    expect(rawText.edits[0].newText).toBe('😀\nraw');
    expect(Object.isFrozen(proposal.changeAnnotations?.a)).toBe(true);
    for (const altered of [
      {...value, operations: EffectArray.reverse(value.operations)},
      {...value, changeAnnotations: {a: {...value.changeAnnotations.a, description: 'changed'}}},
      {
        ...value,
        operations: [
          {kind: 'create', uri: destination, options: {overwrite: true}},
          ...EffectArray.drop(value.operations, 1),
        ],
      },
    ])
      expect(createSemanticProposal(altered, digest).digest).not.toBe(proposal.digest);
    for (const altered of [
      {...value, qualification: 'qualified-text-only'},
      {...value, arbitrary: true},
      {...value, operations: [{kind: 'delete', uri, options: {unknown: true}}]},
      {...value, changeAnnotations: {a: {label: 'Review', unknown: true}}},
      {...value, changeAnnotations: {}},
      {
        ...value,
        operations: [
          {
            kind: 'text',
            uri,
            version: null,
            target: null,
            edits: [{...edit, range: {start: {line: 2, character: 0}, end: {line: 1, character: 0}}}],
          },
          {kind: 'delete', uri},
        ],
      },
    ])
      expect(() => createSemanticProposal(altered, digest)).toThrow();
    const repeated = raw([
      {kind: 'text', uri, version: 1, edits: [edit], target: null},
      {kind: 'text', uri, version: 2, edits: [edit], target: null},
    ]);
    expectCompletePages(
      createSemanticProposal({...repeated, changeAnnotations: value.changeAnnotations}, digest),
      4096,
    );
    expectCompletePages(createSemanticProposal(raw([{kind: 'delete', uri}]), digest), 4096);
  });
  it('reconstructs bounded ordered raw resource sequences without dropping options or text payloads', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({text: fc.string({maxLength: 700}), overwrite: fc.boolean()}), {minLength: 1, maxLength: 5}),
        entries => {
          const operations: ProposalOperation[] = [];
          for (const entry of entries) {
            operations.push({kind: 'create', uri: destination, options: {overwrite: entry.overwrite}});
            operations.push({
              kind: 'text',
              uri: destination,
              version: null,
              target: null,
              edits: [{range: {start: {line: 99, character: 0}, end: {line: 99, character: 0}}, newText: entry.text}],
            });
          }
          const proposal = createSemanticProposal(raw(operations), digest);
          expectCompletePages(proposal, 4096);
          expect(createSemanticProposal(JSON.parse(JSON.stringify(proposal)), digest)).toEqual(proposal);
        },
      ),
      {numRuns: 20},
    );
  });
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
  it('uses CR, LF and CRLF provider line coordinates without changing source bytes', () => {
    for (const source of [
      '// first\rconst target = 1;\nconst backup = 2;',
      '// first\rconst target = 1;\rconst backup = 2;',
    ]) {
      const base = input(source, 0, 0, '');
      const value = {
        ...base,
        targets: [
          {
            ...base.targets[0],
            edits: [{range: {start: {line: 1, character: 6}, end: {line: 1, character: 12}}, newText: 'renamed'}],
          },
        ],
      };
      const result = createSemanticProposal(value, digest);
      expect(result.targets[0].afterText).toBe(EffectString.replace('target', 'renamed')(source));
      expect(value.targets[0].beforeText).toBe(source);
      const ordered = {
        ...qualified(),
        evidence: value.evidence,
        targets: value.targets,
        operations: [{kind: 'text' as const, uri, version: 1, edits: value.targets[0].edits, target: 0}],
      };
      expect(createSemanticProposal(ordered, digest).targets[0].afterText).toBe(result.targets[0].afterText);
    }
    const source = 'a\r😀b\r\nend\n';
    const base = input(source, 0, 0, '');
    const make = (line: number, start: number, end: number) => ({
      ...base,
      targets: [
        {
          ...base.targets[0],
          edits: [{range: {start: {line, character: start}, end: {line, character: end}}, newText: 'X'}],
        },
      ],
    });
    expect(createSemanticProposal(make(1, 0, 2), digest).targets[0].afterText).toBe('a\rXb\r\nend\n');
    expect(createSemanticProposal(make(3, 0, 0), digest).targets[0].afterText).toBe(`${source}X`);
    expect(() => createSemanticProposal(make(1, 1, 2), digest)).toThrow(/surrogate/);
    expect(() => createSemanticProposal(make(1, 0, 4), digest)).toThrow(/outside/);
    expect(() => createSemanticProposal(make(4, 0, 0), digest)).toThrow(/outside/);
  });
  it('matches an independent per-line splice across mixed line endings and UTF-16 coordinates', () => {
    const lines = fc.array(
      fc.record({
        points: fc.array(fc.constantFrom('a', 'é', '😀'), {minLength: 1, maxLength: 12}),
        eol: fc.constantFrom('\r', '\n', '\r\n'),
      }),
      {minLength: 2, maxLength: 7},
    );
    fc.assert(
      fc.property(
        lines,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.string({maxLength: 8}),
        (entries, startPick, endPick, startPoint, endPoint, replacement) => {
          const first = startPick % entries.length;
          const last = first + (endPick % (entries.length - first));
          const start = startPoint % (entries[first].points.length + 1);
          const end =
            first === last
              ? start + (endPoint % (entries[last].points.length - start + 1))
              : endPoint % (entries[last].points.length + 1);
          const prefix = EffectArray.join(EffectArray.take(entries[first].points, start), '');
          const endPrefix = EffectArray.join(EffectArray.take(entries[last].points, end), '');
          const text = (entry: (typeof entries)[number]): string => EffectArray.join(entry.points, '') + entry.eol;
          const source = EffectArray.join(EffectArray.map(entries, text), '');
          // Oracle operates on generated line components, without parsing source or calculating flat offsets.
          const expected =
            EffectArray.join(EffectArray.map(EffectArray.take(entries, first), text), '') +
            prefix +
            replacement +
            EffectArray.join(EffectArray.drop(entries[last].points, end), '') +
            entries[last].eol +
            EffectArray.join(EffectArray.map(EffectArray.drop(entries, last + 1), text), '');
          const base = input(source, 0, 0, '');
          const value = {
            ...base,
            targets: [
              {
                ...base.targets[0],
                edits: [
                  {
                    range: {
                      start: {line: first, character: prefix.length},
                      end: {line: last, character: endPrefix.length},
                    },
                    newText: replacement,
                  },
                ],
              },
            ],
          };
          const result = createSemanticProposal(value, digest);
          expect(result.targets[0].afterText).toBe(expected);
          expect(value.targets[0].beforeText).toBe(source);
        },
      ),
      {numRuns: 40},
    );
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

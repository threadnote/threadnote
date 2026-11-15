import * as EffectString from 'effect/String';
import * as EffectArray from 'effect/Array';
import {it, expect} from 'vitest';
import fc from 'fast-check';
import {captureBodyDiscovery, validateBodyDiscovery} from '@threadnote/graph/languages/body_discovery';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '@threadnote/graph/types';
import {preparedSymbolTerms, projectLexicalSymbols, lexicalUtf16SortKey} from '@threadnote/graph/store/utilities';
import {compareCodeUnits} from '@threadnote/graph/ordering';

it('conserves exact owner identity and charges independent UTF8 prefix/window sums under ordering permutations', () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom('pending', 'éclair', '漢字', '😀', 'journal', 'items'), {minLength: 1, maxLength: 30}),
      fc.boolean(),
      (words, reverse) => {
        const lines = EffectArray.map(words, word => `function f() { "${word}"; }`);
        const content = EffectArray.join(lines, '\r\n') + '\n';
        const file: CodeGraphInventoryFile = {
          blobId: EffectString.repeat(40)('a'),
          content,
          contentHash: sha256HexSync(content),
          path: 'a.ts',
          mode: '100644',
          language: 'typescript',
          size: Buffer.byteLength(content),
          source: 'worktree',
        };
        const symbols = EffectArray.map(lines, (text, i) => ({
          id: `cgs_${EffectString.padStart(32, '0')(i.toString(16))}`,
          contentHash: file.contentHash,
          path: file.path,
          span: {line: i + 1, column: 1, endLine: i + 1, endColumn: text.length + 1},
          kind: 'function',
          language: file.language,
          name: 'f',
          qualifiedName: 'f',
          exported: true,
        }));
        const facts: CodeGraphFileFacts = {
          path: file.path,
          diagnostics: [],
          edges: [],
          symbols: reverse ? [...symbols].reverse() : symbols,
        };
        const before = JSON.stringify([file, facts]);
        const body = captureBodyDiscovery(file, facts).derivationInputs!.bodyDiscovery!;
        const expectedWork =
          Buffer.byteLength(EffectArray.join(lines.slice(0, -1), '\r\n') + (lines.length > 1 ? '\r\n' : '')) +
          2 * EffectArray.reduce(lines, 0, (total, line) => total + Buffer.byteLength(line));
        expect(body.workBytes).toBe(expectedWork);
        expect(body.workBytes).toBeLessThanOrEqual(65_536);
        expect(EffectArray.map(body.records, record => record.ownerId)).toEqual(
          EffectArray.map(symbols, symbol => symbol.id),
        );
        expect(validateBodyDiscovery(body, file.path, symbols)).toEqual(body);
        expect(
          EffectArray.every(
            body.records,
            record =>
              record.terms.length <= 32 && EffectArray.every(record.terms, term => Buffer.byteLength(term) <= 128),
          ),
        ).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(65_536);
        expect(JSON.stringify([file, facts])).toBe(before);
      },
    ),
    {numRuns: 35},
  );
});

it('caps repeated nested windows without multiplying source-work allowance or postings', () => {
  fc.assert(
    fc.property(fc.integer({min: 1, max: 160}), fc.integer({min: 1, max: 5_000}), (owners, length) => {
      const content = EffectString.repeat(length)('pending ');
      const file: CodeGraphInventoryFile = {
        blobId: EffectString.repeat(40)('a'),
        content,
        contentHash: sha256HexSync(content),
        path: 'a.ts',
        mode: '100644',
        language: 'typescript',
        size: Buffer.byteLength(content),
        source: 'worktree',
      };
      const facts: CodeGraphFileFacts = {
        path: file.path,
        diagnostics: [],
        edges: [],
        symbols: Array.from({length: owners}, (_, i) => ({
          id: `cgs_${EffectString.padStart(32, '0')(i.toString(16))}`,
          path: file.path,
          contentHash: file.contentHash,
          kind: 'method',
          name: 'f',
          qualifiedName: 'f',
          language: file.language,
          exported: true,
          span: {line: 1, column: 1, endLine: 1, endColumn: content.length + 1},
        })),
      };
      const result = captureBodyDiscovery(file, facts).derivationInputs!.bodyDiscovery!;
      expect(result.workBytes).toBeLessThanOrEqual(65_536);
      expect(result.records.length).toBeLessThanOrEqual(Math.min(owners, 128));
      const inspected = EffectArray.reduce(
        result.records,
        0,
        (total, record) => total + record.window.endColumn - record.window.column,
      );
      expect(2 * inspected).toBe(result.workBytes);
      expect(inspected).toBeLessThanOrEqual(65_536);
      expect(EffectArray.reduce(result.records, 0, (count, record) => count + record.terms.length)).toBeLessThanOrEqual(
        4_096,
      );
    }),
    {numRuns: 30},
  );
});

it('factors actual metadata while conserving the independent original weighted and body relations', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          name: fc.constantFrom('pendingItems', 'featureOperation', 'journalOwner', 'éclair'),
          documentation: fc.constantFrom('pending items', 'workflow journal', ''),
          packageName: fc.constantFrom(
            undefined,
            '',
            '@scope/pending',
            '@other/journal',
            'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega one two three four five six seven eight nine ten',
          ),
        }),
        {minLength: 1, maxLength: 20},
      ),
      fc.boolean(),
      (inputs, reverse) => {
        const lines = EffectArray.map(inputs, input => `function ${input.name}() { "pending journal"; }`);
        const content = EffectArray.join(lines, '\n');
        const file: CodeGraphInventoryFile = {
          path:
            (reverse
              ? 'src/' +
                EffectArray.join(
                  EffectArray.map(EffectArray.range(0, 40), index => `segment${index}`),
                  '/',
                ) +
                '/'
              : 'src/pending/') + '\u{10000}/\ue000.ts',
          content,
          contentHash: sha256HexSync(content),
          blobId: EffectString.repeat(40)('a'),
          language: 'typescript',
          mode: '100644',
          size: Buffer.byteLength(content),
          source: 'worktree',
        };
        const symbols = EffectArray.map(inputs, (input, index) => ({
          ...input,
          id: `cgs_${EffectString.padStart(32, '0')(index.toString(16))}`,
          path: file.path,
          contentHash: file.contentHash,
          language: file.language,
          kind: 'function',
          exported: true,
          qualifiedName: `Owner.${input.name}`,
          signature: `function ${input.name}(): number`,
          span: {line: index + 1, column: 1, endLine: index + 1, endColumn: lines[index].length + 1},
        }));
        const facts: CodeGraphFileFacts = {path: file.path, symbols, edges: [], diagnostics: []};
        const body = captureBodyDiscovery(file, facts).derivationInputs!.bodyDiscovery!;
        const before = JSON.stringify([symbols, body]);
        const projected = projectLexicalSymbols(reverse ? [...symbols].reverse() : symbols, [body]);
        expect(projected).toEqual(projectLexicalSymbols(symbols, [body]));
        const expected: string[] = [];
        for (const [symbol, terms] of preparedSymbolTerms(symbols, [body])) {
          for (const [term, weight] of terms) expected.push(JSON.stringify([symbol.id, term, weight]));
        }
        const actual = new Map<string, number>();
        const member = new Map(
          EffectArray.map(projected.members, row => [`${row.scopeOrdinal}:${row.memberOrdinal}`, row.symbolId]),
        );
        const put = (id: string, term: string, weight: number) => {
          const key = JSON.stringify([id, term]);
          actual.set(key, Math.max(actual.get(key) ?? 0, weight));
        };
        for (const row of projected.shared) {
          for (const owner of EffectArray.filter(projected.members, value => value.scopeOrdinal === row.scopeOrdinal)) {
            put(owner.symbolId, projected.terms[row.termOrdinal], 3);
          }
        }
        for (const row of projected.owners) {
          const id = member.get(`${row.scopeOrdinal}:${row.memberOrdinal}`)!;
          const term = projected.terms[row.termOrdinal];
          if (row.originMask !== 2) put(id, term, row.metadataWeight);
          if (row.originMask !== 1) put(id, '~body:v1:' + term, 1);
        }
        const decoded = EffectArray.map([...actual], ([key, weight]) => JSON.stringify([...JSON.parse(key), weight]));
        expect(decoded.sort()).toEqual(expected.sort());
        expect(projected.logicalPostingCount).toBe(expected.length);
        expect(projected.physicalRowCount).toBe(
          projected.terms.length +
            projected.scopes.length +
            projected.members.length +
            projected.owners.length +
            projected.shared.length,
        );
        expect(JSON.stringify([symbols, body])).toBe(before);
      },
    ),
    {numRuns: 35},
  );
});

it('uses transient UTF16 sort keys for canonical BMP, supplementary and empty strings', () => {
  const values = ['', 'a', '\ue000', '\u{10000}', '\u{1f600}', 'éclair'];
  expect([...values].sort((a, b) => Buffer.compare(lexicalUtf16SortKey(a), lexicalUtf16SortKey(b)))).toEqual(
    [...values].sort(compareCodeUnits),
  );
});

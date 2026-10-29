import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {createHash} from '@threadnote/testing/node-crypto';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Effect, Layer, Option} from 'effect';
import {hasSameCodeGraphResolutionSurface} from '@threadnote/graph/indexer';
import {createRepositoryFactResolver, createResolutionAttributor} from '@threadnote/graph/extractor';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '@threadnote/graph/languages/registry';
import type {CodeGraphFileMatcher} from '@threadnote/graph/languages/types';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSpan} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const fuzzCases = EffectArray.flatMap(BUILTIN_LANGUAGE_PACK_REGISTRY.packs, pack => {
  const seen = new Set<string>();
  return EffectArray.flatMap(pack.files, matcher => {
    if (matcher.role !== 'source' || seen.has(matcher.language)) return [];
    seen.add(matcher.language);
    return [{language: matcher.language, path: fuzzPath(matcher)}];
  });
});

const sourceArbitrary = FC.array(
  FC.constantFrom(
    '',
    ' ',
    '\n',
    '\r',
    '\r\n',
    '\t',
    '\0',
    'identifier',
    'Δelta',
    '漢字',
    '🙂',
    'class',
    'func',
    'function',
    'import',
    'package',
    'return',
    'public',
    'private',
    '{',
    '}',
    '(',
    ')',
    '[',
    ']',
    '<',
    '>',
    ':',
    ';',
    ',',
    '.',
    '::',
    '->',
    '"',
    "'",
    '`',
    '// comment',
    '/* unterminated',
    '# comment',
    '@annotation',
    '${value}',
    '\u2028',
    '\u2029',
  ),
  {maxLength: 48},
).map(fragments => EffectArray.join(fragments, ''));

const overloadAritiesArbitrary = FC.uniqueArray(FC.integer({max: 4, min: 0}), {
  maxLength: 5,
  minLength: 1,
}).map(values => values.sort((left, right) => left - right));

const structuredSegmentArbitrary = FC.tuple(
  FC.constantFrom('alpha', 'with.dot', 'with/slash', 'with#hash', 'ümlaut', '漢字', '~tilde'),
  FC.integer({max: 100, min: 0}),
).map(([value, suffix]) => `${value}${suffix}`);

const textStructuralCaseArbitrary = FC.constantFrom(
  {
    content:
      'module sample\ncontains\nsubroutine run()\nend subroutine run\nsubroutine run()\nend subroutine run\nend module sample\n',
    path: 'src/sample.f90',
    prefix: '! harmless layout comment\n',
  },
  {
    content: 'public class Sample {\n  public void run() {}\n  public void run() {}\n}\n',
    path: 'src/Sample.cls',
    prefix: '// harmless layout comment\n',
  },
  {
    content: '@page "/sample"\n@code { private void Run() {} private void Run() {} }\n',
    path: 'Pages/Sample.razor',
    prefix: '@* harmless layout comment *@\n',
  },
);

const ExtractorTestLayer = TreeSitterRuntime.layer.pipe(
  Layer.provide(TestSystemInfoLayer),
  Layer.provide(BunServices.layer),
);

describe('polyglot code graph extractor properties', () => {
  it.layer(ExtractorTestLayer)(layerIt => {
    describe('malformed-source safety', () => {
      for (const fuzzCase of fuzzCases) {
        fcEffectProp(
          layerIt,
          `${fuzzCase.language} is deterministic, bounded, and structurally valid`,
          {source: sourceArbitrary},
          ({source}) =>
            Effect.gen(function* () {
              const file = inventoryFile(fuzzCase.path, source);
              const [first, second] = yield* Effect.all(
                [BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file), BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file)],
                {concurrency: 1},
              );
              expect(first, fuzzCase.language).toEqual(second);
              assertFacts(file, first, fuzzCase.language);
            }),
          {
            fastCheck: {interruptAfterTimeLimit: 20_000, markInterruptAsFailure: true, numRuns: 8},
            timeout: 25_000,
          },
        );
      }

      layerIt.effect('bounds malformed Swift import spans at a CRLF boundary', () =>
        Effect.gen(function* () {
          const file = inventoryFile('src/fuzz.swift', 'import// comment\r\n');
          const facts = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file);
          assertFacts(file, facts, 'swift');
        }),
      );
    });

    fcEffectProp(
      layerIt,
      'assigns unique stable identities to TypeScript overloads and sibling-block declarations',
      {arities: overloadAritiesArbitrary, revision: FC.integer({max: 10_000, min: 0})},
      ({arities, revision}) => {
        const source = typescriptIdentityFixture(arities, 0);
        const revised = typescriptIdentityFixture(arities, revision + 1);
        const file = inventoryFile('src/overloads.ts', source);
        const revisedFile = inventoryFile('src/overloads.ts', revised);
        return Effect.gen(function* () {
          const first = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file);
          const repeated = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file);
          const bodyOnly = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(revisedFile);
          const parseSymbols = EffectArray.filter(first.symbols, symbol => symbol.name === 'parse');
          const shadowSymbols = EffectArray.filter(first.symbols, symbol => symbol.name === 'shadow');
          const stableSymbol = Option.getOrUndefined(
            EffectArray.findFirst(first.symbols, symbol => symbol.name === 'stable'),
          );

          expect(first).toEqual(repeated);
          expect(parseSymbols).toHaveLength(arities.length + 1);
          expect(shadowSymbols).toHaveLength(2);
          expect(stableSymbol?.id).toBe(legacyTypeScriptSymbolId('src/overloads.ts', 'function', 'stable'));
          expect(new Set(EffectArray.map(first.symbols, symbol => symbol.id)).size).toBe(first.symbols.length);
          expect(hasSameCodeGraphResolutionSurface(first.symbols, bodyOnly.symbols)).toBe(true);
        });
      },
      {fastCheck: {numRuns: 100}, timeout: 15_000},
    );

    fcEffectProp(
      layerIt,
      'retains TypeScript declaration merges while resolving references to one canonical group member',
      {declarationCount: FC.integer({max: 8, min: 2}), padding: FC.integer({max: 12, min: 0})},
      ({declarationCount, padding}) => {
        const file = inventoryFile(
          'src/merged.ts',
          EffectArray.join(
            [
              ...Array.from({length: padding}, () => '// harmless leading layout'),
              ...Array.from(
                {length: declarationCount},
                (_, index) => `export interface Shape { readonly field${index}: string; }`,
              ),
              'export class Widget implements Shape {}',
              '',
            ],
            '\n',
          ),
        );
        return Effect.gen(function* () {
          const extracted = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(file);
          const attributed = createResolutionAttributor([file])([extracted]);
          const resolved = createRepositoryFactResolver(attributed, [file]).resolve(attributed)[0];
          const declarations = EffectArray.filter(
            resolved.symbols,
            symbol => symbol.kind === 'interface' && symbol.name === 'Shape',
          );
          const canonical = EffectArray.filter(
            declarations,
            symbol =>
              symbol.lookupKeys !== undefined &&
              EffectArray.some(symbol.lookupKeys, key => Effect2.pipe(key, EffectString.endsWith(':merge-canonical'))),
          );
          const implementation = Option.getOrUndefined(
            EffectArray.findFirst(
              resolved.edges,
              edge => edge.sourceName === 'Widget' && edge.relation === 'implements' && edge.targetName === 'Shape',
            ),
          );

          expect(declarations).toHaveLength(declarationCount);
          expect(new Set(EffectArray.map(declarations, symbol => symbol.id)).size).toBe(declarationCount);
          expect(canonical).toHaveLength(1);
          expect(implementation).toMatchObject({provenance: 'resolved', targetId: canonical[0]?.id});
        });
      },
      {fastCheck: {numRuns: 80}, timeout: 15_000},
    );

    fcEffectProp(
      layerIt,
      'keeps structured object paths and repeated protobuf members unambiguous',
      {
        format: FC.constantFrom('json' as const, 'jsonc' as const, 'yaml' as const),
        lineSeparator: FC.constantFrom('\n', '\r', '\r\n', '\u2028', '\u2029'),
        segment: structuredSegmentArbitrary,
        serviceCount: FC.integer({max: 6, min: 2}),
      },
      ({format, lineSeparator, segment, serviceCount}) => {
        const objectPath = `config/fuzz.${format}`;
        const flatKey = `root.${segment}`;
        const objectFile = inventoryFile(objectPath, structuredConfigSource(format, flatKey, segment));
        const protobufFile = inventoryFile(
          'schema/fuzz.proto',
          EffectArray.join(
            [
              '/* package fake.pkg; import "ghost.proto"; service Ghost { rpc Nope(Request) returns (Response); } */',
              '// 🙂 service Fake { rpc Bad(Request) returns (Response); }',
              'package real.pkg;',
              'import "real.proto";',
              ...Array.from({length: serviceCount}, (_, index) =>
                EffectArray.join(
                  [
                    `service Service${index} {`,
                    `  // 🙂 service Fake${index} { rpc Bad(Request) returns (Response); }`,
                    `  option note = "🙂 }";`,
                    `  /* } service Ghost${index} { rpc Nope(Request) returns (Response); } */`,
                    '  rpc Get(Request) returns (Response);',
                    '  rpc Get(Request) returns (Response);',
                    '}',
                  ],
                  lineSeparator,
                ),
              ),
            ],
            lineSeparator,
          ),
        );
        return Effect.gen(function* () {
          const structured = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(objectFile);
          const protobuf = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(protobufFile);
          const rpcSymbols = EffectArray.filter(protobuf.symbols, symbol => symbol.kind === 'rpc');
          const firstService = Option.getOrUndefined(
            EffectArray.findFirst(protobuf.symbols, symbol => symbol.name === 'Service0'),
          );
          const flatProperty = Option.getOrUndefined(
            EffectArray.findFirst(
              structured.symbols,
              symbol => symbol.qualifiedName === `${objectPath}#/${escapeStructuredSegment(flatKey)}`,
            ),
          );
          const nestedProperty = Option.getOrUndefined(
            EffectArray.findFirst(
              structured.symbols,
              symbol => symbol.qualifiedName === `${objectPath}#/root/${escapeStructuredSegment(segment)}`,
            ),
          );

          expect(structured.diagnostics, format).toEqual([]);
          expect(new Set(EffectArray.map(structured.symbols, symbol => symbol.id)).size).toBe(
            structured.symbols.length,
          );
          expect(new Set(EffectArray.map(structured.symbols, symbol => symbol.qualifiedName)).size).toBe(
            structured.symbols.length,
          );
          expect(flatProperty?.id).toBe(
            legacyStructuredSymbolId(objectPath, format, 'property', `${objectPath}#${flatKey}`),
          );
          expect(nestedProperty?.id).toBeDefined();
          expect(nestedProperty?.id).not.toBe(flatProperty?.id);
          expect(rpcSymbols).toHaveLength(serviceCount * 2);
          expect(new Set(EffectArray.map(rpcSymbols, symbol => symbol.id)).size).toBe(serviceCount * 2);
          expect(firstService?.id).toBe(
            legacyStructuredSymbolId('schema/fuzz.proto', 'protobuf', 'service', 'real.pkg.Service0'),
          );
          expect(new Set(EffectArray.map(rpcSymbols, symbol => symbol.qualifiedName))).toEqual(
            new Set(Array.from({length: serviceCount}, (_, index) => `real.pkg.Service${index}.Get`)),
          );
          expect(
            EffectArray.map(
              EffectArray.filter(protobuf.edges, edge => edge.relation === 'imports'),
              edge => edge.targetName,
            ),
          ).toEqual(['real.proto']);
          for (const rpc of rpcSymbols) {
            expect(
              EffectArray.some(
                protobuf.edges,
                edge =>
                  edge.relation === 'contains' &&
                  edge.targetId === rpc.id &&
                  Effect2.pipe(edge.sourceName, EffectString.startsWith('Service')),
              ),
            ).toBe(true);
          }
        });
      },
      {fastCheck: {numRuns: 80}, timeout: 15_000},
    );

    fcEffectProp(
      layerIt,
      'keeps bounded text-structural symbol identities stable across harmless leading layout',
      {padding: FC.integer({max: 20, min: 0}), sample: textStructuralCaseArbitrary},
      ({padding, sample}) => {
        const plain = inventoryFile(sample.path, sample.content);
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        const padded = inventoryFile(sample.path, `${sample.prefix.repeat(padding + 1)}${sample.content}`);
        return Effect.gen(function* () {
          const first = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(plain);
          const shifted = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile(padded);
          expect(new Set(EffectArray.map(first.symbols, symbol => symbol.id)).size).toBe(first.symbols.length);
          expect(new Set(EffectArray.map(shifted.symbols, symbol => symbol.id)).size).toBe(shifted.symbols.length);
          expect(symbolIdentityProjection(shifted)).toEqual(symbolIdentityProjection(first));
        });
      },
      {fastCheck: {numRuns: 60}, timeout: 15_000},
    );
  });
});

function assertFacts(file: CodeGraphInventoryFile, facts: CodeGraphFileFacts, language: string): void {
  const message = `${language}:${file.path}`;
  const symbolIds = new Set(EffectArray.map(facts.symbols, symbol => symbol.id));
  const edgeIds = new Set(EffectArray.map(facts.edges, edge => edge.id));
  const edgeIdentityById = new Map<string, ReturnType<typeof edgeIdentityProjection>>();
  const inputBytes = Buffer.byteLength(file.content ?? '');
  const factCountBound = Math.max(64, inputBytes * 8);

  expect(facts.path, message).toBe(file.path);
  expect(symbolIds.size, message).toBe(facts.symbols.length);
  expect(facts.symbols.length + facts.edges.length, message).toBeLessThanOrEqual(factCountBound);
  expect(facts.diagnostics.length, message).toBeLessThanOrEqual(100);

  for (const symbol of facts.symbols) {
    expect(symbol.path, message).toBe(file.path);
    expect(symbol.language, message).toBe(file.language);
    assertSpan(symbol.span, file.content ?? '', message);
  }
  for (const edge of facts.edges) {
    const identity = edgeIdentityProjection(edge);
    const previous = edgeIdentityById.get(edge.id);
    if (previous === undefined) edgeIdentityById.set(edge.id, identity);
    else expect(identity, `${message}:${edge.id}`).toEqual(previous);
    expect(edge.evidencePath, message).toBe(file.path);
    expect(Number.isFinite(edge.confidence), message).toBe(true);
    expect(edge.confidence, message).toBeGreaterThanOrEqual(0);
    expect(edge.confidence, message).toBeLessThanOrEqual(1);
    if (edge.sourceId !== undefined) expect(symbolIds.has(edge.sourceId), message).toBe(true);
    if (edge.targetId !== undefined) expect(symbolIds.has(edge.targetId), message).toBe(true);
    assertSpan(edge.evidenceSpan, file.content ?? '', message);
  }
  for (const reference of facts.references ?? []) {
    expect(edgeIds.has(reference.edgeId), message).toBe(true);
    expect(reference.evidencePath, message).toBe(file.path);
    if (reference.sourceId !== undefined) expect(symbolIds.has(reference.sourceId), message).toBe(true);
    assertSpan(reference.evidenceSpan, file.content ?? '', message);
  }
}

function edgeIdentityProjection(edge: CodeGraphFileFacts['edges'][number]) {
  return {
    evidencePath: edge.evidencePath,
    provenance: edge.provenance,
    relation: edge.relation,
    sourceId: edge.sourceId,
    sourceName: edge.sourceName,
    targetId: edge.targetId,
    targetName: edge.targetName,
  };
}

function assertSpan(span: CodeGraphSpan, content: string, message: string): void {
  const lines = Effect2.pipe(content, EffectString.split(/\r\n|[\n\r\u2028\u2029]/u));
  expect(Number.isSafeInteger(span.line), message).toBe(true);
  expect(Number.isSafeInteger(span.column), message).toBe(true);
  expect(Number.isSafeInteger(span.endLine), message).toBe(true);
  expect(Number.isSafeInteger(span.endColumn), message).toBe(true);
  expect(span.line, message).toBeGreaterThanOrEqual(1);
  expect(span.column, message).toBeGreaterThanOrEqual(1);
  expect(span.endColumn, message).toBeGreaterThanOrEqual(1);
  expect(span.endLine, message).toBeGreaterThanOrEqual(span.line);
  expect(span.line, message).toBeLessThanOrEqual(lines.length);
  expect(span.endLine, message).toBeLessThanOrEqual(lines.length);
  expect(span.column, message).toBeLessThanOrEqual((lines[span.line - 1]?.length ?? 0) + 1);
  expect(span.endColumn, message).toBeLessThanOrEqual((lines[span.endLine - 1]?.length ?? 0) + 1);
  if (span.endLine === span.line) expect(span.endColumn, message).toBeGreaterThanOrEqual(span.column);
}

function inventoryFile(path: string, content: string): CodeGraphInventoryFile {
  const match = BUILTIN_LANGUAGE_PACK_REGISTRY.match(path);
  if (Option.isNone(match)) throw TestError.make({message: `Fuzz path is not accepted by a language pack: ${path}.`});
  return {
    blobId: `fuzz-${path}`,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    language: match.value.language,
    mode: '100644',
    path,
    size: Buffer.byteLength(content),
    source: 'commit',
  };
}

function fuzzPath(matcher: CodeGraphFileMatcher): string {
  if (matcher.kind === 'basename') return `src/${matcher.value}`;
  if (matcher.kind === 'basename-pattern')
    return `src/${Effect2.pipe(matcher.value, EffectString.replaceAll('*', 'fuzz'))}`;
  if (matcher.kind === 'path-suffix')
    return `src/fuzz${Effect2.pipe(matcher.value, EffectString.startsWith('/')) ? '' : '/'}${matcher.value}`;
  return `src/fuzz${matcher.value}`;
}

function typescriptIdentityFixture(arities: readonly number[], revision: number): string {
  return EffectArray.join(
    [
      ...EffectArray.map(arities, arity => {
        const parameters = EffectArray.join(
          Array.from({length: arity}, (_, index) => `value${index}: number`),
          ', ',
        );
        return `export function parse(${parameters}): string;`;
      }),
      'export function parse(...values: readonly number[]): string {',
      `  return values.join(',') + '${revision}';`,
      '}',
      'export function stable(): void {}',
      'if (true) {',
      '  const shadow = 1;',
      '  void shadow;',
      '} else {',
      '  const shadow = 1;',
      '  void shadow;',
      '}',
      '',
    ],
    '\n',
  );
}

function legacyTypeScriptSymbolId(path: string, kind: string, qualifiedName: string): string {
  return `cgs_${Effect2.pipe(
    createHash('sha256').update(`symbol-v1\n${path}\ntypescript\n${kind}\n${qualifiedName}`).digest('hex'),
    EffectString.slice(0, 32),
  )}`;
}

function legacyStructuredSymbolId(path: string, language: string, kind: string, qualifiedName: string): string {
  return `cgs_${Effect2.pipe(
    createHash('sha256').update(`structured-symbol-v1\n${path}\n${language}\n${kind}\n${qualifiedName}`).digest('hex'),
    EffectString.slice(0, 32),
  )}`;
}

function structuredConfigSource(format: 'json' | 'jsonc' | 'yaml', flatKey: string, nestedKey: string): string {
  const value = {[flatKey]: {leaf: true}, root: {[nestedKey]: {leaf: false}}, literal: '/* value */ // ,}'};
  if (format === 'json') return JSON.stringify(value);
  if (format === 'jsonc') {
    return EffectArray.join(
      [
        '\uFEFF{',
        '  // comments and trailing commas must preserve string contents and source offsets',
        `  ${JSON.stringify(flatKey)}: {"leaf": true,},`,
        `  "root": {${JSON.stringify(nestedKey)}: {"leaf": false,},},`,
        '  "literal": "/* value */ // ,}",',
        '}',
      ],
      '\n',
    );
  }
  return EffectArray.join(
    [
      `${JSON.stringify(flatKey)}:`,
      '  leaf: true',
      'root:',
      `  ${JSON.stringify(nestedKey)}:`,
      '    leaf: false',
      'literal: "/* value */ // ,}"',
      '',
    ],
    '\n',
  );
}

function escapeStructuredSegment(value: string): string {
  return Effect2.pipe(value, EffectString.replaceAll('~', '~0'), EffectString.replaceAll('/', '~1'));
}

function symbolIdentityProjection(facts: CodeGraphFileFacts) {
  return EffectArray.map(facts.symbols, symbol => ({
    id: symbol.id,
    kind: symbol.kind,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
  }));
}
